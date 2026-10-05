import { describe, expect, test } from "bun:test";
import { exposeTools } from "../agent-bot/src/deferral";
import {
  ACCOUNTS,
  accountsWith,
  answeredAtOnce,
  asksThePerson,
  type ConnectTurn,
  claimsNothingThere,
  connectCard,
  connectFactsOf,
  connectsAtTheCard,
  DEADLINE_LOOKUP,
  everythingConnected,
  judgeCardOffered,
  judgeNoCard,
  judgeSaysItCouldNot,
  NOTION_SEARCH,
  nothingConnected,
  nothingToRead,
  onlyConnected,
  saysItCouldNot,
  supportNotices,
  TALK_CALENDAR,
  withTheConnectCard,
} from "../evals/connect";
import { REALISTIC_TOOLSET } from "../evals/deferral";
import type { ObservedCall, StreamEvent } from "../evals/lib";
import { CATALOGUE } from "../server/src/plugins/catalogue";
import { toolResultText } from "../shared/prompt/tool-results.ko";
import { BUSINESS_SITES } from "../shared/sites/catalogue";
import {
  describedToolNames,
  FAMILY_LABELS_KO,
  OPEN_ACCOUNTS_HEAD,
  searchResultText,
  serverKeyOf,
  type WireTool,
} from "../shared/tools/bridge";
import {
  accountStatesIn,
  CONNECT_CARD,
  withoutAccountStates,
} from "../shared/tools/gallery";

/**
 * THE JUDGES OF THE CONNECT-CARD SCENARIOS, JUDGED — AND THEIR FIXTURES HELD TO THE PRODUCT.
 *
 * The scenarios call a real model and never run in the gate (`evals/connect.ts`). So a judge that
 * could not fail would pass every model for ever, and a fixture that drifted from what a chat turn
 * hands a Bot would measure a product nobody has. The turns below are the fleet's model's own, from
 * the runs of 2026-10-05 — the lookups it made, the routines it listed on the way, the prose it
 * ended on — and the ways a card can be the wrong card.
 */

type Round = Array<{ name: string; args?: Record<string, unknown> }>;

/** A turn as the stream carries it: each round's calls, then that round's usage. */
function turnOf(rounds: readonly Round[], text = ""): ConnectTurn {
  const calls: ObservedCall[] = [];
  const events: StreamEvent[] = [];
  rounds.forEach((round, at) => {
    round.forEach((call, index) => {
      const id = `call_${at}_${index}`;
      const args = call.args ?? {};
      calls.push({
        id,
        name: call.name,
        rawArguments: JSON.stringify(args),
        arguments: args,
      });
      events.push({
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: call.name,
      });
    });
    events.push({
      type: "CUSTOM",
      name: "laf.model.usage",
      value: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
  });
  return { text, calls, events };
}

const look = (query: string) => ({ name: "tool_search", args: { query } });
const raise = (...services: string[]) => ({
  name: CONNECT_CARD,
  args: { services, reason: "일정을 보려면 연결이 필요해요" },
});
const failed = (conditions: Array<[string, boolean]>) =>
  conditions.filter(([, ok]) => !ok).map(([label]) => label);

describe("a card for a service nobody connected", () => {
  test("passes: one look, then the card for that service", () => {
    const turn = turnOf([
      [look("캘린더 일정 확인")],
      [raise("google-calendar")],
    ]);
    expect(failed(judgeCardOffered(turn, "google-calendar"))).toEqual([]);
    expect(connectFactsOf(turn)).toEqual({
      searches: ["캘린더 일정 확인"],
      offered: ["google-calendar"],
      cards: [["google-calendar"]],
      requestsToTheCard: 2,
      first: CONNECT_CARD,
    });
  });

  test("passes when it listed its routines in the same reply it looked in", () => {
    // 일정 is also this product's word for a routine's schedule; the fleet's model reads it so.
    const turn = turnOf([
      [{ name: "manage_routine", args: { action: "list" } }, look("일정 확인")],
      [raise("google-calendar")],
    ]);
    expect(failed(judgeCardOffered(turn, "google-calendar"))).toEqual([]);
  });

  test("passes with no look at all: the card straight away", () => {
    expect(
      failed(judgeCardOffered(turnOf([[raise("gmail")]]), "gmail")),
    ).toEqual([]);
  });

  test("fails prose and no card — what was measured before", () => {
    const turn = turnOf(
      [
        [look("캘린더 일정 확인")],
        [look("구글 캘린더")],
        [{ name: "manage_routine", args: { action: "list" } }],
        [],
      ],
      "사장님, 연결된 캘린더가 없어서 일정을 볼 수가 없어요.",
    );
    const notes = failed(judgeCardOffered(turn, "google-calendar"));
    expect(notes[0]).toContain("연결 카드(showConnection)를 띄우지 않음");
    expect(notes[0]).toContain("manage_routine");
    expect(notes.join("\n")).toContain(
      '같은 것을 두 번 찾음 — "캘린더 일정 확인" → "구글 캘린더"',
    );
  });

  test("fails a card for another service, and one that puts another first", () => {
    for (const offered of [
      ["gmail"],
      ["kakao-playmcp", "google-calendar"],
      [],
    ]) {
      const notes = failed(
        judgeCardOffered(
          turnOf([[look("일정")], [raise(...offered)]]),
          "google-calendar",
        ),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("google-calendar를 먼저 권하지 않음");
    }
  });

  test("fails a second look, and a card that took a third request", () => {
    const twice = turnOf([
      [look("캘린더 일정 확인")],
      [look("구글 캘린더")],
      [raise("google-calendar")],
    ]);
    expect(failed(judgeCardOffered(twice, "google-calendar"))).toEqual([
      '같은 것을 두 번 찾음 — "캘린더 일정 확인" → "구글 캘린더"',
      "카드까지 모델을 3번 부름 (2번까지)",
    ]);
    const slow = turnOf([
      [look("캘린더 일정 확인")],
      [{ name: "manage_routine", args: { action: "list" } }],
      [raise("google-calendar")],
    ]);
    expect(failed(judgeCardOffered(slow, "google-calendar"))).toEqual([
      "카드까지 모델을 3번 부름 (2번까지)",
    ]);
  });
});

describe("where no card belongs", () => {
  test("passes a turn that raised none and looked once", () => {
    expect(
      failed(judgeNoCard(turnOf([[look("캘린더 일정 확인")], []]))),
    ).toEqual([]);
    expect(failed(judgeNoCard(turnOf([[]])))).toEqual([]);
  });

  test("fails a card, whatever it offers", () => {
    const notes = failed(
      judgeNoCard(
        turnOf([[look("슬랙 메시지 보내기")], [raise("kakao-playmcp")]]),
      ),
    );
    expect(notes).toEqual(["연결 카드를 띄움 — 권한 것: kakao-playmcp"]);
  });

  test("fails a second look for what the first answered", () => {
    const notes = failed(
      judgeNoCard(
        turnOf([
          [look("슬랙 메시지 보내기")],
          [look("select:mcp__slack__post_message")],
          [],
        ]),
      ),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("같은 것을 두 번 찾음");
  });
});

describe("the same thing looked for twice", () => {
  const CALENDAR = /캘린더|일정|calendar|schedule/i;

  test("a lookup for something else on the way is not the calendar looked for again", () => {
    // Asked about 일정, the fleet's model also opens 목표 — a different thing, found by name.
    const turn = turnOf([
      [look("캘린더 일정 확인")],
      [look("select:mcp__goals__list_goals")],
      [raise("google-calendar")],
    ]);
    expect(failed(judgeCardOffered(turn, "google-calendar", CALENDAR))).toEqual(
      ["카드까지 모델을 3번 부름 (2번까지)"],
    );
    expect(
      failed(judgeNoCard(turnOf([[look("일정")], [look("목표")]]), CALENDAR)),
    ).toEqual([]);
    // With nothing said about what the scenario asks for, every lookup counts.
    expect(
      failed(judgeNoCard(turnOf([[look("일정")], [look("목표")]]))),
    ).toHaveLength(1);
  });

  test("a guess at the same service's tool names is", () => {
    const turn = turnOf([
      [look("캘린더 일정 확인")],
      [
        look(
          "select:mcp__calendar__list_events,mcp__google-calendar__list_events",
        ),
      ],
      [],
    ]);
    const notes = failed(judgeNoCard(turn, CALENDAR));
    expect(notes).toEqual([
      '같은 것을 두 번 찾음 — "캘린더 일정 확인" → "select:mcp__calendar__list_events,mcp__google-calendar__list_events"',
    ]);
  });
});

describe("an answer that says what could not be done", () => {
  test.each([
    "사장님, 오늘 일정은 확인하지 못했습니다. 연결된 일정 기능이 없습니다.",
    "지금 연결된 서비스에는 슬랙이 없어서 올려드릴 수가 없어요.",
    "구글 캘린더에 로그인이 필요해요.",
    "캘린더가 연결돼 있지 않아요.",
  ])("passes %s", (said) => {
    expect(saysItCouldNot(said)).toBe(true);
    expect(failed(judgeSaysItCouldNot(turnOf([[]]), said))).toEqual([]);
  });

  test.each([
    ["", "아무 말도 하지 않음"],
    ["   ", "아무 말도 하지 않음"],
    [
      "오늘 일정은 2건입니다. 21시 치과, 22시 30분 매출 정리.",
      "하지 못했다는 말",
    ],
    ["[SILENT]", "알릴 것이 없다고 답함"],
  ])("fails %s", (said, why) => {
    expect(
      failed(judgeSaysItCouldNot(turnOf([[]]), said)).join("\n"),
    ).toContain(why);
  });

  /*
   * "THERE IS NONE" IS NOT "I COULD NOT LOOK" (review, 2026-10-05). The judge passed any answer
   * with 없 in it, so a routine that told somebody their calendar was empty — a calendar nobody
   * connected — was counted as having owned up.
   */
  test.each([
    "오늘 등록된 일정이 없어요.",
    "사장님, 등록된 일정은 아직 없어요. 아침마다 챙길 일이 있으면 알려주세요.",
    "오늘 일정은 없어요. 다만 캘린더가 연결돼 있지 않아서 정확하지 않을 수 있어요.",
    "새 메일은 없어요.",
  ])("fails a claim that nothing is there: %s", (said) => {
    expect(claimsNothingThere(said)).toBe(true);
    expect(saysItCouldNot(said)).toBe(false);
    expect(
      failed(judgeSaysItCouldNot(turnOf([[]]), said)).join("\n"),
    ).toContain("보지 못한 것을 없다고 말함");
  });

  test("an answer that owns up with the word 없 in it is not such a claim", () => {
    for (const said of [
      "구글 캘린더가 연결되어 있지 않아 일정을 조회할 수 없었습니다.",
      "오늘 일정 확인해 드리려고 했는데 확인할 방법이 없네요.",
      "오늘 일정을 확인하려 했는데 확인할 곳이 없었습니다.",
      "제 컴퓨터에 저장된 일정 파일이 없고, 연결된 일정도 없어서 볼 방법이 없습니다.",
      "저장된 루틴도 없고, 캘린더가 연결돼 있지 않아서 캘린더 일정은 확인하지 못했어요.",
    ]) {
      expect({ said, claims: claimsNothingThere(said) }).toEqual({
        said,
        claims: false,
      });
      expect(saysItCouldNot(said)).toBe(true);
    }
  });

  test("and fails a card raised where nobody can press one", () => {
    const notes = failed(
      judgeSaysItCouldNot(
        turnOf([[raise("google-calendar")]]),
        "연결이 필요해서 확인하지 못했어요.",
      ),
    );
    expect(notes).toEqual(["연결 카드를 띄움 — 권한 것: google-calendar"]);
  });
});

/*
 * THE FIXTURES. What they hand a Bot has to be what a chat turn hands one, or the six runs are six
 * runs of something else.
 */
describe("what the scenarios hand the Bot", () => {
  const cards: WireTool[] = [
    {
      name: "showBarChart",
      description: "Show values as a bar chart.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: CONNECT_CARD,
      description: "Put connection switches on screen.",
      parameters: { type: "object", properties: {} },
    },
  ];
  const accounts = CATALOGUE.filter(
    (entry) => entry.auth.kind === "user-oauth",
  ).map((entry) => entry.key);
  const nothing = nothingConnected(
    REALISTIC_TOOLSET,
    withTheConnectCard(cards),
  );
  /** Every account by its name and key, in key order: the list a lookup says. */
  const EVERY_ACCOUNT = [...accounts]
    .sort()
    .map((key) => `${FAMILY_LABELS_KO[key]}(${key})`)
    .join(", ");
  const raised = (services: string[]): ObservedCall => ({
    id: "c",
    name: CONNECT_CARD,
    rawArguments: JSON.stringify({ services }),
    arguments: { services },
  });

  test("the connect card lists every row 연결 draws, and a turn writes every account on it, in key order", () => {
    const declared = connectCard().parameters as {
      properties: { services: { items: { enum: string[] } } };
    };
    expect([...declared.properties.services.items.enum].sort()).toEqual(
      [...accounts, ...BUSINESS_SITES.map((site) => site.id)].sort(),
    );
    expect([...ACCOUNTS].sort()).toEqual([...accounts].sort());
    // As the server reads them: every account, off unless said, sorted by key.
    expect(accountsWith()).toEqual(
      [...accounts].sort().map((key) => ({ key, connected: false })),
    );
    expect(
      accountsWith(["gmail"])
        .filter((account) => account.connected)
        .map((account) => account.key),
    ).toEqual(["gmail"]);
    // Written on the window's own card the way a turn writes them, and nothing else changed.
    const handed = withTheConnectCard(cards).find(
      (card) => card.name === CONNECT_CARD,
    );
    expect(accountStatesIn(handed?.parameters)).toEqual(accountsWith());
    expect(withoutAccountStates(handed?.parameters)).toEqual(declared);
    expect(handed?.description).toBe(connectCard().description);
    // Every account has the name a lookup says it by — one list of them, the bridge's.
    for (const key of accounts)
      expect(FAMILY_LABELS_KO[key]).toMatch(/[가-힣]/);
  });

  test("a person with nothing connected holds no account's tools, and still 목표 and the fleet's", () => {
    const families = new Set(nothing.map((tool) => serverKeyOf(tool.name)));
    for (const key of accounts) expect(families.has(key)).toBe(false);
    expect(families.has("kakao-alimtalk")).toBe(false);
    for (const key of ["goals", "public-data", "web-search", "kma-weather"]) {
      expect(families.has(key)).toBe(true);
    }
    // And with everything connected, every adapter this repository has.
    const all = new Set(
      everythingConnected(REALISTIC_TOOLSET, cards).map((tool) =>
        serverKeyOf(tool.name),
      ),
    );
    for (const key of ["google-calendar", "gmail", "google-sheets", "goals"]) {
      expect(all.has(key)).toBe(true);
    }
  });

  /*
   * The scenarios are about what the bridge answers these lookups with, so the lookups the fleet's
   * model made are answered here from the scenarios' own lists — no model, no network. Whatever
   * the words, the answer ends on the same line: the bridge picks no service.
   */
  test("the lookups the fleet's model made end on what could be connected, and the card is callable from there", () => {
    const { deferred, offered } = exposeTools(nothing, true);
    for (const query of [
      "캘린더 일정 확인",
      "일정 확인하기, 캘린더 보기",
      "메일 확인하기",
      "구글 시트에 행 추가, 시트 만들기",
      "슬랙 메시지 보내기",
      "select:showBarChart",
      "목표 저장",
    ]) {
      const text = searchResultText(deferred, query, offered);
      const line = text.split("\n").at(-1) ?? "";
      expect(line.startsWith(`${OPEN_ACCOUNTS_HEAD}${EVERY_ACCOUNT}. `)).toBe(
        true,
      );
      expect(line).toContain(`name은 "${CONNECT_CARD}"`);
      // The call's shape is in the line; the card's schema is not pasted behind it.
      expect(describedToolNames([text]).has(CONNECT_CARD)).toBe(true);
      if (!query.includes("select:")) {
        expect(text).not.toContain(`{"name":"${CONNECT_CARD}"`);
      }
    }
  });

  /*
   * `deadline-is-not-the-calendar` starts from this lookup, already made and answered. It counts
   * whether a Bot takes a deadline for the calendar only for as long as the answer carries both:
   * 기업마당's search, and the line saying what could be connected.
   */
  test("the deadline lookup is answered with 기업마당's search, and then what could be connected", () => {
    const { deferred, offered } = exposeTools(nothing, true);
    const lines = searchResultText(deferred, DEADLINE_LOOKUP, offered).split(
      "\n",
    );
    const search = lines.findIndex((line) =>
      line.startsWith('{"name":"mcp__public-data__search_support_programs"'),
    );
    expect(search).toBeGreaterThan(0);
    expect(lines.at(-1)?.startsWith(OPEN_ACCOUNTS_HEAD)).toBe(true);
    expect(lines.length - 1).toBeGreaterThan(search);
    // What the search is then answered with: this month's two notices, in the transport's shape.
    const answer = JSON.parse(supportNotices("2026-10-05")) as {
      shown: number;
      rows: Array<{ title: string; period: string }>;
    };
    expect(answer.shown).toBe(answer.rows.length);
    expect(answer.rows.map((row) => row.period)).toEqual([
      "2026-10-01 ~ 2026-10-24",
      "2026-10-05 ~ 2026-10-28",
    ]);
    expect(answer.rows[0]?.title).toContain("스마트상점");
  });

  test("with 톡캘린더 connected, a lookup for a calendar is answered with it, and the line does not name 카카오", () => {
    const { deferred, offered } = exposeTools(
      [
        ...nothingConnected(
          REALISTIC_TOOLSET,
          withTheConnectCard(cards, accountsWith(["kakao-playmcp"])),
        ),
        TALK_CALENDAR,
      ],
      true,
    );
    for (const query of ["캘린더 일정 확인", "오늘 일정 보기"]) {
      const text = searchResultText(deferred, query, offered);
      expect(text).toContain(`{"name":"${TALK_CALENDAR.name}"`);
      const line = text.split("\n").at(-1) ?? "";
      expect(line.startsWith(OPEN_ACCOUNTS_HEAD)).toBe(true);
      expect(line).not.toContain("kakao-playmcp");
    }
  });

  /*
   * ONE SERVICE CONNECTED, AND SOMETHING ELSE ASKED — the three `…-with-…-connected-…` scenarios.
   * Each list holds the stranger's real tools and none of the service asked for, and the line on
   * a lookup for that service names it and leaves the stranger out.
   */
  test("with one unrelated service connected, the list has its tools and the line names the one asked for", () => {
    for (const [connected, more, query, asked] of [
      ["gmail", [], "캘린더 일정 확인", "google-calendar"],
      ["google-calendar", [], "메일 확인하기", "gmail"],
      ["notion", [NOTION_SEARCH], "구글 시트에 행 추가", "google-sheets"],
    ] as const) {
      const list = [
        ...onlyConnected(
          REALISTIC_TOOLSET,
          withTheConnectCard(cards, accountsWith([connected])),
          [connected],
        ),
        ...more,
      ];
      const families = new Set(list.map((tool) => serverKeyOf(tool.name)));
      expect(families.has(connected)).toBe(true);
      expect(families.has(asked)).toBe(false);
      const { deferred, offered } = exposeTools(list, true);
      const line =
        searchResultText(deferred, query, offered).split("\n").at(-1) ?? "";
      expect(line.startsWith(OPEN_ACCOUNTS_HEAD)).toBe(true);
      expect(line).toContain(`(${asked})`);
      expect(line).not.toContain(`(${connected})`);
    }
  });

  test("카카오 on with an empty toolbox: the lookup says so, and a card raised for it is answered at once", () => {
    const on = accountsWith(["kakao-playmcp"]);
    const empty = nothingConnected(
      REALISTIC_TOOLSET,
      withTheConnectCard(cards, on),
    );
    const { deferred, offered } = exposeTools(empty, true);
    const lines = searchResultText(
      deferred,
      "카카오톡 나에게 보내기",
      offered,
    ).split("\n");
    expect(lines.at(-2)).toContain(
      "연결돼 있지만 그 연결이 가져온 도구가 없는 계정: 카카오(kakao-playmcp).",
    );
    // Among what could be connected, 카카오 is not.
    expect(lines.at(-1)?.startsWith(OPEN_ACCOUNTS_HEAD)).toBe(true);
    expect(lines.at(-1)).not.toContain("kakao-playmcp");
    // The card, as the server answers it: on, and nothing usable — never "look its tools up".
    const answer = answeredAtOnce(on, empty);
    expect(JSON.parse(answer(raised(["kakao-playmcp"])) ?? "null")).toEqual({
      code: "laf:connection_unusable",
      connected: ["kakao-playmcp"],
      notConnected: [],
      reason: toolResultText("laf:connection_unusable"),
    });
    // With a tool of its own in the list it is simply on; anything not on is drawn, and waited on.
    expect(
      JSON.parse(
        answeredAtOnce(on, [...empty, TALK_CALENDAR])(
          raised(["kakao-playmcp"]),
        ) ?? "null",
      ).code,
    ).toBe("laf:connection_on");
    expect(answer(raised(["gmail"]))).toBeUndefined();
    expect(answer(raised(["kakao-playmcp", "gmail"]))).toBeUndefined();
    expect(
      answer({ ...raised(["kakao-playmcp"]), name: "askChoice" }),
    ).toBeUndefined();
  });

  /*
   * `connected-at-the-card-then-used` goes past the card: the fixture answers the first card for
   * 지메일 as the server answers one whose switch turned on, and lands its tools in the same list.
   * The card on that list still carries the turn's read — 지메일 not connected — which is the
   * state the lookup after it has to see through.
   */
  test("a person who connects at the card: answered as on, the tools land in the same list, and the next lookup does not offer it again", () => {
    const gmail = REALISTIC_TOOLSET.filter(
      (tool) => serverKeyOf(tool.name) === "gmail",
    );
    const landing = connectsAtTheCard(nothing, "gmail", gmail);
    const lookup = (query: string) => {
      const { deferred, offered } = exposeTools(landing.tools, true);
      return searchResultText(deferred, query, offered);
    };
    const lineOf = (text: string) => text.split("\n").at(-1) ?? "";
    expect(landing.tools).toEqual(nothing);
    expect(lineOf(lookup("메일 확인하기"))).toContain("지메일(gmail)");

    // The first card is answered, not waited on.
    expect(landing.waitsOn(raised(["gmail"]))).toBe(false);
    expect(JSON.parse(landing.answer(raised(["gmail"])) ?? "null")).toEqual({
      code: "laf:connection_on",
      connected: ["gmail"],
      notConnected: [],
      tools: gmail.map((tool) => tool.name),
      reason: toolResultText("laf:connection_on"),
    });
    expect(landing.tools).toHaveLength(nothing.length + gmail.length);

    // The lookup the card's answer sends the Bot to: the tool, and a line that leaves 지메일 out.
    const after = lookup("select:mcp__gmail__search_messages");
    expect(after).toContain('"name":"mcp__gmail__search_messages"');
    expect(lineOf(after).startsWith(OPEN_ACCOUNTS_HEAD)).toBe(true);
    expect(lineOf(after)).not.toContain("지메일(gmail)");

    // A second card is the Bot asking again: waited on, and never answered here.
    expect(landing.waitsOn(raised(["gmail"]))).toBe(true);
    expect(landing.answer(raised(["gmail"]))).toBeUndefined();
    // And the next attempt starts from nothing connected; a card for something else is not this one's.
    landing.reset();
    expect(landing.tools).toEqual(nothing);
    expect(landing.answer(raised(["notion"]))).toBeUndefined();
    expect(landing.waitsOn(raised(["notion"]))).toBe(true);
  });

  test("a routine's list has no card, so nothing is said of connecting", () => {
    const routine = nothingConnected(REALISTIC_TOOLSET, []).filter(
      (tool) => serverKeyOf(tool.name) !== "goals",
    );
    const { deferred, offered } = exposeTools(routine, true);
    expect(
      searchResultText(deferred, "캘린더 일정 조회", offered).split("\n"),
    ).toEqual([
      "'캘린더 일정 조회'에 맞는 도구가 없다.",
      "지금 연결된 서비스는 없다.",
      "다시 찾지 않는다. 지금 쓸 수 있는 도구로 하거나, 할 수 없다고 사람에게 말한다.",
    ]);
  });

  test("what is read on the way is answered as the product answers it", () => {
    const call = (
      name: string,
      args: Record<string, unknown>,
    ): ObservedCall => ({
      id: "c",
      name,
      rawArguments: JSON.stringify(args),
      arguments: args,
    });
    expect(nothingToRead(call("manage_routine", { action: "list" }))).toBe(
      toolResultText("laf:routine_list_empty"),
    );
    expect(nothingToRead(call("mcp__goals__list_goals", {}))).toBe(
      '{"ok":true,"goals":[]}',
    );
    const wall = JSON.parse(
      nothingToRead(
        call("computer_navigate", { url: "https://calendar.google.com/" }),
      ) ?? "null",
    );
    expect(wall.title).toBe("로그인");
    expect(wall.url).toBe("https://calendar.google.com/");
    expect(nothingToRead(call("remember", { fact: "x" }))).toBeUndefined();
  });

  test("a run ends where the product's turn waits for the person", () => {
    const call = (name: string): ObservedCall => ({
      id: "c",
      name,
      rawArguments: "{}",
      arguments: {},
    });
    for (const name of [
      CONNECT_CARD,
      "askChoice",
      "askApproval",
      "computer_request_help",
      "computer_request_secret",
    ]) {
      expect({ name, waits: asksThePerson(call(name)) }).toEqual({
        name,
        waits: true,
      });
    }
    for (const name of ["computer_navigate", "manage_routine", "showFile"]) {
      expect({ name, waits: asksThePerson(call(name)) }).toEqual({
        name,
        waits: false,
      });
    }
  });
});
