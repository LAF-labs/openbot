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
 * THE NUMBER CLAUSE, BY CONSTRUCTION. The first rule took any 3+-digit run of the fact as a
 * substring of the line's digits, so forgetting a jam sold in 300g jars dropped every line with
 * order 20260300 or 300 lids in it — 168 unrelated dated lines on a run's real summaries (third
 * review of pull request 196). Four cuts of a reading that compared tokens, then canonical
 * numbers, each lost a writing of the same number the summariser uses (`11,000원에는`, `010
 * 1234-5678`, `300그램병`, `2026년 10월 11일`, `1억2천만`, `300/500/700g`, `300분` — the four reviews
 * of pull request 204): a parser of Korean numbers always has one more reading, and a line it
 * misreads is a forgotten fact kept. So the clause is built so that what the first rule carried
 * is carried, with two exemptions that can be checked, and a reading that can only ADD:
 *
 *   carried = (oldSubstringCarries AND NOT clearlyAnotherNumber) OR readingsMeet
 *
 *   - `oldSubstringCarries` is the first rule, as it was, kept as a function so the dated
 *     differential cannot drift — on the text as written and on the text folded (full-width
 *     digits, every dash, every space, the middle dots), which can only find more;
 *   - `clearlyAnotherNumber` exempts a line only when EVERY place a number of the fact's occurs
 *     in it is positively something else: (a) inside a longer run of digits with nothing between
 *     them (the 300 in 20260300; not the 300 in 300/500/700, not a group of an identifier), or
 *     (b) followed by a recognised unit of a DIFFERENT DIMENSION than the one after the fact's
 *     number (300개 for 300g; not 300분 for 300명, since 분 counts people too; not 300kg for 300g).
 *     An unrecognised or absent unit on either side, or anything in doubt, is not exempt: the
 *     line goes, since keeping what a person asked to forget is the worse error, as the head of
 *     this file says;
 *   - `readingsMeet` is what the clause adds on top: both sides read as the numbers they say
 *     (`numbersIn` — an amount in scale words as its value, an identifier as one value whatever
 *     its separators, a date with its year as one value) and the same whole value met. It never
 *     takes a carry away, so a reading that goes wrong — 조 as a counter, a numeric list — can at
 *     worst add one.
 *
 * THE INVARIANT, by that construction: every (line, fact) pair the first rule carried is still
 * carried unless `clearlyAnotherNumber` says why, and the why is (a) or (b). `memory-forgetting
 * .test.ts` walks it over every pair it holds and over Codex's quoted calls; the run's real
 * summaries were walked with the same functions. Muse documents "forget" as removing the named
 * thing and what is related to it; the dimensions are where relatedness can be told for sure.
 */
export type SaidNumber = { value: string; unit: string };

/**
 * Recognised units, every spelling to its one name — the pairs `evals/memory-days-facts.ts`
 * reads as one fact (kg, ㎏, 킬로, 키로, 킬로그램; g, 그램) and the units a shop's summary says.
 * Matched longest spelling first, so `kg` is not `g` and `개월` is not `개`.
 */
const UNITS: ReadonlyArray<[spelling: string, unit: string]> = (
  [
    ["kg", "kg"],
    ["킬로그램", "kg"],
    ["킬로", "kg"],
    ["키로", "kg"],
    ["mg", "mg"],
    ["밀리그램", "mg"],
    ["g", "g"],
    ["그램", "g"],
    ["그람", "g"],
    ["ml", "ml"],
    ["밀리리터", "ml"],
    ["밀리", "ml"],
    ["l", "l"],
    ["리터", "l"],
    ["km", "km"],
    ["킬로미터", "km"],
    ["mm", "mm"],
    ["밀리미터", "mm"],
    ["cm", "cm"],
    ["센티미터", "cm"],
    ["센티", "cm"],
    ["m", "m"],
    ["미터", "m"],
    ["원", "원"],
    ["개월", "개월"],
    ["개", "개"],
    ["ea", "개"],
    ["병", "병"],
    ["번", "번"],
    ["박스", "박스"],
    ["명", "명"],
    ["일", "일"],
    ["시", "시"],
    ["분", "분"],
    ["월", "월"],
    ["년", "년"],
    ["%", "%"],
    ["퍼센트", "%"],
    ["프로", "%"],
  ] as Array<[string, string]>
).sort((a, b) => b[0].length - a[0].length);

/**
 * What a unit measures. A fact's 300g and a line's 300개 are different things; 300분 and 300명
 * may be the same people, and 300kg and 300g are the same dimension said in another unit.
 * Spellings are matched longest first at the start of what follows a number, one space allowed.
 */
const DIMENSIONS: ReadonlyArray<[spellings: string[], dimensions: string[]]> = [
  [
    [
      "kg",
      "mg",
      "g",
      "t",
      "톤",
      "킬로그램",
      "밀리그램",
      "그램",
      "그람",
      "킬로",
      "키로",
    ],
    ["weight"],
  ],
  [["ml", "cc", "l", "밀리리터", "밀리", "리터"], ["volume"]],
  [
    ["mm", "cm", "km", "m", "밀리미터", "센티미터", "센티", "미터", "킬로미터"],
    ["length"],
  ],
  [
    [
      "원",
      "₩",
      "만원",
      "만 원",
      "천원",
      "천 원",
      "억원",
      "억 원",
      "달러",
      "엔",
      "유로",
    ],
    ["money"],
  ],
  [
    [
      "개",
      "ea",
      "병",
      "박스",
      "상자",
      "장",
      "건",
      "통",
      "봉",
      "세트",
      "묶음",
      "캔",
      "팩",
      "줄",
      "쌍",
      "켤레",
      "권",
      "대",
      "마리",
      "송이",
      "알",
      "판",
      "잔",
    ],
    ["count"],
  ],
  [["명", "인"], ["people"]],
  [["분"], ["people", "time"]],
  [["시간", "시", "초", "일", "주", "월", "년", "개월", "분기"], ["time"]],
  [["%", "퍼센트", "프로"], ["share"]],
];
const DIMENSION_SPELLINGS: ReadonlyArray<
  [spelling: string, dimensions: string[]]
> = DIMENSIONS.flatMap(([spellings, dimensions]) =>
  spellings.map((spelling): [string, string[]] => [spelling, dimensions]),
).sort((a, b) => b[0].length - a[0].length);

/** The dimensions of the unit said at `at` in the text, one space allowed; null when none is. */
function dimensionsAt(text: string, at: number): string[] | null {
  const tail = text.startsWith(" ", at) ? text.slice(at + 1) : text.slice(at);
  const found = DIMENSION_SPELLINGS.find(([spelling]) =>
    tail.startsWith(spelling),
  );
  return found ? found[1] : null;
}

/** The dimensions of a unit by its name, for the readings. */
const dimensionsOf = (unit: string) =>
  DIMENSION_SPELLINGS.find(([spelling]) => spelling === unit)?.[1] ?? null;

/** A text as digits are read in it: full-width folded, every dash a hyphen, every space a space,
 * middle dots dots, thousands commas gone, lowercased. */
const fold = (text: string) =>
  text
    .replace(/[\u00b7\u2027\u30fb\u318d\uff65]/g, ".")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{Pd}\u2212]/gu, "-")
    .replace(/\p{Zs}/gu, " ")
    .replace(/(\d),(?=\d{3})/g, "$1");

/** The fact's numbers as the first rule had them: every run of three digits or more. */
const digitRuns = (text: string) => text.match(/\d{3,}/g) ?? [];

/**
 * THE FIRST RULE, as it was on main before pull request 204: any 3+-digit run of the fact,
 * commas inside a number removed, as a substring of the line's digits. Kept whole so that what
 * it carried can be shown carried.
 */
export function oldSubstringCarries(line: string, fact: string): boolean {
  const digits = flat(line).replace(/(\d),(?=\d{3})/g, "$1");
  return digitRuns(fact.replace(/(\d),(?=\d{3})/g, "$1")).some((run) =>
    digits.includes(run),
  );
}

export type Exemption = "longer run" | "other dimension";

/**
 * Why a line the first rule carried is clearly about another number — one reason per place a
 * number of the fact's occurs in the line, every one of them (a) or (b) — or null when any
 * place is in doubt, and the line goes.
 */
export function clearlyAnotherNumber(
  line: string,
  fact: string,
): Exemption[] | null {
  const here = fold(flat(line));
  const said = fold(flat(fact));
  const reasons: Exemption[] = [];
  for (const run of new Set(digitRuns(said))) {
    if (!here.includes(run)) continue;
    // The dimensions after the fact's own number, at every place the fact says it whole.
    const factDimensions: Array<string[] | null> = [];
    for (const match of said.matchAll(/\d{3,}/g)) {
      if (match[0] === run) {
        factDimensions.push(dimensionsAt(said, match.index + run.length));
      }
    }
    for (let at = here.indexOf(run); at >= 0; at = here.indexOf(run, at + 1)) {
      const end = at + run.length;
      const before = at > 0 ? (here[at - 1] ?? "") : "";
      const after = here[end] ?? "";
      if (/\d/.test(before) || /\d/.test(after)) {
        reasons.push("longer run");
        continue;
      }
      const lineDimensions = dimensionsAt(here, end);
      const apart =
        lineDimensions !== null &&
        factDimensions.length > 0 &&
        factDimensions.every(
          (dimensions) =>
            dimensions !== null &&
            !dimensions.some((dimension) => lineDimensions.includes(dimension)),
        );
      if (!apart) return null;
      reasons.push("other dimension");
    }
  }
  return reasons.length > 0 ? reasons : null;
}

/**
 * An amount in Korean scale words as its value. The words are a hierarchy, not a sum of
 * independent terms (Codex's third review of pull request 204 found 1억2천만 read as 100002000):
 * the small words 천/백/십 build a group of under ten thousand, and each big word 조/억/만 closes
 * the group and multiplies it — `1억 2천만` is (1)×억 + (2천)×만, `3천5백만` is (3500)×만, `1만8천`
 * is (1)×만 + 8천, `2천5백` is 2500. Digits may stand before any word (`1,000만`, `12만5천`) and
 * a small word may stand alone (`천만` is 1천만); the span starts with a digit, so `만 원` in prose
 * and `5일 만에` are not amounts.
 */
const BIG_WORDS: Readonly<Record<string, bigint>> = {
  조: 1_000_000_000_000n,
  억: 100_000_000n,
  만: 10_000n,
};
const SMALL_WORDS: Readonly<Record<string, bigint>> = {
  천: 1_000n,
  백: 100n,
  십: 10n,
};
export function koreanAmount(span: string): bigint {
  let total = 0n;
  let group = 0n;
  const parts = span.replace(/(\d),(?=\d{3})/g, "$1");
  for (const part of parts.matchAll(/(\d+)?\s?([조억만천백십])?/g)) {
    const [, digits, word] = part;
    if (!digits && !word) continue;
    const figure = digits ? BigInt(digits) : 1n;
    const big = word ? BIG_WORDS[word] : undefined;
    const small = word ? SMALL_WORDS[word] : undefined;
    if (small !== undefined) group += figure * small;
    else if (big !== undefined) {
      // `만 원` and `만1천원` say one 만; `1만8천` says the digits; `3천5백만` the group.
      const times = group === 0n ? figure : group + (digits ? figure : 0n);
      total += times * big;
    } else group += figure;
    if (big !== undefined) group = 0n;
  }
  return total + group;
}

/** The unit said at the start of what follows a number, one space allowed; "" when none is. */
function unitAt(trailing: string): string {
  const tail = trailing.startsWith(" ") ? trailing.slice(1) : trailing;
  const found = UNITS.find(([spelling]) => tail.startsWith(spelling));
  return found ? found[1] : "";
}

/** Two digits of a date part: 2026-10-1 and 2026년 10월 01일 are one day. */
const twoDigits = (part: string) => part.padStart(2, "0").slice(-2);

export function numbersIn(text: string): SaidNumber[] {
  const said: SaidNumber[] = [];
  // Every dash (\p{Pd}, the minus sign) is a hyphen, every space (\p{Zs}) a space and a middle
  // dot a dot before anything is read: the summariser and the owner write a phone with a
  // non-breaking hyphen, an en dash or 010·1234·5678 (Codex's third review of pull request 204).
  let rest = text
    .replace(/[\u00b7\u2027\u30fb\u318d\uff65]/g, ".")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{Pd}\u2212]/gu, "-")
    .replace(/\p{Zs}/gu, " ")
    .replace(/(\d),(?=\d{3})/g, "$1");
  // Each reading takes its span out of the text so a later one never reads it again.
  const take = (
    pattern: RegExp,
    read: (match: RegExpExecArray, trailing: string) => SaidNumber | null,
  ) => {
    rest = rest.replace(pattern, (...args) => {
      const match = args as unknown as RegExpExecArray;
      const offset = args.at(-2) as number;
      const whole = args.at(-1) as string;
      const number = read(match, whole.slice(offset + match[0].length));
      if (number) said.push(number);
      return " ";
    });
  };
  // A date with its year, in figures or in 년/월/일.
  take(
    /(?<!\d)(\d{4})\s?(?:[-./]|년\s?)(\d{1,2})\s?(?:[-./]|월\s?)(\d{1,2})일?(?!\d)/g,
    (match) => ({
      value: `${match[1]}${twoDigits(match[2] ?? "")}${twoDigits(match[3] ?? "")}`,
      unit: "",
    }),
  );
  // A short date or a decimal says no number of its own.
  take(/(?<![\d.])\d{1,2}[./]\d{1,2}(?![\d.])/g, () => null);
  // An identifier: digit groups joined by separators, as one value.
  take(
    /(?<!\d)\(?(?:0\d*(?:[\s\-./()]{1,3}\d+)+|\d+(?:[\s\-./()]{1,3}\d+){2,})\)?/g,
    (match, trailing) => ({
      value: match[0].replace(/\D/g, ""),
      unit: unitAt(trailing),
    }),
  );
  // An amount in scale words.
  // Said in words alone — 천만 원, 백만 원 — only with two words or a unit after it, since `5일
  // 만에` is not ten thousand of anything.
  take(
    /\d+(?:\s?(?:조(?=\s?[\d억만천백원])|[억만천백십])(?:\s?\d+)?)+|(?<!\p{L})(?:조(?=\s?[\d억만천백원])|[억만천백십])(?:\s?\d+)?(?:\s?(?:조(?=\s?[\d억만천백원])|[억만천백십])(?:\s?\d+)?)*/gu,
    (match, trailing) => {
      const unit = unitAt(trailing);
      const words = match[0].match(/[조억만천백십]/g)?.length ?? 0;
      if (!/\d/.test(match[0]) && words < 2 && unit === "") return null;
      return { value: koreanAmount(match[0]).toString(), unit };
    },
  );
  // Every other run of digits, as written.
  take(/\d+/g, (match, trailing) => ({
    value: match[0],
    unit: unitAt(trailing),
  }));
  return said;
}

/** The numbers a forgotten fact is found by: three digits or more, as the first rule had it. */
function numbersOf(fact: string): SaidNumber[] {
  return numbersIn(fact).filter((number) => number.value.length >= 3);
}

/**
 * Whether the line, read, says the fact's number: the same whole value, and not two units of
 * different dimensions — a unit unsaid on either side still counts.
 */
const saysNumber = (line: readonly SaidNumber[], number: SaidNumber) =>
  line.some((said) => {
    if (said.value !== number.value) return false;
    const a = dimensionsOf(said.unit);
    const b = dimensionsOf(number.unit);
    return !(a && b && !a.some((dimension) => b.includes(dimension)));
  });

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
 * its numbers (the number clause, by construction — see the head of that section), or most of
 * its distinctive words (two at least) in the line — a dated line's test; a standing line is also
 * read as `head: body` (`standingLineCarries`).
 */
export function lineCarries(line: string, fact: string): boolean {
  const here = flat(line);
  const said = flat(fact);
  if (!here || !said) return false;
  if (here.includes(said)) return true;
  const firstRule =
    oldSubstringCarries(line, fact) ||
    oldSubstringCarries(fold(line), fold(fact));
  if (firstRule && clearlyAnotherNumber(line, fact) === null) return true;
  const numbers = numbersOf(fact);
  if (numbers.length > 0) {
    const read = numbersIn(here);
    if (numbers.some((number) => saysNumber(read, number))) return true;
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
