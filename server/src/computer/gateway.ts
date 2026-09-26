/**
 * The only way an action reaches a Bot's computer.
 *
 * Reading a page is one thing; clicking a button on an external website is
 * another, and the difference is the whole product. The record is not a report written alongside the
 * work, it is the thing the action goes through, so it cannot be missing: an action that was not
 * recorded did not happen, because there is no path that acts without writing the row first.
 *
 * Three jobs, in this order:
 *
 *  1. Resolve the ref the caller sent into the element it actually points at, from the snapshot this
 *     server fetched. Never from what the caller said it was clicking.
 *  2. Ask the policy. Deny beats allow, an absent policy denies, and a broken rule denies.
 *  3. Write the row, whichever way the decision went, and only then act.
 *
 * Step 1 is the one that is easy to skip and fatal to skip. A gateway that decides on a label supplied
 * by the model is theatre: "never click Submit" is evaded by sending `{ref: "e13", name: "Continue"}`.
 * The refs are opaque to the caller precisely so that the server holds the mapping.
 *
 * WHERE THINGS LIVE, AND WHY THE LINES ARE WHERE THEY ARE.
 *
 * This file was 1,991 lines and one closure of 1,136. Audit A3 §7 (2026-09-10) found the snapshot
 * cache, `govern`, the secret bookkeeping, a dozen acting methods, four audit writers and the address
 * helpers sharing one scope — and found its secret leak and its approval bypass in that file, the one
 * that did not fit on a screen. The split is along the seams the audit named, each one a place where
 * the question a reviewer is asking changes:
 *
 *  - The decision stays one function (`gateway/govern.ts`). Its order is what makes the trail true —
 *    counted before the policy, the row before the action, a failure row after — and an order spread
 *    over modules is one nobody can see. The audit's own words: the rest leaves, `govern` stays whole.
 *  - What the server believes is on the screen is state a restart empties; the blind-action refusal
 *    is a question about that state, not part of it. So the cache is apart from the decision.
 *  - Everything that knows which box holds a secret is in one place, because that is the path S1
 *    leaked along and W1-b closed: a request resolved against the snapshot, a field followed by
 *    identity, every later snapshot masked on the way in.
 *  - The audit writers are the trail's schema — what a row may carry and what it must never carry —
 *    and a change to them should be reviewable as that, not buried in a diff to some action.
 *  - A navigation is the one call that loops (every redirect hop judged, the landing judged again,
 *    W1-d) and reports a site's sign-in (W1-c); it reads as one sequence on its own.
 *  - The acting calls decide nothing and are kept thin by being kept apart; handovers are a person's
 *    reach into the browser, recorded and never judged, and sit apart from what a Bot does.
 *  - Addresses and a call's intent are pure spellings a boundary is evaded through (a trailing dot
 *    walked past a money rule), testable without a computer.
 *
 * Every name another directory imports from here is still exported from here.
 */

import type { AuditStore } from "../audit";
import { type ApprovalRegistry, createApprovalRegistry } from "./approvals";
import type { ReviewSubject, ReviewVerdict } from "./auto-review";
import type { ComputerClient } from "./client";
import { createActs } from "./gateway/acts";
import { createGovern } from "./gateway/govern";
import { createHandovers } from "./gateway/handovers";
import { createNavigation, type SiteSeen } from "./gateway/navigation";
import { createSecrets } from "./gateway/secrets";
import { createPageReads, createSnapshotCache } from "./gateway/snapshots";
import { createTypedLedger, type HighRiskCheck } from "./high-risk";
import type { ActionPolicy } from "./policy";
import { createRepeatDetector, type RepeatDetector } from "./repeat";
import {
  createStandingApprovalStore,
  type StandingApprovalStore,
} from "./standing-approvals";

export {
  type ActionActor,
  ActionNeedsApprovalError,
  ActionRefusedError,
  THREAD_HEADER,
  TOOL_CALL_HEADER,
} from "./gateway/caller";
export { isTextKey } from "./gateway/intent";

export type ComputerGatewayOptions = {
  client: ComputerClient;
  auditStore: AuditStore;
  /** Absent denies everything. See evaluateActionPolicy. */
  policy: () => ActionPolicy | undefined;
  /**
   * Where questions raised by the `ask` list wait for an answer.
   *
   * Handed in rather than owned, because the deployment has exactly one of these and the gateway is
   * not the only thing that asks: the same policy judges a Bot's calls to somebody else's servers,
   * and a person answering should see everything their Bot is waiting on rather than whichever half
   * belongs to the subsystem that happened to serve the page. A gateway built without one keeps its
   * own, which is what the tests do so they can control the clock.
   */
  approvals?: ApprovalRegistry;
  /**
   * Counts a Bot repeating itself, so that the policy can be told how many times.
   *
   * Absent, the gateway makes its own, which is what almost every deployment gets. Passed in only to
   * widen the window for a slow provider, or to hand a test a clock it can move, because otherwise
   * proving that a window expires means a test that waits three minutes, and a test that waits three
   * minutes is a test somebody eventually deletes.
   */
  repeat?: RepeatDetector;
  /**
   * The person's own sentence about what they do not want to be asked, applied per action.
   *
   * Absent means every stopped action is put in front of somebody, which is what this file did
   * before it existed. Given as one function rather than as a store plus a model client, so the
   * gateway knows nothing about where an instruction is kept or how it is judged — it asks one
   * question and reads one answer. See `auto-review.ts`.
   */
  autoReview?: (
    botId: string,
    subject: ReviewSubject,
  ) => Promise<ReviewVerdict | null>;
  /**
   * The questions a person has already decided not to be asked again.
   *
   * Consulted before a question is opened, so an allowance somebody granted last week means the Bot
   * simply gets on with it. Absent, the gateway makes its own in-memory one, which is what the tests
   * get: a store that nothing has granted anything in behaves exactly as this file did before it
   * existed, so a test that says nothing about allowances is testing what it always was.
   */
  standing?: StandingApprovalStore;
  /**
   * Told whenever a navigation lands on a site in the 사이트 연결 catalogue.
   *
   * THIS IS THE HALF THAT KEEPS THE CARD HONEST. A person connects 배민 once, in March; whether
   * that session is still good in September is only knowable by looking at the page, and the thing
   * that looks at the page every morning is the routine, not the settings screen. So the ordinary
   * navigation path reports what it saw — signed in, or back at the login wall — and the card is
   * drawn from that rather than from the day somebody last pressed a button.
   *
   * Synchronous and returning nothing, deliberately: this is bookkeeping on the success path of
   * somebody's actual work, and it must not be able to fail it or slow it down. The gateway knows
   * nothing about the table underneath. Absent — every test that does not care, and every
   * deployment without a database — changes nothing else about a navigation.
   */
  siteSeen?: SiteSeen;
  /**
   * The high-risk check (`high-risk.ts`) and where it reads the owner's task from. Absent, nothing
   * is escalated — the gateway behaves as it did before the check existed.
   */
  highRisk?: {
    check: HighRiskCheck;
    taskText: (threadId: string | undefined) => Promise<string>;
  };
};

export function createComputerGateway(options: ComputerGatewayOptions) {
  const { client, auditStore } = options;

  /**
   * The computer, addressed as the Bot that is asking.
   *
   * Every call goes through this. The Bot's browser, its logins and the proxy its traffic leaves
   * through are all keyed on this id at the far end, so a call that forgets it lands on the wrong
   * computer, because there is always a computer to answer.
   */
  const as = (botId: string) => client.forBot(botId);

  const snapshots = createSnapshotCache();
  const secrets = createSecrets({ as, auditStore, snapshots });
  const govern = createGovern({
    auditStore,
    policy: options.policy,
    approvals: options.approvals ?? createApprovalRegistry(),
    repeat: options.repeat ?? createRepeatDetector(),
    standing: options.standing ?? createStandingApprovalStore(),
    ...(options.autoReview ? { autoReview: options.autoReview } : {}),
    snapshots,
    ...(options.highRisk
      ? {
          highRisk: {
            check: options.highRisk.check,
            taskText: options.highRisk.taskText,
            typed: createTypedLedger(),
            secretHere: secrets.suppliedOn,
          },
        }
      : {}),
  });

  return {
    ...createPageReads({
      as,
      auditStore,
      snapshots,
      withoutSecrets: secrets.withoutSecrets,
    }),
    ...createHandovers({ client, as, auditStore, secrets }),
    requestSecret: secrets.requestSecret,
    supplySecret: secrets.supplySecret,
    ...createNavigation({ as, govern, siteSeen: options.siteSeen }),
    ...createActs({ as, govern }),
  };
}

export type ComputerGateway = ReturnType<typeof createComputerGateway>;
