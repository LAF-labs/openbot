import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  estimateTokens,
  SKILL_INDEX_MAX_TOKENS,
  skillIndexText,
} from "../shared/prompt/skill-index";
import {
  normalizeSkillName,
  SKILL_TOOLS,
  SKILL_VIEW,
} from "../shared/tools/skills";

/**
 * What a Bot is told about its skills, and the tool it reads one with.
 *
 * The index is a prompt cost paid on every turn, so its cap is the property that matters: a
 * deployment that installs forty skills must not turn every conversation into a forty-line
 * catalogue. The tool is a catalogue entry like the computer's, registered from the same object by
 * both consumers and described nowhere else.
 */

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const skill = (
  at: number,
  summary = `${at}번 창고의 재고를 세고 표로 정리한다`,
) => ({
  slug: `skill-${at}`,
  summary,
});

describe("the skill index in the prompt", () => {
  test("says nothing when a Bot holds nothing", () => {
    expect(skillIndexText([])).toBe("");
    expect(skillIndexText([{ slug: "  ", summary: "x" }])).toBe("");
  });

  test("lists a name and one line, and says how to read the body", () => {
    const text = skillIndexText([
      { slug: "재고정리", summary: "창고 재고를 세고 표로 정리한다" },
    ]);
    expect(text).toContain("- /재고정리 — 창고 재고를 세고 표로 정리한다");
    expect(text).toContain("skill_view");
    expect(text.split("\n")).toHaveLength(2);
  });

  test("flattens a pasted paragraph into one line and cuts a long one", () => {
    const text = skillIndexText([
      { slug: "a", summary: "첫 줄\n\n둘째 줄   셋째" },
      { slug: "b", summary: "가".repeat(200) },
    ]);
    expect(text).toContain("- /a — 첫 줄 둘째 줄 셋째");
    const long = text.split("\n").find((line) => line.startsWith("- /b"));
    expect(long?.endsWith("…")).toBe(true);
    expect((long ?? "").length).toBeLessThan(100);
  });

  test("a skill with no summary is still listed", () => {
    expect(skillIndexText([{ slug: "a", summary: "" }])).toContain(
      "- /a — (설명 없음)",
    );
  });

  test("stays under the token cap however many skills a Bot holds", () => {
    const many = Array.from({ length: 300 }, (_, at) =>
      skill(at, "가나다라마바사아자차카타파하".repeat(6)),
    );
    const text = skillIndexText(many);
    expect(estimateTokens(text)).toBeLessThanOrEqual(SKILL_INDEX_MAX_TOKENS);
    // The ones that did not fit are counted, so the Bot knows there is more to ask for.
    const shown = text.split("\n").filter((line) => line.startsWith("- /"));
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.length).toBeLessThan(300);
    expect(text).toContain(`…외 ${300 - shown.length}개`);
    // In the order given: the first page is the first page.
    expect(shown[0]).toContain("/skill-0 ");
  });

  test("a short catalogue is shown whole, with no tail", () => {
    const text = skillIndexText(
      Array.from({ length: 12 }, (_, at) => skill(at)),
    );
    expect(
      text.split("\n").filter((line) => line.startsWith("- /")),
    ).toHaveLength(12);
    expect(text).not.toContain("…외");
    expect(estimateTokens(text)).toBeLessThanOrEqual(SKILL_INDEX_MAX_TOKENS);
  });

  test("the estimate counts Korean by the character and ASCII by the word", () => {
    // Conservative on purpose: it must over-count rather than let the cap be crossed.
    expect(estimateTokens("가나다")).toBe(3);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("the skill_view tool", () => {
  test("is one catalogue entry with a name argument", () => {
    expect(SKILL_TOOLS).toEqual([SKILL_VIEW]);
    expect(SKILL_VIEW.name).toBe("skill_view");
    expect(SKILL_VIEW.description.length).toBeGreaterThan(20);
    expect(SKILL_VIEW.parameters.required).toEqual(["name"]);
    expect(SKILL_VIEW.parameters.properties).toHaveProperty("name");
  });

  test("reads the name a model gives the way the index wrote it", () => {
    expect(normalizeSkillName("/재고정리")).toBe("재고정리");
    expect(normalizeSkillName("  Daily-Standup ")).toBe("daily-standup");
    expect(normalizeSkillName("//x")).toBe("x");
  });

  /**
   * The same rule `tool-catalogue.test.ts` keeps for the computer's tools: both consumers register
   * from the one object and write no description of their own.
   */
  test("the surface and the unattended loop register it from the catalogue", () => {
    const surface = read("app/src/lib/copilot/skill-tools.tsx");
    expect(surface).toContain('from "@shared/tools/skills"');
    expect(surface).toContain("SKILL_VIEW.description");
    expect([...surface.matchAll(/description:\s*("|`)/g)]).toEqual([]);

    const loop = read("server/src/runner/unattended.ts");
    expect(loop).toContain('from "../../../shared/tools/skills"');
    expect(loop).toContain("SKILL_VIEW.description");
  });
});
