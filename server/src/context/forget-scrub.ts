/**
 * FORGETTING THAT REALLY FORGETS — the day summaries lose what the owner forgot.
 *
 * A memory forgotten on 수첩 stopped reaching the model's memory paragraph at once
 * (`conversations.ts`, `memory_forgotten`). But the owner had usually SAID it in the conversation,
 * and the day's close summarises the conversation: the fact went into the summary, the summary is
 * carried into every later epoch (`withSummary`), and each night's close merges it forward. So the
 * Bot "forgot" a fact that its own frozen layer still stated — reported by the daily-epochs work
 * (2026-09-26), and the one place the fact can survive, since compaction writes no summaries of its
 * own: it drops tool calls and results, and a dropped result keeps only its first characters.
 *
 * So a summary is scrubbed line by line: at the forgetting, for the summary the conversation carries
 * and the close waiting for the next message; and at every later close, after the summariser has
 * been told the same lines (`day-close.ts`, `forgotten`). A line is DROPPED, never rewritten: a
 * rewrite is a model writing into the prompt again, where a drop can only take something out. A
 * summary bullet that held the forgotten fact beside another loses both; forgetting errs that way.
 *
 * Two judges, the way compaction has them: the model (Jev, the server model in Jev's shape behind
 * it) decides which lines carry a forgotten fact, and a deterministic rule — the fact's own words or
 * its numbers in the line — is applied under it whatever the model said, and alone when the model
 * cannot answer. The model catches a paraphrase; the rule is the floor.
 */

import type { JevAsker } from "./vendor/fast-jev-compaction/index";
import { redactText } from "./judge-redaction";

export type ScrubArm = "jev" | "model" | "rule";

export type SummaryScrubber = (input: {
  summary: string;
  forgotten: readonly string[];
}) => Promise<{ summary: string; removed: number; arm: ScrubArm }>;

/** At or above this, the judge's "this line carries a forgotten fact" drops the line. */
export const SCRUB_DROP = 0.5;

const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** What Korean attaches to a word and English does not: stripped so "서연이는" meets "서연". */
const PARTICLE =
  /(으로서|으로써|에서는|에게서|이라고|이라는|이에요|예요|입니다|이다|이고|으로|에서|에게|께서|한테|까지|부터|처럼|보다|이나|라고|라는|하고|은|는|이|가|을|를|의|에|로|와|과|도|만|요|다)$/;

/** Words that say nothing about which fact a line is: every summary says them. */
const COMMON = new Set([
  "사장님",
  "사장",
  "가게",
  "우리",
  "봇",
  "있음",
  "있다",
  "한다",
  "했다",
  "했음",
  "함",
  "그리고",
  "오늘",
  "내일",
  "어제",
  "the",
  "and",
  "owner",
  "shop",
]);

/** The words of a fact that could only be about it. */
export function distinctiveWords(fact: string): string[] {
  const words = fact
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.replace(PARTICLE, ""))
    .filter((word) => word.length >= 2 && !COMMON.has(word));
  return [...new Set(words)];
}

/** Numbers of three digits or more — a price, a phone number, a count — commas ignored. */
function numbersOf(text: string): string[] {
  return (text.replace(/(\d),(?=\d{3})/g, "$1").match(/\d{3,}/g) ?? []).filter(
    Boolean,
  );
}

/**
 * THE RULE: whether one summary line carries one forgotten fact. The fact word for word, any of
 * its numbers, or most of its distinctive words (two at least) in the line.
 */
export function lineCarries(line: string, fact: string): boolean {
  const here = flat(line);
  const said = flat(fact);
  if (!here || !said) return false;
  if (here.includes(said)) return true;
  const digits = here.replace(/(\d),(?=\d{3})/g, "$1");
  if (numbersOf(fact).some((number) => digits.includes(number))) return true;
  const words = distinctiveWords(fact);
  if (words.length === 0) return false;
  const found = words.filter((word) => here.includes(word)).length;
  return found >= Math.min(2, words.length) && found / words.length >= 0.6;
}

/** The lines a scrub looks at: a summary is written as bullet lines, one fact or event each. */
function linesOf(summary: string): string[] {
  return summary.split("\n");
}

/** The rule alone: every line some forgotten fact is carried by, dropped. */
export function scrubByRule(
  summary: string,
  forgotten: readonly string[],
): { summary: string; removed: number } {
  const lines = linesOf(summary);
  const kept = lines.filter(
    (line) => !forgotten.some((fact) => lineCarries(line, fact)),
  );
  return {
    summary: kept.join("\n").trim(),
    removed: lines.length - kept.length,
  };
}

/**
 * The scrubber: the model's decision with the rule under it. An asker that throws (Jev down and
 * its fallback down) leaves the rule's answer, which is never nothing.
 */
export function createSummaryScrubber(asker: JevAsker | null): SummaryScrubber {
  return async ({ summary, forgotten }) => {
    const facts = forgotten.map((fact) => fact.trim()).filter(Boolean);
    if (facts.length === 0 || !summary.trim()) {
      return { summary, removed: 0, arm: "rule" };
    }
    const lines = linesOf(summary);
    const ruled = new Set(
      lines.flatMap((line, at) =>
        facts.some((fact) => lineCarries(line, fact)) ? [at] : [],
      ),
    );
    const asked = lines.flatMap((line, at) =>
      line.trim() && !ruled.has(at) ? [at] : [],
    );
    let arm: ScrubArm = "rule";
    const judged = new Set<number>();
    if (asker && asked.length > 0) {
      try {
        const response = await asker.ask(
          {
            forgotten: facts.map(redactText),
            lines: Object.fromEntries(
              asked.map((at) => [`l${at}`, redactText(lines[at] ?? "")]),
            ),
          },
          Object.fromEntries(
            asked.map((at) => [
              `l${at}`,
              {
                type: "noul" as const,
                instructions: `Line l${at} in \`lines\` states, repeats, paraphrases or depends on one of the facts listed in \`forgotten\` — facts the owner told the assistant to forget.`,
              },
            ]),
          ),
        );
        for (const at of asked) {
          const answer = response.answers[`l${at}`];
          const p =
            answer && "noul" in answer && typeof answer.noul === "number"
              ? answer.noul
              : 0;
          if (p >= SCRUB_DROP) judged.add(at);
        }
        arm = /jev/i.test(response.model ?? "") ? "jev" : "model";
      } catch {
        arm = "rule";
      }
    }
    const kept = lines.filter((_, at) => !ruled.has(at) && !judged.has(at));
    return {
      summary: kept.join("\n").trim(),
      removed: lines.length - kept.length,
      arm,
    };
  };
}
