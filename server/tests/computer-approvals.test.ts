import { describe, expect, test } from "bun:test";
import {
  type ApprovalSubject,
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";
import { A_CLICK } from "./support/subjects";

/**
 * What an approval has to mean, tested as properties rather than as a call sequence.
 *
 * A registry that only remembered ids would pass a naive test and be worthless: the failure it
 * exists to prevent is a person allowing one thing and a model spending that permission on another,
 * and nothing about that is visible from a green typecheck. So the cases here are the four ways a
 * grant can be stretched beyond what somebody agreed to, plus the two ways it stops being valid.
 */

const CLICK: ApprovalSubject = {
  botId: "sales-bot",
  toolName: "computer_click",
  ref: "e9",
  pageUrl: "https://example.com/order",
};

function registry(clock?: { at: number }) {
  return createApprovalRegistry(clock ? { now: () => clock.at } : {});
}

async function ask(
  approvals: ReturnType<typeof registry>,
  subject: ApprovalSubject = CLICK,
) {
  return await approvals.request({
    botId: subject.botId,
    actor: "someone@example.test",
    rule: 'contains(element.name, "submit")',
    subject: A_CLICK,
    fingerprint: fingerprintOf(subject),
    target: { type: "computer", id: subject.botId },
  });
}

/** Answering, on the Bot the question was asked about, which is the ordinary case. */
async function answer(
  approvals: ReturnType<typeof registry>,
  id: string,
  who: string,
  granted: boolean,
  botId = CLICK.botId,
) {
  return await approvals.answer(id, botId, who, granted);
}

describe("an approval", () => {
  test("is spendable on the action it was granted for", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", true);

    const spent = await approvals.consume(pending.id, fingerprintOf(CLICK));
    expect(spent.ok).toBe(true);
    if (spent.ok)
      expect(spent.approval.answeredBy).toBe("manager@example.test");
  });

  test("is refused for a DIFFERENT action, which is the whole point of it", async () => {
    // "Yes, click Place order" must not be replayable as "yes, click Delete account". Without this
    // the feature is a dialog box that returns a token good for anything.
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", true);

    const elsewhere = await approvals.consume(
      pending.id,
      fingerprintOf({ ...CLICK, ref: "e42" }),
    );
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.reason).toBe("a different action");
  });

  test("survives a failed replay, so the person's answer is not lost with it", async () => {
    // A mismatch leaves the approval alone. Burning it would let a model that reached for the wrong
    // button take away permission for the one somebody actually meant.
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", true);
    await approvals.consume(
      pending.id,
      fingerprintOf({ ...CLICK, ref: "e42" }),
    );

    expect((await approvals.consume(pending.id, fingerprintOf(CLICK))).ok).toBe(
      true,
    );
  });

  test("is good exactly once", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", true);

    expect((await approvals.consume(pending.id, fingerprintOf(CLICK))).ok).toBe(
      true,
    );
    const again = await approvals.consume(pending.id, fingerprintOf(CLICK));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("unknown");
  });

  test("cannot be spent before anybody has answered", async () => {
    const approvals = registry();
    const pending = await ask(approvals);

    const early = await approvals.consume(pending.id, fingerprintOf(CLICK));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe("unanswered");
  });

  test("a No is an answer, and it is final", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", false);

    const declined = await approvals.consume(pending.id, fingerprintOf(CLICK));
    expect(declined.ok).toBe(false);
    if (!declined.ok) expect(declined.reason).toBe("declined");
  });

  test("cannot be answered twice, so a decision cannot be quietly overturned", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", false);

    const second = await answer(
      approvals,
      pending.id,
      "somebody@example.test",
      true,
    );
    expect(second.ok).toBe(false);
    expect((await approvals.consume(pending.id, fingerprintOf(CLICK))).ok).toBe(
      false,
    );
  });

  test("runs out, and stops being answerable when it does", async () => {
    const clock = { at: Date.parse("2026-01-01T09:00:00.000Z") };
    const approvals = createApprovalRegistry({
      now: () => clock.at,
      ttlMs: 60_000,
    });
    const pending = await ask(approvals);
    expect(await approvals.pending("sales-bot")).toHaveLength(1);

    clock.at += 60_001;
    // Swept on the way past rather than on a timer, so a question nobody answered leaves no trace
    // that could later be mistaken for one somebody did.
    expect(await approvals.pending("sales-bot")).toHaveLength(0);
    expect(
      (await answer(approvals, pending.id, "late@example.test", true)).ok,
    ).toBe(false);
    expect((await approvals.consume(pending.id, fingerprintOf(CLICK))).ok).toBe(
      false,
    );
  });

  test("an already-granted approval expires too", async () => {
    const clock = { at: Date.parse("2026-01-01T09:00:00.000Z") };
    const approvals = createApprovalRegistry({
      now: () => clock.at,
      ttlMs: 60_000,
    });
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", true);

    clock.at += 60_001;
    // Consent to something that was going to happen now is not consent to it happening in an hour.
    expect((await approvals.consume(pending.id, fingerprintOf(CLICK))).ok).toBe(
      false,
    );
  });
});

describe("an approval belongs to one Bot", () => {
  const SAME_ACTION_OTHER_BOT: ApprovalSubject = {
    ...CLICK,
    botId: "research-bot",
  };

  test("cannot be spent by another Bot doing the identical thing", async () => {
    // The Bot id is inside the fingerprint, so two Bots clicking the same ref on the same page
    // produce two different bindings. Otherwise a permission given on one computer would carry over
    // to a computer with different logins and a different person's session in it.
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", true);

    const elsewhere = await approvals.consume(
      pending.id,
      fingerprintOf(SAME_ACTION_OTHER_BOT),
    );
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.reason).toBe("a different action");
  });

  test("cannot be answered from another Bot's address", async () => {
    // The id is enough to find the question, so this is not authorisation, it is the trail: the row
    // an answer writes says which Bot it was about, and it is taken from the request. Without this
    // check a grant lands under one Bot and the action it pays for under another, and filtering the
    // audit page by either shows half the story.
    const approvals = registry();
    const pending = await ask(approvals);

    const elsewhere = await approvals.answer(
      pending.id,
      "research-bot",
      "mallory@example.test",
      true,
    );
    expect(elsewhere.ok).toBe(false);
    // Still open, and still answerable by somebody who arrived at the right address.
    expect(
      (await answer(approvals, pending.id, "manager@example.test", true)).ok,
    ).toBe(true);
  });

  test("does not show up in another Bot's pending list", async () => {
    const approvals = registry();
    await ask(approvals);
    expect(await approvals.pending("research-bot")).toEqual([]);
    expect(await approvals.pending("sales-bot")).toHaveLength(1);
  });
});

/**
 * A No OUTLIVES THE QUESTION IT ANSWERED, which it did not.
 *
 * The refusal on the approval itself was the whole of it: the next attempt found no approval to
 * spend and the gateway opened a fresh question. So a Bot that had been told no could ask again
 * immediately, and the only thing between somebody and being worn down was their patience. Deny has
 * to mean "not this", not "not this second".
 *
 * These moved here from `approval-registry-contract.integration.test.ts` when the registry's
 * database twin was deleted (decision §7-1). There is one registry now, so there is one file.
 */
describe("a No that sticks", () => {
  test("is remembered against the action it was about", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", false);

    expect(
      await approvals.recentlyDeclined(CLICK.botId, fingerprintOf(CLICK)),
    ).toBe(true);
  });

  test("covers the Bot and the action it was about, and nothing else", async () => {
    // A person told one Bot not to press one button. Everything else it was doing carries on, and
    // so does every other Bot — a refusal that spread would be a Bot stopped by somebody else's
    // decision about something else.
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", false);

    expect(
      await approvals.recentlyDeclined(
        CLICK.botId,
        fingerprintOf({ ...CLICK, ref: "e42" }),
      ),
    ).toBe(false);
    expect(
      await approvals.recentlyDeclined("research-bot", fingerprintOf(CLICK)),
    ).toBe(false);
  });

  test("is not what a Yes leaves behind", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", true);

    expect(
      await approvals.recentlyDeclined(CLICK.botId, fingerprintOf(CLICK)),
    ).toBe(false);
  });

  test("expires, so it is a pause and not a rule", async () => {
    // Half an hour later the same action asks again. Somebody who wants a thing stopped for good
    // writes it into the boundary, where everybody can read it — a refusal buried in a registry
    // is not a rule anybody can find.
    const clock = { at: 1_000_000 };
    const approvals = createApprovalRegistry({
      now: () => clock.at,
      declineStickyMs: 60_000,
    });
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", false);

    clock.at += 59_000;
    expect(
      await approvals.recentlyDeclined(CLICK.botId, fingerprintOf(CLICK)),
    ).toBe(true);
    clock.at += 2_000;
    expect(
      await approvals.recentlyDeclined(CLICK.botId, fingerprintOf(CLICK)),
    ).toBe(false);
  });
});

/**
 * Being TOLD an answer rather than asking for it once a second.
 *
 * The room used to poll `pending` every second for two minutes to learn something that happened in
 * this very process. `waitFor` is what the questions being in memory actually buys: the promise
 * settles in the same tick the answer lands, and a wait with nobody answering costs nothing at all.
 * So the assertion in most of these is `looks`, not just the outcome — a waiter that returned the
 * right answer by polling would pass every other test in this file.
 */
describe("waiting to be told", () => {
  /** A promise that has not settled, told apart from one that has without waiting on a clock. */
  const settled = async <T>(promise: Promise<T>) =>
    await Promise.race([
      promise.then(() => true),
      Promise.resolve().then(() => false),
    ]);

  test("resolves in the tick the answer lands, on a clock that never moves", async () => {
    // The clock is frozen for the whole test. A poller cannot pass this: its next look is a
    // `setTimeout` away, and nothing here ever gets to one.
    const clock = { at: 1_000_000 };
    const approvals = registry(clock);
    const pending = await ask(approvals);

    const waiting = approvals.waitFor(CLICK.botId, pending.id);
    expect(await settled(waiting)).toBe(false);

    await answer(approvals, pending.id, "manager@example.test", true);
    const answered = await waiting;
    expect(answered?.granted).toBe(true);
    expect(answered?.answeredBy).toBe("manager@example.test");
  });

  test("resolves on a No too, because a refusal is an answer", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    const waiting = approvals.waitFor(CLICK.botId, pending.id);
    await answer(approvals, pending.id, "manager@example.test", false);
    expect((await waiting)?.granted).toBe(false);
  });

  test("does not wait at all for a question already answered", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", true);

    expect((await approvals.waitFor(CLICK.botId, pending.id))?.granted).toBe(
      true,
    );
  });

  test("has nothing to wait for when the question is not open here", async () => {
    const approvals = registry();
    expect(await approvals.waitFor(CLICK.botId, "never-asked")).toBeNull();
  });

  test("has nothing to wait for on another Bot's question", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    expect(await approvals.waitFor("research-bot", pending.id)).toBeNull();
  });

  test("ends when the question runs out, on the clock the registry is given", async () => {
    const clock = { at: 1_000_000 };
    const approvals = createApprovalRegistry({
      now: () => clock.at,
      ttlMs: 60_000,
    });
    const pending = await ask(approvals);
    const waiting = approvals.waitFor(CLICK.botId, pending.id);

    // A sweep is what notices an expiry — the same rule the registry has always had, that nothing
    // matters until somebody looks. The waiter is told rather than left holding a dead question.
    clock.at += 60_001;
    await approvals.pending(CLICK.botId);
    expect(await waiting).toBeNull();
  });

  test("ends when the turn holding it is over", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    const over = new AbortController();
    const waiting = approvals.waitFor(CLICK.botId, pending.id, {
      signal: over.signal,
    });

    over.abort();
    expect(await waiting).toBeNull();
    // And the question is still open, to be answered late by whoever is looking at it.
    expect(await approvals.pending(CLICK.botId)).toHaveLength(1);
  });

  test("ends at the caller's own bound", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    // A real millisecond, because this is the one path that is a timer rather than an event.
    expect(
      await approvals.waitFor(CLICK.botId, pending.id, { timeoutMs: 1 }),
    ).toBeNull();
  });

  test("tells every waiter, not merely the first", async () => {
    const approvals = registry();
    const pending = await ask(approvals);
    const both = Promise.all([
      approvals.waitFor(CLICK.botId, pending.id),
      approvals.waitFor(CLICK.botId, pending.id),
    ]);

    await answer(approvals, pending.id, "manager@example.test", true);
    expect((await both).map((one) => one?.granted)).toEqual([true, true]);
  });
});

describe("the fingerprint", () => {
  test("is the same for the same action and different for every changed part", async () => {
    expect(fingerprintOf(CLICK)).toBe(fingerprintOf({ ...CLICK }));
    for (const changed of [
      { ...CLICK, botId: "other" },
      { ...CLICK, toolName: "computer_key" },
      { ...CLICK, ref: "e10" },
      { ...CLICK, key: "Enter" },
      { ...CLICK, filePath: "notes.md" },
      { ...CLICK, pageUrl: "https://example.com/other" },
      // Typing into a field and typing into it then pressing Enter are two different actions, and
      // the second one submits the form. An approval for one must not be spendable as the other.
      { ...CLICK, submit: true },
      { ...CLICK, arguments: { channel: "#general" } },
    ]) {
      expect(fingerprintOf(changed)).not.toBe(fingerprintOf(CLICK));
    }
  });

  test("reads the same arguments the same way whatever order they arrive in", async () => {
    // A tool call goes through a parse between being asked about and being retried, and an approval
    // that stopped fitting because a client wrote its fields in another order would send somebody a
    // second question about the call they just allowed.
    expect(
      fingerprintOf({
        botId: "b",
        toolName: "t",
        arguments: { channel: "#general", text: "shipped" },
      }),
    ).toBe(
      fingerprintOf({
        botId: "b",
        toolName: "t",
        arguments: { text: "shipped", channel: "#general" },
      }),
    );
  });

  test("tells one set of arguments from another", async () => {
    // The reason arguments are in here at all: "post the release note in the team channel" is not
    // permission to post something else somewhere else.
    expect(
      fingerprintOf({
        botId: "b",
        toolName: "t",
        arguments: { channel: "#general", text: "shipped" },
      }),
    ).not.toBe(
      fingerprintOf({
        botId: "b",
        toolName: "t",
        arguments: { channel: "#board", text: "shipped" },
      }),
    );
  });

  test("cannot be made to collide by shuffling where a boundary falls", async () => {
    // The parts are joined with a separator no field can contain, so a ref of "ab" with no key is a
    // different action from a ref of "a" with a key of "b".
    expect(fingerprintOf({ botId: "b", toolName: "t", ref: "ab" })).not.toBe(
      fingerprintOf({ botId: "b", toolName: "t", ref: "a", key: "b" }),
    );
  });
});
