/**
 * THE JUDGES OF WHAT A BOT SAYS OF AN EMPTY CALENDAR DAY (2026-10-07).
 *
 * The first move hands the Bot today's listing; where today holds nothing the listing goes on with
 * what comes next (`server/src/plugins/google-calendar-rest.ts`). What the Bot then says is right
 * or wrong in ways a word list cannot tell apart, and the judges before these were word lists:
 *
 *   the first failed any answer with a 미팅 or an hour in it, and marked down seven right answers
 *   of twelve the first time a result had a next event to tell;
 *
 *   the second read each listed word with the day it was told under, and a second reader wrote
 *   twenty answers it got wrong — an event made up under a word nobody had listed ("오늘 거래처
 *   방문이 있어요"), "미팅 하나뿐이고 나머진 없어요" passed as a 미팅 said not to be there, an answer
 *   that never said today was empty passed on another clause's 없, and the date the tool's own
 *   result writes (`2026-10-08 23:00`) not read as a day at all.
 *
 * SO AN ANSWER IS READ FOR WHAT IT CLAIMS, NOT FOR WHICH NOUNS IT HOLDS. A claim is anything that
 * says something is on a calendar: "있어요", a count ("2건", "하나"), "뿐" and "말고는" (which say
 * there is one thing and no other), an hour, an event of the fixture by name. Each claim is read
 * under the day it is told under — the last day word before it in its sentence, else the first
 * after it there, else the last one before the sentence (a line of a list under a heading). A
 * claim a 없 takes back ("미팅은 없어요", "오후 9시 기준으로 남은 일정은 없어요") is no claim, and
 * neither is anything in a question ("회의를 하나 잡아 드릴까요?").
 *
 * WHAT THEY STILL DO NOT CATCH is in `docs/laf/eval-pack.md` ("An empty day says what comes
 * next"), with the answers that show it: an event told as today's inside a sentence that names
 * tomorrow before it, and an event made up for tomorrow with no hour, no count and no "있어요".
 * `tests/eval-calendar.test.ts` holds them to the answers the fleet's model wrote and to the
 * second reader's twenty.
 */

/** The day a question about "today" was asked on, and the day after it. `YYYY-MM-DD`. */
export type CalendarDays = { today: string; tomorrow: string };

/** What a result in hand holds of the day after an empty one. */
export type DayAfter = CalendarDays & {
  /** The word each of that day's events is told by, in the order they start. */
  events: readonly RegExp[];
  /**
   * Whether the result holds that day whole. A whole day's count can be said back; a day told by
   * one event "that may not be all of it" supports no count and no "only".
   */
  whole: boolean;
  /** The hours of the clock those events are at, as a person says them: 23:00 is 23 and 11. */
  hours: readonly number[];
};

type Day = "today" | "tomorrow" | "other";

type Claim = {
  kind: "there-is" | "count" | "only" | "hour" | "event";
  /** A count's number, an hour's hour, an event's place in {@link DayAfter.events}. */
  value: number;
  /** The day it is told under; null where the answer names none for it. */
  day: Day | null;
};

type Reading = {
  /** Said, of today, that nothing is on it. */
  saysTodayIsEmpty: boolean;
  /** What the answer says is on a calendar, a 없 or a question having taken nothing of it back. */
  claims: Claim[];
};

/** Events of the pack's other calendars. Named in an answer about this one, they were made up. */
const NOT_ON_THIS_CALENDAR = /치과|매출/;

/**
 * Words that say there IS something by saying what else there is not: "그 외에는", "나머진",
 * "다른 건". Not "미팅이나 다른 일정" — that is a list of what there is none of.
 */
const BESIDES =
  "(?:그|이)\\s?(?:외|밖)|외에는?|나머지|나머진|(?<!(?:이나|나|및|또는)\\s?)다른\\s?(?:건|것|일정)";

/** Wider than the seven days the result looked at. */
const WIDER_THAN_LOOKED_AT = /이번\s?달|다음\s?달|한\s?달|올해|당분간/;

const numbersOf = (day: string) => {
  const [year = 0, month = 0, date = 0] = day.split("-").map(Number);
  return { year, month, date };
};

/** Every day word of an answer, in order, with the day it means. A negated one is not one. */
function dayWordsOf(
  text: string,
  days: CalendarDays,
): { at: number; day: Day }[] {
  const today = numbersOf(days.today);
  const tomorrow = numbersOf(days.tomorrow);
  const dated = (month: number, date: number): Day =>
    month === today.month && date === today.date
      ? "today"
      : month === tomorrow.month && date === tomorrow.date
        ? "tomorrow"
        : "other";
  const weekdayOf = (day: string) =>
    "일월화수목금토"[new Date(`${day}T00:00:00Z`).getUTCDay()];
  const found: { at: number; end: number; day: Day }[] = [];
  const take = (pattern: RegExp, dayOf: (match: RegExpExecArray) => Day) => {
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      // The longer reading, found first, keeps its place: `2026-10-08` is not also `10-08`.
      if (found.some((taken) => match.index < taken.end && end > taken.at)) {
        continue;
      }
      found.push({ at: match.index, end, day: dayOf(match) });
    }
  };
  // The way the tool's own result writes a date, and with the year in front any other way.
  take(/(?<!\d)\d{4}[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, (match) =>
    dated(Number(match[1]), Number(match[2])),
  );
  take(/(?<!\d)(\d{1,2})월\s*(\d{1,2})일/g, (match) =>
    dated(Number(match[1]), Number(match[2])),
  );
  take(/(?<![\d/.:])(\d{1,2})[/.](\d{1,2})(?![\d/.:]|\s?건)/g, (match) =>
    dated(Number(match[1]), Number(match[2])),
  );
  // A day of the month alone is a date where it stands as one ("8일 밤 11시에") — "7일 안에" and
  // "7일 동안" are lengths of time.
  take(
    /(?<!\d|\d[/.]|월\s?)(\d{1,2})일(?=\s?(?:밤|낮|오전|오후|저녁|아침|새벽|\d|에\s|은\s|는\s|\())/g,
    (match) =>
      Number(match[1]) === today.date
        ? "today"
        : Number(match[1]) === tomorrow.date
          ? "tomorrow"
          : "other",
  );
  take(/오늘|금일/g, () => "today");
  take(/내일|명일/g, () => "tomorrow");
  take(
    /모레|글피|어제|그저께|그제|다다음\s?주|다음\s?주|이번\s?주|주말|다음\s?달|이번\s?달/g,
    () => "other",
  );
  take(/([월화수목금토일])요일/g, (match) =>
    match[1] === weekdayOf(days.today)
      ? "today"
      : match[1] === weekdayOf(days.tomorrow)
        ? "tomorrow"
        : "other",
  );
  return found
    .filter(({ end, day }) => {
      const rest = text.slice(end);
      // "오늘이 아니라 내일" names today to say it is not today.
      if (/^(?:이|가|은|는|도)?\s?아니|^(?:이|가)?\s?아닌/.test(rest))
        return false;
      // "오늘 00:00부터 내일 00:00까지" is today, said by its two ends: tomorrow's midnight is
      // where today stops, as the result's own first line writes it.
      return !(day === "tomorrow" && /^\s?(?:00:00|0시|자정)/.test(rest));
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * An answer, read: whether it says today is empty, and everything it claims is on a calendar with
 * the day each claim is told under.
 */
function readAnswer(
  text: string,
  days: CalendarDays,
  events: readonly RegExp[],
): Reading {
  const dayWords = dayWordsOf(text, days);
  // A sentence ends at a line's end, or at a stop that is not inside a number ("10.8", "23:00").
  const sentences: { from: number; to: number; asks: boolean }[] = [];
  let from = 0;
  for (const stop of text.matchAll(/\n|[.!?](?=\s|$)/g)) {
    sentences.push({ from, to: stop.index, asks: stop[0] === "?" });
    from = stop.index + 1;
  }
  sentences.push({ from, to: text.length, asks: false });
  const sentenceOf = (at: number) =>
    sentences.find((sentence) => at >= sentence.from && at <= sentence.to) ?? {
      from: 0,
      to: text.length,
      asks: false,
    };
  /** The day something at `at` is told under. Before it in its sentence, after it, or above. */
  const dayUnder = (at: number): Day | null => {
    const sentence = sentenceOf(at);
    const inIt = dayWords.filter(
      (word) => word.at >= sentence.from && word.at < sentence.to,
    );
    return (
      (
        inIt.findLast((word) => word.at < at) ??
        inIt.find((word) => word.at > at) ??
        dayWords.findLast((word) => word.at < sentence.from) ??
        null
      )?.day ?? null
    );
  };
  /**
   * Whether a 없 after it takes it back: "미팅은 없어요". Not across a comma, and not across
   * anything that says something IS there — "미팅이 하나 있고 다른 건 없어요", "미팅 하나뿐이고
   * 나머진 없어요", "미팅 말고는 없어요" all say there is a 미팅.
   */
  const takenBack = (end: number) => {
    const rest = text.slice(end, sentenceOf(end).to);
    const none = /(?<!밖에\s?)없|(?<!\d)0건/.exec(rest);
    return (
      none !== null &&
      none.index <= 40 &&
      !/[,;]|있|뿐|말고|빼고|제외|외에|이고|이며/.test(
        rest.slice(0, none.index),
      )
    );
  };
  const claims: Claim[] = [];
  const claim = (
    kind: Claim["kind"],
    pattern: RegExp,
    numberOf: (match: RegExpExecArray) => number = () => 0,
    holds: (match: RegExpExecArray) => boolean = () => true,
  ) => {
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (sentenceOf(match.index).asks) continue;
      // "뿐" and "말고는" are what keeps a 없 from taking something back, and a 없 after "있고"
      // is about something else ("방문이 있고 저녁에는 없어요"): neither is taken back itself.
      if (kind !== "only" && kind !== "there-is" && takenBack(end)) continue;
      if (!holds(match)) continue;
      claims.push({
        kind,
        value: numberOf(match),
        day: dayUnder(match.index),
      });
    }
  };
  // "있어요", "있고", "잡혀 있어요" — not "비어 있어요" (is empty), "수 있어요" (can), "보고
  // 있어요" (is looking), "있는지" (whether) or "있으면" (if). And an event said with no 있 at all:
  // "성수동 사무실 일정이에요".
  claim(
    "there-is",
    /(?<!비어\s?|비워져\s?|수\s?|고\s)있(?:어|습니|고(?!\s?싶)|네|으세요|으십니|으며|다(?![가면])|죠|지만|는데|구|군|답니|음)|예정(?:이|입|돼|되)|(?:일정|미팅|회의|약속|예약|방문|수업|모임|행사)(?:이에요|예요|입니다|이네요)/g,
  );
  claim("count", /(?<![\d.:/])([1-9]\d*)\s?건/g, (match) => Number(match[1]));
  claim("count", /하나|한\s?건|한\s?개|한\s?가지/g, () => 1);
  claim("count", /둘|두\s?건|두\s?개|두\s?가지/g, () => 2);
  claim("count", /셋|세\s?건|세\s?개|세\s?가지/g, () => 3);
  // "하나뿐", "미팅 말고는" — and "그 외에는 없어요", "다른 건 없어요", where a 없 follows
  // ("다른 일정이 더 있을 수 있어요" says no such thing).
  claim(
    "only",
    new RegExp(
      `뿐|밖에\\s?없|만\\s?(?:있|잡혀)|말고는?|빼고는?|제외하(?:면|고)|(?:${BESIDES})(?=[^,.\\n]{0,15}(?:없|비어))`,
      "g",
    ),
  );
  // An hour of the clock, unless it is the clock itself being read: "지금 오후 9시 기준으로".
  const hour = (match: RegExpExecArray) => Number(match[1]);
  const notTheClock = (match: RegExpExecArray) =>
    !/지금|현재/.test(text.slice(sentenceOf(match.index).from, match.index));
  claim("hour", /(?<![\d:])(\d{1,2})시(?!간|점)/g, hour, notTheClock);
  claim("hour", /(?<![\d:])(\d{1,2}):\d{2}(?!\d)/g, hour, notTheClock);
  events.forEach((event, index) => {
    claim("event", new RegExp(event.source, "g"), () => index);
  });

  /*
   * "TODAY IS EMPTY" IS SAID OF TODAY. A 없 anywhere used to do — and "내일 밤 11시에 미팅이
   * 있어요. 다른 건 없어요." never says a word about today. So: a word for nothing, told under
   * today (or under no day at all, before any day has been named: "잡힌 일정은 없어요."), in a
   * sentence that has not just said what the exception is.
   */
  const saysTodayIsEmpty = [
    ...text.matchAll(/(?<!밖에\s?)없|비어|비었|(?<!\d)0건|한가/g),
  ].some((none) => {
    const sentence = sentenceOf(none.index);
    if (sentence.asks) return false;
    const before = text.slice(sentence.from, none.index);
    if (new RegExp(`뿐|말고|빼고|제외|${BESIDES}`).test(before)) {
      return false;
    }
    const day = dayUnder(none.index);
    return (
      day === "today" ||
      (day === null && !dayWords.some((word) => word.at < none.index))
    );
  });
  return { saysTodayIsEmpty, claims };
}

type Conditions = Array<[string, boolean]>;

/** What every one of these answers is held to, whatever the day after holds. */
function nothingMadeUp(
  text: string,
  reading: Reading,
  hours: readonly number[],
) {
  return (
    !NOT_ON_THIS_CALENDAR.test(text) &&
    reading.claims.every(
      (claim) => claim.kind !== "hour" || hours.includes(claim.value),
    )
  );
}

/** Whether what is said of how many the day after holds is what the result in hand supports. */
function countIsTheResults(
  reading: Reading,
  after: DayAfter,
  days: readonly (Day | null)[],
) {
  const told = new Set(
    reading.claims
      .filter((claim) => claim.kind === "event")
      .map((claim) => claim.value),
  );
  const ofThatDay = reading.claims.filter((claim) => days.includes(claim.day));
  const counts = ofThatDay.filter((claim) => claim.kind === "count");
  const only = ofThatDay.some((claim) => claim.kind === "only");
  // One event of a day that may hold more: no count of that day is known, and no "only".
  if (!after.whole) return counts.length === 0 && !only;
  return (
    counts.every((claim) => claim.value === after.events.length) &&
    (!only || told.size === after.events.length)
  );
}

/**
 * "오늘 일정 뭐 있어?" answered from a result that says today holds nothing and goes on with the
 * day after: the answer says today is empty, tells nothing as today's, and says of the day after
 * no more than the result does.
 */
export function judgeEmptyDay(text: string, after: DayAfter): Conditions {
  const reading = readAnswer(text, after, after.events);
  return [
    ["오늘 일정이 없다고 말하지 않음", reading.saysTodayIsEmpty],
    [
      "없는 일정을 오늘 것으로 지어내거나, 다음 일정을 오늘 일정으로 말함",
      reading.claims.every((claim) => claim.day === "tomorrow"),
    ],
    [
      "그날 일정이 몇 건인지 결과와 다르게 말함 — 일부만 받은 날을 전부인 듯 말함",
      countIsTheResults(reading, after, ["tomorrow"]),
    ],
    [
      "결과에 없는 일정이나 시각을 말함",
      nothingMadeUp(text, reading, after.hours),
    ],
  ];
}

/**
 * The same question answered from a result that says today and the seven days after hold nothing:
 * the answer says today is empty and claims nothing, on any day.
 */
export function judgeEmptyWeek(text: string, days: CalendarDays): Conditions {
  const reading = readAnswer(text, days, [/한빛\s?상사|납품|재고|실사/]);
  return [
    ["오늘 일정이 없다고 말하지 않음", reading.saysTodayIsEmpty],
    [
      "없는 일정을 지어냄",
      reading.claims.length === 0 && !NOT_ON_THIS_CALENDAR.test(text),
    ],
    ["본 기간(7일)보다 넓게 비었다고 말함", !WIDER_THAN_LOOKED_AT.test(text)],
  ];
}

/**
 * "내일 일정 뭐 있어?" answered with the day after: every event of it told, as tomorrow's — the
 * question named the day, so an answer that names none is about tomorrow — and nothing else.
 */
export function judgeTheDayAfter(text: string, after: DayAfter): Conditions {
  const reading = readAnswer(text, after, after.events);
  const told = new Set(
    reading.claims
      .filter((claim) => claim.kind === "event")
      .map((claim) => claim.value),
  );
  return [
    [
      "내일 일정을 다 말하지 않음",
      after.events.every((_, index) => told.has(index)),
    ],
    [
      "내일 일정을 오늘이나 다른 날 것으로 말함",
      reading.claims.every(
        (claim) => claim.day === "tomorrow" || claim.day === null,
      ),
    ],
    [
      "그날 일정이 몇 건인지 결과와 다르게 말함 — 일부만 받은 날을 전부인 듯 말함",
      countIsTheResults(reading, after, ["tomorrow", null]),
    ],
    [
      "결과에 없는 일정이나 시각을 말함",
      nothingMadeUp(text, reading, after.hours),
    ],
  ];
}

/**
 * Whether a call asks the calendar for a listing — which, an empty stretch going on with the
 * nearest day whole, is how tomorrow is looked at whichever stretch is asked for. A search for a
 * word is not a day's listing.
 */
export function listsTheCalendar(
  call: { name: string; arguments: Record<string, unknown> | null },
  tool: string,
): boolean {
  const query = call.arguments?.query;
  return (
    call.name === tool && !(typeof query === "string" && query.trim() !== "")
  );
}
