import { describe, expect, test } from "bun:test";
import { DECLINED, relayApprovals } from "../src/rooms/approval-relay";
import type { ToolOutcome, UnattendedToolkit } from "../src/runner/unattended";

/**
 * What happens between a member's action stopping at a boundary and the person seeing a result.
 *
 * The case that matters most is the retry carrying the answer: without it the gateway raises a
 * SECOND question for the same action, the person's Allow pays for nothing, and the room goes
 * quiet — which is what shipped for about twenty minutes before this file existed.
 */

const ASKING: ToolOutcome = {
  ok: false,
  awaitingApproval: true,
  approvalId: "ap_1",
  question: "Open wttr.in?",
  rule: "true",
  reason: "A person has to allow that.",
};

/** A toolkit that answers with a script, recording exactly how each call arrived. */
function toolkit(outcomes: ToolOutcome[]) {
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
    call?: { id: string; approvalId?: string };
  }> = [];
  const base: UnattendedToolkit = {
    tools: [],
    execute: async (name, args, call) => {
      calls.push({ name, args, ...(call ? { call } : {}) });
      return outcomes[calls.length - 1] ?? { ok: true };
    },
  };
  return { base, calls };
}

function relay(
  outcomes: ToolOutcome[],
  wait?: () => Promise<"granted" | "denied" | "unanswered">,
) {
  const { base, calls } = toolkit(outcomes);
  const announced: Array<{ approvalId: string; answered: boolean }> = [];
  const relayed = relayApprovals(base, {
    memberId: "risk",
    announce: (question, answered) =>
      announced.push({ approvalId: question.approvalId, answered }),
    ...(wait ? { wait } : {}),
  });
  return { relayed, calls, announced };
}

describe("a member's action at a boundary", () => {
  test("an action that goes through is not touched", async () => {
    const it = relay([{ ok: true, text: "24°C" }]);
    const outcome = await it.relayed.execute(
      "computer_navigate",
      { url: "https://wttr.in" },
      { id: "call_1" },
    );
    expect(outcome).toEqual({ ok: true, text: "24°C" });
    expect(it.announced).toEqual([]);
    expect(it.calls).toHaveLength(1);
  });

  test("Allow retries the same action WITH the answer, once", async () => {
    const it = relay(
      [ASKING, { ok: true, text: "24°C" }],
      async () => "granted",
    );
    const outcome = await it.relayed.execute(
      "computer_navigate",
      { url: "https://wttr.in" },
      { id: "call_1" },
    );
    expect(outcome).toEqual({ ok: true, text: "24°C" });
    // The retry is the same action, and it presents the answer the person gave.
    expect(it.calls).toHaveLength(2);
    expect(it.calls[1]).toEqual({
      name: "computer_navigate",
      args: { url: "https://wttr.in" },
      call: { id: "call_1", approvalId: "ap_1" },
    });
    // Shown, then taken down.
    expect(it.announced).toEqual([
      { approvalId: "ap_1", answered: false },
      { approvalId: "ap_1", answered: true },
    ]);
  });

  test("a retry that meets a boundary again is reported, not asked about forever", async () => {
    let waits = 0;
    const it = relay([ASKING, ASKING], async () => {
      waits += 1;
      return "granted";
    });
    const outcome = await it.relayed.execute(
      "computer_navigate",
      {},
      { id: "c" },
    );
    expect(outcome.awaitingApproval).toBe(true);
    expect(waits).toBe(1);
    expect(it.calls).toHaveLength(2);
  });

  test("Deny is an answer, and the member is told not to try again", async () => {
    const it = relay([ASKING], async () => "denied");
    const outcome = await it.relayed.execute(
      "computer_navigate",
      {},
      { id: "c" },
    );
    expect(outcome).toEqual({ ok: false, refused: true, reason: DECLINED });
    // Not retried: a person said no.
    expect(it.calls).toHaveLength(1);
    expect(it.announced.at(-1)).toEqual({ approvalId: "ap_1", answered: true });
  });

  test("nobody answering leaves the question up, and the member says it is waiting", async () => {
    const it = relay([ASKING], async () => "unanswered");
    const outcome = await it.relayed.execute(
      "computer_navigate",
      {},
      { id: "c" },
    );
    expect(outcome).toBe(ASKING);
    expect(it.calls).toHaveLength(1);
    // Announced once and never taken down: answering it late still counts.
    expect(it.announced).toEqual([{ approvalId: "ap_1", answered: false }]);
  });

  test("with nothing able to wait, the question is still shown", async () => {
    const it = relay([ASKING]);
    const outcome = await it.relayed.execute(
      "computer_navigate",
      {},
      { id: "c" },
    );
    expect(outcome).toBe(ASKING);
    expect(it.announced).toEqual([{ approvalId: "ap_1", answered: false }]);
  });

  test("an outcome with no approval id is not treated as a question", async () => {
    const it = relay(
      [{ ok: false, awaitingApproval: true }],
      async () => "granted",
    );
    const outcome = await it.relayed.execute(
      "computer_navigate",
      {},
      { id: "c" },
    );
    expect(outcome.ok).toBe(false);
    expect(it.announced).toEqual([]);
    expect(it.calls).toHaveLength(1);
  });
});
