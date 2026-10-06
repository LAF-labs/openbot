import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
 * The three scenarios count how often the fleet's model takes an empty day's answer in one request
 * (`evals/scenarios.ts`, `firstMovesBehindTheBridge`), and neither half of that can be seen from a
 * run. A fixture written by hand to look like the transport's text measures the fixture once the
 * transport's wording moves — the wording IS what is being measured here: three ways of saying
 * "nothing" changed nothing and an event to tell did. And a judge that fails the right answer hides
 * the result: the first time the nearest event was put in the answer, seven runs of twelve said
 * "오늘은 없어요. 다음 일정은 내일 …" and were marked down for naming a 미팅.
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

describe("the answers an empty day's scenarios open with are the transport's own", () => {
  let realFetch: typeof fetch;
  let items: unknown[] = [];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ items }), {
          headers: { "content-type": "application/json" },
        }),
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** The call a scenario's thread opens with, and the answer filed under it. */
  const opening = (id: string) => {
    const [, asking, answer] = scenario(id).messages as [
      unknown,
      { toolCalls: { function: { name: string; arguments: string } }[] },
      { content: string },
    ];
    const made = asking.toolCalls[0]?.function;
    return {
      tool: made?.name,
      args: JSON.parse(made?.arguments ?? "{}") as Record<string, unknown>,
      answer: answer.content,
    };
  };

  /** What the real transport writes for that call, on the eval's clock, of a calendar holding `events`. */
  const transportSays = async (
    args: Record<string, unknown>,
    events: unknown[],
  ) => {
    items = events;
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
  const TOMORROW_NIGHT = {
    id: "ev_tomorrow_1",
    summary: "한빛상사 납품 미팅",
    location: "성수동 사무실",
    start: at(tomorrow, "23:00"),
    end: at(tomorrow, "23:30"),
  };

  test("nothing today and the nearest event after it — and the wrong move for tomorrow opens with the same", async () => {
    for (const id of [
      "first-move-calendar-empty-day",
      "first-move-calendar-empty-day-for-tomorrow-is-put-right",
    ]) {
      const { tool, args, answer } = opening(id);
      expect(tool).toBe(CALENDAR_TOOL_NAME);
      // A later event rides behind the nearest, as Google's page would carry it: only one is told.
      expect(
        await transportSays(args, [
          TOMORROW_NIGHT,
          {
            id: "ev_later",
            summary: "세무사 상담",
            start: at(dayAfter(today, 3), "10:00"),
            end: at(dayAfter(today, 3), "11:00"),
          },
        ]),
      ).toBe(answer);
    }
  });

  test("nothing today and nothing for a week", async () => {
    const { tool, args, answer } = opening("first-move-calendar-empty-week");
    expect(tool).toBe(CALENDAR_TOOL_NAME);
    expect(await transportSays(args, [])).toBe(answer);
  });

  test("a day with two events on it reads as it did, with tomorrow's behind them", async () => {
    const { args, answer } = opening("first-move-calendar-is-answered-from");
    expect(
      await transportSays(args, [
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
        TOMORROW_NIGHT,
      ]),
    ).toBe(answer);
  });
});

describe("first-move-calendar-empty-day", () => {
  const check = scenario("first-move-calendar-empty-day").check;

  test.each([
    // The fleet's model's own, from the twelve runs of 2026-10-07 that the old check marked down
    // seven of — the dates are the run's, written here as the day the test runs on.
    `사장님, 오늘 ${T0}은 잡힌 일정이 없어요.\n\n그 다음으로는 내일 ${T1} 밤 11시에 '한빛상사 납품 미팅'이 성수동 사무실에서 있어요.`,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없어요.\n\n다음 일정은 내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 있어요.`,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없으세요.\n\n다음 일정은 내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 있어요. 성수동 사무실에서요.`,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없습니다.\n\n가장 가까운 일정은 내일 ${T1} 밤 11시, 한빛상사 납품 미팅입니다. 장소는 성수동 사무실로 되어 있어요.`,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없어요.\n\n내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 하나 있어요.`,
    // Says nothing of what comes next: it was asked about today.
    "사장님, 오늘은 잡힌 일정이 없으세요.",
    // The same news in shapes those runs did not take: one sentence; a list under a heading; the
    // event before its day; the day as a date and no 내일.
    "오늘은 일정이 없고, 내일 밤 11시에 한빛상사 납품 미팅이 있어요.",
    `오늘은 잡힌 일정이 없어요.\n\n다음 일정 (내일 ${T1})\n- 밤 11시 ~ 11시 30분 · 한빛상사 납품 미팅 · 성수동 사무실`,
    "오늘은 비어 있어요. 한빛상사 납품 미팅은 내일 밤 11시예요.",
    `오늘 일정은 없어요. ${T1} 23:00에 한빛상사 납품 미팅이 잡혀 있어요.`,
    // A 미팅 said not to be there is not an event told.
    "오늘은 미팅이나 다른 일정이 없어요. 다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.",
  ])("passes %s", (said) => {
    expect(check(turn(said))).toEqual({ pass: true, notes: [] });
  });

  test.each([
    // Tomorrow night's, told as tonight's.
    "사장님, 오늘 밤 11시에 한빛상사 납품 미팅이 있어요. 그 외에는 없어요.",
    `${T0} 밤 11시에 한빛상사 납품 미팅이 있어요. 그 밖에는 없어요.`,
    // …as a list under today's heading, with a true sentence about tomorrow after it.
    "오늘 일정은 1건이에요.\n- 밤 11시 ~ 11시 30분 · 한빛상사 납품 미팅 · 성수동 사무실\n\n내일은 잡힌 일정이 없어요.",
    // …under today's date and no 오늘, after a sentence about tomorrow.
    `내일은 잡힌 일정이 없어요.\n\n${T0}\n- 밤 11시 ~ 11시 30분 · 한빛상사 납품 미팅 · 성수동 사무실`,
    // On no day at all, under a question about today.
    "밤 11시에 한빛상사 납품 미팅이 있고, 그 밖에는 없어요.",
    // An event made up for today, beside the true next one — with an hour, and with none.
    "오늘은 오후 3시에 거래처 방문이 있고, 내일 밤 11시에는 한빛상사 납품 미팅이 있어요. 그 외에는 없어요.",
    "오늘 거래처 미팅이 하나 있어요. 그 외에는 없어요.",
    // An event on no day of this calendar.
    "오늘은 일정이 없어요. 내일은 오전 10시에 치과 예약이 있어요.",
  ])("fails %s", (said) => {
    expect(check(turn(said)).notes).toEqual([
      "없는 일정을 오늘 것으로 지어내거나, 다음 일정을 오늘 일정으로 말함",
    ]);
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
  });

  test("the next event told and today not said to be empty is not an answer to the question", () => {
    expect(
      check(turn("다음 일정은 내일 밤 11시 한빛상사 납품 미팅이에요.")).notes,
    ).toEqual(["오늘 일정이 없다고 말하지 않음"]);
    expect(check(turn("  ")).pass).toBe(false);
  });
});

describe("first-move-calendar-empty-week", () => {
  const check = scenario("first-move-calendar-empty-week").check;

  test.each([
    // The fleet's model's own, 2026-10-07.
    "사장님, 오늘 잡힌 일정은 없어요. 앞으로 일주일도 비어 있어요.",
    `사장님, 오늘 ${T0}은 잡힌 일정이 없어요. 앞으로 7일 안에도 일정이 비어 있어요.`,
    `사장님, 오늘 ${T0}은 잡힌 일정이 없으세요.`,
    // Seven days are not an hour of the clock, and neither is "24시간".
    "오늘은 일정이 없어요. 앞으로 7일, 그러니까 다음 주 이맘때까지 24시간 내내 비어 있어요.",
    // A 회의 said not to be there is not an event made up.
    "오늘은 회의나 약속이 없어요. 이번 주 내내 비어 있어요.",
  ])("passes %s", (said) => {
    expect(check(turn(said))).toEqual({ pass: true, notes: [] });
  });

  test.each([
    "오늘은 오후 3시에 거래처 미팅이 하나 있어요. 그 외에는 없어요.",
    "오늘은 없고, 내일 14:00에 일정이 하나 있어요.",
    "오늘 거래처 회의가 하나 있어요. 그 외에는 없어요.",
  ])("fails %s — nothing is on this calendar for a week", (said) => {
    expect(check(turn(said)).notes).toEqual(["없는 일정을 지어냄"]);
  });
});

describe("first-move-calendar-empty-day-for-tomorrow-is-put-right", () => {
  const found = scenario(
    "first-move-calendar-empty-day-for-tomorrow-is-put-right",
  );
  const asks = (args: Record<string, unknown>) =>
    found.stub?.(called(CALENDAR_TOOL_NAME, args));
  const BOTH = `사장님, 내일 ${T1} 일정은 2건 있어요.\n\n- 밤 11시 ~ 11시 30분 · 한빛상사 납품 미팅 · 성수동 사무실\n- 밤 11시 40분 ~ 11시 55분 · 마감 재고 실사`;
  const ONE = `사장님, 내일 ${T1} 밤 11시에 한빛상사 납품 미팅이 있어요.`;
  const SHORT =
    "내일의 두 일정(한빛상사 납품 미팅, 마감 재고 실사)을 다 말하지 않음 — 미리 본 한 줄로 답함";

  test("its calendar holds two events tomorrow, and from now on for a day reaches neither", async () => {
    // What the Bot's model sent in twelve runs of twelve: two days from now.
    const twoDays = String(await asks({ days: 2, max: 10 })).split("\n");
    expect(twoDays).toHaveLength(3);
    expect(twoDays[0]).toContain("일정 2건]");
    expect(twoDays[1]).toContain("한빛상사 납품 미팅");
    expect(twoDays[2]).toContain("마감 재고 실사");
    // No `days` is a week, which holds them too.
    expect(String(await asks({}))).toContain("마감 재고 실사");
    // A day from now stops short of tomorrow night: empty again, with the same one line.
    for (const args of [{ days: 1 }, { day: "today" }]) {
      expect(await asks(args)).toBe(
        (found.messages.at(-1) as { content: string }).content,
      );
    }
  });

  test("passes the calendar asked for tomorrow and both events named", () => {
    expect(
      found.check(turn(BOTH, [called(CALENDAR_TOOL_NAME, { days: 2 })])),
    ).toEqual({ pass: true, notes: [] });
  });

  test("fails an answer made from the one line of look-ahead, asked again or not", () => {
    expect(found.check(turn(ONE)).notes).toEqual([
      "내일을 보도록 캘린더를 다시 부르지 않음",
      SHORT,
    ]);
    expect(
      found.check(turn(ONE, [called(CALENDAR_TOOL_NAME, { days: 2 })])).notes,
    ).toEqual([SHORT]);
    // The same day asked for again is not tomorrow asked for.
    expect(
      found.check(turn(BOTH, [called(CALENDAR_TOOL_NAME, { day: "today" })]))
        .notes,
    ).toEqual(["내일을 보도록 캘린더를 다시 부르지 않음"]);
  });
});
