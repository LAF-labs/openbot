import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type DayAfter,
  judgeEmptyDay,
  judgeEmptyWeek,
  judgeTheDayAfter,
  listsTheCalendar,
} from "../evals/calendar";
import type { ObservedCall } from "../evals/lib";
import { dayAfter } from "../evals/morning-briefing";
import { EVAL_NOW } from "../evals/prompt";
import { fridaysMeantThisWeek, SCENARIOS, type Turn } from "../evals/scenarios";
import * as calendar from "../server/src/plugins/google-calendar-rest";
import { CALENDAR_TOOL_NAME } from "../server/src/turns/first-move";
import { stubFetch } from "../server/tests/support/fetch";
import { zonedParts } from "../shared/prompt/zone";

describe("this-weeks-friday grades against the calendar a person means", () => {
  test("on a weekday there is one Friday", () => {
    // Tuesday 2026-09-22, 10:00 KST.
    expect(
      fridaysMeantThisWeek(new Date("2026-09-22T01:00:00Z"), "Asia/Seoul"),
    ).toEqual([{ month: 9, day: 25 }]);
  });

  test("on a Sunday both the Friday just gone and the coming one are honest answers", () => {
    // Sunday 2026-09-27, 01:23 KST — when the eval's one miss was graded against 9/25 alone.
    expect(
      fridaysMeantThisWeek(new Date("2026-09-26T16:23:00Z"), "Asia/Seoul"),
    ).toEqual([
      { month: 9, day: 25 },
      { month: 10, day: 2 },
    ]);
  });

  test("the weekday is Seoul's, not the machine's: Saturday 23:30 UTC is already Sunday there", () => {
    expect(
      fridaysMeantThisWeek(new Date("2026-09-26T23:30:00Z"), "Asia/Seoul"),
    ).toEqual([
      { month: 9, day: 25 },
      { month: 10, day: 2 },
    ]);
  });
});

/**
 * AN EMPTY DAY'S FIRST MOVE (2026-10-07): THE FIXTURES HELD TO THE TRANSPORT, AND THE JUDGES JUDGED.
 *
 * Four scenarios count how often the fleet's model takes an empty day's answer in one request
 * (`evals/scenarios.ts`, `firstMovesBehindTheBridge`), and neither half of that can be seen from a
 * run. A fixture written by hand to look like the transport's text measures the fixture once the
 * transport's wording moves — the wording IS what is being measured here: three ways of saying
 * "nothing" changed nothing and something to tell did. And a judge that fails the right answer, or
 * passes the wrong one, hides the result. Both have happened to this change: the first judge marked
 * down seven right answers of twelve, and a second reader wrote twenty answers the judge after it
 * got wrong. Those twenty are here, each under the result it was written about.
 */

const scenario = (id: string) => {
  const found = SCENARIOS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
};

const turn = (text: string, calls: ObservedCall[] = []): Turn => ({
  text,
  calls,
  events: [],
});

const called = (name: string, args: Record<string, unknown>): ObservedCall => ({
  id: `c_${name}`,
  name,
  rawArguments: JSON.stringify(args),
  arguments: args,
});

const ZONE = "Asia/Seoul";
const today = zonedParts(EVAL_NOW, ZONE).date;
const tomorrow = dayAfter(today, 1);
/** A day the way the fleet's model writes one: `10/7(수)`. */
const written = (day: string) => {
  const [, month, date] = day.split("-").map(Number);
  const weekday = zonedParts(new Date(`${day}T03:00:00Z`), ZONE).weekday;
  return `${month}/${date}(${weekday})`;
};
const T0 = written(today);
const T1 = written(tomorrow);

const EMPTY_DAY = "first-move-calendar-empty-day";
const EMPTY_WEEK = "first-move-calendar-empty-week";
const ANSWERED_FROM_THE_DAY =
  "first-move-calendar-empty-day-for-tomorrow-is-answered-from-the-day";
const PUT_RIGHT = "first-move-calendar-empty-day-for-tomorrow-is-put-right";

describe("what an empty day's scenarios hand the model is the transport's own text", () => {
  let realFetch: typeof fetch;
  let answer: Record<string, unknown> = {};

  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(
      async () =>
        new Response(JSON.stringify(answer), {
          headers: { "content-type": "application/json" },
        }),
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** The call a scenario's thread opens with, and the answer filed under it. */
  const opening = (id: string) => {
    const [, asking, filed] = scenario(id).messages as [
      unknown,
      { toolCalls: { function: { name: string; arguments: string } }[] },
      { content: string },
    ];
    const made = asking.toolCalls[0]?.function;
    return {
      tool: made?.name,
      args: JSON.parse(made?.arguments ?? "{}") as Record<string, unknown>,
      answer: filed.content,
    };
  };

  /** What the real transport writes for a call, on the eval's clock, of what Google answered. */
  const transportSays = async (
    args: Record<string, unknown>,
    answered: Record<string, unknown>,
  ) => {
    answer = { timeZone: ZONE, ...answered };
    const result = await calendar.callTool(
      {
        url: "https://www.googleapis.com/calendar/v3",
        token: "at",
        timeZone: ZONE,
      },
      "list_events",
      args,
      () => EVAL_NOW,
    );
    return result.text;
  };

  const at = (day: string, time: string) => ({
    dateTime: `${day}T${time}:00+09:00`,
  });
  const MEETING = {
    id: "ev_tomorrow_1",
    summary: "한빛상사 납품 미팅",
    location: "성수동 사무실",
    start: at(tomorrow, "23:00"),
    end: at(tomorrow, "23:30"),
  };
  const STOCKTAKE = {
    id: "ev_tomorrow_2",
    summary: "마감 재고 실사",
    start: at(tomorrow, "23:40"),
    end: at(tomorrow, "23:55"),
  };
  const later = (n: number) => ({
    id: `ev_later_${n}`,
    summary: "세무사 상담",
    start: at(dayAfter(today, 3), `1${n}:00`),
    end: at(dayAfter(today, 3), `1${n}:30`),
  });

  test("nothing today, and tomorrow told whole — one event, with a later day's behind it unsaid", async () => {
    const { tool, args, answer: filed } = opening(EMPTY_DAY);
    expect(tool).toBe(CALENDAR_TOOL_NAME);
    expect(await transportSays(args, { items: [MEETING, later(0)] })).toBe(
      filed,
    );
    // The day and its count, in the result's own words.
    expect(filed.split("\n")[2]).toBe(
      `[그 뒤 7일 안에서 일정이 있는 가장 가까운 날: ${tomorrow} · 일정 1건]`,
    );
  });

  test("nothing today and nothing for a week", async () => {
    const { tool, args, answer: filed } = opening(EMPTY_WEEK);
    expect(tool).toBe(CALENDAR_TOOL_NAME);
    expect(await transportSays(args, { items: [] })).toBe(filed);
  });

  test("a wrong move the result answers: tomorrow whole, with its two events", async () => {
    const { args, answer: filed } = opening(ANSWERED_FROM_THE_DAY);
    expect(
      await transportSays(args, { items: [MEETING, STOCKTAKE, later(0)] }),
    ).toBe(filed);
    expect(filed.split("\n")[2]).toBe(
      `[그 뒤 7일 안에서 일정이 있는 가장 가까운 날: ${tomorrow} · 일정 2건]`,
    );
  });

  test("a wrong move it does not: a page Google cut, one event and the day perhaps holding more", async () => {
    const { args, answer: filed } = opening(PUT_RIGHT);
    // Cut either way Google cuts one: a token for the next page, or as many as were asked for.
    expect(
      await transportSays(args, {
        items: [MEETING],
        nextPageToken: "the-next-page",
      }),
    ).toBe(filed);
    expect(
      await transportSays(args, {
        items: [MEETING, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(later)],
      }),
    ).toBe(filed);
    expect(filed.split("\n").slice(2)).toEqual([
      "[그 뒤 7일 안의 가장 가까운 일정 — 그날 일정이 더 있을 수 있음]",
      `- ${tomorrow} 23:00 ~ ${tomorrow} 23:30 · 한빛상사 납품 미팅 · 장소: 성수동 사무실 · id: ev_tomorrow_1`,
    ]);
  });

  /*
   * A SECOND CALL IS ANSWERED AS THE TRANSPORT WOULD ANSWER IT. The first version's scenarios
   * answered a re-ask with the opening's text whatever was asked — a day from this minute on under
   * a first line that said midnight to midnight — and the second reader set the two side by side.
   * A model that asks again is reading that answer; it is the transport's now, for each way a
   * Bot's model has asked here and for the move's own.
   */
  test.each([
    [EMPTY_DAY, [MEETING]],
    [EMPTY_WEEK, []],
    [ANSWERED_FROM_THE_DAY, [MEETING, STOCKTAKE]],
    [PUT_RIGHT, [MEETING, STOCKTAKE]],
  ] as const)(
    "%s: a second call is answered as the transport answers that calendar",
    async (id, items) => {
      for (const args of [
        { days: 1, max: 10 },
        { days: 1 },
        { days: 2, max: 10 },
        { days: 2, max: 20 },
        {},
        { day: "today" },
      ]) {
        expect(
          await scenario(id).stub?.(called(CALENDAR_TOOL_NAME, args)),
        ).toBe(await transportSays(args, { items }));
      }
    },
  );

  test("…so a day from this minute on comes back with tomorrow whole: its two events", async () => {
    const again = String(
      await scenario(PUT_RIGHT).stub?.(
        called(CALENDAR_TOOL_NAME, { days: 2, max: 10 }),
      ),
    ).split("\n");
    expect(again).toHaveLength(3);
    expect(again[0]).toContain("· 일정 2건]");
    expect(again[1]).toContain("한빛상사 납품 미팅");
    expect(again[2]).toContain("마감 재고 실사");
  });

  test("a day with two events on it reads as it did, with tomorrow's behind them", async () => {
    const { args, answer: filed } = opening(
      "first-move-calendar-is-answered-from",
    );
    expect(
      await transportSays(args, {
        items: [
          {
            id: "ev_today_1",
            summary: "치과 정기검진",
            location: "연세미소치과",
            start: at(today, "21:00"),
            end: at(today, "21:30"),
          },
          {
            id: "ev_today_2",
            summary: "주간 매출 정리",
            start: at(today, "22:30"),
            end: at(today, "23:00"),
          },
          MEETING,
        ],
      }),
    ).toBe(filed);
  });
});

/* ── the judges (`evals/calendar.ts`) ─────────────────────────────────────────────────────────── */

const A = /한빛\s?상사|납품/;
const B = /재고|실사/;
/** What a result holds of tomorrow: one event or two, the day whole or one event of it. */
const tomorrowHolds = (
  events: readonly RegExp[],
  whole: boolean,
  days = { today, tomorrow },
): DayAfter => ({ ...days, events, whole, hours: [11, 23] });
/** One event of a day that may hold more: what the FIRST version's result said, and a cut page's. */
const ONE_OF_A_DAY = tomorrowHolds([A], false);
const A_DAY_OF_ONE = tomorrowHolds([A], true);
const A_DAY_OF_TWO = tomorrowHolds([A, B], true);
const failed = (conditions: Array<[string, boolean]>) =>
  conditions.filter(([, ok]) => !ok).map(([label]) => label);

const TOLD_AS_TODAYS =
  "없는 일정을 오늘 것으로 지어내거나, 다음 일정을 오늘 일정으로 말함";
const TODAY_NOT_SAID_EMPTY = "오늘 일정이 없다고 말하지 않음";
const NOT_THE_RESULTS_COUNT =
  "그날 일정이 몇 건인지 결과와 다르게 말함 — 일부만 받은 날을 전부인 듯 말함";
const NOT_IN_THE_RESULT = "결과에 없는 일정이나 시각을 말함";

/*
 * THE SECOND READER'S TWENTY, as it wrote them (`judge-holes.test.ts`, outside the repository):
 * each an answer the judge at `9a1e2c7a` got wrong. Twelve are about an empty day, five about an
 * empty week, three about a wrong move for tomorrow.
 */
const WRONG_OF_AN_EMPTY_DAY = [
  // An event made up for TODAY under a word no list had.
  "오늘 거래처 방문이 있어요. 그 외에는 없어요.",
  "오늘 저녁에 친구와 약속이 하나 있어요. 그 외에는 없어요.",
  // A 미팅 beside a 없 in one sentence, with no 있 between: what is not there is the rest.
  "오늘 거래처 미팅 하나뿐이고 나머진 없어요.",
  "오늘은 거래처 미팅 말고는 없어요.",
  // Tomorrow's event told as today's next one. "다음" is not a day.
  "오늘 다음 일정은 밤 11시 한빛상사 납품 미팅이에요. 그 외에는 없어요.",
  // Never says today is empty: the 없 is another clause's.
  "내일 밤 11시에 한빛상사 납품 미팅이 있어요. 다른 건 없어요.",
];
const RIGHT_OF_AN_EMPTY_DAY = [
  // The date the way the tool's own result writes it.
  `오늘은 일정이 없어요. ${tomorrow} 23:00에 한빛상사 납품 미팅이 있어요.`,
  // The stretch the result's first line names, said back: tomorrow's midnight is where today ends.
  "오늘 00:00부터 내일 00:00까지 잡힌 일정이 없어요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.",
  // The count the result's first line gives.
  "오늘 일정은 0건이에요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.",
  // The clock, then the right answer: nine o'clock is not an event.
  "지금 오후 9시 기준으로 오늘 남은 일정은 없어요. 다음은 내일 밤 11시 한빛상사 납품 미팅이에요.",
  // "Not today but tomorrow."
  "오늘은 일정이 없어요. 한빛상사 납품 미팅은 오늘이 아니라 내일 밤 11시예요.",
];
/** The one of the twenty whose verdict depends on what the result holds of tomorrow. */
const TOMORROW_TOLD_AS_ONLY_THAT =
  "오늘은 일정이 없어요. 내일 일정은 밤 11시 한빛상사 납품 미팅 하나뿐이에요.";

describe("an empty day, answered from one event of a day that may hold more — the result the twenty were written about", () => {
  test.each(WRONG_OF_AN_EMPTY_DAY)("fails %s", (said) => {
    expect(failed(judgeEmptyDay(said, ONE_OF_A_DAY))).not.toEqual([]);
  });

  test.each(RIGHT_OF_AN_EMPTY_DAY)("passes %s", (said) => {
    expect(failed(judgeEmptyDay(said, ONE_OF_A_DAY))).toEqual([]);
  });

  test("one event told as the whole of its day fails — and so does the count the first version's answers said back", () => {
    expect(
      failed(judgeEmptyDay(TOMORROW_TOLD_AS_ONLY_THAT, ONE_OF_A_DAY)),
    ).toEqual([NOT_THE_RESULTS_COUNT]);
    // The fleet's model's own, eight answers of the sixteen that told the next event: the result
    // said "1건 — 그날의 전체 일정은 아님", and the count is what was kept.
    expect(
      failed(
        judgeEmptyDay(
          `사장님, 오늘 ${T0}은 잡힌 일정이 없어요.\n\n내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 하나 있어요.`,
          ONE_OF_A_DAY,
        ),
      ),
    ).toEqual([NOT_THE_RESULTS_COUNT]);
    // "Only", with no count beside it, says as much.
    expect(
      failed(
        judgeEmptyDay(
          "오늘은 없어요. 내일은 밤 11시 한빛상사 납품 미팅뿐이에요.",
          ONE_OF_A_DAY,
        ),
      ),
    ).toEqual([NOT_THE_RESULTS_COUNT]);
    // The other eight said no count, and were right.
    expect(
      failed(
        judgeEmptyDay(
          `사장님, 오늘 ${T0}은 잡힌 일정이 없어요.\n\n다음 일정은 내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 있어요.`,
          ONE_OF_A_DAY,
        ),
      ),
    ).toEqual([]);
  });
});

describe(EMPTY_DAY, () => {
  const check = scenario(EMPTY_DAY).check;

  test.each([
    ...RIGHT_OF_AN_EMPTY_DAY,
    // RIGHT NOW, and it was wrong: the result holds tomorrow whole, and tomorrow holds one.
    TOMORROW_TOLD_AS_ONLY_THAT,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없어요.\n\n내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 하나 있어요.`,
    // The fleet's model's own, from the runs of 2026-10-07.
    `사장님, 오늘 ${T0}은 잡힌 일정이 없어요.\n\n그 다음으로는 내일 ${T1} 밤 11시에 '한빛상사 납품 미팅'이 성수동 사무실에서 있어요.`,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없으세요.\n\n다음 일정은 내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 있어요. 성수동 사무실에서요.`,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없습니다.\n\n가장 가까운 일정은 내일 ${T1} 밤 11시, 한빛상사 납품 미팅입니다. 장소는 성수동 사무실로 되어 있어요.`,
    `사장님, 오늘 잡힌 일정은 없어요.\n\n내일 밤 11시에 성수동 사무실에서 한빛상사 납품 미팅이 하나 있네요.`,
    // Says nothing of what comes next: it was asked about today.
    "사장님, 오늘은 잡힌 일정이 없으세요.",
    // Today said empty with no word for today: the question was about today.
    "사장님, 잡힌 일정은 없어요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.",
    // The same news in other shapes: one sentence; a list under a heading; the event before its day.
    "오늘은 일정이 없고, 내일 밤 11시에 한빛상사 납품 미팅이 있어요.",
    `오늘은 잡힌 일정이 없어요.\n\n다음 일정 (내일 ${T1})\n- 밤 11시 ~ 11시 30분 · 한빛상사 납품 미팅 · 성수동 사무실`,
    "오늘은 비어 있어요. 한빛상사 납품 미팅은 내일 밤 11시예요.",
    // A 미팅 said not to be there is not an event told; an offer is a question; a closing line.
    "오늘은 미팅이나 다른 일정이 없어요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.",
    "오늘은 잡힌 일정이 없어요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요. 오늘 회의를 새로 잡아 드릴까요?",
    "오늘은 일정이 없어요. 내일 밤 11시에 한빛상사 납품 미팅이 있어요. 미리 챙길 거 있으면 말씀해 주세요.",
    // Tomorrow by its weekday, by the day of the month, and the day called quiet.
    `오늘은 일정이 없어요. ${written(tomorrow).slice(-2, -1)}요일 밤 11시에 한빛상사 납품 미팅이 있어요.`,
    `오늘은 일정이 없어요. ${Number(tomorrow.slice(8))}일 밤 11시에 한빛상사 납품 미팅이 있어요.`,
    "오늘은 한가한 날이에요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.",
    // The clock read out in a sentence of its own is not an event at nine.
    "지금은 밤 9시예요. 오늘 남은 일정은 없어요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.",
  ])("passes %s", (said) => {
    expect(check(turn(said))).toEqual({ pass: true, notes: [] });
  });

  test.each(WRONG_OF_AN_EMPTY_DAY)("fails %s", (said) => {
    expect(check(turn(said)).pass).toBe(false);
  });

  test.each([
    // Tomorrow night's, told as tonight's — by 오늘, by today's date, under today's heading, or
    // under no day at all, which under a question about today is today.
    [
      "사장님, 오늘은 다른 일정 없이 밤 11시에 한빛상사 납품 미팅이 있어요.",
      [TODAY_NOT_SAID_EMPTY, TOLD_AS_TODAYS],
    ],
    [
      `오늘은 한가해요. ${T0} 밤 11시에 한빛상사 납품 미팅이 있어요.`,
      [TOLD_AS_TODAYS],
    ],
    [
      "오늘은 한가해요.\n\n오늘 일정\n- 밤 11시 ~ 11시 30분 · 한빛상사 납품 미팅 · 성수동 사무실",
      [TOLD_AS_TODAYS],
    ],
    [
      "오늘은 일정이 없어요. 그 뒤로는 밤 11시 한빛상사 납품 미팅이 가장 먼저예요.",
      [TOLD_AS_TODAYS],
    ],
    // On another day than the result's, and at another hour.
    [
      "오늘은 일정이 없어요. 다음 일정은 모레 밤 11시 한빛상사 납품 미팅이에요.",
      [TOLD_AS_TODAYS],
    ],
    [
      "오늘은 일정이 없어요. 다음 일정은 내일 오전 9시 한빛상사 납품 미팅이에요.",
      [NOT_IN_THE_RESULT],
    ],
    // A second event made up for tomorrow, and one from another calendar of the pack.
    [
      "오늘은 없어요. 내일은 오후 2시 은행 방문과 밤 11시 한빛상사 납품 미팅이 있어요.",
      [NOT_IN_THE_RESULT],
    ],
    [
      "오늘은 일정이 없어요. 내일은 밤 11시에 치과 예약이 있어요.",
      [NOT_IN_THE_RESULT],
    ],
    // Two said of a day that holds one.
    [
      "오늘은 없어요. 내일은 2건 있어요. 밤 11시 한빛상사 납품 미팅이에요.",
      [NOT_THE_RESULTS_COUNT],
    ],
    // Empty said of tomorrow morning, and never of today.
    [
      "내일 밤 11시에 한빛상사 납품 미팅이 있어요. 내일 오전은 비어 있어요.",
      [TODAY_NOT_SAID_EMPTY],
    ],
    // A 없 does not reach back across a comma, or across "있고".
    ["오늘 회의 한 건, 내일은 없음.", [TODAY_NOT_SAID_EMPTY, TOLD_AS_TODAYS]],
    ["오늘은 거래처 방문이 있고 저녁에는 없어요.", [TOLD_AS_TODAYS]],
    // No day anywhere in the answer: the question was about today, and so is the hour.
    [
      "사장님, 잡힌 일정은 없어요. 다음 일정은 밤 11시 한빛상사 납품 미팅이에요.",
      [TOLD_AS_TODAYS],
    ],
  ] as const)("fails %s", (said, why) => {
    expect(check(turn(said)).notes).toEqual([...why]);
  });

  test("the saving spent is a failure whatever is said after: the calendar asked again, or the tool looked up", () => {
    const right = `오늘 ${T0}은 잡힌 일정이 없어요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.`;
    const spent =
      "빈 답을 믿지 않고 캘린더를 다시 부르거나 도구를 찾음 — 첫 수가 아낀 바퀴를 도로 씀";
    expect(
      check(turn(right, [called(CALENDAR_TOOL_NAME, { days: 1, max: 10 })]))
        .notes,
    ).toEqual([spent]);
    expect(
      check(turn(right, [called("tool_search", { query: "캘린더 일정 조회" })]))
        .notes,
    ).toEqual([spent]);
    expect(check(turn("  ")).pass).toBe(false);
  });

  test("a day that holds two is not told as one, and may be told by its first as what comes next", () => {
    const told = (said: string) => failed(judgeEmptyDay(said, A_DAY_OF_TWO));
    expect(
      told(
        `오늘은 없어요. 내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 하나 있어요.`,
      ),
    ).toEqual([NOT_THE_RESULTS_COUNT]);
    expect(told(TOMORROW_TOLD_AS_ONLY_THAT)).toEqual([NOT_THE_RESULTS_COUNT]);
    // "Only" with no count at all, and one of the two untold.
    expect(
      told("오늘은 없어요. 내일은 밤 11시 한빛상사 납품 미팅뿐이에요."),
    ).toEqual([NOT_THE_RESULTS_COUNT]);
    expect(
      told(
        "오늘은 없어요. 내일은 2건 있어요: 밤 11시 한빛상사 납품 미팅, 밤 11시 40분 마감 재고 실사.",
      ),
    ).toEqual([]);
    expect(
      told("오늘은 없어요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요."),
    ).toEqual([]);
  });
});

/*
 * The judge reads today's and tomorrow's dates as day words, and the rows above can only write the
 * dates of the day the test runs on. These hold it on days that day will seldom be.
 */
describe("the day an event is told under, on other dates", () => {
  const NEXT = "밤 11시에 한빛상사 납품 미팅이 있어요.";
  const on = (todays: string, tomorrows: string) => (said: string) =>
    failed(
      judgeEmptyDay(
        said,
        tomorrowHolds([A], true, { today: todays, tomorrow: tomorrows }),
      ),
    );

  test("in January a date in November is neither today's nor tomorrow's", () => {
    const told = on("2026-01-06", "2026-01-07");
    // Tomorrow's own date, each way it is written.
    for (const date of [
      "1월 7일",
      "1/7",
      "01/07",
      "1.7",
      "2026-01-07",
      "7일",
    ]) {
      expect(told(`오늘은 없어요. ${date} ${NEXT}`)).toEqual([]);
    }
    // "1월 7일" is inside "11월 7일", and "1/7" inside "11/7": another day's.
    for (const date of ["11월 7일", "11/7", "2026-11-07"]) {
      expect(told(`오늘은 없어요. ${date} ${NEXT}`)).toEqual([TOLD_AS_TODAYS]);
    }
    // And today's own date is today.
    for (const date of ["1월 6일", "1/6", "2026-01-06"]) {
      expect(told(`오늘은 한가해요. ${date} ${NEXT}`)).toEqual([
        TOLD_AS_TODAYS,
      ]);
    }
    // Seven days are a length of time and no date: an hour told "within seven days" is told
    // under no day, though the seventh is tomorrow.
    expect(told(`오늘은 없어요. 앞으로 7일 안에는 ${NEXT}`)).toEqual([
      TOLD_AS_TODAYS,
    ]);
  });

  test("tomorrow is next month's first day when today is this month's last, and next year's", () => {
    const monthsEnd = on("2026-01-31", "2026-02-01");
    expect(monthsEnd(`오늘은 없어요. 다음 일정은 2/1 ${NEXT}`)).toEqual([]);
    expect(monthsEnd(`오늘은 없어요. 2월 1일 ${NEXT}`)).toEqual([]);
    expect(monthsEnd(`오늘은 한가해요. 1/31 ${NEXT}`)).toEqual([
      TOLD_AS_TODAYS,
    ]);
    const yearsEnd = on("2026-12-31", "2027-01-01");
    expect(yearsEnd(`오늘은 없어요. 1/1 ${NEXT}`)).toEqual([]);
    // "1/1" is the first of January, not the start of the fifteenth.
    expect(yearsEnd(`오늘은 없어요. 1/15 ${NEXT}`)).toEqual([TOLD_AS_TODAYS]);
  });
});

describe(EMPTY_WEEK, () => {
  const check = scenario(EMPTY_WEEK).check;

  test.each([
    // The fleet's model's own, 2026-10-07.
    "사장님, 오늘 잡힌 일정은 없어요. 앞으로 일주일도 비어 있어요.",
    `사장님, 오늘 ${T0}은 잡힌 일정이 없어요. 앞으로 7일 안에도 일정이 비어 있어요.`,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없으세요.`,
    "사장님, 오늘 잡힌 일정은 없어요.\n앞으로 7일 동안도 따로 잡힌 일정이 없네요.",
    `사장님, 오늘 ${T0}은 잡힌 일정이 없으세요.\n뒤 7일 안에도 일정이 비어 있어요.`,
    // The second reader's two: the stretch said back, and an offer to add one.
    "오늘 00:00부터 내일 00:00까지 일정이 없어요. 그 뒤 7일도 비어 있어요.",
    "오늘은 일정이 없어요. 앞으로 일주일도 비어 있어요. 회의를 하나 잡아 드릴까요?",
    // Seven days are not an hour of the clock, and neither is "24시간"; nine o'clock is the clock.
    "오늘은 일정이 없어요. 앞으로 7일, 그러니까 다음 주 이맘때까지 24시간 내내 비어 있어요.",
    "지금 오후 9시 기준으로 오늘 남은 일정은 없어요. 앞으로 7일도 비어 있어요.",
    // A 회의 said not to be there, or looked for and not found, is not one made up.
    "오늘은 회의나 약속이 없어요. 이번 주 내내 비어 있어요.",
    "오늘은 미팅이 있는지 봤는데 없어요. 이번 주도 비어 있어요.",
  ])("passes %s", (said) => {
    expect(check(turn(said))).toEqual({ pass: true, notes: [] });
  });

  test.each([
    // The second reader's three.
    "오늘 거래처 방문이 있어요. 그 외에는 없어요.",
    "오늘 거래처 미팅 하나뿐이고 나머진 없어요.",
    "오늘은 없고, 내일 저녁에 친구와 약속이 하나 있어요.",
    // An hour, a count, an event said with no 있.
    "오늘은 없고, 내일 14:00에 일정이 하나 있어요.",
    "오늘 거래처 회의가 하나 있고 다른 건 없어요.",
    "오늘은 없어요. 다음 일정은 내일 성수동 사무실 일정이에요.",
  ])("fails %s — nothing is on this calendar for a week", (said) => {
    expect(check(turn(said)).notes).toContain("없는 일정을 지어냄");
  });

  test("seven days were looked at, and a month said empty is more than that", () => {
    expect(
      failed(
        judgeEmptyWeek("오늘은 일정이 없어요. 이번 달 내내 비어 있어요.", {
          today,
          tomorrow,
        }),
      ),
    ).toEqual(["본 기간(7일)보다 넓게 비었다고 말함"]);
  });
});

/*
 * A WRONG MOVE FOR TOMORROW, TWO WAYS. Tomorrow holds two events in both. Where the result holds
 * tomorrow whole the answer may be made from it; where it holds one event of a cut page the
 * calendar has to be asked again. What is said is judged the same in both.
 */
describe("a wrong move for tomorrow: what is said of the day", () => {
  const BOTH = `사장님, 내일 ${T1} 일정 2건 있어요.\n\n- 밤 11시 ~ 11시 30분: 한빛상사 납품 미팅 (성수동 사무실)\n- 밤 11시 40분 ~ 11시 55분: 마감 재고 실사`;
  const told = (said: string) => failed(judgeTheDayAfter(said, A_DAY_OF_TWO));

  test.each([
    // The fleet's model's own, from the runs of 2026-10-07 — with the lines it says on the way.
    BOTH,
    `내일 일정을 확인해 볼게요.내일 일정을 가져오고 있어요.${BOTH}`,
    `사장님, 내일 ${T1} 일정 2건 있어요.\n\n* 23:00 ~ 23:30 - 한빛상사 납품 미팅 (성수동 사무실)\n* 23:40 ~ 23:55 - 마감 재고 실사`,
    `${BOTH}\n\n늦은 시간 일정이네요. 미리 챙길 거 있으면 말씀해 주세요.`,
    // No day named: the question named it.
    "2건 있어요. 밤 11시 한빛상사 납품 미팅, 밤 11시 40분 마감 재고 실사.",
    // A title shortened, and one spaced.
    "내일은 2건이에요. 밤 11시 한빛 상사 납품 미팅, 밤 11시 40분 마감 실사.",
  ])("passes %s", (said) => {
    expect(told(said)).toEqual([]);
  });

  test.each([
    // The second reader's two: tomorrow's two told as TODAY's; one told and the other denied.
    [
      "오늘 일정은 2건이에요. 밤 11시 한빛상사 납품 미팅, 밤 11시 40분 마감 재고 실사.",
      ["내일 일정을 오늘이나 다른 날 것으로 말함"],
    ],
    [
      "내일은 한빛상사 납품 미팅 하나뿐이에요. 재고 관련 일정은 없어요.",
      ["내일 일정을 다 말하지 않음", NOT_THE_RESULTS_COUNT],
    ],
    // One event and no more: the answer the first version's one line invited.
    [
      `사장님, 내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 있어요.`,
      ["내일 일정을 다 말하지 않음"],
    ],
    // Both, on the day after tomorrow; and a third made up.
    [
      "내일은 일정이 없고, 모레 한빛상사 납품 미팅과 마감 재고 실사가 있어요.",
      ["내일 일정을 오늘이나 다른 날 것으로 말함"],
    ],
    [
      "내일은 3건이에요. 오전 9시 치과, 밤 11시 한빛상사 납품 미팅, 밤 11시 40분 마감 재고 실사.",
      [NOT_THE_RESULTS_COUNT, NOT_IN_THE_RESULT],
    ],
  ] as const)("fails %s", (said, why) => {
    expect(told(said)).toEqual([...why]);
  });
});

describe(ANSWERED_FROM_THE_DAY, () => {
  const check = scenario(ANSWERED_FROM_THE_DAY).check;
  const BOTH = `사장님, 내일 ${T1} 일정은 2건 있어요.\n\n- 밤 11시 ~ 11시 30분 · 한빛상사 납품 미팅 · 성수동 사무실\n- 밤 11시 40분 ~ 11시 55분 · 마감 재고 실사`;

  test("passes both events named from the day in hand, and fails the round spent asking again", () => {
    expect(check(turn(BOTH))).toEqual({ pass: true, notes: [] });
    expect(
      check(turn(BOTH, [called(CALENDAR_TOOL_NAME, { days: 2 })])).notes,
    ).toEqual([
      "받은 하루를 믿지 않고 캘린더를 다시 부르거나 도구를 찾음 — 하루를 통째로 준 것이 아낀 바퀴를 도로 씀",
    ]);
  });
});

describe(PUT_RIGHT, () => {
  const check = scenario(PUT_RIGHT).check;
  const BOTH = `사장님, 내일 ${T1} 일정 2건 있어요.\n\n- 밤 11시 ~ 11시 30분: 한빛상사 납품 미팅 (성수동 사무실)\n- 밤 11시 40분 ~ 11시 55분: 마감 재고 실사`;
  const NOT_ASKED_AGAIN =
    "내일을 보도록 캘린더를 다시 부르지 않음 — 일부만 받은 하루로 답함";

  test("passes the calendar asked again and both events named", () => {
    for (const args of [{ days: 2, max: 10 }, { days: 1 }, {}]) {
      expect(check(turn(BOTH, [called(CALENDAR_TOOL_NAME, args)]))).toEqual({
        pass: true,
        notes: [],
      });
    }
  });

  test("fails an answer made from the one event in hand, and a search taken for a look at the day", () => {
    const ONE = `사장님, 내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 있어요.`;
    expect(check(turn(ONE)).notes).toEqual([
      NOT_ASKED_AGAIN,
      "내일 일정을 다 말하지 않음",
    ]);
    // Both named from nowhere: nothing in hand held the second.
    expect(check(turn(BOTH)).notes).toEqual([NOT_ASKED_AGAIN]);
    expect(
      check(turn(BOTH, [called(CALENDAR_TOOL_NAME, { query: "내일" })])).notes,
    ).toEqual([NOT_ASKED_AGAIN]);
    expect(
      check(turn(BOTH, [called("tool_search", { query: "캘린더 일정 조회" })]))
        .notes,
    ).toEqual([NOT_ASKED_AGAIN]);
  });

  /*
   * THE ONE OF THE TWENTY THAT CHANGED ITS MEANING. The second reader's: "the same empty day asked
   * again (days: 1) is not a look at tomorrow". It was not, while an empty stretch went on with one
   * event: a day from now came back as empty as the first answer. An empty stretch now goes on with
   * the nearest day WHOLE, so a day from now comes back with both of tomorrow's — and is a look at
   * tomorrow whichever stretch it names. What is not one is a search.
   */
  test("a day from this minute on is a look at tomorrow now; a search for a word is not", () => {
    expect(
      listsTheCalendar(
        called(CALENDAR_TOOL_NAME, { days: 1 }),
        CALENDAR_TOOL_NAME,
      ),
    ).toBe(true);
    expect(
      listsTheCalendar(
        called(CALENDAR_TOOL_NAME, { days: 2, query: "납품" }),
        CALENDAR_TOOL_NAME,
      ),
    ).toBe(false);
    expect(
      listsTheCalendar(
        called("mcp__gmail__search_messages", {}),
        CALENDAR_TOOL_NAME,
      ),
    ).toBe(false);
  });
});

/*
 * WHAT THE JUDGES STILL GET WRONG, written down so that a change that fixes one says so. Neither
 * was seen in a run.
 */
describe("what the empty day's judges do not catch", () => {
  test("an event made up for tomorrow with no hour, no count and no 있어요", () => {
    expect(
      failed(
        judgeEmptyDay(
          "오늘은 없어요. 내일은 은행 방문, 그리고 한빛상사 납품 미팅.",
          A_DAY_OF_ONE,
        ),
      ),
    ).toEqual([]);
  });

  test("an honest caveat that names an event of another calendar as an example is failed", () => {
    expect(
      failed(
        judgeEmptyDay(
          "오늘은 일정이 없어요. 내일 밤 11시에 한빛상사 납품 미팅이 있는데, 치과 같은 다른 일정이 더 있을 수 있어요.",
          ONE_OF_A_DAY,
        ),
      ),
    ).toEqual([NOT_IN_THE_RESULT]);
  });
});
