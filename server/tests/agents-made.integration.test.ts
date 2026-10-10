/**
 * 만든 것, AGAINST THE REAL TABLES (muse-shape plan §3.5, phase 6): what counts, whose it is, and
 * how the pages walk back.
 *
 * One person's conversation with their Bot holds a checklist card, a notice, a table written into an
 * answer, a card that was refused, a card that never got its answer, a question card, plain talk,
 * and two file cards — one for a file that was there and one the server would not confirm; somebody
 * else's conversation holds a card of theirs. Then enough cards to need a second page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  cardArgs,
  createMadeReader,
  createMadeRoutes,
  MADE_ARGS_MAX,
  MADE_PAGE_MESSAGES,
  type MadePage,
} from "../src/agents/made";
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
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
const A = {
  user: `made-a-${tag}`,
  bot: `made-bot-a-${tag}`,
  channel: `made-channel-a-${tag}`,
  thread: randomUUID(),
};
const B = {
  user: `made-b-${tag}`,
  bot: `made-bot-b-${tag}`,
  channel: `made-channel-b-${tag}`,
  thread: randomUUID(),
};
/** A third person whose conversation is long enough for pages. */
const C = {
  user: `made-c-${tag}`,
  bot: `made-bot-c-${tag}`,
  channel: `made-channel-c-${tag}`,
  thread: randomUUID(),
};

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const answer = (callId: string, content: string) => ({
  id: `answer-${callId}`,
  role: "tool",
  toolCallId: callId,
  content,
});

const at = (minute: number) => new Date(Date.UTC(2026, 8, 27, 9, minute));

beforeAll(async () => {
  await database.insert(users).values(
    [A.user, B.user, C.user].map((id) => ({
      id,
      email: `${id}@laf.test`,
      name: id,
      emailVerified: true,
    })),
  );
  await database.insert(agents).values(
    [A.bot, B.bot, C.bot].map((id) => ({
      id,
      name: id,
      type: "remote_ag_ui" as const,
      configuration: {},
    })),
  );
  const people = [
    [A, "a"],
    [B, "b"],
    [C, "c"],
  ] as const;
  await database.insert(channels).values(
    people.map(([one]) => ({
      id: one.channel,
      name: one.channel,
      description: "",
    })),
  );
  await database
    .insert(channelMemberships)
    .values(
      people.map(([one]) => ({ channelId: one.channel, userId: one.user })),
    );
  await database
    .insert(channelAgents)
    .values(
      people.map(([one]) => ({ channelId: one.channel, agentId: one.bot })),
    );
  await database.insert(channelThreads).values(
    people.map(([one]) => ({
      userId: one.user,
      channelId: one.channel,
      threadId: one.thread,
    })),
  );

  const a = [
    { id: "a-ask", role: "user", content: "체크리스트랑 표 만들어 줘" },
    {
      id: "a-cards",
      role: "assistant",
      content: "",
      toolCalls: [
        call("c-check", "showChecklist", {
          title: "가게 오픈 준비",
          items: [],
        }),
        call("c-notice", "showNotice", { title: "추석 휴무 안내" }),
      ],
    },
    answer("c-check", "The checklist is now on screen for the person."),
    answer("c-notice", "The notice is now on screen for the person."),
    {
      id: "a-table",
      role: "assistant",
      content:
        "정리했어요.\n\n**메뉴 가격표**\n\n| 메뉴 | 가격 |\n|---|---|\n| 김치찌개 | 9,000원 |",
    },
    // Refused by the grants: a JSON refusal is its answer.
    {
      id: "a-refused",
      role: "assistant",
      content: "",
      toolCalls: [call("c-refused", "showMetrics", { title: "막힌 카드" })],
    },
    answer(
      "c-refused",
      JSON.stringify({ ok: false, code: "laf:component_not_granted" }),
    ),
    // Thrown by its handler.
    {
      id: "a-thrown",
      role: "assistant",
      content: "",
      toolCalls: [call("c-thrown", "showRecord", { title: "터진 카드" })],
    },
    answer("c-thrown", "Error: boom"),
    // Never answered: the turn was stopped with the card in flight.
    {
      id: "a-pending",
      role: "assistant",
      content: "",
      toolCalls: [
        call("c-pending", "showBarChart", { title: "그리다 만 차트" }),
      ],
    },
    // A question is not a thing made, and neither is plain talk.
    {
      id: "a-question",
      role: "assistant",
      content: "",
      toolCalls: [call("c-question", "askChoice", { question: "어느 쪽?" })],
    },
    answer("c-question", JSON.stringify({ choice: "a" })),
    {
      id: "a-talk",
      role: "assistant",
      content: "그 밖에 도와드릴 게 있을까요?",
    },
    // A file handed over (phase 8): no title of its own, so it is listed as its file.
    {
      id: "a-file",
      role: "assistant",
      content: "",
      toolCalls: [
        call("c-file", "showFile", {
          path: "보고서/9월 정산.csv",
          note: "이번 달 정산 내역이에요",
        }),
      ],
    },
    answer(
      "c-file",
      "The file card is on screen for the person, with its name, its size and a button to download it. Do not paste the file's contents into your answer again.",
    ),
    // And one whose file was not there: the turn answered the computer's fact, as an envelope.
    {
      id: "a-nofile",
      role: "assistant",
      content: "",
      toolCalls: [call("c-nofile", "showFile", { path: "없는 파일.csv" })],
    },
    answer(
      "c-nofile",
      JSON.stringify({
        ok: false,
        code: "laf:file_not_found",
        reason: "그 경로에 파일이나 폴더가 없다.",
      }),
    ),
  ];
  await database.insert(lafThreadMessages).values(
    a.map((message, index) => ({
      threadId: A.thread,
      seq: index + 1,
      message,
      at: at(index),
    })),
  );
  await database.insert(lafThreadMessages).values([
    {
      threadId: B.thread,
      seq: 1,
      message: {
        id: "b-card",
        role: "assistant",
        content: "",
        toolCalls: [
          call("b-check", "showChecklist", { title: "남의 체크리스트" }),
        ],
      },
      at: at(1),
    },
    {
      threadId: B.thread,
      seq: 2,
      message: answer(
        "b-check",
        "The checklist is now on screen for the person.",
      ),
      at: at(2),
    },
  ]);
  // Enough notices for two pages and a bit, each with its answer.
  const count = MADE_PAGE_MESSAGES + 5;
  await database.insert(lafThreadMessages).values(
    Array.from({ length: count }, (_, index) => [
      {
        threadId: C.thread,
        seq: index * 2 + 1,
        message: {
          id: `c-card-${index}`,
          role: "assistant",
          content: "",
          toolCalls: [
            call(`c-call-${index}`, "showNotice", { title: `공지 ${index}` }),
          ],
        },
        at: at(0),
      },
      {
        threadId: C.thread,
        seq: index * 2 + 2,
        message: answer(
          `c-call-${index}`,
          "The notice is now on screen for the person.",
        ),
        at: at(0),
      },
    ]).flat(),
  );
});

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, [A.thread, B.thread, C.thread]));
  // Memberships, links and threads go with the channels and the people.
  await database
    .delete(agents)
    .where(inArray(agents.id, [A.bot, B.bot, C.bot]));
  await database
    .delete(channels)
    .where(inArray(channels.id, [A.channel, B.channel, C.channel]));
  await database
    .delete(users)
    .where(inArray(users.id, [A.user, B.user, C.user]));
  await database.$client.end();
});

const read = createMadeReader({ database });

describe("what the Bot made, read out of its conversation", () => {
  test("the cards that reached the screen and the table it wrote, newest first, with where to jump", async () => {
    const page = await read({
      userId: A.user,
      agentId: A.bot,
      shelf: null,
      cursor: null,
    });
    expect(
      page.items.map((item) => [
        item.tool,
        item.shelf,
        item.title,
        item.messageId,
      ]),
    ).toEqual([
      // The file's name, without the folder it sits in.
      ["showFile", "file", "9월 정산.csv", "c-file"],
      ["markdownTable", "table", "메뉴 가격표", "a-table"],
      ["showNotice", "text", "추석 휴무 안내", "c-notice"],
      ["showChecklist", "checklist", "가게 오픈 준비", "c-check"],
    ]);
    expect(page.items.every((item) => item.channelId === A.channel)).toBe(true);
    expect(page.next).toBeNull();
  });

  test("a refused card, a card that threw, one never answered, a file that was not there and a question are not listed", async () => {
    const page = await read({
      userId: A.user,
      agentId: A.bot,
      shelf: null,
      cursor: null,
    });
    const titles = JSON.stringify(page.items);
    for (const absent of [
      "막힌 카드",
      "터진 카드",
      "그리다 만 차트",
      "c-question",
      // A file card the server did not confirm never reached the person as a file.
      "없는 파일.csv",
      "c-nofile",
    ]) {
      expect(titles).not.toContain(absent);
    }
  });

  /*
   * 홈 DRAWS THE LAST THING MADE AS THE CARD ITSELF (2026-10-10), and a card is its arguments. One
   * thing's are sent, not a page's: the newest, on the newest page, and only where it is a card.
   */
  test("the newest card carries what it was called with — it alone, and never a file or a table", async () => {
    // Everything: the newest thing is a file, whose argument is a path in the Bot's folder.
    const all = await read({
      userId: A.user,
      agentId: A.bot,
      shelf: null,
      cursor: null,
    });
    expect(all.items[0]?.tool).toBe("showFile");
    expect(all.items.filter((item) => item.args !== undefined)).toEqual([]);
    expect(JSON.stringify(all)).not.toContain("이번 달 정산 내역이에요");

    // The written things: the newest is the notice, and it alone carries its arguments.
    const text = await read({
      userId: A.user,
      agentId: A.bot,
      shelf: "text",
      cursor: null,
    });
    expect(text.items[0]?.messageId).toBe("c-notice");
    expect(text.items[0]?.args?.title).toBe("추석 휴무 안내");
    expect(
      text.items.slice(1).filter((item) => item.args !== undefined),
    ).toEqual([]);

    // A table written into an answer has no arguments: it is words.
    const tables = await read({
      userId: A.user,
      agentId: A.bot,
      shelf: "table",
      cursor: null,
    });
    expect(tables.items[0]?.tool).toBe("markdownTable");
    expect(tables.items.filter((item) => item.args !== undefined)).toEqual([]);
  });

  test("only the newest page's first thing: a page walked back to carries none", async () => {
    const first = await read({
      userId: C.user,
      agentId: C.bot,
      shelf: null,
      cursor: null,
    });
    expect(first.items[0]?.args).toEqual({
      title: `공지 ${MADE_PAGE_MESSAGES + 4}`,
    });
    expect(first.items.filter((item) => item.args !== undefined)).toHaveLength(
      1,
    );
    const second = await read({
      userId: C.user,
      agentId: C.bot,
      shelf: null,
      cursor: first.next,
    });
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.filter((item) => item.args !== undefined)).toEqual([]);
  });

  test.each([
    ["nothing", null],
    ["not JSON", "{title:"],
    ["a list", "[1,2]"],
    ["a word", '"x"'],
    [
      "more than is worth drawing small",
      JSON.stringify({ rows: "x".repeat(MADE_ARGS_MAX) }),
    ],
  ])("arguments that are %s are not sent", (_, raw) => {
    expect(cardArgs(raw)).toBeNull();
  });

  test("arguments that are an object are sent as they were", () => {
    expect(
      cardArgs('{"title":"가","items":[{"label":"나","done":true}]}'),
    ).toEqual({
      title: "가",
      items: [{ label: "나", done: true }],
    });
  });

  test("a shelf holds only its own", async () => {
    const tables = await read({
      userId: A.user,
      agentId: A.bot,
      shelf: "table",
      cursor: null,
    });
    expect(tables.items.map((item) => item.title)).toEqual(["메뉴 가격표"]);
    const checklists = await read({
      userId: A.user,
      agentId: A.bot,
      shelf: "checklist",
      cursor: null,
    });
    expect(checklists.items.map((item) => item.title)).toEqual([
      "가게 오픈 준비",
    ]);
    const files = await read({
      userId: A.user,
      agentId: A.bot,
      shelf: "file",
      cursor: null,
    });
    expect(files.items.map((item) => [item.tool, item.title])).toEqual([
      ["showFile", "9월 정산.csv"],
    ]);
    // Somebody whose Bot has handed over nothing has nothing on that shelf: the page draws no
    // 파일 filter on exactly this answer.
    const none = await read({
      userId: B.user,
      agentId: B.bot,
      shelf: "file",
      cursor: null,
    });
    expect(none).toEqual({ items: [], next: null });
  });

  test("somebody else's conversation, and a Bot with none, give nothing", async () => {
    const other = await read({
      userId: A.user,
      agentId: B.bot,
      shelf: null,
      cursor: null,
    });
    expect(other).toEqual({ items: [], next: null });
    const theirs = await read({
      userId: B.user,
      agentId: B.bot,
      shelf: null,
      cursor: null,
    });
    expect(theirs.items.map((item) => item.title)).toEqual(["남의 체크리스트"]);
  });

  test("a long conversation walks back a page at a time, each item once", async () => {
    const first = await read({
      userId: C.user,
      agentId: C.bot,
      shelf: null,
      cursor: null,
    });
    expect(first.items).toHaveLength(MADE_PAGE_MESSAGES);
    expect(first.items[0]?.title).toBe(`공지 ${MADE_PAGE_MESSAGES + 4}`);
    expect(first.next).not.toBeNull();
    const second = await read({
      userId: C.user,
      agentId: C.bot,
      shelf: null,
      cursor: first.next,
    });
    expect(second.items.map((item) => item.title)).toEqual(
      [4, 3, 2, 1, 0].map((index) => `공지 ${index}`),
    );
    expect(second.next).toBeNull();
  });
});

describe("GET /api/agents/:agentId/made", () => {
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
      [A.user, [A.bot]],
      [B.user, [B.bot]],
    ]);
    return new Hono<{ Variables: AppVariables }>().route(
      "/api/agents",
      createMadeRoutes(
        async (actor, agentId) =>
          mine.get(actor.id)?.includes(agentId) ?? false,
        requireUser,
        read,
      ),
    );
  };

  test("answers the person's own Bot, by shelf", async () => {
    const response = await surface(A.user).request(
      `/api/agents/${A.bot}/made?shelf=text`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as MadePage;
    expect(page.items.map((item) => item.title)).toEqual(["추석 휴무 안내"]);
  });

  test("a Bot the person cannot see is not found; an unknown shelf or cursor is refused with a code", async () => {
    const hidden = await surface(B.user).request(`/api/agents/${A.bot}/made`);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({
      error: "laf:agent_not_found",
      code: "laf:agent_not_found",
    });
    const shelf = await surface(A.user).request(
      `/api/agents/${A.bot}/made?shelf=files`,
    );
    expect(shelf.status).toBe(400);
    expect(((await shelf.json()) as { code: string }).code).toBe(
      "laf:made_shelf_unknown",
    );
    const cursor = await surface(A.user).request(
      `/api/agents/${A.bot}/made?cursor=1;drop`,
    );
    expect(cursor.status).toBe(400);
  });
});
