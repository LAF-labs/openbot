import { describe, expect, test } from "bun:test";
import { handedOver, handedOverLine } from "../src/lib/routines/handed-over";
import type { Routine } from "../src/lib/routines/queries";

/**
 * A company sub-Bot handed to this person arrives switched off (`server/src/hub/jobs.ts`): its row
 * says who it came from and that it runs once they turn it on.
 */

const base = {
  id: "routine_1",
  agentId: "agent_1",
  name: "어제 매출 정리",
  instruction: "어제 매출을 정리해줘",
  scheduleKind: "interval",
  intervalMinutes: 60,
  dailyLocal: null,
  dailyTimeZone: null,
  dailyDays: null,
  lastRunAt: null,
  nextRunAt: "2026-10-18T00:00:00.000Z",
} as unknown as Routine;

const members = [{ id: "m_a", name: "기범", role: "member" as const }];

describe("a routine handed over by a company member", () => {
  test("is the one made off with that reason, and no other", () => {
    expect(
      handedOver({ ...base, enabled: false, pausedReason: "handed_over" }),
    ).toBe(true);
    // Turned on by its person: the reason is cleared, and the row is an ordinary routine.
    expect(handedOver({ ...base, enabled: true, pausedReason: null })).toBe(
      false,
    );
    expect(handedOver({ ...base, enabled: false, pausedReason: "unread" })).toBe(
      false,
    );
  });

  test("names who it came from once the roster is there, and says the switch is theirs", () => {
    const routine = {
      ...base,
      enabled: false,
      pausedReason: "handed_over" as const,
      handedBy: "m_a",
    };
    expect(handedOverLine(routine, members)).toBe(
      "기범 handed this to you. It runs once you turn it on.",
    );
    expect(handedOverLine(routine, undefined)).toBe(
      "Company member handed this to you. It runs once you turn it on.",
    );
    expect(handedOverLine({ ...routine, handedBy: null }, members)).toBe(
      "Handed to you by a company member. It runs once you turn it on.",
    );
  });
});
