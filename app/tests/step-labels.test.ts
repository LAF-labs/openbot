import { describe, expect, test } from "bun:test";
import { COMPUTER_TOOLS } from "@shared/tools/computer";
import { NOW_TOOL_NAME } from "@shared/tools/now";
import { ROUTINE_NOTE } from "@shared/tools/routine-note";
import { SELF_TOOLS } from "@shared/tools/self";
import { SKILL_VIEW } from "@shared/tools/skills";
import { BRIDGE_TOOL_NAMES, DEFERRED_TOOL_PREFIX } from "@shared/tools/bridge";
import {
  SERVICE_STEP_LABELS,
  STEP_LABELS,
  stepLineOf,
} from "../src/lib/copilot/step-labels";
import { ko } from "../src/lib/i18n-ko";

/**
 * The step lines a transcript draws, in the owner's words (2026-09-27: "tool_search" and
 * "search_support_programs · public-data" on a shop owner's first task).
 *
 * The tables are read through `t(variable)`, which `i18n-coverage.test.ts` cannot see, so they are
 * walked here — and so is every tool a Bot can be handed: the shared core list, and every tool the
 * server's catalogue ships. A tool added on either side fails here until somebody decides what the
 * owner calls it.
 */

/**
 * Whether a line reads in Korean in a Korean window. `t()` answers in the process's own language,
 * which under `bun test` is English, so a label is its English key — and that key has to have a
 * Korean entry, or the Korean window shows the English.
 */
const inKorean = (text: string | undefined) =>
  text !== undefined && KOREAN.test(ko[text] ?? "");
const KOREAN = /[가-힣]/;

describe("the step labels", () => {
  test("every label in the tables has Korean", () => {
    const missing = [
      ...Object.values(STEP_LABELS),
      ...Object.values(SERVICE_STEP_LABELS),
      "Used {service}",
      "Used a connected service",
      "Used a tool",
    ].filter((label) => !(label in ko));
    expect(missing).toEqual([]);
  });

  test("every core tool and the bridge's two have a line of their own", () => {
    const core = [
      ...COMPUTER_TOOLS.map((tool) => tool.name),
      ...SELF_TOOLS.map((tool) => tool.name),
      SKILL_VIEW.name,
      ROUTINE_NOTE.name,
      NOW_TOOL_NAME,
      ...BRIDGE_TOOL_NAMES,
    ];
    expect(core.filter((name) => !(name in STEP_LABELS))).toEqual([]);
  });

  test("every tool the server's catalogue ships reads in Korean, never as its name", async () => {
    const { CATALOGUE } = await import("../../server/src/plugins/catalogue");
    const { PUBLIC_DATA_TOOLS } = await import(
      "../../server/src/plugins/public-data-rest"
    );
    const { ALIMTALK_TOOLS } = await import(
      "../../server/src/plugins/alimtalk/tools"
    );
    /*
     * The REST adapters keep their tool lists private, so their names are read out of the source,
     * the way `agent-refusals.test.ts` reads the server's codes: imported, the list would have to be
     * exported for this test alone.
     */
    const shipped: Array<{ server: string; tool: string }> = [];
    for (const entry of CATALOGUE) {
      if (entry.transport?.endsWith("-rest")) {
        const source = await Bun.file(
          new URL(
            `../../server/src/plugins/${entry.transport}.ts`,
            import.meta.url,
          ),
        ).text();
        const names = [...source.matchAll(/^ {4}name: "([a-z_]+)",$/gm)].map(
          (match) => match[1] as string,
        );
        expect(names.length).toBeGreaterThan(0);
        for (const tool of names) shipped.push({ server: entry.key, tool });
      }
    }
    for (const spec of PUBLIC_DATA_TOOLS) {
      shipped.push({ server: "public-data", tool: spec.name });
    }
    for (const spec of ALIMTALK_TOOLS) {
      shipped.push({ server: "kakao-alimtalk", tool: spec.name });
    }
    expect(shipped.length).toBeGreaterThan(20);

    const unnamed = shipped.filter(({ server, tool }) => {
      const line = stepLineOf(`${DEFERRED_TOOL_PREFIX}${server}__${tool}`);
      return (
        !inKorean(line.label) ||
        line.label.includes(tool) ||
        !inKorean(line.detail)
      );
    });
    expect(unnamed).toEqual([]);

    // Every service has a title for a tool of its own nobody named here — Notion's tools are its
    // own MCP server's — and the line is that title, never the tool.
    for (const entry of CATALOGUE) {
      const line = stepLineOf(`${DEFERRED_TOOL_PREFIX}${entry.key}__some_tool`);
      expect(line.label).not.toContain("some_tool");
      expect(line.label).not.toBe("Used a connected service");
    }
  });

  test("the two the owner saw on the walk", () => {
    expect(stepLineOf("tool_search").label).toBe("Finding a tool");
    expect(stepLineOf("mcp__public-data__search_support_programs")).toEqual({
      label: "Searching support programmes",
      detail: "Public tenders and support programmes",
    });
    expect(stepLineOf("mcp__public-data__search_bids").label).toBe(
      "Searching public tenders",
    );
    expect(ko["Finding a tool"]).toBe("도구 찾는 중");
    expect(ko["Searching support programmes"]).toBe("지원사업 공고 찾기");
    expect(ko["Searching public tenders"]).toBe("입찰공고 찾기");
    expect(ko["Public tenders and support programmes"]).toBe(
      "나라장터·기업마당",
    );
  });

  test("a tool nobody named still never shows its name", () => {
    expect(stepLineOf("sales_chart_widget").label).toBe("Used a tool");
    expect(stepLineOf("mcp__custom-crm__create_ticket").label).toBe(
      "Used a connected service",
    );
    expect(stepLineOf("mcp__notion__notion-search").label).toBe("Used Notion");
  });
});
