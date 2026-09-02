import { describe, expect, test } from "bun:test";
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  fingerprintOf,
  type PendingApproval,
} from "../src/computer/approvals";
import { createApprovalWaiter } from "../src/rooms/wait-for-approval";
import { A_CLICK } from "./support/subjects";

/**
 * The wait a room does and a routine does not. Every case here is one the person experiences as
 * "I pressed the button and then…", so each ending is pinned: the action goes through, the action
 * is refused, or the member says it is still waiting and the question stays answerable.
 *
 * IT IS DRIVEN AGAINST THE REAL REGISTRY, and the reason is the change this file records. The waiter
 * used to poll `pending` once a second for two minutes; the tests for it faked a registry that
 * answered on the nth look, and every one of them would still pass against a waiter that polled. So
 * the fake is gone: the waiter is handed the registry's `waitFor` and nothing else — `pending` is
 * not even in the type it is given — and the questions are answered through `answer`, the way the
 * route does it. A poller could not compile, let alone pass.
 */

const BOT = "risk";

async function ask(approvals: ApprovalRegistry): Promise<PendingApproval> {
  return await approvals.request({
    botId: BOT,
    actor: "person@example.test",
    rule: "true",
    subject: A_CLICK,
    fingerprint: fingerprintOf({ botId: BOT, toolName: "computer_navigate" }),
    target: { type: "computer", id: "c1" },
  });
}

/** Settled or not, decided without letting a timer run. */
const settled = async <T>(promise: Promise<T>) =>
  await Promise.race([
    promise.then(() => true),
    Promise.resolve().then(() => false),
  ]);

describe("waiting for a person, in a room", () => {
  test("an answer of yes ends the wait, in the tick it is given", async () => {
    const approvals = createApprovalRegistry();
    const wait = createApprovalWaiter(approvals);
    const pending = await ask(approvals);

    const waiting = wait(BOT, pending.id);
    expect(await settled(waiting)).toBe(false);

    await approvals.answer(pending.id, BOT, "boss", true);
    expect(await waiting).toBe("granted");
  });

  test("an answer of no is an answer, and a final one", async () => {
    const approvals = createApprovalRegistry();
    const wait = createApprovalWaiter(approvals);
    const pending = await ask(approvals);

    const waiting = wait(BOT, pending.id);
    await approvals.answer(pending.id, BOT, "boss", false);
    expect(await waiting).toBe("denied");
  });

  test("a question that is gone is not waited on", async () => {
    // Expired, or spent by something else. There is nothing left to wait for.
    const approvals = createApprovalRegistry();
    const wait = createApprovalWaiter(approvals);
    expect(await wait(BOT, "ap_gone")).toBe("unanswered");
  });

  test("another Bot's question is not this one's", async () => {
    const approvals = createApprovalRegistry();
    const wait = createApprovalWaiter(approvals);
    const pending = await ask(approvals);
    expect(await wait("somebody-else", pending.id)).toBe("unanswered");
  });

  test("nobody answering ends the wait at the bound, and leaves the question open", async () => {
    const approvals = createApprovalRegistry();
    // A millisecond stands in for two minutes: what is being pinned is that the bound is the
    // waiter's and that running out is not an answer.
    const wait = createApprovalWaiter(approvals, { waitMs: 1 });
    const pending = await ask(approvals);

    expect(await wait(BOT, pending.id)).toBe("unanswered");
    // Still there for the rest of its ten minutes, so an answer given late is not thrown away.
    expect(await approvals.pending(BOT)).toHaveLength(1);
    expect((await approvals.answer(pending.id, BOT, "boss", true)).ok).toBe(
      true,
    );
  });

  test("a turn that ended stops the wait where it stands", async () => {
    const approvals = createApprovalRegistry();
    const wait = createApprovalWaiter(approvals);
    const pending = await ask(approvals);
    const over = new AbortController();

    const waiting = wait(BOT, pending.id, over.signal);
    over.abort();
    expect(await waiting).toBe("unanswered");
  });

  test("a turn already over does not start a wait", async () => {
    const approvals = createApprovalRegistry();
    const wait = createApprovalWaiter(approvals);
    const pending = await ask(approvals);
    const over = new AbortController();
    over.abort();

    expect(await wait(BOT, pending.id, over.signal)).toBe("unanswered");
  });

  test("a registry that throws is a wait that ended, not a turn that failed", async () => {
    const wait = createApprovalWaiter({
      waitFor: async () => {
        throw new Error("the registry is having a bad day");
      },
    });
    expect(await wait(BOT, "ap_1")).toBe("unanswered");
  });
});
