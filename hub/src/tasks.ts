import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HUB_FACTS,
  HUB_HEADERS,
  HUB_TASK_BOT_STAGES,
  HUB_TASK_FACTS,
  HUB_TASK_LIMITS,
  HUB_TASK_LOCK_MS,
  HUB_TASK_STAGES,
  type HubTask,
  type HubTaskAssignee,
  type HubTaskDetail,
  type HubTaskList,
  type HubTaskNote,
  type HubTaskStage,
  type HubTaskVisibilityChoice,
} from "../../shared/hub/protocol";
import { recordAudit } from "./audit";
import type { AuthedMember, MemberVariables } from "./auth";
import type { HubDatabase, HubTransaction } from "./db/client";
import {
  hubMembers,
  hubTaskMembers,
  hubTaskNotes,
  hubTasks,
} from "./db/schema";
import { emitEvent, type Listeners } from "./events";
import { type Answer, IDEMPOTENCY_KEY_SHAPE, onceFor } from "./idempotency";
import { audienceOf, visibleTo } from "./visibility";

/**
 * The company's task board: tasks, their notes, and the claim a 라피's run takes on one.
 *
 * WHO MAY DO WHAT, AND WHY.
 * - A task is read, edited and noted by whoever can see it (`visibleTo`, in every query's WHERE).
 *   One a member may not see answers 404, the same as one that does not exist.
 * - Who sees it is changed only by its maker or an owner/admin: widening a task the maker kept to
 *   themselves is theirs to decide, and narrowing one cuts others off. Giving a members task to
 *   somebody not on it puts them on it, so that is theirs too.
 * - A member who leaves the company is taken off every task (`leaveEveryTask`), and an edit never
 *   puts them back, so coming back does not bring back sight of those tasks or their files.
 * - A task given to a 라피 or a job enters `doing` only by its run's checkout. A person cannot put
 *   it there by hand: with no claim on it, no run would ever take it.
 * - A 라피 (`as: "bot"`) moves only a task its own run holds, and only to `review` or `blocked`,
 *   with at most one line of note. `done` is a person's: whether work is finished is a judgement
 *   the hub never takes from a Bot (`laf:task_done_by_person`).
 * - A person's edit carries the `version` it was made against; an older one is `laf:task_stale`,
 *   so a board that read the task before a run moved it reads it again instead of writing over it.
 *
 * THE CLAIM. `POST /tasks/:id/checkout {runId}` is one conditional UPDATE: it takes the task only
 * if it is waiting (`todo`, unclaimed) or its holder's time ran out, and only for a member it is
 * assigned to (or anybody, when it is assigned to nobody). Postgres makes a second UPDATE of the
 * same row wait for the first to commit and then test its WHERE against the row the first wrote,
 * which no longer matches — so of any number of runs asking at once exactly one is told yes and
 * the rest `laf:task_taken`, with no lock of our own. A run that is told no stops; it does not
 * retry. Its claim lasts `HUB_TASK_LOCK_MS` and is renewed by `/heartbeat`; `/release` and a
 * Bot's move to `review`/`blocked` end it, and the sweep (`task-sweeper.ts`) frees what ran out.
 *
 * THE TRAIL HOLDS NO WORDS. A task's audit row says who did what to which id, in which run and
 * with what result — the fields changed by name, a note's length — never a title, a description or
 * a note's text.
 */

const ID_SHAPE = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ASSIGNEE_SHAPE = /^(m|bot|job):([A-Za-z0-9_-]{1,80})$/;
const CURSOR_SHAPE = /^(\d{1,15})\.([A-Za-z0-9_-]{1,80})$/;

class Invalid extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

const invalid = (field: string): Answer => ({
  status: 400,
  body: { ok: false, code: "laf:request_invalid", field },
});
const notFound: Answer = {
  status: 404,
  body: { ok: false, code: HUB_FACTS.notFound },
};
const forbidden: Answer = {
  status: 403,
  body: { ok: false, code: HUB_FACTS.forbidden },
};
const taken: Answer = {
  status: 409,
  body: { ok: false, code: HUB_TASK_FACTS.taken },
};
const notHeld: Answer = {
  status: 409,
  body: { ok: false, code: HUB_TASK_FACTS.notHeld },
};

const isString = (value: unknown): value is string => typeof value === "string";
const isManager = (member: AuthedMember) =>
  member.role === "owner" || member.role === "admin";

/** The SQL for "the claim lasts this long from now", from the database's clock, never the VM's. */
const lockUntil = () =>
  sql`now() + make_interval(secs => ${HUB_TASK_LOCK_MS / 1000})`;

function idList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Invalid(field);
  const ids = [...new Set(value)];
  if (ids.length > max) throw new Invalid(field);
  for (const id of ids) {
    if (!isString(id) || !ID_SHAPE.test(id)) throw new Invalid(field);
  }
  return ids as string[];
}

function text(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Invalid(field);
    return null;
  }
  if (!isString(value)) throw new Invalid(field);
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw new Invalid(field);
    return null;
  }
  if (trimmed.length > max) throw new Invalid(field);
  return trimmed;
}

function stageOf(value: unknown): HubTaskStage {
  if (!HUB_TASK_STAGES.includes(value as HubTaskStage))
    throw new Invalid("stage");
  return value as HubTaskStage;
}

function asOf(value: unknown): "member" | "bot" {
  const as = value ?? "member";
  if (as !== "member" && as !== "bot") throw new Invalid("as");
  return as;
}

function runOf(value: unknown, header: string | undefined): string | null {
  const run = value ?? header ?? null;
  if (run !== null && (!isString(run) || !RUN_SHAPE.test(run)))
    throw new Invalid("runId");
  return run;
}

function rankOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Invalid("rank");
  return value;
}

function assigneeOf(value: unknown): HubTaskAssignee | null {
  if (value === null) return null;
  if (!isString(value) || !ASSIGNEE_SHAPE.test(value))
    throw new Invalid("assignee");
  return value as HubTaskAssignee;
}

/** A task given to a 라피 or a job is worked by a run; one given to a person, by that person. */
const workedByRun = (assignee: string | null) =>
  assignee !== null && !assignee.startsWith("m:");

/** The member an assignee names, or null for a job. */
function assigneeMember(assignee: string | null): string | null {
  const match = assignee ? ASSIGNEE_SHAPE.exec(assignee) : null;
  return match && match[1] !== "job" ? (match[2] ?? null) : null;
}

/**
 * The note as it may be written: a person's up to `note` characters, a 라피's one line of at most
 * `botNote` — a fact or a link, never a report pasted in.
 */
function noteOf(value: unknown, as: "member" | "bot"): string | null {
  if (value === undefined || value === null) return null;
  if (!isString(value)) throw new Invalid("note");
  const note = value.trim();
  const max = as === "bot" ? HUB_TASK_LIMITS.botNote : HUB_TASK_LIMITS.note;
  if (note === "" || note.length > max) throw new Invalid("note");
  if (as === "bot" && /[\r\n]/.test(note)) throw new Invalid("note");
  return note;
}

async function readJson(
  context: Context,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await context.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type TaskRow = typeof hubTasks.$inferSelect;

async function membersOf(
  database: HubDatabase | HubTransaction,
  ids: string[],
): Promise<Map<string, string[]>> {
  const byTask = new Map<string, string[]>();
  if (ids.length === 0) return byTask;
  const rows = await database
    .select()
    .from(hubTaskMembers)
    .where(inArray(hubTaskMembers.taskId, ids))
    .orderBy(asc(hubTaskMembers.memberId));
  for (const row of rows) {
    byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row.memberId]);
  }
  return byTask;
}

function taskView(row: TaskRow, members: string[]): HubTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    stage: row.stage as HubTaskStage,
    visibility: row.visibility,
    members,
    assignee: row.assignee,
    assignedBy: row.assignedBy,
    createdBy: row.createdBy,
    checkout:
      row.checkoutRunId && row.checkoutBy && row.lockExpiresAt
        ? {
            runId: row.checkoutRunId,
            by: row.checkoutBy,
            until: row.lockExpiresAt.toISOString(),
          }
        : null,
    version: row.version,
    rank: row.rank,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    doneAt: row.doneAt?.toISOString() ?? null,
  };
}

async function viewOne(
  database: HubDatabase | HubTransaction,
  row: TaskRow,
): Promise<HubTask> {
  return taskView(row, (await membersOf(database, [row.id])).get(row.id) ?? []);
}

/** The task, if `member` may see it. `lock` takes its row for the rest of the transaction. */
async function visibleTask(
  database: HubDatabase | HubTransaction,
  id: string,
  member: string,
  lock = false,
): Promise<TaskRow | undefined> {
  const query = database
    .select()
    .from(hubTasks)
    .where(and(eq(hubTasks.id, id), visibleTo(hubTasks.visibility, member)));
  const [row] = lock
    ? await query.for("update", { of: hubTasks })
    : await query;
  return row;
}

/** Which of `ids` are members of the company now. */
async function activeOf(tx: HubTransaction, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: hubMembers.id })
    .from(hubMembers)
    .where(and(inArray(hubMembers.id, ids), eq(hubMembers.state, "active")));
  return rows.map((row) => row.id);
}

/** Null (everybody) wins; otherwise everyone in either. */
function unionOf(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null || b === null) return null;
  return [...new Set([...a, ...b])];
}

/** The stored visibility for a choice, or the field that is wrong. */
const VISIBILITY_CHOICES: readonly HubTaskVisibilityChoice[] = [
  "company",
  "me",
  "members",
];

function visibilityFor(choice: unknown, taskId: string, maker: string): string {
  if (!VISIBILITY_CHOICES.includes(choice as HubTaskVisibilityChoice))
    throw new Invalid("visibility");
  if (choice === "me") return `me:${maker}`;
  if (choice === "members") return `task:${taskId}`;
  return "company";
}

/**
 * Writes what an assignee needs to see the task, or says why it cannot: a `task:` task takes the
 * assigned member onto its members; a `me:` task can only be its maker's own.
 */
function assigneeFits(
  visibility: string,
  member: string | null,
  members: Set<string>,
): boolean {
  if (member === null || visibility === "company") return true;
  if (visibility.startsWith("me:")) return visibility === `me:${member}`;
  members.add(member);
  return true;
}

async function writeMembers(
  tx: HubTransaction,
  taskId: string,
  members: Set<string>,
): Promise<void> {
  await tx.delete(hubTaskMembers).where(eq(hubTaskMembers.taskId, taskId));
  if (members.size === 0) return;
  await tx
    .insert(hubTaskMembers)
    .values([...members].map((memberId) => ({ taskId, memberId })));
}

/** `task.assigned` goes to the member whose VM acts on it; a job's to whoever sees the task. */
async function emitAssigned(
  tx: HubTransaction,
  task: { id: string; visibility: string; assignee: string },
  actor: string,
): Promise<void> {
  const member = assigneeMember(task.assignee);
  await emitEvent(tx, {
    type: "task.assigned",
    refId: task.id,
    actor,
    visibleTo: member ? [member] : await audienceOf(tx, task.visibility),
  });
}

/**
 * Takes a member who has left the company off every task they were on, inside the registry's
 * transaction that marks them gone — and so out of every `task:` audience, files included. The
 * tasks are locked in one order before their members change, the way an edit locks its task before
 * it reads them, so an edit committing beside the departure cannot write them back. Whoever is
 * still on a task hears of it, so their boards redraw its members.
 */
export async function leaveEveryTask(
  tx: HubTransaction,
  memberId: string,
  by: string,
): Promise<void> {
  const tasks = await tx
    .select({ id: hubTasks.id, visibility: hubTasks.visibility })
    .from(hubTasks)
    .where(
      inArray(
        hubTasks.id,
        tx
          .select({ taskId: hubTaskMembers.taskId })
          .from(hubTaskMembers)
          .where(eq(hubTaskMembers.memberId, memberId)),
      ),
    )
    .orderBy(asc(hubTasks.id))
    .for("update");
  // Every row of theirs, a task's or not: a `task:` file reads the same table.
  await tx.delete(hubTaskMembers).where(eq(hubTaskMembers.memberId, memberId));
  for (const task of tasks) {
    const audience = await audienceOf(tx, task.visibility);
    if (audience === null || audience.length > 0) {
      await emitEvent(tx, {
        type: "task.changed",
        refId: task.id,
        visibleTo: audience,
      });
    }
    await recordAudit(tx, {
      action: "task.member_removed",
      member: by,
      target: task.id,
      outcome: "ok",
      payload: { member: memberId },
    });
  }
}

export type TaskRouteOptions = {
  database: HubDatabase;
  listeners: Listeners;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
};

export function taskRoutes(options: TaskRouteOptions) {
  const { database, listeners } = options;
  const route = new Hono<{ Variables: MemberVariables }>();
  route.use(options.member);

  /**
   * One write, in the idempotency ledger when the request carries a key and in a plain transaction
   * when it does not. Listeners are poked after the commit, never inside it, and not for a replay,
   * whose events were delivered the first time.
   */
  const write = async (
    context: Context<{ Variables: MemberVariables }>,
    work: (tx: HubTransaction, emitted: () => void) => Promise<Answer>,
  ) => {
    const key = context.req.header(HUB_HEADERS.idempotencyKey);
    if (key !== undefined && !IDEMPOTENCY_KEY_SHAPE.test(key)) {
      return context.json(invalid("idempotencyKey").body as object, 400);
    }
    let poke = false;
    const emitted = () => {
      poke = true;
    };
    const run = async (tx: HubTransaction) => {
      try {
        return await work(tx, emitted);
      } catch (error) {
        if (error instanceof Invalid) {
          poke = false;
          return invalid(error.field);
        }
        throw error;
      }
    };
    const member = context.get("member");
    const answer =
      key === undefined
        ? { ...(await database.transaction(run)), replayed: false }
        : await onceFor(database, member.id, key, run);
    if (poke && !answer.replayed) listeners.pokeAll();
    return context.json(
      answer.body as Record<string, unknown>,
      answer.status as 200,
    );
  };

  const limited = bodyLimit({
    maxSize: 64 * 1024,
    onError: (context) =>
      context.json({ ok: false, code: "laf:request_invalid" }, 413),
  });

  const badId = (context: Context) =>
    context.json({ ok: false, code: HUB_FACTS.notFound }, 404);

  route.get("/", async (context) => {
    const self = context.get("member");
    const stage = context.req.query("stage");
    if (stage !== undefined && !HUB_TASK_STAGES.includes(stage as HubTaskStage))
      return context.json(invalid("stage").body as object, 400);
    const rawLimit = context.req.query("limit");
    const limit =
      rawLimit === undefined ? HUB_TASK_LIMITS.pageDefault : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > HUB_TASK_LIMITS.page)
      return context.json(invalid("limit").body as object, 400);
    const rawCursor = context.req.query("cursor");
    let after: SQL | undefined;
    if (rawCursor !== undefined) {
      const match = CURSOR_SHAPE.exec(rawCursor);
      if (!match) return context.json(invalid("cursor").body as object, 400);
      const at = new Date(Number(match[1]));
      const id = match[2] ?? "";
      after = or(
        lt(hubTasks.createdAt, at),
        and(eq(hubTasks.createdAt, at), lt(hubTasks.id, id)),
      );
    }
    const rows = await database
      .select()
      .from(hubTasks)
      .where(
        and(
          visibleTo(hubTasks.visibility, self.id),
          stage ? eq(hubTasks.stage, stage) : undefined,
          after,
        ),
      )
      .orderBy(desc(hubTasks.createdAt), desc(hubTasks.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const members = await membersOf(
      database,
      page.map((row) => row.id),
    );
    const last = page.at(-1);
    const body: HubTaskList = {
      ok: true,
      tasks: page.map((row) => taskView(row, members.get(row.id) ?? [])),
      next:
        rows.length > limit && last
          ? `${last.createdAt.getTime()}.${last.id}`
          : null,
    };
    return context.json(body);
  });

  route.get("/:id", async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return badId(context);
    const row = await visibleTask(database, id, context.get("member").id);
    if (!row) return badId(context);
    // The newest thousand, oldest first. A 라피 knows a run of its own was reported by that run's
    // line, which is among the newest; the oldest thousand left it out on a long-lived task.
    const notes = (
      await database
        .select()
        .from(hubTaskNotes)
        .where(eq(hubTaskNotes.taskId, row.id))
        .orderBy(desc(hubTaskNotes.id))
        .limit(1000)
    ).reverse();
    const body: HubTaskDetail = {
      ok: true,
      task: await viewOne(database, row),
      notes: notes.map(
        (note): HubTaskNote => ({
          id: note.id,
          by: note.by,
          text: note.text,
          runId: note.runId,
          at: note.at.toISOString(),
        }),
      ),
    };
    return context.json(body);
  });

  route.post("/", limited, async (context) => {
    const body = await readJson(context);
    if (!body) return context.json(invalid("body").body as object, 400);
    const self = context.get("member");
    return write(context, async (tx, emitted) => {
      const as = asOf(body.as);
      const runId = runOf(body.runId, context.req.header(HUB_HEADERS.run));
      const title = text(body.title, "title", HUB_TASK_LIMITS.title, true);
      const description = text(
        body.description,
        "description",
        HUB_TASK_LIMITS.description,
        false,
      );
      const stage = body.stage === undefined ? "todo" : stageOf(body.stage);
      // A 라피 puts work on the board; it does not say where finished work stands.
      if (as === "bot" && stage !== "todo") {
        if (stage === "done") {
          await recordAudit(tx, {
            action: "task.created",
            member: self.id,
            vmOrigin: self.vmOrigin,
            runId,
            outcome: HUB_TASK_FACTS.doneByPerson,
          });
          return {
            status: 403,
            body: { ok: false, code: HUB_TASK_FACTS.doneByPerson },
          };
        }
        throw new Invalid("stage");
      }
      const id = `t_${randomUUID()}`;
      const visibility = visibilityFor(body.visibility ?? "me", id, self.id);
      const asked = idList(body.members, "members", HUB_TASK_LIMITS.members);
      if (visibility.startsWith("me:") && asked.some((m) => m !== self.id))
        throw new Invalid("members");
      const assignee =
        body.assignee === undefined ? null : assigneeOf(body.assignee);
      if (stage === "doing" && workedByRun(assignee))
        throw new Invalid("stage");
      const assigned = assigneeMember(assignee);
      const named = [...new Set([...asked, ...(assigned ? [assigned] : [])])];
      const active = await activeOf(tx, named);
      if (assigned && !active.includes(assigned)) throw new Invalid("assignee");
      if (active.length !== named.length) throw new Invalid("members");
      const members = new Set(asked);
      if (visibility.startsWith("task:")) members.add(self.id);
      if (!assigneeFits(visibility, assigned, members))
        throw new Invalid("assignee");
      const rank = rankOf(body.rank);
      const now = new Date();
      const [row] = await tx
        .insert(hubTasks)
        .values({
          id,
          title: title ?? "",
          description,
          stage,
          visibility,
          assignee,
          assignedBy: assignee ? self.id : null,
          createdBy: self.id,
          // New work goes to the bottom of its column unless placed.
          rank: rank ?? now.getTime() / 1000,
          // From this clock, to the millisecond, so a list's cursor names a row exactly.
          createdAt: now,
          updatedAt: now,
          doneAt: stage === "done" ? now : null,
        })
        .returning();
      if (!row) throw new Error("hub_tasks insert returned nothing");
      await writeMembers(tx, id, members);
      const seq = await emitEvent(tx, {
        type: "task.changed",
        refId: id,
        actor: self.id,
        visibleTo: await audienceOf(tx, visibility),
      });
      if (assignee)
        await emitAssigned(tx, { id, visibility, assignee }, self.id);
      emitted();
      await recordAudit(tx, {
        action: "task.created",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        runId,
        outcome: "ok",
        payload: {
          as,
          stage,
          visibility: visibility.split(":")[0],
          assigned: assignee ? assignee.split(":")[0] : null,
        },
      });
      return {
        status: 200,
        body: { ok: true, task: await viewOne(tx, row), seq },
      };
    });
  });

  route.patch("/:id", limited, async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return badId(context);
    const body = await readJson(context);
    if (!body) return context.json(invalid("body").body as object, 400);
    const self = context.get("member");
    return write(context, async (tx, emitted) => {
      const as = asOf(body.as);
      const runId = runOf(body.runId, context.req.header(HUB_HEADERS.run));
      const note = noteOf(body.note, as);
      const row = await visibleTask(tx, id, self.id, true);
      if (!row) return notFound;
      const audit = (outcome: string, payload?: Record<string, unknown>) =>
        recordAudit(tx, {
          action: "task.changed",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: id,
          runId,
          outcome,
          payload: { as, ...payload },
        });

      if (as === "bot") {
        const fields = Object.keys(body).filter(
          (key) => !["as", "runId", "stage", "note"].includes(key),
        );
        if (fields[0]) throw new Invalid(fields[0]);
        if (body.stage === "done") {
          await audit(HUB_TASK_FACTS.doneByPerson);
          return {
            status: 403,
            body: { ok: false, code: HUB_TASK_FACTS.doneByPerson },
          };
        }
        const stage = body.stage === undefined ? null : stageOf(body.stage);
        if (stage !== null && !HUB_TASK_BOT_STAGES.includes(stage))
          throw new Invalid("stage");
        if (stage === null && note === null) throw new Invalid("body");
        if (runId === null) throw new Invalid("runId");
        if (
          row.checkoutRunId !== runId ||
          row.checkoutBy !== self.id ||
          row.stage !== "doing"
        ) {
          await audit(HUB_TASK_FACTS.notHeld);
          return notHeld;
        }
        const [next] = stage
          ? await tx
              .update(hubTasks)
              .set({
                stage,
                // Its run is done with it: the claim ends with the move.
                checkoutRunId: null,
                checkoutBy: null,
                lockExpiresAt: null,
                version: sql`${hubTasks.version} + 1`,
                updatedAt: sql`now()`,
              })
              .where(eq(hubTasks.id, id))
              .returning()
          : [row];
        if (!next) throw new Error("hub_tasks update returned nothing");
        if (note !== null) {
          await tx
            .insert(hubTaskNotes)
            .values({ taskId: id, by: `bot:${self.id}`, text: note, runId });
        }
        const seq = await emitEvent(tx, {
          type: "task.changed",
          refId: id,
          actor: self.id,
          visibleTo: await audienceOf(tx, next.visibility),
        });
        emitted();
        await audit("ok", {
          stage: next.stage,
          fields: stage ? ["stage"] : [],
          noteChars: note?.length ?? 0,
        });
        return {
          status: 200,
          body: { ok: true, task: await viewOne(tx, next), seq },
        };
      }

      const version = body.version;
      if (typeof version !== "number" || !Number.isInteger(version))
        throw new Invalid("version");
      if (version !== row.version) {
        await audit(HUB_TASK_FACTS.stale);
        return {
          status: 409,
          body: {
            ok: false,
            code: HUB_TASK_FACTS.stale,
            version: row.version,
          },
        };
      }

      const set: Partial<typeof hubTasks.$inferInsert> = {};
      const fields: string[] = [];
      if (body.title !== undefined) {
        set.title =
          text(body.title, "title", HUB_TASK_LIMITS.title, true) ?? "";
        fields.push("title");
      }
      if (body.description !== undefined) {
        set.description = text(
          body.description,
          "description",
          HUB_TASK_LIMITS.description,
          false,
        );
        fields.push("description");
      }
      const rank = rankOf(body.rank);
      if (rank !== undefined) {
        set.rank = rank;
        fields.push("rank");
      }
      const stage = body.stage === undefined ? row.stage : stageOf(body.stage);
      if (stage !== row.stage) {
        set.stage = stage;
        set.doneAt = stage === "done" ? new Date() : null;
        fields.push("stage");
      }
      // A person moving a task out of `doing` takes it from the run that held it; that run's next
      // beat is `laf:task_not_held`, and it stops.
      if (row.checkoutRunId && stage !== "doing") {
        set.checkoutRunId = null;
        set.checkoutBy = null;
        set.lockExpiresAt = null;
      }

      const mayReshape = row.createdBy === self.id || isManager(self);
      const reshaping =
        body.visibility !== undefined || body.members !== undefined;
      if (reshaping && !mayReshape) return forbidden;
      const maker = row.createdBy ?? self.id;
      const visibility =
        body.visibility === undefined
          ? row.visibility
          : visibilityFor(body.visibility, id, maker);
      if (visibility !== row.visibility) fields.push("visibility");
      const current = (await membersOf(tx, [id])).get(id) ?? [];
      const asked =
        body.members === undefined
          ? current
          : idList(body.members, "members", HUB_TASK_LIMITS.members);
      if (body.members !== undefined) fields.push("members");
      const assignee =
        body.assignee === undefined
          ? row.assignee
          : body.assignee === null
            ? null
            : assigneeOf(body.assignee);
      const reassigned = assignee !== row.assignee;
      if (reassigned) fields.push("assignee");
      // A claim outlives an edit only while the task stays in `doing`, so this is "nobody holds it".
      if (
        stage === "doing" &&
        row.checkoutRunId === null &&
        workedByRun(assignee)
      )
        throw new Invalid("stage");
      const assigned = assigneeMember(assignee);
      const added = [
        ...asked.filter((m) => !current.includes(m)),
        ...(reassigned && assigned ? [assigned] : []),
      ];
      const named = [...new Set(added)];
      const active = await activeOf(tx, named);
      if (reassigned && assigned && !active.includes(assigned))
        throw new Invalid("assignee");
      if (active.length !== named.length) throw new Invalid("members");
      const members = new Set(asked);
      if (visibility.startsWith("task:") && row.createdBy)
        members.add(row.createdBy);
      if (!assigneeFits(visibility, assigned, members))
        throw new Invalid("assignee");
      // Nobody who has left the company goes back on: the maker, or an assignee kept from before,
      // may be gone, and `leaveEveryTask` took them off.
      const stay = new Set(await activeOf(tx, [...members]));
      for (const member of members)
        if (!stay.has(member)) members.delete(member);
      if (!mayReshape && [...members].some((m) => !current.includes(m)))
        return forbidden;
      if (fields.length === 0 && note === null) throw new Invalid("body");

      const before = await audienceOf(tx, row.visibility);
      if (reassigned) {
        set.assignee = assignee;
        set.assignedBy = assignee ? self.id : null;
      }
      if (visibility !== row.visibility) set.visibility = visibility;
      const membersChanged =
        members.size !== current.length || current.some((m) => !members.has(m));
      if (membersChanged) await writeMembers(tx, id, members);
      const [next] = await tx
        .update(hubTasks)
        .set({
          ...set,
          version: sql`${hubTasks.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(hubTasks.id, id))
        .returning();
      if (!next) throw new Error("hub_tasks update returned nothing");
      if (note !== null) {
        await tx
          .insert(hubTaskNotes)
          .values({ taskId: id, by: `m:${self.id}`, text: note, runId });
      }
      // Whoever could see it a moment ago hears of it too, so a board drops what it may no longer
      // show.
      const seq = await emitEvent(tx, {
        type: "task.changed",
        refId: id,
        actor: self.id,
        visibleTo: unionOf(before, await audienceOf(tx, next.visibility)),
      });
      if (reassigned && next.assignee)
        await emitAssigned(
          tx,
          { id, visibility: next.visibility, assignee: next.assignee },
          self.id,
        );
      emitted();
      await audit("ok", {
        stage: next.stage,
        fields,
        noteChars: note?.length ?? 0,
      });
      return {
        status: 200,
        body: { ok: true, task: await viewOne(tx, next), seq },
      };
    });
  });

  route.post("/:id/notes", limited, async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return badId(context);
    const body = await readJson(context);
    if (!body) return context.json(invalid("body").body as object, 400);
    const self = context.get("member");
    return write(context, async (tx, emitted) => {
      const as = asOf(body.as);
      const runId = runOf(body.runId, context.req.header(HUB_HEADERS.run));
      const note = noteOf(body.text, as);
      if (note === null) throw new Invalid("text");
      const row = await visibleTask(tx, id, self.id);
      if (!row) return notFound;
      const [inserted] = await tx
        .insert(hubTaskNotes)
        .values({
          taskId: id,
          by: `${as === "bot" ? "bot" : "m"}:${self.id}`,
          text: note,
          runId,
        })
        .returning({ id: hubTaskNotes.id });
      await tx
        .update(hubTasks)
        .set({ updatedAt: sql`now()` })
        .where(eq(hubTasks.id, id));
      const seq = await emitEvent(tx, {
        type: "task.changed",
        refId: id,
        actor: self.id,
        visibleTo: await audienceOf(tx, row.visibility),
      });
      emitted();
      await recordAudit(tx, {
        action: "task.noted",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        runId,
        outcome: "ok",
        payload: { as, chars: note.length },
      });
      return { status: 200, body: { ok: true, id: inserted?.id, seq } };
    });
  });

  /** The run id a claim route is called with, in the body or `x-laf-run`. Required. */
  const claimRun = (body: Record<string, unknown>, context: Context) => {
    const run = runOf(body.runId, context.req.header(HUB_HEADERS.run));
    if (run === null) throw new Invalid("runId");
    return run;
  };

  route.post("/:id/checkout", limited, async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return badId(context);
    const body = (await readJson(context)) ?? {};
    const self = context.get("member");
    return write(context, async (tx, emitted) => {
      const runId = claimRun(body, context);
      const audit = (outcome: string) =>
        recordAudit(tx, {
          action: "task.checkout",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: id,
          runId,
          outcome,
        });
      // A task given to somebody is theirs to take; one given to nobody is anybody's who sees it.
      // A job's task is taken on the VM of whoever gave it to the job.
      const forMe = sql`(${hubTasks.assignee} is null or ${hubTasks.assignee} = ${`m:${self.id}`} or ${hubTasks.assignee} = ${`bot:${self.id}`} or (${hubTasks.assignee} like 'job:%' and ${hubTasks.assignedBy} = ${self.id}))`;
      const [claimed] = await tx
        .update(hubTasks)
        .set({
          checkoutRunId: runId,
          checkoutBy: self.id,
          lockExpiresAt: lockUntil(),
          stage: "doing",
          version: sql`${hubTasks.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(hubTasks.id, id),
            visibleTo(hubTasks.visibility, self.id),
            forMe,
            or(
              sql`(${hubTasks.stage} = 'todo' and ${hubTasks.checkoutRunId} is null)`,
              // A holder whose time ran out and has not been swept yet: taken over, not waited on.
              sql`(${hubTasks.stage} = 'doing' and ${hubTasks.checkoutRunId} is not null and ${hubTasks.lockExpiresAt} < now())`,
            ),
          ),
        )
        .returning();
      if (claimed) {
        const seq = await emitEvent(tx, {
          type: "task.changed",
          refId: id,
          actor: self.id,
          visibleTo: await audienceOf(tx, claimed.visibility),
        });
        emitted();
        await audit("ok");
        return {
          status: 200,
          body: { ok: true, task: await viewOne(tx, claimed), seq },
        };
      }
      // The same run asking again (a retry after a lost answer) is told it holds the task.
      const [mine] = await tx
        .update(hubTasks)
        .set({ lockExpiresAt: lockUntil() })
        .where(
          and(
            eq(hubTasks.id, id),
            visibleTo(hubTasks.visibility, self.id),
            eq(hubTasks.stage, "doing"),
            eq(hubTasks.checkoutRunId, runId),
            eq(hubTasks.checkoutBy, self.id),
          ),
        )
        .returning();
      if (mine) {
        return {
          status: 200,
          body: { ok: true, task: await viewOne(tx, mine) },
        };
      }
      if (!(await visibleTask(tx, id, self.id))) {
        await audit(HUB_FACTS.notFound);
        return notFound;
      }
      await audit(HUB_TASK_FACTS.taken);
      return taken;
    });
  });

  route.post("/:id/heartbeat", limited, async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return badId(context);
    const body = (await readJson(context)) ?? {};
    const self = context.get("member");
    return write(context, async (tx) => {
      const runId = claimRun(body, context);
      // No event and no version: a beat changes nothing anybody reads but the claim's end.
      const [beat] = await tx
        .update(hubTasks)
        .set({ lockExpiresAt: lockUntil() })
        .where(
          and(
            eq(hubTasks.id, id),
            visibleTo(hubTasks.visibility, self.id),
            eq(hubTasks.stage, "doing"),
            eq(hubTasks.checkoutRunId, runId),
            eq(hubTasks.checkoutBy, self.id),
          ),
        )
        .returning({ until: hubTasks.lockExpiresAt });
      if (!beat?.until) {
        await recordAudit(tx, {
          action: "task.heartbeat",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: id,
          runId,
          outcome: HUB_TASK_FACTS.notHeld,
        });
        return notHeld;
      }
      return {
        status: 200,
        body: { ok: true, until: beat.until.toISOString() },
      };
    });
  });

  route.post("/:id/release", limited, async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return badId(context);
    const body = (await readJson(context)) ?? {};
    const self = context.get("member");
    return write(context, async (tx, emitted) => {
      const runId = claimRun(body, context);
      const audit = (outcome: string) =>
        recordAudit(tx, {
          action: "task.released",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: id,
          runId,
          outcome,
        });
      // Only the run that holds it, from the member whose run it is: a run id is not a secret.
      // And only while that member still sees it: the answer carries the task, and a holder cut
      // off by a narrowing is not_held here as at `/heartbeat`, its claim left to run out.
      const [released] = await tx
        .update(hubTasks)
        .set({
          checkoutRunId: null,
          checkoutBy: null,
          lockExpiresAt: null,
          stage: sql`case when ${hubTasks.stage} = 'doing' then 'todo' else ${hubTasks.stage} end`,
          version: sql`${hubTasks.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(hubTasks.id, id),
            visibleTo(hubTasks.visibility, self.id),
            eq(hubTasks.checkoutRunId, runId),
            eq(hubTasks.checkoutBy, self.id),
          ),
        )
        .returning();
      if (!released) {
        await audit(HUB_TASK_FACTS.notHeld);
        return notHeld;
      }
      const seq = await emitEvent(tx, {
        type: "task.changed",
        refId: id,
        actor: self.id,
        visibleTo: await audienceOf(tx, released.visibility),
      });
      emitted();
      await audit("ok");
      return {
        status: 200,
        body: { ok: true, task: await viewOne(tx, released), seq },
      };
    });
  });

  return route;
}
