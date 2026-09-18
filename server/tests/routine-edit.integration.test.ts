import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { agents, lafRoutineRuns, lafRoutines, users } from "../src/db/schema";
import { createRoutineRoutes } from "../src/routines/routes";
import {
  createRoutineService,
  type RoutineServiceOptions,
} from "../src/routines/service";
import { TEST_POOL } from "./support/database";

/**
 * EDITING A ROUTINE IN PLACE, against the table.
 *
 * Until this there was no way to change one: the screen offered Delete, and a Bot asked to move
 * "매일 7시 반" to eight deleted the routine and made it again — its run history, its notepad and
 * its webhook token went with the old row. These are the rules an edit keeps: the same validation
 * and the same refusal codes a new routine meets, the deployment's zone for a daily time that names
 * none, a clock that moves only when the schedule does, and nobody's routine but the person's own.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const run = randomUUID().slice(0, 8);
const ACTOR = { id: `routine-editor-${run}`, role: "user" as const };
const STRANGER = { id: `routine-edit-stranger-${run}`, role: "user" as const };
const BOT_ID = `routine-edit-bot-${run}`;

/** 05:00 UTC on a Thursday: 14:00 in Seoul, 01:00 in New York. */
const AT = new Date("2026-08-20T05:00:00Z");
/** An hour later, when the edits below are made. */
const LATER = new Date("2026-08-20T06:00:00Z");

beforeAll(async () => {
  await database.insert(agents).values({
    id: BOT_ID,
    name: "Edit Bot",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(users).values(
    [ACTOR, STRANGER].map((person) => ({
      id: person.id,
      email: `${person.id}@laf.test`,
      name: person.id,
    })),
  );
});

afterEach(async () => {
  // Only what this file made: every routine here is on this run's Bot.
  const mine = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(eq(lafRoutines.agentId, BOT_ID));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, mine));
  await database.delete(lafRoutines).where(eq(lafRoutines.agentId, BOT_ID));
});

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, BOT_ID));
  await database
    .delete(users)
    .where(inArray(users.id, [ACTOR.id, STRANGER.id]));
});

function serviceAt(
  clock: { now: Date },
  deployment: Pick<RoutineServiceOptions, "timeZone"> = {},
) {
  return createRoutineService({
    ...deployment,
    database,
    resolveAgents: async () => ({}),
    now: () => clock.now,
  });
}

const MORNING = {
  agentId: BOT_ID,
  name: "아침 브리핑",
  instruction: "오늘 할 일 알려줘",
};

async function stored(id: string) {
  const [row] = await database
    .select()
    .from(lafRoutines)
    .where(eq(lafRoutines.id, id));
  return row;
}

describe("editing what a routine says", () => {
  test("a new name and instruction are kept, and the clock does not move", async () => {
    const clock = { now: AT };
    const service = serviceAt(clock, { timeZone: "Asia/Seoul" });
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "interval", minutes: 60 },
    });

    clock.now = LATER;
    const edited = await service.update(ACTOR, made.id, {
      name: "  아침 요약  ",
      instruction: " 새 리뷰만 요약해줘 ",
    });

    expect(edited).toMatchObject({
      id: made.id,
      name: "아침 요약",
      instruction: "새 리뷰만 요약해줘",
      scheduleKind: "interval",
      intervalMinutes: 60,
    });
    // An hourly routine renamed at 06:00 still fires at 06:00 — an edit of its words is not a
    // reason to push its next run an hour out.
    expect(edited.nextRunAt.toISOString()).toBe(made.nextRunAt.toISOString());
    expect(edited.updatedAt.toISOString()).toBe(LATER.toISOString());
    // Who made it is who it runs as. An edit does not change that.
    expect((await stored(made.id))?.createdById).toBe(ACTOR.id);
  });

  test("a blank name or instruction is refused with the codes a new routine gets", async () => {
    const clock = { now: AT };
    const service = serviceAt(clock);
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "interval", minutes: 60 },
    });

    await expect(
      service.update(ACTOR, made.id, { name: "   " }),
    ).rejects.toMatchObject({ status: 400, code: "laf:routine_needs_name" });
    await expect(
      service.update(ACTOR, made.id, { instruction: "" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "laf:routine_needs_instruction",
    });
    // And nothing was written on the way to either refusal.
    expect((await stored(made.id))?.name).toBe(MORNING.name);
  });

  test("a change of nothing is refused rather than answered as a save", async () => {
    const clock = { now: AT };
    const service = serviceAt(clock);
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "interval", minutes: 60 },
    });

    await expect(service.update(ACTOR, made.id, {})).rejects.toMatchObject({
      status: 400,
      code: "laf:routine_nothing_to_change",
    });
  });
});

describe("editing when a routine runs", () => {
  test("a new daily time re-arms the clock from the moment of the edit", async () => {
    const clock = { now: AT };
    const service = serviceAt(clock, { timeZone: "Asia/Seoul" });
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "daily", time: "07:30" },
    });
    // 14:00 in Seoul: the next 07:30 there is tomorrow's.
    expect(made.nextRunAt.toISOString()).toBe("2026-08-20T22:30:00.000Z");

    clock.now = LATER;
    const edited = await service.update(ACTOR, made.id, {
      schedule: { kind: "daily", time: "08:00" },
    });

    // What a Bot sends for "8시로 바꿔 줘" names no zone: the deployment's is the clock it heard.
    expect(edited).toMatchObject({
      scheduleKind: "daily",
      dailyLocal: "08:00",
      dailyTimeZone: "Asia/Seoul",
      dailyDays: [],
    });
    expect(edited.nextRunAt.toISOString()).toBe("2026-08-20T23:00:00.000Z");
  });

  test("the zone default is the deployment's, not the one the routine had", async () => {
    // Made on the form in New York; edited by a Bot that reads the time on the deployment's clock.
    const clock = { now: AT };
    const service = serviceAt(clock, { timeZone: "Asia/Seoul" });
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "daily", time: "07:30", timeZone: "America/New_York" },
    });

    const edited = await service.update(ACTOR, made.id, {
      schedule: { kind: "daily", time: "08:00" },
    });
    expect(edited.dailyTimeZone).toBe("Asia/Seoul");

    // A schedule that names its zone keeps it, which is what the form sends.
    const kept = await service.update(ACTOR, made.id, {
      schedule: { kind: "daily", time: "08:00", timeZone: "America/New_York" },
    });
    expect(kept.dailyTimeZone).toBe("America/New_York");
  });

  test("weekdays are a list, and an empty one is refused as it is on create", async () => {
    const clock = { now: AT };
    const service = serviceAt(clock, { timeZone: "Asia/Seoul" });
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "daily", time: "07:30" },
    });

    const weekdays = await service.update(ACTOR, made.id, {
      schedule: { kind: "daily", time: "09:00", days: [5, 1, 3, 1] },
    });
    // Sorted and de-duplicated, and an array — `.returning()` hands `integer[]` back as an object
    // unless the row is normalised on the way out, which is what the create response once did.
    expect(weekdays.dailyDays).toEqual([1, 3, 5]);
    // Thursday 15:00 in Seoul: Friday 09:00 is next.
    clock.now = LATER;
    const again = await service.update(ACTOR, made.id, {
      schedule: { kind: "daily", time: "09:00", days: [1, 3, 5] },
    });
    expect(again.nextRunAt.toISOString()).toBe("2026-08-21T00:00:00.000Z");

    await expect(
      service.update(ACTOR, made.id, {
        schedule: { kind: "daily", time: "09:00", days: [] },
      }),
    ).rejects.toMatchObject({ status: 400, code: "laf:routine_days_empty" });
    await expect(
      service.update(ACTOR, made.id, {
        schedule: { kind: "daily", time: "9:00" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "laf:routine_time_invalid" });
    await expect(
      service.update(ACTOR, made.id, {
        schedule: { kind: "interval", minutes: 2 },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "laf:routine_interval_too_short",
    });
  });

  test("daily to interval clears the daily columns, and back again", async () => {
    const clock = { now: AT };
    const service = serviceAt(clock, { timeZone: "Asia/Seoul" });
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "daily", time: "07:30", days: [1] },
    });

    const interval = await service.update(ACTOR, made.id, {
      schedule: { kind: "interval", minutes: 30 },
    });
    expect(interval).toMatchObject({
      scheduleKind: "interval",
      intervalMinutes: 30,
      dailyLocal: null,
      dailyTimeZone: null,
      dailyDays: null,
    });
    expect(interval.nextRunAt.toISOString()).toBe("2026-08-20T05:30:00.000Z");

    const daily = await service.update(ACTOR, made.id, {
      schedule: { kind: "daily", time: "07:30" },
    });
    expect(daily).toMatchObject({
      scheduleKind: "daily",
      intervalMinutes: null,
      dailyLocal: "07:30",
    });
  });

  test("the schedule it already has, sent again, does not move the clock", async () => {
    /*
     * A form that sends every field, or a Bot that repeats the schedule beside a new name, must not
     * shift an hourly routine's next run to an hour from the edit. Only a schedule that differs is
     * a reason to re-arm.
     */
    const clock = { now: AT };
    const service = serviceAt(clock, { timeZone: "Asia/Seoul" });
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "interval", minutes: 60 },
    });

    clock.now = new Date("2026-08-20T05:40:00Z");
    const edited = await service.update(ACTOR, made.id, {
      name: "매시 점검",
      schedule: { kind: "interval", minutes: 60 },
    });
    expect(edited.nextRunAt.toISOString()).toBe("2026-08-20T06:00:00.000Z");
  });
});

describe("whose routine an edit reaches", () => {
  test("somebody else's routine does not exist", async () => {
    const clock = { now: AT };
    const service = serviceAt(clock);
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "interval", minutes: 60 },
    });

    await expect(
      service.update(STRANGER, made.id, { name: "내 것" }),
    ).rejects.toMatchObject({ status: 404, code: "laf:routine_not_found" });
    expect((await stored(made.id))?.name).toBe(MORNING.name);
  });

  test("through the routes: the three fields change and nothing else does", async () => {
    const clock = { now: AT };
    const service = serviceAt(clock, { timeZone: "Asia/Seoul" });
    const made = await service.create(ACTOR, {
      ...MORNING,
      schedule: { kind: "daily", time: "07:30" },
    });
    const person: AuthenticatedActor = {
      id: ACTOR.id,
      email: `${ACTOR.id}@laf.test`,
      role: ACTOR.role,
    };
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", person);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/routines", createRoutineRoutes(service, requireUser));

    const response = await app.request(
      `http://laf.test/api/routines/${made.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schedule: { kind: "daily", time: "08:00" },
          enabled: false,
          agentId: "another-bot",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    // The token was shown once, at creation; its hash is shown never.
    expect(body).not.toContain("triggerToken");
    const { routine } = JSON.parse(body) as {
      routine: Record<string, unknown>;
    };
    expect(routine).toMatchObject({
      id: made.id,
      dailyLocal: "08:00",
      dailyTimeZone: "Asia/Seoul",
      enabled: true,
      agentId: BOT_ID,
    });
  });
});
