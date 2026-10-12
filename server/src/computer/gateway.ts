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
 *    reach into the browser, recorded and never judged, and sit apart from what a Bot does. So does
 *    a person's reach into the Bot's folder (`person-files.ts`): the same decision about the same
 *    person, and the one other place a file leaves the folder.
 *  - Addresses and a call's intent are pure spellings a boundary is evaded through (a trailing dot
 *    walked past a money rule), testable without a computer.
 *
 * Every name another directory imports from here is still exported from here.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type FileScope,
  MAIN_SCOPE,
  projectScope,
} from "../../../shared/file-scope";
import type { LoginVault } from "../logins/store";
import type { AuditStore } from "../audit";
import { type ApprovalRegistry, createApprovalRegistry } from "./approvals";
import type { ReviewSubject, ReviewVerdict } from "./auto-review";
import { browserOf, computerOf } from "./bot-id";
import type { ComputerClient } from "./client";
import { createActs } from "./gateway/acts";
import { createGovern } from "./gateway/govern";
import { createHandovers } from "./gateway/handovers";
import { createNavigation, type SiteSeen } from "./gateway/navigation";
import { createPersonFiles } from "./gateway/person-files";
import { createSecrets } from "./gateway/secrets";
import { createPageReads, createSnapshotCache } from "./gateway/snapshots";
import { createTypedLedger, type HighRiskCheck } from "./high-risk";
import type { ActionPolicy } from "./policy";
import { createRepeatDetector, type RepeatDetector } from "./repeat";
import type { Workbench } from "../workbench/client";
import {
  createStandingApprovalStore,
  type StandingApprovalStore,
} from "./standing-approvals";

import type { ActionActor } from "./gateway/caller";

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
   * What the deployment's people saved for their Bot's browser (`logins/store.ts`). With it, a
   * request for a sign-in's values is answered from the vault where the person saved a login for
   * that origin (`gateway/secrets.ts`); without it, every value is asked of a person.
   */
  logins?: Pick<LoginVault, "forOrigin" | "open" | "used"> &
    Partial<Pick<LoginVault, "save" | "acceptsOrigin">>;
  /**
   * The project a conversation is, by its thread: the channel's id where its kind is `project`,
   * null for the main conversation's thread or one that is no conversation's
   * (`channels/thread-projects.ts`, which keeps the answer). What decides whose folder a run's
   * files go in. Absent — a test of something else — every run is the main folder's.
   */
  projectOf?: (threadId: string) => Promise<string | null>;
  /**
   * The high-risk check (`high-risk.ts`) and where it reads the owner's task from. Absent, nothing
   * is escalated — the gateway behaves as it did before the check existed.
   */
  highRisk?: {
    check: HighRiskCheck;
    taskText: (threadId: string | undefined) => Promise<string>;
  };
  /**
   * Where a script a Bot wrote is run (`workbench/client.ts`): another container, with no network
   * and nothing of the Bot's folder in it but the bytes a run is handed.
   *
   * ABSENT EVERYWHERE TODAY. Nothing reads a socket or a key for it from the environment, and
   * `main.ts` hands none in: the act it serves (`gateway/acts.ts`, `runScript`) is offered to no
   * Bot yet, and with none here that act refuses at once, before it reads a file. A test hands in
   * a stand-in; the rehearsal hands in the real client beside the real service.
   */
  workbench?: Workbench;
  /** The clock a script run's folder is dated by. Absent, the wall clock. */
  now?: () => Date;
  /** The most `made/` may hold (`gateway/script-run.ts`, `MADE_MAX_BYTES`). A test makes it small. */
  madeMaxBytes?: number;
};

export function createComputerGateway(options: ComputerGatewayOptions) {
  const { client, auditStore } = options;

  /**
   * The computer, addressed as the Bot that is asking — in the browser the computer's id names.
   *
   * Every call goes through this. The Bot's browser, its logins and the proxy its traffic leaves
   * through are all keyed on this id at the far end, so a call that forgets it lands on the wrong
   * computer, because there is always a computer to answer.
   *
   * A COMPUTER'S ID IS THE BOT'S, OR THE BOT'S AND A BROWSER'S NAME (`bot-id.ts`, piece 5-3). The
   * main browser's is the Bot's id alone, which is what every caller passed before there were
   * others, so a call that names only a Bot is the main browser's as it always was.
   */
  /*
   * AND AS WHOSE FILES (`shared/file-scope.ts`): the scope of the act that is going on, which
   * `govern` reads from its actor and holds for as long as the act runs — so a call made by any
   * module below says it without being handed it. Outside an act there is none, and a caller
   * that touches files says its own (`person-files.ts`: the person's own door).
   */
  const acting = new AsyncLocalStorage<FileScope>();
  const as = (computerId: string, botId?: string, scope?: FileScope) => {
    const whose = scope ?? acting.getStore();
    // Where the caller says which Bot it is acting as, that is who is addressed, and a browser
    // the id names has to be that Bot's (`browserOf`). Where it hands over the id alone — a look
    // at the page — the id says both.
    if (botId !== undefined) {
      return client.forBot(botId, browserOf(computerId, botId), whose);
    }
    const named = computerOf(computerId);
    return client.forBot(named.botId, named.browser, whose);
  };
  /** No thread — a routine, a check with no conversation — is the main folder's. */
  const fileScopeOf = async (actor: ActionActor): Promise<FileScope> => {
    if (!actor.threadId || !options.projectOf) return MAIN_SCOPE;
    const projectId = await options.projectOf(actor.threadId);
    return projectId ? projectScope(projectId) : MAIN_SCOPE;
  };

  const snapshots = createSnapshotCache();
  const secrets = createSecrets({
    as,
    auditStore,
    snapshots,
    // Made just below, from what this hands it; called only once a request arrives.
    govern: (...call) => govern(...call),
    ...(options.logins ? { logins: options.logins } : {}),
  });
  const govern = createGovern({
    auditStore,
    policy: options.policy,
    approvals: options.approvals ?? createApprovalRegistry(),
    repeat: options.repeat ?? createRepeatDetector(),
    standing: options.standing ?? createStandingApprovalStore(),
    ...(options.autoReview ? { autoReview: options.autoReview } : {}),
    snapshots,
    fileScopes: {
      of: fileScopeOf,
      during: (scope, work) => acting.run(scope, work),
    },
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
    ...createHandovers({ client, as, auditStore, secrets, snapshots }),
    ...createPersonFiles({ as, scopeOf: fileScopeOf, auditStore }),
    requestSecret: secrets.requestSecret,
    supplySecret: secrets.supplySecret,
    /** Whether a person's value is being held in this Bot's browser. See `gateway/secrets.ts`. */
    holdsValues: secrets.holdsValues,
    /** A browser call's outcome was handed to a model, with or without a saved password hidden in it. */
    handedOver: secrets.handedOver,
    /** Whether a picture offered for this call is one not to keep. */
    frameWithheld: secrets.frameWithheld,
    /** A run of this Bot's is over: what was put in for it stops being held. */
    runEnded: secrets.runEnded,
    ...createNavigation({ as, govern, siteSeen: options.siteSeen }),
    ...createActs({
      as,
      govern,
      auditStore,
      ...(options.workbench ? { workbench: options.workbench } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.madeMaxBytes === undefined
        ? {}
        : { madeMaxBytes: options.madeMaxBytes }),
    }),
  };
}

export type ComputerGateway = ReturnType<typeof createComputerGateway>;
