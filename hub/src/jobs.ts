import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  HUB_BUDGET_LIMITS,
  HUB_JOB_LIMITS,
  type HubJob,
} from "../../shared/hub/protocol";
import { recordAudit } from "./audit";
import type { MemberVariables } from "./auth";
import {
  dollars,
  forbidden,
  Invalid,
  isManager,
  limited,
  notFound,
  setLimit,
  writer,
} from "./budget";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubBudgetLimits, hubJobs, hubMembers } from "./db/schema";
import { emitEvent, type Listeners } from "./events";
import { addHandoffRoutes, noteJobMove } from "./job-handoff";
import { freeMovedJobClaims } from "./tasks";

/**
 * The sub-Bot register: which named, scheduled jobs exist, who owns each, whose VM runs it, when,
 * and its daily limit. Never what a job is told or what it found — those stay on the VM that runs
 * it. Everybody may read the register; it holds nothing a member could not be shown.
 *
 * WHO MAY DO WHAT.
 * - Anybody registers a job of their own. An owner or admin may register one for another member.
 * - Its owner or an owner/admin edits it, hands it to another member, or removes it.
 * - Its daily limit is an owner's or admin's to set (`lafi-dev-design.md` §7): a member does not set
 *   the ceiling on their own spending.
 *
 * THE RUNNER FOLLOWS THE OWNER. A job runs on its owner's VM unless set apart, so handing a job to
 * another member moves it: `job.moved` goes to the old runner, whose VM drops it, and the new one,
 * whose VM picks it up. `job.changed` goes to everybody, so every register on screen reads it again.
 * The move also opens the job's handoff slot (`job-handoff.ts`), through which the old VM hands the
 * new one the definition the register never holds.
 */

const ID_SHAPE = /^[A-Za-z0-9_-]{1,80}$/;

type JobRow = typeof hubJobs.$inferSelect;

function jobView(row: JobRow, dailyUsd: string | null): HubJob {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    runner: row.runner,
    schedule: row.schedule,
    dailyUsd: dailyUsd === null ? null : Number(dailyUsd),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function limitsOfJobs(
  database: HubDatabase | HubTransaction,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await database
    .select({ id: hubBudgetLimits.scopeId, usd: hubBudgetLimits.dailyUsd })
    .from(hubBudgetLimits)
    .where(
      and(
        eq(hubBudgetLimits.scopeKind, "job"),
        inArray(hubBudgetLimits.scopeId, ids),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.usd]));
}

async function viewOne(
  database: HubDatabase | HubTransaction,
  row: JobRow,
): Promise<HubJob> {
  return jobView(
    row,
    (await limitsOfJobs(database, [row.id])).get(row.id) ?? null,
  );
}

function text(
  value: unknown,
  field: string,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Invalid(field);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Invalid(field);
  return trimmed === "" ? null : trimmed;
}

function memberId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ID_SHAPE.test(value))
    throw new Invalid(field);
  return value;
}

type JobInput = {
  name: string | undefined;
  owner: string | undefined;
  runner: string | undefined;
  schedule: string | null | undefined;
  /** Dollars to six places, null to clear, undefined to leave. */
  dailyUsd: string | null | undefined;
};

function jobInput(body: Record<string, unknown>): JobInput {
  const known = ["name", "owner", "runner", "schedule", "dailyUsd"];
  // The register holds no content: a prompt or a result sent here is refused, not dropped quietly.
  const unknown = Object.keys(body).find((key) => !known.includes(key));
  if (unknown) throw new Invalid(unknown);
  const name = text(body.name, "name", HUB_JOB_LIMITS.name);
  if (name === null) throw new Invalid("name");
  return {
    name,
    owner: memberId(body.owner, "owner"),
    runner: memberId(body.runner, "runner"),
    schedule: text(body.schedule, "schedule", HUB_JOB_LIMITS.schedule),
    dailyUsd:
      body.dailyUsd === undefined || body.dailyUsd === null
        ? (body.dailyUsd as null | undefined)
        : dollars(body.dailyUsd, "dailyUsd", {
            min: 0,
            max: HUB_BUDGET_LIMITS.daily,
            zero: true,
          }),
  };
}

async function allActive(tx: HubTransaction, ids: string[]): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  const rows = await tx
    .select({ id: hubMembers.id })
    .from(hubMembers)
    .where(and(inArray(hubMembers.id, unique), eq(hubMembers.state, "active")));
  return rows.length === unique.length;
}

export type JobRouteOptions = {
  database: HubDatabase;
  listeners: Listeners;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
};

export function jobRoutes(options: JobRouteOptions) {
  const { database, listeners } = options;
  const route = new Hono<{ Variables: MemberVariables }>();
  route.use(options.member);
  const write = writer(database, listeners);
  addHandoffRoutes(route, { database, listeners });

  route.get("/", async (context) => {
    const rows = await database
      .select()
      .from(hubJobs)
      .orderBy(asc(hubJobs.createdAt), asc(hubJobs.id))
      .limit(1000);
    const limits = await limitsOfJobs(
      database,
      rows.map((row) => row.id),
    );
    return context.json({
      ok: true,
      jobs: rows.map((row) => jobView(row, limits.get(row.id) ?? null)),
    });
  });

  route.get("/:id", async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return context.json(notFound.body as object, 404);
    const [row] = await database
      .select()
      .from(hubJobs)
      .where(eq(hubJobs.id, id));
    if (!row) return context.json(notFound.body as object, 404);
    return context.json({ ok: true, job: await viewOne(database, row) });
  });

  /** Registers the job under this id, or edits the one there. */
  route.put("/:id", limited, async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return context.json(notFound.body as object, 404);
    const self = context.get("member");
    return write(context, jobInput, async (tx, input, emitted) => {
      const [row] = await tx
        .select()
        .from(hubJobs)
        .where(eq(hubJobs.id, id))
        .for("update");
      if (input.dailyUsd !== undefined && !isManager(self)) return forbidden;

      if (!row) {
        if (!input.name) throw new Invalid("name");
        const owner = input.owner ?? self.id;
        const runner = input.runner ?? owner;
        if ((owner !== self.id || runner !== self.id) && !isManager(self))
          return forbidden;
        if (!(await allActive(tx, [owner, runner]))) throw new Invalid("owner");
        const [made] = await tx
          .insert(hubJobs)
          .values({
            id,
            name: input.name,
            owner,
            runner,
            schedule: input.schedule ?? null,
            createdBy: self.id,
          })
          .returning();
        if (!made) throw new Error("hub_jobs insert returned nothing");
        if (input.dailyUsd !== undefined)
          await setLimit(tx, self, `job:${id}`, input.dailyUsd);
        const seq = await emitEvent(tx, {
          type: "job.changed",
          refId: id,
          actor: self.id,
        });
        emitted();
        await recordAudit(tx, {
          action: "job.created",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: id,
          outcome: "ok",
          payload: { owner, runner },
        });
        return {
          status: 200,
          body: { ok: true, job: await viewOne(tx, made), seq },
        };
      }

      if (row.owner !== self.id && !isManager(self)) return forbidden;
      const owner = input.owner ?? row.owner;
      // Handing a job on moves it to the new owner's VM unless the runner is named too.
      const runner = input.runner ?? (owner !== row.owner ? owner : row.runner);
      if (!(await allActive(tx, [owner, runner]))) throw new Invalid("owner");
      const fields: string[] = [];
      const set: Partial<typeof hubJobs.$inferInsert> = {};
      if (input.name !== undefined && input.name !== row.name) {
        set.name = input.name;
        fields.push("name");
      }
      if (input.schedule !== undefined && input.schedule !== row.schedule) {
        set.schedule = input.schedule;
        fields.push("schedule");
      }
      if (owner !== row.owner) {
        set.owner = owner;
        fields.push("owner");
      }
      if (runner !== row.runner) {
        set.runner = runner;
        fields.push("runner");
      }
      if (input.dailyUsd !== undefined) {
        await setLimit(tx, self, `job:${id}`, input.dailyUsd);
        fields.push("dailyUsd");
      }
      const [next] =
        Object.keys(set).length > 0
          ? await tx
              .update(hubJobs)
              .set({ ...set, updatedAt: sql`now()` })
              .where(eq(hubJobs.id, id))
              .returning()
          : [row];
      if (!next) throw new Error("hub_jobs update returned nothing");
      let seq: number | undefined;
      // Task rows before the event lock, as every transaction takes them (job row, task rows,
      // `emitEvent`'s lock): a report, an approval, a release or the sweep holds a task row and then
      // emits, so a move that emitted first and then reached for that row deadlocked with it.
      if (runner !== row.runner) {
        await noteJobMove(tx, id, row.runner, runner);
        await freeMovedJobClaims(tx, id, row.runner, self.id);
      }
      if (fields.length > 0) {
        seq = await emitEvent(tx, {
          type: "job.changed",
          refId: id,
          actor: self.id,
        });
        if (runner !== row.runner) {
          seq = await emitEvent(tx, {
            type: "job.moved",
            refId: id,
            actor: self.id,
            visibleTo: [row.runner, runner],
          });
        }
        emitted();
      }
      await recordAudit(tx, {
        action: "job.changed",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        outcome: "ok",
        payload: {
          fields,
          ...(runner !== row.runner ? { from: row.runner, to: runner } : {}),
        },
      });
      return {
        status: 200,
        body: {
          ok: true,
          job: await viewOne(tx, next),
          ...(seq === undefined ? {} : { seq }),
        },
      };
    });
  });

  route.delete("/:id", async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return context.json(notFound.body as object, 404);
    const self = context.get("member");
    let poke = false;
    const answer = await database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(hubJobs)
        .where(eq(hubJobs.id, id))
        .for("update");
      if (!row) return notFound;
      if (row.owner !== self.id && !isManager(self)) return forbidden;
      await tx.delete(hubJobs).where(eq(hubJobs.id, id));
      await tx
        .delete(hubBudgetLimits)
        .where(
          and(
            eq(hubBudgetLimits.scopeKind, "job"),
            eq(hubBudgetLimits.scopeId, id),
          ),
        );
      // Its VM reads the job again on `job.changed`, is told it is gone, and drops it.
      const seq = await emitEvent(tx, {
        type: "job.changed",
        refId: id,
        actor: self.id,
      });
      poke = true;
      await recordAudit(tx, {
        action: "job.deleted",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        outcome: "ok",
        payload: { runner: row.runner },
      });
      return { status: 200, body: { ok: true, seq } };
    });
    if (poke) listeners.pokeAll();
    return context.json(
      answer.body as Record<string, unknown>,
      answer.status as 200,
    );
  });

  return route;
}
