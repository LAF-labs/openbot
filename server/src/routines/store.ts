import { createHash, randomBytes, randomUUID } from "node:crypto";
import { count, desc, eq } from "drizzle-orm";
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
 * The routines a person keeps: made, listed, paused, re-armed and deleted — every verb scoped by
 * whose they are (`ownership.ts`).
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
  schedule: RoutineSchedule;
  /**
   * The catalogue suggestion this routine is being made from, when it is. See the schema note:
   * it is what stops the same suggestion being offered twice, and only `routines/suggestions.ts`
   * sets it — the create route does not read it out of a body.
   */
  suggestionKey?: string;
};

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
  scheduleKind: lafRoutines.scheduleKind,
  intervalMinutes: lafRoutines.intervalMinutes,
  dailyLocal: lafRoutines.dailyLocal,
  dailyTimeZone: lafRoutines.dailyTimeZone,
  dailyDays: lafRoutines.dailyDays,
  enabled: lafRoutines.enabled,
  createdById: lafRoutines.createdById,
  createdByRole: lafRoutines.createdByRole,
  suggestionKey: lafRoutines.suggestionKey,
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
 * `.returning()` hands back `integer[]` columns as `{ "0": 1, "1": 3 }` where a plain SELECT of the
 * same row gives `[1, 3]` — verified against the live server, and the reason the create response
 * and the list disagreed about the same routine's days. Normalised here, once, for every row that
 * leaves the service.
 */
function published<Row extends { dailyDays: unknown }>(row: Row): Row {
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
    return { ...published(withoutTokenHash(row)), triggerToken };
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
      scheduleKind: schedule.kind,
      intervalMinutes: schedule.kind === "interval" ? schedule.minutes : null,
      dailyLocal: schedule.kind === "daily" ? schedule.time : null,
      // No fallback here: a parsed daily schedule always names its zone, and the one this line used
      // to supply was UTC.
      dailyTimeZone: schedule.kind === "daily" ? schedule.timeZone : null,
      dailyDays: schedule.kind === "daily" ? schedule.days : null,
      enabled: true,
      createdById: actor.id,
      createdByRole: actor.role,
      suggestionKey: input.suggestionKey ?? null,
      nextRunAt: nextRunAt(schedule, at),
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

export async function listRoutines(store: RoutineStore, actor: AgentActor) {
  return store.database
    .select(publishedColumns)
    .from(lafRoutines)
    .where(scopeOf(store.database, actor))
    .orderBy(desc(lafRoutines.createdAt));
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
  await mine(database, actor, id);
  const at = store.now();
  const [row] = await database
    .update(lafRoutines)
    .set({ enabled, updatedAt: at })
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
    return published(withoutTokenHash(rearmed ?? row));
  }
  return published(withoutTokenHash(row));
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
