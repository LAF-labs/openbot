import { describe, expect, test } from "bun:test";
import { ACCOUNT_FIRST_TASKS } from "../src/lib/agents/first-tasks";
import {
  BRIEFING_ACCOUNT_TASKS,
  BRIEFING_MAX_PLACES,
  BRIEFING_SKILL,
  type BriefingConnections,
  type BriefingSection,
  briefingContents,
  briefingInstruction,
  briefingSections,
  type Translate,
} from "../src/lib/agents/morning-briefing";
import { ko } from "../src/lib/i18n-ko";
import { BUSINESS_SITES } from "../src/lib/sites/catalogue";

/**
 * 아침 브리핑: which sections a Bot's reach puts in it, the instruction and the chip's line they
 * become, and that every word of both has Korean.
 *
 * Both texts are built through `t(variable)`, which `i18n-coverage.test.ts` cannot see, so the keys
 * are collected here by running the composition with a translator that writes down what it is asked.
 */

const overview = (
  sites: Array<[string, string]> = [],
  accounts: Array<[string, string]> = [],
): BriefingConnections => ({
  sites: sites.map(([id, status]) => ({ id, status })),
  accounts: accounts.map(([id, status]) => ({
    kind: "oauth",
    id,
    status,
    title: id === "cafe24" ? "Cafe24" : "Google Business Profile",
  })),
});

/** The app's `t()` in Korean, whatever language the test runner's navigator claims. */
const korean: Translate = (source, params) => {
  let text = ko[source] ?? source;
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
};

const kinds = (sections: readonly BriefingSection[]) =>
  sections.map((section) =>
    section.kind === "site" || section.kind === "account"
      ? `${section.kind}:${section.id}`
      : section.kind,
  );

describe("what the briefing holds", () => {
  test("with nothing connected: the weather, and 지원사업 only where the Bot holds the tool", () => {
    expect(
      kinds(briefingSections(overview(), { supportPrograms: false })),
    ).toEqual(["weather"]);
    expect(
      kinds(briefingSections(overview(), { supportPrograms: true })),
    ).toEqual(["weather", "support"]);
  });

  test("the calendar and the mail only while their accounts say connected", () => {
    const connected = overview(
      [],
      [
        ["google-calendar", "connected"],
        ["gmail", "connected"],
      ],
    );
    expect(
      kinds(briefingSections(connected, { supportPrograms: false })),
    ).toEqual(["weather", "calendar", "mail"]);
    const lapsed = overview(
      [],
      [
        ["google-calendar", "needs_reconnect"],
        ["gmail", "not_connected"],
      ],
    );
    expect(kinds(briefingSections(lapsed, { supportPrograms: false }))).toEqual(
      ["weather"],
    );
  });

  test("a site only while its session is signed in, and never one a certificate signs into", () => {
    const sections = briefingSections(
      overview([
        ["baemin-ceo", "connected"],
        ["naver-smartplace", "needs_login"],
        ["coupang-wing", "not_connected"],
        ["hometax", "connected"],
      ]),
      { supportPrograms: false },
    );
    expect(kinds(sections)).toEqual(["weather", "site:baemin-ceo"]);
    const baemin = BUSINESS_SITES.find((site) => site.id === "baemin-ceo");
    expect(sections[1]).toEqual({
      kind: "site",
      id: "baemin-ceo",
      name: baemin?.name ?? "",
      task: baemin?.prompts[0] ?? "",
    });
  });

  test("the order and review accounts, with their first task; a spreadsheet has no morning news", () => {
    const sections = briefingSections(
      overview(
        [],
        [
          ["cafe24", "connected"],
          ["google-business-profile", "connected"],
          ["google-sheets", "connected"],
          ["notion", "connected"],
        ],
      ),
      { supportPrograms: false },
    );
    expect(kinds(sections)).toEqual([
      "weather",
      "account:cafe24",
      "account:google-business-profile",
    ]);
    for (const [id, task] of Object.entries(BRIEFING_ACCOUNT_TASKS)) {
      // The account's own first task, word for word — one sentence for one kind of work.
      expect(task).toBe(ACCOUNT_FIRST_TASKS[id]?.sentence ?? "");
    }
  });

  test("at most three places, in the catalogue's order, with 지원사업 still last", () => {
    const everything = overview(
      BUSINESS_SITES.map((site) => [site.id, "connected"]),
      [
        ["cafe24", "connected"],
        ["google-business-profile", "connected"],
        ["gmail", "connected"],
        ["google-calendar", "connected"],
      ],
    );
    const sections = briefingSections(everything, { supportPrograms: true });
    const places = sections.filter(
      (section) => section.kind === "site" || section.kind === "account",
    );
    expect(places).toHaveLength(BRIEFING_MAX_PLACES);
    const signedInSites = BUSINESS_SITES.filter(
      (site) => site.handoff === "login",
    );
    expect(kinds(places)).toEqual(
      signedInSites
        .slice(0, BRIEFING_MAX_PLACES)
        .map((site) => `site:${site.id}`),
    );
    expect(kinds(sections).slice(0, 3)).toEqual([
      "weather",
      "calendar",
      "mail",
    ]);
    expect(sections.at(-1)).toEqual({ kind: "support" });
  });
});

describe("what the routine is told", () => {
  test("names the skill and lists the sections, one line each, in Korean", () => {
    const instruction = briefingInstruction(
      briefingSections(overview(), { supportPrograms: true }),
      korean,
    );
    expect(instruction).toBe(
      [
        `/${BRIEFING_SKILL} 스킬대로 오늘 아침 브리핑을 한 메시지로 보내 줘:`,
        "- 오늘 날씨",
        "- 오늘이 월요일이면: 새 지원사업 (기업마당)",
      ].join("\n"),
    );
  });

  test("a connected place is its name and its first task", () => {
    const instruction = briefingInstruction(
      briefingSections(
        overview([["naver-smartstore", "connected"]], [["gmail", "connected"]]),
        { supportPrograms: false },
      ),
      korean,
    );
    expect(instruction.split("\n")).toEqual([
      `/${BRIEFING_SKILL} 스킬대로 오늘 아침 브리핑을 한 메시지로 보내 줘:`,
      "- 오늘 날씨",
      "- 답 안 한 메일 (Gmail)",
      "- 네이버 스마트스토어 판매자센터: 오늘 들어온 주문 목록을 정리해줘",
    ]);
  });

  test("the chip says the same sections in a few words each", () => {
    const sections = briefingSections(
      overview([], [["google-calendar", "connected"]]),
      { supportPrograms: true },
    );
    expect(briefingContents(sections, korean)).toBe(
      "날씨, 오늘 일정, 월요일마다 새 지원사업",
    );
  });
});

describe("the words", () => {
  /** Brand names the 연결 screen draws as they are, through the same `t()`. */
  const SAME_IN_KOREAN = new Set(["Cafe24"]);

  test("every key either text can ask for has Korean", () => {
    const asked = new Set<string>();
    const recording: Translate = (source, params) => {
      asked.add(source);
      return korean(source, params);
    };
    const everything = overview(
      BUSINESS_SITES.map((site) => [site.id, "connected"]),
      [
        ["cafe24", "connected"],
        ["google-business-profile", "connected"],
        ["gmail", "connected"],
        ["google-calendar", "connected"],
      ],
    );
    // Every site in turn as the only one, so the cap does not hide the ones past the third.
    const layouts: BriefingConnections[] = [
      everything,
      ...BUSINESS_SITES.map((site) => overview([[site.id, "connected"]])),
    ];
    for (const layout of layouts) {
      const sections = briefingSections(layout, { supportPrograms: true });
      briefingInstruction(sections, recording);
      briefingContents(sections, recording);
    }
    const missing = [...asked].filter(
      (key) => !SAME_IN_KOREAN.has(key) && !ko[key],
    );
    expect(missing).toEqual([]);
    // The fixed keys, the account titles and tasks, and every login site's name and first task.
    expect(asked.size).toBeGreaterThan(30);
  });
});
