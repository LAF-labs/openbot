import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HUB_FACTS,
  HUB_JOB_FACTS,
  HUB_JOB_HANDOFF_MS,
  HUB_JOB_LIMITS,
  hubJobHandoffBytes,
  type HubJobHandoff,
} from "../../shared/hub/protocol";
import type { Logger } from "../../shared/log";
import { recordAudit } from "./audit";
import type { MemberVariables } from "./auth";
import { forbidden, isManager, notFound, readJson } from "./budget";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubJobHandoffs, hubJobs } from "./db/schema";
import { emitEvent, type Listeners } from "./events";
import type { Answer } from "./idempotency";

/**
 * A sub-Bot's handoff: how its definition gets from the VM the job moved away from to the VM it
 * moved to, when neither knows the other's address nor could tell the other's pass from an
 * impostor's. The hub is the go-between and holds the definition no longer than that takes.
 *
 * THE SLOT IS MADE BY THE MOVE. When a job's runner changes (`jobs.ts`), the hub notes who it moved
 * from and to, with no body yet — that note is what "a move is pending" means. Only the member it
 * moved FROM may fill it (`PUT`), only the member it moved TO may read it (`GET`), and they or an
 * owner/admin clear it (`DELETE`). The definition is never the register's: the job's own rows,
 * events, the trail and the log carry ids and sizes, never it.
 *
 * A SECOND MOVE BEFORE THE FIRST IS COLLECTED keeps who it came from — that VM still holds the
 * definition, or already handed it here — and points the slot at the newest runner. A move back to
 * where it came from keeps the slot too: the old VM may have turned its copy off and sent the
 * definition already, and taking it back is then how it gets its routine again.
 *
 * WHY NOT STRICTER ON `to`. The VM's PUT names who it hands to, as it read the register. The hub
 * delivers to whom the register says now; a `to` that a later move made stale is not refused,
 * because the VM's outbox drops a refused write, and the definition would be lost with it.
 */

const ID_SHAPE = /^[A-Za-z0-9_-]{1,80}$/;

/** Room for the definition and the `to` around it; the definition alone is measured after. */
const handoffBodyLimit = bodyLimit({
  maxSize: HUB_JOB_LIMITS.handoffBytes + 1024,
  onError: (context) =>
    context.json(
      { ok: false, code: "laf:request_invalid", field: "definition" },
      413,
    ),
});

const notMoving: Answer = {
  status: 409,
  body: { ok: false, code: HUB_JOB_FACTS.notMoving },
};

const expiry = () =>
  sql`now() + make_interval(secs => ${HUB_JOB_HANDOFF_MS / 1000})`;

type HandoffRow = typeof hubJobHandoffs.$inferSelect;

async function liveHandoff(
  tx: HubDatabase | HubTransaction,
  jobId: string,
  lock: boolean,
): Promise<HandoffRow | undefined> {
  const query = tx
    .select()
    .from(hubJobHandoffs)
    .where(
      and(
        eq(hubJobHandoffs.jobId, jobId),
        gt(hubJobHandoffs.expiresAt, sql`now()`),
      ),
    );
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

/**
 * Called inside the transaction that changed a job's runner from `from` to `to`. Makes the job's
 * slot, or points the one already there at the newest runner.
 */
export async function noteJobMove(
  tx: HubTransaction,
  jobId: string,
  from: string,
  to: string,
): Promise<void> {
  const held = await liveHandoff(tx, jobId, true);
  if (held) {
    await tx
      .update(hubJobHandoffs)
      .set({ toMember: to, expiresAt: expiry() })
      .where(eq(hubJobHandoffs.jobId, jobId));
    return;
  }
  // One that ran out is no move pending any more: replaced, body and all.
  await tx
    .insert(hubJobHandoffs)
    .values({
      jobId,
      fromMember: from,
      toMember: to,
      body: null,
      expiresAt: expiry(),
    })
    .onConflictDoUpdate({
      target: hubJobHandoffs.jobId,
      set: {
        fromMember: from,
        toMember: to,
        body: null,
        createdAt: sql`now()`,
        expiresAt: expiry(),
      },
    });
}

/** Drops the handoffs nobody came for. Run at boot and hourly, beside the idempotency sweep. */
export async function sweepExpiredHandoffs(
  database: HubDatabase,
): Promise<number> {
  const removed = await database
    .delete(hubJobHandoffs)
    .where(lt(hubJobHandoffs.expiresAt, sql`now()`))
    .returning({ jobId: hubJobHandoffs.jobId });
  return removed.length;
}

/** Hourly, and once at boot. Never throws out of the timer (`task-sweeper.ts` says why). */
export function startHandoffSweeper(input: {
  database: HubDatabase;
  log: Logger;
  everyMs?: number;
}): { stop(): void; sweep(): Promise<void> } {
  let running: Promise<void> | null = null;
  const sweep = (): Promise<void> => {
    if (running) return running;
    running = sweepExpiredHandoffs(input.database)
      .then((dropped) => {
        if (dropped > 0) input.log.info("job_handoffs_swept", { dropped });
      })
      .catch((error: unknown) => {
        input.log.warn("job_handoff_sweep_failed", { error });
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  const tick = setInterval(
    () => {
      try {
        void sweep();
      } catch (error) {
        input.log.warn("job_handoff_sweep_failed", { error });
      }
    },
    input.everyMs ?? 60 * 60 * 1000,
  );
  return { stop: () => clearInterval(tick), sweep };
}

/** The definition's size as JSON, in bytes, or null when it is not an object. */
function definitionBytes(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return hubJobHandoffBytes(value);
}

const reply = (context: Context, answer: Answer) =>
  context.json(answer.body as Record<string, unknown>, answer.status as 200);

/** `PUT|GET|DELETE /jobs/:id/handoff`, on the jobs route (which has already checked the pass). */
export function addHandoffRoutes(
  route: Hono<{ Variables: MemberVariables }>,
  options: { database: HubDatabase; listeners: Listeners },
): void {
  const { database, listeners } = options;

  route.put("/:id/handoff", handoffBodyLimit, async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return reply(context, notFound);
    const self = context.get("member");
    const body = await readJson(context);
    const invalid = (field: string): Answer => ({
      status: 400,
      body: { ok: false, code: "laf:request_invalid", field },
    });
    if (!body) return reply(context, invalid("body"));
    const unknown = Object.keys(body).find(
      (key) => key !== "to" && key !== "definition",
    );
    if (unknown) return reply(context, invalid(unknown));
    if (
      body.to !== undefined &&
      (typeof body.to !== "string" || !ID_SHAPE.test(body.to))
    )
      return reply(context, invalid("to"));
    const bytes = definitionBytes(body.definition);
    if (bytes === null) return reply(context, invalid("definition"));
    if (bytes > HUB_JOB_LIMITS.handoffBytes) {
      return context.json(
        { ok: false, code: "laf:request_invalid", field: "definition" },
        413,
      );
    }

    let poke = false;
    const answer = await database.transaction(async (tx): Promise<Answer> => {
      const [job] = await tx
        .select({ id: hubJobs.id })
        .from(hubJobs)
        .where(eq(hubJobs.id, id));
      if (!job) return notFound;
      const held = await liveHandoff(tx, id, true);
      const audit = (outcome: string, to?: string) =>
        recordAudit(tx, {
          action: "job.handoff_put",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: id,
          outcome,
          payload: { bytes, ...(to ? { to } : {}) },
        });
      if (!held || held.fromMember !== self.id) {
        await audit(HUB_JOB_FACTS.notMoving);
        return notMoving;
      }
      const [stored] = await tx
        .update(hubJobHandoffs)
        .set({ body: body.definition, expiresAt: expiry() })
        .where(eq(hubJobHandoffs.jobId, id))
        .returning({
          to: hubJobHandoffs.toMember,
          expiresAt: hubJobHandoffs.expiresAt,
        });
      if (!stored) throw new Error("hub_job_handoffs update returned nothing");
      // The new runner's VM may have looked before this came; told again, it looks again.
      const seq = await emitEvent(tx, {
        type: "job.moved",
        refId: id,
        actor: self.id,
        visibleTo: [stored.to],
      });
      poke = true;
      await audit("ok", stored.to);
      return {
        status: 200,
        body: {
          ok: true,
          to: stored.to,
          expiresAt: stored.expiresAt.toISOString(),
          seq,
        },
      };
    });
    if (poke) listeners.pokeAll();
    return reply(context, answer);
  });

  route.get("/:id/handoff", async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return reply(context, notFound);
    const self = context.get("member");
    const [job] = await database
      .select({ runner: hubJobs.runner })
      .from(hubJobs)
      .where(eq(hubJobs.id, id));
    if (!job) return reply(context, notFound);
    const held = await liveHandoff(database, id, false);
    // Only the member it moved to: not its old runner, not an admin, not anybody else.
    if (job.runner !== self.id || (held && held.toMember !== self.id))
      return reply(context, forbidden);
    if (!held || held.body === null) return reply(context, notFound);
    const handoff: HubJobHandoff = {
      jobId: held.jobId,
      from: held.fromMember,
      to: held.toMember,
      definition: held.body,
      createdAt: held.createdAt.toISOString(),
      expiresAt: held.expiresAt.toISOString(),
    };
    return context.json({ ok: true, handoff });
  });

  route.delete("/:id/handoff", async (context) => {
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return reply(context, notFound);
    const self = context.get("member");
    const answer = await database.transaction(async (tx): Promise<Answer> => {
      const held = await liveHandoff(tx, id, true);
      if (!held) return notFound;
      if (held.toMember !== self.id && !isManager(self)) {
        await recordAudit(tx, {
          action: "job.handoff_cleared",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: id,
          outcome: HUB_FACTS.forbidden,
        });
        return forbidden;
      }
      await tx.delete(hubJobHandoffs).where(eq(hubJobHandoffs.jobId, id));
      await recordAudit(tx, {
        action: "job.handoff_cleared",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        outcome: "ok",
        payload: { from: held.fromMember, to: held.toMember },
      });
      return { status: 200, body: { ok: true } };
    });
    return reply(context, answer);
  });
}
