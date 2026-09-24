import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_RESULT_KO } from "../../shared/prompt/tool-results.ko";
import { auditFactCodes } from "../../server/src/audit";
import { REFUSAL_SAID } from "../src/lib/components/queries";
import { OUTCOME_LABELS } from "../src/lib/computer/outcome-labels";
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

/*
 * The transcript line's table is imported since 2026-09-14, when it moved out of `computer-tools.tsx`
 * into a module of its own (`lib/computer/outcome-labels.ts`). It was parsed out of that file's source
 * before, so the test could not pass against a table that had moved; the import fails loudly instead.
 *
 * Since 2026-09-24 the words for a line are chosen in `lib/computer/browsing.ts`, which both the task
 * card and the file lines in `computer-tools.tsx` read — so that is the file that must import it.
 */
describe("what a tool result says to each of its readers", () => {
  test("the transcript line is the table the line's words are chosen from", () => {
    const words = readFileSync(
      join(import.meta.dir, "../src/lib/computer/browsing.ts"),
      "utf8",
    );
    expect(words).toContain(
      'import { OUTCOME_LABELS } from "@/lib/computer/outcome-labels";',
    );
    const tools = readFileSync(
      join(import.meta.dir, "../src/lib/copilot/computer-tools.tsx"),
      "utf8",
    );
    // And no second table beside either for a code to be added to instead.
    for (const source of [words, tools]) {
      expect(source).not.toMatch(/const OUTCOME_LABELS/);
    }
    expect(tools).toContain('from "@/lib/computer/browsing"');
  });

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
 * A Bot's own tools — `manage_routine`, `update_profile`, `remember` — hand the route's refusal code
 * to the model through this table, and a code with no sentence reaches the Bot as an identifier.
 *
 * The schedule refusals were English sentences with no code until 2026-09-11 (audit A1-3), so they
 * all collapsed into "봇과 일정을 먼저 정해야 한다" whatever was actually wrong; the Bot could not
 * tell a bad time from a missing day. Walked against the server's own source, like the tables above.
 */
describe("what a Bot's own tools are told when a route refuses them", () => {
  test("every routine refusal the routes can send has words for the model", () => {
    /*
     * Every module of the routine service and its routes, not `service.ts` alone: since the service
     * was split by responsibility (2026-09-14) a refusal lives in the module that makes it —
     * `schedule.ts`, `store.ts` — and `service.ts` is the door. The suggestion files have their own
     * refusals and their own walk (`routine-suggestions.test.tsx`).
     */
    const directory = join(import.meta.dir, "../../server/src/routines");
    const source = readdirSync(directory)
      .filter((name) => name.endsWith(".ts") && !name.startsWith("suggestion"))
      .map((name) => readFileSync(join(directory, name), "utf8"))
      .join("\n");
    const codes = new Set(
      [...source.matchAll(/"(laf:routine_[a-z_]+)"/g)].map(
        (match) => match[1] as string,
      ),
    );
    // A webhook's refusal, never a Bot tool's: the tool calls the session routes, not `/trigger`.
    codes.delete("laf:routine_trigger_token_missing");
    expect(codes.size).toBeGreaterThan(8);
    expect([...codes].filter((code) => !(code in TOOL_RESULT_KO))).toEqual([]);
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
