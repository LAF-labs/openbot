import { describe, expect, test } from "bun:test";
import {
  BRIDGE_TOOLS,
  DEFERRED_TOOL_PREFIX,
  DEPLOYMENT_FAMILIES,
  deferredToolsText,
  describedToolNames,
  exposureOf,
  FAMILY_LABELS_KO,
  familiesOf,
  isBridgeToolName,
  isDeferredToolName,
  OPEN_ACCOUNTS_HEAD,
  oneLine,
  resolveDeferred,
  resolveOffered,
  SEARCH_LIMIT,
  searchResultText,
  searchTools,
  splitExposure,
  unwrapToolCall,
  type WireTool,
} from "../shared/tools/bridge";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
import {
  ACCOUNT_STATES,
  type AccountState,
  accountStatesIn,
  CONNECT_CARD,
  FILE_CARD,
  openAccountsIn,
  withAccountStates,
  withoutAccountStates,
} from "../shared/tools/gallery";
import { GOALS_FAMILY } from "../shared/tools/goals";
import { SELF_TOOLS } from "../shared/tools/self";

/**
 * The rule that decides what a Bot's schema carries, and the three tools that reach the rest.
 *
 * THE ONE THING THAT MUST NEVER BE DEFERRED is anything a person answers through. Hermes measured
 * it: hiding the ask-the-user tool behind the bridge turned structured questions into prose
 * (18/18 → 7/18), and this product's whole boundary story runs through `computer_request_help`,
 * `computer_request_secret` and the approval a real call raises. So the first test walks every
 * catalogue and names them one by one.
 */

const wire = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
): WireTool => ({
  name,
  description,
  parameters: { type: "object", properties, required: [] },
});

/* The connected services a shop's Bot typically has, in the words the adapters actually use. */
const CONNECTED: WireTool[] = [
  wire(
    "mcp__gmail__search_messages",
    "지메일에서 메일을 찾는다. query는 지메일 검색창과 같은 문법이다. (gmail)",
  ),
  wire("mcp__gmail__read_message", "메일 한 통의 본문을 읽는다. (gmail)"),
  wire(
    "mcp__gmail__create_draft",
    "메일 초안을 만들어 둔다. 보내지는 않으므로 사람이 지메일에서 확인하고 직접 보낼 수 있다. (gmail)",
  ),
  wire(
    "mcp__gmail__send_message",
    "메일을 실제로 보낸다. 보낸 메일은 되돌릴 수 없으므로 사람이 승인해야 나간다. (gmail)",
    { to: { type: "string" }, subject: { type: "string" } },
  ),
  wire(
    "mcp__google-sheets__list_sheet_tabs",
    "스프레드시트에 어떤 시트(탭)들이 있는지 본다. (google-sheets)",
  ),
  wire(
    "mcp__google-sheets__read_sheet_values",
    "시트의 범위를 읽는다. (google-sheets)",
  ),
  wire(
    "mcp__google-sheets__append_sheet_row",
    "시트 끝에 행 하나를 덧붙인다. (google-sheets)",
  ),
  wire(
    "mcp__google-sheets__update_sheet_values",
    "시트의 범위를 새 값으로 덮어쓴다. (google-sheets)",
  ),
  wire("mcp__cafe24__list_orders", "쇼핑몰의 주문을 나열한다. (cafe24)"),
  wire("mcp__cafe24__read_order", "주문 하나를 자세히 읽는다. (cafe24)"),
  wire("mcp__cafe24__list_products", "쇼핑몰의 상품을 나열한다. (cafe24)"),
  wire("mcp__cafe24__list_board_articles", "게시판의 글을 나열한다. (cafe24)"),
  wire(
    "mcp__cafe24__update_order_status",
    "주문의 배송 상태를 바꾼다. (cafe24)",
  ),
  wire(
    "mcp__kakao-alimtalk__alimtalk_templates",
    "이 사업장의 카카오톡 채널에 등록된 알림톡 서식과 심사 상태를 본다. (kakao-alimtalk)",
  ),
  wire(
    "mcp__kakao-alimtalk__alimtalk_send",
    "승인된 서식으로 손님 휴대폰에 알림톡을 보낸다. (kakao-alimtalk)",
  ),
];

const first = (query: string) => searchTools(CONNECTED, query)[0]?.name;

describe("what is never deferred", () => {
  test("every computer tool, and above all the two that hand the wheel to a person", () => {
    for (const tool of COMPUTER_TOOLS) {
      expect(exposureOf(tool.name)).toBe("core");
    }
    const asksAPerson = COMPUTER_TOOLS.filter((tool) => tool.needsPerson).map(
      (tool) => tool.name,
    );
    expect(asksAPerson.sort()).toEqual([
      "computer_request_help",
      "computer_request_secret",
    ]);
  });

  test("every self tool", () => {
    for (const tool of SELF_TOOLS) {
      expect(exposureOf(tool.name)).toBe("core");
    }
  });

  test("the bridge itself", () => {
    for (const tool of BRIDGE_TOOLS) {
      expect(isDeferredToolName(tool.name)).toBe(false);
      expect(isBridgeToolName(tool.name)).toBe(true);
    }
  });

  test("a connected service's tool is, by the name the server mints for it", () => {
    expect(exposureOf(`${DEFERRED_TOOL_PREFIX}gmail__send_message`)).toBe(
      "deferred",
    );
    const { core, deferred } = splitExposure([
      ...COMPUTER_TOOLS,
      ...SELF_TOOLS,
      ...CONNECTED,
    ]);
    expect(core).toHaveLength(COMPUTER_TOOLS.length + SELF_TOOLS.length);
    expect(deferred).toHaveLength(CONNECTED.length);
  });
});

/*
 * THE CARDS A WINDOW OFFERS, AND THE ONE THAT IS NOT BEHIND THE BRIDGE.
 *
 * Measured 2026-10-02 with the fleet's model, every card behind the bridge: asked to hand over a
 * note it had just saved, the Bot looked for "화면에 카드 띄우기, 파일 보여주기" and "카드 보여주기",
 * was told there was no such tool — the cards are named and described in English — and answered
 * "화면에 카드로 띄우는 기능은 지금 없어서" four times in six. Asked to MAKE a file, it never once
 * handed it over: "제 컴퓨터에 weekly_sales.csv로 저장해 뒀고".
 */
describe("the screen's cards", () => {
  const CARDS: WireTool[] = [
    wire(
      "askChoice",
      "Ask the person to pick one of several options, and WAIT for their answer.",
    ),
    wire(
      "showBarChart",
      "Show values as a bar chart. Use when comparing a handful of named things.",
    ),
    wire(
      "showChecklist",
      "Show a list of things and which are done. Reporting only.",
    ),
    wire("showProgress", "Show values against their targets as progress bars."),
    wire(
      "showQuote",
      "Show a quotation with its attribution. Use when the exact words matter.",
    ),
  ];
  const HANDS_A_FILE = wire(
    FILE_CARD,
    "Hand the person a file from your workspace: a card with its name, its size and a download button.",
  );

  test("the one that hands a file over is in the schema, and the others are not", () => {
    expect(exposureOf(FILE_CARD)).toBe("core");
    for (const card of CARDS) expect(exposureOf(card.name)).toBe("deferred");
    const { core, deferred } = splitExposure([...CARDS, HANDS_A_FILE]);
    expect(core.map((tool) => tool.name)).toEqual([FILE_CARD]);
    expect(deferred).toHaveLength(CARDS.length);
    // So the line of names the Bot is given no longer has to be read for it.
    expect(
      deferredToolsText([...CARDS, HANDS_A_FILE].map((t) => t.name)),
    ).not.toContain(FILE_CARD);
  });

  test("are found from the Korean a request is made of", () => {
    // The very words the Bot looked with.
    const asked = searchTools(CARDS, "화면에 카드 띄우기");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((hit) => hit.name.startsWith("show"))).toBe(true);
    expect(searchTools(CARDS, "체크리스트로 정리")[0]?.name).toBe(
      "showChecklist",
    );
    expect(searchTools(CARDS, "진행 상황 카드")[0]?.name).toBe("showProgress");
    expect(searchTools(CARDS, "인용")[0]?.name).toBe("showQuote");
    expect(searchTools(CARDS, "선택 받기")[0]?.name).toBe("askChoice");
    // "보여 줘" alone is not a request for a card: it is how anything is asked for.
    expect(searchTools(CARDS, "매출 보여줘")).toEqual([]);
  });

  test("a file looked for through the bridge is answered with the card already in the list", () => {
    for (const query of ["파일을 카드로 건네주기", "파일 내려받기 카드"]) {
      const text = searchResultText(CARDS, query, [HANDS_A_FILE]);
      expect(text).toContain("이미 목록에 있는 도구다");
      expect(text).toContain(FILE_CARD);
      expect(text).not.toContain("맞는 도구가 없다");
    }
  });
});

describe("tool_search", () => {
  test("finds the tool from Korean", () => {
    expect(first("메일 보내줘")).toBe("mcp__gmail__send_message");
    expect(first("시트에 행 추가")).toBe(
      "mcp__google-sheets__append_sheet_row",
    );
    expect(first("주문 목록")).toBe("mcp__cafe24__list_orders");
    expect(first("알림톡 보내기")).toBe("mcp__kakao-alimtalk__alimtalk_send");
  });

  test("finds the tool from English", () => {
    expect(first("send email")).toBe("mcp__gmail__send_message");
    expect(first("append a row to the spreadsheet")).toBe(
      "mcp__google-sheets__append_sheet_row",
    );
    expect(first("list orders")).toBe("mcp__cafe24__list_orders");
  });

  test("returns at most five, each with a one-line description", () => {
    const hits = searchTools(CONNECTED, "목록 나열 읽는다 본다 시트 주문 메일");
    expect(hits.length).toBeLessThanOrEqual(SEARCH_LIMIT);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.description).not.toContain("\n");
      expect(hit.description.length).toBeLessThanOrEqual(120);
    }
  });

  test("says what is connected when nothing matches, rather than inventing a tool", () => {
    const text = searchResultText(CONNECTED, "비행기표 예약");
    expect(text).toContain("없다");
    expect(text).toContain("지메일");
    expect(text).toContain("카페24");
    expect(searchTools(CONNECTED, "비행기표 예약")).toEqual([]);
  });

  test("an empty query matches nothing", () => {
    expect(searchTools(CONNECTED, "   ")).toEqual([]);
  });

  /*
   * THE FIRST MESSAGE'S EXTRA ROUND (ux-review-0.5.4, item 9). With nothing connected, only the
   * gallery's cards sit behind the bridge, and a miss that said "다른 말로 다시 찾아 본다" bought
   * another full model round for the same empty answer. Measured: every conversation's first
   * weather question began with `tool_search("날씨 확인")`, 4.8–8 s of "생각 중".
   */
  test("with nothing connected, a miss does not send the Bot searching again", () => {
    const cards = [wire("showBarChart", "막대 그래프를 띄운다.")];
    const text = searchResultText(cards, "날씨 확인");
    expect(text).toContain("지금 연결된 서비스는 없다.");
    expect(text).toContain("다시 찾지 않는다");
    expect(text).not.toContain("다른 말로 다시 찾아");
    // A connected service is still worth a second phrasing.
    expect(searchResultText(CONNECTED, "비행기표 예약")).toContain(
      "다른 말로 다시 찾아 본다",
    );
  });

  test("the context layer says the names behind the bridge are all of them", () => {
    expect(deferredToolsText(["showBarChart", "askChoice"])).toContain(
      "아래가 전부다",
    );
  });
});

describe("what tool_search hands back", () => {
  const schemas = (text: string) =>
    text
      .split("\n")
      .slice(1)
      .map(
        (line) =>
          JSON.parse(line) as {
            name: string;
            parameters: { properties: Record<string, unknown> };
          },
      );

  test("the whole schema of every match, as Claude Code's ToolSearch does", () => {
    const [found] = schemas(searchResultText(CONNECTED, "메일 보내줘"));
    expect(found?.name).toBe("mcp__gmail__send_message");
    expect(Object.keys(found?.parameters.properties ?? {})).toEqual([
      "to",
      "subject",
    ]);
  });

  test("select: picks tools by the names the context layer lists", () => {
    const found = schemas(
      searchResultText(
        CONNECTED,
        "select:mcp__cafe24__read_order, mcp__gmail__send_message",
      ),
    );
    expect(found.map((tool) => tool.name)).toEqual([
      "mcp__cafe24__read_order",
      "mcp__gmail__send_message",
    ]);
  });

  test("accepts a bare name only when it names exactly one tool", () => {
    expect(resolveDeferred(CONNECTED, "send_message")?.name).toBe(
      "mcp__gmail__send_message",
    );
    const twice = [
      ...CONNECTED,
      wire("mcp__other__send_message", "다른 데로 보낸다."),
    ];
    expect(resolveDeferred(twice, "send_message")).toBeNull();
  });

  test("an unknown name is answered with the nearest names", () => {
    const unknown = unwrapToolCall(CONNECTED, { name: "mcp__gmail__send" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.text).toContain("없다");
      expect(unknown.text).toContain("mcp__gmail__send_message");
    }
  });
});

describe("tool_call", () => {
  test("unwraps into the real name and the arguments as given", () => {
    expect(
      unwrapToolCall(CONNECTED, {
        name: "mcp__gmail__send_message",
        args: { to: "kim@shop.kr", subject: "정산서" },
      }),
    ).toEqual({
      ok: true,
      name: "mcp__gmail__send_message",
      args: { to: "kim@shop.kr", subject: "정산서" },
    });
  });

  test("refuses what it cannot name, and says how to find it", () => {
    for (const bad of [null, "x", [], { args: {} }, { name: "" }]) {
      const result = unwrapToolCall(CONNECTED, bad);
      expect(result.ok).toBe(false);
    }
    const unknown = unwrapToolCall(CONNECTED, { name: "mcp__slack__post" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.text).toContain("tool_search");
  });

  test("missing arguments become an empty object, for the server to judge", () => {
    expect(
      unwrapToolCall(CONNECTED, { name: "mcp__cafe24__list_orders" }),
    ).toEqual({
      ok: true,
      name: "mcp__cafe24__list_orders",
      args: {},
    });
  });

  /*
   * A string where the object should be — the common mistake — used to become `{}` silently, and
   * the server then said "X is missing". The model read that, never "args must be an object", and
   * made the same mistake again (audit A2 §4). Refused here, in words about the shape.
   */
  test("arguments that are not an object are refused, and told what shape they should be", () => {
    for (const bad of ['{"to":"a@b.c"}', ["a@b.c"], 7]) {
      const result = unwrapToolCall(CONNECTED, {
        name: "mcp__gmail__send_message",
        args: bad,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.text).toContain("JSON 객체");
    }
  });
});

describe("the words around the bridge", () => {
  test("families are named in Korean, once each, in the order they appear", () => {
    expect(familiesOf(CONNECTED.map((tool) => tool.name))).toEqual([
      "지메일",
      "구글 시트",
      "카페24",
      "카카오 알림톡",
    ]);
    // A server an administrator added by URL has no label; its key is better than an invention.
    expect(familiesOf(["mcp__acme-crm__list"])).toEqual(["acme-crm"]);
  });

  /*
   * THE BRIDGE'S WORDS NEVER DEPEND ON WHAT IS CONNECTED. They used to name this run's services,
   * so connecting one changed the tool list — the head of the prompt — and re-billed the whole
   * conversation. What is behind the bridge is named in the context layer instead.
   */
  test("the two bridge tools are static: search and call, nothing about this run", () => {
    expect(BRIDGE_TOOLS.map((tool) => tool.name)).toEqual([
      "tool_search",
      "tool_call",
    ]);
    const words = JSON.stringify(BRIDGE_TOOLS);
    expect(words).not.toContain("지금 연결된 서비스");
  });

  test("the context layer names what is behind the bridge, by name, grouped and sorted", () => {
    const names = [
      "showBarChart",
      ...CONNECTED.map((tool) => tool.name).reverse(),
      "computer_navigate",
      "remember",
      "tool_search",
    ];
    const text = deferredToolsText(names);
    expect(text).toBe(deferredToolsText([...names].reverse()));
    expect(text).toContain("- 지메일: mcp__gmail__create_draft,");
    expect(text).toContain("- 화면에 띄우는 카드: showBarChart");
    // Core tools and the bridge are on the tool list itself, not here.
    expect(text).not.toContain("computer_navigate");
    expect(text).not.toContain("remember");
    expect(text).not.toContain("- 도구");
    expect(deferredToolsText(["computer_navigate", "now"])).toBe("");
  });

  test("a card from the gallery is deferred like a connected service", () => {
    expect(exposureOf("showBarChart")).toBe("deferred");
    expect(exposureOf("askChoice")).toBe("deferred");
    expect(isDeferredToolName("skill_view")).toBe(false);
    expect(isDeferredToolName("routine_note")).toBe(false);
    expect(isDeferredToolName("now")).toBe(false);
  });

  test("a one-line description is the first sentence, bounded", () => {
    expect(oneLine("메일을 실제로 보낸다. 보낸 메일은 되돌릴 수 없다.")).toBe(
      "메일을 실제로 보낸다.",
    );
    expect(oneLine("가".repeat(300)).length).toBeLessThanOrEqual(120);
  });
});

/*
 * 목표's tools stand behind the bridge (`shared/tools/goals.ts`, muse-shape plan §3.4): a chat turn
 * offers them always, and the head of the prompt — the list the model is offered — is byte-identical
 * with or without them. Measured on the real stack too (a proxy before OpenRouter, the same chat's
 * request from the server before and after: the same 21 tools, 9,804 bytes).
 */
describe("목표's tools cost the head nothing", () => {
  test("deferred by name, filed under 목표, and the offered list is the same bytes with or without them", async () => {
    const { GOAL_TOOLS } = await import("../shared/tools/goals");
    const { exposeTools } = await import("../agent-bot/src/deferral");
    for (const tool of GOAL_TOOLS) {
      expect(isDeferredToolName(tool.name)).toBe(true);
      expect(exposureOf(tool.name)).toBe("deferred");
    }
    expect(familiesOf(GOAL_TOOLS.map((tool) => tool.name))).toEqual(["목표"]);
    const chat: WireTool[] = [
      ...COMPUTER_TOOLS.map((tool) => wire(tool.name, tool.description)),
      ...SELF_TOOLS.map((tool) => wire(tool.name, tool.description)),
    ];
    const without = exposeTools(chat, true);
    const withGoals = exposeTools(
      [
        ...chat,
        ...GOAL_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      ],
      true,
    );
    expect(JSON.stringify(withGoals.provider)).toBe(
      JSON.stringify(without.provider),
    );
    expect(withGoals.deferred.map((tool) => tool.name).sort()).toEqual(
      GOAL_TOOLS.map((tool) => tool.name).sort(),
    );
    expect(deferredToolsText(GOAL_TOOLS.map((tool) => tool.name))).toContain(
      "- 목표: mcp__goals__list_goals, mcp__goals__log_progress, mcp__goals__save_goal, mcp__goals__update_goal",
    );
  });
});

/*
 * THE BRIDGE DOES NOT SAY A TOOL IS MISSING WHEN THE BOT IS HOLDING IT.
 *
 * Measured 2026-10-02 on the local stack, muse-spark: asked "KTX 요금이랑 걸리는 시간 검색해서
 * 알려줘", the Bot called `tool_search("select:mcp__web-search__search")` — the search tool had been
 * behind the bridge earlier in that conversation, and the history said so. It is in the schema now,
 * and the bridge, which knew only what stands behind it, answered that no such tool exists. The Bot
 * believed it, gave up on searching and opened Naver in its browser: forty seconds for a question
 * the search answers in six.
 */
describe("a tool already in the schema, asked for through the bridge", () => {
  const SEARCH = wire(
    "mcp__web-search__search",
    "웹을 검색해 지금의 사실을 찾는다 — 뉴스, 가격, 영업시간, 제도와 기한.",
    { queries: { type: "array" } },
  );
  const WEATHER = wire(
    "mcp__kma-weather__get_weather",
    "날씨를 기상청 예보로 알려 준다.",
  );
  const NAVIGATE = wire("computer_navigate", "네 컴퓨터에서 웹 페이지를 연다.");
  const OFFERED = [NAVIGATE, WEATHER, SEARCH];

  test("named exactly, it is said to be in the list and to be called by its name", () => {
    const text = searchResultText(
      CONNECTED,
      "select:mcp__web-search__search",
      OFFERED,
    );
    expect(text).toContain("이미 목록에 있는 도구다");
    expect(text).toContain("바로 부른다");
    expect(text).toContain("- mcp__web-search__search: 웹을 검색해");
    // Not the sentence that sent the Bot to its browser.
    expect(text).not.toContain("맞는 도구가 없다");
    // And no schema line: the schema is at the head of the request already.
    expect(text).not.toContain('{"name":');
  });

  test("beside one that is behind the bridge, each is answered as what it is", () => {
    const text = searchResultText(
      CONNECTED,
      "select:mcp__gmail__send_message,mcp__web-search__search",
      OFFERED,
    );
    expect(text).toContain("맞는 도구 1개, 스키마 전부");
    expect(text).toContain('{"name":"mcp__gmail__send_message"');
    expect(text).toContain("이미 목록에 있는 도구다");
    expect(text).toContain("- mcp__web-search__search:");
  });

  test("asked for in words, a service-shaped tool is found; a browser tool is not noise", () => {
    // Behind the bridge "검색" finds Gmail's search of mail. Handed back alone, that sends a Bot
    // to look for the web in a mailbox: the search it holds is said beside it.
    const text = searchResultText(CONNECTED, "웹 검색", OFFERED);
    expect(text).toContain("mcp__gmail__search_messages");
    expect(text).toContain("이미 목록에 있는 도구다");
    expect(text).toContain("- mcp__web-search__search:");
    // With nothing behind the bridge that matches, it is the whole answer.
    const alone = searchResultText(
      [wire("showBarChart", "막대 그래프를 띄운다.")],
      "웹 검색",
      OFFERED,
    );
    expect(alone.startsWith("이미 목록에 있는 도구다")).toBe(true);
    expect(alone).not.toContain("맞는 도구가 없다");
    // A phrase about the browser must not come back as "you already have the browser": only the
    // tools shaped like a connected service are looked through, since those are the ones a Bot
    // would think to look for behind the bridge.
    expect(
      searchResultText(CONNECTED, "웹 페이지 열기", OFFERED),
    ).not.toContain("computer_navigate");
    // And a phrase nothing matches, anywhere, is the miss it always was.
    const miss = searchResultText(CONNECTED, "비행기표 예약", OFFERED);
    expect(miss).toContain("맞는 도구가 없다");
    expect(miss).not.toContain("이미 목록에 있는");
    // What IS behind the bridge still wins, and nothing is added to its answer.
    const mail = searchResultText(CONNECTED, "메일 보내줘", OFFERED);
    expect(mail).toContain("mcp__gmail__send_message");
    expect(mail).not.toContain("이미 목록에 있는");
  });

  test("a caller that says nothing of what is offered gets the answer it always got", () => {
    expect(
      searchResultText(CONNECTED, "select:mcp__web-search__search"),
    ).toContain("맞는 도구가 없다");
  });

  test("a bare name is a service-shaped tool's only when one has it", () => {
    expect(resolveOffered(OFFERED, "search")?.name).toBe(
      "mcp__web-search__search",
    );
    expect(resolveOffered(OFFERED, "computer_navigate")?.name).toBe(
      "computer_navigate",
    );
    expect(resolveOffered(OFFERED, "navigate")).toBeNull();
    expect(resolveOffered(OFFERED, "  ")).toBeNull();
    const twice = [
      ...OFFERED,
      wire("mcp__naver__search", "네이버에서 찾는다."),
    ];
    expect(resolveOffered(twice, "search")).toBeNull();
  });

  test("called through tool_call, it is the real call and not a tool that does not exist", () => {
    const call = unwrapToolCall(
      CONNECTED,
      { name: "mcp__web-search__search", args: { queries: ["KTX 요금"] } },
      OFFERED,
    );
    expect(call).toEqual({
      ok: true,
      name: "mcp__web-search__search",
      args: { queries: ["KTX 요금"] },
      offered: SEARCH,
    });
    // One behind the bridge is not marked as offered, and an unknown name is still unknown.
    const behind = unwrapToolCall(
      CONNECTED,
      { name: "mcp__gmail__send_message", args: {} },
      OFFERED,
    );
    expect(behind.ok && "offered" in behind).toBe(false);
    expect(
      unwrapToolCall(CONNECTED, { name: "mcp__slack__post" }, OFFERED).ok,
    ).toBe(false);
  });
});

/*
 * WHAT COULD BE CONNECTED IS SAID AS A FACT, ON EVERY LOOKUP, AND THE MODEL CHOOSES.
 *
 * Measured 2026-10-05 on the fleet's model, a person with nothing connected, six runs a question:
 * "오늘 일정 뭐 있어?" was two to six requests of the model and then prose saying it could see no
 * schedule — the connect card never raised. The bridge had answered "맞는 도구가 없다 … 다른 말로
 * 다시 찾아 본다": it took 목표 and 나라장터 for connected services, and said nothing of what could
 * be connected.
 *
 * Twice the bridge then decided for the model, and twice it was wrong. A table of words chose the
 * service: "배송 일정 조회" was offered Google Calendar, "카페 24시간" Cafe24, "balance sheet" Google
 * Sheets. Then "say nothing where a connected service's tool was found" chose when to speak: with
 * only Gmail connected, "캘린더 일정 확인" reaches Gmail's draft tool on the one word 확인, and the
 * offer was gone — 18 of 48 calendar lookups and 15 of 30 mail lookups, for a person with one
 * service connected (review). So the bridge picks nothing: for anyone with an account left to
 * connect, every lookup's answer ends on the same short line, and the model that read the request
 * decides whether it matters.
 */
describe("what a lookup says of connecting", () => {
  const DECLARED = {
    type: "object",
    properties: {
      services: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "string",
          enum: ["google-calendar", "gmail", "google-sheets", "notion"],
        },
        description: "The connections to offer, most useful first",
      },
      reason: { type: "string" },
    },
    required: ["services"],
  };
  /** The connect card as a turn hands it on: the window's schema, the person's accounts on it. */
  const card = (accounts?: readonly AccountState[]): WireTool => ({
    name: CONNECT_CARD,
    description:
      "Put connection switches on screen and WAIT until the person turns one on, or says not now.",
    parameters: accounts ? withAccountStates(DECLARED, accounts) : DECLARED,
  });
  const off = (...keys: string[]): AccountState[] =>
    keys.map((key) => ({ key, connected: false }));
  const on = (...keys: string[]): AccountState[] =>
    keys.map((key) => ({ key, connected: true }));
  const OPEN = off("notion", "google-sheets", "google-calendar", "gmail");
  /* What stands behind the bridge of a person who has connected nothing, on a fleet deployment. */
  const NOBODYS: WireTool[] = [
    wire(
      "mcp__goals__list_goals",
      "이 사람의 진행 중인 목표를 id·제목·달성 기준·마감·최근 흐름과 함께 본다.",
    ),
    wire(
      "mcp__goals__log_progress",
      "목표에 진행을 한 줄 적는다: 사람이 말한 진행이나 점검 루틴이 확인한 것.",
    ),
    wire(
      "mcp__public-data__search_bids",
      "나라장터(조달청) 용역 입찰공고를 찾는다. (public-data)",
    ),
    wire("showBarChart", "Show values as a bar chart."),
  ];
  const NOTHING = [...NOBODYS, card(OPEN)];
  const linesOf = (text: string) => text.split("\n");
  const lastOf = (text: string) => linesOf(text).at(-1) ?? "";
  /** The line for these open accounts: the whole of what is said, pinned once. */
  const lineFor = (accounts: string) =>
    `${OPEN_ACCOUNTS_HEAD}${accounts}. 부탁받은 일에 이 가운데 하나가 꼭 필요할 때만, 말로만 답하지 말고 tool_search 없이 바로 tool_call로 연결 카드를 띄운다 — name은 "showConnection", args는 {"services":["괄호 안의 키"],"reason":"연결하면 해 줄 일 한 줄"}. 이 대화에서 이미 다음으로 미룬 연결은 다시 띄우지 않는다.`;
  const LINE = lineFor(
    "지메일(gmail), 구글 캘린더(google-calendar), 구글 시트(google-sheets), 노션(notion)",
  );

  test("a miss ends on one short line: the accounts still open, by name and key in key order, and the call's whole shape", () => {
    const text = searchResultText(NOTHING, "캘린더 일정 조회");
    expect(linesOf(text)).toEqual([
      "'캘린더 일정 조회'에 맞는 도구가 없다.",
      "지금 연결된 서비스는 없다.",
      "다시 찾지 않는다. 지금 쓸 수 있는 도구로 하거나, 할 수 없다고 사람에게 말한다.",
      LINE,
    ]);
    // No schema is pasted, and nothing of what the turn wrote on the card.
    expect(text).not.toContain(`{"name":"${CONNECT_CARD}"`);
    expect(text).not.toContain(ACCOUNT_STATES);
  });

  test("the line is short whoever reads it: under four hundred characters with every account open", () => {
    const every = Object.keys(FAMILY_LABELS_KO).filter(
      (key) => !DEPLOYMENT_FAMILIES.has(key) && key !== "kakao-alimtalk",
    );
    expect(every).toHaveLength(9);
    const line = lastOf(
      searchResultText([...NOBODYS, card(off(...every))], "막대 차트"),
    );
    expect(line.startsWith(OPEN_ACCOUNTS_HEAD)).toBe(true);
    expect(line.length).toBeLessThan(400);
  });

  test("the same accounts are the same bytes, in whatever order the turn or the list came", () => {
    const again = [card([...OPEN].reverse()), ...[...NOBODYS].reverse()];
    for (const query of ["캘린더 일정 조회", "메일 확인"]) {
      expect(searchResultText(again, query)).toBe(
        searchResultText(NOTHING, query),
      );
    }
  });

  /*
   * NO MATCHER DECIDES WHETHER IT IS SAID. Whatever the words and whatever was found — nothing,
   * 목표's tool on a stray word, a tool asked for by name, a card — the last line is the same line.
   */
  test("every lookup ends on it, whatever the words and whatever was found", () => {
    for (const query of [
      "캘린더 일정 조회",
      "배송 일정 조회",
      "카페 24시간",
      "balance sheet",
      "네이버 메일 확인",
      "일정 확인",
      "막대 차트",
      "select:mcp__public-data__search_bids",
      "select:mcp__gmail__list_messages",
      "연결",
    ]) {
      expect({ query, last: lastOf(searchResultText(NOTHING, query)) }).toEqual(
        {
          query,
          last: LINE,
        },
      );
    }
    // Said once: found by the word 연결, the card's schema is the hit and the line follows it.
    const found = searchResultText(NOTHING, "연결");
    expect(found.split(OPEN_ACCOUNTS_HEAD)).toHaveLength(2);
    expect(found.split(`"name":"${CONNECT_CARD}"`)).toHaveLength(2);
  });

  /*
   * THE CASE THE SECOND BUILD LOST (review, 2026-10-05). Gmail is the one service this person
   * connected. The model's own lookup for a calendar reaches Gmail's draft tool on 확인 — and the
   * answer said nothing of the calendar that could be connected, because "a connected service's
   * tool was found". Now the hit is handed over and the line still follows: Gmail is not on it,
   * the calendar is.
   */
  test("a weak hit on a connected stranger's tool does not silence it", () => {
    const draft = wire(
      "mcp__gmail__create_draft",
      "메일 초안을 만든다. 보내지 않는다 — 사람이 확인하고 보낸다. (gmail)",
    );
    const list = [
      ...NOBODYS,
      draft,
      card([
        ...on("gmail"),
        ...off("google-calendar", "google-sheets", "notion"),
      ]),
    ];
    const lines = linesOf(searchResultText(list, "캘린더 일정 확인"));
    expect(lines.some((line) => line.includes(`"name":"${draft.name}"`))).toBe(
      true,
    );
    expect(lines.at(-1)).toBe(
      lineFor(
        "구글 캘린더(google-calendar), 구글 시트(google-sheets), 노션(notion)",
      ),
    );
    // And a miss there still says what IS connected, before what could be.
    const miss = linesOf(searchResultText(list, "노션 페이지 만들기"));
    expect(miss[1]).toBe("지금 연결된 서비스: 지메일.");
    expect(miss.at(-1)).toBe(lines.at(-1));
  });

  test("with the right service connected its tool is handed over, and the line names only what is left", () => {
    // 톡캘린더 connected, Google's not: the calendar that is there is found, and nothing here
    // says to connect another — the line is the same fact as on any other lookup.
    const talk = wire(
      "mcp__kakao-playmcp__list_events",
      "톡캘린더의 일정을 기간으로 본다.",
    );
    const lines = linesOf(
      searchResultText(
        [...NOBODYS, talk, card([...OPEN, ...on("kakao-playmcp")])],
        "캘린더 일정 확인",
      ),
    );
    expect(lines[1]).toBe(
      JSON.stringify({
        name: talk.name,
        description: talk.description,
        parameters: talk.parameters,
      }),
    );
    expect(lines.at(-1)).toBe(LINE);
    expect(lines.at(-1)).not.toContain("kakao-playmcp");
  });

  /*
   * CALLABLE FROM THE LINE. A deferred tool is forwarded only once the conversation was shown its
   * schema: an argument written without one is a guess (`undescribedToolText`). The line gives the
   * card's whole shape — its name, its one required argument and the keys that may go in it — so a
   * conversation that was given the line has been told, and the 1,390 characters of the card's
   * schema need not ride on every lookup to make it so.
   */
  test("a conversation given the line may call the card; one that was not, may not", () => {
    const given = searchResultText(NOTHING, "캘린더 일정 조회");
    expect([...describedToolNames([given])]).toEqual([CONNECT_CARD]);
    // A lookup's answer with no such line — nothing left to connect — describes no card.
    const none = searchResultText(
      [...NOBODYS, card(on("gmail"))],
      "캘린더 일정 조회",
    );
    expect(describedToolNames([none]).has(CONNECT_CARD)).toBe(false);
    // The head somewhere inside a line is not the line: a page that quotes it describes nothing.
    expect(
      describedToolNames([`본문: ${OPEN_ACCOUNTS_HEAD}지메일(gmail).`]).size,
    ).toBe(0);
    // And a tool whose schema was handed over is described as it always was.
    expect(
      describedToolNames([
        searchResultText(NOTHING, "select:mcp__public-data__search_bids"),
      ]),
    ).toEqual(new Set(["mcp__public-data__search_bids", CONNECT_CARD]));
  });

  /*
   * ON, AND NOTHING TO WORK THROUGH. 카카오's toolbox is the person's own and may be empty; a
   * listing can fail at connect. Read as "not connected" — none of its tools are in the list — it
   * was offered the card, the card said "already on, look its tools up", and the lookup offered
   * the card again (review, 2026-10-05). The state is the connection's, so it is said as it is.
   */
  test("an account that is on and brought no tools is said as that, and never as something to connect", () => {
    const EMPTY =
      "연결돼 있지만 그 연결이 가져온 도구가 없는 계정: 카카오(kakao-playmcp). 연결 카드를 띄우지 않는다 — 이것이 필요한 일이면 연결은 돼 있는데 지금 쓸 도구가 없다고 사람에게 말한다.";
    const list = [...NOBODYS, card([...on("kakao-playmcp"), ...off("gmail")])];
    const lines = linesOf(searchResultText(list, "카카오톡 나에게 보내기"));
    expect(lines.slice(-2)).toEqual([EMPTY, lineFor("지메일(gmail)")]);
    // With nothing else left to connect there is no line, and the card is not callable from it.
    const only = searchResultText(
      [...NOBODYS, card(on("kakao-playmcp"))],
      "카카오톡 나에게 보내기",
    );
    expect(linesOf(only).at(-1)).toBe(EMPTY);
    expect(only).not.toContain(OPEN_ACCOUNTS_HEAD);
    expect(describedToolNames([only]).size).toBe(0);
  });

  test("nothing left to connect, nothing written on the card, or no card at all: the answer it always was", () => {
    const mail = wire("mcp__gmail__search_messages", "받은편지함을 찾는다.");
    const MISS = [
      "'노션 페이지 만들기'에 맞는 도구가 없다.",
      "지금 연결된 서비스는 없다.",
      "다시 찾지 않는다. 지금 쓸 수 있는 도구로 하거나, 할 수 없다고 사람에게 말한다.",
    ];
    for (const list of [
      // A window's card no turn wrote on, and a routine's list, which has no card.
      [...NOBODYS, card()],
      NOBODYS,
    ]) {
      expect(linesOf(searchResultText(list, "노션 페이지 만들기"))).toEqual(
        MISS,
      );
    }
    // Everything this deployment can connect is on, with its tools: look again, connect nothing.
    expect(
      linesOf(
        searchResultText(
          [...NOBODYS, mail, card(on("gmail"))],
          "노션 페이지 만들기",
        ),
      ),
    ).toEqual([
      MISS[0],
      "지금 연결된 서비스: 지메일.",
      "다른 말로 다시 찾아 본다. 그래도 없으면 지금 쓸 수 있는 도구로 하거나, 할 수 없다고 사람에게 말한다.",
    ]);
  });

  test("an account the bridge has no name for is said by its key, not by a name made up", () => {
    expect(
      lastOf(
        searchResultText(
          [...NOBODYS, card(off("gmail", "acme-crm"))],
          "고객 목록",
        ),
      ),
    ).toBe(lineFor("acme-crm, 지메일(gmail)"));
  });

  test("목표 and the fleet's keys are nobody's connection: a miss names none and is not looked for again", () => {
    expect([...DEPLOYMENT_FAMILIES]).toContain(GOALS_FAMILY);
    const lines = linesOf(searchResultText(NOBODYS, "노션 페이지 만들기"));
    expect(lines[1]).toBe("지금 연결된 서비스는 없다.");
    expect(lines[2]).toContain("다시 찾지 않는다");
    expect(familiesOf(NOBODYS.map((tool) => tool.name))).toEqual([
      "목표",
      "나라장터·기업마당",
    ]);
  });
});

/*
 * ONE SENTENCE IN THE CONTEXT LAYER, AND ONLY WHILE AN ACCOUNT IS LEFT TO CONNECT.
 *
 * A lookup's answer reaches only a Bot that looks, and the paragraph naming what is behind the
 * bridge says not to look for what it does not name. Taken at its word, the fleet's model answered
 * "오늘 일정 뭐 있어?" from its routines — "제가 챙기고 있는 일정은 없어요", of a calendar it never
 * read. Three ways of telling it were measured (2026-10-05, `docs/laf/eval-pack.md`): this sentence
 * (the card in 18 runs of 18), nothing (15), and a line naming the open accounts (11 — three of
 * them said "연결이 필요해요" and raised no card).
 */
describe("the names behind the bridge, while an account is left to connect", () => {
  const NAMES = [
    "mcp__goals__list_goals",
    "showBarChart",
    CONNECT_CARD,
    "computer_navigate",
  ];
  const SENTENCE =
    "다만 이 사람의 메일·캘린더 일정·시트처럼 계정을 연결해야 볼 수 있는 것은, 위에 그 도구가 없어도 못 본다고 답하기 전에 tool_search로 한 번 찾는다 — 연결을 권할 길이 답에 온다.";

  test("end on the one exception: look once for what needs an account before saying it cannot be seen", () => {
    expect(deferredToolsText(NAMES, ["gmail"]).split("\n").at(-1)).toBe(
      SENTENCE,
    );
  });

  test("the paragraph above it is the one every Bot has read, byte for byte, and the sentence names no account", () => {
    const without = deferredToolsText(NAMES);
    const withIt = deferredToolsText(NAMES, ["gmail", "notion"]);
    expect(withIt).toBe(`${without}\n${SENTENCE}`);
    // The same bytes whichever accounts are open: connecting one of several changes nothing here.
    expect(deferredToolsText(NAMES, ["cafe24"])).toBe(withIt);
  });

  test("with nothing left to connect there is no such sentence — nor in a routine, whose list has no card", () => {
    for (const open of [undefined, []]) {
      const text = deferredToolsText(NAMES, open);
      expect(text).not.toContain("다만");
      expect(text.split("\n").at(-1)?.startsWith("- ")).toBe(true);
    }
    // Nothing behind the bridge at all: no paragraph, whatever is open.
    expect(deferredToolsText(["computer_navigate"], ["gmail"])).toBe("");
  });
});

/*
 * THE ACCOUNTS A TURN WRITES ON THE CONNECT CARD (`shared/tools/gallery.ts`): the one carrier of
 * what a person could connect, from the server that read the connections to the bridge that
 * answers a lookup.
 */
describe("the accounts a turn writes on the connect card", () => {
  const declared = {
    type: "object",
    properties: { services: { type: "array", items: { type: "string" } } },
    required: ["services"],
  };
  const accounts: AccountState[] = [
    { key: "gmail", connected: false },
    { key: "notion", connected: true },
  ];

  test("are read back as written, beside a schema that is otherwise the window's", () => {
    const written = withAccountStates(declared, accounts);
    expect(accountStatesIn(written)).toEqual(accounts);
    expect(withoutAccountStates(written)).toEqual(declared);
    // The window's own object is not written to.
    expect(accountStatesIn(declared)).toBeNull();
    expect(Object.keys(declared)).not.toContain(ACCOUNT_STATES);
  });

  test("nothing written reads as null, and what is not a schema is left alone", () => {
    for (const none of [undefined, null, "services", 3]) {
      expect(accountStatesIn(none)).toBeNull();
      expect(withAccountStates(none, accounts)).toBe(none);
      expect(withoutAccountStates(none)).toBe(none);
    }
    // Rows that are not an account's state are not read as one.
    expect(
      accountStatesIn({
        [ACCOUNT_STATES]: [
          { key: "gmail", connected: false },
          { key: "notion" },
          "canva",
          null,
        ],
      }),
    ).toEqual([{ key: "gmail", connected: false }]);
  });

  test("the ones still open are read off a run's tools, for the context layer's one sentence", () => {
    const card = {
      name: CONNECT_CARD,
      parameters: withAccountStates(declared, accounts),
    };
    expect(openAccountsIn([{ name: "remember" }, card])).toEqual(["gmail"]);
    // A window's card no turn wrote on, a run with no card, and everything connected: none.
    expect(
      openAccountsIn([{ name: CONNECT_CARD, parameters: declared }]),
    ).toEqual([]);
    expect(openAccountsIn([{ name: "remember" }])).toEqual([]);
    expect(
      openAccountsIn([
        {
          name: CONNECT_CARD,
          parameters: withAccountStates(declared, [
            { key: "gmail", connected: true },
          ]),
        },
      ]),
    ).toEqual([]);
  });
});
