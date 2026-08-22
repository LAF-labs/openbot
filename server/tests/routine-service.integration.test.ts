import { afterEach, describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import { count, eq, inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { lafRoutineRuns, lafRoutines } from "../src/db/schema";
import {
  createRoutineService,
  MAX_ROUTINES,
  nextRunAt,
  RoutineError,
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

const ACTOR = { id: "routine-tester", role: "admin" as const };

/*
 * Only this file's rows. Every test here creates as ACTOR, so everything it made carries that
 * id — and nothing else does. The suite runs against whatever DATABASE_URL names, which on a
 * development machine is the database the app is using; a `delete(lafRoutines)` with no clause
 * erased every routine a person had made, each time the tests ran.
 */
afterEach(async () => {
  const mine = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(eq(lafRoutines.createdById, ACTOR.id));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, mine));
  await database
    .delete(lafRoutines)
    .where(eq(lafRoutines.createdById, ACTOR.id));
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
  return { agents: { "morning-bot": agent }, asked };
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
      agentId: "morning-bot",
      name: "아침 리뷰 요약",
      instruction: "스토어 리뷰 확인하고 새 것만 요약해줘",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    expect(await service.tick()).toBe(0); // Not due yet.

    clock = new Date("2026-08-20T07:31:00Z");
    expect(await service.tick()).toBe(1);

    expect(asked).toEqual(["스토어 리뷰 확인하고 새 것만 요약해줘"]);
    const runs = await service.runs(routine.id);
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

  test("two processes over one table run a due routine once", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents } = fakeAgents("only once");
    const a = serviceWith(agents, () => clock).service;
    const b = serviceWith(agents, () => clock).service;

    const routine = await a.create(ACTOR, {
      agentId: "morning-bot",
      name: "once",
      instruction: "run once",
      schedule: { kind: "interval", minutes: 10 },
    });
    if (!routine) throw new Error("not created");
    clock = new Date("2026-08-20T07:11:00Z");

    const [ranA, ranB] = await Promise.all([a.tick(), b.tick()]);
    expect(ranA + ranB).toBe(1);
    expect(await a.runs(routine.id)).toHaveLength(1);
  });

  test("a Bot that fails leaves a run record that says so", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { service } = serviceWith({}, () => clock); // Roster without the Bot.
    const routine = await service.create(ACTOR, {
      agentId: "morning-bot",
      name: "gone",
      instruction: "hello",
      schedule: { kind: "interval", minutes: 10 },
    });
    if (!routine) throw new Error("not created");
    clock = new Date("2026-08-20T07:11:00Z");

    await service.tick();
    const runs = await service.runs(routine.id);
    expect(runs[0]).toMatchObject({ ok: false });
    expect(runs[0]?.error).toContain("no longer in the roster");
  });

  test("a disabled routine does not fire, and re-enabling re-arms from now", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents } = fakeAgents("hi");
    const { service } = serviceWith(agents, () => clock);
    const routine = await service.create(ACTOR, {
      agentId: "morning-bot",
      name: "paused",
      instruction: "hello",
      schedule: { kind: "interval", minutes: 10 },
    });
    if (!routine) throw new Error("not created");

    await service.setEnabled(routine.id, false);
    clock = new Date("2026-08-20T09:00:00Z");
    expect(await service.tick()).toBe(0);

    // A routine paused for hours must not fire a backlog on re-enable.
    const rearmed = await service.setEnabled(routine.id, true);
    expect(rearmed?.nextRunAt?.toISOString()).toBe("2026-08-20T09:10:00.000Z");
  });

  test("refuses the routine past the cap, with the reason", async () => {
    const { agents } = fakeAgents("x");
    const { service } = serviceWith(agents, () => new Date());
    // The cap is the deployment's, and a development database already holds a person's routines.
    const [existing] = await database
      .select({ count: count() })
      .from(lafRoutines);
    for (
      let held = Number(existing?.count ?? 0);
      held < MAX_ROUTINES;
      held += 1
    ) {
      await service.create(ACTOR, {
        agentId: "morning-bot",
        name: `routine ${held}`,
        instruction: "x",
        schedule: { kind: "interval", minutes: 10 },
      });
    }
    await expect(
      service.create(ACTOR, {
        agentId: "morning-bot",
        name: "one too many",
        instruction: "x",
        schedule: { kind: "interval", minutes: 10 },
      }),
    ).rejects.toThrow(RoutineError);
  });

  test("run-now fires ahead of the clock and pushes the next firing out", async () => {
    let clock = new Date("2026-08-20T07:00:00Z");
    const { agents } = fakeAgents("early");
    const { service } = serviceWith(agents, () => clock);
    const routine = await service.create(ACTOR, {
      agentId: "morning-bot",
      name: "early",
      instruction: "x",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    await service.runNow(routine.id);
    expect(await service.runs(routine.id)).toHaveLength(1);

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

describe("a webhook firing a routine", () => {
  async function armed(clock: () => Date, reply = "fired") {
    const { agents, asked } = fakeAgents(reply);
    const { service } = serviceWith(agents, clock);
    const routine = await service.create(ACTOR, {
      agentId: "morning-bot",
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
    await service.setEnabled(routine.id, false);

    const outcome = await service.trigger(routine.id, routine.triggerToken);
    expect(outcome).toEqual({ ran: false, reason: "disabled" });
    expect(asked).toHaveLength(0);
  });
});
