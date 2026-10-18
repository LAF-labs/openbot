import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, hubJobRoutines, lafRoutines, users } from "../src/db/schema";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import {
  createHubJobs,
  installHandedOver,
  scheduleLine,
} from "../src/hub/jobs";
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
  const handoffs = new Map<
    string,
    { from: string; to: string; definition: JobDefinition }
  >();
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
          handoffs.set(id, {
            ...(request.body as { to: string; definition: JobDefinition }),
            from: member,
          });
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

  test("handed to another member: made on their VM switched off, marked as from the old runner, and run on schedule only once they turn it on", async () => {
    const hub = register();
    const httpA = hub.as("m_a");
    const old = createHubJobs({
      database,
      http: httpA,
      outbox: directOutbox(httpA),
      memberId: () => "m_a",
      mine: (actor, id) => mine(database, actor, id),
      install: async () => {
        throw new Error("not this VM's to install");
      },
    });
    const made = await routine(`매출 정리 ${suite}-5`);
    const registered = await old.register(AUTHOR, made.id);
    if (!registered.ok) throw new Error(registered.code);
    const jobId = registered.jobId;

    // B's VM, on a clock of its own in the past, so no other suite's routine is due on it. Every
    // run it starts asks for the Bot, which is what is counted.
    let clock = new Date("2026-10-01T00:00:00Z"); // Thursday, 09:00 in Seoul
    const asked = { count: 0 };
    const routinesB = createRoutineService({
      database,
      resolveAgents: async () => {
        asked.count += 1;
        return {};
      },
      now: () => clock,
    });
    const httpB = hub.as("m_b");
    const fresh = createHubJobs({
      database,
      http: httpB,
      outbox: directOutbox(httpB),
      memberId: () => "m_b",
      mine: (actor, id) => mine(database, actor, id),
      // The install main.ts uses, with this test's person and Bot standing in for B's.
      install: installHandedOver({
        routines: routinesB,
        owner: async () => ({ actor: AUTHOR, botId: BOT }),
      }),
    });
    const job = hub.jobs.get(jobId);
    if (!job) throw new Error("not registered");
    hub.jobs.set(jobId, { ...job, owner: "m_b", runner: "m_b" });
    old.heard({ type: "job.moved", refId: jobId });
    await old.idle();
    fresh.heard({ type: "job.moved", refId: jobId });
    await fresh.idle();

    const [link] = await database
      .select()
      .from(hubJobRoutines)
      .where(eq(hubJobRoutines.jobId, jobId));
    if (!link) throw new Error("not taken over");
    expect(link.handedBy).toBe("m_a");
    const read = async () => {
      const [row] = await database
        .select({
          enabled: lafRoutines.enabled,
          pausedReason: lafRoutines.pausedReason,
          instruction: lafRoutines.instruction,
        })
        .from(lafRoutines)
        .where(eq(lafRoutines.id, link.routineId));
      return row;
    };
    expect(await read()).toEqual({
      enabled: false,
      pausedReason: "handed_over",
      instruction: "매일 아침 어제 매출을 정리해서 알려줘",
    });
    // The person's list says who it came from.
    const listed = (await routinesB.list(AUTHOR)).find(
      (row) => row.id === link.routineId,
    );
    expect(listed).toMatchObject({
      enabled: false,
      pausedReason: "handed_over",
      handedBy: "m_a",
    });

    // Its time comes (Friday 07:30 in Seoul) and goes: nothing runs.
    clock = new Date("2026-10-01T23:00:00Z");
    expect(await routinesB.tick()).toBe(0);
    expect(asked.count).toBe(0);

    // Its person turns it on: the reason is gone, and at its next time (Monday 07:30) it runs.
    const on = await routinesB.setEnabled(AUTHOR, link.routineId, true);
    expect(on).toMatchObject({ enabled: true, pausedReason: null });
    clock = new Date("2026-10-04T23:00:00Z");
    expect(await routinesB.tick()).toBe(1);
  });

  test("a definition too big for the hub's handoff never moves: not registered, and if it grew after, kept running here", async () => {
    const hub = register();
    const http = hub.as("m_a");
    const outbox = directOutbox(http);
    const jobs = createHubJobs({
      database,
      http,
      outbox,
      memberId: () => "m_a",
      mine: (actor, id) => mine(database, actor, id),
      install: async () => {
        throw new Error("not this VM's to install");
      },
    });
    // 64 KB of instruction, in three-byte letters: under the cap in characters, over it in bytes.
    const tooLong = "가".repeat(22_000);
    const big = await routine(`매출 정리 ${suite}-6`);
    await database
      .update(lafRoutines)
      .set({ instruction: tooLong })
      .where(eq(lafRoutines.id, big.id));
    expect(await jobs.register(AUTHOR, big.id)).toEqual({
      ok: false,
      code: "laf:job_definition_too_large",
    });
    expect(hub.seen).toEqual([]);

    // Registered while small, grown since, then moved to another member.
    const grown = await routine(`매출 정리 ${suite}-7`);
    const registered = await jobs.register(AUTHOR, grown.id);
    if (!registered.ok) throw new Error(registered.code);
    await database
      .update(lafRoutines)
      .set({ instruction: tooLong })
      .where(eq(lafRoutines.id, grown.id));
    const job = hub.jobs.get(registered.jobId);
    if (!job) throw new Error("not registered");
    hub.jobs.set(registered.jobId, { ...job, owner: "m_b", runner: "m_b" });
    jobs.heard({ type: "job.moved", refId: registered.jobId });
    await jobs.idle();

    // Nothing handed on, and the routine still on here, a plain routine again.
    expect(outbox.sent).toEqual([]);
    const [row] = await database
      .select({ enabled: lafRoutines.enabled })
      .from(lafRoutines)
      .where(eq(lafRoutines.id, grown.id));
    expect(row?.enabled).toBe(true);
    expect(await jobs.jobOf(grown.id)).toBeNull();
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
