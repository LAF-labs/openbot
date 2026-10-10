/**
 * 통합검색, AGAINST THE REAL TABLES (record §3, piece 4-3): whose words are read, which rows count
 * as words, what a person's punctuation means, and how the pages walk back.
 *
 * One person has a main conversation and a project with the same Bot, and a third conversation
 * they are no longer a member of; somebody else has a conversation holding the same words. The
 * words are tagged per run, since the test database is shared with every other file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { markTerms, type SearchPage, searchTerms } from "../../shared/search";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import {
  createConversationSearch,
  createSearchRoutes,
  likePattern,
  parseSearchCursor,
  SEARCH_PAGE,
  SNIPPET_LENGTH,
  snippetOf,
} from "../src/search/conversations";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
/** A word nothing else in the database holds. */
const word = (name: string) => `${name}${tag}`;

const ME = `search-me-${tag}`;
const OTHER = `search-other-${tag}`;
const BOT = `search-bot-${tag}`;
const MAIN = { channel: `search-main-${tag}`, thread: randomUUID() };
const PROJECT = { channel: `search-project-${tag}`, thread: randomUUID() };
const LEFT = { channel: `search-left-${tag}`, thread: randomUUID() };
const THEIRS = { channel: `search-theirs-${tag}`, thread: randomUUID() };
const LONG = { channel: `search-long-${tag}`, thread: randomUUID() };
/** Somebody else's thread in a channel this person is a member of: a channel holds one each. */
const BESIDE = { channel: MAIN.channel, thread: randomUUID() };
const ALL = [MAIN, PROJECT, LEFT, THEIRS, LONG];

const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 9, minute));

const SECRET = word("도구결과");
const ARGUMENT = word("도구인자");
const PICTURE = word("그림자료");

beforeAll(async () => {
  await database.insert(users).values(
    [ME, OTHER].map((id) => ({
      id,
      email: `${id}@laf.test`,
      name: id,
      emailVerified: true,
    })),
  );
  await database.insert(agents).values({
    id: BOT,
    name: BOT,
    type: "remote_ag_ui" as const,
    configuration: {},
  });
  await database.insert(channels).values([
    { id: MAIN.channel, name: "봇", description: "", kind: "main" },
    {
      id: PROJECT.channel,
      name: "가을 메뉴 개편",
      description: "",
      kind: "project",
    },
    { id: LEFT.channel, name: "나간 곳", description: "", kind: "project" },
    { id: THEIRS.channel, name: "남의 봇", description: "", kind: "main" },
    { id: LONG.channel, name: "긴 프로젝트", description: "", kind: "project" },
  ]);
  await database.insert(channelMemberships).values([
    { channelId: MAIN.channel, userId: ME },
    { channelId: PROJECT.channel, userId: ME },
    { channelId: LONG.channel, userId: ME },
    { channelId: THEIRS.channel, userId: OTHER },
    // Somebody is still in the conversation this person left: it is theirs to read, not ours.
    { channelId: LEFT.channel, userId: OTHER },
  ]);
  await database
    .insert(channelAgents)
    .values(ALL.map((one) => ({ channelId: one.channel, agentId: BOT })));
  await database.insert(channelThreads).values([
    { userId: ME, channelId: MAIN.channel, threadId: MAIN.thread },
    { userId: ME, channelId: PROJECT.channel, threadId: PROJECT.thread },
    // A thread whose membership is gone: the conversation was left.
    { userId: ME, channelId: LEFT.channel, threadId: LEFT.thread },
    { userId: ME, channelId: LONG.channel, threadId: LONG.thread },
    { userId: OTHER, channelId: THEIRS.channel, threadId: THEIRS.thread },
    { userId: OTHER, channelId: BESIDE.channel, threadId: BESIDE.thread },
  ]);

  const main = [
    {
      id: "m-ask",
      role: "user",
      content: `${word("토익")} 800점이 목표야. ${word("Excel")} 표로 정리해 줘`,
      lafAt: "2026-10-01T03:00:00.000Z",
    },
    {
      id: "m-answer",
      role: "assistant",
      content: `네, ${word("토익")} 계획을 세웠어요.`,
      toolCalls: [
        {
          id: "m-call",
          type: "function",
          function: {
            name: "showChecklist",
            arguments: JSON.stringify({ title: ARGUMENT }),
          },
        },
      ],
    },
    { id: "m-result", role: "tool", toolCallId: "m-call", content: SECRET },
    {
      id: "m-file",
      role: "user",
      content: [
        { type: "text", text: `${word("영수증")} 봐 줘` },
        { type: "binary", mimeType: "image/png", data: PICTURE },
        { type: "text", text: "두 번째 줄" },
      ],
    },
    { id: "m-percent", role: "user", content: `${word("할인")} 50% 적용` },
    { id: "m-plain", role: "user", content: `${word("할인")} 500 적용` },
    { id: "m-under", role: "user", content: `${word("파일")} a_b.csv` },
    { id: "m-nounder", role: "user", content: `${word("파일")} axb.csv` },
    { id: "m-slash", role: "user", content: `${word("경로")} C:\\temp` },
    { id: "m-noslash", role: "user", content: `${word("경로")} C:temp` },
  ];
  await database.insert(lafThreadMessages).values(
    main.map((message, index) => ({
      threadId: MAIN.thread,
      seq: index + 1,
      message,
      at: at(index),
    })),
  );
  await database.insert(lafThreadMessages).values([
    {
      threadId: PROJECT.thread,
      seq: 1,
      message: {
        id: "p-menu",
        role: "assistant",
        content: `${word("메뉴")}는 가을에 ${word("토익")}과 상관없이 바꿔요.`,
      },
      at: at(30),
    },
    {
      threadId: LEFT.thread,
      seq: 1,
      message: { id: "l-menu", role: "user", content: word("토익") },
      at: at(31),
    },
    {
      threadId: THEIRS.thread,
      seq: 1,
      message: { id: "t-menu", role: "user", content: word("토익") },
      at: at(32),
    },
    {
      threadId: BESIDE.thread,
      seq: 1,
      message: { id: "b-menu", role: "user", content: word("토익") },
      at: at(33),
    },
  ]);
  // More than a page, half of them written in the same instant: the order has to break the tie.
  await database.insert(lafThreadMessages).values(
    Array.from({ length: SEARCH_PAGE + 5 }, (_, index) => ({
      threadId: LONG.thread,
      seq: index + 1,
      message: {
        id: `long-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${word("반복")} ${index}`,
      },
      at: at(index < 20 ? 40 : 41),
    })),
  );
});

afterAll(async () => {
  await database.delete(lafThreadMessages).where(
    inArray(
      lafThreadMessages.threadId,
      [...ALL, BESIDE].map((one) => one.thread),
    ),
  );
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(channels).where(
    inArray(
      channels.id,
      ALL.map((one) => one.channel),
    ),
  );
  await database.delete(users).where(inArray(users.id, [ME, OTHER]));
  await database.$client.end();
});

const search = createConversationSearch({ database });
const find = (q: string, userId = ME, cursor: string | null = null) =>
  search({
    cursor: cursor === null ? null : parseSearchCursor(cursor),
    terms: searchTerms(q) ?? [],
    userId,
  });
const ids = (page: SearchPage) => page.hits.map((hit) => hit.messageId);

describe("what was said, in every conversation a person has", () => {
  test("the main conversation and a project are read together, newest first, each with where to go", async () => {
    const page = await find(word("토익"));
    expect(
      page.hits.map((hit) => [
        hit.messageId,
        hit.channelId,
        hit.kind,
        hit.channelName,
        hit.role,
      ]),
    ).toEqual([
      ["p-menu", PROJECT.channel, "project", "가을 메뉴 개편", "assistant"],
      ["m-answer", MAIN.channel, "main", "봇", "assistant"],
      ["m-ask", MAIN.channel, "main", "봇", "user"],
    ]);
    expect(page.next).toBeNull();
  });

  test("a hit says when it was said: the message's own stamp, or its row's where it has none", async () => {
    const page = await find(word("토익"));
    const byId = new Map(page.hits.map((hit) => [hit.messageId, hit.at]));
    expect(byId.get("m-ask")).toBe("2026-10-01T03:00:00.000Z");
    expect(byId.get("m-answer")).toBe(at(1).toISOString());
  });

  test("every word must be there, in any order", async () => {
    expect(ids(await find(`${word("메뉴")} ${word("토익")}`))).toEqual([
      "p-menu",
    ]);
    expect(ids(await find(`${word("토익")}   ${word("메뉴")}`))).toEqual([
      "p-menu",
    ]);
    expect(ids(await find(`${word("메뉴")} ${word("영수증")}`))).toEqual([]);
  });

  test("letters are found whatever their case", async () => {
    expect(ids(await find(word("excel").toLowerCase()))).toEqual(["m-ask"]);
    expect(ids(await find(word("EXCEL").toUpperCase()))).toEqual(["m-ask"]);
  });

  test("somebody else's conversation is not read, and neither is one the person left", async () => {
    const mine = ids(await find(word("토익")));
    expect(mine).not.toContain("t-menu");
    expect(mine).not.toContain("l-menu");
    // Nor the thread somebody else has in a channel this person is in.
    expect(mine).not.toContain("b-menu");
    // Theirs: their own conversation — and not the thread in a channel they are not a member of.
    expect(ids(await find(word("토익"), OTHER))).toEqual(["t-menu"]);
  });

  test("a tool's result and a call's arguments are not words anybody said", async () => {
    expect(ids(await find(SECRET))).toEqual([]);
    expect(ids(await find(ARGUMENT))).toEqual([]);
    // And what a hit carries is the message's words only: neither rides along beside them.
    const page = await find(word("토익"));
    const whole = JSON.stringify(page);
    expect(whole).not.toContain(SECRET);
    expect(whole).not.toContain(ARGUMENT);
  });

  test("a message that carried a file is read by its words, not by the file", async () => {
    const page = await find(word("영수증"));
    expect(ids(page)).toEqual(["m-file"]);
    expect(page.hits[0]?.snippet).toBe(`${word("영수증")} 봐 줘 두 번째 줄`);
    expect(ids(await find("두 번째 줄"))).toContain("m-file");
    expect(ids(await find(PICTURE))).toEqual([]);
  });

  test.each([
    ["a percent sign", `${word("할인")} 50%`, ["m-percent"]],
    ["an underscore", `${word("파일")} a_b`, ["m-under"]],
    ["a backslash", `${word("경로")} C:\\temp`, ["m-slash"]],
  ])(
    "%s is the character a person typed, not a pattern",
    async (_name, q, expected) => {
      expect(ids(await find(q))).toEqual(expected);
    },
  );

  test("the pages walk back without a hit twice or a hit missed, through rows written in one instant", async () => {
    const first = await find(word("반복"));
    expect(first.hits).toHaveLength(SEARCH_PAGE);
    expect(first.next).not.toBeNull();
    const second = await find(word("반복"), ME, first.next);
    expect(second.hits).toHaveLength(5);
    expect(second.next).toBeNull();
    const seen = [...ids(first), ...ids(second)];
    expect(new Set(seen).size).toBe(SEARCH_PAGE + 5);
    // Newest first: the later instant, and inside an instant the later row.
    expect(seen[0]).toBe(`long-${SEARCH_PAGE + 4}`);
    expect(seen.at(-1)).toBe("long-0");
  });

  test("exactly a page of hits has no page after it", async () => {
    await database
      .delete(lafThreadMessages)
      .where(
        and(
          eq(lafThreadMessages.threadId, LONG.thread),
          sql`${lafThreadMessages.seq} > ${SEARCH_PAGE}`,
        ),
      );
    const page = await find(word("반복"));
    expect(page.hits).toHaveLength(SEARCH_PAGE);
    expect(page.next).toBeNull();
  });

  test("the index the migration made is the one the search names", async () => {
    const [index] = (await database.execute(
      sql`select indexdef from pg_indexes where indexname = 'laf_thread_messages_said_trgm_idx'`,
    )) as unknown as Array<{ indexdef: string }>;
    expect(index?.indexdef).toContain("gin_trgm_ops");
    expect(index?.indexdef).toContain("laf_message_text(message)");
    expect(index?.indexdef).toContain("'user'");
    expect(index?.indexdef).toContain("'assistant'");
  });

  test("no statistics are kept for the index's expression: ANALYZE of a long conversation took minutes with them", async () => {
    const [column] = (await database.execute(
      sql`select attstattarget as target from pg_attribute where attrelid = 'laf_thread_messages_said_trgm_idx'::regclass and attnum = 1`,
    )) as unknown as Array<{ target: number | null }>;
    expect(column?.target).toBe(0);
  });
});

describe("the door", () => {
  const routes = new Hono<{ Variables: AppVariables }>();
  const asMe: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: ME } as AppVariables["actor"]);
    await next();
  };
  routes.route("/api/search", createSearchRoutes(search, asMe));
  const post = (body: unknown) =>
    routes.request("/api/search", {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

  test("answers the hits, and says they are not to be kept", async () => {
    const response = await post({ q: word("메뉴") });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ids((await response.json()) as SearchPage)).toEqual(["p-menu"]);
  });

  test.each([
    ["one character", { q: "가" }],
    ["nothing but spaces", { q: "    " }],
    ["a number", { q: 12 }],
    ["more than a hundred characters", { q: "가".repeat(101) }],
    ["six words", { q: "가나 다라 마바 사아 자차 카타" }],
    ["no body", "not json"],
  ])("refuses %s as a search", async (_name, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "laf:search_query_invalid",
    );
  });

  test.each([
    ["words", "어제"],
    ["a date that is not one", "2026-13-45T99:00:00.000000Z~thread~1"],
    ["a quote", "2026-10-10T09:00:00.000000Z~a'b~1"],
    ["a number", 3],
  ])("refuses a cursor that is %s", async (_name, cursor) => {
    const response = await post({ cursor, q: word("메뉴") });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "laf:search_cursor_invalid",
    );
  });

  test("a search that could not be read says so, and not that nothing was found", async () => {
    const broken = new Hono<{ Variables: AppVariables }>();
    broken.route(
      "/api/search",
      createSearchRoutes(async () => {
        throw new Error("boom");
      }, asMe),
    );
    const response = await broken.request("/api/search", {
      body: JSON.stringify({ q: "메뉴" }),
      method: "POST",
    });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { code: string }).code).toBe(
      "laf:search_unavailable",
    );
  });
});

describe("the words a person typed", () => {
  test("are split on spaces, once each, composed", () => {
    expect(searchTerms("  가을   메뉴 가을 ")).toEqual(["가을", "메뉴"]);
    // Decomposed 한 (three jamo) is the one character a message stores.
    expect(searchTerms("\u1112\u1161\u11ab글")).toEqual(["한글"]);
  });

  test("a pattern is its own characters", () => {
    expect(likePattern("50%")).toBe("%50\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
    expect(likePattern("C:\\temp")).toBe("%C:\\\\temp%");
  });

  test("a snippet is one line around the first word found, cut by characters", () => {
    expect(snippetOf("가을\n\n메뉴   개편", ["메뉴"])).toBe("가을 메뉴 개편");
    const long = `${"가".repeat(300)} 찾는말 ${"나".repeat(300)}`;
    const cut = snippetOf(long, ["찾는말"]);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toContain("찾는말");
    expect([...cut]).toHaveLength(SNIPPET_LENGTH + 2);
    // An emoji is two halves in a string and one thing in a snippet.
    const emoji = snippetOf(`${"😀".repeat(400)}끝`, ["없는말"]);
    expect([...emoji]).toHaveLength(SNIPPET_LENGTH + 1);
    expect(emoji).toBe(`${"😀".repeat(SNIPPET_LENGTH)}…`);
    expect(snippetOf("Excel 표", ["excel"])).toBe("Excel 표");
  });

  test("the words found are marked, and nothing else", () => {
    expect(markTerms("가을 Menu 개편, 메뉴판", ["menu", "메뉴"])).toEqual([
      { at: 0, isMatch: false, text: "가을 " },
      { at: 3, isMatch: true, text: "Menu" },
      { at: 7, isMatch: false, text: " 개편, " },
      { at: 12, isMatch: true, text: "메뉴" },
      { at: 14, isMatch: false, text: "판" },
    ]);
    // A term is its own characters, never a pattern.
    expect(markTerms("a.c (b)", [".", "("])).toEqual([
      { at: 0, isMatch: false, text: "a" },
      { at: 1, isMatch: true, text: "." },
      { at: 2, isMatch: false, text: "c " },
      { at: 4, isMatch: true, text: "(" },
      { at: 5, isMatch: false, text: "b)" },
    ]);
    expect(markTerms("없음", ["메뉴"])).toEqual([
      { at: 0, isMatch: false, text: "없음" },
    ]);
    expect(markTerms("", ["메뉴"])).toEqual([]);
  });
});
