/**
 * 오늘, AGAINST THE REAL TABLES: whose rows, which day, and what each row points at.
 *
 * Two people and three Bots, a browsing turn of three runs with a picture on its middle step, a
 * routine that answered and one that said `[SILENT]`, memories learned today, yesterday and
 * forgotten — and the 23:59/00:01 pair in Seoul on a clock that keeps UTC.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type BotDay,
  createDayReader,
  createDayRoutes,
} from "../src/agents/day";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentMemories,
  agents,
  channels,
  channelThreads,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
const A = {
  user: `day-a-${tag}`,
  bot: `day-bot-a-${tag}`,
  other: `day-bot-a2-${tag}`,
  channel: `day-channel-a-${tag}`,
  thread: randomUUID(),
  routine: `day-routine-a-${tag}`,
};
const B = {
  user: `day-b-${tag}`,
  bot: `day-bot-b-${tag}`,
  channel: `day-channel-b-${tag}`,
  thread: randomUUID(),
};

// Noon in Seoul on 2026-09-25; the VM's clock is UTC.
const NOW = new Date("2026-09-25T03:00:00Z");
const at = (iso: string) => new Date(iso);
const run = (name: string) => `day-run-${name}-${tag}`;

const runIds = [
  "late",
  "early",
  "chat",
  "step1",
  "step2",
  "said",
  "silent",
  "b",
  "a2",
].map(run);

beforeAll(async () => {
  await database.insert(users).values(
    [A.user, B.user].map((id) => ({
      id,
      email: `${id}@laf.test`,
      name: id,
      emailVerified: true,
    })),
  );
  await database.insert(agents).values(
    [A.bot, A.other, B.bot].map((id) => ({
      id,
      name: id,
      type: "remote_ag_ui" as const,
      configuration: {},
    })),
  );
  await database
    .insert(channels)
    .values(
      [A.channel, B.channel].map((id) => ({ id, name: id, description: "" })),
    );
  await database.insert(channelThreads).values([
    { userId: A.user, channelId: A.channel, threadId: A.thread },
    { userId: B.user, channelId: B.channel, threadId: B.thread },
  ]);
  await database.insert(lafRoutines).values({
    id: A.routine,
    agentId: A.bot,
    name: "아침 주문 확인",
    instruction: "주문 확인",
    scheduleKind: "daily",
    dailyLocal: "07:30",
    dailyTimeZone: "Asia/Seoul",
    createdById: A.user,
    createdByRole: "user",
    nextRunAt: NOW,
  });

  const ledger = (
    name: string,
    over: Partial<typeof lafThreadRuns.$inferInsert> & { startedAt: Date },
  ) => ({
    runId: run(name),
    threadId: A.thread,
    agentId: A.bot,
    userId: A.user,
    origin: "chat" as const,
    status: "done" as const,
    label: null,
    ...over,
  });
  await database.insert(lafThreadRuns).values([
    // 23:59 in Seoul yesterday, and 00:01 today.
    ledger("late", { label: "어제 밤", startedAt: at("2026-09-24T14:59:00Z") }),
    ledger("early", {
      label: "오늘 새벽",
      startedAt: at("2026-09-24T15:01:00Z"),
    }),
    // A browsing turn: the person's run, then two steps a browser carried on.
    ledger("chat", {
      label: "예스24에서 책 찾아 줘",
      startedAt: at("2026-09-25T01:00:00Z"),
    }),
    ledger("step1", { startedAt: at("2026-09-25T01:00:10Z") }),
    ledger("step2", {
      startedAt: at("2026-09-25T01:00:20Z"),
      status: "stopped",
    }),
    // A routine that answered, and one that found nothing.
    ledger("said", {
      origin: "routine",
      label: "아침 주문 확인",
      startedAt: at("2026-09-24T22:30:00Z"),
    }),
    ledger("silent", {
      origin: "routine",
      label: "아침 주문 확인",
      startedAt: at("2026-09-25T02:30:00Z"),
    }),
    // Somebody else's run, and this person's other Bot.
    ledger("b", {
      userId: B.user,
      agentId: B.bot,
      threadId: B.thread,
      label: "남의 일",
      startedAt: at("2026-09-25T01:30:00Z"),
    }),
    ledger("a2", {
      agentId: A.other,
      label: "다른 봇",
      startedAt: at("2026-09-25T01:40:00Z"),
    }),
  ]);
  await database.insert(lafRoutineRuns).values([
    {
      id: run("said"),
      routineId: A.routine,
      startedAt: at("2026-09-24T22:30:00Z"),
      ok: true,
      answer: "새 주문 2건",
    },
    {
      id: run("silent"),
      routineId: A.routine,
      startedAt: at("2026-09-25T02:30:00Z"),
      ok: true,
      answer: "[SILENT]",
    },
  ]);

  const message = (
    seq: number,
    runId: string | null,
    body: Record<string, unknown>,
    frame: string | null = null,
  ) => ({ threadId: A.thread, seq, runId, message: body, frame });
  await database.insert(lafThreadMessages).values([
    message(1, run("said"), {
      id: "m-said",
      role: "assistant",
      content: "새 주문 2건",
    }),
    message(2, run("chat"), {
      id: "m-user",
      role: "user",
      content: "예스24에서 책 찾아 줘",
    }),
    // Tool calls only: the transcript draws it as the browsing card, named after the first call.
    message(3, run("chat"), {
      id: "m-call",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "computer_navigate", arguments: "{}" },
        },
      ],
    }),
    message(
      4,
      run("step1"),
      { id: "m-result", role: "tool", toolCallId: "call-1", content: "{}" },
      "aGVsbG8=",
    ),
    message(5, run("step2"), {
      id: "m-answer",
      role: "assistant",
      content: "찾았어요",
    }),
  ]);
  await database.insert(agentMemories).values([
    {
      id: `day-mem-today-${tag}`,
      agentId: A.bot,
      ownerUserId: A.user,
      content:
        "사장님 가게는 매주 월요일에 쉰다. 배달은 오후 네 시까지만 받는다.",
      createdAt: at("2026-09-25T02:00:00Z"),
    },
    {
      id: `day-mem-yesterday-${tag}`,
      agentId: A.bot,
      ownerUserId: A.user,
      content: "어제 배운 것",
      createdAt: at("2026-09-24T12:00:00Z"),
    },
    {
      id: `day-mem-forgot-${tag}`,
      agentId: A.bot,
      ownerUserId: A.user,
      content: "잊은 것",
      forgottenAt: NOW,
      createdAt: at("2026-09-25T02:10:00Z"),
    },
  ]);
});

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, [A.thread, B.thread]));
  await database
    .delete(lafThreadRuns)
    .where(inArray(lafThreadRuns.runId, runIds));
  // Routines, receipts, memories and threads go with the Bots, the channels and the people.
  await database
    .delete(agents)
    .where(inArray(agents.id, [A.bot, A.other, B.bot]));
  await database
    .delete(channels)
    .where(inArray(channels.id, [A.channel, B.channel]));
  await database.delete(users).where(inArray(users.id, [A.user, B.user]));
  await database.$client.end();
});

const read = createDayReader({
  database,
  zoneOf: async (userId) => (userId === A.user ? "Asia/Seoul" : null),
  fallbackZone: "UTC",
  now: () => NOW,
});

describe("the Bot's day", () => {
  test("this person's Bot, today in Seoul, newest first", async () => {
    const day = await read({ userId: A.user, agentId: A.bot });
    expect(day.day).toBe("2026-09-25");
    expect(day.zone).toBe("Asia/Seoul");
    expect(day.more).toBe(false);
    expect(
      day.items.map((item) =>
        item.kind === "learned"
          ? `learned:${item.head}`
          : item.kind === "chat"
            ? `chat:${item.label}`
            : `routine:${item.name}:${item.silent ? "silent" : "said"}`,
      ),
    ).toEqual([
      "routine:아침 주문 확인:silent",
      "learned:사장님 가게는 매주 월요일에 쉰다. 배달은 오후 네 시",
      "chat:예스24에서 책 찾아 줘",
      "routine:아침 주문 확인:said",
      "chat:오늘 새벽",
    ]);
  });

  test("never another person's run, nor this person's other Bot's", async () => {
    const day = await read({ userId: A.user, agentId: A.bot });
    const serialised = JSON.stringify(day);
    expect(serialised).not.toContain("남의 일");
    expect(serialised).not.toContain("다른 봇");
    expect(serialised).not.toContain("어제 밤");
    expect(serialised).not.toContain("잊은 것");
    expect(serialised).not.toContain("어제 배운 것");

    // And A's Bot read as B finds nothing of A's.
    const asB = await read({ userId: B.user, agentId: A.bot });
    expect(asB.items).toEqual([]);
  });

  test("a browsing turn is one row: its first run's words, its last run's ending, its picture", async () => {
    const day = await read({ userId: A.user, agentId: A.bot });
    const chat = day.items.find(
      (item) => item.kind === "chat" && item.runId === run("chat"),
    );
    expect(chat).toEqual({
      kind: "chat",
      runId: run("chat"),
      at: "2026-09-25T01:00:00.000Z",
      status: "stopped",
      label: "예스24에서 책 찾아 줘",
      channelId: A.channel,
      messageId: "call-1",
      frameToolCallId: "call-1",
    });
    expect(
      day.items
        .filter((item) => item.kind === "chat")
        .map((item) => item.runId),
    ).not.toContain(run("step1"));
  });

  test("a silent routine is silent, has no message, and still names its routine", async () => {
    const day = await read({ userId: A.user, agentId: A.bot });
    const routines = day.items.filter((item) => item.kind === "routine");
    expect(routines).toEqual([
      {
        kind: "routine",
        runId: run("silent"),
        routineId: A.routine,
        at: "2026-09-25T02:30:00.000Z",
        status: "done",
        name: "아침 주문 확인",
        silent: true,
        channelId: A.channel,
        messageId: null,
      },
      {
        kind: "routine",
        runId: run("said"),
        routineId: A.routine,
        at: "2026-09-24T22:30:00.000Z",
        status: "done",
        name: "아침 주문 확인",
        silent: false,
        channelId: A.channel,
        messageId: "m-said",
      },
    ]);
  });

  test("the same instants are a different day in a zone that is still on yesterday", async () => {
    const utc = createDayReader({
      database,
      zoneOf: async () => null,
      fallbackZone: "UTC",
      now: () => NOW,
    });
    const day = await utc({ userId: A.user, agentId: A.bot });
    expect(day.zone).toBe("UTC");
    expect(day.day).toBe("2026-09-25");
    // 00:01 Seoul is 15:01 UTC the day before: not today in UTC.
    expect(JSON.stringify(day)).not.toContain("오늘 새벽");
  });
});

describe("GET /api/agents/:agentId/day", () => {
  const surface = (actorId: string) => {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: actorId,
        email: `${actorId}@laf.test`,
        role: "user",
      });
      await next();
    };
    const mine = new Map([
      [A.user, [A.bot, A.other]],
      [B.user, [B.bot]],
    ]);
    return new Hono<{ Variables: AppVariables }>().route(
      "/api/agents",
      createDayRoutes(
        async (actor, agentId) =>
          mine.get(actor.id)?.includes(agentId) ?? false,
        requireUser,
        read,
      ),
    );
  };

  test("answers the person's own Bot with facts", async () => {
    const response = await surface(A.user).request(`/api/agents/${A.bot}/day`);
    expect(response.status).toBe(200);
    const day = (await response.json()) as BotDay;
    expect(day.items.length).toBe(5);
  });

  test("a Bot the person cannot see is not found, the same as the profile says", async () => {
    const response = await surface(B.user).request(`/api/agents/${A.bot}/day`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "laf:agent_not_found",
      code: "laf:agent_not_found",
    });
  });
});
