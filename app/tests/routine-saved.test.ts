import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  routineSavedText,
  TOOL_RESULT_KO,
} from "../../shared/prompt/tool-results.ko";
import { routineAction } from "../src/lib/copilot/self-tools";
import { stubFetch } from "./support/fetch";

/**
 * What a Bot is told when it has saved a routine. Audit 2026-09-16, R2 F1.
 *
 * It was told "루틴을 저장했다" and nothing else, while a daily schedule with no zone was being stored
 * as UTC: "매일 7시 반" ran at 16:30 in Seoul and the Bot said it was done. The server fills the
 * deployment's zone in now, and the tool result says the schedule back as the server STORED it —
 * the time, the days and the zone — so the Bot can repeat it and a wrong one is caught in the same
 * conversation instead of the next morning.
 */

/** The schedule half of a routine row, as `POST /api/routines` answers it. */
const daily = (
  days: number[] | null,
  timeZone: string | null = "Asia/Seoul",
) => ({
  scheduleKind: "daily",
  intervalMinutes: null,
  dailyLocal: "07:30",
  dailyTimeZone: timeZone,
  dailyDays: days,
});

describe("the saved schedule, in the model's words", () => {
  test("a daily routine names its time, every day, and its zone", () => {
    const said = routineSavedText(daily([]));
    expect(said).toContain("매일 07:30");
    expect(said).toContain("Asia/Seoul");
    // What the Bot is to do with it: say it back, and put it right if it is not what was asked.
    expect(said).toContain("그대로 말해");
  });

  test("restricted days are named in week order, whatever order they were stored in", () => {
    expect(routineSavedText(daily([5, 1, 3]))).toContain("매주 월·수·금 07:30");
    expect(routineSavedText(daily([0, 6]))).toContain("매주 일·토 07:30");
  });

  test("all seven days, or none, is every day", () => {
    for (const days of [[], null, [0, 1, 2, 3, 4, 5, 6]]) {
      expect(routineSavedText(daily(days))).toContain("매일 07:30");
    }
  });

  test("a row from before zones is said as UTC, because that is the clock it runs on", () => {
    expect(routineSavedText(daily([], null))).toContain("UTC");
  });

  test("an interval says how often, and no zone", () => {
    const said = routineSavedText({
      scheduleKind: "interval",
      intervalMinutes: 30,
      dailyLocal: null,
      dailyTimeZone: null,
      dailyDays: null,
    });
    expect(said).toContain("저장된 일정: 30분마다.");
    expect(said).not.toContain("(시간대");
  });

  test("a reply it cannot read is not turned into a schedule", () => {
    /*
     * A schedule the Bot repeats to a person has to be the stored one or nothing. A body with no
     * routine, a time that is not HH:MM or a day list that is not one gets the sentence that says
     * the schedule could not be read — never "매일", which is what a missing day list would
     * otherwise look like.
     */
    const unread = TOOL_RESULT_KO["laf:routine_saved_unread"];
    expect(unread).toBeDefined();
    for (const reply of [
      undefined,
      null,
      "saved",
      {},
      { ...daily([]), dailyLocal: 730 },
      { ...daily([]), dailyLocal: "7:30" },
      { ...daily([]), dailyDays: { 0: 1 } },
      { ...daily([]), dailyDays: [7] },
      { ...daily([]), dailyTimeZone: 9 },
      { ...daily([]), scheduleKind: "weekly" },
      { scheduleKind: "interval", intervalMinutes: "30" },
    ]) {
      expect({ reply, said: routineSavedText(reply) }).toEqual({
        reply,
        said: unread as string,
      });
    }
  });

  test("no placeholder reaches the model", () => {
    for (const said of [
      routineSavedText(daily([1, 2, 3, 4, 5])),
      routineSavedText({ scheduleKind: "interval", intervalMinutes: 5 }),
      routineSavedText(null),
    ]) {
      expect(said).not.toMatch(/[{}]/);
      expect(said).not.toContain("laf:");
    }
  });
});

describe("manage_routine, after a save", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const create = {
    action: "create" as const,
    name: "아침 브리핑",
    instruction: "오늘 할 일 알려줘",
    // What a model sends for "평일 7시 반": no zone, and here not even the days.
    schedule: { kind: "daily" as const, time: "07:30" },
  };

  test("tells the Bot the routine the server stored, not the one it asked for", async () => {
    const sent: unknown[] = [];
    globalThis.fetch = stubFetch(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json(
        {
          routine: {
            id: "routine_1",
            agentId: "bot-1",
            name: create.name,
            instruction: create.instruction,
            ...daily([1, 2, 3, 4, 5]),
            enabled: true,
            nextRunAt: "2026-09-16T22:30:00.000Z",
            // Shown once, to whoever made the routine. Not a thing a model is handed.
            triggerToken: "the-token-once",
          },
        },
        { status: 201 },
      );
    });
    const lines: unknown[] = [];

    const said = await routineAction(
      create,
      "bot-1",
      (entry, failed) => lines.push({ entry, failed }),
      new QueryClient(),
    );

    // The request carried no zone and no days; the answer names both, so they came from the row.
    expect(sent).toEqual([
      {
        agentId: "bot-1",
        name: create.name,
        instruction: create.instruction,
        schedule: { kind: "daily", time: "07:30" },
      },
    ]);
    expect(said).toBe(routineSavedText(daily([1, 2, 3, 4, 5])));
    expect(said).toContain("매주 월·화·수·목·금 07:30");
    expect(said).toContain("Asia/Seoul");
    expect(said).not.toContain("the-token-once");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ failed: false });
  });

  test("a refused save is still told why, and no schedule", async () => {
    globalThis.fetch = stubFetch(async () =>
      Response.json(
        {
          error: "laf:routine_time_invalid",
          code: "laf:routine_time_invalid",
        },
        { status: 400 },
      ),
    );

    const said = await routineAction(
      create,
      "bot-1",
      () => {},
      new QueryClient(),
    );

    expect(said).toBe(TOOL_RESULT_KO["laf:routine_time_invalid"] as string);
  });

  test("a save whose reply cannot be read says so rather than inventing a schedule", async () => {
    globalThis.fetch = stubFetch(
      async () => new Response("<!doctype html>", { status: 200 }),
    );

    const said = await routineAction(
      create,
      "bot-1",
      () => {},
      new QueryClient(),
    );

    expect(said).toBe(TOOL_RESULT_KO["laf:routine_saved_unread"] as string);
  });
});
