/**
 * ONE SETTLE STEP, FOR EVERY ACTION A BOUNDARY STOPS.
 *
 * A Bot pressing a button on a website and a Bot calling a tool on somebody else's server are the
 * same interruption to the same person, and until this file existed they were two sequences. The
 * gateway's ran fingerprint → presented approval → sticky decline → standing allowance → auto-review
 * → open the question; `plugins/call.ts` hand-wrote the same thing without the auto-review, and both
 * read `settleWithoutAsking` for themselves (docs/laf/redesign-2026-09.md §3.1 "게이트웨이가 둘이다").
 * Two copies of a boundary are not a boundary: fixing one leaves the other wrong, and the one that
 * is wrong is whichever nobody was looking at.
 *
 * WHAT IT DECIDES AND WHAT IT DOES NOT. It is handed a verdict the caller's own policy context
 * produced — the two contexts are genuinely different, a browser action has an element and a tool
 * call has arguments — and it decides what happens to that verdict once a person, an allowance and
 * an instruction are folded in. It writes no audit rows and throws nothing: the caller records what
 * came back, against the target it owns, and turns it into its own error type. So the trail keeps
 * saying which subsystem an action happened in while the decision behind it is made once.
 *
 * THE ORDER IS THE POLICY. A person's own No about this exact action outranks everything, including
 * an allowance they granted last week; a presented approval is the one thing that gets past it. Then
 * an allowance, then the Bot's own instruction — cheapest first, and the model call last because it
 * sits between a Bot and its next action. `deny` never reaches any of them.
 */
import type {
  ApprovalRegistry,
  AskSubject,
  PendingApproval,
} from "./approvals";
import type { ReviewSubject, ReviewVerdict } from "./auto-review";
import type { ActionPolicy, FactCode, PolicyDecision } from "./policy";
import {
  type AllowanceScope,
  type StandingApproval,
  type StandingApprovalStore,
  scopeKeyOf,
} from "./standing-approvals";

export type SettleInput = {
  botId: string;
  /** Who was driving. Not necessarily who answers, which is the point of recording both. */
  actorId: string;
  /** What is about to happen, in facts. Goes on the approval and on the caller's audit row. */
  subject: AskSubject;
  /** The tool about to run, for the judge. `computer_click`, or an MCP tool's reference. */
  action: string;
  /**
   * The hash that binds one approval to one action.
   *
   * Computed by the caller, because what makes two calls the same call differs by path: a click is
   * identified by the thing it lands on, a call to somebody else's server by what it says.
   */
  fingerprint: string;
  /** What answering "always" would cover. See `standing-approvals.ts`. */
  allowance: AllowanceScope;
  /** The expression that asked. Empty where a floor asked rather than a written rule. */
  rule: string;
  /** Where the answer's own audit row is filed. See PendingApproval.target. */
  target: { type: string; id: string };
  /** An answer a person already gave, being presented for the action it was given for. */
  presentedApprovalId?: string | undefined;
  /**
   * The conversation the action was raised from, where it was raised from one.
   *
   * Two things read it: an allowance bound to a conversation answers only for its own, and a
   * question opened from a conversation offers "for this conversation" as an answer. Absent for
   * work outside any — a routine — where neither applies.
   */
  threadId?: string | undefined;
  /**
   * Set when this turn is one Bot answering another, with no person watching it.
   *
   * A boundary that wants a person cannot be satisfied here: there is nobody to open a question
   * in front of, and the Bot's own instruction is not eyes. So an `ask` in a delegated turn is
   * refused with `laf:ask_in_delegated_turn` rather than asked — unless a person already answered
   * the wider question with a standing allowance, which is their deliberate decision about that
   * named tool and is honoured wherever the Bot is.
   */
  delegated?: { callerId: string } | undefined;
  /** The caller's own policy verdict, evaluated against the caller's own context. */
  policyVerdict: PolicyDecision;
  /**
   * A floor that asks whatever the policy allowed, short of `deny`.
   *
   * The plugin contract's guards — money, external, destructive, and a tool that declared nothing —
   * where a person answers for the exact call because its target lives in its arguments and no scope
   * decided in advance can cover it. Expressed as an input rather than as a second sequence beside
   * this one, which is what it was.
   */
  forcedAsk?: boolean;
};

export type SettleDeps = {
  /** Read at settle time, never captured: a rule changed a moment ago applies to this action. */
  policy: () => ActionPolicy | undefined;
  approvals: ApprovalRegistry;
  /** Absent behaves as a deployment where nobody has granted anything: every asked action asks. */
  standing?: StandingApprovalStore | undefined;
  /**
   * The Bot owner's own sentence about what they do not want to be asked.
   *
   * Absent means every stopped action is put in front of somebody. See `auto-review.ts`.
   */
  autoReview?:
    | ((botId: string, subject: ReviewSubject) => Promise<ReviewVerdict | null>)
    | undefined;
};

export type SettleResult =
  | {
      outcome: "allowed";
      /** The person whose yes this is. Absent when nobody's is: see `autoReviewed`. */
      approvedBy?: string;
      /** Set when the yes came from an allowance rather than from anybody looking at this action. */
      allowance?: StandingApproval;
      /** Set when the yes came from the owner's instruction and no person saw the action at all. */
      autoReviewed?: ReviewVerdict;
    }
  | {
      outcome: "refused";
      code: FactCode;
      /** True for the one refusal this file produces itself: a No that still stands. */
      declinedRecently?: true;
    }
  | {
      outcome: "asked";
      approvalId: string;
      /** The whole record, because the caller's error type and its audit row both need it. */
      approval: PendingApproval;
      /**
       * What the Bot's own instruction made of this, where it was consulted at all.
       *
       * Null covers two different things and the caller says which on the row: there was no
       * instruction, or the judge could not be reached. Both mean a person is asked.
       */
      autoReview: ReviewVerdict | null;
    };

/**
 * Decide what happens to one stopped action.
 *
 * Never throws for a boundary outcome. A refusal, a question and a pass are three answers to one
 * question and a caller handles all three; making one of them an exception would put the decision
 * back in the caller's error handling, which is where the second copy of this started.
 */
export async function settle(
  input: SettleInput,
  deps: SettleDeps,
): Promise<SettleResult> {
  const { policyVerdict: verdict } = input;
  const policyAsks = verdict.source === "ask" && !verdict.forward;
  // The floor only ever adds a question to something the policy was willing to allow. A `deny` is
  // not a question — nothing here can soften one, which is the property that makes an allowance and
  // an instruction conveniences rather than holes.
  const floorAsks = input.forcedAsk === true && verdict.forward;

  if (!policyAsks && !floorAsks) {
    return verdict.forward
      ? { outcome: "allowed" }
      : { outcome: "refused", code: verdict.code ?? "laf:policy_denied" };
  }

  const presented = input.presentedApprovalId
    ? await deps.approvals.consume(input.presentedApprovalId, input.fingerprint)
    : undefined;

  /*
   * A NO THAT STICKS.
   *
   * Declining used to leave the audit row and nothing else: the next attempt found no approval to
   * spend and opened a fresh question, so a model that had been told no could ask again, and again,
   * and the only thing between somebody and being worn down was their patience.
   *
   * Before the allowance and before the instruction, because a person's own answer about THIS action
   * outranks both. Presenting a fresh grant is the one way past it, which is what keeps the card on
   * the surface working if somebody changes their mind.
   */
  if (
    !presented?.ok &&
    (await deps.approvals.recentlyDeclined(input.botId, input.fingerprint))
  ) {
    return {
      outcome: "refused",
      code: "laf:declined_recently",
      declinedRecently: true,
    };
  }

  /*
   * WHETHER THIS QUESTION CAN BE ANSWERED FOR GOOD AT ALL, READ IN ONE PLACE.
   *
   * A deployment that has decided every one of these actions gets a pair of eyes says so here, and
   * the one switch does the whole job on both paths: nothing standing is honoured, no instruction is
   * consulted, and the approval goes out without a scope — which is already how the card and the
   * answering route read "there is nothing to grant". It used to be read in the gateway and again in
   * the plugin store, and a deployment turning it off had to hope the two agreed.
   */
  const mayStand =
    (deps.policy()?.settleWithoutAsking ?? "allowed") === "allowed";

  const already =
    presented?.ok || !mayStand
      ? null
      : ((await deps.standing?.find(
          input.botId,
          input.rule,
          scopeKeyOf(input.allowance),
          { threadId: input.threadId },
        )) ?? null);

  /*
   * NOBODY IS WATCHING A DELEGATED TURN, so nothing below this line can happen in one.
   *
   * A question would sit in the registry with no surface to draw it on, and the instruction would
   * be a model answering for a model with nobody having seen either. What a person already decided
   * about this named thing — a presented answer, an allowance — has been read above and stands;
   * everything from here on needs eyes, and this turn has none. The refusal names the fact so the
   * caller can say what it could not do and who would have to do it.
   */
  if (input.delegated && !presented?.ok && !already) {
    return { outcome: "refused", code: "laf:ask_in_delegated_turn" };
  }

  /*
   * The owner's own sentence, asked about this action, and only after the cheap answers.
   *
   * NOT ON A GUARD FLOOR, and the exception is the whole reason the floor exists. A tool declared to
   * move money, to send something outward or to destroy something is one whose target lives in its
   * arguments, and the contract's promise is that a person answers for the exact call. A model
   * reading the owner's standing sentence is not a person seeing the call. A standing allowance
   * still gets past a floor, because that is a person's own deliberate decision about that named
   * tool and it is what this path already did — but nothing new is waved through by a judge.
   */
  const reviewed =
    presented?.ok || already || !mayStand || floorAsks || !deps.autoReview
      ? null
      : await deps.autoReview(input.botId, {
          action: input.action,
          subject: input.subject,
        });

  if (presented?.ok && presented.approval.answeredBy) {
    return { outcome: "allowed", approvedBy: presented.approval.answeredBy };
  }
  if (already) {
    return {
      outcome: "allowed",
      approvedBy: already.grantedBy,
      allowance: already,
    };
  }
  if (reviewed?.allowed) {
    // Nobody's name goes on this. `approvedBy` stays absent, so the caller's row cannot read as a
    // person having stood behind it — the one thing this record must never claim.
    return { outcome: "allowed", autoReviewed: reviewed };
  }

  /*
   * Every unsuccessful presentation asks again rather than failing: an expired approval, an id
   * already spent, a No being replayed and an approval granted for a different button all mean the
   * same thing here, which is that nobody has agreed to THIS. Asking twice is annoying and safe;
   * guessing which of those deserves an error is neither.
   *
   * An approval with nobody's name on it lands here too, rather than falling back to whoever was
   * driving the Bot: crediting consent to the actor is the one attribution this record must never
   * make.
   */
  const approval = await deps.approvals.request({
    botId: input.botId,
    actor: input.actorId,
    rule: input.rule,
    subject: input.subject,
    fingerprint: input.fingerprint,
    // Absent where the deployment has turned allowances off: the card then offers two buttons and
    // the answering route has nothing to grant, without either of them knowing why. The thread
    // goes with the scope: "for this conversation" is a kind of allowance and off with the rest.
    ...(mayStand ? { scope: input.allowance } : {}),
    ...(mayStand && input.threadId ? { threadId: input.threadId } : {}),
    target: input.target,
  });
  return {
    outcome: "asked",
    approvalId: approval.id,
    approval,
    autoReview: reviewed,
  };
}
