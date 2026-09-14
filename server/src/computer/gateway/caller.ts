/**
 * What a caller hands the gateway, and the two ways an action comes back without having happened.
 *
 * The routes, the unattended runner and the rooms all speak to the gateway in these terms and in no
 * others, which is why they are exported from `../gateway` as well as living here: a caller that has
 * to tell a refusal from a pause should not need to know how the gateway is put together.
 */
import type { AskSubject, PendingApproval } from "../approvals";
import type { FactCode } from "../policy";
import type { AllowanceScope } from "../standing-approvals";

export class ActionRefusedError extends Error {
  /** The rule that refused it, so the surface can show which one and an operator can find it. */
  readonly rule: string | null;
  /**
   * What kind of refusal this was, as a code each reader phrases for itself.
   *
   * THE MESSAGE IS THE CODE. It used to be an English sentence the policy assembled, and it went out
   * of the route as `error`, into a Korean-speaking model as a tool result and onto a Korean screen
   * as the reason an action was blocked. Now the code is the whole of what crosses: the model's
   * Korean is in `shared/prompt/tool-results.ko.ts`, the person's is in `i18n-ko.ts`, and neither is
   * written by this file. See `FactCode`.
   */
  readonly code: FactCode;

  constructor(rule: string | null, code: FactCode) {
    super(code);
    this.name = "ActionRefusedError";
    this.rule = rule;
    this.code = code;
  }
}

/**
 * The boundary wants a person's answer before this happens.
 *
 * Emphatically not an {@link ActionRefusedError}. A refusal is final and the Bot should say so and
 * move on; this one is a pause, and the same Bot presenting the same request again with an approval
 * on it is the intended next step rather than an attempt to get around anything. Collapsing the two
 * would teach a model to give up on exactly the actions a deployment was willing to permit, which is
 * the failure that makes an ask list worse than useless.
 */
export class ActionNeedsApprovalError extends Error {
  /** What the caller presents once somebody has answered. */
  readonly approvalId: string;
  /** What is being asked about, in facts. The sentence is composed where it is read. */
  readonly subject: AskSubject;
  /** The rule that asked, so the surface can name the boundary the way a refusal does. */
  readonly rule: string;
  /**
   * What answering "always" would cover, so the card can say it on the button.
   *
   * Carried out with the question rather than fetched back: the facts a person reads and the scope
   * that gets granted have to be the same record, and a surface that went and asked separately could
   * show one and grant the other. Absent means the card offers only "this once".
   */
  readonly scope: AllowanceScope | undefined;
  /** Present when "for this conversation" is on offer: the card draws that button off it. */
  readonly threadId: string | undefined;
  /**
   * When the question stops being answerable.
   *
   * Carried because the card is drawn from this reply and from nothing else, and a card with no
   * clock on it simply vanished after ten minutes with nothing having said it would
   * (docs/laf/redesign-2026-09.md §5.6(g)-7).
   */
  readonly expiresAt: string;

  constructor(approval: PendingApproval) {
    super("laf:awaiting_approval");
    this.name = "ActionNeedsApprovalError";
    this.approvalId = approval.id;
    this.subject = approval.subject;
    this.rule = approval.rule;
    this.scope = approval.scope;
    this.threadId = approval.threadId;
    this.expiresAt = approval.expiresAt;
  }
}

/**
 * The header a surface names its conversation in, so an allowance can be "for this conversation".
 *
 * A header rather than a body field because the acting routes take many shapes and the one thing
 * they share is the request. Optional everywhere: an action with no conversation behind it — a
 * routine, a call from something that is not a chat — is asked and answered in the standing terms
 * alone, which is what every action was before the middle answer existed.
 */
export const THREAD_HEADER = "x-openbot-thread-id";

/** Who is asking. The gateway records this; it does not decide it. */
export type ActionActor = {
  /** The signed-in person, or the local actor when authentication is not configured. */
  id: string;
  /** Null unless this is a real row in `users`, because the audit table has a foreign key to it. */
  userId?: string;
  /** The conversation the action was raised from, when it was raised from one. See THREAD_HEADER. */
  threadId?: string;
  /**
   * Set when the turn is one Bot answering another with nobody watching.
   *
   * Nothing sets it today: a coworker answering a question runs with no tools at all
   * (`agents/coworker-call.ts`), so no action of its reaches here. It is the seam for the day
   * that changes, and `settle` refuses an `ask` under it rather than opening a question nobody
   * will see.
   */
  delegated?: { callerId: string };
};
