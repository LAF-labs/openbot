import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_RESULT_KO } from "../../shared/prompt/tool-results.ko";
import { ko } from "../src/lib/i18n-ko";
import { TURN_NOTICES } from "../src/lib/copilot/stopped-turn";

/**
 * A tool result has two readers, and they are not owed the same sentence.
 *
 * The MODEL reads "이 행동을 다시 시도하지 마라 — 같은 거절이 돌아온다", which tells it what to do
 * next. The PERSON reads "사람이 컴퓨터를 잡고 있음" on a transcript line, which tells them what
 * happened. One fact code carries both, and neither is written in English by a service that has
 * never heard of a locale — which is what shipped: `agent-computer` sent an English paragraph and
 * the surface printed it.
 *
 * Both tables are `t()` and lookups on a VARIABLE, so `i18n-coverage.test.ts` cannot see either.
 * They are checked in and finite, so they are walked instead — the same arrangement the audit
 * labels and the model failures have.
 */

const OUTCOME_LABELS = labelsFrom(
  readFileSync(
    join(import.meta.dir, "../src/lib/copilot/computer-tools.tsx"),
    "utf8",
  ),
);

/** The label table out of its own source, so this cannot pass against a table that moved. */
function labelsFrom(source: string): Record<string, string> {
  const block = source.match(
    /const OUTCOME_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/,
  );
  if (!block?.[1]) throw new Error("OUTCOME_LABELS is not where it was.");
  return Object.fromEntries(
    [...block[1].matchAll(/"(laf:[a-z_]+)":\s*\n?\s*"([^"]+)"/g)].map(
      (match) => [match[1] as string, match[2] as string],
    ),
  );
}

describe("what a tool result says to each of its readers", () => {
  test("every code the surface labels has Korean for the person", () => {
    expect(Object.keys(OUTCOME_LABELS).length).toBeGreaterThan(0);
    const missing = Object.values(OUTCOME_LABELS).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("every code the surface labels has Korean for the model too", () => {
    // A code with a line but no model sentence would reach the Bot as `laf:` and an identifier.
    const missing = Object.keys(OUTCOME_LABELS).filter(
      (code) => !(code in TOOL_RESULT_KO),
    );
    expect(missing).toEqual([]);
  });

  test("no code reaches either reader as the code itself", () => {
    for (const [code, label] of Object.entries(OUTCOME_LABELS)) {
      expect(label).not.toContain("laf:");
      expect(TOOL_RESULT_KO[code]).not.toContain("laf:");
    }
  });

  /*
   * The two are deliberately different sentences. If one table were a copy of the other, the model
   * would be reading a transcript label ("중단됨") instead of an instruction, which is how a Bot
   * ends up retrying the thing it was just told not to.
   */
  test("the person's words and the model's words are not the same words", () => {
    for (const [code, label] of Object.entries(OUTCOME_LABELS)) {
      expect(TOOL_RESULT_KO[code]).not.toBe(label);
    }
  });

  test("every model-facing sentence is Korean", () => {
    for (const [code, sentence] of Object.entries(TOOL_RESULT_KO)) {
      const hangul = [...sentence].filter((character) =>
        /[가-힣]/.test(character),
      ).length;
      expect({ code, hangul: hangul > 3 }).toEqual({ code, hangul: true });
    }
  });
});

/**
 * A truncated or an empty answer is not an error, so it arrives as a CUSTOM event on the Bot's own
 * stream — the same channel the token counts use. Without words it would be a name on a screen.
 */
describe("what the surface says about a turn that did not come back whole", () => {
  test("every notice has Korean", () => {
    const missing = Object.values(TURN_NOTICES).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("names the two things a person cannot otherwise tell from a short answer", () => {
    expect(Object.keys(TURN_NOTICES).sort()).toEqual([
      "laf.answer_truncated",
      "laf.empty_answer",
    ]);
  });
});
