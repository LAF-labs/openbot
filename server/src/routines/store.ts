import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import {
  actorMayDriveBot,
  BOT_NOT_FOUND,
  lookupBotOwner,
} from "../auth/guards";
import type { Database } from "../db/client";
import { lafRoutineRuns, lafRoutines } from "../db/schema";
import { noSuchRoutine, RoutineError } from "./errors";
import { mine, scopeOf } from "./ownership";
import { KEPT_RUNS } from "./receipts";
import {
  nextRunAt,
  parseSchedule,
  type RoutineSchedule,
  type StoredSchedule,
  scheduleOf,
} from "./schedule";

/**
 * The routines a person keeps: made, listed, edited, paused, re-armed and deleted — every verb
 * scoped by whose they are (`ownership.ts`).
 */

/**
 * Twenty routines per account. A wall against runaway creation, not a pricing tier.
 *
 * Per account, counted by who made them. It counted the whole table, which on a VM a shop owner
 * shares with their staff means the first person to make twenty routines stops everybody else from
 * making one — a limit that reads as somebody else's mistake.
 */
export const MAX_ROUTINES = 20;

export type RoutineInput = {
  agentId: string;
  name: string;
  instruction: string;
  /** The line the person reads on the Routines screen. Optional; see `summaryOf`. */
  summary?: string;
  schedule: RoutineSchedule;
  /**
   * The catalogue suggestion this routine is being made from, when it is. See the schema note:
   * it is what stops the same suggestion being offered twice, and only `routines/suggestions.ts`
   * sets it — the create route does not read it out of a body.
   */
  suggestionKey?: string;
};

/**
 * What an edit may change: the words, the name and the clock — any of them, and only these.
 *
 * Not `enabled`, not which Bot, and not whether the unread rule may pause it: each of those has a
 * door of its own, and this shape is what a Bot's `manage_routine` reaches (`routes.ts` picks these
 * four out of the body and drops everything else).
 */
export type RoutineChange = {
  name?: string;
  instruction?: string;
  /** The person's line. Only with or after the words it describes; see `updateRoutine`. */
  summary?: string;
  schedule?: RoutineSchedule;
};

/**
 * How long the person's line may be. One line on a phone is about forty Korean characters, two is
 * eighty; a Bot that writes a paragraph here has written a second instruction, and the screen cuts
 * it rather than refusing the routine it came with — refusing would lose the routine over its label.
 */
export const SUMMARY_MAX_CHARS = 120;

/**
 * The line as it is kept: one line, trimmed, bounded, or null for nothing.
 *
 * Newlines become spaces because it is drawn as a line, and a Bot's summary that opens with a
 * heading and a list would push the schedule off the card.
 */
export function summaryOf(summary: string | undefined): string | null {
  const line = (summary ?? "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  const letters = [...line];
  return letters.length > SUMMARY_MAX_CHARS
    ? `${letters
        .slice(0, SUMMARY_MAX_CHARS - 1)
        .join("")
        .trimEnd()}…`
    : line;
}

/** What every verb here works with: the database, and the clock a new or re-armed routine reads. */
export type RoutineStore = {
  database: Database;
  now: () => Date;
  /**
   * The zone a new daily routine is written in when it names none: the deployment's,
   * `config.botTimeZone`. See `parseSchedule`.
   */
  timeZone: string;
};

type RoutineRow = typeof lafRoutines.$inferSelect;

/** The webhook token as it is kept: its SHA-256, never the token. See the schema note. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Every column of a routine except the one that is a capability.
 *
 * `triggerTokenHash` is the SHA-256 of the webhook token, and `SELECT *` was handing it to the
 * roster: a hash is not the token, but it is the material for guessing one offline and it is on a
 * screen that has no use for it. The list is the projection rather than a delete-after-select so a
 * column added to the table has to be named here before it can leave the deployment.
 */
const publishedColumns = {
  id: lafRoutines.id,
  agentId: lafRoutines.agentId,
  name: lafRoutines.name,
  instruction: lafRoutines.instruction,
  summary: lafRoutines.summary,
  scheduleKind: lafRoutines.scheduleKind,
  intervalMinutes: lafRoutines.intervalMinutes,
  dailyLocal: lafRoutines.dailyLocal,
  dailyTimeZone: lafRoutines.dailyTimeZone,
  dailyDays: lafRoutines.dailyDays,
  enabled: lafRoutines.enabled,
  createdById: lafRoutines.createdById,
  createdByRole: lafRoutines.createdByRole,
  suggestionKey: lafRoutines.suggestionKey,
  // Why it is off when its person did not turn it off, and their 계속 돌리기. See `unread.ts`.
  pausedReason: lafRoutines.pausedReason,
  pausedAt: lafRoutines.pausedAt,
  keepRunning: lafRoutines.keepRunning,
  nextRunAt: lafRoutines.nextRunAt,
  lastRunAt: lafRoutines.lastRunAt,
  createdAt: lafRoutines.createdAt,
  updatedAt: lafRoutines.updatedAt,
};

/** The same, for a row that arrived whole: `.returning()` has no projection to apply. */
function withoutTokenHash<Row extends { triggerTokenHash?: unknown }>(
  row: Row,
): Omit<Row, "triggerTokenHash"> {
  const { triggerTokenHash: _hash, ...rest } = row;
  return rest;
}

/**
 * A routine row as the API may publish it.
 *
 * Bun's driver hands an `integer[]` column back as an `Int32Array` whenever the query carries
 * parameters, and as an array only when it does not. An `Int32Array` is not an array to
 * `Array.isArray`, and JSON writes it as `{ "0": 1, "1": 3 }`. `.returning()` was where this was
 * first seen — the create response and the list disagreed about the same routine's days — and
 * the list itself turned out to have it too, because its ownership clause is a parameter: every
 * weekday routine read as 매일 on the screen (measured 2026-09-18). Normalised here, once, for
 * every row that leaves the service — and exported, because the account export reads routines
 * the same way and wrote the same object into the file a person takes with them.
 */
export function publishedRoutine<Row extends { dailyDays: unknown }>(
  row: Row,
): Row {
  const days = row.dailyDays;
  const dailyDays = Array.isArray(days)
    ? days
    : days && typeof days === "object"
      ? Object.values(days as Record<string, number>)
      : null;
  return { ...row, dailyDays };
}

export async function createRoutine(
  store: RoutineStore,
  actor: AgentActor,
  input: RoutineInput,
) {
  const schedule = parseSchedule(input.schedule, store.timeZone);
  const name = input.name.trim();
  const instruction = input.instruction.trim();
  refuseBlank(name, instruction);
  await refuseSomebodyElsesBot(store.database, actor, input.agentId);

  return store.database.transaction(async (transaction) => {
    await refuseAtCap(transaction, actor);
    const at = store.now();
    // Shown once, in the create response, and kept only as a hash. See the schema note.
    const triggerToken = randomBytes(24).toString("base64url");
    const row = await insertRoutine(transaction, {
      actor,
      input,
      schedule,
      name,
      instruction,
      triggerToken,
      at,
    });
    // The token, once. Never its hash, which is the one column this row does not publish.
    return { ...publishedRoutine(withoutTokenHash(row)), triggerToken };
  });
}

/**
 * Codes, because a Bot creates routines too and a Bot cannot act on an English sentence.
 * The surface turns them into Korean; so does the Bot's own tool, from a different table.
 */
function refuseBlank(name: string, instruction: string): void {
  if (!name) {
    throw new RoutineError("Name the routine.", 400, "laf:routine_needs_name");
  }
  if (!instruction) {
    throw new RoutineError(
      "Say what the routine should do.",
      400,
      "laf:routine_needs_instruction",
    );
  }
}

/**
 * WHOSE BOT, BEFORE THE ROW.
 *
 * Create was the one verb here that did not ask: list, run, enable and delete are scoped by
 * `scopeOf`, and the write that puts a routine on a Bot in the first place checked the name,
 * the schedule and the cap, and took `agentId` on trust. Measured 2026-09-10 (audit A8): a
 * colleague posted the owner's Bot and got 201, `createdById` theirs, and a trigger token —
 * an unattended instruction planted on a Bot that runs with the owner's logins, computer and
 * grants. The rule is the one every other door a Bot id opens uses (`actorMayDriveBot`), and
 * the refusal is the same 404 the rest of the product gives for a Bot that is not yours,
 * which a Bot that does not exist — a foreign-key failure and a 500, before — now shares.
 *
 * NOT THERE IS NOT THERE FOR AN ADMINISTRATOR EITHER, and 2026-09-16 is when that became true
 * of the predicate rather than of an extra clause here. `actorMayDriveBot` used to let an
 * administrator through to any id at all; an administrator could plant a standing instruction on a
 * colleague's Bot — unattended, on that Bot's computer, with that person's logins — and it would
 * show up in the owner's own list of routines as something they never wrote. This function briefly
 * carried a second check of its own to close that. It does not need one now: driving and seeing are
 * both ownership, so `actorMayDriveBot` is again the whole of the rule, and one rule asked once is
 * the point.
 *
 * `owner === undefined` is still asked separately, because a Bot that does not EXIST would
 * otherwise let the insert reach the foreign key — audit A1-2 measured that as the local
 * administrator: a 500, and the instruction's text in the operator log.
 */
async function refuseSomebodyElsesBot(
  database: Database,
  actor: AgentActor,
  agentId: string,
): Promise<void> {
  const owner = await lookupBotOwner(database, agentId);
  if (owner === undefined || !actorMayDriveBot(actor, owner)) {
    throw new RoutineError("There is no such Bot.", 404, BOT_NOT_FOUND);
  }
}

/** This person's routines, not the deployment's. See MAX_ROUTINES. */
async function refuseAtCap(
  transaction: Pick<Database, "select">,
  actor: AgentActor,
): Promise<void> {
  const [held] = await transaction
    .select({ count: count() })
    .from(lafRoutines)
    .where(eq(lafRoutines.createdById, actor.id));
  if (Number(held?.count ?? 0) >= MAX_ROUTINES) {
    throw new RoutineError(
      `This account holds ${MAX_ROUTINES} routines already. Delete one to make room.`,
      409,
      "laf:routine_cap_reached",
    );
  }
}

async function insertRoutine(
  transaction: Pick<Database, "insert">,
  made: {
    actor: AgentActor;
    input: RoutineInput;
    schedule: StoredSchedule;
    name: string;
    instruction: string;
    triggerToken: string;
    at: Date;
  },
): Promise<RoutineRow> {
  const { actor, input, schedule, at } = made;
  const [row] = await transaction
    .insert(lafRoutines)
    .values({
      id: `routine_${randomUUID()}`,
      triggerTokenHash: hashToken(made.triggerToken),
      agentId: input.agentId,
      name: made.name,
      instruction: made.instruction,
      summary: summaryOf(input.summary),
      ...scheduleColumns(schedule, at),
      enabled: true,
      createdById: actor.id,
      createdByRole: actor.role,
      suggestionKey: input.suggestionKey ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!row) {
    throw new RoutineError(
      "The routine could not be created.",
      409,
      "laf:routine_not_created",
    );
  }
  return row;
}

/**
 * A routine changed in place: its name, what it says, when it runs.
 *
 * IN PLACE, BECAUSE THE ALTERNATIVE WAS DELETING IT. There was no edit, so "move my 07:30 briefing
 * to eight" was a delete and a create — and a routine's id is what its run history, its notepad
 * and its webhook token hang from, so all three went with the old row. The row stays; the fields
 * move.
 *
 * Checked the way a new routine is, with the same codes, before the row is looked for: a blank name
 * or instruction, and every schedule refusal `parseSchedule` makes, including the deployment's zone
 * for a daily time that names none — a Bot hears "8시" on that clock (see `parseSchedule`).
 *
 * THE CLOCK MOVES ONLY WHEN THE SCHEDULE DOES. Re-arming from the moment of the edit is right for
 * a new time and wrong for a new name: an hourly routine renamed at 05:40 would otherwise fire at
 * 06:40 instead of 06:00. A schedule sent back exactly as it is stored — the form sends every field,
 * and a Bot may repeat the schedule beside a rename — is no change, and moves nothing.
 *
 * Who made it is not touched. `created_by_id` is who the routine runs as (`run.ts`), and an edit
 * is not a reason for it to start running as somebody else.
 */
export async function updateRoutine(
  store: RoutineStore,
  actor: AgentActor,
  id: string,
  change: RoutineChange,
) {
  const { database } = store;
  const name = change.name?.trim();
  const instruction = change.instruction?.trim();
  if (
    name === undefined &&
    instruction === undefined &&
    change.summary === undefined &&
    change.schedule === undefined
  ) {
    throw new RoutineError(
      "Say what to change: the name, the instruction, its summary or the schedule.",
      400,
      "laf:routine_nothing_to_change",
    );
  }
  if (name !== undefined && !name) {
    throw new RoutineError("Name the routine.", 400, "laf:routine_needs_name");
  }
  if (instruction !== undefined && !instruction) {
    throw new RoutineError(
      "Say what the routine should do.",
      400,
      "laf:routine_needs_instruction",
    );
  }
  const schedule =
    change.schedule === undefined
      ? undefined
      : parseSchedule(change.schedule, store.timeZone);

  const row = await mine(database, actor, id);
  const at = store.now();
  const rescheduled =
    schedule !== undefined && !sameSchedule(schedule, scheduleOf(row));
  /*
   * THE PERSON'S LINE FOLLOWS WHAT IT DESCRIBES. A new summary is kept as sent. New words or a new
   * clock without one clear the old line: it described a routine that is no longer this one, and
   * the screen showing it would be telling the person something that will not happen. Measured
   * 2026-09-24: "월요일 말고 화요일 8시 반으로" moved the routine and left "매주 월요일 오전 9시에
   * 매출 요약을 알려 드립니다" under a schedule that said 화 오전 8:30. With no line the screen shows
   * the instruction itself, which is true if not pretty.
   */
  const reworded = instruction !== undefined && instruction !== row.instruction;
  const summary =
    change.summary !== undefined
      ? { summary: summaryOf(change.summary) }
      : reworded || rescheduled
        ? { summary: null }
        : {};
  const [updated] = await database
    .update(lafRoutines)
    .set({
      ...(name === undefined ? {} : { name }),
      ...(instruction === undefined ? {} : { instruction }),
      ...summary,
      ...(rescheduled ? scheduleColumns(schedule, at) : {}),
      updatedAt: at,
    })
    .where(eq(lafRoutines.id, id))
    .returning();
  if (!updated) throw noSuchRoutine();
  return publishedRoutine(withoutTokenHash(updated));
}

/**
 * The columns a schedule is kept in, and the next window it names from `at` — for a new routine
 * and an edited one alike, so the two cannot store the same schedule two ways.
 */
function scheduleColumns(schedule: StoredSchedule, at: Date) {
  return {
    scheduleKind: schedule.kind,
    intervalMinutes: schedule.kind === "interval" ? schedule.minutes : null,
    dailyLocal: schedule.kind === "daily" ? schedule.time : null,
    // No fallback here: a parsed daily schedule always names its zone, and the one this line used
    // to supply was UTC.
    dailyTimeZone: schedule.kind === "daily" ? schedule.timeZone : null,
    dailyDays: schedule.kind === "daily" ? schedule.days : null,
    nextRunAt: nextRunAt(schedule, at),
  };
}

/**
 * Whether two schedules name the same windows. The day lists are compared as sets: a parsed one is
 * sorted, and a row written before `parseSchedule` sorted them need not be.
 */
function sameSchedule(a: StoredSchedule, b: StoredSchedule): boolean {
  if (a.kind === "interval" || b.kind === "interval") {
    return (
      a.kind === "interval" && b.kind === "interval" && a.minutes === b.minutes
    );
  }
  const days = (list: number[]) =>
    [...new Set(list)].sort((x, y) => x - y).join(",");
  return (
    a.time === b.time &&
    a.timeZone === b.timeZone &&
    days(a.days) === days(b.days)
  );
}

export async function listRoutines(store: RoutineStore, actor: AgentActor) {
  const rows = await store.database
    .select(publishedColumns)
    .from(lafRoutines)
    .where(scopeOf(store.database, actor))
    .orderBy(desc(lafRoutines.createdAt));
  return rows.map(publishedRoutine);
}

export async function listRuns(
  store: RoutineStore,
  actor: AgentActor,
  routineId: string,
) {
  // Ownership before history: a run record carries the Bot's answer, which is the routine's
  // whole content, so reading somebody else's runs is reading their work.
  await mine(store.database, actor, routineId);
  return store.database
    .select()
    .from(lafRoutineRuns)
    .where(eq(lafRoutineRuns.routineId, routineId))
    .orderBy(desc(lafRoutineRuns.startedAt))
    .limit(KEPT_RUNS);
}

export async function setRoutineEnabled(
  store: RoutineStore,
  actor: AgentActor,
  id: string,
  enabled: boolean,
) {
  const { database } = store;
  const before = await mine(database, actor, id);
  const at = store.now();
  /*
   * THE SWITCH IS THE PERSON'S DECISION, WHICHEVER WAY IT GOES, so it clears the reason the unread
   * rule left (`unread.ts`): on is "run it", off is "I turned it off", and neither is the rule's any
   * more. Turning it on from off is also where the rule starts counting again — the pile that paused
   * it is still unread, and it must not pause the routine a second time on the next tick. A switch
   * pressed to where it already was is no resume, and moves nothing.
   */
  const [row] = await database
    .update(lafRoutines)
    .set({
      enabled,
      pausedReason: null,
      pausedAt: null,
      ...(enabled && !before.enabled ? { resumedAt: at } : {}),
      updatedAt: at,
    })
    .where(eq(lafRoutines.id, id))
    .returning();
  if (!row) throw noSuchRoutine();
  if (enabled) {
    // Re-enabling re-arms the clock from now; a routine disabled for a week must not fire
    // seven times to catch up.
    const next = nextRunAt(scheduleOf(row), at);
    const [rearmed] = await database
      .update(lafRoutines)
      .set({ nextRunAt: next })
      .where(eq(lafRoutines.id, id))
      .returning();
    return publishedRoutine(withoutTokenHash(rearmed ?? row));
  }
  return publishedRoutine(withoutTokenHash(row));
}

/**
 * 계속 돌리기 on one routine: never paused for going unread (`unread.ts`), or back under the rule.
 *
 * Its own verb and its own route, never a field of the edit: a Bot's `manage_routine` reaches the
 * edit, and a Bot that could exempt its own routines from the rule would be deciding for itself
 * what it may spend. It does not turn the routine on — that is the switch's, or 다시 켜기's.
 */
export async function setRoutineKeepRunning(
  store: RoutineStore,
  actor: AgentActor,
  id: string,
  keepRunning: boolean,
) {
  const { database } = store;
  await mine(database, actor, id);
  const [row] = await database
    .update(lafRoutines)
    .set({ keepRunning, updatedAt: store.now() })
    .where(eq(lafRoutines.id, id))
    .returning();
  if (!row) throw noSuchRoutine();
  return publishedRoutine(withoutTokenHash(row));
}

/**
 * 다시 켜기 and 계속 돌리기, for one Bot: its routines the unread rule paused, back on.
 *
 * Only those the RULE paused. A routine the person switched off themselves carries no reason and is
 * not touched: the banner that offers this is about the rule's pause, and pressing it must not undo
 * a decision somebody made on the switch. Each is re-armed from now, like the switch — a routine
 * paused for a week does not fire a backlog — and counted by the rule from now, like the switch.
 *
 * One statement, so a press is all of its routines or none of them. Whose Bot is asked the way
 * create asks it: a Bot that is not this person's is not there.
 */
export async function resumeUnreadPaused(
  store: RoutineStore,
  actor: AgentActor,
  agentId: string,
  options: { keepRunning: boolean },
) {
  const { database } = store;
  await refuseSomebodyElsesBot(database, actor, agentId);
  const at = store.now();
  const paused = await database
    .select()
    .from(lafRoutines)
    .where(
      and(
        eq(lafRoutines.agentId, agentId),
        eq(lafRoutines.pausedReason, "unread"),
        eq(lafRoutines.enabled, false),
        scopeOf(database, actor),
      ),
    );
  if (paused.length === 0) return [];
  return database.transaction(async (transaction) => {
    const resumed: RoutineRow[] = [];
    for (const row of paused) {
      const [updated] = await transaction
        .update(lafRoutines)
        .set({
          enabled: true,
          pausedReason: null,
          pausedAt: null,
          resumedAt: at,
          nextRunAt: nextRunAt(scheduleOf(row), at),
          ...(options.keepRunning ? { keepRunning: true } : {}),
          updatedAt: at,
        })
        .where(
          and(
            eq(lafRoutines.id, row.id),
            eq(lafRoutines.pausedReason, "unread"),
          ),
        )
        .returning();
      if (updated) resumed.push(updated);
    }
    return resumed.map((row) => publishedRoutine(withoutTokenHash(row)));
  });
}

export async function removeRoutine(
  store: RoutineStore,
  actor: AgentActor,
  id: string,
): Promise<void> {
  // Checked before the runs are deleted, so a stranger's DELETE cannot destroy the history of a
  // routine it is then refused permission to remove.
  await mine(store.database, actor, id);
  await store.database
    .delete(lafRoutineRuns)
    .where(eq(lafRoutineRuns.routineId, id));
  const removed = await store.database
    .delete(lafRoutines)
    .where(eq(lafRoutines.id, id))
    .returning();
  if (removed.length === 0) throw noSuchRoutine();
}
