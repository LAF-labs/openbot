import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ACCOUNT_FIRST_TASKS,
  FIRST_TASK_COUNT,
  FIRST_TASK_PRESSED,
  type FirstTask,
  type FirstTaskPressed,
  isFirstConversation,
  MORNING_REPORT_TIME,
  makeMorningReport,
  morningReportPayload,
  NO_CONNECTION_TASKS,
  pickFirstTasks,
  reportFirstTaskPressed,
  roleHint,
  routineSentence,
} from "../src/lib/agents/first-tasks";
import {
  AGENT_PRESETS,
  WORK_PATTERNS,
  type WorkPatternId,
} from "../src/lib/agents/presets";
import type { ChannelSummary } from "../src/lib/channels/queries";
import type {
  ConnectionsOverview,
  OauthAccount,
  OverviewSite,
} from "../src/lib/connections/queries";
import { ko } from "../src/lib/i18n-ko";
import { CATALOGUE_COPY } from "../src/lib/plugins/catalogue-copy";
import { BUSINESS_SITES } from "../src/lib/sites/catalogue";
import { stubFetch } from "./support/fetch";

/**
 * The first-task chips: which sentences are offered for which connection state and which role,
 * when they are offered at all, what the routine chip sends, what a press reports, and that every
 * word of it has Korean in the owner's register.
 *
 * The chips are read through `t(task.sentence)`, which `i18n-coverage.test.ts` cannot see, so the
 * tables are walked here the way `agent-presets.test.ts` walks the presets. The selection is a pure
 * function of the overview and the hint, so the connection states are a table too.
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
const holidays = generic("schedule");
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
    hint?: WorkPatternId;
    expected: unknown[];
  }[] = [
    {
      name: "nothing connected: four sentences that need nothing, then the way to connect",
      state: overview(),
      expected: [
        ask(holidays),
        ask(introductions),
        ask(opening),
        ask(refund),
        { kind: "connect" },
      ],
    },
    {
      name: "nothing connected and a role: that kind of work leads, the rest keep their order",
      state: overview(),
      hint: "settlement",
      expected: [
        ask(generic("settlement")),
        ask(holidays),
        ask(introductions),
        ask(opening),
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
        ask(holidays),
        ask(opening),
        ask(refund),
      ],
    },
    {
      name: "a role already spoken for by a connected site does not get a second chip",
      state: overview([site("naver-smartplace")]),
      hint: "reputation",
      expected: [
        ask(firstPrompt("naver-smartplace"), {
          kind: "site",
          id: "naver-smartplace",
        }),
        ask(holidays),
        ask(opening),
        ask(refund),
      ],
    },
    {
      name: "a site that needs a login again is not offered at all",
      state: overview([site("naver-smartplace", "needs_login")]),
      expected: [
        ask(holidays),
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
        ask(holidays),
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
        ask(holidays),
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
        ask(holidays),
        ask(introductions),
        ask(opening),
        ask(refund),
        { kind: "connect" },
      ],
    },
  ];

  for (const { name, state, hint, expected } of cases) {
    test(name, () => {
      // `unknown`: the expectation mixes matchers and literals, which `toEqual<FirstTask[]>` refuses.
      expect(pickFirstTasks(state, { hint }) as unknown).toEqual(expected);
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
      holidays,
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

  test("a role moves its connected site to the front of the same set", () => {
    const state = overview([site("hometax"), site("naver-smartstore")]);
    const tasks = pickFirstTasks(state, { hint: "paperwork" });
    expect(sentencesOf(tasks).slice(0, 2)).toEqual([
      firstPrompt("hometax"),
      firstPrompt("naver-smartstore"),
    ]);
    // The same four sentences either way; only the order answers to the hint.
    expect(new Set(sentencesOf(tasks))).toEqual(
      new Set(sentencesOf(pickFirstTasks(state))),
    );
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

describe("the role hint", () => {
  test("an empty card says nothing", () => {
    expect(roleHint({ title: "", roleDescription: "" })).toBeNull();
    expect(roleHint({ title: "  ", roleDescription: "" })).toBeNull();
  });

  test("every preset is recognised by its Korean title, its English title, or its role", () => {
    for (const preset of AGENT_PRESETS) {
      const korean = ko[preset.title] ?? "";
      expect(korean).not.toBe("");
      expect(roleHint({ title: korean, roleDescription: "" })).toBe(
        preset.pattern,
      );
      expect(roleHint({ title: preset.title, roleDescription: "" })).toBe(
        preset.pattern,
      );
      expect(
        roleHint({
          title: "",
          roleDescription: ko[preset.roleDescription] ?? "",
        }),
      ).toBe(preset.pattern);
    }
  });

  test("a card written by hand is read by its words", () => {
    const cases: [string, WorkPatternId | null][] = [
      ["리뷰 답변 담당", "reputation"],
      ["매일 아침 정산 확인", "settlement"],
      ["손님 문의 응대", "enquiries"],
      ["예약 관리", "schedule"],
      ["재고 확인과 발주", "stock"],
      ["세금계산서와 영수증 정리", "paperwork"],
      ["밤새 주문 지켜보기", "night-watch"],
      ["나가기 전에 검토", "approval"],
      ["Reviews and replies", "reputation"],
      ["커피 잘 내리기", null],
    ];
    for (const [title, expected] of cases) {
      expect(roleHint({ title, roleDescription: "" })).toBe(expected);
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
  test("one browser event, carrying the key and never typed text", () => {
    const target = new EventTarget();
    const seen: FirstTaskPressed[] = [];
    target.addEventListener(FIRST_TASK_PRESSED, (event) => {
      seen.push((event as CustomEvent<FirstTaskPressed>).detail);
    });
    const detail: FirstTaskPressed = {
      agentId: "bot-1",
      kind: "ask",
      pattern: "schedule",
      sentence: holidays,
      via: null,
      hint: null,
    };
    reportFirstTaskPressed(detail, target);
    expect(seen).toEqual([detail]);
    expect(JSON.stringify(seen)).not.toContain(ko[holidays] ?? " ");
  });

  test("nowhere to report to is not an error", () => {
    expect(() =>
      reportFirstTaskPressed(
        {
          agentId: "bot-1",
          kind: "connect",
          pattern: null,
          sentence: null,
          via: null,
          hint: null,
        },
        null,
      ),
    ).not.toThrow();
  });
});

describe("the routine chip", () => {
  test("repeats the first sentence that asks something", () => {
    expect(routineSentence(pickFirstTasks(overview()))).toBe(holidays);
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
      "Get a report every morning at 7:30",
      "The first sentence above, asked every morning at 7:30, answered in this conversation.",
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
    ].map((task) => task.sentence)) {
      expect(ko[sentence]).toMatch(/줘$/);
    }
  });
});
