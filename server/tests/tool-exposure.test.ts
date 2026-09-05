import { describe, expect, test } from "bun:test";
import { exposeTools, schemaBytesOf } from "../../agent-bot/src/deferral";
import {
  connectedServiceTools,
  measureSchema,
  REALISTIC_TOOLSET,
} from "../../evals/deferral";
import {
  DEFERRED_TOOL_PREFIX,
  exposureOf,
  FAMILY_LABELS_KO,
  isDeferredToolName,
  searchTools,
} from "../../shared/tools/bridge";
import { ALIMTALK_TOOLS } from "../src/plugins/alimtalk/tools";
import { CATALOGUE } from "../src/plugins/catalogue";
import { toolNameFor } from "../src/plugins/store";

/**
 * The bridge against the real adapters: the names the server mints, the words the vendors' tools
 * actually carry, and the schema a Bot with everything connected is handed.
 *
 * `tests/tool-bridge.test.ts` pins the rule on hand-written tools; this pins it on the product's
 * own, because the search quality that matters is over THESE descriptions and the byte count that
 * matters is of THIS schema.
 */

describe("the name the server mints is the deferral flag", () => {
  test("every connected-service tool is deferred, by the one prefix", () => {
    expect(toolNameFor("gmail/send_message")).toBe(
      `${DEFERRED_TOOL_PREFIX}gmail__send_message`,
    );
    expect(isDeferredToolName(toolNameFor("gmail/send_message"))).toBe(true);
    for (const tool of ALIMTALK_TOOLS) {
      expect(exposureOf(toolNameFor(`kakao-alimtalk/${tool.name}`))).toBe(
        "deferred",
      );
    }
  });

  test("every adapter's tool, as the surface would register it", async () => {
    const connected = await connectedServiceTools();
    // Sheets 4, Gmail 4, Calendar 2, Business Profile 3, Cafe24 5, Drive 4, alimtalk 2.
    expect(connected.length).toBeGreaterThanOrEqual(20);
    for (const tool of connected) {
      expect(exposureOf(tool.name)).toBe("deferred");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  test("every catalogue entry has a Korean family name for tool_search to say", () => {
    for (const entry of CATALOGUE) {
      expect(FAMILY_LABELS_KO[entry.key]).toBeDefined();
      expect(FAMILY_LABELS_KO[entry.key]).toMatch(/[가-힣]/);
    }
  });
});

describe("tool_search over the adapters' own words", () => {
  const first = async (query: string) =>
    searchTools(await connectedServiceTools(), query)[0]?.name;

  test("Korean", async () => {
    expect(await first("메일 보내줘")).toBe("mcp__gmail__send_message");
    expect(await first("시트에 행 추가해줘")).toBe(
      "mcp__google-sheets__append_sheet_row",
    );
    expect(await first("주문 목록 보여줘")).toBe("mcp__cafe24__list_orders");
    expect(await first("알림톡 보내기")).toBe(
      "mcp__kakao-alimtalk__alimtalk_send",
    );
    expect(await first("리뷰에 답글 달기")).toBe(
      "mcp__google-business-profile__reply_to_review",
    );
    expect(await first("일정 만들기")).toBe(
      "mcp__google-calendar__create_event",
    );
  });

  test("English", async () => {
    expect(await first("send an email")).toBe("mcp__gmail__send_message");
    expect(await first("list orders")).toBe("mcp__cafe24__list_orders");
    expect(await first("create calendar event")).toBe(
      "mcp__google-calendar__create_event",
    );
  });
});

describe("what the bridge saves on the product's whole schema", () => {
  test("the schema a Bot with everything connected is handed, before and after", () => {
    const measured = measureSchema(REALISTIC_TOOLSET);
    // The shape the design was sized for: fourteen computer, three self, ~twenty connected.
    expect(measured.tools).toBeGreaterThanOrEqual(37);
    expect(measured.deferred).toBeGreaterThanOrEqual(20);
    /*
     * Measured on 2026-09-06: 23,175 B → 13,166 B (−43%), 15,817 → 8,295 characters (−48%).
     * Less than Hermes's −56% because the core tools' descriptions are Korean and three bytes a
     * character; the floors below are what the bridge must keep, not that number.
     */
    expect(measured.bytesDeferred).toBeLessThan(measured.bytes * 0.6);
    expect(measured.charsDeferred).toBeLessThan(measured.chars * 0.6);
    // The bridge itself must stay cheap, or it is three tools' worth of the thing it saves.
    expect(measured.bytesBridge).toBeLessThan(2_000);
  });

  test("a Bot with nothing connected pays nothing for the bridge", () => {
    const core = REALISTIC_TOOLSET.filter(
      (tool) => !isDeferredToolName(tool.name),
    );
    const exposed = exposeTools(core, true);
    expect(exposed.provider).toEqual(core);
    expect(schemaBytesOf(exposed.provider)).toBe(schemaBytesOf(core));
  });
});
