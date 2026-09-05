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
 */

import { siteForUrl } from "../../../shared/sites/catalogue";
import {
  ACTION_FAILED,
  type AuditStore,
  ELEMENT_NOT_IN_SNAPSHOT,
  recordAuditEvent,
} from "../audit";
import {
  type ApprovalRegistry,
  type AskSubject,
  createApprovalRegistry,
  fingerprintOf,
  type PendingApproval,
} from "./approvals";
import type { ReviewSubject, ReviewVerdict } from "./auto-review";
import { describeFailure } from "../failure-text";
import { normalizeHostname } from "../net/host-verdict";
import { type ComputerClient, StaleSnapshotError } from "./client";
import { isSecretFieldElement } from "./default-policy";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type FactCode,
  type PolicyContext,
  type PolicyDecision,
  policyDecidesOnSnapshot,
} from "./policy";
import { createRepeatDetector, type RepeatDetector } from "./repeat";
import type {
  ClickInput,
  KeyInput,
  ListFilesInput,
  ReadFileInput,
  ReadResult,
  ScrollInput,
  SecretRequest,
  SnapshotElement,
  SnapshotResult,
  SwitchTabInput,
  TypeInput,
  UploadFileInput,
  WriteFileInput,
} from "./schema";
import { settle } from "./settle";
import {
  type AllowanceScope,
  type AllowanceTier,
  allowanceFor,
  createStandingApprovalStore,
  type StandingApprovalStore,
} from "./standing-approvals";

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
  siteSeen?: (seen: {
    userId: string;
    siteId: string;
    botId: string;
    signedIn: boolean;
  }) => void;
};

/**
 * The last snapshot the server took, per computer.
 *
 * In memory. It describes the live contents of a browser window, so it is
 * meaningless the moment the process holding that window restarts. Persisting it would create a cache
 * that can disagree with the page, which is worse than not having one: the refs would resolve to names
 * that are no longer on screen and the policy would decide on fiction.
 */
type CachedSnapshot = {
  snapshotId: number;
  elements: Map<string, SnapshotElement>;
  url: string;
  /**
   * The browser has moved since this was taken, and only the address is still believed.
   *
   * THE CACHE WAS NEVER INVALIDATED. `snapshots.set` ran in exactly one place — `snapshot()` — and
   * nothing else touched it: not a navigation, not a click that followed a link, not a tab switch.
   * So `page.host`, the audit row's `page` and the scope printed on an "always allow" button all
   * described whatever page was last SNAPSHOTTED, however many pages ago that was. Measured as a
   * sequence: snapshot on example.com, navigate to a bank, press Enter with no ref — the money-host
   * rule looked at `example.com` and let it through.
   *
   * A stale entry keeps the address the browser reported and no elements, so a rule about the host
   * sees the right host and an action that needs the screen is refused as blind until the Bot
   * looks again — which is what the tool results already tell it to do.
   */
  stale: boolean;
};

/** The roles a value can be typed into. What `computer_request_secret` may name. */
const SECRET_ENTRY_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "input",
]);

/**
 * Whether a `computer_key` call is really typing.
 *
 * `hunter2`, sent as six keypresses with no ref, used to arrive as six actions on nothing in
 * particular: no element resolved, so the password-field `deny` matched an empty label and the
 * value went into the focused box one character at a time. A key name is a word — Enter, Tab,
 * ArrowDown, F5 — and a single printable character is a letter. Shift still types (`Shift+a` is
 * `A`); Control, Alt and Meta make a shortcut, which is the thing this tool is for.
 */
export function isTextKey(key: string): boolean {
  const parts = key.split("+");
  const last = parts.pop() ?? "";
  const modifiers = parts.map((part) => part.trim().toLowerCase());
  if (
    modifiers.some(
      (modifier) =>
        modifier === "control" ||
        modifier === "alt" ||
        modifier === "meta" ||
        modifier === "controlormeta",
    )
  ) {
    return false;
  }
  const points = Array.from(last);
  return points.length === 1 && last !== " " && !/\p{C}/u.test(last);
}

/**
 * The element, minus the value of a secret field.
 *
 * The computer already drops these; this is the same rule applied where the snapshot enters this
 * process, so an older `agent-computer` image cannot hand a password to the model through a server
 * that knows better.
 */
function withoutSecretValue(element: SnapshotElement): SnapshotElement {
  if (element.value === undefined || !isSecretFieldElement(element)) {
    return element;
  }
  return { ...element, value: "" };
}

export function createComputerGateway(options: ComputerGatewayOptions) {
  const { client, auditStore } = options;
  const snapshots = new Map<string, CachedSnapshot>();
  /**
   * Where each open secret request points, as this server resolved it when the request was made.
   *
   * Held here rather than read back off the computer, because the computer keeps the Bot's label
   * and the ref and nothing else — and the host and the control's own name are what a person needs
   * beside a label a model wrote. Cleared when the value is supplied.
   */
  const secretTargets = new Map<
    string,
    { host: string; element: { role: string; name: string } }
  >();
  const approvals = options.approvals ?? createApprovalRegistry();
  const repeat = options.repeat ?? createRepeatDetector();
  const standing = options.standing ?? createStandingApprovalStore();

  /**
   * The browser is somewhere else now: keep the address, forget the elements.
   *
   * Called with every URL an action or a navigation reports back, so the cache follows the browser
   * rather than the last snapshot. The same address as the cache holds is not a move.
   */
  function pageMoved(computerId: string, url: string): void {
    const cached = snapshots.get(computerId);
    if (cached && cached.url === url) return;
    snapshots.set(computerId, {
      snapshotId: cached?.snapshotId ?? 0,
      url,
      elements: new Map(),
      stale: true,
    });
  }

  /**
   * The computer, addressed as the Bot that is asking.
   *
   * Every call goes through this. The Bot's browser, its logins and the proxy its traffic leaves
   * through are all keyed on this id at the far end, so a call that forgets it lands on the wrong
   * computer, because there is always a computer to answer.
   */
  const as = (botId: string) => client.forBot(botId);

  /** Read-only, so it passes straight through. Nothing has changed and there is nothing to decide. */
  async function snapshot(computerId: string): Promise<SnapshotResult> {
    const result = await as(computerId).snapshot();
    const elements = result.elements.map(withoutSecretValue);
    snapshots.set(computerId, {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(elements.map((element) => [element.ref, element])),
      stale: false,
    });
    return { ...result, elements };
  }

  async function read(botId: string): Promise<ReadResult> {
    const result = await as(botId).read();
    pageMoved(botId, result.url);
    return result;
  }

  /**
   * Report a landing on a catalogue site, if it is one and if a real person is behind the call.
   *
   * `actor.userId` is omitted for the local development actor, and that omission is about
   * ATTRIBUTION — a fixture is not a person, so it does not become the actor of an audit row. It is
   * not about existence: `initializeDevActorUser` writes that fixture into `users` on boot, so it
   * owns rows like anybody else and the id is what a connection belongs to. Hence the fallback,
   * without which the whole feature is invisible in local development for a reason that only
   * applies to the trail.
   */
  function noteSiteVisit(
    botId: string,
    actor: ActionActor,
    url: string,
    text: string | undefined,
  ): void {
    const userId = actor.userId ?? actor.id;
    if (!userId || !options.siteSeen) return;
    const site = siteForUrl(url);
    if (!site) return;
    options.siteSeen({
      userId,
      siteId: site.id,
      botId,
      signedIn: site.signedIn(url, text ?? ""),
    });
  }

  /**
   * Resolve a ref against the snapshot the server holds.
   *
   * Returns undefined for an unknown ref rather than throwing, because the policy still has to run:
   * an action on an element we cannot identify must still receive a policy decision.
   * A deny rule written against a page a Bot has not snapshotted should still refuse it.
   */
  function resolve(
    computerId: string,
    ref: string | undefined,
  ): SnapshotElement | undefined {
    if (!ref) return undefined;
    return snapshots.get(computerId)?.elements.get(ref);
  }

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
      /** The person's Stop, on its way to the browser. See the acting methods below. */
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
    run: () => Promise<T>,
  ): Promise<T> {
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
        console.error(
          JSON.stringify({
            type: "computer-repeat-row-lost",
            bot: botId,
            fingerprint: repetition.fingerprint,
            count: repetition.count,
            error: String(error),
          }),
        );
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
      result = await run();
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

  return {
    snapshot,
    read,

    /**
     * Handovers, recorded but not policy-gated.
     *
     * The policy constrains what a Bot may do. A person taking the wheel is the escape hatch that
     * makes a governed Bot usable at all, and a rule able to lock somebody out of their own browser
     * halfway through a login would be a worse failure than anything it prevented. So these write the
     * row and do not ask. What IS recorded is the period: who, when, and why the Bot asked, the fact
     * an investigator wants is that a human drove this browser between two times.
     */
    async requestHelp(
      computerId: string,
      botId: string,
      actor: ActionActor,
      reason: string,
    ) {
      const state = await as(botId).requestControl(reason);
      await writeControlEvent(auditStore, "computer.help_requested", {
        botId,
        actor,
        computerId,
        reason,
      });
      return state;
    },

    async takeControl(computerId: string, botId: string, actor: ActionActor) {
      const state = await as(botId).takeControl();
      await writeControlEvent(auditStore, "computer.control_taken", {
        botId,
        actor,
        computerId,
        // Carried onto the row so the trail says what the person was handed, not merely that they
        // took over.
        reason: state.reason,
      });
      return state;
    },

    async releaseControl(
      computerId: string,
      botId: string,
      actor: ActionActor,
    ) {
      const state = await as(botId).releaseControl();
      await writeControlEvent(auditStore, "computer.control_released", {
        botId,
        actor,
        computerId,
      });
      return state;
    },

    async control(botId: string) {
      const state = await as(botId).control();
      // The open request's target, resolved when it was made. Attached only while the request is
      // open, so a stale entry cannot describe a box that is no longer asking.
      const into = secretTargets.get(botId);
      return state.secretWanted && into
        ? { ...state, secretInto: into }
        : state;
    },

    /**
     * The computers, for the admin surface. A read, so no audit row.
     *
     * Said, not inferred: every Bot shares the account's one browser, which looks identical on
     * every screen to each having its own — same cards, same trail, same screenshots. A reader has
     * to be told which arrangement they are looking at.
     */
    async computers() {
      return { isolation: "shared" as const, ...(await client.computers()) };
    },

    /**
     * Stop a computer's browser, keeping what it knows.
     *
     * Audited, unlike the read above, because a person reached in and stopped something. Recorded
     * whether or not a browser was actually running: "she pressed stop and nothing was running" is a
     * fact worth having, and a trail that only records effective actions cannot tell you what somebody
     * tried.
     */
    async stopComputer(computerId: string, botId: string, actor: ActionActor) {
      const result = await as(botId).stopComputer();
      await writeControlEvent(auditStore, "computer.stopped", {
        botId,
        actor,
        computerId,
        reason: result.wasRunning
          ? "browser was running"
          : "no browser was running",
      });
      return result;
    },

    /**
     * Wipe a computer's profile.
     *
     * The most destructive button we have. Every login the Bot had is gone and no undo exists, so the
     * row is written whatever happens next.
     */
    async resetComputer(computerId: string, botId: string, actor: ActionActor) {
      const result = await as(botId).resetComputer();
      await writeControlEvent(auditStore, "computer.reset", {
        botId,
        actor,
        computerId,
        reason: "every saved login on this computer was deleted",
      });
      return result;
    },

    /**
     * Asking for a secret, and supplying one.
     *
     * Both are audited, and neither records the value. The row says a secret was asked for, what it
     * was called, and which field it went in, the things an investigator needs in order to know a
     * human credential entered this session. The value itself is on one path only, from a person's
     * keyboard to the page, and is not on this one.
     */
    async requestSecret(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: SecretRequest,
    ) {
      /*
       * THE FIELD IS RESOLVED HERE, NEVER TAKEN FROM THE BOT.
       *
       * This call used to go straight to the computer with whatever ref and label the model sent,
       * outside the policy and outside the snapshot: a page that steered the Bot could ask for
       * "네이버 비밀번호" into a box of its own, and the masked prompt showed the person exactly that.
       * The ref now has to name a field on the snapshot this server holds, the host and the field's
       * own label are recorded and returned beside the Bot's words, and a ref that resolves to
       * nothing — or to a button — is refused with a row, like any other action.
       */
      const cached = snapshots.get(computerId);
      if (!cached || cached.stale || cached.snapshotId !== input.snapshotId) {
        throw new StaleSnapshotError(
          "The snapshot this ref came from is no longer current. Take a fresh snapshot and use the refs from it.",
        );
      }
      const element = cached.elements.get(input.ref);
      if (!element || !SECRET_ENTRY_ROLES.has(element.role)) {
        const refusal: PolicyDecision = {
          allowed: false,
          matched: null,
          source: "deny",
          forward: false,
          code: "laf:secret_target_not_a_field",
        };
        await write(auditStore, {
          toolName: "computer_request_secret",
          botId,
          actor,
          computerId,
          element,
          ref: input.ref,
          filePath: undefined,
          pageUrl: cached.url,
          decision: refusal,
        });
        throw new ActionRefusedError(null, "laf:secret_target_not_a_field");
      }
      const into = {
        host: hostOf(cached.url),
        element: { role: element.role, name: element.name },
      };
      // One line, bounded: it is rendered on the masked box and written into the trail.
      const label = input.label.replace(/\s+/g, " ").trim().slice(0, 120);
      const state = await as(botId).requestSecret({ ...input, label });
      secretTargets.set(computerId, into);
      await writeControlEvent(auditStore, "computer.secret_requested", {
        botId,
        actor,
        computerId,
        reason: `${label} (into ${element.role} "${element.name}" on ${into.host})`,
      });
      return { ...state, secretInto: into };
    },

    async supplySecret(
      computerId: string,
      botId: string,
      actor: ActionActor,
      text: string,
    ) {
      const result = await as(botId).supplySecret(text);
      secretTargets.delete(computerId);
      await writeControlEvent(auditStore, "computer.secret_supplied", {
        botId,
        actor,
        computerId,
        // Length, never content. Enough to show something real was entered.
        reason: `${result.characters} characters`,
      });
      return result;
    },

    humanInput(
      botId: string,
      input: Parameters<ComputerClient["humanInput"]>[0],
    ) {
      return as(botId).humanInput(input);
    },

    /**
     * Opening a page, through the gateway so it lands in the audit trail.
     *
     * The client still applies its target guard, which is the floor that holds under every policy,
     * including one that permits everything. This adds the record and the per-Bot decision on top: a
     * refusal by either produces a row, so navigation denials are visible in the audit trail.
     */
    async navigate(
      computerId: string,
      botId: string,
      actor: ActionActor,
      url: string,
      /**
       * An answer a person gave to this exact call, if one has been given.
       *
       * Last and optional on every acting method, so a caller that knows nothing about approvals
       * behaves exactly as it did and a route that forgets to pass it fails by asking again rather
       * than by acting unasked.
       */
      approvalId?: string,
    ) {
      const result = await govern(
        computerId,
        "computer_navigate",
        botId,
        actor,
        { targetUrl: url, ...(approvalId ? { approvalId } : {}) },
        () => as(botId).navigate(url),
      );
      /*
       * The page that actually loaded, not the one that was asked for. A login wall redirects, and
       * the redirect is precisely the information worth having: `nid.naver.com` is not one of
       * 스마트스토어's hosts, so it reads as "not signed in" without any special case.
       */
      noteSiteVisit(botId, actor, result.url, result.text);
      return result;
    },

    click(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ClickInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_click",
        botId,
        actor,
        {
          ref: input.ref,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).click(input, signal),
      );
    },

    type(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: TypeInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_type",
        botId,
        actor,
        {
          ref: input.ref,
          // Whether this call ends by pressing Enter, which is the third way into a form and the one
          // a rule about clicking and a rule about `key` both miss. The computer presses it itself,
          // so it never arrives here as an action of its own to be judged.
          submit: input.submit === true,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).type(input, signal),
      );
    },

    key(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: KeyInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_key",
        botId,
        actor,
        // The key is part of the subject, so a rule can tell Enter from a letter. Form submission can
        // happen through a keypress as well as a click, so the policy context carries the key.
        {
          ref: input.ref,
          key: input.key,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).key(input, signal),
      );
    },

    scroll(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ScrollInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_scroll",
        botId,
        actor,
        { ...(approvalId ? { approvalId } : {}) },
        () => as(botId).scroll(input),
      );
    },

    /**
     * Moving to another tab, governed as the read it is.
     *
     * It goes through the gateway rather than straight to the client for the audit row: which page a
     * Bot was on when it pressed something is the question every trail is read to answer, and a tab
     * change that left no row would make that unanswerable.
     */
    switchTab(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: SwitchTabInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_switch_tab",
        botId,
        actor,
        { ...(approvalId ? { approvalId } : {}) },
        () => as(botId).switchTab(input),
      );
    },

    /**
     * Handing a workspace file to a page.
     *
     * Its own intent, `upload`, and in the shipped policy's `ask` list. Everything else a Bot does
     * with a file stays inside its own workspace; this is the one call that takes something out of
     * it and gives it to somebody else's website, and the thing it hands over may be the 정산 내역
     * it wrote this morning.
     */
    uploadFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: UploadFileInput,
      signal?: AbortSignal,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_upload_file",
        botId,
        actor,
        {
          ref: input.ref,
          // The file is part of the subject, so a rule about which files may leave the workspace has
          // something to match on, and so the audit row names what was handed over.
          filePath: input.path,
          ...(signal ? { signal } : {}),
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).uploadFile(input, signal),
      );
    },

    /**
     * The file tools, governed like everything else.
     *
     * The read is governed too, unlike reading a page. A page was permitted when it was opened; the
     * workspace accumulates whatever a Bot has saved across every task it has ever run, so which of
     * those files it may read back is a real question for a deployment to be able to answer.
     */
    readFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ReadFileInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_read_file",
        botId,
        actor,
        { filePath: input.path, ...(approvalId ? { approvalId } : {}) },
        () => as(botId).readFile(input),
      );
    },

    /**
     * Listing is governed too, and for the same reason the read is: what a Bot has accumulated over
     * every task it has run is worth being able to restrict. A rule denying a folder hides it from the
     * listing as well as from reads, which is the consistent answer.
     */
    listFiles(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: ListFilesInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_list_files",
        botId,
        actor,
        {
          filePath: input.path ?? ".",
          ...(approvalId ? { approvalId } : {}),
        },
        () => as(botId).listFiles(input),
      );
    },

    writeFile(
      computerId: string,
      botId: string,
      actor: ActionActor,
      input: WriteFileInput,
      approvalId?: string,
    ) {
      return govern(
        computerId,
        "computer_write_file",
        botId,
        actor,
        { filePath: input.path, ...(approvalId ? { approvalId } : {}) },
        () => as(botId).writeFile(input),
      );
    },
  };
}

/**
 * Split a path into the parts a rule wants to match on.
 *
 * Lower-cased, because a rule forbidding `.env` must also catch `.ENV`; the
 * operator should have anticipated. Same reasoning as the case-insensitive `contains` in policy.ts.
 */
function describeFile(path: string): {
  path: string;
  name: string;
  extension: string;
} {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    // A leading dot is the whole name of a dotfile, not an extension: `.env` has no extension, and the
    // rule for it is written against `name`.
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}

export type ComputerGateway = ReturnType<typeof createComputerGateway>;

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
/**
 * What an action does, from what the gateway already knows.
 *
 * Derived here rather than passed in by each call site, so a new acting route cannot arrive
 * without an intent and fall outside every rule written in terms of one.
 *
 * Enter and Space are activations. They press whatever has focus, so a rule about activation must
 * cover keypresses as well as clicks.
 */
const ACTIVATING_KEYS = new Set(["Enter", "NumpadEnter", "Space", " "]);

/**
 * The intents this gateway can produce, which is every one that is not about somebody else's server.
 *
 * Named so that both readers of an intent take the same value: the policy context, whose union also
 * covers MCP calls, and the subject a person is shown, whose union also covers a tool call and the
 * unrecognised case. A plain `PolicyContext["intent"]` here would let `read_tool` into a browser
 * subject, which is a sentence about a page that no page was involved in.
 */
type BrowserIntent = Extract<
  PolicyContext["intent"],
  AskSubject["intent"] | undefined
>;

function intentOf(toolName: string, key: string | undefined): BrowserIntent {
  switch (toolName) {
    case "computer_click":
      return "activate";
    case "computer_key":
      return key && ACTIVATING_KEYS.has(key) ? "activate" : "type";
    case "computer_type":
      return "type";
    case "computer_navigate":
      return "navigate";
    case "computer_read":
    case "computer_snapshot":
    case "computer_screenshot":
    case "computer_scroll":
    // Looking at a tab the browser already has open changes nothing on any website. What it changes
    // is which page the NEXT action lands on, and that action is judged on its own.
    case "computer_switch_tab":
      return "read";
    case "computer_upload_file":
      return "upload";
    case "computer_read_file":
      return "read_file";
    case "computer_write_file":
      return "write_file";
    case "computer_list_files":
      return "list_files";
    default:
      return undefined;
  }
}

async function write(
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
async function writeRepeat(
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
 * The host a rule can match on, or empty.
 *
 * Empty means "no page", which is the accurate answer before a Bot has snapshotted anything, and it is
 * the only case that occurs in practice: the URL comes from Playwright's own `page.url()` by way of the
 * snapshot cache. Worth stating explicitly because a `page.host == "..."` deny rule would not match an
 * empty host, so a boundary that must not be evadable should also key on the tool, the element or the
 * file rather than on the host alone.
 */
/**
 * One row for a handover.
 *
 * Separate from `write` because a handover has no element, no file and no policy decision, forcing it
 * through the same shape would mean inventing a decision that was never asked for, and a row claiming
 * a policy allowed something it never saw is exactly the kind of comfortable fiction this trail exists
 * to avoid.
 */
async function writeControlEvent(
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
async function writeApprovalEvent(
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

/**
 * The host a rule is matched against, spelled one way.
 *
 * `URL.host` keeps a non-default port and a trailing dot, and the shipped money-host pattern is
 * anchored on `$` — so `kbstar.com.` and `kbstar.com:8443` walked past a rule written for
 * `kbstar.com` (measured). `normalizeHostname` is the same spelling every other host comparison in
 * this server uses.
 */
function hostOf(url: string): string {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return "";
  }
}

/**
 * The page, as the trail may keep it: the address without its query or fragment.
 *
 * A URL is routinely a credential carrier — `?code=…&state=…` on an OAuth return, a password-reset
 * link, a pre-signed file — and the trail is append-only for a year. The path is what a reader
 * needs; the query is where the secrets are.
 */
function pageForTrail(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 200);
  }
}

/**
 * The path, for a card that would otherwise say only which site.
 *
 * The query string is deliberately dropped. It is where an order number, an email address and a
 * session token live, and this string is rendered on a screen and written into an audit payload —
 * the same reasoning that keeps typed text out of both.
 */
function pathOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
}

/** Whether the rule that asked was one about a Bot going round in circles. See `REPEAT_RULE`. */
function isAboutRepetition(expression: string | null): boolean {
  return expression !== null && /\brepeat\s*\./.test(expression);
}

/**
 * What is about to happen, as the facts a person is shown.
 *
 * Assembled here, once, from what the SERVER resolved: the element off its own snapshot, the host
 * off the URL it is about to open. The sentence used to be assembled in `policy.ts`, in English,
 * and rendered as-is on three Korean screens — see {@link AskSubject}.
 */
function askSubjectOf(input: {
  intent: BrowserIntent;
  pageUrl: string;
  filePath: string | undefined;
  element: SnapshotElement | undefined;
  /** The expression that asked, to tell a question about repetition from any other. */
  matched: string | null;
  repeatCount: number;
}): AskSubject {
  const reason = isAboutRepetition(input.matched) ? "repeat" : "policy_ask";
  const repeated =
    reason === "repeat" ? { repeatCount: input.repeatCount } : {};
  // A file call has nothing to do with whatever the browser is showing, so its subject names no
  // host: saying one would send somebody to a page that has nothing to do with it.
  if (input.filePath) {
    return {
      kind: "file",
      intent: input.intent ?? "act",
      file: { path: input.filePath },
      ...repeated,
      reason,
    };
  }
  const host = hostOf(input.pageUrl);
  const path = pathOf(input.pageUrl);
  return {
    kind: "browser",
    intent: input.intent ?? "act",
    ...(host ? { host } : {}),
    ...(path ? { path } : {}),
    ...(input.element
      ? { element: { role: input.element.role, name: input.element.name } }
      : {}),
    ...repeated,
    reason,
  };
}
