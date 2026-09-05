import { describe, expect, test } from "bun:test";
import { SEND_MESSAGE } from "../server/src/rooms/send-message";
import {
  BRIDGE_TOOLS,
  bridgeTools,
  DEFERRED_TOOL_PREFIX,
  DEFERRED_TOOLS_HINT_KO,
  describeResultText,
  exposureOf,
  familiesOf,
  isBridgeToolName,
  oneLine,
  resolveDeferred,
  SEARCH_LIMIT,
  searchResultText,
  searchTools,
  splitExposure,
  unwrapToolCall,
  type WireTool,
} from "../shared/tools/bridge";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
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

  test("every self tool, the room's voice, and asking a coworker", () => {
    for (const tool of SELF_TOOLS) {
      expect(exposureOf(tool.name)).toBe("core");
    }
    expect(exposureOf(SEND_MESSAGE)).toBe("core");
    // Registered in `app/src/lib/copilot/coworker-tools.tsx` under this literal name.
    expect(exposureOf("ask_coworker")).toBe("core");
  });

  test("the bridge itself", () => {
    for (const tool of BRIDGE_TOOLS) {
      expect(exposureOf(tool.name)).toBe("core");
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

  test("returns at most eight, each with a one-line description", () => {
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
});

describe("tool_describe", () => {
  test("hands back the whole schema by exact name", () => {
    const described = JSON.parse(
      describeResultText(CONNECTED, "mcp__gmail__send_message"),
    ) as { name: string; parameters: { properties: Record<string, unknown> } };
    expect(described.name).toBe("mcp__gmail__send_message");
    expect(Object.keys(described.parameters.properties)).toEqual([
      "to",
      "subject",
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
    const text = describeResultText(CONNECTED, "mcp__gmail__send");
    expect(text).toContain("없다");
    expect(text).toContain("mcp__gmail__send_message");
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

  test("tool_search's description names what is connected this run", () => {
    const search = bridgeTools(CONNECTED).find(
      (tool) => tool.name === "tool_search",
    );
    expect(search?.description).toContain(
      "지메일, 구글 시트, 카페24, 카카오 알림톡",
    );
    const bare = BRIDGE_TOOLS.find((tool) => tool.name === "tool_search");
    expect(bare?.description).toContain("연결된 서비스는 없다");
  });

  test("the prompt line the context tier can pick up names all three bridge tools", () => {
    for (const name of ["tool_search", "tool_describe", "tool_call"]) {
      expect(DEFERRED_TOOLS_HINT_KO).toContain(name);
    }
  });

  test("a one-line description is the first sentence, bounded", () => {
    expect(oneLine("메일을 실제로 보낸다. 보낸 메일은 되돌릴 수 없다.")).toBe(
      "메일을 실제로 보낸다.",
    );
    expect(oneLine("가".repeat(300)).length).toBeLessThanOrEqual(120);
  });
});
