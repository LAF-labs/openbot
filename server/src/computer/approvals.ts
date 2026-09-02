/**
 * The questions a Bot is waiting on a person to answer, and the binding that makes an answer mean
 * exactly one thing.
 *
 * In memory, per process, and deliberately not in the database. A pending question is about a live
 * browser session and a live turn: the snapshot the refs came from, the page that is open, the model
 * that is mid-run holding the tool call. A restart takes all three with it, so a persisted approval
 * would come back as a grant for an action nobody could still perform, attached to a conversation
 * nobody is having. Worse, it would be a grant nobody remembers giving. The safe reading of a
 * restart is that every open question was withdrawn, and the safe way to guarantee that is to keep
 * the questions somewhere a restart empties.
 *
 * A `computer_approvals` table once stood beside this and was what the server actually wired, on the
 * argument that several servers behind a load balancer each hold half the questions. This deployment
 * is one process on one VM (docs/laf/deployment-model.md), so that argument described somebody
 * else's product while this file's own first paragraph said the opposite. The table and its registry
 * were deleted on 2026-09-02 by decision §7-1; git holds them if the deployment ever changes shape,
 * and the list to start from is in the decision record.
 *
 * The important part is the fingerprint. An approval registry without one is a dialog box: a person
 * presses Allow, an id comes back, and the model may then spend that id on any action it likes.
 * Binding an approval to a hash of the action it was granted for is what stops "yes, click Place
 * order" being replayable as "yes, click Delete account", and it is the reason this is a governance
 * feature rather than a confirmation prompt.
 *
 * It lives beside the computer because that is where the boundary it serves was written, and it is
 * not only the computer's, the same policy judges a Bot's calls to somebody else's servers and those
 * raise the same questions. One registry per deployment rather than one per subsystem: a Bot waiting
 * on a person is waiting on a person, and a deployment with two of these would be a deployment where
 * the surface a person answers on decides which half of a Bot's work they can see.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AllowanceScope } from "./standing-approvals";

/**
 * How long a question stays open.
 *
 * Ten minutes, the same window the surface gives a person to answer a request for help or a secret.
 * Long enough that somebody who walked away from the screen can still come back and decide; finite
 * because a run holding a tool call open forever is a hung Bot, and because an approval that outlives
 * anybody's memory of the question is not consent.
 */
export const APPROVAL_TTL_MS = 10 * 60_000;

/**
 * How long a person's No goes on meaning no.
 *
 * Thirty minutes, and the number is a compromise with what this layer can see. What the boundary
 * wants is "for the rest of this conversation": a Bot told no should not be able to come back at the
 * same thing five seconds later with the same request, and a person should not have to answer the
 * same question until they give in. Nothing here knows about conversations — a registry entry is a
 * Bot, an action and a fingerprint — so the bound is a clock, set long enough to outlast the turn
 * that was refused and short enough that tomorrow's work is not shaped by yesterday's no.
 *
 * It is not a way to forbid something. Half an hour later the same action asks again, and a person
 * who wants it stopped for good writes it into the boundary where everybody can read it.
 */
export const DECLINE_STICKS_MS = 30 * 60_000;

/**
 * The action an approval is about, in the fields a fingerprint is taken over.
 *
 * Everything here is known to the caller before it acts and is derived from the request it is
 * actually about to make, never from anything the model asserted about it.
 */
export type ApprovalSubject = {
  botId: string;
  toolName: string;
  ref?: string | undefined;
  key?: string | undefined;
  /** True when a `computer_type` call will press Enter afterwards. See PolicyContext.submit. */
  submit?: boolean | undefined;
  filePath?: string | undefined;
  pageUrl?: string | undefined;
  /**
   * The arguments a tool call carries, for the calls whose whole meaning is in them.
   *
   * A browser action is identified by the thing it touches: a ref, a key, a path. A call to somebody
   * else's server is not. `postMessage` on the same Bot's same server is one action when it says
   * "the deploy finished" in a team channel and another when it says something else to a customer,
   * and a fingerprint that stopped at the tool name would make one person's yes cover both.
   *
   * Left out where the arguments are not the identity, so that a person who allowed a click is not
   * asked again because a snapshot id moved on.
   */
  arguments?: Record<string, unknown> | undefined;
};

export type PendingApproval = {
  id: string;
  botId: string;
  /** Who was driving the Bot when it met the rule. Not necessarily who answers. */
  actor: string;
  /** The expression that asked, so the surface and the trail can name the boundary. */
  rule: string;
  /** What is about to happen, in one sentence, as the policy phrased it. */
  question: string;
  /**
   * What the question is about, in the terms the audit trail files things under.
   *
   * Carried on the approval because the person answering arrives minutes later on a surface that
   * knows nothing but an id, and the row their answer writes has to land against the same thing the
   * action's own row will. Without it every answer would be filed against whichever subsystem
   * happened to own the endpoint they pressed the button on, so a yes to a tool call on somebody
   * else's server would be recorded as something that happened on a browser.
   */
  target: { type: string; id: string };
  /**
   * The action this approval is good for, and only this one.
   *
   * Kept on the record rather than recomputed at consumption time from whatever arrives, because the
   * whole point is to compare the action a person saw against the action being attempted.
   */
  fingerprint: string;
  /**
   * What answering this with "always" would cover. Absent when nothing could be derived.
   *
   * Decided by whoever raised the question, from the action itself, and never by the client pressing
   * the button — see `standing-approvals.ts`. It travels out to the surface because a person cannot
   * consent to a widening they were not shown, and it comes back off the record rather than off the
   * request when the widening is actually granted.
   */
  scope?: AllowanceScope;
  requestedAt: string;
  expiresAt: string;
  /** Undefined until somebody answers. False is an answer, and a final one. */
  granted?: boolean;
  /** Who answered, recorded so the audit row credits the decision to a person rather than to a Bot. */
  answeredBy?: string;
};

/**
 * An approval as a surface is allowed to see it.
 *
 * The fingerprint is the binding between an approval and its action, the actor is the person the
 * turn belonged to, and the target is bookkeeping for the trail. None of the three is any use to a
 * browser and all three are compared or written on the server, so they do not travel.
 *
 * One projection rather than one per handler. The reading endpoint and the answering endpoint sit
 * four lines apart and return the same record, and the way that goes wrong is that somebody adds a
 * field to the record and only one of them keeps it out; a stated invariant of a security surface
 * being quietly broken by a sibling handler is a worse failure than the field itself.
 */
export type PresentedApproval = {
  id: string;
  botId: string;
  rule: string;
  question: string;
  /** What "always" would cover, so the surface can say so on the button rather than beside it. */
  scope?: AllowanceScope;
  requestedAt: string;
  expiresAt: string;
  granted?: boolean;
  answeredBy?: string;
};

export function presentable(approval: PendingApproval): PresentedApproval {
  return {
    id: approval.id,
    botId: approval.botId,
    rule: approval.rule,
    question: approval.question,
    ...(approval.scope ? { scope: approval.scope } : {}),
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    ...(approval.granted === undefined ? {} : { granted: approval.granted }),
    ...(approval.answeredBy ? { answeredBy: approval.answeredBy } : {}),
  };
}

export type ApprovalAnswer =
  | { ok: true; approval: PendingApproval }
  /** One reason, because a person acts on all three identically: that question is no longer open. */
  | { ok: false; reason: "no longer open" };

export type ApprovalConsumption =
  | { ok: true; approval: PendingApproval }
  | {
      ok: false;
      reason: "unknown" | "unanswered" | "declined" | "a different action";
    };

/**
 * A stable hash of the action, used to bind one approval to one thing.
 *
 * Hashed rather than stored as a tuple so the value is a single opaque string that can be compared in
 * one line and cannot be partially matched by accident. The parts are joined with a NUL, which no
 * field can contain, so that a ref of "a" with a key of "bc" cannot produce the same fingerprint as
 * "ab" with "c".
 *
 * The Bot's id is in here first, which is what stops an approval granted on one Bot's computer being
 * spent on another's: two Bots doing the identical thing produce two different fingerprints, and
 * neither can consume the other's.
 */
export function fingerprintOf(subject: ApprovalSubject): string {
  return createHash("sha256")
    .update(
      [
        subject.botId,
        subject.toolName,
        subject.ref ?? "",
        subject.key ?? "",
        subject.submit === true ? "submit" : "",
        subject.filePath ?? "",
        subject.pageUrl ?? "",
        subject.arguments ? canonical(subject.arguments) : "",
      ].join("\u0000"),
    )
    .digest("hex");
}

/**
 * JSON with its keys in a fixed order, so two spellings of the same arguments hash the same.
 *
 * `JSON.stringify` keeps whatever order an object was built in, and the same call arrives here
 * twice: once when the question is asked and once when the answer is spent, with a parse in between.
 * Sorting makes the comparison about what the arguments say rather than about the order somebody's
 * client happened to write them in, which is not a difference anybody would understand being asked
 * about twice.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  // `undefined` stringifies to nothing at all, which would let a field somebody sent as undefined
  // hash the same as one they never sent.
  return JSON.stringify(value) ?? "null";
}

export type ApprovalRegistry = {
  /** Open a question. The id it returns is what a caller presents once somebody has answered. */
  request: (input: {
    botId: string;
    actor: string;
    rule: string;
    question: string;
    fingerprint: string;
    /** What answering "always" would cover. Omitted where nothing about the action is durable. */
    scope?: AllowanceScope;
    target: { type: string; id: string };
  }) => Promise<PendingApproval>;
  /**
   * The open questions for one Bot, newest last, expired ones already gone.
   *
   * Includes answered-but-unspent ones, because the waiting caller learns the answer by finding its
   * own id in this list. The surface shows only the unanswered ones.
   */
  pending: (botId: string) => Promise<PendingApproval[]>;
  /**
   * Answer one question, on the Bot it was asked about.
   *
   * The Bot is named rather than looked up from the id, and it has to match. The id is enough to
   * find the entry, so this is not authorisation, it is bookkeeping that cannot be wrong: the
   * surface takes the Bot from the address it was called on, and the row an answer writes says which
   * Bot it was about. Without the check those two can disagree, and then the trail holds a grant
   * filed under one Bot and the action it paid for filed under another, joined by an id that appears
   * on both and reconciles neither. "Who approved what" is the one question this record exists to
   * answer.
   */
  answer: (
    id: string,
    botId: string,
    actor: string,
    granted: boolean,
  ) => Promise<ApprovalAnswer>;
  /** Spend an approval on one action. Single use: a successful consumption removes it. */
  consume: (id: string, fingerprint: string) => Promise<ApprovalConsumption>;
  /**
   * Whether somebody's No to this exact action still stands.
   *
   * Asked before a question is opened, so that a Bot which has been refused cannot simply raise the
   * same question again — see DECLINE_STICKS_MS for why that mattered enough to be its own state.
   * Keyed on the fingerprint, so it is the action that was refused rather than the Bot: a Bot told
   * no about one button carries on with the rest of its work.
   */
  recentlyDeclined: (botId: string, fingerprint: string) => Promise<boolean>;
  /**
   * Hold until this question is answered, or until there is nothing left to wait for.
   *
   * The answered approval, or null — expired, spent, never open here, the wait abandoned, or the
   * bound run out. Null is one reason on purpose, the same way `answer` reports one: a caller does
   * the same thing with all of them, which is carry on without a grant.
   *
   * THIS IS WHY THE QUESTIONS ARE IN THIS PROCESS. The room used to ask `pending` once a second for
   * two minutes — a hundred and twenty list-builds and, while the registry was a table, a hundred
   * and twenty DELETE + SELECT pairs — to learn something that happened in the same process, in a
   * function it could simply have been told about. One process means the answer arrives on the same
   * heap the question is waiting on, so a promise settles at the moment somebody presses the button
   * rather than up to a second later.
   *
   * `timeoutMs` is the caller's bound and defaults to what is left of the question's own ten
   * minutes, so nothing waits on a question that can no longer be answered.
   */
  waitFor: (
    botId: string,
    approvalId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<PendingApproval | null>;
};

/**
 * The Nos, remembered beside the questions they answered.
 *
 * In memory, like the questions (docs/laf/deployment-model.md, and decision §7-1). A decline
 * outliving a restart while the question it answered does not would be the odd half: the Bot would
 * be refused for something nobody in this process ever asked about. A restart forgets both, the Bot
 * asks again, and a person answers again — which is the behaviour a restart is allowed to have.
 */
function createDeclineMemory(now: () => number, stickyMs: number) {
  const until = new Map<string, number>();
  const key = (botId: string, fingerprint: string) => `${botId} ${fingerprint}`;

  return {
    record(botId: string, fingerprint: string) {
      until.set(key(botId, fingerprint), now() + stickyMs);
    },
    stands(botId: string, fingerprint: string) {
      const at = now();
      // Swept on read, like the questions themselves: nothing here matters until somebody looks.
      for (const [entry, expires] of until) {
        if (expires <= at) until.delete(entry);
      }
      return (until.get(key(botId, fingerprint)) ?? 0) > at;
    },
  };
}

export function createApprovalRegistry(
  options: {
    /** Injectable so expiry can be tested without a test that sleeps for ten minutes. */
    now?: () => number;
    ttlMs?: number;
    /** How long a decline stands. See DECLINE_STICKS_MS. */
    declineStickyMs?: number;
  } = {},
): ApprovalRegistry {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  const declines = createDeclineMemory(
    now,
    options.declineStickyMs ?? DECLINE_STICKS_MS,
  );
  const open = new Map<string, PendingApproval>();

  /**
   * Who is holding for each question, so an answer can be handed to them rather than found.
   *
   * A set per question rather than one waiter, because a room turn and a chat turn can be waiting
   * on the same id — and because a waiter that walked away has to be able to remove itself without
   * taking anybody else's wait with it.
   */
  const waiting = new Map<
    string,
    Set<(answered: PendingApproval | null) => void>
  >();

  /** Hand every holder of this question its ending, once. */
  const settle = (id: string, answered: PendingApproval | null) => {
    const holders = waiting.get(id);
    if (!holders) return;
    waiting.delete(id);
    for (const hand of holders) hand(answered);
  };

  /**
   * Drop what has run out, on every read.
   *
   * On read rather than on a timer, because a timer keeps a process alive and adds a thing that can
   * be forgotten in a test; nothing here matters until somebody looks, and everything that looks
   * sweeps first.
   *
   * A waiter is told, because from where it is standing an expiry and an answer are the same event:
   * the question it was holding for is over.
   */
  const sweep = () => {
    const at = now();
    for (const [id, approval] of open) {
      if (Date.parse(approval.expiresAt) <= at) {
        open.delete(id);
        settle(id, null);
      }
    }
  };

  return {
    request: async (input) => {
      sweep();
      const at = now();
      const approval: PendingApproval = {
        id: randomUUID(),
        botId: input.botId,
        actor: input.actor,
        rule: input.rule,
        question: input.question,
        fingerprint: input.fingerprint,
        ...(input.scope ? { scope: input.scope } : {}),
        target: input.target,
        requestedAt: new Date(at).toISOString(),
        expiresAt: new Date(at + ttlMs).toISOString(),
      };
      open.set(approval.id, approval);
      return approval;
    },

    pending: async (botId) => {
      sweep();
      return [...open.values()].filter((approval) => approval.botId === botId);
    },

    answer: async (id, botId, actor, granted) => {
      sweep();
      const approval = open.get(id);
      // An answered question is not answerable again, whichever way it went. Otherwise a second
      // person, or the same person in a second tab, can quietly overturn a decision that the trail
      // has already recorded as made.
      //
      // A question asked about another Bot is reported the same way, because from where the caller
      // is standing it is the same fact: nothing is open here under that id.
      if (
        !approval ||
        approval.botId !== botId ||
        approval.granted !== undefined
      ) {
        return { ok: false, reason: "no longer open" };
      }
      const answered: PendingApproval = {
        ...approval,
        granted,
        answeredBy: actor,
      };
      open.set(id, answered);
      // A No outlives the question it answered. See DECLINE_STICKS_MS.
      if (!granted) declines.record(approval.botId, approval.fingerprint);
      // Whoever is holding for this hears it here, in the same tick the person's answer landed.
      settle(id, answered);
      return { ok: true, approval: answered };
    },

    consume: async (id, fingerprint) => {
      sweep();
      const approval = open.get(id);
      if (!approval) return { ok: false, reason: "unknown" };
      if (approval.granted === undefined) {
        return { ok: false, reason: "unanswered" };
      }
      if (approval.granted === false) return { ok: false, reason: "declined" };
      if (approval.fingerprint !== fingerprint) {
        // Left in place rather than burned. A mismatch is the replay this whole mechanism exists to
        // stop, and destroying the approval on the way past would let a model that guessed wrong take
        // the person's grant away from the action they actually meant it for.
        return { ok: false, reason: "a different action" };
      }
      // Single use. A grant is permission for one thing to happen once; leaving it spendable would
      // make "yes" mean "yes, as often as you like", which is not what anybody pressing Allow on one
      // button thinks they are agreeing to.
      open.delete(id);
      // Nobody should still be holding for a question that was answered before it was spent, but a
      // wait that outlived its answer must not outlive the question itself.
      settle(id, null);
      return { ok: true, approval };
    },

    recentlyDeclined: async (botId, fingerprint) =>
      declines.stands(botId, fingerprint),

    waitFor: async (botId, approvalId, options = {}) => {
      sweep();
      const approval = open.get(approvalId);
      // Gone, or another Bot's: the same nothing an expiry leaves behind, reported the same way.
      if (!approval || approval.botId !== botId) return null;
      if (approval.granted !== undefined) return approval;
      if (options.signal?.aborted) return null;

      /*
       * The bound. The caller's, or what is left of the question's own ten minutes — never
       * unbounded, because a promise nobody ever settles is a turn that never ends.
       *
       * A real timer rather than the injected clock: this is the backstop, and the paths that
       * actually end a wait (an answer, a sweep, an abort) are all events. A test that moves a fake
       * clock and reads the registry sweeps, and the sweep settles the wait.
       */
      const bound =
        options.timeoutMs ??
        Math.max(0, Date.parse(approval.expiresAt) - now());

      const holders =
        waiting.get(approvalId) ??
        new Set<(answered: PendingApproval | null) => void>();
      waiting.set(approvalId, holders);

      return new Promise<PendingApproval | null>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hand = (answered: PendingApproval | null) => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", abandon);
          // This set, not whatever the map holds now: `settle` drops the map entry before handing
          // anything out, and a later waiter may already have put a fresh set in its place.
          holders.delete(hand);
          if (holders.size === 0 && waiting.get(approvalId) === holders) {
            waiting.delete(approvalId);
          }
          resolve(answered);
        };
        const abandon = () => hand(null);

        holders.add(hand);
        timer = setTimeout(abandon, bound);
        timer.unref?.();
        options.signal?.addEventListener("abort", abandon, { once: true });
      });
    },
  };
}
