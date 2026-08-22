import { describe, expect, test } from "bun:test";
import type { PendingApproval } from "../src/computer/approvals";
import { createApprovalWaiter } from "../src/rooms/wait-for-approval";

/**
 * The wait a room does and a routine does not. Every case here is one the person experiences as
 * "I pressed the button and then…", so each ending is pinned: the action goes through, the action
 * is refused, or the member says it is still waiting and the question stays answerable.
 */

const approval = (over: Partial<PendingApproval> = {}): PendingApproval =>
  ({
    id: "ap_1",
    botId: "risk",
    actor: "person",
    rule: "true",
    question: "Open wttr.in?",
    target: { type: "computer", id: "c1" },
    fingerprint: "f1",
    requestedAt: "2026-08-22T13:00:00.000Z",
    expiresAt: "2026-08-22T13:10:00.000Z",
    ...over,
  }) as PendingApproval;

/** A registry whose answer arrives on the nth look, and a clock that only moves when we sleep. */
function registry(answers: Array<PendingApproval[] | null>) {
  let looks = 0;
  let clock = 0;
  const sleeps: number[] = [];
  return {
    looks: () => looks,
    sleeps,
    waiter: createApprovalWaiter(
      {
        pending: async () => {
          const answer = answers[Math.min(looks, answers.length - 1)];
          looks += 1;
          if (answer === null) throw new Error("database blip");
          return answer;
        },
      },
      {
        waitMs: 5_000,
        pollMs: 1_000,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      },
    ),
  };
}

describe("waiting for a person, in a room", () => {
  test("an answer of yes ends the wait", async () => {
    const it = registry([[approval()], [approval({ granted: true })]]);
    expect(await it.waiter("risk", "ap_1")).toBe("granted");
    expect(it.looks()).toBe(2);
  });

  test("an answer of no is an answer, and a final one", async () => {
    const it = registry([[approval({ granted: false })]]);
    expect(await it.waiter("risk", "ap_1")).toBe("denied");
    // Answered on the first look: nothing slept.
    expect(it.sleeps).toEqual([]);
  });

  test("a question that is gone is not waited on", async () => {
    // Expired, or spent by something else. There is nothing left to wait for.
    const it = registry([[]]);
    expect(await it.waiter("risk", "ap_1")).toBe("unanswered");
    expect(it.sleeps).toEqual([]);
  });

  test("nobody answering ends the wait at the deadline, not before", async () => {
    const it = registry([[approval()]]);
    expect(await it.waiter("risk", "ap_1")).toBe("unanswered");
    // Five seconds of budget, one second a poll.
    expect(it.sleeps).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
  });

  test("a turn that ended stops the wait where it stands", async () => {
    const over = new AbortController();
    over.abort();
    const it = registry([[approval()]]);
    expect(await it.waiter("risk", "ap_1", over.signal)).toBe("unanswered");
    // Not even one look: there is nothing left to answer for.
    expect(it.looks()).toBe(0);
  });

  test("a failed read is a blip, not an answer", async () => {
    const it = registry([null, null, [approval({ granted: true })]]);
    expect(await it.waiter("risk", "ap_1")).toBe("granted");
    expect(it.looks()).toBe(3);
  });

  test("another Bot's question is not this one's", async () => {
    const it = registry([[approval({ id: "somebody_else", granted: true })]]);
    expect(await it.waiter("risk", "ap_1")).toBe("unanswered");
  });
});
