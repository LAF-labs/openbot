import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, hubJobRoutines, lafRoutines, users } from "../src/db/schema";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import { createHubJobs, scheduleLine } from "../src/hub/jobs";
import type { HubOutboxWrite } from "../src/hub/outbox";
import type { JobDefinition } from "../src/hub/wire";
import { mine } from "../src/routines/ownership";
import { createRoutineService } from "../src/routines/service";
import { TEST_POOL } from "./support/database";

/**
 * A routine registered as a sub-Bot, and handed on when its owner changes: the register holds no
 * instruction, the old VM turns its copy off and hands the definition on through the hub's one-time
 * handoff, and the new VM makes the routine from it. Against a real Postgres (the routine rows and
 * the job link), with the hub a script.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const suite = randomUUID().slice(0, 8);
const AUTHOR = { id: `hub-jobs-author-${suite}`, role: "user" as const };
const BOT = `hub-jobs-bot-${suite}`;
const routines = createRoutineService({
  database,
  resolveAgents: async () => ({}),
});

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: BOT, name: "라피", type: "remote_ag_ui", configuration: {} });
  await database
    .insert(users)
    .values({ id: AUTHOR.id, email: `${AUTHOR.id}@laf.test`, name: "사장님" });
});

afterAll(async () => {
  // The job links cascade with the routines.
  await database
    .delete(lafRoutines)
    .where(eq(lafRoutines.createdById, AUTHOR.id));
  await database.delete(users).where(eq(users.id, AUTHOR.id));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.$client.end();
});

/** The register and its handoffs, in memory, answering as #b1's routes are written to. */
function register() {
  const jobs = new Map<
    string,
    {
      id: string;
      name: string;
      owner: string;
      runner: string;
      schedule: string | null;
    }
  >();
  const handoffs = new Map<string, { to: string; definition: JobDefinition }>();
  const seen: (HubRequest & { as: string })[] = [];
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, body }) as HubAnswer<never>;
  const as = (member: string): HubHttp => ({
    async request(request) {
      seen.push({ ...request, as: member });
      const [, kind, id, rest] = request.path.split("/");
      if (kind !== "jobs")
        return { ok: false, status: 404, code: "laf:hub_not_found" };
      const method = request.method ?? "GET";
      if (!id) return ok({ ok: true, jobs: [...jobs.values()] });
      if (rest === "handoff") {
        if (method === "PUT") {
          handoffs.set(
            id,
            request.body as { to: string; definition: JobDefinition },
          );
          return ok({ ok: true });
        }
        const held = handoffs.get(id);
        if (!held || held.to !== member) {
          return { ok: false, status: 404, code: "laf:hub_not_found" };
        }
        if (method === "DELETE") handoffs.delete(id);
        return ok({ ok: true, handoff: held });
      }
      if (method === "PUT") {
        const body = request.body as { name: string; schedule: string | null };
        const job = jobs.get(id) ?? {
          id,
          name: body.name,
          owner: member,
          runner: member,
          schedule: body.schedule,
        };
        jobs.set(id, { ...job, name: body.name, schedule: body.schedule });
        return ok({ ok: true, job: jobs.get(id) });
      }
      const job = jobs.get(id);
      return job
        ? ok({ ok: true, job })
        : { ok: false, status: 404, code: "laf:hub_not_found" };
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  });
  return { jobs, handoffs, seen, as };
}

/** An outbox that sends at once, keeping what it was handed. */
function directOutbox(http: HubHttp) {
  const sent: HubOutboxWrite[] = [];
  return {
    sent,
    async enqueue(write: HubOutboxWrite) {
      sent.push(write);
      await http.request({
        method: write.method,
        path: write.path,
        ...(write.body ? { body: write.body } : {}),
      });
      return randomUUID();
    },
  };
}

async function routine(name: string) {
  const made = await routines.create(AUTHOR, {
    agentId: BOT,
    name,
    instruction: "매일 아침 어제 매출을 정리해서 알려줘",
    summary: "어제 매출 정리",
    schedule: {
      kind: "daily",
      time: "07:30",
      timeZone: "Asia/Seoul",
      days: [1, 2, 3, 4, 5],
    },
  });
  if (!made) throw new Error("the routine was not made");
  return made;
}

describe("a routine as the company's sub-Bot", () => {
  test("registered: the hub is told a name and a schedule line, never the instruction", async () => {
    const hub = register();
    const http = hub.as("m_a");
    const jobs = createHubJobs({
      database,
      http,
      outbox: directOutbox(http),
      memberId: () => "m_a",
      mine: (actor, id) => mine(database, actor, id),
      install: async () => {
        throw new Error("not this VM's to install");
      },
    });
    const made = await routine(`매출 정리 ${suite}-1`);
    const registered = await jobs.register(AUTHOR, made.id);
    if (!registered.ok) throw new Error(registered.code);
    expect(await jobs.jobOf(made.id)).toBe(registered.jobId);
    const put = hub.seen.find((request) => request.method === "PUT");
    expect(put?.body).toEqual({
      name: made.name,
      schedule: "daily 07:30 Asia/Seoul days:1,2,3,4,5",
    });
    expect(JSON.stringify(put)).not.toContain("매출을 정리해서");
    // Somebody else's routine is not theirs to register.
    const stranger = { id: `stranger-${suite}`, role: "user" as const };
    await expect(jobs.register(stranger, made.id)).rejects.toThrow();
  });

  test("moved to another member: the old copy is off, the definition goes to the new runner only, and the new VM makes it", async () => {
    const hub = register();
    const httpA = hub.as("m_a");
    const outboxA = directOutbox(httpA);
    const old = createHubJobs({
      database,
      http: httpA,
      outbox: outboxA,
      memberId: () => "m_a",
      mine: (actor, id) => mine(database, actor, id),
      install: async () => {
        throw new Error("not this VM's to install");
      },
    });
    const made = await routine(`매출 정리 ${suite}-2`);
    const registered = await old.register(AUTHOR, made.id);
    if (!registered.ok) throw new Error(registered.code);
    const jobId = registered.jobId;

    // The new runner hears first, before the old VM has handed anything on: it waits.
    const installed: JobDefinition[] = [];
    const httpB = hub.as("m_b");
    const outboxB = directOutbox(httpB);
    const fresh = createHubJobs({
      database,
      http: httpB,
      outbox: outboxB,
      memberId: () => "m_b",
      mine: (actor, id) => mine(database, actor, id),
      install: async (definition) => {
        installed.push(definition);
        const copy = await routines.create(AUTHOR, {
          agentId: BOT,
          name: `${definition.name} (B)`,
          instruction: definition.instruction,
          schedule: { kind: "interval", minutes: 60 },
        });
        if (!copy) throw new Error("not made");
        // This test's two VMs share one database; B's link is under its own routine.
        return copy.id;
      },
    });
    const job = hub.jobs.get(jobId);
    if (!job) throw new Error("not registered");
    hub.jobs.set(jobId, { ...job, owner: "m_b", runner: "m_b" });
    fresh.heard({ type: "job.moved", refId: jobId });
    await fresh.idle();
    expect(installed).toEqual([]);

    // The old VM hears it: its copy off, the definition handed to m_b, the job let go.
    old.heard({ type: "job.moved", refId: jobId });
    await old.idle();
    const [after] = await database
      .select({ enabled: lafRoutines.enabled })
      .from(lafRoutines)
      .where(eq(lafRoutines.id, made.id));
    expect(after?.enabled).toBe(false);
    expect(await old.jobOf(made.id)).toBeNull();
    const handed = outboxA.sent.find((write) => write.method === "PUT");
    expect(handed?.body).toEqual({
      to: "m_b",
      definition: {
        name: made.name,
        instruction: "매일 아침 어제 매출을 정리해서 알려줘",
        summary: "어제 매출 정리",
        schedule: {
          kind: "daily",
          time: "07:30",
          timeZone: "Asia/Seoul",
          days: [1, 2, 3, 4, 5],
        },
        delivery: "chat",
      },
    });
    // Another member asking for it is told there is none.
    const peek = await hub
      .as("m_c")
      .request({ path: `/jobs/${jobId}/handoff` });
    expect(peek.ok).toBe(false);

    // The hub's next word on the job: B collects it, makes the routine, and clears the handoff.
    fresh.heard({ type: "job.changed", refId: jobId });
    await fresh.idle();
    expect(installed.map((definition) => definition.instruction)).toEqual([
      "매일 아침 어제 매출을 정리해서 알려줘",
    ]);
    const [link] = await database
      .select()
      .from(hubJobRoutines)
      .where(eq(hubJobRoutines.jobId, jobId));
    expect(link?.routineId).not.toBe(made.id);
    expect(await fresh.jobOf(link?.routineId ?? "")).toBe(jobId);
    expect(outboxB.sent.map((write) => write.method)).toEqual(["DELETE"]);
    expect(hub.handoffs.has(jobId)).toBe(false);
  });

  test("taken off the register: the link goes and the routine stays a plain routine, heard live or found at the next scan", async () => {
    const hub = register();
    const http = hub.as("m_a");
    const jobs = createHubJobs({
      database,
      http,
      outbox: directOutbox(http),
      memberId: () => "m_a",
      mine: (actor, id) => mine(database, actor, id),
      install: async () => {
        throw new Error("not this VM's to install");
      },
    });
    const heard = await routine(`매출 정리 ${suite}-3`);
    const away = await routine(`매출 정리 ${suite}-4`);
    const first = await jobs.register(AUTHOR, heard.id);
    const second = await jobs.register(AUTHOR, away.id);
    if (!first.ok || !second.ok) throw new Error("not registered");

    // Deleted on the hub while the line is up: `job.changed`, read as 404.
    hub.jobs.delete(first.jobId);
    jobs.heard({ type: "job.changed", refId: first.jobId });
    await jobs.idle();
    expect(await jobs.jobOf(heard.id)).toBeNull();
    // The other is untouched: still listed, still linked.
    expect(await jobs.jobOf(away.id)).toBe(second.jobId);

    // Deleted while this VM was away: the next time the line comes up, it is let go too.
    hub.jobs.delete(second.jobId);
    await jobs.scan();
    await jobs.idle();
    expect(await jobs.jobOf(away.id)).toBeNull();

    // Both routines are still there and still on: plain routines, as before they were registered.
    const rows = await database
      .select({ id: lafRoutines.id, enabled: lafRoutines.enabled })
      .from(lafRoutines)
      .where(eq(lafRoutines.createdById, AUTHOR.id));
    expect(
      rows
        .filter((row) => row.id === heard.id || row.id === away.id)
        .map((row) => row.enabled),
    ).toEqual([true, true]);
  });

  test("the schedule line says when, in the register's words", () => {
    expect(scheduleLine({ kind: "interval", minutes: 30 })).toBe("every 30m");
    expect(
      scheduleLine({
        kind: "daily",
        time: "09:00",
        timeZone: "Asia/Seoul",
        days: null,
      }),
    ).toBe("daily 09:00 Asia/Seoul");
  });
});
