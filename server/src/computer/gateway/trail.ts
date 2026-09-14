/**
 * The rows a computer's actions leave in the audit trail, one writer per kind of row.
 *
 * This is the trail's schema as much as it is code: which fields a row carries, and which it must
 * never carry — the text somebody typed, a file's contents, a query string. A change here is a change
 * to what an investigator can read a year from now, so it lives where it can be reviewed as that,
 * and not inside a diff to whatever action happened to need a new field.
 */
import {
  type AuditStore,
  ELEMENT_NOT_IN_SNAPSHOT,
  recordAuditEvent,
} from "../../audit";
import type { PendingApproval } from "../approvals";
import type { PolicyDecision } from "../policy";
import type { SnapshotElement } from "../schema";
import type { AllowanceTier } from "../standing-approvals";
import { pageForTrail } from "./addresses";
import type { ActionActor } from "./caller";

/**
 * One audit row for one decision.
 *
 * Deliberately absent: the text that was typed. The row says which field was filled and
 * how many characters went into it, and never the value, because a form field is where a password, a
 * card number and a one-time code live. `audit.ts` would redact a key literally called `text`, but
 * relying on that would mean the secret was placed in the payload and caught on the way past; it is
 * simpler and stronger for it never to be put there. `element.name` is a label a page displays, not
 * something a person typed, so it is safe and it is the part an investigator actually needs.
 */
export async function write(
  auditStore: AuditStore,
  entry: {
    toolName: string;
    botId: string;
    actor: ActionActor;
    computerId: string;
    element: SnapshotElement | undefined;
    ref: string | undefined;
    /** Which key, for a keypress. Recorded because a keypress can act without naming a button. */
    key?: string | undefined;
    filePath: string | undefined;
    pageUrl: string;
    decision: PolicyDecision;
    /**
     * Who allowed this, when the boundary asked and somebody said yes.
     *
     * On the action row as well as on the approval row, because the two are found by different
     * questions: a reader following one Bot's actions should not have to go and correlate ids to
     * discover that a person stood behind this particular click.
     */
    approvedBy?: string;
    /**
     * The allowance that answered for them, when nobody was actually asked.
     *
     * `approvedBy` alone would report a standing allowance as somebody having looked at this action,
     * and those are different amounts of attention: one is consent to this click, the other is a
     * decision made once about a whole site. A trail that reported the second as the first would
     * overstate the review on every action an allowance covers — which, being the ones nobody saw,
     * are exactly the ones an investigator is reading the trail to find.
     */
    standingAllowance?: { id: string; scope: string; tier: AllowanceTier };
    /**
     * The reason the Bot's own instruction gave, when that is what let this through.
     *
     * Its own field rather than folded into `approvedBy`, which stays empty here on purpose: this
     * action was seen by nobody, and the row has to be findable as one of those. The reason is what
     * makes the row worth reading — an investigator asking "why was this never questioned" gets a
     * sentence rather than a flag.
     */
    autoReviewed?: string;
    /** Set only when a permitted action was attempted and did not succeed. */
    failure?: string;
  },
) {
  await recordAuditEvent(auditStore, {
    // A failure is its own kind of event, not a variant of "allowed": the whole point of the extra row
    // is that a reader can tell an action that happened from one that was permitted and then did not.
    eventType: entry.failure
      ? "computer.action_failed"
      : entry.decision.allowed
        ? "computer.action_allowed"
        : "computer.action_refused",
    targetType: "computer",
    targetId: entry.computerId,
    // Only ever a real users row. The audit table has a foreign key to it, so writing the local
    // development actor's id here makes every action fail on a constraint violation instead of being
    // recorded. Who it was is in the payload either way.
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      bot: entry.botId,
      actor: entry.actor.id,
      page: pageForTrail(entry.pageUrl),
      ref: entry.ref ?? null,
      /*
       * The key, where there is one. A keypress can submit a form from inside a text field, so the
       * element it was aimed at is not always the thing it acted on. Without the key, the trail
       * cannot distinguish a form-submitting Enter from typing a letter. Bounded, because it is
       * whatever the model sent.
       */
      ...(entry.key ? { key: entry.key.slice(0, 64) } : {}),
      // The path, never the contents. A Bot writes down what it was told, so a file body is exactly as
      // sensitive as text typed into a form field, and for the same reason it is not put here.
      ...(entry.filePath ? { file: entry.filePath } : {}),
      element: entry.element
        ? {
            role: entry.element.role,
            name: entry.element.name,
            ...(entry.element.type ? { type: entry.element.type } : {}),
          }
        : entry.filePath
          ? // A file action has no element and never will. File rows leave the element field absent
            // rather than describing a browser snapshot.
            undefined
          : /*
             * An action on an element the server cannot identify is worth recording plainly, rather
             * than as an absent field that reads like a logging gap.
             *
             * A CODE AND NOT A SENTENCE. This was the English string "not in the current snapshot",
             * and the audit table printed it verbatim — one English line in the middle of a Korean
             * trail, written by the server, which owns no words on any surface. The trail carries
             * the fact; `admin/audit.tsx` owns what a reader is told it means.
             */
            ELEMENT_NOT_IN_SNAPSHOT,
      ...(entry.failure ? { failure: entry.failure } : {}),
      decision: {
        allowed: entry.decision.allowed,
        source: entry.decision.source,
        rule: entry.decision.matched,
        // What kind of refusal, where there is more to say than the rule. Queryable, unlike the
        // sentence beside it, which is why the trail carries both.
        ...(entry.decision.code ? { code: entry.decision.code } : {}),
        ...(entry.approvedBy ? { approvedBy: entry.approvedBy } : {}),
        // Structured rather than folded into the reason, so "everything an allowance let through"
        // is a query somebody can actually run.
        ...(entry.standingAllowance
          ? {
              allowance: entry.standingAllowance.id,
              allowanceScope: entry.standingAllowance.scope,
              // Which kind: a decision for good, or one for the conversation this action came
              // from. "Everything a conversation's allowance let through" is its own query.
              allowanceTier: entry.standingAllowance.tier,
            }
          : {}),
        ...(entry.autoReviewed ? { autoReviewed: entry.autoReviewed } : {}),
        /**
         * Whether the action actually went on to run.
         *
         * The same as `allowed` now that everything enforces, and kept because the rows written
         * before that are not: a reader filtering on it finds the dry-run era's refusals that ran
         * anyway, and a future third answer would land here rather than in a new field.
         */
        carriedOut: entry.decision.forward,
      },
    },
  });
}

/**
 * One row for a Bot going round in circles.
 *
 * Separate from `write` because there is no policy decision to record. This row is an observation
 * about the call that is about to be decided, not the decision, and giving it a `decision` block
 * would mean inventing an answer the policy was never asked for. It is also why it is not a refusal:
 * nothing was forbidden here.
 *
 * The fingerprint goes in as written, which is why `repeat.ts` builds a readable one. A reader
 * arriving at "the same call, 25 times" needs to be told which call in the row itself.
 */
export async function writeRepeat(
  auditStore: AuditStore,
  entry: {
    toolName: string;
    botId: string;
    actor: ActionActor;
    computerId: string;
    pageUrl: string;
    filePath: string | undefined;
    fingerprint: string;
    count: number;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType: "computer.action_repeated",
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      bot: entry.botId,
      actor: entry.actor.id,
      // The page, for a browser action only. A file call has nothing to do with whatever the browser
      // happens to be showing, and naming a host on that row sends a reader somewhere irrelevant, the
      // same trap `describeRefusal` avoids.
      ...(entry.filePath ? {} : { page: entry.pageUrl }),
      fingerprint: entry.fingerprint,
      count: entry.count,
    },
  });
}

/**
 * One row for a handover.
 *
 * Separate from `write` because a handover has no element, no file and no policy decision, forcing it
 * through the same shape would mean inventing a decision that was never asked for, and a row claiming
 * a policy allowed something it never saw is exactly the kind of comfortable fiction this trail exists
 * to avoid.
 */
export async function writeControlEvent(
  auditStore: AuditStore,
  eventType:
    | "computer.help_requested"
    | "computer.control_taken"
    | "computer.control_released"
    | "computer.secret_requested"
    | "computer.secret_supplied"
    | "computer.stopped"
    | "computer.reset",
  entry: {
    botId: string;
    actor: ActionActor;
    computerId: string;
    reason?: string;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      bot: entry.botId,
      actor: entry.actor.id,
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  });
}

/**
 * The row for a question the boundary stopped to ask.
 *
 * Its own writer rather than a variant of either of the others, because an approval sits between
 * them and fits neither shape. It is not `write`: no decision was reached, the policy said it wanted
 * a person and the turn stopped there, and inventing an allowed-or-refused verdict for that row would
 * be the comfortable fiction the rest of this file is careful to avoid. It is not
 * `writeControlEvent`: a handover is a person taking the browser away from the Bot, whereas this is a
 * question about one specific action, so the row has to name the action or a reader cannot tell what
 * was being agreed to.
 *
 * The answer's row is written where the answer is given, which is not here. All of them carry the
 * approval id: that is what lets a reader join a request to its answer and to the action that
 * finally happened, and it is the only way to see the case that matters most, a question that was
 * asked and never answered.
 */
export async function writeApprovalEvent(
  auditStore: AuditStore,
  entry: {
    botId: string;
    actor: ActionActor;
    computerId: string;
    approval: PendingApproval;
    toolName?: string;
    pageUrl?: string;
    filePath?: string | undefined;
    /**
     * What the Bot's own instruction made of this, when there was one.
     *
     * On the row that says a person was asked, because that is the row somebody reads when they
     * want to know why they are being asked despite having written an instruction. Without it the
     * two reasons look identical from here — the instruction did not cover this, and the model
     * could not be reached — and the difference is the whole of whether the feature is working.
     */
    autoReview?: { allowed: boolean; reason: string } | null;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType: "approval.requested",
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      bot: entry.botId,
      actor: entry.actor.id,
      approval: entry.approval.id,
      rule: entry.approval.rule,
      /*
       * What was being asked about, in the same facts the card was drawn from — not the sentence.
       *
       * The row used to hold the English sentence the policy assembled, which meant the trail was
       * the only place that sentence still existed once the surface started composing its own: two
       * descriptions of one question, drifting. Element labels are things a page displays rather
       * than things anybody typed, which is why they are safe to keep here; see `write` above.
       */
      subject: entry.approval.subject,
      ...(entry.toolName ? { action: entry.toolName } : {}),
      ...(entry.pageUrl ? { page: entry.pageUrl } : {}),
      ...(entry.filePath ? { file: entry.filePath } : {}),
      // An empty reason is the judge having failed rather than having decided, and the two are said
      // differently: "could not be reached" is somebody's provider being down, not their rule being
      // too narrow, and only one of those is worth editing the rule over.
      ...(entry.autoReview
        ? {
            autoReview: entry.autoReview.reason
              ? `declined: ${entry.autoReview.reason}`
              : "could not be reached",
          }
        : {}),
    },
  });
}
