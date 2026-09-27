/**
 * 소식, AGAINST THE REAL TABLES (muse-shape plan §3.2, phase 7).
 *
 * Made by a person's press and never twice; a run's posts land with its record and only when it
 * succeeded, its answer staying out of the conversation; the page's reads and presses are the
 * person's own; what they liked reaches the next run; a quoted post is read again for the model;
 * and posts nobody opens pause the routine the way unread answers do.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { feedQuotePart } from "../../shared/feed";
import { routineListResult } from "../../shared/prompt/tool-results.ko";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  channelMemberships,
  channels,
  lafFeedPosts,
  lafRoutineRuns,
  lafRoutines,
  users,
} from "../src/db/schema";
import { withFeedQuotes } from "../src/feed/quote";
import { createFeedRoutes } from "../src/feed/routes";
import { createFeedStore } from "../src/feed/store";
import { feedDraftOf, reactionsFor } from "../src/routines/feed";
import { createRoutineService, RoutineError } from "../src/routines/service";
import { settleRun } from "../src/routines/settlement";
import { pauseUnreadRoutines } from "../src/routines/unread";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const conversations = createChannelStore(
  database,
  profiles,
  createThreadIdentity("feed-test"),
);
const store = createFeedStore({ database });

const tag = randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-09-27T09:00:00Z");

const made = {
  owners: [] as string[],
  bots: [] as Array<{ botId: string; owner: AgentActor }>,
  channels: [] as string[],
};

async function personWithBot(): Promise<{
  owner: AgentActor;
  botId: string;
  channelId: string;
}> {
  const owner: AgentActor = {
    id: `feed-owner-${tag}-${made.owners.length}`,
    role: "user",
  };
  await database
    .insert(users)
    .values({ id: owner.id, email: `${owner.id}@laf.test`, name: owner.id });
  made.owners.push(owner.id);
  const bot = await profiles.create(owner, {
    name: "새벽",
    roleDescription: "",
  });
  made.bots.push({ botId: bot.id, owner });
  const channel = await conversations.create(owner, [bot.id]);
  made.channels.push(channel.id);
  return { owner, botId: bot.id, channelId: channel.id };
}

const service = createRoutineService({
  database,
  resolveAgents: async () => ({}),
  timeZone: "Asia/Seoul",
  now: () => NOW,
});

async function feedRoutine(owner: AgentActor, botId: string) {
  return service.create(owner, {
    agentId: botId,
    name: "소식",
    instruction:
      "소식 스킬대로 아래 주제의 새 소식을 찾아 올려 줘:\n- 업종 뉴스",
    schedule: { kind: "daily", time: "06:30", timeZone: "Asia/Seoul" },
    delivery: "feed",
  });
}

const routineRow = async (id: string) => {
  const [row] = await database
    .select()
    .from(lafRoutines)
    .where(eq(lafRoutines.id, id));
  if (!row) throw new Error("no routine");
  return row;
};

/** A draft holding posts whose sources the run saw. */
function draftWith(
  row: { id: string; agentId: string },
  userId: string,
  titles: string[],
) {
  const draft = feedDraftOf({
    routineId: row.id,
    agentId: row.agentId,
    userId,
    recent: { titles: new Set(), sources: new Set() },
  });
  titles.forEach((title, index) => {
    const url = `https://news.example.kr/${tag}/${index}`;
    draft.observe("computer_navigate", { url }, { ok: true, url });
    draft.apply({
      topic: "업종 뉴스",
      title,
      body: `${title}의 본문`,
      sources: [{ title: "기사", url }],
    });
  });
  return draft;
}

let A: Awaited<ReturnType<typeof personWithBot>>;
let B: Awaited<ReturnType<typeof personWithBot>>;

beforeAll(async () => {
  A = await personWithBot();
  B = await personWithBot();
});

afterAll(async () => {
  const botIds = made.bots.map((one) => one.botId);
  await database
    .delete(lafFeedPosts)
    .where(inArray(lafFeedPosts.agentId, botIds));
  const routines = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(inArray(lafRoutines.agentId, botIds));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, routines));
  await database
    .delete(lafRoutines)
    .where(inArray(lafRoutines.agentId, botIds));
  await database.delete(channels).where(inArray(channels.id, made.channels));
  for (const { botId, owner } of made.bots) {
    await profiles.softDelete(owner, botId).catch(() => {});
  }
  await database.delete(users).where(inArray(users.id, made.owners));
});

describe("made by a press, once", () => {
  test("delivery feed is kept; a second 소식 on the Bot is refused with laf:routine_feed_exists; a routine the Bot makes is chat", async () => {
    const routine = await feedRoutine(A.owner, A.botId);
    expect(routine.delivery).toBe("feed");
    const refused = await feedRoutine(A.owner, A.botId).catch((error) => error);
    expect(refused).toBeInstanceOf(RoutineError);
    expect((refused as RoutineError).code).toBe("laf:routine_feed_exists");
    const plain = await service.create(A.owner, {
      agentId: A.botId,
      name: "아침 브리핑",
      instruction: "브리핑",
      schedule: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
    });
    expect(plain.delivery).toBe("chat");
    // An edit reaches the words and never the delivery.
    await service.update(A.owner, routine.id, { instruction: "- 부동산 뉴스" });
    expect((await routineRow(routine.id)).delivery).toBe("feed");
    await service.remove(A.owner, plain.id);
  });

  test("the Bot's routine list shows a 소식 routine's instruction, so its topics can be changed by talking", async () => {
    const rows = await service.list(A.owner);
    const text = routineListResult("laf:routine_list", rows);
    expect(text).toContain("소식 루틴");
    expect(text).toContain("부동산 뉴스");
  });
});

describe("a run's posts land with its record", () => {
  test("a run that succeeded writes its posts and delivers nothing to the conversation", async () => {
    const [created] = await database
      .select()
      .from(lafRoutines)
      .where(
        and(eq(lafRoutines.agentId, A.botId), eq(lafRoutines.delivery, "feed")),
      );
    if (!created) throw new Error("no 소식");
    const delivered: string[] = [];
    const settled = await settleRun(
      {
        database,
        now: () => NOW,
        deliver: async (answer) => {
          delivered.push(answer.answer);
          return null;
        },
      },
      {
        row: created,
        runId: randomUUID(),
        startedAt: NOW,
        author: A.owner.id,
        ledgerRunId: null,
        ok: true,
        answer: "소식 2개를 올렸어요",
        failure: "",
        steps: null,
        silent: false,
        notepad: null,
        feed: draftWith(created, A.owner.id, ["첫째 소식", "둘째 소식"]),
      },
    );
    expect(settled.posted).toBe(2);
    expect(delivered).toEqual([]);
    const page = await store.page(A.owner.id, null);
    expect(page.posts.map((post) => post.title)).toEqual([
      "첫째 소식",
      "둘째 소식",
    ]);
    expect(page.unseen).toBe(2);
    expect(page.routines.map((one) => one.id)).toEqual([created.id]);
  });

  test("a run that failed writes none; a feed run that stopped for the person is delivered", async () => {
    const row = (
      await database
        .select()
        .from(lafRoutines)
        .where(
          and(
            eq(lafRoutines.agentId, A.botId),
            eq(lafRoutines.delivery, "feed"),
          ),
        )
    )[0];
    if (!row) throw new Error("no 소식");
    const failed = await settleRun(
      { database, now: () => NOW },
      {
        row,
        runId: randomUUID(),
        startedAt: NOW,
        author: A.owner.id,
        ledgerRunId: null,
        ok: false,
        answer: "",
        failure: "boom",
        steps: null,
        silent: false,
        notepad: null,
        feed: draftWith(row, A.owner.id, ["실패한 실행의 소식"]),
      },
    );
    expect(failed.posted).toBe(0);
    const delivered: string[] = [];
    await settleRun(
      {
        database,
        now: () => NOW,
        deliver: async (answer) => {
          delivered.push(answer.answer);
          return null;
        },
      },
      {
        row,
        runId: randomUUID(),
        startedAt: NOW,
        author: A.owner.id,
        ledgerRunId: null,
        ok: true,
        answer: "⏸ 로그인이 필요해요",
        failure: "",
        steps: null,
        silent: false,
        notepad: null,
        awaiting: true,
        feed: draftWith(row, A.owner.id, []),
      },
    );
    expect(delivered).toEqual(["⏸ 로그인이 필요해요"]);
    const titles = (await store.page(A.owner.id, null)).posts.map(
      (p) => p.title,
    );
    expect(titles).not.toContain("실패한 실행의 소식");
  });
});

describe("the person's presses", () => {
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
    return new Hono<{ Variables: AppVariables }>().route(
      "/api/feed",
      createFeedRoutes(store, requireUser),
    );
  };
  const post = async (path: string, who: string, body: unknown) =>
    surface(who).request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("seen, like and hide change the person's own posts; somebody else's is not found", async () => {
    const page = await store.page(A.owner.id, null);
    const [first, second] = page.posts;
    if (!first || !second) throw new Error("no posts");
    expect(
      (await post(`/api/feed/${first.id}/like`, B.owner.id, { liked: true }))
        .status,
    ).toBe(404);
    expect(
      await (
        await post("/api/feed/seen", B.owner.id, { ids: [first.id] })
      ).json(),
    ).toEqual({ seen: 0 });

    expect(
      await (
        await post("/api/feed/seen", A.owner.id, { ids: [first.id, second.id] })
      ).json(),
    ).toEqual({ seen: 2 });
    const unseen = await (
      await surface(A.owner.id).request("/api/feed/unseen")
    ).json();
    expect(unseen).toEqual({ count: 0 });

    expect(
      await (
        await post(`/api/feed/${first.id}/like`, A.owner.id, { liked: true })
      ).json(),
    ).toEqual({ liked: true, hidden: false });
    expect(
      await (await post(`/api/feed/${second.id}/hide`, A.owner.id, {})).json(),
    ).toEqual({ liked: false, hidden: true });
    const after = await store.page(A.owner.id, null);
    expect(after.posts.map((one) => one.title)).toEqual(["첫째 소식"]);
    expect(after.posts[0]?.liked).toBe(true);
  });

  test("what was liked and hidden is carried into the next run's instruction", async () => {
    const text = await reactionsFor(database, {
      userId: A.owner.id,
      agentId: A.botId,
    });
    expect(text).toContain("최근 좋아요: 첫째 소식");
    expect(text).toContain("숨김: 둘째 소식");
    expect(
      await reactionsFor(database, { userId: B.owner.id, agentId: B.botId }),
    ).toBe("");
  });

  test("a quoted post reaches the model as the post, read again by its id and only for the Bot that wrote it", async () => {
    const [liked] = (await store.page(A.owner.id, null)).posts;
    if (!liked) throw new Error("no post");
    const part = feedQuotePart({ id: liked.id, title: "제목은 칩에만" });
    const sent: string[] = [];
    const inner = async (_url: string, init: RequestInit) => {
      sent.push(String(init.body));
      return new Response("");
    };
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [part, { type: "text", text: "해당돼?" }] },
      ],
    });
    await withFeedQuotes(store, A.botId, inner)("/run", { body });
    expect(sent[0]).toContain("첫째 소식의 본문");
    expect(sent[0]).not.toContain("vnd.laf.feed-post");
    await withFeedQuotes(store, B.botId, inner)("/run", { body });
    expect(sent[1]).not.toContain("첫째 소식의 본문");
    expect(sent[1]).toContain("더 이상 없다");
  });
});

describe("posts nobody opens", () => {
  test("three runs with unseen posts, the oldest a week old, pause 소식 like unread answers", async () => {
    const routine = await feedRoutine(B.owner, B.botId);
    await database
      .update(channelMemberships)
      .set({ lastReadAt: NOW })
      .where(eq(channelMemberships.userId, B.owner.id));
    await database.insert(lafFeedPosts).values(
      [9, 8, 7].map((days, index) => ({
        id: `feed_${randomUUID()}`,
        userId: B.owner.id,
        agentId: B.botId,
        routineId: routine.id,
        runId: `run-${tag}-${index}`,
        topic: "업종 뉴스",
        title: `읽지 않은 소식 ${index}`,
        body: "본문",
        sources: [],
        createdAt: new Date(NOW.getTime() - days * DAY),
      })),
    );
    const pauses = await pauseUnreadRoutines({
      database,
      now: NOW,
      botIds: [B.botId],
    });
    expect(pauses.map((pause) => pause.routineIds)).toEqual([[routine.id]]);
    expect((await routineRow(routine.id)).pausedReason).toBe("unread");
  });
});
