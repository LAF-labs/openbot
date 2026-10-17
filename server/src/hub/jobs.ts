/**
 * A routine registered as a named sub-Bot on the company hub, and what happens when its owner is
 * handed on.
 *
 * THE SHAPE (lafi-dev-design §7). A sub-Bot is a routine on its owner's VM plus a row in the hub's
 * register (`PUT /jobs/:id`): its name, the owner and the member whose VM runs it, a schedule line,
 * a limit. No instruction, no answers, nothing it found. Here, `hub_job_routines` says which routine
 * that row is, so every run of it reserves against the job's own day too (`job:<id>`, `budget.ts`).
 *
 * WHEN THE OWNER CHANGES the hub says `job.moved` to the old runner and the new one.
 * - The old VM turns its copy off first — so the two VMs never both run it — and hands the
 *   definition on, then forgets the job.
 * - The new VM takes the definition, makes the routine for its own person and 라피, and from then
 *   on the job is its.
 *
 * HOW THE DEFINITION TRAVELS, given that the register holds none. From the old runner's VM, through
 * a one-time handoff on the hub (`PUT /jobs/:id/handoff {to, definition}`), sent through the outbox
 * so a hub that is away loses nothing; the new runner's VM takes it (`GET`) and clears it
 * (`DELETE`). What crosses is what the person wrote and when it runs — the name, the instruction,
 * the summary line, the schedule, where results go — and nothing the routine did: no notepad, no
 * answers, no webhook token. The hub authenticates both ends by their passes and gives the handoff
 * only to the member it names, and keeps it no longer than it takes the new VM to collect it: the
 * register stays content-free, and no VM ever talks to another VM directly (neither knows the
 * other's address, and neither could tell the other's pass from an impostor's).
 *
 * A handoff that is not there yet — the old VM is down, or slower than the event — is looked for
 * again at every `job.changed` and every time the line comes back (`scan`), so a new runner whose
 * old one was offline for a day still gets it the moment it can.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { hubJobRoutines, lafRoutines } from "../db/schema";
import { log } from "../log";
import { scheduleOf } from "../routines/schedule";
import type { HubHttp } from "./http";
import type { HubFrame } from "./link";
import type { HubOutbox } from "./outbox";
import {
  HUB_JOB_PATHS,
  type JobDefinition,
  jobHandoffBody,
  jobRegisterBody,
  readJob,
  readJobHandoff,
} from "./wire";

export type HubJobs = {
  /** The job a routine is registered as, or null. What its runs reserve against beside the workspace. */
  jobOf(routineId: string): Promise<string | null>;
  /** Register one of the person's routines as a named sub-Bot. The routine must be theirs. */
  register(
    actor: AgentActor,
    routineId: string,
  ): Promise<{ ok: true; jobId: string } | { ok: false; code: string }>;
  /** An event off the hub's line. Only the jobs' are looked at. */
  heard(event: { type: string; refId: string | null }): void;
  /** Every job this VM runs now and has no routine for: its handoff looked for. At boot and on reconnect. */
  scan(): Promise<void>;
  /** Whatever is being handled now, settled. For a test, and for leaving. */
  idle(): Promise<void>;
};

export type HubJobsOptions = {
  database: Database;
  http: HubHttp;
  outbox: Pick<HubOutbox, "enqueue">;
  /** This VM's member id on the hub, from the last `/me` that answered; null before one did. */
  memberId: () => string | null;
  /** Whether the routine is this actor's to register (`routines/ownership.ts`, `mine`). Throws if not. */
  mine: (actor: AgentActor, routineId: string) => Promise<unknown>;
  /** Make the routine on this VM, for its person and their 라피. Answers its id. */
  install: (definition: JobDefinition) => Promise<string>;
  now?: () => Date;
};

/** The schedule as one line for the register: when it runs, never what it does. */
export function scheduleLine(definition: JobDefinition["schedule"]): string {
  if (definition.kind === "interval") return `every ${definition.minutes}m`;
  const days =
    definition.days && definition.days.length > 0
      ? ` days:${definition.days.join(",")}`
      : "";
  return `daily ${definition.time} ${definition.timeZone}${days}`;
}

/** A routine as it travels: what its person wrote and when it runs. */
async function definitionOf(
  database: Database,
  routineId: string,
): Promise<JobDefinition | null> {
  const [row] = await database
    .select()
    .from(lafRoutines)
    .where(eq(lafRoutines.id, routineId))
    .limit(1);
  if (!row) return null;
  const schedule = scheduleOf(row);
  return {
    name: row.name,
    instruction: row.instruction,
    summary: row.summary,
    schedule:
      schedule.kind === "interval"
        ? { kind: "interval", minutes: schedule.minutes }
        : {
            kind: "daily",
            time: schedule.time,
            timeZone: schedule.timeZone,
            // A plain array: the driver hands the column back as an `Int32Array`, which JSON
            // writes as an object of indexes, and the new VM would read no days at all.
            days: schedule.days.length > 0 ? Array.from(schedule.days) : null,
          },
    delivery: row.delivery === "feed" ? "feed" : "chat",
  };
}

const JOB_EVENTS: ReadonlySet<string> = new Set(["job.moved", "job.changed"]);

export function createHubJobs(options: HubJobsOptions): HubJobs {
  const { database, http } = options;
  const now = options.now ?? (() => new Date());
  /** Jobs being looked at now. Added before the first await, so two events make one look. */
  const busy = new Map<string, Promise<void>>();

  const jobOf: HubJobs["jobOf"] = async (routineId) => {
    const [row] = await database
      .select({ jobId: hubJobRoutines.jobId })
      .from(hubJobRoutines)
      .where(eq(hubJobRoutines.routineId, routineId))
      .limit(1);
    return row?.jobId ?? null;
  };

  const localOf = async (jobId: string) => {
    const [row] = await database
      .select({ routineId: hubJobRoutines.routineId })
      .from(hubJobRoutines)
      .where(eq(hubJobRoutines.jobId, jobId))
      .limit(1);
    return row?.routineId ?? null;
  };

  /** The job went to another member: this copy off first, the definition handed on, the job let go. */
  const handOn = async (jobId: string, routineId: string, to: string) => {
    const definition = await definitionOf(database, routineId);
    await database
      .update(lafRoutines)
      .set({ enabled: false, updatedAt: now() })
      .where(eq(lafRoutines.id, routineId));
    if (definition) {
      await options.outbox.enqueue({
        method: "PUT",
        path: HUB_JOB_PATHS.handoff(jobId),
        body: jobHandoffBody({ to, definition }),
        origin: "job",
      });
    }
    await database
      .delete(hubJobRoutines)
      .where(eq(hubJobRoutines.jobId, jobId));
    log.info("hub_job_handed_on", { job: jobId, routine: routineId });
  };

  /** The job is this VM's now: its definition collected, the routine made, the handoff cleared. */
  const takeOver = async (jobId: string) => {
    const answer = await http.request({
      path: HUB_JOB_PATHS.handoff(jobId),
      retry: false,
    });
    const definition = answer.ok ? readJobHandoff(answer.body) : null;
    if (!definition) {
      // Not there yet: looked for again at the next `job.changed` and the next reconnect.
      log.info("hub_job_handoff_waiting", {
        job: jobId,
        code: answer.ok ? null : answer.code,
      });
      return;
    }
    const routineId = await options.install(definition);
    await database
      .insert(hubJobRoutines)
      .values({ jobId, routineId })
      .onConflictDoNothing();
    await options.outbox.enqueue({
      method: "DELETE",
      path: HUB_JOB_PATHS.handoff(jobId),
      origin: "job",
    });
    log.info("hub_job_taken_over", { job: jobId, routine: routineId });
  };

  const look = async (jobId: string): Promise<void> => {
    const me = options.memberId();
    if (!me) return;
    const read = await http.request({
      path: HUB_JOB_PATHS.job(jobId),
      retry: false,
    });
    if (!read.ok) {
      if (read.code !== "laf:hub_not_found") {
        log.warn("hub_job_not_read", { job: jobId, code: read.code });
      }
      return;
    }
    const job = readJob(read.body);
    if (!job) return;
    const local = await localOf(jobId);
    if (local && job.runner !== me) {
      await handOn(jobId, local, job.runner);
      return;
    }
    if (!local && job.runner === me) await takeOver(jobId);
  };

  const consider = (jobId: string): Promise<void> => {
    const current = busy.get(jobId);
    if (current) return current;
    const going = look(jobId)
      .catch((error: unknown) => {
        log.error("hub_job_look_failed", {
          job: jobId,
          reason: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => busy.delete(jobId));
    busy.set(jobId, going);
    return going;
  };

  return {
    jobOf,

    async register(actor, routineId) {
      await options.mine(actor, routineId);
      const definition = await definitionOf(database, routineId);
      if (!definition) return { ok: false, code: "laf:routine_not_found" };
      const jobId = (await jobOf(routineId)) ?? randomUUID();
      const answer = await http.request({
        method: "PUT",
        path: HUB_JOB_PATHS.job(jobId),
        body: jobRegisterBody({
          name: definition.name,
          schedule: scheduleLine(definition.schedule),
        }),
        origin: "person",
      });
      if (!answer.ok) return { ok: false, code: answer.code };
      await database
        .insert(hubJobRoutines)
        .values({ jobId, routineId })
        .onConflictDoNothing();
      return { ok: true, jobId };
    },

    heard(event) {
      if (!JOB_EVENTS.has(event.type) || !event.refId) return;
      void consider(event.refId);
    },

    async scan() {
      const me = options.memberId();
      if (!me) return;
      const answer = await http.request({
        path: HUB_JOB_PATHS.list,
        retry: false,
      });
      if (!answer.ok) return;
      const body = answer.body as { jobs?: unknown } | null;
      const jobs = Array.isArray(body?.jobs)
        ? body.jobs.map(readJob).filter((job) => job !== null)
        : [];
      await Promise.all(
        jobs.map(async (job) => {
          const local = await localOf(job.id);
          if ((job.runner === me) !== Boolean(local)) await consider(job.id);
        }),
      );
    },

    async idle() {
      while (busy.size > 0) await Promise.allSettled([...busy.values()]);
    },
  };
}

/** What the line delivers, as the sub-Bots hear it (`main.ts`): an event names a job; the line up is a scan. */
export function hearJobFrame(
  jobs: HubJobs | undefined,
  frame: HubFrame,
): Promise<void> {
  if (!jobs) return Promise.resolve();
  if ("state" in frame) {
    return frame.state === "connected" ? jobs.scan() : Promise.resolve();
  }
  jobs.heard({ type: frame.kind.slice("hub.".length), refId: frame.refId });
  return Promise.resolve();
}
