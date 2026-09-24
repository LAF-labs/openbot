import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { createAccountExport } from "../src/account/export";
import { createWhereaboutsStore } from "../src/account/whereabouts";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import { agents, lafRoutineRuns, lafRoutines, users } from "../src/db/schema";
import { createRoutineService } from "../src/routines/service";
import { TEST_POOL } from "./support/database";

/**
 * The person's clock and place against a real database: kept on their own row, coarse, and the
 * clock a routine made without a zone runs on.
 *
 * "매일 아침 7시 반" is half past seven where the person is. The Bot was told the time on the device's
 * zone when the routine was made; a routine stored on the deployment's zone instead would bring a
 * person in Dubai their morning briefing at 02:30.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = `where-${randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];

// The test database is shared between files: only what this file made is removed, by id.
afterEach(async () => {
  if (createdUserIds.length > 0) {
    const theirs = database
      .select({ id: lafRoutines.id })
      .from(lafRoutines)
      .where(inArray(lafRoutines.createdById, createdUserIds));
    await database
      .delete(lafRoutineRuns)
      .where(inArray(lafRoutineRuns.routineId, theirs));
    await database
      .delete(lafRoutines)
      .where(inArray(lafRoutines.createdById, createdUserIds));
  }
  const agentIds = createdAgentIds.splice(0);
  if (agentIds.length > 0) {
    await database.delete(agents).where(inArray(agents.id, agentIds));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function person(): Promise<AgentActor> {
  const id = `${suite}-${randomUUID().slice(0, 8)}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "사장님" });
  createdUserIds.push(id);
  return { id, role: "user" };
}

/** A Bot row for the routine to point at. No profile: the routine store's own suite does the same. */
async function aBot(): Promise<string> {
  const id = `${suite}-bot-${randomUUID().slice(0, 8)}`;
  await database.insert(agents).values({
    id,
    name: "미소",
    type: "remote_ag_ui",
    configuration: {},
  });
  createdAgentIds.push(id);
  return id;
}

describe("where the person's clock and place are kept", () => {
  test("on their own row, read back as they were written", async () => {
    const owner = await person();
    const changed: string[] = [];
    const store = createWhereaboutsStore(database, (id) => changed.push(id));

    expect(
      await store.saveDevice(owner.id, {
        timeZone: "Asia/Dubai",
        locale: "ko-KR",
      }),
    ).toBe(true);
    // The same device opening the app again writes nothing and tells the browser nothing.
    expect(
      await store.saveDevice(owner.id, {
        timeZone: "Asia/Dubai",
        locale: "ko-KR",
      }),
    ).toBe(false);
    expect(changed).toEqual([owner.id]);

    const held = await store.savePlace(owner.id, {
      place: "서울 강남구",
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    expect(held).toEqual({
      timeZone: "Asia/Dubai",
      locale: "ko-KR",
      place: "서울 강남구",
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    expect(changed).toEqual([owner.id, owner.id]);
  });

  test("cleared, the words and the coordinates go together", async () => {
    const owner = await person();
    const store = createWhereaboutsStore(database);
    await store.savePlace(owner.id, {
      place: "서울 강남구",
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    const cleared = await store.savePlace(owner.id, {
      place: null,
      coordinates: null,
    });
    expect(cleared.place).toBeNull();
    expect(cleared.coordinates).toBeNull();
    const [row] = await database
      .select({
        place: users.place,
        lat: users.placeLatitude,
        lon: users.placeLongitude,
      })
      .from(users)
      .where(eq(users.id, owner.id));
    expect(row).toEqual({ place: null, lat: null, lon: null });
  });

  test("a finer coordinate somebody wrote by hand is read back coarse", async () => {
    const owner = await person();
    await database
      .update(users)
      .set({ placeLatitude: 37.498_095, placeLongitude: 127.027_61 })
      .where(eq(users.id, owner.id));
    const store = createWhereaboutsStore(database);
    expect((await store.read(owner.id)).coordinates).toEqual({
      latitude: 37.5,
      longitude: 127.03,
    });
  });

  test("the export carries them, as they are kept, on the person's profile", async () => {
    const owner = await person();
    const store = createWhereaboutsStore(database);
    await store.saveDevice(owner.id, {
      timeZone: "Asia/Dubai",
      locale: "ko-KR",
    });
    await store.savePlace(owner.id, {
      place: "서울 강남구",
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    const text = await new Response(
      createAccountExport(database).stream(owner.id),
    ).text();
    const document = JSON.parse(text) as { profile: Record<string, unknown> };
    expect(document.profile.whereabouts).toEqual({
      timeZone: "Asia/Dubai",
      locale: "ko-KR",
      place: "서울 강남구",
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
  });

  test("nobody by that id is nothing known, not a failure", async () => {
    const store = createWhereaboutsStore(database);
    expect(await store.read(`${suite}-nobody`)).toEqual({
      timeZone: null,
      locale: null,
      place: null,
      coordinates: null,
    });
  });
});

describe("a routine made without a zone", () => {
  function serviceFor(clock: () => Date, reply = "주문 두 건이 들어왔어요.") {
    const asked: string[] = [];
    const store = createWhereaboutsStore(database);
    const agent = {
      setMessages(messages: { content?: string }[]) {
        asked.push(messages[0]?.content ?? "");
      },
      async runAgent() {
        return {
          result: undefined,
          newMessages: [{ id: "m", role: "assistant", content: reply }],
        };
      },
    } as unknown as AbstractAgent;
    const service = createRoutineService({
      database,
      resolveAgents: async () =>
        Object.fromEntries(createdAgentIds.map((id) => [id, agent])),
      auditStore: { insert: async () => undefined },
      deliver: async () => null,
      now: clock,
      timeZone: "Asia/Seoul",
      personZone: async (userId) => (await store.read(userId)).timeZone,
    });
    return { service, store, asked };
  }

  test("is written on the zone the person's device last reported, and fires at 07:30 there", async () => {
    const owner = await person();
    const botId = await aBot();
    // 01:00 UTC is 05:00 in Dubai and 10:00 in Seoul.
    let clock = new Date("2026-09-24T01:00:00Z");
    const { service, store, asked } = serviceFor(() => clock);
    await store.saveDevice(owner.id, {
      timeZone: "Asia/Dubai",
      locale: "ko-KR",
    });

    const routine = await service.create(owner, {
      agentId: botId,
      name: "아침 주문 정리",
      instruction: "오늘 들어온 주문을 정리해서 알려줘",
      schedule: { kind: "daily", time: "07:30" },
    });
    expect(routine.dailyTimeZone).toBe("Asia/Dubai");
    // 07:30 in Dubai (UTC+4) is 03:30 UTC — not 07:30 in Seoul, which would be 22:30 UTC.
    expect(new Date(routine.nextRunAt).toISOString()).toBe(
      "2026-09-24T03:30:00.000Z",
    );

    clock = new Date("2026-09-24T03:29:00Z");
    await service.tick();
    expect(asked).toEqual([]);

    clock = new Date("2026-09-24T03:30:30Z");
    await service.tick();
    expect(asked).toEqual(["오늘 들어온 주문을 정리해서 알려줘"]);
  });

  test("is written on the deployment's zone when the device never said — Seoul, never UTC", async () => {
    const owner = await person();
    const botId = await aBot();
    const { service } = serviceFor(() => new Date("2026-09-24T01:00:00Z"));
    const routine = await service.create(owner, {
      agentId: botId,
      name: "아침 주문 정리",
      instruction: "오늘 들어온 주문을 정리해서 알려줘",
      schedule: { kind: "daily", time: "07:30" },
    });
    expect(routine.dailyTimeZone).toBe("Asia/Seoul");
  });

  test("keeps a zone the schedule names, whatever the device said", async () => {
    const owner = await person();
    const botId = await aBot();
    const { service, store } = serviceFor(
      () => new Date("2026-09-24T01:00:00Z"),
    );
    await store.saveDevice(owner.id, { timeZone: "Asia/Dubai", locale: null });
    const routine = await service.create(owner, {
      agentId: botId,
      name: "뉴욕 시장 확인",
      instruction: "뉴욕 시장이 열리면 알려줘",
      schedule: { kind: "daily", time: "09:30", timeZone: "America/New_York" },
    });
    expect(routine.dailyTimeZone).toBe("America/New_York");
  });

  test("moved to a new time without a zone follows the person's zone too", async () => {
    const owner = await person();
    const botId = await aBot();
    const { service, store } = serviceFor(
      () => new Date("2026-09-24T01:00:00Z"),
    );
    const routine = await service.create(owner, {
      agentId: botId,
      name: "아침 주문 정리",
      instruction: "오늘 들어온 주문을 정리해서 알려줘",
      schedule: { kind: "daily", time: "07:30" },
    });
    expect(routine.dailyTimeZone).toBe("Asia/Seoul");
    await store.saveDevice(owner.id, { timeZone: "Asia/Dubai", locale: null });
    const moved = await service.update(owner, routine.id, {
      schedule: { kind: "daily", time: "08:00" },
    });
    expect(moved.dailyTimeZone).toBe("Asia/Dubai");
  });
});
