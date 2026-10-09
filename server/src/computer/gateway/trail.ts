/**
 * The rows a computer's actions leave in the audit trail, one writer per kind of row.
 *
 * This is the trail's schema as much as it is code: which fields a row carries, and which it must
 * never carry — the text somebody typed, a file's contents, a query string. A change here is a change
 * to what an investigator can read a year from now, so it lives where it can be reviewed as that,
 * and not inside a diff to whatever action happened to need a new field.
 */
import type {
  ProductsRefusal,
  RunEnding,
} from "../../../../shared/workbench/protocol";
import {
  type AuditStore,
  ELEMENT_NOT_IN_SNAPSHOT,
  recordAuditEvent,
} from "../../audit";
import type { PendingApproval } from "../approvals";
import type { PolicyDecision } from "../policy";
import type { SnapshotElement } from "../schema";
import type { HighRiskVerdict } from "../high-risk";
import type { AllowanceTier } from "../standing-approvals";
import { originOf, pageForTrail } from "./addresses";
import type { ActionActor } from "./caller";

/**
 * What a row says of a script: its SHA-256, its length in bytes, and the files it names.
 *
 * THE WHOLE OF WHAT THE TRAIL HOLDS OF ONE. A script is a model's text and may carry anything a
 * person told their Bot, so the row keeps what identifies it and nothing of what it says — the
 * rule typed text and a written file's contents are held to in `write` below. The digest is found
 * again from the conversation, where the script is the call's arguments, for as long as that
 * conversation exists (the owner's decision, 2026-10-07: the digest and length, no second copy).
 */
export type ScriptOnTrail = {
  sha256: string;
  bytes: number;
  files: readonly string[];
};

/**
 * The fields a row carries about a script: for the run's own rows what identifies it, and for a
 * file read or filed on its behalf the digest alone — which run this row belongs to. Never more
 * than these.
 */
function scriptForTrail(
  script: ScriptOnTrail | undefined,
  forScript: string | undefined,
) {
  return {
    ...(script
      ? {
          script: { sha256: script.sha256, bytes: script.bytes },
          // The paths it was to read, as the Bot named them. Each read has its own row as well.
          files: [...script.files],
        }
      : {}),
    // Until 2026-10-07 a run's reads and files were tied to it by nothing but the order of rows.
    ...(forScript ? { forScript } : {}),
  };
}

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
    /**
     * Every box of a card that asks a person for several values, first to last — `element` and
     * `ref` above are then the one the decision turned on (`govern.ts`, `alsoRefs`).
     */
    fields?: readonly { ref: string; role: string; name: string }[] | undefined;
    /** The saved login an act put into a page (`FILL_LOGIN_TOOL`). */
    login?: { id: string; site?: string } | undefined;
    /** Which key, for a keypress. Recorded because a keypress can act without naming a button. */
    key?: string | undefined;
    filePath: string | undefined;
    /** The script, for a run: what identifies it. See {@link ScriptOnTrail}. */
    script?: ScriptOnTrail | undefined;
    /** The digest of the script a file was read or filed for. See `govern`'s `forScript`. */
    forScript?: string | undefined;
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
    /** The high-risk check's reading, where it consulted anything. Kinds and signals, never values. */
    highRisk?: HighRiskVerdict;
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
      ...(entry.fields ? { fields: entry.fields } : {}),
      // Which saved login, by its id and the site it was saved under — never what the person
      // called it, and never anything of what it holds (the vault's own rows say the same).
      ...(entry.login ? { login: entry.login } : {}),
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
      ...scriptForTrail(entry.script, entry.forScript),
      element: entry.element
        ? {
            role: entry.element.role,
            name: entry.element.name,
            ...(entry.element.type ? { type: entry.element.type } : {}),
          }
        : !entry.ref
          ? /*
             * An action that names no element has none, and its row leaves the field absent: a
             * file's, and equally a navigation's, a look's or a scroll's.
             *
             * ONLY A FILE ACTION USED TO BE LEFT OUT, and every other row without an element was
             * written as the fact below — so going to an address was recorded as acting on
             * something "not in the current snapshot". Read off the fleet on 2026-10-02: 14 of the
             * week's 18 failure signals were this, every one a navigation that had worked. The
             * trail said a thing that had not happened, and the figure an operator reads was four
             * times what had gone wrong.
             */
            undefined
          : /*
             * An action on an element the server cannot identify — it named a ref, and the ref is
             * in no snapshot the server holds — is worth recording plainly, rather than as an
             * absent field that reads like a logging gap.
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
        ...(entry.highRisk
          ? { highRisk: highRiskForTrail(entry.highRisk) }
          : {}),
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
 * One row for a look at the screen that could not see all of it.
 *
 * A snapshot decides nothing and changes nothing, so it has never had a row, and still does not for
 * the ordinary look — a Bot takes several per task, and a row for each would bury the actions this
 * trail exists for under the Bot reading its own screen. What is worth a row is the frame it could
 * not see into: that is where a Bot gets stuck, and on which site, which is what laf-control's
 * `insights` counts (`computer.action_allowed` with `action: computer_snapshot`, `opaqueFrames`).
 *
 * NO DECISION BLOCK, because none was made: `write` would have to invent one. And the page as its
 * origin only — scheme and host, no path — because the site is the whole of what this row is for.
 */
export async function writeSnapshotRow(
  auditStore: AuditStore,
  entry: {
    botId: string;
    actor: ActionActor;
    computerId: string;
    pageUrl: string;
    opaqueFrames: number;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: "computer_snapshot",
      bot: entry.botId,
      actor: entry.actor.id,
      // `about:blank` has the origin "null", which is not a site.
      page: /^https?:/i.test(entry.pageUrl) ? originOf(entry.pageUrl) : "",
      opaqueFrames: entry.opaqueFrames,
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
      // same trap `describeRefusal` avoids. Without its query, as `write` has it: this row kept
      // `?pin=…` whole until audit R3-03 (2026-09-16).
      ...(entry.filePath ? {} : { page: pageForTrail(entry.pageUrl) }),
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
 * One row for a file a person took out of their Bot's folder.
 *
 * Its own writer for the reason a handover has one: nobody asked the policy, so `write` would have
 * to invent the decision it records. The path and the size, and never the contents — the rule
 * `write` keeps for a file a Bot wrote, kept for the same file being carried away.
 */
export async function writeFileDownloaded(
  auditStore: AuditStore,
  entry: {
    botId: string;
    actor: ActionActor;
    computerId: string;
    filePath: string;
    bytes: number;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType: "computer.file_downloaded",
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      bot: entry.botId,
      actor: entry.actor.id,
      file: entry.filePath,
      bytes: entry.bytes,
    },
  });
}

/**
 * One row for a script that ran to an ending.
 *
 * Its own writer for the reason a handover and a download have theirs: nothing is decided here.
 * The decision to run it has its row already — `write`, before the script was sent anywhere — and
 * every file it made gets a decision and a row of its own afterwards. This is the fact between
 * them: it ran, and this is how it ended.
 *
 * FIELD BY FIELD, AND NEVER A SPREAD. What the sandbox reports about a run holds what the script
 * printed, and what it handed back holds files; this takes the counts and the names out of them
 * one at a time, so that a field added to either cannot arrive here by being there. A file's name
 * is the script's own choice and is kept, as a path a Bot writes to is kept — the name, never
 * what is in it.
 */
export async function writeScriptFinished(
  auditStore: AuditStore,
  entry: {
    toolName: string;
    botId: string;
    actor: ActionActor;
    computerId: string;
    script: { sha256: string; bytes: number };
    /** By itself, or stopped at which bound: the time it was given, or the memory. */
    ending: RunEnding;
    /** The status it left with, where it ended by itself. */
    exitCode: number | null;
    /** The signal that ended it, where one did. A name (`SIGKILL`), held to that shape upstream. */
    signal: string | null;
    ms: number;
    /** How much it printed, in bytes. Never what. */
    stdoutBytes: number;
    stderrBytes: number;
    /** Each file it handed back: the name it gave it, and its size. */
    products: readonly { name: string; bytes: number }[];
    /** Present when it left files and none came back, and says which bound they were over. */
    productsRefused?: ProductsRefusal | undefined;
    /** How many things it left that were not files to hand back. */
    skipped: number;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType: "computer.script_finished",
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      bot: entry.botId,
      actor: entry.actor.id,
      script: { sha256: entry.script.sha256, bytes: entry.script.bytes },
      ending: entry.ending,
      exit: entry.exitCode,
      signal: entry.signal,
      ms: entry.ms,
      stdoutBytes: entry.stdoutBytes,
      stderrBytes: entry.stderrBytes,
      products: entry.products.map((product) => ({
        name: product.name,
        bytes: product.bytes,
      })),
      ...(entry.productsRefused
        ? { productsRefused: entry.productsRefused }
        : {}),
      skipped: entry.skipped,
    },
  });
}

/**
 * One row for the files of a run that were never tried, and why.
 *
 * Its own writer for the reason the ending has one: nothing is decided here. A file that is
 * tried has a decision and a row; these have neither, because the filing ended before them — by
 * the caller's Stop (`laf:stopped`), or at a question about a file before them
 * (`laf:awaiting_approval`) — or never began: where the folder they are filed in belongs there
 * is a file (`laf:made_not_a_folder`), which is about none of them and so is said once, of all
 * of them. Field by field, as the ending's row is: a name and a size.
 *
 * NOT A FIELD OF THE ENDING'S ROW, which is where that last one was said for an afternoon: to
 * say it there the ending had to wait for the computer to describe the folder, and a run that
 * has ended is on the trail before the call waits on anything (`acts.ts`, step 3).
 */
export async function writeScriptFilesLeft(
  auditStore: AuditStore,
  entry: {
    toolName: string;
    botId: string;
    actor: ActionActor;
    computerId: string;
    script: { sha256: string; bytes: number };
    /** Why none of these was tried: what ended the filing, or kept it from beginning. */
    because: string;
    left: readonly { name: string; bytes: number }[];
  },
) {
  await recordAuditEvent(auditStore, {
    eventType: "computer.script_files_left",
    targetType: "computer",
    targetId: entry.computerId,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      bot: entry.botId,
      actor: entry.actor.id,
      script: { sha256: entry.script.sha256, bytes: entry.script.bytes },
      because: entry.because,
      left: entry.left.map((file) => ({ name: file.name, bytes: file.bytes })),
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
    /** The script a question about a run is bound to, by its digest. See {@link ScriptOnTrail}. */
    script?: ScriptOnTrail | undefined;
    /** The digest of the script a file's question arose for. See `govern`'s `forScript`. */
    forScript?: string | undefined;
    /**
     * What the Bot's own instruction made of this, when there was one.
     *
     * On the row that says a person was asked, because that is the row somebody reads when they
     * want to know why they are being asked despite having written an instruction. Without it the
     * two reasons look identical from here — the instruction did not cover this, and the model
     * could not be reached — and the difference is the whole of whether the feature is working.
     */
    autoReview?: { allowed: boolean; reason: string } | null;
    /** Why a high-risk check asked, or what it read where it was consulted. */
    highRisk?: HighRiskVerdict | undefined;
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
      // Without its query, like every other row here (R3-03): the address a question is asked about
      // is as often as not the one a form sent by GET, or an OAuth return, just landed on.
      ...(entry.pageUrl ? { page: pageForTrail(entry.pageUrl) } : {}),
      ...(entry.filePath ? { file: entry.filePath } : {}),
      ...scriptForTrail(entry.script, entry.forScript),
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
      // Who decided this needed eyes and on what: the rules or a named judge, and the signals it saw.
      ...(entry.highRisk ? { highRisk: highRiskForTrail(entry.highRisk) } : {}),
    },
  });
}

/**
 * The high-risk reading as the trail keeps it: whether it asked, why, and who decided — the signal
 * names and the judge's probabilities. Nothing typed is in it, by construction: the verdict never
 * held a value.
 */
export function highRiskForTrail(verdict: HighRiskVerdict) {
  return {
    escalated: verdict.escalate,
    kinds: verdict.kinds,
    signals: verdict.signals,
    ...(verdict.judge ? { judge: verdict.judge } : {}),
    ...(verdict.failed ? { failed: verdict.failed } : {}),
  };
}
