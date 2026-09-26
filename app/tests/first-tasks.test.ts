import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseFirstTaskPress } from "../../server/src/agents/first-task";
import {
  ACCOUNT_FIRST_TASKS,
  COMPUTER_FIRST_TASK,
  FIRST_TASK_COUNT,
  FIRST_TASK_PRESSED,
  type FirstTask,
  type FirstTaskPressed,
  firstTaskPressBody,
  holdsSupportPrograms,
  isFirstConversation,
  MORNING_REPORT_TIME,
  makeMorningReport,
  morningReportPayload,
  NO_CONNECTION_TASKS,
  pickFirstTasks,
  reportFirstTaskPressed,
  routineSentence,
  SUPPORT_PROGRAMS_FIRST_TASK,
  SUPPORT_PROGRAMS_TOOL,
} from "../src/lib/agents/first-tasks";
import {
  WORK_PATTERNS,
  type WorkPatternId,
} from "../src/lib/agents/work-patterns";
import type { ChannelSummary } from "../src/lib/channels/queries";
import type {
  ConnectionsOverview,
  OauthAccount,
  OverviewSite,
} from "../src/lib/connections/queries";
import { ko } from "../src/lib/i18n-ko";
import { CATALOGUE_COPY } from "../src/lib/plugins/catalogue-copy";
import { BUSINESS_KINDS } from "../src/lib/shop/catalogue";
import { BUSINESS_SITES } from "../src/lib/sites/catalogue";
import { stubFetch } from "./support/fetch";

/**
 * The first-task chips: which sentences are offered for which connection state and which role,
 * when they are offered at all, what the routine chip sends, what a press reports, and that every
 * word of it has Korean in the owner's register.
 *
 * The chips are read through `t(task.sentence)`, which `i18n-coverage.test.ts` cannot see, so the
 * tables are walked here. The selection is a pure function of the overview and the shop, so the
 * connection states are a table too.
 */

const site = (
  id: string,
  status: OverviewSite["status"] = "connected",
): OverviewSite => ({
  id,
  status,
  botId: status === "not_connected" ? null : "bot-1",
  lastSeenAt: null,
  connectedAt: status === "connected" ? "2026-09-06T00:00:00.000Z" : null,
});

const account = (
  id: string,
  status: OauthAccount["status"] = "connected",
): OauthAccount => ({
  kind: "oauth",
  id,
  serverId: null,
  title: id,
  vendor: id,
  status,
  connectedAt: null,
  account: null,
  needsInstanceName: false,
  health: {
    status: status === "needs_reconnect" ? "needs_reconnect" : "ok",
    lastOkAt: null,
    lastFailureAt: null,
    failureCode: null,
  },
});

const overview = (
  sites: OverviewSite[] = [],
  accounts: ConnectionsOverview["accounts"] = [],
): Pick<ConnectionsOverview, "sites" | "accounts"> => ({ sites, accounts });

const ask = (
  sentence: string,
  via: Extract<FirstTask, { kind: "ask" }>["via"] = null,
) => expect.objectContaining({ kind: "ask", sentence, via });

/** The connection-free table by pattern, so a case can name a sentence by the work it is. */
const generic = (pattern: WorkPatternId): string => {
  const found = NO_CONNECTION_TASKS.find((task) => task.pattern === pattern);
  if (!found) throw new Error(`no connection-free sentence for ${pattern}`);
  return found.sentence;
};
const weather = generic("schedule");
const introductions = generic("reputation");
const opening = generic("night-watch");
const refund = generic("enquiries");

const firstPrompt = (id: string): string => {
  const entry = BUSINESS_SITES.find((known) => known.id === id);
  if (!entry?.prompts[0]) throw new Error(`no first prompt for ${id}`);
  return entry.prompts[0];
};

const sentencesOf = (tasks: readonly FirstTask[]) =>
  tasks.map((task) => (task.kind === "ask" ? task.sentence : "connect"));

describe("which chips are offered", () => {
  const cases: {
    name: string;
    state: Pick<ConnectionsOverview, "sites" | "accounts">;
    expected: unknown[];
  }[] = [
    {
      name: "nothing connected: four sentences that need nothing, then the way to connect",
      state: overview(),
      expected: [
        ask(weather),
        ask(introductions),
        ask(opening),
        ask(refund),
        { kind: "connect" },
      ],
    },
    {
      name: "one connected site: its first prompt leads, padded with OTHER kinds of work",
      state: overview([site("naver-smartplace")]),
      // 스마트플레이스 is reviews, so the reviews sentence (소개 문구) is not one of the padding.
      expected: [
        ask(firstPrompt("naver-smartplace"), {
          kind: "site",
          id: "naver-smartplace",
        }),
        ask(weather),
        ask(opening),
        ask(refund),
      ],
    },
    {
      name: "a site that needs a login again is not offered at all",
      state: overview([site("naver-smartplace", "needs_login")]),
      expected: [
        ask(weather),
        ask(introductions),
        ask(opening),
        ask(refund),
        { kind: "connect" },
      ],
    },
    {
      name: "a site the Bot has never been signed into is not offered either",
      state: overview([site("baemin-ceo", "not_connected")]),
      expected: [
        ask(weather),
        ask(introductions),
        ask(opening),
        ask(refund),
        { kind: "connect" },
      ],
    },
    {
      name: "a connected account leads; one that needs reconnecting does not appear",
      state: overview(
        [],
        [account("gmail"), account("google-calendar", "needs_reconnect")],
      ),
      expected: [
        ask(ACCOUNT_FIRST_TASKS.gmail?.sentence ?? "", {
          kind: "account",
          id: "gmail",
        }),
        ask(weather),
        ask(introductions),
        ask(opening),
      ],
    },
    {
      name: "a partner account is not a first task",
      state: overview(
        [],
        [
          {
            kind: "partner",
            id: "kakao-alimtalk",
            status: "connected",
            partner: {
              status: {
                isConfigured: true,
                connected: true,
                searchId: "@laf",
                connectedAt: "2026-09-06T00:00:00.000Z",
                templates: [],
              },
            },
          },
        ],
      ),
      expected: [
        ask(weather),
        ask(introductions),
        ask(opening),
        ask(refund),
        { kind: "connect" },
      ],
    },
  ];

  for (const { name, state, expected } of cases) {
    test(name, () => {
      // `unknown`: the expectation mixes matchers and literals, which `toEqual<FirstTask[]>` refuses.
      expect(pickFirstTasks(state) as unknown).toEqual(expected);
    });
  }

  test("the same shop through two doors is one sentence, not two", () => {
    // The cafe24 site and the cafe24 account share a first prompt; whichever door comes first in
    // the pattern order, the sentence is offered once and the padding is three other kinds of work.
    const tasks = pickFirstTasks(
      overview([site("cafe24-admin")], [account("cafe24")]),
    );
    expect(sentencesOf(tasks)).toEqual([
      firstPrompt("cafe24-admin"),
      weather,
      introductions,
      opening,
    ]);
  });

  test("with plenty connected there are exactly four, one kind of work each", () => {
    // Three reviews sites and two order sites: the chips must not all be reviews.
    const tasks = pickFirstTasks(
      overview(
        [
          site("naver-smartplace"), // reputation
          site("baemin-ceo"), // reputation
          site("daangn-business"), // reputation
          site("naver-smartstore"), // enquiries
          site("coupang-wing"), // enquiries
          site("naver-booking-talk"), // schedule
          site("hometax"), // paperwork
        ],
        [account("google-business-profile")], // reputation
      ),
    );
    expect(tasks).toHaveLength(FIRST_TASK_COUNT);
    expect(tasks.every((task) => task.kind === "ask")).toBe(true);
    const patterns = tasks.map((task) =>
      task.kind === "ask" ? task.pattern : "connect",
    );
    expect(new Set(patterns).size).toBe(FIRST_TASK_COUNT);
    // Nothing that needs no connection when four connected sentences are available.
    for (const task of tasks) {
      if (task.kind === "ask") expect(task.via).not.toBeNull();
    }
  });

  test("the order follows the work patterns, so the chips do not move between reloads", () => {
    const state = overview([
      site("hometax"), // paperwork, last in the pattern order
      site("naver-smartstore"), // enquiries, earlier
    ]);
    const first = pickFirstTasks(state);
    expect(sentencesOf(first).slice(0, 2)).toEqual([
      firstPrompt("naver-smartstore"),
      firstPrompt("hometax"),
    ]);
    expect(pickFirstTasks(state)).toEqual(first);
  });

  test("the connect chip is offered only when nothing is connected", () => {
    expect(
      pickFirstTasks(overview([site("yogiyo-ceo")])).some(
        (task) => task.kind === "connect",
      ),
    ).toBe(false);
    expect(
      pickFirstTasks(overview()).filter((task) => task.kind === "connect"),
    ).toHaveLength(1);
  });

  test("the count is four to six pressable things, every state", () => {
    for (const state of [
      overview(),
      overview([site("baemin-ceo")]),
      overview([site("baemin-ceo"), site("hometax"), site("naver-smartstore")]),
    ]) {
      const tasks = pickFirstTasks(state);
      // Plus the routine chip drawn beside them: 5 or 6 on screen.
      expect(tasks.length).toBeGreaterThanOrEqual(FIRST_TASK_COUNT);
      expect(tasks.length).toBeLessThanOrEqual(FIRST_TASK_COUNT + 1);
    }
  });
});

describe("whether the chips are shown at all", () => {
  const channel = (
    agentIds: string[],
    lastMessageAt: string | null,
  ): Pick<ChannelSummary, "agentIds" | "lastMessageAt"> => ({
    agentIds,
    lastMessageAt,
  });

  test("a Bot nobody has spoken to gets them", () => {
    expect(isFirstConversation([], "bot-1")).toBe(true);
    expect(
      isFirstConversation([channel(["bot-2"], "2026-09-06")], "bot-1"),
    ).toBe(true);
  });

  test("a Bot with a message behind it does not", () => {
    expect(
      isFirstConversation(
        [channel(["bot-1"], "2026-09-06T00:00:00Z")],
        "bot-1",
      ),
    ).toBe(false);
    // In a room with others counts too: the Bot has been spoken to.
    expect(
      isFirstConversation(
        [channel(["bot-2", "bot-1"], "2026-09-06T00:00:00Z")],
        "bot-1",
      ),
    ).toBe(false);
  });

  test("a channel with nothing said in it is not a conversation yet", () => {
    expect(isFirstConversation([channel(["bot-1"], null)], "bot-1")).toBe(true);
  });
});

describe("what a press reports", () => {
  test("one browser event carrying the key, and one request carrying no sentence at all", async () => {
    const target = new EventTarget();
    const seen: FirstTaskPressed[] = [];
    target.addEventListener(FIRST_TASK_PRESSED, (event) => {
      seen.push((event as CustomEvent<FirstTaskPressed>).detail);
    });
    const sent: { url: string; init: RequestInit }[] = [];
    const detail: FirstTaskPressed = {
      agentId: "bot-1",
      kind: "ask",
      pattern: "schedule",
      sentence: weather,
      via: { kind: "site", id: "naver-smartplace" },
      hint: "schedule",
    };
    reportFirstTaskPressed(detail, target, async (url, init) => {
      sent.push({ url, init });
      return new Response(null, { status: 204 });
    });
    await Promise.resolve();

    expect(seen).toEqual([detail]);
    expect(JSON.stringify(seen)).not.toContain(ko[weather] ?? "\x00");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("/api/me/first-task");
    expect(sent[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      agentId: "bot-1",
      kind: "ask",
      pattern: "schedule",
      via: { kind: "site", id: "naver-smartplace" },
      hint: "schedule",
    });
    // Neither the key nor its Korean: the keys beside it already name the sentence exactly.
    expect(String(sent[0]?.init.body)).not.toContain(weather);
    expect(String(sent[0]?.init.body)).not.toContain(ko[weather] ?? "\x00");
    expect(firstTaskPressBody(detail)).not.toHaveProperty("sentence");
  });

  test("nowhere to report to, and a server that cannot be reached, are not errors", async () => {
    const connect: FirstTaskPressed = {
      agentId: "bot-1",
      kind: "connect",
      pattern: null,
      sentence: null,
      via: null,
      hint: null,
    };
    expect(() =>
      reportFirstTaskPressed(connect, null, async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).not.toThrow();
    expect(() =>
      reportFirstTaskPressed(connect, null, () => {
        throw new TypeError("thrown before a promise existed");
      }),
    ).not.toThrow();
    // Let both rejections settle: an unhandled one would fail the run from here.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  /*
   * THE TETHER TO THE SERVER. The route checks every field against the catalogue it names
   * (`server/src/agents/first-task.ts`), and a chip the screen can draw that the route refuses is a
   * press that silently never counts — a green chip test and a zero on every VM. So every chip
   * `pickFirstTasks` can produce, with everything or nothing connected, is put
   * through the route's own parser.
   */
  test("every chip the screen can draw is a press the server accepts", () => {
    const everything = overview(
      BUSINESS_SITES.map((known) => site(known.id)),
      Object.keys(ACCOUNT_FIRST_TASKS).map((id) => account(id)),
    );
    const agentId = "agent_1f2e3d4c-aaaa-4bbb-8ccc-123456789abc";
    let checked = 0;
    for (const connected of [overview(), everything]) {
      // With the 지원사업 chip on the row: its `via` names the public-data entry, and must count.
      const tasks = pickFirstTasks(connected, {
        count: 64,
        supportPrograms: true,
      });
      const leading = tasks.find((task) => task.kind === "ask");
      const presses: FirstTaskPressed[] = tasks.map((task) =>
        task.kind === "connect"
          ? {
              agentId,
              kind: "connect",
              pattern: null,
              sentence: null,
              via: null,
              hint: null,
            }
          : {
              agentId,
              kind: "ask",
              pattern: task.pattern,
              sentence: task.sentence,
              via: task.via,
              hint: null,
            },
      );
      if (leading?.kind === "ask") {
        presses.push({
          agentId,
          kind: "routine",
          pattern: leading.pattern,
          sentence: leading.sentence,
          via: leading.via,
          hint: null,
        });
      }
      for (const press of presses) {
        const parsed = parseFirstTaskPress(firstTaskPressBody(press));
        expect([press.kind, press.pattern, press.via, parsed.ok]).toEqual([
          press.kind,
          press.pattern,
          press.via,
          true,
        ]);
        checked += 1;
      }
    }
    // Thirty-eight measured 2026-09-24: every chip, with nothing and with everything connected. It was
    // over a hundred while the same set was walked once per role hint, which went with the role.
    expect(checked).toBeGreaterThan(30);
  });
});

describe("the routine chip", () => {
  test("repeats the first sentence that asks something", () => {
    expect(routineSentence(pickFirstTasks(overview()))).toBe(weather);
    expect(
      routineSentence(pickFirstTasks(overview([site("baemin-ceo")]))),
    ).toBe(firstPrompt("baemin-ceo"));
    expect(routineSentence([{ kind: "connect" }])).toBeNull();
  });

  test("builds the body the Routines page would: daily at 07:30 in the person's zone, nothing else", () => {
    const payload = morningReportPayload({
      agentId: "bot-1",
      name: "아침 보고",
      instruction: "오늘 날짜와 이번 주 공휴일 알려줘",
      timeZone: "Asia/Seoul",
    });
    expect(payload).toEqual({
      agentId: "bot-1",
      name: "아침 보고",
      instruction: "오늘 날짜와 이번 주 공휴일 알려줘",
      schedule: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
    });
    expect(MORNING_REPORT_TIME).toBe("07:30");
    // No day restriction (the server refuses an empty one) and no webhook fields of any kind.
    expect(Object.keys(payload.schedule)).toEqual(["kind", "time", "timeZone"]);
    expect(JSON.stringify(payload)).not.toContain("trigger");
  });

  describe("on the wire", () => {
    const realFetch = globalThis.fetch;
    let seen: { url: string; init?: RequestInit } | null = null;

    beforeEach(() => {
      seen = null;
      globalThis.fetch = stubFetch(async (url, init) => {
        seen = { url: String(url), init: init as RequestInit };
        return new Response(JSON.stringify({ routine: { id: "routine-1" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      });
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test("goes to the existing POST /api/routines with the payload as JSON", async () => {
      const body = await makeMorningReport({
        agentId: "bot-1",
        name: "아침 보고",
        instruction: "이번 주에 달린 리뷰를 정리해줘",
        timeZone: "Asia/Seoul",
      });
      expect(body).toEqual({ routine: { id: "routine-1" } });
      expect(seen?.url).toBe("/api/routines");
      expect(seen?.init?.method).toBe("POST");
      expect(seen?.init?.credentials).toBe("include");
      expect(JSON.parse(String(seen?.init?.body))).toEqual({
        agentId: "bot-1",
        name: "아침 보고",
        instruction: "이번 주에 달린 리뷰를 정리해줘",
        schedule: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
      });
    });
  });
});

describe("the words", () => {
  const sentences = [
    ...NO_CONNECTION_TASKS.map((task) => task.sentence),
    ...Object.values(ACCOUNT_FIRST_TASKS).map((task) => task.sentence),
    SUPPORT_PROGRAMS_FIRST_TASK.sentence,
    ...BUSINESS_SITES.map((entry) => entry.prompts[0] ?? ""),
  ];

  test("every sentence a chip can say has Korean", () => {
    expect(sentences.filter((sentence) => !(sentence in ko))).toEqual([]);
  });

  test("there is a connection-free sentence for every one of the eight, once", () => {
    const patterns = NO_CONNECTION_TASKS.map((task) => task.pattern);
    expect([...patterns].sort()).toEqual(
      WORK_PATTERNS.map((pattern) => pattern.id).sort(),
    );
  });

  test("every site has a first prompt, so a connected site is never a blank chip", () => {
    expect(
      BUSINESS_SITES.filter((entry) => !entry.prompts[0]).map((e) => e.id),
    ).toEqual([]);
  });

  test("every account sentence is keyed by a connector the 연결 screen knows", () => {
    const unknown = Object.keys(ACCOUNT_FIRST_TASKS).filter(
      (key) => !(key in CATALOGUE_COPY),
    );
    expect(unknown).toEqual([]);
  });

  test("every pattern named is one of the eight", () => {
    const known = new Set(WORK_PATTERNS.map((pattern) => pattern.id));
    for (const task of [
      ...NO_CONNECTION_TASKS,
      ...Object.values(ACCOUNT_FIRST_TASKS),
      SUPPORT_PROGRAMS_FIRST_TASK,
    ]) {
      expect(known.has(task.pattern)).toBe(true);
    }
  });

  test("they speak the owner's vocabulary", () => {
    /*
     * The same words `owner-vocabulary.test.ts` forbids. That walk reads the presets and the site
     * catalogue but not this table, so the check is repeated here for the sentences it cannot see.
     */
    const forbidden = [
      "에이전트",
      "코워커",
      "어시스턴트",
      "스레드",
      "엔드포인트",
      "AG-UI",
      "MCP",
      "게이트웨이",
      "경계",
      "토큰",
      "플러그인",
      "컴포넌트",
    ];
    const screen = [
      "Try one of these first",
      "Connect a site",
      "Get “{task}” every morning at 7:30",
      "Your Bot is asked this every morning at 7:30 and answers in this conversation.",
      "Morning report",
      "Making the routine…",
      "The routine is made.",
      "See it on Routines",
    ];
    const offences: string[] = [];
    for (const key of [...sentences, ...screen]) {
      const korean = ko[key] ?? "";
      expect(korean).not.toBe("");
      for (const word of forbidden) {
        if (korean.includes(word)) offences.push(`${word}: ${korean}`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("a chip is a request a person could have typed, so it ends the way they ask", () => {
    // 줘 is how the catalogue's own prompts end; a chip that reads as a heading is not pressable.
    for (const sentence of [
      ...NO_CONNECTION_TASKS,
      ...Object.values(ACCOUNT_FIRST_TASKS),
      SUPPORT_PROGRAMS_FIRST_TASK,
    ].map((task) => task.sentence)) {
      expect(ko[sentence]).toMatch(/줘$/);
    }
  });
});

/*
 * 0.5.3 audit, item 12: with nothing connected, all four chips were writing — the one thing this
 * product does that a chat window does not, going to a site and coming back, was on none of them.
 */
describe("the Bot's computer is on the row", () => {
  const nothing = overview();

  test("with nothing connected, the lookup leads — and it is the one the 7:30 chip repeats", () => {
    const tasks = pickFirstTasks(nothing);
    expect(tasks[0]).toEqual({
      kind: "ask",
      ...COMPUTER_FIRST_TASK,
      via: null,
    });
    expect(routineSentence(tasks)).toBe(COMPUTER_FIRST_TASK.sentence);
    expect(ko[COMPUTER_FIRST_TASK.sentence]).toContain("네이버");
  });

  test("whatever the shop's kind of work puts first, one chip goes out on the computer", () => {
    for (const kind of BUSINESS_KINDS) {
      const tasks = pickFirstTasks(nothing, {
        shop: { kind: kind.id, places: [] },
      });
      expect(
        tasks.some(
          (task) =>
            task.kind === "ask" &&
            task.sentence === COMPUTER_FIRST_TASK.sentence,
        ),
      ).toBe(true);
    }
  });

  test("a connected site already is one, so nothing is swapped out for the lookup", () => {
    const tasks = pickFirstTasks(overview([site("naver-smartplace")]));
    expect(tasks[0]).toEqual(
      ask(firstPrompt("naver-smartplace"), {
        kind: "site",
        id: "naver-smartplace",
      }),
    );
  });
});

/*
 * 지원사업 — the one first task that needs nothing from the person and still returns something no
 * model could write from its own head. Offered only where the Bot holds the 기업마당 tool, second
 * among the sentences that need nothing, and never at the cost of the Bot's computer.
 */
describe("the support-programme chip", () => {
  const support = ask(SUPPORT_PROGRAMS_FIRST_TASK.sentence, {
    kind: "account",
    id: "public-data",
  });
  const hasSupport = (tasks: readonly FirstTask[]) =>
    tasks.some(
      (task) =>
        task.kind === "ask" &&
        task.sentence === SUPPORT_PROGRAMS_FIRST_TASK.sentence,
    );

  test("is not drawn for a Bot that does not hold the tool", () => {
    expect(hasSupport(pickFirstTasks(overview()))).toBe(false);
    expect(
      hasSupport(pickFirstTasks(overview(), { supportPrograms: false })),
    ).toBe(false);
  });

  test("the grant decides, by the tool's own ref", () => {
    expect(holdsSupportPrograms(undefined)).toBe(false);
    expect(holdsSupportPrograms({ tools: [] })).toBe(false);
    expect(
      holdsSupportPrograms({ tools: [{ ref: "public-data/search_bids" }] }),
    ).toBe(false);
    expect(
      holdsSupportPrograms({ tools: [{ ref: SUPPORT_PROGRAMS_TOOL }] }),
    ).toBe(true);
  });

  test("with nothing connected: second, after the lookup, and the row is still four and a link", () => {
    const tasks = pickFirstTasks(overview(), { supportPrograms: true });
    expect(sentencesOf(tasks)).toEqual([
      weather,
      SUPPORT_PROGRAMS_FIRST_TASK.sentence,
      introductions,
      opening,
      "connect",
    ]);
    expect(tasks[1]).toEqual(support);
    // The 7:30 chip repeats the lookup, not a search that answers the same list every morning.
    expect(routineSentence(tasks)).toBe(weather);
  });

  test("whatever the shop's order, it is second among what needs nothing, and the lookup stays", () => {
    for (const kind of BUSINESS_KINDS) {
      const tasks = pickFirstTasks(overview(), {
        shop: { kind: kind.id, places: [] },
        supportPrograms: true,
      });
      const asks = tasks.filter((task) => task.kind === "ask");
      expect(asks).toHaveLength(FIRST_TASK_COUNT);
      expect(asks[1]).toEqual(support);
      expect(
        asks.some((task) => task.sentence === COMPUTER_FIRST_TASK.sentence),
      ).toBe(true);
    }
  });

  test("a connected sentence still comes first, and nothing connected is displaced", () => {
    const tasks = pickFirstTasks(overview([site("naver-smartplace")]), {
      supportPrograms: true,
    });
    const asks = tasks.filter((task) => task.kind === "ask");
    expect(asks).toHaveLength(FIRST_TASK_COUNT);
    expect(asks[0]).toEqual(
      ask(firstPrompt("naver-smartplace"), {
        kind: "site",
        id: "naver-smartplace",
      }),
    );
    // Second among the padding: the connected sentence, the first padding chip, then this.
    expect(asks[2]).toEqual(support);
    // It connects nothing, so a person with a site connected is not sent to 연결 because of it.
    expect(tasks.some((task) => task.kind === "connect")).toBe(false);
  });

  test("with no room beside the lookup, the lookup keeps its place", () => {
    const accounts = ["gmail", "google-calendar", "google-sheets"].map((id) =>
      account(id),
    );
    const tasks = pickFirstTasks(overview([], accounts), {
      supportPrograms: true,
    });
    const asks = tasks.filter((task) => task.kind === "ask");
    expect(asks).toHaveLength(FIRST_TASK_COUNT);
    expect(asks.map((task) => task.sentence)).toContain(
      COMPUTER_FIRST_TASK.sentence,
    );
    expect(hasSupport(tasks)).toBe(false);
  });
});
