import { describe, expect, test } from "bun:test";
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";
import type { ReviewSubject, ReviewVerdict } from "../src/computer/auto-review";
import type { ActionPolicy, PolicyDecision } from "../src/computer/policy";
import { settle, type SettleDeps } from "../src/computer/settle";
import {
  allowanceFor,
  createStandingApprovalStore,
  type StandingApprovalStore,
} from "../src/computer/standing-approvals";
import { A_CLICK, A_TOOL_CALL } from "./support/subjects";

/**
 * THE ONE SETTLE STEP, AS A CONTRACT.
 *
 * The gateway and the plugin call path each hand-wrote this sequence, and the copies disagreed: the
 * plugin one consulted no auto-review, counted every call as a first attempt, and read
 * `settleWithoutAsking` for itself. Nobody decided any of that (docs/laf/redesign-2026-09.md §3.1
 * "게이트웨이가 둘이다"). The rules below are what BOTH paths get, and the two caller suites —
 * `computer-gateway.test.ts` and `plugin-*.integration.test.ts` — prove each one actually goes
 * through here rather than keeping a copy.
 *
 * Written against `settle` directly because the properties are about the decision, not about a
 * browser or a vendor: what happens to a No, whose yes is spent, and what a switch turns off.
 */

const BOT = "bot-1";
const ACTOR = "dev-local-user";
const MANAGER = "manager-user";
const RULE = 'contains(element.name, "submit")';

const ASKED: PolicyDecision = {
  allowed: false,
  matched: RULE,
  source: "ask",
  forward: false,
};

const ALLOWED: PolicyDecision = {
  allowed: true,
  matched: "true",
  source: "allow",
  forward: true,
};

const DENIED: PolicyDecision = {
  allowed: false,
  matched: 'contains(element.name, "delete")',
  source: "deny",
  forward: false,
  code: "laf:policy_denied",
};

const PERMISSIVE: ActionPolicy = { deny: [], ask: [RULE], allow: ["true"] };

/** The fingerprint the gateway would take over this click. */
const CLICK_PRINT = fingerprintOf({
  botId: BOT,
  toolName: "computer_click",
  ref: "e9",
  pageUrl: "https://example.com/order",
});

function deps(
  overrides: {
    policy?: ActionPolicy;
    approvals?: ApprovalRegistry;
    standing?: StandingApprovalStore;
    autoReview?: (
      botId: string,
      subject: ReviewSubject,
    ) => Promise<ReviewVerdict | null>;
  } = {},
): SettleDeps & {
  approvals: ApprovalRegistry;
  standing: StandingApprovalStore;
} {
  const approvals = overrides.approvals ?? createApprovalRegistry();
  const standing = overrides.standing ?? createStandingApprovalStore();
  return {
    policy: () => overrides.policy ?? PERMISSIVE,
    approvals,
    standing,
    ...(overrides.autoReview ? { autoReview: overrides.autoReview } : {}),
  };
}

function asking(
  extra: Partial<Parameters<typeof settle>[0]> = {},
): Parameters<typeof settle>[0] {
  return {
    botId: BOT,
    actorId: ACTOR,
    subject: A_CLICK,
    action: "computer_click",
    fingerprint: CLICK_PRINT,
    allowance: allowanceFor({ tool: "computer_click", host: "example.com" }),
    rule: RULE,
    target: { type: "computer", id: "default" },
    policyVerdict: ASKED,
    ...extra,
  };
}

describe("settling one stopped action", () => {
  test("an allowed verdict is allowed, and nobody is asked about it", async () => {
    const shared = deps();
    const settled = await settle(asking({ policyVerdict: ALLOWED }), shared);
    expect(settled).toEqual({ outcome: "allowed" });
    // Nothing was opened: an action nobody had to be asked about must not leave a question behind.
    expect(await shared.approvals.pending(BOT)).toEqual([]);
  });

  test("an ask with nothing standing opens a question and stops", async () => {
    const shared = deps();
    const settled = await settle(asking(), shared);

    expect(settled.outcome).toBe("asked");
    if (settled.outcome !== "asked") return;
    expect(settled.approval.subject).toEqual(A_CLICK);
    expect(settled.approval.rule).toBe(RULE);
    // The scope is derived from the action, never from whoever answers: see standing-approvals.ts.
    expect(settled.approval.scope).toEqual({
      kind: "host",
      value: "example.com",
    });
    expect(await shared.approvals.pending(BOT)).toHaveLength(1);
  });

  /*
   * A DENY IS NOT UP FOR RENEGOTIATION, and this is the test that says so for both paths at once.
   * Everything that can settle a question without a person is switched on and pointed at this
   * action — a live allowance covering it, an instruction that says yes — and it is still refused.
   */
  test("a deny is never softened, by an allowance or by an instruction", async () => {
    const standing = createStandingApprovalStore();
    await standing.grant({
      botId: BOT,
      rule: DENIED.matched ?? "",
      scope: { kind: "host", value: "example.com" },
      subject: A_CLICK,
      grantedBy: MANAGER,
    });
    const asked: ReviewSubject[] = [];
    const shared = deps({
      standing,
      autoReview: async (_bot, subject) => {
        asked.push(subject);
        return { allowed: true, reason: "the instruction covers it" };
      },
    });

    const settled = await settle(
      asking({ policyVerdict: DENIED, rule: DENIED.matched ?? "" }),
      shared,
    );

    expect(settled).toEqual({
      outcome: "refused",
      code: "laf:policy_denied",
    });
    // Not even asked. A model call on a path a deployment has already forbidden is latency spent on
    // an answer nothing would act on.
    expect(asked).toEqual([]);
    expect(await shared.approvals.pending(BOT)).toEqual([]);
  });

  test("a refusal with no code of its own is still a refusal, named", async () => {
    const settled = await settle(
      asking({
        policyVerdict: {
          allowed: false,
          matched: null,
          source: "default",
          forward: false,
        },
      }),
      deps(),
    );
    expect(settled).toEqual({
      outcome: "refused",
      code: "laf:policy_denied",
    });
  });

  test("a standing allowance answers, and says whose it was", async () => {
    const standing = createStandingApprovalStore();
    const granted = await standing.grant({
      botId: BOT,
      rule: RULE,
      scope: { kind: "host", value: "example.com" },
      subject: A_CLICK,
      grantedBy: MANAGER,
    });
    const shared = deps({ standing });

    const settled = await settle(asking(), shared);

    expect(settled.outcome).toBe("allowed");
    if (settled.outcome !== "allowed") return;
    expect(settled.approvedBy).toBe(MANAGER);
    // Kept apart from a person's own answer, because "allowed by Sam" and "allowed by an allowance
    // Sam granted last Tuesday" are different amounts of attention and the row has to say which.
    expect(settled.allowance?.id).toBe(granted.id);
    expect(await shared.approvals.pending(BOT)).toEqual([]);
  });

  test("an allowance for another rule covers nothing", async () => {
    const standing = createStandingApprovalStore();
    await standing.grant({
      botId: BOT,
      rule: "some other rule",
      scope: { kind: "host", value: "example.com" },
      subject: A_CLICK,
      grantedBy: MANAGER,
    });

    expect((await settle(asking(), deps({ standing }))).outcome).toBe("asked");
  });

  /*
   * THE SWITCH, READ IN ONE PLACE. It used to be read here and again in the plugin store, so a
   * deployment that turned it off had to hope the two agreed — and on the MCP path nothing tested
   * that they did.
   */
  test("settleWithoutAsking off ignores an allowance and offers no scope", async () => {
    const standing = createStandingApprovalStore();
    await standing.grant({
      botId: BOT,
      rule: RULE,
      scope: { kind: "host", value: "example.com" },
      subject: A_CLICK,
      grantedBy: MANAGER,
    });
    const asked: ReviewSubject[] = [];
    const shared = deps({
      standing,
      policy: { ...PERMISSIVE, settleWithoutAsking: "off" },
      autoReview: async (_bot, subject) => {
        asked.push(subject);
        return { allowed: true, reason: "read-only" };
      },
    });

    const settled = await settle(asking(), shared);

    expect(settled.outcome).toBe("asked");
    if (settled.outcome !== "asked") return;
    // No scope on the question, so the card has nothing to offer and the answering route has
    // nothing to grant — one decision, expressed once.
    expect(settled.approval.scope).toBeUndefined();
    // And no instruction was consulted either: the switch covers both ways past a person.
    expect(asked).toEqual([]);
  });

  test("the Bot's own instruction can answer, with nobody's name on it", async () => {
    const shared = deps({
      autoReview: async () => ({ allowed: true, reason: "read-only" }),
    });

    const settled = await settle(asking(), shared);

    expect(settled.outcome).toBe("allowed");
    if (settled.outcome !== "allowed") return;
    // NOBODY'S NAME. The row this produces must not read as a person having stood behind it.
    expect(settled.approvedBy).toBeUndefined();
    expect(settled.autoReviewed).toEqual({
      allowed: true,
      reason: "read-only",
    });
  });

  test("the instruction is shown the same facts the person would be", async () => {
    const asked: ReviewSubject[] = [];
    await settle(
      asking(),
      deps({
        autoReview: async (_bot, subject) => {
          asked.push(subject);
          return null;
        },
      }),
    );
    expect(asked).toEqual([{ action: "computer_click", subject: A_CLICK }]);
  });

  test("an instruction that says no, or cannot be reached, asks a person", async () => {
    for (const verdict of [
      { allowed: false, reason: "this submits a form" },
      null,
    ]) {
      const shared = deps({ autoReview: async () => verdict });
      const settled = await settle(asking(), shared);
      expect(settled.outcome).toBe("asked");
      if (settled.outcome !== "asked") continue;
      // Carried out so the row that records the question can say WHY it is being asked despite the
      // instruction: a declining judge and an unreachable one look identical without it.
      expect(settled.autoReview).toEqual(verdict);
    }
  });

  /*
   * A NO THAT STICKS, and it outranks both of the ways past a person. A model told no could
   * otherwise come back at the same action five seconds later, and the only thing between somebody
   * and being worn down was their patience.
   */
  test("a No that still stands refuses, ahead of an allowance and an instruction", async () => {
    const approvals = createApprovalRegistry();
    const standing = createStandingApprovalStore();
    /** Nothing to judge until the person has answered; then it says yes to everything. */
    let instruction: ReviewVerdict | null = null;
    const shared = deps({
      approvals,
      standing,
      autoReview: async () => instruction,
    });

    const first = await settle(asking(), shared);
    expect(first.outcome).toBe("asked");
    if (first.outcome !== "asked") return;
    await approvals.answer(first.approvalId, BOT, MANAGER, false);

    // Both ways past a person switched on AFTER the No, and neither changes anything: somebody's own
    // answer about this exact action outranks a decision about the whole site and an instruction
    // about the whole Bot, whichever order they were made in.
    instruction = { allowed: true, reason: "read-only" };
    await standing.grant({
      botId: BOT,
      rule: RULE,
      scope: { kind: "host", value: "example.com" },
      subject: A_CLICK,
      grantedBy: MANAGER,
    });

    const second = await settle(asking(), shared);
    expect(second).toEqual({
      outcome: "refused",
      code: "laf:declined_recently",
      declinedRecently: true,
    });
  });

  test("presenting a fresh grant is the one way past a No that stands", async () => {
    const approvals = createApprovalRegistry();
    const shared = deps({ approvals });

    const first = await settle(asking(), shared);
    if (first.outcome !== "asked") throw new Error("expected a question");
    await approvals.answer(first.approvalId, BOT, MANAGER, false);

    // Somebody changed their mind on the card, which opens a question and answers it yes.
    const again = await approvals.request({
      botId: BOT,
      actor: ACTOR,
      rule: RULE,
      subject: A_CLICK,
      fingerprint: CLICK_PRINT,
      target: { type: "computer", id: "default" },
    });
    await approvals.answer(again.id, BOT, MANAGER, true);

    const settled = await settle(
      asking({ presentedApprovalId: again.id }),
      shared,
    );
    expect(settled).toEqual({ outcome: "allowed", approvedBy: MANAGER });
  });

  test("a presented approval is spent once, and the second attempt asks again", async () => {
    const approvals = createApprovalRegistry();
    const shared = deps({ approvals });
    const opened = await approvals.request({
      botId: BOT,
      actor: ACTOR,
      rule: RULE,
      subject: A_CLICK,
      fingerprint: CLICK_PRINT,
      target: { type: "computer", id: "default" },
    });
    await approvals.answer(opened.id, BOT, MANAGER, true);

    expect(
      await settle(asking({ presentedApprovalId: opened.id }), shared),
    ).toEqual({ outcome: "allowed", approvedBy: MANAGER });

    // Single use. "Yes" is permission for one thing to happen once, and a grant left spendable
    // would make it mean "yes, as often as you like".
    const second = await settle(
      asking({ presentedApprovalId: opened.id }),
      shared,
    );
    expect(second.outcome).toBe("asked");
  });

  test("an approval granted for a different action asks rather than passing", async () => {
    const approvals = createApprovalRegistry();
    const shared = deps({ approvals });
    const other = await approvals.request({
      botId: BOT,
      actor: ACTOR,
      rule: RULE,
      subject: A_CLICK,
      fingerprint: fingerprintOf({
        botId: BOT,
        toolName: "computer_click",
        ref: "e13",
      }),
      target: { type: "computer", id: "default" },
    });
    await approvals.answer(other.id, BOT, MANAGER, true);

    const settled = await settle(
      asking({ presentedApprovalId: other.id }),
      shared,
    );
    expect(settled.outcome).toBe("asked");
  });
});

/**
 * The plugin contract's floors, expressed as an input to the same step rather than as a second one.
 *
 * `forcedAsk` is what a guard is: money, external, destructive or a tool that declared nothing stop
 * for a person whatever the written policy allowed, short of `deny`.
 */
describe("a floor that asks whatever the policy allowed", () => {
  function forced(extra: Partial<Parameters<typeof settle>[0]> = {}) {
    return asking({
      subject: A_TOOL_CALL,
      action: "notion/create_page",
      rule: "laf:money",
      allowance: allowanceFor({ tool: "notion/create_page" }),
      policyVerdict: ALLOWED,
      forcedAsk: true,
      ...extra,
    });
  }

  test("asks even though the policy said yes", async () => {
    const shared = deps();
    const settled = await settle(forced(), shared);
    expect(settled.outcome).toBe("asked");
    if (settled.outcome !== "asked") return;
    expect(settled.approval.subject).toEqual(A_TOOL_CALL);
    expect(settled.approval.rule).toBe("laf:money");
  });

  test("does not soften a deny", async () => {
    const settled = await settle(forced({ policyVerdict: DENIED }), deps());
    expect(settled).toEqual({
      outcome: "refused",
      code: "laf:policy_denied",
    });
  });

  /*
   * A PERSON'S OWN ALLOWANCE STILL GETS PAST A FLOOR, which is what this path already did before
   * the sequences were merged and is kept deliberately: somebody pressed "always allow this tool"
   * with the tool's name on the button, which is a decision about the named thing.
   */
  test("an allowance somebody granted for the tool still answers", async () => {
    const standing = createStandingApprovalStore();
    await standing.grant({
      botId: BOT,
      rule: "laf:money",
      scope: { kind: "tool", value: "notion/create_page" },
      subject: A_TOOL_CALL,
      grantedBy: MANAGER,
    });

    const settled = await settle(forced(), deps({ standing }));
    expect(settled.outcome).toBe("allowed");
    if (settled.outcome !== "allowed") return;
    expect(settled.approvedBy).toBe(MANAGER);
  });

  /*
   * BUT THE BOT'S OWN INSTRUCTION DOES NOT. The floor's promise is that a person answers for the
   * exact call, because a money or an external tool's target lives in its arguments; a model reading
   * the owner's standing sentence is not a person seeing the call. This is the one place the two
   * paths deliberately differ, and it differs by an input rather than by a second sequence.
   */
  test("the Bot's own instruction cannot settle a guard floor", async () => {
    const asked: ReviewSubject[] = [];
    const settled = await settle(
      forced(),
      deps({
        autoReview: async (_bot, subject) => {
          asked.push(subject);
          return { allowed: true, reason: "the owner said tools are fine" };
        },
      }),
    );
    expect(settled.outcome).toBe("asked");
    expect(asked).toEqual([]);
  });

  test("a No stands here too", async () => {
    const approvals = createApprovalRegistry();
    const shared = deps({ approvals });
    const first = await settle(forced(), shared);
    if (first.outcome !== "asked") throw new Error("expected a question");
    await approvals.answer(first.approvalId, BOT, MANAGER, false);

    expect((await settle(forced(), shared)).outcome).toBe("refused");
  });
});
