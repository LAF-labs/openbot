import { describe, expect, test } from "bun:test";
import {
  blankForm,
  formOf,
  routineChange,
  scheduleFrom,
} from "../src/lib/routines/form";
import type { Routine } from "../src/lib/routines/queries";

/**
 * The routine form, opened on a routine that already exists. 2026-09-18.
 *
 * 수정 opens the same form 새 루틴 does, filled in from the row — so the two rules that matter are
 * that what it shows is what is stored, and that saving sends only what the person changed. The
 * second is not tidiness: the server re-arms a routine's clock when its schedule changes, and a
 * form that sent the schedule back on every save would push an hourly routine's next run an hour
 * out because somebody fixed a typo in its name.
 */

const SEOUL = "Asia/Seoul";

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: "routine_1",
  agentId: "bot-1",
  name: "아침 브리핑",
  instruction: "오늘 할 일 알려줘",
  scheduleKind: "daily",
  intervalMinutes: null,
  dailyLocal: "07:30",
  dailyTimeZone: SEOUL,
  dailyDays: [],
  enabled: true,
  lastRunAt: null,
  nextRunAt: "2026-09-18T22:30:00.000Z",
  ...overrides,
});

describe("what the form shows for a routine", () => {
  test("a daily routine: its name, its words, its hour and minute, every day", () => {
    expect(formOf(routine(), "Europe/Paris")).toEqual({
      agentId: "bot-1",
      name: "아침 브리핑",
      instruction: "오늘 할 일 알려줘",
      repeat: "daily",
      minutes: "60",
      hour: 7,
      minute: 30,
      // The ROUTINE's zone, not the browser's: 07:30 is a wall clock in the zone it was written in,
      // and re-reading it in another would move the routine without anybody asking.
      timeZone: SEOUL,
      days: [],
    });
  });

  test("a daily routine with days is 특정 요일, with those days lit", () => {
    const state = formOf(routine({ dailyDays: [5, 1, 3] }), SEOUL);
    expect(state.repeat).toBe("weekly");
    expect(state.days).toEqual([1, 3, 5]);
  });

  test("all seven days is every day, which is what the server means by it", () => {
    const state = formOf(routine({ dailyDays: [0, 1, 2, 3, 4, 5, 6] }), SEOUL);
    expect(state.repeat).toBe("daily");
    expect(state.days).toEqual([]);
  });

  test("an interval routine keeps its minutes, and a switch to daily starts in the reader's zone", () => {
    const state = formOf(
      routine({
        scheduleKind: "interval",
        intervalMinutes: 30,
        dailyLocal: null,
        dailyTimeZone: null,
        dailyDays: null,
      }),
      SEOUL,
    );
    expect(state.repeat).toBe("interval");
    expect(state.minutes).toBe("30");
    expect(state.timeZone).toBe(SEOUL);
  });

  test("a row from before zones is UTC, because that is the clock it runs on", () => {
    expect(formOf(routine({ dailyTimeZone: null }), SEOUL).timeZone).toBe(
      "UTC",
    );
  });

  test("a minute a Bot set off the five-minute grid is kept, not rounded", () => {
    const state = formOf(routine({ dailyLocal: "07:32" }), SEOUL);
    expect([state.hour, state.minute]).toEqual([7, 32]);
  });

  test("a new routine starts where the form always has", () => {
    expect(blankForm(SEOUL)).toMatchObject({
      agentId: "",
      name: "",
      repeat: "daily",
      hour: 7,
      minute: 30,
      timeZone: SEOUL,
      days: [],
    });
  });
});

describe("what saving sends", () => {
  test("nothing changed is nothing to send", () => {
    const stored = routine();
    expect(routineChange(stored, formOf(stored, "Europe/Paris"))).toEqual({});
  });

  test("a new name is the name alone, trimmed", () => {
    const stored = routine();
    const state = { ...formOf(stored, SEOUL), name: "  아침 요약 " };
    expect(routineChange(stored, state)).toEqual({ name: "아침 요약" });
  });

  test("a new time is the whole schedule, in the routine's own zone", () => {
    const stored = routine({ dailyTimeZone: "America/New_York" });
    const state = { ...formOf(stored, SEOUL), hour: 8, minute: 0 };
    expect(routineChange(stored, state)).toEqual({
      schedule: { kind: "daily", time: "08:00", timeZone: "America/New_York" },
    });
  });

  test("days are sent only for 특정 요일, and every day is the absence of them", () => {
    const stored = routine();
    const weekly = {
      ...formOf(stored, SEOUL),
      repeat: "weekly" as const,
      days: [1, 2, 3, 4, 5],
    };
    expect(routineChange(stored, weekly)).toEqual({
      schedule: {
        kind: "daily",
        time: "07:30",
        timeZone: SEOUL,
        days: [1, 2, 3, 4, 5],
      },
    });

    const backToDaily = routine({ dailyDays: [1, 2, 3, 4, 5] });
    const everyDay = {
      ...formOf(backToDaily, SEOUL),
      repeat: "daily" as const,
    };
    expect(routineChange(backToDaily, everyDay)).toEqual({
      schedule: { kind: "daily", time: "07:30", timeZone: SEOUL },
    });
  });

  test("an interval that did not change is not sent, so its clock does not move", () => {
    const stored = routine({
      scheduleKind: "interval",
      intervalMinutes: 60,
      dailyLocal: null,
      dailyTimeZone: null,
      dailyDays: null,
    });
    const state = { ...formOf(stored, SEOUL), instruction: "매시 점검해줘" };
    expect(routineChange(stored, state)).toEqual({
      instruction: "매시 점검해줘",
    });
    expect(
      routineChange(stored, { ...formOf(stored, SEOUL), minutes: "90" }),
    ).toEqual({ schedule: { kind: "interval", minutes: 90 } });
  });

  test("the schedule a new routine sends is the same shape", () => {
    expect(scheduleFrom({ ...blankForm(SEOUL), hour: 9, minute: 5 })).toEqual({
      kind: "daily",
      time: "09:05",
      timeZone: SEOUL,
    });
    expect(
      scheduleFrom({ ...blankForm(SEOUL), repeat: "interval", minutes: "15" }),
    ).toEqual({ kind: "interval", minutes: 15 });
  });
});
