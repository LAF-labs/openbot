import { describe, expect, test } from "bun:test";
import {
  type ApprovalSubject,
  createApprovalRegistry,
  fingerprintOf,
  HOLD_LAPSE_MS,
  presentable,
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

  test("is taken back by its own question, after the question has closed, on its own Bot", async () => {
    const clock = { at: 1_000_000 };
    const approvals = createApprovalRegistry({ now: () => clock.at });
    const pending = await ask(approvals);
    await answer(approvals, pending.id, "manager@example.test", false);
    // Past the question's ten minutes: the question is gone, the No is not.
    clock.at += 11 * 60_000;
    expect(await approvals.pending(CLICK.botId)).toEqual([]);

    expect((await approvals.liftDecline(pending.id, "research-bot")).ok).toBe(
      false,
    );
    const lifted = await approvals.liftDecline(pending.id, CLICK.botId);
    expect(lifted.ok && lifted.approval.granted).toBe(false);
    expect(
      await approvals.recentlyDeclined(CLICK.botId, fingerprintOf(CLICK)),
    ).toBe(false);
    expect((await approvals.liftDecline(pending.id, CLICK.botId)).ok).toBe(
      false,
    );
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

/**
 * A QUESTION OUTLIVES THE WINDOW THAT RAISED IT (UX review 0.5.4, candidate 1). It names its step,
 * every window of the conversation can see it, and exactly one window holds it — the one that will
 * carry the step on once it is answered.
 */
describe("which window carries a question's step on", () => {
  const STEP = { threadId: "thread-1", toolCallId: "call-7" };

  async function askFromStep(
    approvals: ReturnType<typeof registry>,
  ): Promise<string> {
    const approval = await approvals.request({
      botId: CLICK.botId,
      actor: "owner",
      rule: "r",
      subject: A_CLICK,
      fingerprint: fingerprintOf(CLICK),
      step: STEP,
      target: { type: "computer", id: CLICK.botId },
    });
    return approval.id;
  }

  test("the step travels with the question to every window", async () => {
    const approvals = registry();
    await askFromStep(approvals);
    const [open] = await approvals.pending(CLICK.botId);
    expect(presentable(open as never).step).toEqual(STEP);
  });

  test("one holder at a time, kept by whoever keeps asking", async () => {
    const clock = { at: 1_000_000 };
    const approvals = registry(clock);
    const id = await askFromStep(approvals);

    const first = await approvals.hold(id, CLICK.botId, "window-a");
    expect(first).toMatchObject({ ok: true, holding: true });
    const second = await approvals.hold(id, CLICK.botId, "window-b");
    expect(second).toMatchObject({ ok: true, holding: false });
    const [held] = await approvals.pending(CLICK.botId);
    expect(presentable(held as never, clock.at).held).toBe(true);

    clock.at += HOLD_LAPSE_MS - 1;
    expect(await approvals.hold(id, CLICK.botId, "window-a")).toMatchObject({
      holding: true,
    });
  });

  test("a window that let go, or went quiet, is taken over", async () => {
    const clock = { at: 1_000_000 };
    const approvals = registry(clock);
    const id = await askFromStep(approvals);
    await approvals.hold(id, CLICK.botId, "window-a");

    // Said so on its way out: the next window takes the step at once.
    expect(await approvals.release(id, CLICK.botId, "window-b")).toBe(false);
    expect(await approvals.release(id, CLICK.botId, "window-a")).toBe(true);
    expect(await approvals.hold(id, CLICK.botId, "window-b")).toMatchObject({
      holding: true,
    });

    // Went quiet without saying so: taken once the quiet outlasts a throttled background tab.
    clock.at += HOLD_LAPSE_MS;
    expect(await approvals.hold(id, CLICK.botId, "window-c")).toMatchObject({
      holding: true,
    });
    expect(await approvals.hold(id, CLICK.botId, "window-b")).toMatchObject({
      holding: false,
    });
  });

  test("holding answers nothing, and an answer is still bound to its action", async () => {
    const approvals = registry();
    const id = await askFromStep(approvals);
    const held = await approvals.hold(id, CLICK.botId, "window-a");
    expect(held.ok && held.approval.granted).toBeUndefined();
    expect(await approvals.consume(id, fingerprintOf(CLICK))).toEqual({
      ok: false,
      reason: "unanswered",
    });
  });

  test("a withdrawn question is gone without a No standing against the action", async () => {
    const approvals = registry();
    const id = await askFromStep(approvals);
    expect((await approvals.withdraw(id, "another-bot")) === undefined).toBe(
      true,
    );
    expect((await approvals.withdraw(id, CLICK.botId))?.id).toBe(id);
    expect(await approvals.pending(CLICK.botId)).toEqual([]);
    expect(await approvals.hold(id, CLICK.botId, "window-a")).toEqual({
      ok: false,
    });
    expect(
      await approvals.recentlyDeclined(CLICK.botId, fingerprintOf(CLICK)),
    ).toBe(false);
  });
});

/*
 * MEASURED 2026-09-25: "toss.im 항상 허용" pressed, the standing row written, and the card's line read
 * "허용함". The window waiting on the question read `granted: true` off this record before the
 * press's own answer came back, and the record did not say how wide the yes was.
 */
describe("how wide a yes was", () => {
  async function askWide(
    approvals: ReturnType<typeof registry>,
    wide: { scope?: boolean; threadId?: string },
  ) {
    return await approvals.request({
      botId: CLICK.botId,
      actor: "someone@example.test",
      rule: 'contains(element.name, "submit")',
      subject: A_CLICK,
      fingerprint: fingerprintOf(CLICK),
      ...(wide.scope ? { scope: { kind: "host", value: "toss.im" } } : {}),
      ...(wide.threadId ? { threadId: wide.threadId } : {}),
      target: { type: "computer", id: CLICK.botId },
    });
  }

  const answerWith = (
    approvals: ReturnType<typeof registry>,
    id: string,
    granted: boolean,
    tier: "always" | "thread",
  ) => approvals.answer(id, CLICK.botId, "owner@example.test", granted, tier);

  test("travels on the record with the yes, to every reader of it", async () => {
    const approvals = registry();
    const pending = await askWide(approvals, { scope: true });
    const answered = await answerWith(approvals, pending.id, true, "always");
    expect(answered.ok && answered.approval.tier).toBe("always");
    const [read] = await approvals.pending(CLICK.botId);
    expect(read && presentable(read)).toMatchObject({
      granted: true,
      tier: "always",
    });
  });

  test("is only what the question could give", async () => {
    const approvals = registry();
    // No scope: nothing durable was derived, so "always" was never on the card.
    const unscoped = await askWide(approvals, {});
    const once = await answerWith(approvals, unscoped.id, true, "always");
    expect(once.ok && once.approval.tier).toBeUndefined();
    // No thread: "for this conversation" has nothing to bind to.
    const threadless = await askWide(approvals, { scope: true });
    const notThread = await answerWith(
      approvals,
      threadless.id,
      true,
      "thread",
    );
    expect(notThread.ok && notThread.approval.tier).toBeUndefined();
    const threaded = await askWide(approvals, {
      scope: true,
      threadId: "thread-1",
    });
    const thread = await answerWith(approvals, threaded.id, true, "thread");
    expect(thread.ok && thread.approval.tier).toBe("thread");
  });

  test("a No has no width", async () => {
    const approvals = registry();
    const pending = await askWide(approvals, { scope: true });
    const answered = await answerWith(approvals, pending.id, false, "always");
    expect(answered.ok && answered.approval.tier).toBeUndefined();
  });
});
