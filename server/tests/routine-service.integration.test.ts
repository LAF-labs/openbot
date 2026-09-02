import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  lafRoutineRuns,
  lafRoutines,
  users,
} from "../src/db/schema";
import {
  createRoutineService,
  MAX_ROUTINES,
  nextRunAt,
} from "../src/routines/service";
import { TEST_POOL } from "./support/database";

/**
 * What the scheduler promises: the arithmetic is right without a database, the claim is decided by
 * the database, and a fired routine leaves both a run record and an audit row.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/*
 * A plain user, not an administrator.
 *
 * Every method scopes by the actor now, and an administrator is the one actor the scope lets
 * through unfiltered — so a suite that ran as one would exercise the ownership rule nowhere.
 */
const ACTOR = { id: "routine-tester", role: "user" as const };
const STRANGER = { id: "routine-stranger", role: "user" as const };
const ADMIN = { id: "routine-admin", role: "admin" as const };

/*
 * Only this file's rows. Every test here creates as one of the three actors above, so everything it
 * made carries one of those ids — and nothing else does. The suite runs against whatever
 * DATABASE_URL names, which on a development machine is the database the app is using; a
 * `delete(lafRoutines)` with no clause erased every routine a person had made, each time the tests
 * ran.
 */
const TEST_ACTOR_IDS = [ACTOR.id, STRANGER.id, ADMIN.id];

/** The Bot every routine below drives. `laf_routines.agent_id` is a real reference since 0026. */
const BOT_ID = "morning-bot";

/*
 * The rows the references need, created rather than assumed.
 *
 * `laf_routines.agent_id` and `created_by_id` point at `agents` and `users` now, so a routine made
 * under an id nothing carries fails on the reference instead of exercising the scheduler. Only what
 * this file creates is removed; on a machine where the app already seeded them, nothing is touched.
 */
const seeded = { agents: [] as string[], users: [] as string[] };

beforeAll(async () => {
  const madeBot = await database
    .insert(agents)
    .values({
      id: BOT_ID,
      name: "Morning Bot",
      type: "remote_ag_ui",
      configuration: {},
    })
    .onConflictDoNothing()
    .returning({ id: agents.id });
  if (madeBot.length > 0) seeded.agents.push(BOT_ID);
  for (const id of TEST_ACTOR_IDS) {
    const madeUser = await database
      .insert(users)
      .values({ id, email: `${id}@laf.test`, name: id })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (madeUser.length > 0) seeded.users.push(id);
  }
});

afterAll(async () => {
  if (seeded.agents.length > 0) {
    await database.delete(agents).where(inArray(agents.id, seeded.agents));
  }
  if (seeded.users.length > 0) {
    await database.delete(users).where(inArray(users.id, seeded.users));
  }
});

afterEach(async () => {
  const mine = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(inArray(lafRoutines.createdById, TEST_ACTOR_IDS));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, mine));
  await database
    .delete(lafRoutines)
    .where(inArray(lafRoutines.createdById, TEST_ACTOR_IDS));
});

function fakeAgents(reply: string, delayMs = 0) {
  const asked: string[] = [];
  const agent = {
    setMessages(messages: { content?: string }[]) {
      asked.push(messages[0]?.content ?? "");
    },
    async runAgent() {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        result: undefined,
        newMessages: [{ id: "m", role: "assistant", content: reply }],
      };
    },
  } as unknown as AbstractAgent;
  return { agents: { [BOT_ID]: agent }, asked };
}

function serviceWith(agents: Record<string, AbstractAgent>, clock: () => Date) {
  const rows: AuditEventInput[] = [];
  const service = createRoutineService({
    database,
    resolveAgents: async () => agents,
    auditStore: {
      insert: async (event) => {
        rows.push(event);
      },
    },
    now: clock,
  });
  return { service, rows };
}

describe("the schedule arithmetic", () => {
  test("an interval fires that many minutes later", () => {
    const from = new Date("2026-08-20T10:00:00Z");
    expect(
      nextRunAt({ kind: "interval", minutes: 30 }, from).toISOString(),
    ).toBe("2026-08-20T10:30:00.000Z");
  });

  test("a daily time later today fires today", () => {
    const from = new Date("2026-08-20T05:00:00Z");
    expect(
      nextRunAt({ kind: "daily", time: "07:30" }, from).toISOString(),
    ).toBe("2026-08-20T07:30:00.000Z");
  });

  test("a daily time already past fires tomorrow", () => {
    const from = new Date("2026-08-20T23:50:00Z");
    expect(
      nextRunAt({ kind: "daily", time: "07:30" }, from).toISOString(),
    ).toBe("2026-08-21T07:30:00.000Z");
  });

  test("a time is a wall clock in its own zone, not an instant", () => {
    // 07:30 in Seoul is 22:30 UTC the day before. Nobody should have to know that to ask for a
    // morning routine, and the field used to be labelled "Time (UTC)".
    const from = new Date("2026-08-20T05:00:00Z");
    expect(
      nextRunAt(
        { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
        from,
      ).toISOString(),
    ).toBe("2026-08-20T22:30:00.000Z");
  });

  test("weekdays skip the weekend rather than firing through it", () => {
    // 2026-08-22 is a Saturday in Seoul; the next weekday slot is Monday the 24th.
    const saturday = new Date("2026-08-22T01:00:00Z");
    expect(
      nextRunAt(
        {
          kind: "daily",
          time: "09:00",
          timeZone: "Asia/Seoul",
          days: [1, 2, 3, 4, 5],
        },
        saturday,
      ).toISOString(),
    ).toBe("2026-08-24T00:00:00.000Z");
  });

  test("a weekly routine reaches its one day from the day after it", () => {
    // Restricted to Monday, asked on a Monday evening: the answer is next Monday, and finding it
    // needs the eighth step — which is why the search window is eight days and not seven.
    const mondayEvening = new Date("2026-08-24T12:00:00Z");
    expect(
      nextRunAt(
        { kind: "daily", time: "09:00", timeZone: "Asia/Seoul", days: [1] },
        mondayEvening,
      ).toISOString(),
    ).toBe("2026-08-31T00:00:00.000Z");
  });

  test("a wall clock holds across a daylight-saving change", () => {
    /*
     * New York moves to standard time on 2026-11-01. A routine set for 09:00 has to stay 09:00 on
     * both sides of it — an offset stored instead of a zone would drift to 08:00 and the person who
     * wrote "every morning at nine" would be woken an hour early for four months.
     */
    const beforeShift = new Date("2026-10-30T20:00:00Z");
    expect(
      nextRunAt(
        { kind: "daily", time: "09:00", timeZone: "America/New_York" },
        beforeShift,
      ).toISOString(),
    ).toBe("2026-10-31T13:00:00.000Z");

    const afterShift = new Date("2026-11-01T20:00:00Z");
    expect(
      nextRunAt(
        { kind: "daily", time: "09:00", timeZone: "America/New_York" },
        afterShift,
      ).toISOString(),
    ).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("a routine on the clock", () => {
  test("fires when due, records the answer, and re-arms", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents, asked } = fakeAgents("Two reviews came in overnight.");
    const { service, rows } = serviceWith(agents, () => clock);

    const routine = await service.create(ACTOR, {
      agentId: BOT_ID,
      name: "아침 리뷰 요약",
      instruction: "스토어 리뷰 확인하고 새 것만 요약해줘",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    expect(await service.tick()).toBe(0); // Not due yet.

    clock = new Date("2026-08-20T07:31:00Z");
    expect(await service.tick()).toBe(1);

    expect(asked).toEqual(["스토어 리뷰 확인하고 새 것만 요약해줘"]);
    const runs = await service.runs(ACTOR, routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      ok: true,
      answer: "Two reviews came in overnight.",
    });
    expect(rows[0]).toMatchObject({
      eventType: "routine.ran",
      payload: { ok: true },
    });

    // Re-armed: the same moment is no longer due.
    expect(await service.tick()).toBe(0);
  });

  test("the second run is told what the first one reported", async () => {
    /*
     * A routine that cannot remember repeating itself is the failure the whole feature walks into:
     * the 8am briefing reports Tuesday's three orders again on Wednesday and the person stops
     * reading. The answers were already in `laf_routine_runs` — every run writes one — and nothing
     * read them back. Borrowed from Hermes cron `continuity=true`.
     */
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents, asked } = fakeAgents("Two reviews came in overnight.");
    const { service } = serviceWith(agents, () => clock);

    const routine = await service.create(ACTOR, {
      agentId: BOT_ID,
      name: "아침 리뷰 요약",
      instruction: "스토어 리뷰 확인하고 새 것만 요약해줘",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    clock = new Date("2026-08-20T07:31:00Z");
    expect(await service.tick()).toBe(1);
    // Nothing to carry on the first run — there is no previous report to not repeat.
    expect(asked[0]).toBe("스토어 리뷰 확인하고 새 것만 요약해줘");

    clock = new Date("2026-08-20T08:02:00Z");
    expect(await service.tick()).toBe(1);

    // The instruction is still the person's, with the last report appended as context after it.
    expect(asked[1]?.startsWith("스토어 리뷰 확인하고 새 것만 요약해줘")).toBe(
      true,
    );
    expect(asked[1]).toContain("Two reviews came in overnight.");
  });

  test("a failed run is not what the next one is told it reported", async () => {
    // Only a run that SUCCEEDED and said something: carrying a failure forward would have the next
    // run answer a question about an error message.
    let clock = new Date("2026-08-20T07:00:00Z");
    const failing = {
      setMessages() {},
      async runAgent() {
        throw new Error("the model was unreachable");
      },
    } as unknown as AbstractAgent;
    const asked: string[] = [];
    const recovering = {
      setMessages(messages: { content?: string }[]) {
        asked.push(messages[0]?.content ?? "");
      },
      async runAgent() {
        return {
          result: undefined,
          newMessages: [{ id: "m", role: "assistant", content: "All quiet." }],
        };
      },
    } as unknown as AbstractAgent;

    const broken = serviceWith({ "morning-bot": failing }, () => clock);
    const routine = await broken.service.create(ACTOR, {
      agentId: BOT_ID,
      name: "점검",
      instruction: "확인해줘",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    clock = new Date("2026-08-20T07:31:00Z");
    expect(await broken.service.tick()).toBe(1);

    const healed = serviceWith({ "morning-bot": recovering }, () => clock);
    clock = new Date("2026-08-20T08:02:00Z");
    expect(await healed.service.tick()).toBe(1);

    expect(asked[0]).toBe("확인해줘");
    expect(asked[0]).not.toContain("unreachable");
  });

  test("two processes over one table run a due routine once", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents } = fakeAgents("only once");
    const a = serviceWith(agents, () => clock).service;
    const b = serviceWith(agents, () => clock).service;

    const routine = await a.create(ACTOR, {
      agentId: BOT_ID,
      name: "once",
      instruction: "run once",
      schedule: { kind: "interval", minutes: 10 },
    });
    if (!routine) throw new Error("not created");
    clock = new Date("2026-08-20T07:11:00Z");

    const [ranA, ranB] = await Promise.all([a.tick(), b.tick()]);
    expect(ranA + ranB).toBe(1);
    expect(await a.runs(ACTOR, routine.id)).toHaveLength(1);
  });

  test("a Bot that fails leaves a run record that says so", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { service } = serviceWith({}, () => clock); // Roster without the Bot.
    const routine = await service.create(ACTOR, {
      agentId: BOT_ID,
      name: "gone",
      instruction: "hello",
      schedule: { kind: "interval", minutes: 10 },
    });
    if (!routine) throw new Error("not created");
    clock = new Date("2026-08-20T07:11:00Z");

    await service.tick();
    const runs = await service.runs(ACTOR, routine.id);
    expect(runs[0]).toMatchObject({ ok: false });
    expect(runs[0]?.error).toContain("no longer in the roster");
  });

  test("a disabled routine does not fire, and re-enabling re-arms from now", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents } = fakeAgents("hi");
    const { service } = serviceWith(agents, () => clock);
    const routine = await service.create(ACTOR, {
      agentId: BOT_ID,
      name: "paused",
      instruction: "hello",
      schedule: { kind: "interval", minutes: 10 },
    });
    if (!routine) throw new Error("not created");

    await service.setEnabled(ACTOR, routine.id, false);
    clock = new Date("2026-08-20T09:00:00Z");
    expect(await service.tick()).toBe(0);

    // A routine paused for hours must not fire a backlog on re-enable.
    const rearmed = await service.setEnabled(ACTOR, routine.id, true);
    expect(rearmed?.nextRunAt?.toISOString()).toBe("2026-08-20T09:10:00.000Z");
  });

  test("refuses the routine past the cap, with the reason", async () => {
    const { agents } = fakeAgents("x");
    const { service } = serviceWith(agents, () => new Date());
    /*
     * THIS PERSON'S routines, so the count starts at nothing however many the database holds.
     *
     * The cap counted the whole table, which meant it also counted whatever a development machine
     * already had — and, on the deployment it is written for, whatever the shop owner's staff had
     * made. The first person to reach twenty stopped everybody else from making one.
     */
    for (let held = 0; held < MAX_ROUTINES; held += 1) {
      await service.create(ACTOR, {
        agentId: BOT_ID,
        name: `routine ${held}`,
        instruction: "x",
        schedule: { kind: "interval", minutes: 10 },
      });
    }
    await expect(
      service.create(ACTOR, {
        agentId: BOT_ID,
        name: "one too many",
        instruction: "x",
        schedule: { kind: "interval", minutes: 10 },
      }),
    ).rejects.toMatchObject({ code: "laf:routine_cap_reached", status: 409 });

    // And the next person is not out of room because of it.
    const theirs = await service.create(STRANGER, {
      agentId: BOT_ID,
      name: "somebody else's first",
      instruction: "x",
      schedule: { kind: "interval", minutes: 10 },
    });
    expect(theirs.id).toBeString();
  });

  test("run-now fires ahead of the clock and pushes the next firing out", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents } = fakeAgents("early");
    const { service } = serviceWith(agents, () => clock);
    const routine = await service.create(ACTOR, {
      agentId: BOT_ID,
      name: "early",
      instruction: "x",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    await service.runNow(ACTOR, routine.id);
    expect(await service.runs(ACTOR, routine.id)).toHaveLength(1);

    // The early run re-armed the clock: nothing is due before the full interval has passed again.
    clock = new Date("2026-08-20T07:20:00Z");
    expect(await service.tick()).toBe(0);
    const [row] = await database
      .select()
      .from(lafRoutines)
      .where(eq(lafRoutines.id, routine.id));
    expect(row?.nextRunAt?.toISOString()).toBe("2026-08-20T07:30:00.000Z");
  });
});

/**
 * The window a routine missed while nothing was running.
 *
 * `nextRunAt` in the past fired at the first tick however long ago it passed, so a VM that came back
 * at nine o'clock ran the 07:30 open-up briefing then — a Bot answering a question about a morning
 * that is over — and an hourly monitor that missed six windows delivered six verdicts at once.
 */
describe("a window that came and went", () => {
  async function overdue(byMinutes: number) {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents, asked } = fakeAgents("caught up");
    const { service, rows } = serviceWith(agents, () => clock);
    const routine = await service.create(ACTOR, {
      agentId: BOT_ID,
      name: "매일 아침 브리핑",
      instruction: "오늘 할 일 알려줘",
      // Due at 07:30, and then however overdue the caller asked for.
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");
    clock = new Date(
      new Date("2026-08-20T07:30:00Z").getTime() + byMinutes * 60_000,
    );
    const ran = await service.tick();
    const [row] = await database
      .select()
      .from(lafRoutines)
      .where(eq(lafRoutines.id, routine.id));
    return { asked, ran, routine, row, rows, service };
  }

  test("thirty minutes late still runs, once", async () => {
    const { asked, ran, routine, rows, service } = await overdue(30);

    expect(ran).toBe(1);
    expect(asked).toEqual(["오늘 할 일 알려줘"]);
    expect(await service.runs(ACTOR, routine.id)).toHaveLength(1);
    expect(rows.map((row) => row.eventType)).toEqual(["routine.ran"]);
  });

  test("ninety minutes late is skipped, recorded, and re-armed", async () => {
    const { asked, ran, routine, row, rows, service } = await overdue(90);

    expect(ran).toBe(0);
    expect(asked).toEqual([]);
    expect(await service.runs(ACTOR, routine.id)).toHaveLength(0);

    // The row that says a scheduled thing did not happen, and how late the window already was.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "routine.skipped",
      targetId: routine.id,
      targetType: "routine",
    });
    expect(rows[0]?.payload).toMatchObject({
      lateByMinutes: 90,
      missed: "2026-08-20T07:30:00.000Z",
    });

    // Skipped to the NEXT window, not queued: one interval on from the moment the tick looked.
    expect(row?.nextRunAt?.toISOString()).toBe("2026-08-20T09:30:00.000Z");
  });

  test("a routine an hour and a half behind does not fire on the tick after it either", async () => {
    // The skip has to leave the routine armed. A skip that forgot to move the clock would find the
    // same stale window again on the next pass and write a `routine.skipped` row every tick.
    const { rows, service } = await overdue(90);
    expect(await service.tick()).toBe(0);
    expect(rows.map((row) => row.eventType)).toEqual(["routine.skipped"]);
  });
});

describe("two ticks over one service", () => {
  test("a pass does not start while the last one is still running", async () => {
    /*
     * `start` fires the tick on an interval while a run may take ROUTINE_RUN_TIMEOUT_MS, so on a
     * ten-minute run the ticker entered the pass nine more times underneath itself. Without the
     * guard the second pass here claims the second routine and drives the same Bot's browser
     * alongside the first; with it, the pass is skipped and the routine is simply still due.
     */
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents, asked } = fakeAgents("slowly", 40);
    const { service } = serviceWith(agents, () => clock);
    for (const name of ["first", "second"]) {
      await service.create(ACTOR, {
        agentId: BOT_ID,
        name,
        instruction: `run ${name}`,
        schedule: { kind: "interval", minutes: 10 },
      });
      // A second apart, so "first" is created first as far as the service can tell: both fall due at
      // the same instant, and the pass runs older routines before newer ones.
      clock = new Date(clock.getTime() + 1_000);
    }

    clock = new Date("2026-08-20T07:11:00Z");
    const running = service.tick();
    const overlapping = await service.tick();

    expect(overlapping).toBe(0);
    // The pass that was already going still does all of its own work, sequentially.
    expect(await running).toBe(2);
    expect(asked).toEqual(["run first", "run second"]);
  });
});

/**
 * Whose routine it is.
 *
 * The service took an id and scoped by nothing, so on the VM a shop owner shares with their staff
 * any signed-in account could list, run, disable and delete anybody's routines. The rule is the one
 * that decides a Bot (`canManageAgent`): the author, the owner of the Bot it drives, or an
 * administrator — and to everybody else the routine does not exist.
 */
describe("whose routine it is", () => {
  const seededAgentIds: string[] = [];
  const seededUserIds: string[] = [];

  afterEach(async () => {
    for (const agentId of seededAgentIds.splice(0)) {
      // agent_profiles cascades from agents; the user has to go after both.
      await database.delete(agents).where(eq(agents.id, agentId));
    }
    for (const userId of seededUserIds.splice(0)) {
      await database.delete(users).where(eq(users.id, userId));
    }
  });

  async function botOwnedBySomebody() {
    const userId = `routine-bot-owner-${randomUUID()}`;
    const agentId = `routine-test-agent-${randomUUID()}`;
    await database.insert(users).values({
      id: userId,
      email: `${userId}@laf.test`,
      name: "Routine Bot Owner",
    });
    seededUserIds.push(userId);
    await database.insert(agents).values({
      id: agentId,
      name: "Morning Bot",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://seed.example.test/ag-ui" },
    });
    seededAgentIds.push(agentId);
    await database.insert(agentProfiles).values({
      agentId,
      ownerUserId: userId,
      title: "Morning",
      roleDescription: "Opens the shop.",
      avatarSeed: agentId,
      visibility: "private",
    });
    return { agentId, owner: { id: userId, role: "user" as const } };
  }

  async function madeByActor() {
    const clock = new Date("2026-08-20T07:00:00Z");
    const { agents: roster } = fakeAgents("mine");
    const { service } = serviceWith(roster, () => clock);
    const routine = await service.create(ACTOR, {
      agentId: BOT_ID,
      name: "mine",
      instruction: "x",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");
    return { routine, service };
  }

  test("the author reaches their own routine", async () => {
    const { routine, service } = await madeByActor();

    expect((await service.list(ACTOR)).map((row) => row.id)).toEqual([
      routine.id,
    ]);
    expect(await service.runs(ACTOR, routine.id)).toEqual([]);
    expect((await service.setEnabled(ACTOR, routine.id, false)).enabled).toBe(
      false,
    );
    await service.remove(ACTOR, routine.id);
    expect(await service.list(ACTOR)).toEqual([]);
  });

  test("somebody else's routine does not exist", async () => {
    const { routine, service } = await madeByActor();

    // Not listed at all, which is the half a 404 on its own would not give.
    expect(await service.list(STRANGER)).toEqual([]);
    for (const attempt of [
      () => service.runs(STRANGER, routine.id),
      () => service.setEnabled(STRANGER, routine.id, false),
      () => service.runNow(STRANGER, routine.id),
      () => service.remove(STRANGER, routine.id),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: "laf:routine_not_found",
        status: 404,
      });
    }

    // And it is all still there: a refused delete must not have taken the run history with it.
    const [survivor] = await database
      .select()
      .from(lafRoutines)
      .where(eq(lafRoutines.id, routine.id));
    expect(survivor).toMatchObject({ enabled: true, id: routine.id });
  });

  test("the owner of the Bot manages the routines that drive it", async () => {
    // A routine outlives whoever typed it. Staff leave, and a shop owner locked out of the routines
    // running on their own Bot has no way in that is not an administrator.
    const { agentId, owner } = await botOwnedBySomebody();
    const clock = new Date("2026-08-20T07:00:00Z");
    const { service } = serviceWith({}, () => clock);
    const routine = await service.create(ACTOR, {
      agentId,
      name: "theirs to keep",
      instruction: "x",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    expect((await service.list(owner)).map((row) => row.id)).toEqual([
      routine.id,
    ]);
    expect((await service.setEnabled(owner, routine.id, false)).enabled).toBe(
      false,
    );
    await service.remove(owner, routine.id);
  });

  test("an administrator reaches all of them", async () => {
    const { routine, service } = await madeByActor();

    expect((await service.list(ADMIN)).map((row) => row.id)).toContain(
      routine.id,
    );
    await service.remove(ADMIN, routine.id);
  });

  test("the list never carries the trigger token hash", async () => {
    // A hash is not the token, but it is the material for guessing one offline, and it was on a
    // screen with no use for it. Asserted on the serialised body, the way it reaches a browser.
    const { routine, service } = await madeByActor();

    const [listed] = await service.list(ACTOR);
    expect(listed).toBeDefined();
    expect(JSON.stringify(listed)).not.toContain("triggerTokenHash");
    expect(Object.keys(listed as object)).not.toContain("triggerTokenHash");

    // Nor does the create response, which is the one place the token itself is handed over.
    expect(Object.keys(routine)).not.toContain("triggerTokenHash");
    expect(routine.triggerToken).toBeString();
  });
});

describe("a webhook firing a routine", () => {
  async function armed(clock: () => Date, reply = "fired") {
    const { agents, asked } = fakeAgents(reply);
    const { service } = serviceWith(agents, clock);
    const routine = await service.create(ACTOR, {
      agentId: BOT_ID,
      name: "on event",
      instruction: "summarize the event",
      schedule: { kind: "interval", minutes: 60 },
    });
    if (!routine?.triggerToken) throw new Error("no token came back");
    return { service, routine, asked };
  }

  test("the token fires it, and the payload rides into the run", async () => {
    const clock = new Date("2026-08-20T07:00:00Z");
    const { service, routine, asked } = await armed(() => clock);

    const outcome = await service.trigger(
      routine.id,
      routine.triggerToken,
      '{"review":"별점 1점"}',
    );
    expect(outcome.ran).toBe(true);
    // The trigger answers on the claim; the run is behind `finished`, which a sender never waits on.
    if (outcome.ran) await outcome.finished;
    expect(asked[0]).toContain("summarize the event");
    expect(asked[0]).toContain("별점 1점");
  });

  test("a wrong token reads exactly like a missing routine", async () => {
    const clock = new Date("2026-08-20T07:00:00Z");
    const { service, routine } = await armed(() => clock);

    await expect(
      service.trigger(routine.id, "not-the-token"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.trigger("routine_missing", routine.triggerToken),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("a burst buys one run", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { service, routine, asked } = await armed(() => clock);

    const first = await service.trigger(routine.id, routine.triggerToken);
    clock = new Date("2026-08-20T07:00:10Z");
    const second = await service.trigger(routine.id, routine.triggerToken);

    expect(second).toEqual({ ran: false, reason: "debounced" });
    if (first.ran) await first.finished;
    expect(asked).toHaveLength(1);
  });

  test("a disabled routine acknowledges and does nothing", async () => {
    const clock = new Date("2026-08-20T07:00:00Z");
    const { service, routine, asked } = await armed(() => clock);
    await service.setEnabled(ACTOR, routine.id, false);

    const outcome = await service.trigger(routine.id, routine.triggerToken);
    expect(outcome).toEqual({ ran: false, reason: "disabled" });
    expect(asked).toHaveLength(0);
  });
});
