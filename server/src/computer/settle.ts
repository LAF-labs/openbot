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
  ApprovalStep,
  AskSubject,
  CallPreview,
  PendingApproval,
} from "./approvals";
import type { ReviewSubject, ReviewVerdict } from "./auto-review";
import type { HighRiskVerdict } from "./high-risk";
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
  /**
   * What an outward call will send, for the card. Goes on the approval and NOWHERE else: not on
   * a row, not on an allowance, not in front of the judge below. See {@link CallPreview}.
   */
  preview?: CallPreview | undefined;
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
   * The conversation step the action came from — thread and tool call — where the surface named
   * one. Goes on a question whatever `settleWithoutAsking` says, unlike `threadId` above: it is where
   * the question was raised, which every window of that conversation needs to draw it, not an
   * allowance anybody could be granted.
   */
  step?: ApprovalStep | undefined;
  /** The caller's own policy verdict, evaluated against the caller's own context. */
  policyVerdict: PolicyDecision;
  /**
   * A floor that asks whatever the policy allowed, short of `deny`.
   *
   * The plugin contract's guards — money, external, destructive, and a tool that declared nothing —
   * where the call's target lives in its arguments, so a person is asked about it with those
   * arguments in front of them (the preview above) rather than a written rule or a model deciding.
   * An allowance a person granted for the tool still answers, as below. Expressed as an input
   * rather than as a second sequence beside this one, which is what it was.
   */
  forcedAsk?: boolean;
  /**
   * Whether this is a high-risk submission (`high-risk.ts`), asked only when the answer could
   * matter and at most once.
   *
   * A yes turns whatever would have let the action past without a person — the policy's own
   * `allow`, a standing allowance, the owner's instruction — into a question, and the question
   * offers no wider answer: an allowance granted from it would be one this check walks past every
   * time, a button that saves and does nothing. It never allows anything, it is never asked about a
   * `deny`, and a presented approval that matches is not second-guessed — the person saw this very
   * action and said yes.
   */
  highRisk?: (() => Promise<HighRiskVerdict>) | undefined;
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
      /** What the high-risk check made of it, where it consulted anything. */
      highRisk?: HighRiskVerdict;
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
      /** The high-risk check's verdict, where it was asked. An escalation is why this was asked. */
      highRisk?: HighRiskVerdict;
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
    if (!verdict.forward) {
      return { outcome: "refused", code: verdict.code ?? "laf:policy_denied" };
    }
    if (!input.highRisk) return { outcome: "allowed" };
    return settleAllowed(input, deps, input.highRisk);
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

  /*
   * THE TASK THE CONVERSATION IS ON NOW, read here rather than taken from anybody: it is what a
   * "이 일 동안" allowance answers for, and what one granted from this question would bind to.
   */
  const taskId =
    mayStand && input.threadId && !presented?.ok
      ? await deps.standing
          ?.currentTask?.(input.threadId)
          .catch(() => undefined)
      : undefined;

  /*
   * THE HIGH-RISK CHECK, BEFORE ANYTHING THAT COULD PASS THIS WITHOUT A PERSON. Asked even where a
   * person will be asked anyway, so that the card is honest: a high-risk submission is offered this
   * once and nothing wider.
   */
  const risk =
    presented?.ok || !input.highRisk ? undefined : await input.highRisk();
  const escalated = risk?.escalate === true;

  const already =
    presented?.ok || !mayStand || escalated
      ? null
      : ((await deps.standing?.find(
          input.botId,
          input.rule,
          scopeKeyOf(input.allowance),
          { threadId: input.threadId, taskId },
        )) ?? null);

  /*
   * The owner's own sentence, asked about this action, and only after the cheap answers.
   *
   * NOT ON A GUARD FLOOR, and the exception is the whole reason the floor exists. A tool declared to
   * move money, to send something outward or to destroy something is one whose target lives in its
   * arguments, and the contract's promise is that a person — never a model — decides about it. A
   * model reading the owner's standing sentence is not a person seeing the call. A standing
   * allowance still gets past a floor, because that is a person's own deliberate decision about that
   * named tool, made on a card about it — for the catalogue's outward tools, one that showed them the
   * call it was pressed on; the owner kept it that way on 2026-09-16 — but nothing new is waved
   * through by a judge.
   *
   * The judge is handed the subject and never the preview: the words a call would send are exactly
   * where an instruction planted in a mail or a web page would be written.
   */
  const reviewed =
    presented?.ok ||
    already ||
    !mayStand ||
    floorAsks ||
    escalated ||
    !deps.autoReview
      ? null
      : await deps.autoReview(input.botId, {
          action: input.action,
          subject: input.subject,
        });

  if (presented?.ok && presented.approval.answeredBy) {
    return { outcome: "allowed", approvedBy: presented.approval.answeredBy };
  }
  const checked = risk && risk.signals.length > 0 ? { highRisk: risk } : {};
  if (already) {
    return {
      outcome: "allowed",
      approvedBy: already.grantedBy,
      allowance: already,
      ...checked,
    };
  }
  if (reviewed?.allowed) {
    // Nobody's name goes on this. `approvedBy` stays absent, so the caller's row cannot read as a
    // person having stood behind it — the one thing this record must never claim.
    return { outcome: "allowed", autoReviewed: reviewed, ...checked };
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
  // Absent where the deployment has turned allowances off: the card then offers two buttons and
  // the answering route has nothing to grant, without either of them knowing why. The thread and
  // the task go with the scope: "for this conversation" and "for this task" are kinds of
  // allowance and off with the rest — and off for a high-risk submission, which no allowance passes.
  const wider = mayStand && !escalated;
  const approval = await deps.approvals.request({
    botId: input.botId,
    actor: input.actorId,
    rule: input.rule,
    subject:
      escalated && risk ? highRiskSubject(input.subject, risk) : input.subject,
    ...(input.preview ? { preview: input.preview } : {}),
    fingerprint: input.fingerprint,
    ...(wider ? { scope: input.allowance } : {}),
    ...(wider && input.threadId ? { threadId: input.threadId } : {}),
    ...(wider && input.threadId && taskId ? { taskId } : {}),
    ...(input.step ? { step: input.step } : {}),
    target: input.target,
  });
  return {
    outcome: "asked",
    approvalId: approval.id,
    approval,
    autoReview: reviewed,
    ...(risk ? { highRisk: risk } : {}),
  };
}

/** The subject a person is shown for a high-risk submission: the same action, and why. */
function highRiskSubject(
  subject: AskSubject,
  risk: HighRiskVerdict,
): AskSubject {
  const { repeatCount: _repeat, ...rest } = subject;
  return { ...rest, reason: "high_risk", risk: risk.kinds };
}

/**
 * An action the policy itself allowed, with a high-risk check to consult.
 *
 * The check is the only thing here that can stop it, and only by asking. A presented approval that
 * matches is spent first — the person already saw this action on a card this check raised — and a
 * No still standing refuses, exactly as for any other question.
 */
async function settleAllowed(
  input: SettleInput,
  deps: SettleDeps,
  highRisk: () => Promise<HighRiskVerdict>,
): Promise<SettleResult> {
  const presented = input.presentedApprovalId
    ? await deps.approvals.consume(input.presentedApprovalId, input.fingerprint)
    : undefined;
  if (presented?.ok && presented.approval.answeredBy) {
    return { outcome: "allowed", approvedBy: presented.approval.answeredBy };
  }
  const risk = await highRisk();
  if (!risk.escalate) {
    return {
      outcome: "allowed",
      ...(risk.signals.length > 0 ? { highRisk: risk } : {}),
    };
  }
  if (await deps.approvals.recentlyDeclined(input.botId, input.fingerprint)) {
    return {
      outcome: "refused",
      code: "laf:declined_recently",
      declinedRecently: true,
    };
  }
  const approval = await deps.approvals.request({
    botId: input.botId,
    actor: input.actorId,
    rule: input.rule,
    subject: highRiskSubject(input.subject, risk),
    ...(input.preview ? { preview: input.preview } : {}),
    fingerprint: input.fingerprint,
    ...(input.step ? { step: input.step } : {}),
    target: input.target,
  });
  return {
    outcome: "asked",
    approvalId: approval.id,
    approval,
    autoReview: null,
    highRisk: risk,
  };
}
