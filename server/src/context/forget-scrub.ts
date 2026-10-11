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

/**
 * Numbers of three digits or more — a price, a phone number, a count — as the whole token they
 * were said in, unit attached (300g, 9500원, 20260207번), commas inside the number and a particle
 * after it removed. Tokens, not digit runs: the first rule took any 3+-digit run of the fact as a
 * substring of the line's digits, so forgetting a jam sold in 300g jars dropped every line with
 * order 20260300 or 300 lids in it, and forgetting a unit price dropped every line that price's
 * digits ran through — 168 unrelated dated lines on a run's real summaries (third review of pull
 * request 196). Muse documents "forget" as removing the named thing and what is related to it; a
 * shared digit string is not relatedness.
 */
function numbersOf(text: string): string[] {
  return numberTokensOf(text).filter((token) => /^\d{3}/.test(token));
}

/** The tokens of a text with every digit-led one read as a number (`numberToken`). */
const numberTokensOf = (text: string) =>
  tokensOf(numberText(text)).map(numberToken);

/**
 * The text as the number clause reads it, before it is split into tokens (first review of pull
 * request 204): full-width digits and ㎏ as their plain forms; an identifier written in three or
 * more digit groups joined by one separator — a phone (010-1234-5678, 010.1234.5678, 010 1234
 * 5678), a business registration, an account — as one value, since the summariser writes it with
 * or without its separators. Three groups, not two: `9/14 20260300번` is a day and an order
 * number, 59 times on a run's real summaries, and `11,000-12,000원` is a range. A number glued to
 * the word before it (잼300g) is its own token.
 */
const numberText = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\d+(?:-\d+){2,}/g, (id) => id.replace(/-/g, ""))
    .replace(/\d+(?:\.\d+){2,}/g, (id) => id.replace(/\./g, ""))
    .replace(/\d+(?: \d+){2,}/g, (id) => id.replace(/ /g, ""))
    .replace(/(\p{L})(?=\d)/gu, "$1 ");

/**
 * Spellings of one unit the owner and the summariser interchange, read as one — the pairs the
 * memory evaluation already reads as the same fact (`evals/memory-days-facts.ts`: kg, ㎏, 킬로,
 * 키로, 킬로그램; g, 그램). 퍼센트 and 프로 read as the bare number, as % does once the tokens are
 * split. Small on purpose: 개 and EA are not here, EA being unseen in what the Bot writes.
 */
const UNIT_SPELLINGS: ReadonlyMap<string, string> = new Map([
  ["그램", "g"],
  ["킬로", "kg"],
  ["키로", "kg"],
  ["킬로그램", "kg"],
  ["밀리리터", "ml"],
  ["리터", "l"],
  ["센티", "cm"],
  ["센티미터", "cm"],
  ["미터", "m"],
  ["퍼센트", ""],
  ["프로", ""],
]);

/** Said after a measure and not part of it: 300g짜리, 300g씩, 300g정도. */
const MEASURE_SUFFIX = /(짜리|씩|정도|가량|쯤)$/;

/**
 * A digit-led token as the number it says: the unit in its one spelling, and whatever follows
 * the number stripped until nothing more comes off — `11,000원에는` carries two particles, and one
 * strip left `11000원에`, which met nothing (first review of pull request 204). Any other token is
 * returned as it is.
 */
function numberToken(token: string): string {
  if (!/^\d/.test(token)) return token;
  let said = token;
  for (;;) {
    const unit = splitNumber(said)[1];
    const spelled = UNIT_SPELLINGS.get(unit);
    if (spelled !== undefined) {
      said = said.slice(0, said.length - unit.length) + spelled;
      continue;
    }
    const shorter = said.replace(MEASURE_SUFFIX, "").replace(PARTICLE, "");
    if (shorter === said) return said;
    said = shorter;
  }
}

/**
 * Whether the line says one of the fact's numbers: the same whole token, or the same whole number
 * with the unit unsaid on one side — a summary writes a run of amounts as `212,000→429,000→646,000원`
 * and the owner writes `9,500 원` with a space. Never the same digits in a different unit (300g is
 * not 300개) and never a longer number the digits run through (300g is not 20260300번).
 */
function saysNumber(lineTokens: ReadonlySet<string>, number: string): boolean {
  if (lineTokens.has(number)) return true;
  const [digits, unit] = splitNumber(number);
  for (const token of lineTokens) {
    const [tokenDigits, tokenUnit] = splitNumber(token);
    if (tokenDigits !== digits) continue;
    if (unit === "" || tokenUnit === "") return true;
  }
  return false;
}

const splitNumber = (token: string): [digits: string, unit: string] => {
  const match = /^(\d+)(.*)$/.exec(token);
  return match ? [match[1] ?? "", match[2] ?? ""] : ["", token];
};

/**
 * A dated summary line: `- 9/21: …`, `- 9/14~9/16: …`, `- 2026-09-21: …`, `- 9.21: …`,
 * `- (9/21) …`, `1. 9/21: …`. Not `- 3/4분기: …` or `- 3.5kg: …`, where the figure is part of a
 * word. The summary's other lines are its standing facts (`day-close.ts`, `DAY_SUMMARY_SYSTEM`).
 */
export const isDated = (line: string) =>
  /^\s*(?:\d+[.)]\s*)?[-*•]?\s*\(?(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}|\d{1,2}월\s?\d{1,2}일)(?![\d\p{L}])/u.test(
    line,
  );

/** Every month, every week: a word every standing fact of a kind shares, so it names none. */
const RECURRENCE = new Set([
  "매달",
  "매월",
  "매주",
  "매일",
  "매년",
  "다달이",
  "달마다",
  "주마다",
  "월마다",
  "해마다",
]);

/** Said with a particle of its own before the sentence's — "지은이는" — a name needs two strips. */
const bareOf = (word: string) => {
  const shorter = word.replace(PARTICLE, "");
  return shorter.length >= 2 ? shorter : word;
};

/**
 * Weekday shorthand read as the weekday: `화·목`, `화, 목`, `월/수/금` → 화요일 …; not the 일 of 5일.
 * The last of a list keeps its particle (`화·목만`, `월/수/금에`) and is read too — only after a
 * separator, since `일만 원` and `수만 개` are not Sundays or Wednesdays. The unseparated form
 * (`화목`, `월수금`) is NOT read: whole tokens of weekday letters are ordinary words too often —
 * 수금 (collecting payment, a standing line of its own), 금일, 수일, 수목, 토목, 목화 — and a rule
 * that admits only weekday order still admits the first four.
 */
const weekdaysSpelled = (text: string) =>
  text.replace(
    /(?<![\p{L}\d])([월화수목금토일])(?=\s?[·,/]\s?[월화수목금토일]|[\s,.)]|$)|(?<=[월화수목금토일]\s?[·,/]\s?)([월화수목금토일])(?=[만에])/gu,
    "$1$2요일",
  );

/** The fact's tokens as said, commas inside a number removed, in order. */
const tokensOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/(\d),(?=\d{3})/g, "$1")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * THE STANDING-LINE ARM. A standing line is terse — a head and a value, `- 지은(포장 알바): 매주
 * 화·목 출근` — so it holds few of a notebook line's words: two of the six of "포장 알바 지은이는
 * 화요일과 목요일에만 출근한다.", under the ratio in `lineCarries`, and a forgotten standing fact
 * stayed in what the Bot is given on the rule arm, the floor this file promises when the judge
 * model is unavailable (review of pull request 196). But a line of the same kind shares words with
 * it that name nothing — a role (포장 알바), a recurrence (매달), the digits of a price or a day
 * (18,000원에 → "18"; 5일 inside 25일) — and a first arm that took any two words erased unrelated
 * standing facts: 민수's Saturdays for 지은's Tuesdays, a VAT date for the 정산 deadline (second
 * review of the same pull request). So the rule reads the line as `head: body`:
 *
 *   - the head holds one of the fact's words (any), so the line is about something the fact names;
 *   - the body holds a word of what the fact SAYS about its subject — a predicate word, not one of
 *     the subject phrase up to its 은/는/이/가, since "포장 알바" is a role two lines can share;
 *   - and either three of the fact's words are in the line altogether, or a number of the fact's is
 *     in the body as a whole token (5일, never 25일; 18000원, never 11000원).
 *
 * Digit-led words count only as that whole token; recurrence words never count; weekday shorthand
 * is read as the weekday on both sides, since the owner writes 화·목 on 수첩 too (third review of
 * the same pull request); a word counts with a second particle off (지은이 → 지은). A line with no
 * colon is its own head and body. A standing line that groups two people's days loses both —
 * forgetting errs that way, as the head of this file says.
 */
function standingLineCarries(line: string, fact: string): boolean {
  const said = tokensOf(weekdaysSpelled(fact));
  if (said.length === 0) return false;
  // The subject phrase: the tokens up to and including the first one marked 은/는/이/가/께서.
  let subjectEnd = said.findIndex((token) => /(은|는|이|가|께서)$/.test(token));
  if (subjectEnd < 0) subjectEnd = -1;
  const word = (token: string) => token.replace(PARTICLE, "");
  const usable = (token: string) =>
    token.length >= 2 && !COMMON.has(token) && !RECURRENCE.has(token);
  const spoken = said.map(word);
  const numbers = new Set(
    spoken.filter((token) => /^\d/.test(token) && usable(token)),
  );
  // One sieve for both halves: a digit-led token is a number, never a word (5일 is not in 25일).
  const wordy = (token: string) => usable(token) && !/^\d/.test(token);
  const subject = new Set(spoken.slice(0, subjectEnd + 1).filter(wordy));
  const predicate = new Set(spoken.slice(subjectEnd + 1).filter(wordy));
  const colon = line.indexOf(":");
  const headText = weekdaysSpelled(
    flat(colon >= 0 ? line.slice(0, colon) : line),
  );
  const bodyText = weekdaysSpelled(
    flat(colon >= 0 ? line.slice(colon + 1) : line),
  );
  const holds = (text: string, token: string) =>
    text.includes(token) || text.includes(bareOf(token));
  const headWords = [...subject, ...predicate].filter((token) =>
    holds(headText, token),
  );
  const bodyWords = [...predicate].filter((token) => holds(bodyText, token));
  const bodyTokens = new Set(tokensOf(bodyText).map(word));
  const bodyNumber = [...numbers].some(
    (number) => bodyTokens.has(number) || bodyTokens.has(bareOf(number)),
  );
  if (headWords.length === 0) return false;
  if (bodyWords.length === 0 && !bodyNumber) return false;
  const all = new Set([
    ...headWords,
    ...bodyWords,
    ...[...subject].filter((token) => holds(bodyText, token)),
  ]);
  /*
   * THE LIMIT OF THE NUMBER CLAUSE. A number stands in for the three words, so ONE fact word in the
   * head and one of the fact's numbers whole in the body carry the line — and a line of another
   * fact can have both: `- 세무사 상담료: 매달 5일 입금` for the 정산 deadline on the 5th, `- 결제:
   * 한일포장 10만 원 이상 …` for 대성유리's 10만 원, `- 저녁 마감: 6시` for the 6시 chat hours. Such a
   * line is lost (data loss, not a privacy failure). Measured on a run's real summaries it happened
   * 0 times in 21,564 line × fact checks, and no simpler rule did better (third review of pull
   * request 196), so the clause stands; the shapes are pinned as known limits in
   * `memory-forgetting.test.ts` so a change that closes one is seen.
   */
  return all.size >= 3 || bodyNumber;
}

/**
 * THE RULE: whether one summary line carries one forgotten fact. The fact word for word, any of
 * its numbers as a whole token (`saysNumber`), or most of its distinctive words (two at least) in
 * the line — a dated line's test; a standing line is also read as `head: body`
 * (`standingLineCarries`).
 */
export function lineCarries(line: string, fact: string): boolean {
  const here = flat(line);
  const said = flat(fact);
  if (!here || !said) return false;
  if (here.includes(said)) return true;
  const numbers = numbersOf(fact);
  if (numbers.length > 0) {
    const tokens = new Set(numberTokensOf(here));
    if (numbers.some((number) => saysNumber(tokens, number))) return true;
  }
  const words = distinctiveWords(fact);
  if (words.length === 0) return false;
  const found = words.filter((word) => here.includes(word)).length;
  if (found >= Math.min(2, words.length) && found / words.length >= 0.6) {
    return true;
  }
  return !isDated(line) && standingLineCarries(line, fact);
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
