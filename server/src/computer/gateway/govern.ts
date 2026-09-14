/**
 * Decide, record, then act: the one function every acting call goes through.
 *
 * It stays whole. The order is what makes the trail true — counted before the policy is asked, the
 * decision row written before the action runs, a failure row after one that did not happen — and an
 * order spread across modules is an order nobody can see. What it reads (the snapshot cache), what
 * it writes (the trail's rows) and how a call is described (its intent and subject) live beside it,
 * so that this file is the sequence and nothing else.
 */
import { ACTION_FAILED, type AuditStore } from "../../audit";
import { describeFailure } from "../../failure-text";
import { log } from "../../log";
import { type ApprovalRegistry, fingerprintOf } from "../approvals";
import type { ReviewSubject, ReviewVerdict } from "../auto-review";
import { ComputerUnavailableError } from "../client";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
  policyDecidesOnSnapshot,
} from "../policy";
import type { RepeatDetector } from "../repeat";
import { settle } from "../settle";
import {
  allowanceFor,
  type StandingApprovalStore,
} from "../standing-approvals";
import { describeFile, hostOf } from "./addresses";
import {
  type ActionActor,
  ActionNeedsApprovalError,
  ActionRefusedError,
} from "./caller";
import { askSubjectOf, intentOf, isTextKey } from "./intent";
import type { SnapshotCache } from "./snapshots";
import { write, writeApprovalEvent, writeRepeat } from "./trail";

/** A control as the policy judged it: its role and accessible name from this server's snapshot. */
export type JudgedElement = { role: string; name: string };

export function createGovern(options: {
  auditStore: AuditStore;
  /** Absent denies everything. See evaluateActionPolicy. */
  policy: () => ActionPolicy | undefined;
  approvals: ApprovalRegistry;
  repeat: RepeatDetector;
  standing: StandingApprovalStore;
  autoReview?: (
    botId: string,
    subject: ReviewSubject,
  ) => Promise<ReviewVerdict | null>;
  snapshots: SnapshotCache;
}) {
  const { auditStore, approvals, repeat, standing, snapshots } = options;
  const { pageMoved, resolve } = snapshots;

  /**
   * Decide, record, then act.
   *
   * The audit row is written before the action runs, not after it succeeds. An allowed action that
   * later fails is still part of the audit sequence, and a trail that only contains successes cannot
   * show that sequence.
   */
  async function govern<T>(
    computerId: string,
    toolName: string,
    botId: string,
    actor: ActionActor,
    subject: {
      ref?: string;
      filePath?: string;
      targetUrl?: string;
      key?: string;
      /** Whether this call ends by pressing Enter. Only the type tool can, and it says so. */
      submit?: boolean;
      /** The person's Stop, on its way to the browser. See the acting methods in `acts.ts`. */
      signal?: AbortSignal;
      /**
       * An answer a person already gave, being presented for the action it was given for.
       *
       * Carried on the request rather than held against the conversation, because the thing being
       * checked is not "has somebody approved something recently" but "was this exact action the one
       * they were shown". The id alone proves nothing; it is the id plus the fingerprint of the call
       * being made that means anything.
       */
      approvalId?: string;
    },
    /**
     * The action itself, handed the role and name the policy judged the ref as — from this server's
     * snapshot, never from the request — so the computer can refuse if the control is called
     * something else by the time it acts. Undefined where no ref resolved.
     */
    run: (judged: JudgedElement | undefined) => Promise<T>,
  ): Promise<T> {
    /*
     * A CALLER THAT HAS ALREADY STOPPED IS NOT GOVERNED AT ALL.
     *
     * A routine whose deadline passed, or a person who pressed Stop, has nobody left to act for:
     * counting the attempt would feed the repeat rule a call that never happened, and opening a
     * question would ask a person about an action for a run that is already over and reported.
     */
    if (subject.signal?.aborted) throw stopped();

    const { ref, filePath } = subject;
    const element = resolve(computerId, ref);
    const cached = snapshots.get(computerId);
    // For a navigation the relevant page is the one being opened, not the one already loaded. Using
    // the cached URL would mean `page.host == "..."` could never match the destination, which is the
    // only thing a rule about navigation would ever want to say.
    const pageUrl = subject.targetUrl ?? cached?.url ?? "";

    const intent = intentOf(toolName, subject.key);

    /*
     * Counted before the policy is asked, so that a rule written against the count decides the very
     * attempt that crossed the line rather than the one after it. Off by one here would mean a
     * deployment forbidding a tenth identical click allows the tenth and refuses the eleventh, which
     * is the kind of thing nobody notices until they are counting rows in an incident.
     *
     * Reading a page never reaches this function, so nothing counts a Bot looking at the same screen
     * over and over. That is the cheapest thing it does and the one nobody minds.
     */
    const repetition = await repeat.observe(botId, {
      tool: toolName,
      ref,
      key: subject.key,
      filePath,
      targetUrl: subject.targetUrl,
    });

    /*
     * EVERY FIELD, ON EVERY ACTION, EMPTY WHERE THERE IS NOTHING TO SAY.
     *
     * cel-js throws on a field that is not in the context, `matches` returns a broken deny as a
     * refusal and a broken ask as a question — so an absent field does not make a rule inert, it
     * makes it fire on everything. Left optional, `element` was absent on every keypress the server
     * could not attach to a control and on every file call, which turned one rule about button
     * labels into a deployment that stopped Enter and refused the workspace. The plugin store has
     * filled every field with empty strings since it was written (`plugins/store.ts`) for exactly
     * this reason; this is the same context, built the same way, so a rule means one thing on both
     * paths.
     *
     * Blank is not a lie here. A file call has no element and no key, and a rule about element names
     * should be false against it rather than unevaluable. What blank must never mean is "the server
     * could not see the page" — that is decided separately, below, and refuses.
     */
    const context: PolicyContext = {
      tool: { name: toolName },
      bot: { id: botId },
      actor: { id: actor.id },
      page: { url: pageUrl, host: hostOf(pageUrl) },
      repeat: { count: repetition.count },
      // Always a boolean, unlike `key` once was, so a rule about form submission needs no guard to
      // stay evaluable on the actions that cannot submit anything. See PolicyContext.submit.
      submit: subject.submit === true,
      ...(intent ? { intent } : {}),
      key: subject.key ?? "",
      element: {
        // The RESOLVED ref, blank when nothing resolved — never the one the caller sent. Nothing
        // in this object may come from the request, or "do not click Submit" is evaded by calling
        // it something else, and the blank is the honest answer: this server issued no such handle.
        ref: element?.ref ?? "",
        role: element?.role ?? "",
        name: element?.name ?? "",
        type: element?.type ?? "",
      },
      file: filePath
        ? describeFile(filePath)
        : { path: "", name: "", extension: "" },
    };

    if (repetition.threshold !== null && repetition.fingerprint) {
      /*
       * Ahead of the decision row, so the trail reads in the order the thing happened: this was the
       * tenth identical attempt, and this is what the policy did about it. Filed the other way round
       * a reader has to deduce the cause from a row written after its effect.
       *
       * Its failure is swallowed, which nothing else in this file does. This row is an observation,
       * and an observation is not allowed to refuse anything: letting a lost insert throw from here
       * would stop every third, tenth and twenty-fifth identical call before the policy had even
       * been asked, so a deployment that permits an action would lose it to a moment's trouble at the
       * audit store. Nothing is weakened by that. An action that was not recorded still does not
       * happen, because the decision row goes to the same store a few lines below, and a store that
       * is genuinely down refuses the action there.
       */
      try {
        await writeRepeat(auditStore, {
          toolName,
          botId,
          actor,
          computerId,
          pageUrl,
          filePath,
          fingerprint: repetition.fingerprint,
          count: repetition.count,
        });
      } catch (error) {
        log.error("computer_repeat_row_lost", {
          bot: botId,
          fingerprint: repetition.fingerprint,
          count: repetition.count,
          reason: error,
        });
      }
    }

    /*
     * A snapshot this process never took is an unknown page, not an empty one.
     *
     * `cached` is read from the map above, which a restart empties and a Bot that has not looked at
     * anything yet has never filled. Then `page` and `element` are blank and every rule written
     * against them silently stops matching. Refusing is the only answer consistent with the
     * rest of this boundary, where an absent policy denies and a broken deny expression still denies:
     * a rule that cannot be evaluated must not be read as a rule that did not fire.
     *
     * A navigation carries its destination on the request, so it is decidable without a snapshot and
     * passes this guard. So does a deployment whose refusing rules never mention either field, which
     * is why the policy is consulted rather than the snapshot alone — a boundary that says nothing
     * about pages loses nothing by not having one.
     *
     * AND SO DOES THE WORKSPACE. A file call has nothing to do with whatever the browser is showing:
     * its element and page are structurally empty, not unknown, and no snapshot would fill them in.
     * Refusing those was harmless while the shipped policy mentioned neither field — it now mentions
     * both, and without this line every deployment would refuse `computer_read_file` until somebody
     * had looked at a web page first, with a message about a screen the Bot was never using.
     */
    const policy = options.policy();
    const aboutThePage =
      intent !== "read_file" &&
      intent !== "write_file" &&
      intent !== "list_files";
    const blind =
      (!cached || cached.stale) &&
      subject.targetUrl === undefined &&
      aboutThePage;
    // A floor under the policy, like the blind check: no rule an operator writes can make a
    // character pressed as a key into something other than typing. See `isTextKey`.
    const textKey = toolName === "computer_key" && isTextKey(subject.key ?? "");
    const decision = textKey
      ? ({
          allowed: false,
          matched: null,
          source: "deny",
          forward: false,
          code: "laf:key_is_text",
        } satisfies PolicyDecision)
      : blind && policyDecidesOnSnapshot(policy)
        ? ({
            allowed: false,
            matched: null,
            source: "deny",
            forward: false,
            code: "laf:blind_action",
          } satisfies PolicyDecision)
        : evaluateActionPolicy(policy, context);

    /**
     * A DECISION THAT WANTS A PERSON, SETTLED IN THE ONE PLACE THAT SETTLES THEM.
     *
     * The sequence this used to run inline — spend a presented approval, honour a No that still
     * stands, look for an allowance, ask the Bot's own instruction, open the question — is in
     * `settle.ts`, because the plugin store ran a second copy of it without the instruction and with
     * the repeat count nailed to one. Everything about the decision is there; everything about
     * recording it is here, where the target and the shape of a computer's audit row are known.
     */
    const fingerprint = fingerprintOf({
      botId,
      toolName,
      ref,
      key: subject.key,
      submit: subject.submit,
      filePath,
      pageUrl,
      element: element ? { role: element.role, name: element.name } : undefined,
    });
    /*
     * What a standing allowance for this action would have to cover.
     *
     * Derived from the same fields the policy was given, by the same function the next action will
     * use, so the scope printed on the button and the scope checked afterwards cannot differ.
     */
    const allowance = allowanceFor({
      tool: toolName,
      host: hostOf(pageUrl),
      filePath,
    });
    const settled = await settle(
      {
        botId,
        actorId: actor.id,
        subject: askSubjectOf({
          intent,
          pageUrl,
          filePath,
          element,
          matched: decision.matched,
          repeatCount: repetition.count,
        }),
        action: toolName,
        fingerprint,
        allowance,
        rule: decision.matched ?? "",
        target: { type: "computer", id: computerId },
        ...(subject.approvalId
          ? { presentedApprovalId: subject.approvalId }
          : {}),
        ...(actor.threadId ? { threadId: actor.threadId } : {}),
        ...(actor.delegated ? { delegated: actor.delegated } : {}),
        policyVerdict: decision,
      },
      {
        policy: options.policy,
        approvals,
        standing,
        ...(options.autoReview ? { autoReview: options.autoReview } : {}),
      },
    );

    if (settled.outcome === "asked") {
      // Nothing is written as allowed or refused, because neither happened: `approval.requested` is
      // the record of where the turn actually got to.
      await writeApprovalEvent(auditStore, {
        botId,
        actor,
        computerId,
        approval: settled.approval,
        toolName,
        pageUrl,
        filePath,
        ...(settled.autoReview ? { autoReview: settled.autoReview } : {}),
      });
      throw new ActionNeedsApprovalError(settled.approval);
    }

    if (settled.outcome === "refused") {
      /*
       * A refusal `settle` reached rather than the policy — a No that still stands — is recorded as
       * a deny with its own code. The policy's own refusals keep the verdict they arrived with.
       */
      const refusal: PolicyDecision =
        settled.code === decision.code
          ? decision
          : {
              ...decision,
              allowed: false,
              forward: false,
              source: "deny",
              code: settled.code,
            };
      await write(auditStore, {
        toolName,
        botId,
        actor,
        computerId,
        element,
        ref,
        ...(subject.key ? { key: subject.key } : {}),
        filePath,
        pageUrl,
        decision: refusal,
      });
      throw new ActionRefusedError(refusal.matched, settled.code);
    }

    /*
     * What the boundary settled on, once a person's answer is folded in.
     *
     * The source stays `ask`, so the row reads as "allowed, because somebody was asked and said yes"
     * rather than as an ordinary permission nobody ever questioned. WHICH of the three yeses it was
     * is in the fields below and never folded into a sentence: "allowed by Sam", "allowed by an
     * allowance Sam granted last Tuesday" and "allowed by an instruction nobody read today" are
     * different amounts of attention, and the last two are the rows an investigator is looking for.
     */
    const approvedBy = settled.approvedBy;
    const allowedByStanding = settled.allowance;
    const allowedByReview = settled.autoReviewed;
    const carried: PolicyDecision = decision.forward
      ? decision
      : { ...decision, allowed: true, forward: true };

    await write(auditStore, {
      toolName,
      botId,
      actor,
      computerId,
      element,
      ref,
      ...(subject.key ? { key: subject.key } : {}),
      filePath,
      pageUrl,
      decision: carried,
      ...(approvedBy ? { approvedBy } : {}),
      ...(allowedByStanding
        ? {
            standingAllowance: {
              id: allowedByStanding.id,
              scope: allowedByStanding.scope,
              tier: allowedByStanding.tier,
            },
          }
        : {}),
      ...(allowedByReview ? { autoReviewed: allowedByReview.reason } : {}),
    });

    let result: T;
    try {
      /*
       * AND NOT CARRIED OUT, if the caller stopped while this was being decided. Settling can wait
       * on a model — the auto-review judge takes seconds — and a routine's deadline that passed in
       * those seconds has already been recorded as a failure and told to a person. The click must
       * not arrive after that. Checked here as well as in the client, because this is the one
       * entry every acting call comes through and a client is only one of the things it runs.
       */
      if (subject.signal?.aborted) throw stopped();
      result = await run(
        element ? { role: element.role, name: element.name } : undefined,
      );
    } catch (error) {
      /**
       * A permitted action that did not happen gets its own row.
       *
       * Without this the trail lies by omission. The row above says the policy allowed the call, and
       * a reader takes "allowed" to mean "it happened".
       *
       * Writing the decision before acting is still right, because an allowed action may have partial
       * effects before failing. The failure row records the outcome separately from the policy
       * decision.
       */
      await write(auditStore, {
        toolName,
        botId,
        actor,
        computerId,
        element,
        ref,
        filePath,
        pageUrl,
        decision: carried,
        ...(approvedBy ? { approvedBy } : {}),
        ...(allowedByStanding
          ? {
              standingAllowance: {
                id: allowedByStanding.id,
                scope: allowedByStanding.scope,
                tier: allowedByStanding.tier,
              },
            }
          : {}),
        ...(allowedByReview ? { autoReviewed: allowedByReview.reason } : {}),
        /*
         * Never `error.message`: a failed audit insert would put its SQL, parameters included, into
         * the trail it failed to write to (failure-text.ts). An exception from somebody else's
         * software keeps one line of its own; a throw that was not an Error keeps our code.
         */
        failure:
          error instanceof Error ? describeFailure(error) : ACTION_FAILED,
      });
      throw error;
    }
    // Where the browser is now, from the action's own report. A click that followed a link, a
    // navigation, a tab switch: each moves the page under the cache, and the cache follows.
    const movedTo =
      result && typeof result === "object" && "url" in result
        ? (result as { url?: unknown }).url
        : undefined;
    if (typeof movedTo === "string" && movedTo) pageMoved(computerId, movedTo);
    // The element's label, attached on the way out, so the transcript can say what was acted on
    // instead of quoting a ref. The computer cannot supply this: it knows the ref, and the resolved
    // snapshot lives here. File calls carry their own path already, so there is nothing to add.
    return element && result && typeof result === "object"
      ? { ...result, element: { role: element.role, name: element.name } }
      : result;
  }

  return govern;
}

export type Govern = ReturnType<typeof createGovern>;

/** What a stopped caller is told: the same error the client throws for one. */
function stopped(): ComputerUnavailableError {
  return new ComputerUnavailableError("The action was stopped.");
}
