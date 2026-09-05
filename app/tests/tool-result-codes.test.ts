import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_RESULT_KO } from "../../shared/prompt/tool-results.ko";
import { auditFactCodes } from "../../server/src/audit";
import { REFUSAL_SAID } from "../src/lib/components/queries";
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
 * THE SAME ARRANGEMENT, ONE LAYER OVER: A COMPONENT THIS BOT WAS NOT GIVEN.
 *
 * These refusals were the last English sentences the server was still assembling for a screen —
 * `${row.title} has been withheld from this Bot in this deployment…`, composed in `components/
 * store.ts` and printed verbatim into the audit table's Korean 결정 column AND onto the card a
 * person is looking at when nothing appears. One string, three readers, written for none of them.
 *
 * Walked here rather than in `audit-labels.test.ts` because the audit test already covers the
 * trail's own words. What it cannot see is the OTHER two readers, and a code with a column label
 * and nothing else would reach a person as `laf:component_withheld` in the middle of a
 * conversation — which is the failure this whole mechanism exists to prevent.
 */
/**
 * The refusals a MODEL can be handed, as opposed to the ones only a card and the trail ever see.
 *
 * `laf:read_failed` is the fifth thing `REFUSAL_SAID` answers for and it is deliberately not here:
 * it comes back to the component's own fetch, never to a tool call, so it needs the person's words
 * and no model's. The rest are returned straight out of a tool handler.
 */
const TOLD_TO_THE_MODEL = [
  "laf:component_unknown",
  "laf:component_not_published",
  "laf:component_withheld",
  "laf:function_unknown",
  "laf:function_not_granted",
] as const;

describe("what a refused component says to each of its readers", () => {
  test("every code has words for the person", () => {
    expect(Object.keys(REFUSAL_SAID).length).toBeGreaterThan(0);
    const missing = Object.values(REFUSAL_SAID).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("every code the SERVER can send a card has words for the person", () => {
    // Against the server's own list, imported rather than copied — the same arrangement the audit
    // labels have. A refusal added there with nothing said here reaches a card as an identifier.
    const said = new Set(Object.keys(REFUSAL_SAID));
    const known = new Set<string>(auditFactCodes);
    for (const code of TOLD_TO_THE_MODEL) {
      expect({ code, listed: known.has(code) }).toEqual({ code, listed: true });
      expect({ code, said: said.has(code) }).toEqual({ code, said: true });
    }
  });

  test("every code the model can be handed has Korean for the model", () => {
    const missing = TOLD_TO_THE_MODEL.filter(
      (code) => !(code in TOOL_RESULT_KO),
    );
    expect(missing).toEqual([]);
  });

  test("no code reaches either reader as the code itself", () => {
    for (const [code, sentence] of Object.entries(REFUSAL_SAID)) {
      expect(code.startsWith("laf:")).toBe(true);
      expect(sentence).not.toContain("laf:");
      expect(ko[sentence]).not.toContain("laf:");
    }
  });

  /*
   * Three lengths for three readers, and the failure this guards is the tempting one: filling the
   * tables by copying, which hands a person an instruction written for a model ("다시 시도하지
   * 말고 글로 답해라") on a card in their own conversation.
   */
  test("the person's words are not the model's words", () => {
    for (const code of TOLD_TO_THE_MODEL) {
      const sentence = REFUSAL_SAID[code] as string;
      expect(TOOL_RESULT_KO[code]).not.toBe(ko[sentence]);
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
