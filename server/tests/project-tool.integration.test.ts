/**
 * THE MAIN CONVERSATION'S WAY INTO THE PROJECTS, AGAINST THE REAL TABLES (record §3, piece 4-4's
 * first part): whose projects are read, what each reading hands over, which projects a result says
 * it read — the mark the stored copy is covered by — and what a summary costs and keeps.
 *
 * One person has a main conversation and several projects with one Bot; somebody else has a project
 * with the same words. The words are tagged per run, since the test database is shared.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { TOOL_RESULT_CUT } from "../../shared/spillover";
import {
  PROJECT_SEARCH_HITS,
  READ_PROJECTS,
} from "../../shared/tools/projects";
import {
  createProjectSummaries,
  createProjectTools,
  PROJECT_SUMMARY_MESSAGES,
  type ProjectSummarizer,
} from "../src/channels/project-tool";
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
import { createConversationSearch } from "../src/search/conversations";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
const word = (name: string) => `${name}${tag}`;

const ME = `ptool-me-${tag}`;
const OTHER = `ptool-other-${tag}`;
const BOT = `ptool-bot-${tag}`;
const place = (name: string) => ({
  channel: `ptool-${name}-${tag}`,
  thread: randomUUID(),
});
const MAIN = place("main");
const TRIP = place("trip");
const MENU = place("menu");
const TWIN_A = place("twin-a");
const TWIN_B = place("twin-b");
const EMPTY = place("empty");
const LEAVING = place("leaving");
const THEIRS = place("theirs");
const ALL = [MAIN, TRIP, MENU, TWIN_A, TWIN_B, EMPTY, LEAVING, THEIRS];

const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 9, minute));

const said = (
  threadId: string,
  seq: number,
  message: Record<string, unknown>,
) => ({ threadId, seq, message, at: at(seq) });

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
    { id: TRIP.channel, name: "제주 여행", description: "", kind: "project" },
    { id: MENU.channel, name: "가을 메뉴", description: "", kind: "project" },
    { id: TWIN_A.channel, name: "이사 준비", description: "", kind: "project" },
    { id: TWIN_B.channel, name: "이사 준비", description: "", kind: "project" },
    {
      id: EMPTY.channel,
      name: "빈 프로젝트",
      description: "",
      kind: "project",
    },
    {
      id: LEAVING.channel,
      name: "지우는 중",
      description: "",
      kind: "project",
      deletingAt: new Date(),
    },
    { id: THEIRS.channel, name: "남의 것", description: "", kind: "project" },
  ]);
  await database.insert(channelMemberships).values([
    ...[MAIN, TRIP, MENU, TWIN_A, TWIN_B, EMPTY, LEAVING].map((one) => ({
      channelId: one.channel,
      userId: ME,
    })),
    { channelId: THEIRS.channel, userId: OTHER },
  ]);
  await database
    .insert(channelAgents)
    .values(ALL.map((one) => ({ channelId: one.channel, agentId: BOT })));
  await database.insert(channelThreads).values([
    { userId: ME, channelId: MAIN.channel, threadId: MAIN.thread },
    {
      userId: ME,
      channelId: TRIP.channel,
      threadId: TRIP.thread,
      lastMessageAt: at(30),
    },
    {
      userId: ME,
      channelId: MENU.channel,
      threadId: MENU.thread,
      lastMessageAt: at(40),
    },
    { userId: ME, channelId: TWIN_A.channel, threadId: TWIN_A.thread },
    { userId: ME, channelId: TWIN_B.channel, threadId: TWIN_B.thread },
    { userId: ME, channelId: EMPTY.channel, threadId: EMPTY.thread },
    {
      userId: ME,
      channelId: LEAVING.channel,
      threadId: LEAVING.thread,
      lastMessageAt: at(50),
    },
    { userId: OTHER, channelId: THEIRS.channel, threadId: THEIRS.thread },
  ]);
  await database.insert(lafThreadMessages).values([
    said(MAIN.thread, 1, {
      id: "main-said",
      role: "user",
      content: `${word("숙소")}는 어디가 좋을까`,
    }),
    said(TRIP.thread, 1, {
      id: "trip-ask",
      role: "user",
      content: `제주 3박 4일, ${word("숙소")}는 애월로 잡아 줘`,
    }),
    said(TRIP.thread, 2, {
      id: "trip-step",
      role: "assistant",
      content: "",
      lafDelegated: "call-browse",
      toolCalls: [
        {
          id: "step-1",
          type: "function",
          function: { name: "computer_navigate", arguments: "{}" },
        },
      ],
    }),
    said(TRIP.thread, 3, {
      id: "trip-page",
      role: "tool",
      toolCallId: "step-1",
      lafDelegated: "call-browse",
      content: `맡은 쪽이 본 페이지 ${word("광고문구")}`,
    }),
    said(TRIP.thread, 4, {
      id: "trip-answer",
      role: "assistant",
      content: `애월 ${word("숙소")} 세 곳을 골랐어요. 1박 12만 원대예요.`,
    }),
    said(MENU.thread, 1, {
      id: "menu-ask",
      role: "user",
      content: `${word("단호박")} 수프를 넣자`,
    }),
    said(LEAVING.thread, 1, {
      id: "leaving-said",
      role: "user",
      content: `${word("숙소")} 지우는 중인 말`,
    }),
    said(THEIRS.thread, 1, {
      id: "theirs-said",
      role: "user",
      content: `${word("숙소")} 남의 말`,
    }),
  ]);
});

afterAll(async () => {
  await database.delete(lafThreadMessages).where(
    inArray(
      lafThreadMessages.threadId,
      ALL.map((one) => one.thread),
    ),
  );
  await database.delete(channels).where(
    inArray(
      channels.id,
      ALL.map((one) => one.channel),
    ),
  );
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(inArray(users.id, [ME, OTHER]));
  await database.$client.end();
});

/** A toolkit for one turn, with what its summariser was asked and what it answers. */
function turn(
  options: {
    userId?: string;
    summarize?: ProjectSummarizer | null;
    isSpent?: boolean;
    summaries?: ReturnType<typeof createProjectSummaries>;
    runId?: string;
  } = {},
) {
  const asked: Array<{ name: string; transcript: string }> = [];
  const summaries = options.summaries ?? createProjectSummaries();
  const summarize: ProjectSummarizer =
    options.summarize ??
    (async (input) => {
      asked.push(input);
      return `- 요약 ${asked.length}`;
    });
  const toolkit = createProjectTools({
    database,
    search: createConversationSearch({ database }),
    summaries,
    ...(options.summarize === null ? {} : { summarize }),
    budgetSpent: async () => options.isSpent === true,
    timeZoneOf: async () => "Asia/Seoul",
  })({
    userId: options.userId ?? ME,
    agentId: BOT,
    ...(options.runId ? { runId: options.runId } : {}),
  });
  let calls = 0;
  const call = async (args: Record<string, unknown>) => {
    calls += 1;
    const id = `call-${calls}`;
    const outcome = await toolkit.execute(READ_PROJECTS, args, { id });
    return { outcome, read: toolkit.read(id) };
  };
  return { asked, call, summaries, toolkit };
}

describe("the list", () => {
  test("is this person's projects with this Bot — the newest spoken in first, none on its way out, nobody else's", async () => {
    const { call } = turn();
    const { outcome, read } = await call({ kind: "list" });
    expect(outcome.ok).toBe(true);
    const projects = outcome.projects as Array<{
      id: string;
      name: string;
      lastAt?: string;
    }>;
    expect(projects.map((one) => one.id)).toEqual([
      MENU.channel,
      TRIP.channel,
      ...projects.slice(2).map((one) => one.id),
    ]);
    expect(new Set(projects.map((one) => one.id))).toEqual(
      new Set([
        MENU.channel,
        TRIP.channel,
        TWIN_A.channel,
        TWIN_B.channel,
        EMPTY.channel,
      ]),
    );
    expect(projects[0]).toEqual({
      id: MENU.channel,
      name: "가을 메뉴",
      lastAt: at(40).toISOString(),
    });
    // A project nothing was said in has no time to say.
    expect(projects.find((one) => one.id === EMPTY.channel)).toEqual({
      id: EMPTY.channel,
      name: "빈 프로젝트",
    });
    // The names are the projects' own words: the result says it read every one of them.
    expect(new Set(read)).toEqual(new Set(projects.map((one) => one.id)));
  });

  test("of somebody with no project is empty, and says it read nothing", async () => {
    const { call } = turn({ userId: `ptool-nobody-${tag}` });
    const { outcome, read } = await call({ kind: "list" });
    expect(outcome).toEqual({ ok: true, projects: [] });
    expect(read).toBeUndefined();
  });
});

describe("the search", () => {
  test("says where each thing was said — here, or a project by id and name — and which projects the result read", async () => {
    const { call } = turn();
    const { outcome, read } = await call({
      kind: "search",
      terms: word("숙소"),
    });
    expect(outcome.ok).toBe(true);
    const hits = outcome.hits as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(3);
    expect(hits.find((hit) => hit.here)).toMatchObject({
      here: true,
      by: "person",
      text: `${word("숙소")}는 어디가 좋을까`,
    });
    expect(
      hits.filter((hit) => hit.project === TRIP.channel).map((hit) => hit.by),
    ).toEqual(["bot", "person"]);
    expect(hits.find((hit) => hit.project)).toMatchObject({
      project: TRIP.channel,
      name: "제주 여행",
    });
    // Not the project on its way out, and not somebody else's.
    expect(JSON.stringify(outcome)).not.toContain("지우는 중인 말");
    expect(JSON.stringify(outcome)).not.toContain("남의 말");
    // What a run the project handed its browsing to read is nobody's words.
    expect(JSON.stringify(outcome)).not.toContain(word("광고문구"));
    expect(read).toEqual([TRIP.channel]);
    expect(outcome.next).toBeUndefined();
  });

  test("that found something only in this conversation read no project", async () => {
    const { call } = turn();
    const { outcome, read } = await call({
      kind: "search",
      terms: `${word("숙소")} 어디가`,
    });
    expect((outcome.hits as unknown[]).length).toBe(1);
    expect(read).toBeUndefined();
  });

  test("that found nothing says so with an empty list", async () => {
    const { call } = turn();
    const { outcome, read } = await call({
      kind: "search",
      terms: word("없는말"),
    });
    expect(outcome).toEqual({ ok: true, hits: [] });
    expect(read).toBeUndefined();
  });

  test.each([
    [{ kind: "search" }, "terms"],
    [{ kind: "search", terms: "가" }, "terms"],
    [{ kind: "search", terms: word("숙소"), cursor: "아무 말" }, "cursor"],
    [{ kind: "summary" }, "project"],
    [{ kind: "everything" }, "kind"],
    [{ kind: "query", project: "제주 여행" }, "kind"],
    [{ kind: 3 }, "kind"],
  ])(
    "a call that is not one — %j — is told which part",
    async (args, field) => {
      const { call } = turn();
      const { outcome, read } = await call(args);
      expect(outcome).toMatchObject({
        ok: false,
        code: "laf:project_read_invalid",
        field,
      });
      expect(read).toBeUndefined();
    },
  );

  test("does not hand a turn its own question back: what the asking run wrote is left out", async () => {
    const RUN = `ptool-run-${tag}`;
    await database.insert(lafThreadMessages).values([
      {
        ...said(MAIN.thread, 50, {
          id: "main-asking",
          role: "user",
          content: `${word("숙소")} 어디로 했는지 프로젝트에서 찾아 줘`,
        }),
        runId: RUN,
      },
      {
        ...said(MAIN.thread, 51, {
          id: "main-looking",
          role: "assistant",
          content: `${word("숙소")} 기록을 찾아볼게요.`,
        }),
        runId: RUN,
      },
    ]);
    const texts = async (runId?: string) => {
      const { call } = turn(runId ? { runId } : {});
      const { outcome } = await call({ kind: "search", terms: word("숙소") });
      return (outcome.hits as Array<{ text: string }>).map((hit) => hit.text);
    };
    // Another turn's search reads them — they are words said in the conversation.
    expect((await texts(`ptool-later-${tag}`)).join("\n")).toContain(
      "프로젝트에서 찾아 줘",
    );
    const own = await texts(RUN);
    expect(own.join("\n")).not.toContain("프로젝트에서 찾아 줘");
    expect(own.join("\n")).not.toContain("기록을 찾아볼게요");
    // And everything else is still there: the older line here, the project's two.
    expect(own).toHaveLength(3);

    await database
      .delete(lafThreadMessages)
      .where(
        and(
          eq(lafThreadMessages.threadId, MAIN.thread),
          inArray(lafThreadMessages.seq, [50, 51]),
        ),
      );
  });

  test("a page holds fewer hits than a screen's, and says where the next one starts", async () => {
    const LONG = place("long");
    await database.insert(channels).values({
      id: LONG.channel,
      name: "긴 프로젝트",
      description: "",
      kind: "project",
    });
    await database
      .insert(channelMemberships)
      .values({ channelId: LONG.channel, userId: ME });
    await database
      .insert(channelAgents)
      .values({ channelId: LONG.channel, agentId: BOT });
    await database.insert(channelThreads).values({
      userId: ME,
      channelId: LONG.channel,
      threadId: LONG.thread,
    });
    await database.insert(lafThreadMessages).values(
      Array.from({ length: PROJECT_SEARCH_HITS + 3 }, (_, index) =>
        said(LONG.thread, index + 1, {
          id: `long-${index}`,
          role: "user",
          content: `${word("반복")} ${index}`,
        }),
      ),
    );
    const { call } = turn();
    const first = await call({ kind: "search", terms: word("반복") });
    expect(first.outcome.hits as unknown[]).toHaveLength(PROJECT_SEARCH_HITS);
    expect(typeof first.outcome.next).toBe("string");
    const second = await call({
      kind: "search",
      terms: word("반복"),
      cursor: first.outcome.next,
    });
    expect(second.outcome.hits as unknown[]).toHaveLength(3);
    expect(second.outcome.next).toBeUndefined();
    expect(second.read).toEqual([LONG.channel]);

    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, LONG.thread));
    await database.delete(channels).where(eq(channels.id, LONG.channel));
  });
});

describe("the summary", () => {
  test("is made from what was said in the project — not from what a delegated run read — and names the project it read", async () => {
    const { asked, call } = turn();
    const { outcome, read } = await call({
      kind: "summary",
      project: TRIP.channel,
    });
    expect(outcome).toEqual({
      ok: true,
      project: TRIP.channel,
      name: "제주 여행",
      summary: "- 요약 1",
      through: at(30).toISOString(),
    });
    expect(read).toEqual([TRIP.channel]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.name).toBe("제주 여행");
    expect(asked[0]?.transcript).toContain("애월로 잡아 줘");
    expect(asked[0]?.transcript).toContain("1박 12만 원대");
    expect(asked[0]?.transcript).not.toContain(word("광고문구"));
    expect(asked[0]?.transcript).not.toContain("computer_navigate");
  });

  test.each(["  제주   여행 ", "제주 여행 프로젝트", "제주"])(
    "is found by the project's name as a person would say it: %j",
    async (project) => {
      const { call } = turn();
      const { outcome } = await call({ kind: "summary", project });
      expect(outcome).toMatchObject({
        ok: true,
        project: TRIP.channel,
        name: "제주 여행",
      });
    },
  );

  test("words that fit two projects are not guessed at either", async () => {
    const { asked, call } = turn();
    const { outcome } = await call({ kind: "summary", project: "이사" });
    expect(outcome).toMatchObject({
      ok: false,
      code: "laf:project_ambiguous",
    });
    expect(asked).toHaveLength(0);
  });

  test("is made once for a project nothing more was said in, and again after a word is", async () => {
    const summaries = createProjectSummaries();
    const first = turn({ summaries });
    await first.call({ kind: "summary", project: MENU.channel });
    expect(first.asked).toHaveLength(1);

    // Another turn, the same process: read from what is kept.
    const second = turn({ summaries });
    const again = await second.call({
      kind: "summary",
      project: MENU.channel,
    });
    expect(second.asked).toHaveLength(0);
    expect(again.outcome).toMatchObject({ ok: true, summary: "- 요약 1" });
    expect(again.read).toEqual([MENU.channel]);

    await database.insert(lafThreadMessages).values(
      said(MENU.thread, 2, {
        id: "menu-more",
        role: "assistant",
        content: "단호박 수프, 9천 원으로 올릴게요.",
      }),
    );
    const third = turn({ summaries });
    await third.call({ kind: "summary", project: MENU.channel });
    expect(third.asked).toHaveLength(1);
    expect(third.asked[0]?.transcript).toContain("9천 원");
  });

  test("of a project that is not this person's, is on its way out, or was never made is not found — with the ones there are", async () => {
    const { asked, call } = turn();
    for (const project of [THEIRS.channel, LEAVING.channel, "없는 프로젝트"]) {
      const { outcome, read } = await call({ kind: "summary", project });
      expect(outcome).toMatchObject({
        ok: false,
        code: "laf:project_not_found",
      });
      const offered = (outcome.projects as Array<{ id: string }>).map(
        (one) => one.id,
      );
      expect(offered).toContain(TRIP.channel);
      expect(offered).not.toContain(THEIRS.channel);
      expect(offered).not.toContain(LEAVING.channel);
      // The names it was handed are content too.
      expect(new Set(read)).toEqual(new Set(offered));
    }
    expect(asked).toHaveLength(0);
  });

  test("by a name two projects have is not guessed at", async () => {
    const { asked, call } = turn();
    const { outcome, read } = await call({
      kind: "summary",
      project: "이사 준비",
    });
    expect(outcome).toMatchObject({
      ok: false,
      code: "laf:project_ambiguous",
    });
    expect(
      new Set((outcome.projects as Array<{ id: string }>).map((one) => one.id)),
    ).toEqual(new Set([TWIN_A.channel, TWIN_B.channel]));
    expect(new Set(read)).toEqual(new Set([TWIN_A.channel, TWIN_B.channel]));
    expect(asked).toHaveLength(0);
  });

  test("of a project nothing was said in costs nothing and says so", async () => {
    const { asked, call } = turn();
    const { outcome, read } = await call({
      kind: "summary",
      project: EMPTY.channel,
    });
    expect(outcome).toMatchObject({
      ok: true,
      project: EMPTY.channel,
      empty: true,
    });
    expect(outcome.summary).toBeUndefined();
    expect(read).toEqual([EMPTY.channel]);
    expect(asked).toHaveLength(0);
  });

  test.each([
    ["no model is configured to write one", { summarize: null }],
    ["the day's budget is spent", { isSpent: true }],
    [
      "the model did not answer",
      {
        summarize: async () => {
          throw new Error("project summary: took too long");
        },
      },
    ],
  ] as const)(
    "is said to be unavailable when %s, and nothing is kept",
    async (_why, options) => {
      const { call, summaries } = turn(options);
      const { outcome, read } = await call({
        kind: "summary",
        project: TRIP.channel,
      });
      expect(outcome).toMatchObject({
        ok: false,
        code: "laf:project_summary_unavailable",
        project: TRIP.channel,
      });
      expect(JSON.stringify(outcome)).not.toContain("애월");
      expect(read).toEqual([TRIP.channel]);
      expect(summaries.get(TRIP.channel)).toBeUndefined();
    },
  );

  test("of a project deleted while the model was writing is handed to nobody and kept nowhere", async () => {
    const GOING = place("going");
    await database.insert(channels).values({
      id: GOING.channel,
      name: "곧 지울 것",
      description: "",
      kind: "project",
    });
    await database
      .insert(channelMemberships)
      .values({ channelId: GOING.channel, userId: ME });
    await database
      .insert(channelAgents)
      .values({ channelId: GOING.channel, agentId: BOT });
    await database.insert(channelThreads).values({
      userId: ME,
      channelId: GOING.channel,
      threadId: GOING.thread,
    });
    await database.insert(lafThreadMessages).values(
      said(GOING.thread, 1, {
        id: "going-said",
        role: "user",
        content: "곧 지울 프로젝트의 말",
      }),
    );
    const { call, summaries } = turn({
      summarize: async () => {
        // The person asks for the deletion while the summary is being written.
        await database
          .update(channels)
          .set({ deletingAt: new Date() })
          .where(eq(channels.id, GOING.channel));
        return "- 곧 지울 프로젝트의 요약";
      },
    });
    const { outcome, read } = await call({
      kind: "summary",
      project: GOING.channel,
    });
    expect(outcome).toMatchObject({
      ok: false,
      code: "laf:project_not_found",
    });
    expect(JSON.stringify(outcome)).not.toContain("곧 지울");
    expect(read).toBeUndefined();
    expect(summaries.get(GOING.channel)).toBeUndefined();

    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, GOING.thread));
    await database.delete(channels).where(eq(channels.id, GOING.channel));
  });

  test("of a conversation longer than it reads says it read the newest part", async () => {
    const LONG = place("tall");
    await database.insert(channels).values({
      id: LONG.channel,
      name: "오래된 프로젝트",
      description: "",
      kind: "project",
    });
    await database
      .insert(channelMemberships)
      .values({ channelId: LONG.channel, userId: ME });
    await database
      .insert(channelAgents)
      .values({ channelId: LONG.channel, agentId: BOT });
    await database.insert(channelThreads).values({
      userId: ME,
      channelId: LONG.channel,
      threadId: LONG.thread,
    });
    await database.insert(lafThreadMessages).values(
      Array.from({ length: PROJECT_SUMMARY_MESSAGES + 2 }, (_, index) =>
        said(LONG.thread, index + 1, {
          id: `tall-${index}`,
          role: "user",
          content: `말 ${index}`,
        }),
      ),
    );
    const { asked, call } = turn();
    const { outcome } = await call({ kind: "summary", project: LONG.channel });
    expect(outcome).toMatchObject({ ok: true, partial: true });
    expect(typeof outcome.note).toBe("string");
    // The newest are read; the two oldest are not.
    expect(asked[0]?.transcript).toContain(
      `말 ${PROJECT_SUMMARY_MESSAGES + 1}`,
    );
    expect(asked[0]?.transcript).not.toMatch(/말 0(\n|$)/u);

    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, LONG.thread));
    await database.delete(channels).where(eq(channels.id, LONG.channel));
  });
});

describe("a call that does not say which reading", () => {
  test.each([
    [{}, "projects"],
    [{ kind: "" }, "projects"],
    [{ kind: null }, "projects"],
    [{ terms: word("숙소") }, "hits"],
    [{ project: "제주 여행" }, "summary"],
  ] as const)(
    "%j is read by what it carries, not refused",
    async (args, holds) => {
      const { call } = turn();
      const { outcome } = await call(args);
      expect(outcome.ok).toBe(true);
      expect(outcome).toHaveProperty(holds);
    },
  );
});

describe("what the tool hands over", () => {
  test("another tool's name is not carried out here", async () => {
    const { toolkit } = turn();
    expect(
      await toolkit.execute("mcp__projects__write", {}, { id: "x" }),
    ).toMatchObject({ ok: false, code: "laf:tool_unknown" });
  });

  test("is never long enough to be filed as a file in the Bot's folder", async () => {
    const { call } = turn();
    for (const args of [
      { kind: "list" },
      { kind: "search", terms: word("숙소") },
      { kind: "summary", project: TRIP.channel },
    ]) {
      const { outcome } = await call(args);
      expect(JSON.stringify(outcome).length).toBeLessThan(TOOL_RESULT_CUT / 4);
    }
  });
});
