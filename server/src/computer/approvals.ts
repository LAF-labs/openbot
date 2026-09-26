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
import type { HighRiskKind } from "./high-risk";
import type { AllowanceScope, AllowanceTier } from "./standing-approvals";

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
 * How long a window may go quiet before the step it was holding counts as let go.
 *
 * The window whose tool call raised a question holds it open by asking after it every second
 * (`hold`), and says so when it goes away (`release`, sent as the page is hidden for good). The
 * quiet is for the window that could not say so: a crash, a laptop lid, a phone that killed the tab.
 * Ninety seconds, because a hidden Chrome tab is throttled to one timer a minute after five minutes
 * (measured 2026-08-24): a window that is merely behind others must not have its step taken from it.
 */
export const HOLD_LAPSE_MS = 90_000;

/**
 * The step of a conversation a question holds open: which thread, and which of the Bot's tool calls.
 *
 * What lets a question outlive the window it was raised in (UX review 0.5.4, candidate 1). The
 * window that raised it used to be the only thing that knew which tool call it was about, so
 * closing or reloading it took the card away, and a second window showed the task stopped with no
 * card at all. With the step on the question, any window that opens the conversation can draw the
 * card on its line and, when nobody else is holding the step, carry it on once it is answered.
 *
 * Separate from `threadId`, which is present only when "for this conversation" is on offer and is
 * off with every other allowance when a deployment turns them off; where a question was raised is a
 * fact either way.
 */
export type ApprovalStep = { threadId: string; toolCallId: string };

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
   * The control the ref resolved to, as the server saw it when the question was asked.
   *
   * A ref is an ordinal Playwright mints per snapshot — `e13` — and a page that re-renders in place
   * keeps its URL while handing `e13` to a different control. The fingerprint used to stop at the
   * ref, so the thing the person was shown ("Place order") and the thing the approval could be spent
   * on were bound only by that ordinal staying put, which on a page an attacker writes it need not.
   * The role and the label are what the person actually read; they go into the hash.
   */
  element?: { role: string; name: string } | undefined;
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

/**
 * Why a call must stop for a person even when the written policy allows it.
 *
 * `money` and `external` are the plugin contract's x-laf/effect classes: actions whose target lives
 * in their arguments, which is why an `external` call carries a {@link CallPreview} of them to the
 * card. `destructive` is the server's own declaration. `unannotated` is a tool that declared
 * nothing — treated as the most dangerous thing it could have said.
 *
 * A floor asks; it does not forbid a wider answer. A person who presses 이 도구 항상 허용 on one of
 * these has let that Bot's later calls of that tool go without asking, whatever their arguments —
 * what the button says, kept by the owner's decision of 2026-09-16 (`settle.ts`).
 *
 * Defined here rather than in `plugins/laf-contract.ts` because it travels on the approval, and the
 * surface phrases it; the contract module re-exports it under its own name so there is one list
 * rather than two that agree by hand.
 */
export type AskGuard = "money" | "external" | "destructive" | "unannotated";

/** What the action does, in the terms a person is asked about it. */
export type AskIntent =
  | "navigate"
  | "activate"
  | "type"
  | "read"
  | "read_file"
  | "write_file"
  | "list_files"
  /** A workspace file handed to a site, which is the one browser action that sends something out. */
  | "upload"
  /** A tool on somebody else's server. Read and write are not phrased apart; the guard is. */
  | "call_tool"
  /**
   * An acting route whose tool nothing here recognises.
   *
   * Nothing produces one today — every route through the gateway names a tool `intentOf` knows —
   * and it exists so that adding a ninth one without an intent produces a vague sentence rather than
   * a card with a hole in it. The words for it say only that the Bot wants to do something, because
   * that is all that would be known.
   */
  | "act";

/**
 * Why the boundary stopped here, which is a different fact from what the action is.
 *
 * `policy_ask` is a rule somebody wrote. `guard_floor` and `unannotated` are the plugin contract's
 * floors, which ask whatever the policy said. `repeat` is the same action over and over — the one
 * case where the sentence is about the count rather than about the thing being acted on.
 */
export type AskReason =
  | "policy_ask"
  | "guard_floor"
  | "repeat"
  | "unannotated"
  /**
   * A submission the high-risk check put in front of a person whatever an allowance or the owner's
   * instruction would have said: it pays, changes how an account is secured, or hands somebody's
   * details to a site (`high-risk.ts`). `risk` says which.
   */
  | "high_risk";

/**
 * WHAT IS ABOUT TO HAPPEN, AS FACTS, FOR A SURFACE TO SAY IN ITS OWN LANGUAGE.
 *
 * Not to be confused with {@link ApprovalSubject} above. That one is what the FINGERPRINT is taken
 * over — the identity of one action, hashed, compared. This is what a person is being asked about.
 *
 * It replaced a `question` field holding an English sentence that `describeAsk` assembled in
 * `policy.ts` and three screens rendered verbatim, while the MCP guard's questions in the same field
 * were Korean — one field, two languages, and a Korean reader shown "The Bot wants to press …"
 * whatever the dictionary said. The server sends the facts and the surface owns the words
 * (docs/laf/redesign-2026-09.md §4-2, §5.1(b)); `app/src/lib/approvals.ts` is where they become a
 * sentence, and a test there walks every intent and reason this type can carry.
 *
 * Everything in it is what the SERVER resolved — the element off its own snapshot, the host off the
 * URL it is about to open — never anything the model claimed about what it was doing.
 */
export type AskSubject = {
  kind: "browser" | "file" | "tool";
  intent: AskIntent;
  /** The site the action lands on, absent when there is no page in it. */
  host?: string;
  /** The path being opened, for a navigation that names one beyond `/`. */
  path?: string;
  /** The control, as the server resolved it from its own snapshot. */
  element?: { role: string; name: string };
  file?: { path: string };
  tool?: { server: string; name: string; guard?: AskGuard };
  /** How many times this exact call has just been made, when that is why it stopped. */
  repeatCount?: number;
  /** What made it high-risk, when that is why it stopped. See `high-risk.ts`. */
  risk?: HighRiskKind[];
  reason: AskReason;
};

/**
 * One thing an outward call carries, named by what it is rather than by the argument it came in.
 *
 * A closed list because the surface writes a label for each (`app/src/lib/call-preview.ts`), and a
 * value arriving under a name it has no word for is dropped there rather than drawn unlabelled.
 */
export type CallPreviewField =
  /** The addresses or phone numbers a message goes to. */
  | "recipients"
  /** The addresses an invitation is mailed to. Not `recipients`: the event is the thing sent. */
  | "attendees"
  | "subject"
  /** An event's own name. */
  | "title"
  | "starts"
  | "ends"
  | "location"
  /** The 알림톡 template's code. The card names the ones it knows. */
  | "template"
  /** The words that leave: a mail's body, a published reply, the message a customer will read. */
  | "text"
  /** Which review a reply is published under. */
  | "review"
  | "order"
  /** The status an order is about to be moved to, as the vendor's own code. */
  | "status";

export type CallPreviewEntry = {
  field: CallPreviewField;
  /** What the call carries for it — one value, or several for a list — each cut to its bound. */
  values: string[];
  /** How many values the call carried, present only when that is more than are shown. */
  total?: number;
  /** Present when a value was cut short, so the card never passes a fragment off as the whole. */
  cut?: true;
};

/**
 * WHAT AN OUTWARD CALL WILL SEND, FOR THE PERSON ASKED TO LET IT.
 *
 * Measured 2026-09-16 (audit R4-01): the question for an 알림톡, a mail, an invitation, a review
 * reply or an order status change carried `{ server, name, guard }` and nothing else, so the "yes"
 * that the fingerprint binds to one exact set of arguments was given without seeing any of them.
 * The transport that knows the arguments writes this beside the question (`VendorTransport
 * .previewCall`), from the same arguments the fingerprint is taken over and the vendor is sent.
 *
 * Facts, bounded, and never a secret: who, what, when, cut to a size a card can hold
 * (`plugins/call-preview.ts`). The surface writes the words around them.
 *
 * NOT ON {@link AskSubject}, AND THAT IS THE POINT. The subject is copied into the audit trail when
 * the question is raised and again when it is answered, into a standing allowance's row, into the
 * notification outbox and in front of the auto-review model. A recipient and a message body belong
 * in none of those — the trail records that typing happened, never what was typed, and an audit row
 * is forever. So the preview lives on the question itself, which is in memory for ten minutes and
 * is handed only to the surfaces that draw the card.
 */
export type CallPreview = CallPreviewEntry[];

export type PendingApproval = {
  id: string;
  botId: string;
  /** Who was driving the Bot when it met the rule. Not necessarily who answers. */
  actor: string;
  /** The expression that asked, so the surface and the trail can name the boundary. */
  rule: string;
  /** What is about to happen, in facts. The sentence is the surface's. See {@link AskSubject}. */
  subject: AskSubject;
  /** What an outward call will send, where the call has one. Never written down; see the type. */
  preview?: CallPreview;
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
  /**
   * The conversation the action was raised from, so "for this conversation" has something to bind
   * to. Absent when the action came from outside any — a routine — and the card then offers the
   * standing answer alone. Read off this record when the middle answer is granted, never off the
   * request, for the reason `scope` is.
   */
  threadId?: string;
  /**
   * The task in that conversation the action was raised under — the person's newest message there,
   * read by the server when the question was asked — so "for this task" has something to bind to.
   * Present only with `threadId`, and only where the server could read one.
   */
  taskId?: string;
  /** The conversation step this question holds open. See {@link ApprovalStep}. */
  step?: ApprovalStep;
  /**
   * The window holding the step while it waits, and when it last said so. Absent once let go.
   * An id the window made up for itself; nothing is authorised by it, it only says who carries on.
   */
  holder?: { id: string; seenAt: number };
  requestedAt: string;
  expiresAt: string;
  /** Undefined until somebody answers. False is an answer, and a final one. */
  granted?: boolean;
  /**
   * How wide the yes was, when it was wider than this once — set in the same step as `granted`.
   *
   * MEASURED 2026-09-25: "toss.im 항상 허용" pressed, the standing row written, and the line read
   * "허용함". The window waiting on the question reads `granted: true` off this record on its next
   * poll, which can land before the press's own answer comes back, and the record did not say how
   * wide. Every reader that learns the answer from here — that wait, and every other window of the
   * conversation — now learns the tier with it. Only a tier this question could give: "always"
   * needs a scope, "for this conversation" a thread, the same test the standing grant makes.
   */
  tier?: AllowanceTier;
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
  subject: AskSubject;
  /** What the call will send, so the card can show it. Handed to nothing but a card's surfaces. */
  preview?: CallPreview;
  /** What "always" would cover, so the surface can say so on the button rather than beside it. */
  scope?: AllowanceScope;
  /** Present when "for this conversation" is on offer, so the card knows to draw that button. */
  threadId?: string;
  /** Present when "for this task" is on offer, so the card knows to draw that button. */
  taskId?: string;
  /** Which conversation and which tool call, so every window of it can draw the card. */
  step?: ApprovalStep;
  /** Some window is holding the step and will carry it on; nobody else should. */
  held?: true;
  requestedAt: string;
  expiresAt: string;
  granted?: boolean;
  tier?: AllowanceTier;
  answeredBy?: string;
};

/** Whether a window is holding this question's step right now. */
export function isHeld(approval: PendingApproval, at: number): boolean {
  return (
    approval.holder !== undefined && at - approval.holder.seenAt < HOLD_LAPSE_MS
  );
}

export function presentable(
  approval: PendingApproval,
  at: number = Date.now(),
): PresentedApproval {
  return {
    id: approval.id,
    botId: approval.botId,
    rule: approval.rule,
    subject: approval.subject,
    ...(approval.preview ? { preview: approval.preview } : {}),
    ...(approval.scope ? { scope: approval.scope } : {}),
    ...(approval.threadId ? { threadId: approval.threadId } : {}),
    ...(approval.taskId ? { taskId: approval.taskId } : {}),
    ...(approval.step ? { step: approval.step } : {}),
    ...(isHeld(approval, at) ? { held: true as const } : {}),
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    ...(approval.granted === undefined ? {} : { granted: approval.granted }),
    ...(approval.tier ? { tier: approval.tier } : {}),
    ...(approval.answeredBy ? { answeredBy: approval.answeredBy } : {}),
  };
}

export type ApprovalAnswer =
  | { ok: true; approval: PendingApproval }
  /** One reason, because a person acts on all three identically: that question is no longer open. */
  | { ok: false; reason: "no longer open" };

/**
 * What a window learned by holding a question's step.
 *
 * `holding` false means another window has it and is alive: this one draws the card and leaves the
 * carrying on to that one. `ok: false` means the question is not open here any more — answered and
 * spent, withdrawn, expired, or asked about another Bot.
 */
export type ApprovalHold =
  | { ok: true; approval: PendingApproval; holding: boolean }
  | { ok: false };

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
        // The control itself, where the server resolved one: a page that re-renders in place keeps
        // its URL while handing the same ref to a different button, and the ref alone would let an
        // answer for "Place order" be spent on whatever `e13` became.
        subject.element
          ? `${subject.element.role}\u0001${subject.element.name}`
          : "",
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
    subject: AskSubject;
    /** What an outward call will send, for the card. See {@link CallPreview}. */
    preview?: CallPreview;
    fingerprint: string;
    /** What answering "always" would cover. Omitted where nothing about the action is durable. */
    scope?: AllowanceScope;
    /** The conversation it came from, where it came from one. See PendingApproval.threadId. */
    threadId?: string;
    /** The task in that conversation, where the server could read one. See PendingApproval.taskId. */
    taskId?: string;
    /** The conversation step it holds open, where the surface named one. See {@link ApprovalStep}. */
    step?: ApprovalStep;
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
    /** The wider answer pressed, if any. Recorded only where the question could give it. */
    tier?: AllowanceTier,
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
   * The person taking their own No back, named by the question it answered.
   *
   * Without it a No could not be undone from the conversation: the question is closed once
   * answered and gone ten minutes later, while its No stands for thirty, so a person who changed
   * their mind watched the Bot be refused without being asked (0.5.4 QA). This reopens nothing and
   * grants nothing — the next attempt at the action simply asks again, on a card of its own.
   *
   * By the approval's id, which the card that was answered holds, and on the Bot it was asked about.
   * The declined question comes back for the trail; `ok: false` when no No of that question still
   * stands — it ran out, it was already taken back, or this process never heard it.
   */
  liftDecline: (
    id: string,
    botId: string,
  ) => Promise<{ ok: true; approval: PendingApproval } | { ok: false }>;
  /**
   * A window saying it is still waiting on this question, and will carry its step on.
   *
   * Taken when nobody holds it, when the holder let it go, or when the holder has been quiet for
   * {@link HOLD_LAPSE_MS}; kept by whoever holds it for as long as it keeps asking. One holder at a
   * time is what stops two windows carrying the same step on twice.
   */
  hold: (id: string, botId: string, holderId: string) => Promise<ApprovalHold>;
  /** The holding window is going away. The question stays open for another window to take. */
  release: (id: string, botId: string, holderId: string) => Promise<boolean>;
  /**
   * The turn that raised this question was stopped, so nobody is waiting for its answer.
   *
   * Not a No: nothing is recorded against the action and the next attempt asks as usual. Without
   * it a stopped turn's question stayed answerable for the rest of its ten minutes, and now that
   * every window of a conversation draws what is open, it would have been drawn in all of them.
   */
  withdraw: (id: string, botId: string) => Promise<PendingApproval | undefined>;
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
  /** The No, until when it stands, and the question it answered — which is how it is taken back. */
  const until = new Map<
    string,
    { expires: number; approval: PendingApproval }
  >();
  const key = (botId: string, fingerprint: string) =>
    `${botId}\u0000${fingerprint}`;
  // Swept on read, like the questions themselves: nothing here matters until somebody looks.
  const sweep = (at: number) => {
    for (const [entry, decline] of until) {
      if (decline.expires <= at) until.delete(entry);
    }
  };

  return {
    record(approval: PendingApproval) {
      until.set(key(approval.botId, approval.fingerprint), {
        expires: now() + stickyMs,
        approval,
      });
    },
    stands(botId: string, fingerprint: string) {
      const at = now();
      sweep(at);
      return (until.get(key(botId, fingerprint))?.expires ?? 0) > at;
    },
    lift(id: string, botId: string): PendingApproval | undefined {
      sweep(now());
      for (const [entry, decline] of until) {
        if (decline.approval.id === id && decline.approval.botId === botId) {
          until.delete(entry);
          return decline.approval;
        }
      }
      return undefined;
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
    /**
     * A question nobody answered in the time it had.
     *
     * The one ending of a question that produces no row anywhere else: a grant and a refusal are
     * both a person acting and are audited as one (`approval-routes.ts`), and an expiry is the
     * absence of that. It is what the notification outbox turns into `approval.expired`, and
     * without it "nobody was reached" and "somebody decided not to" look identical from outside.
     *
     * Called synchronously from the sweep, so it must do nothing slow and must not throw — the
     * sweep runs inside every read of this registry. A throw is swallowed here rather than left to
     * take a caller's read down with it.
     */
    onExpire?: (approval: PendingApproval) => void;
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
   * Drop what has run out, on every read.
   *
   * On read rather than on a timer, because a timer keeps a process alive and adds a thing that can
   * be forgotten in a test; nothing here matters until somebody looks, and everything that looks
   * sweeps first.
   */
  const sweep = () => {
    const at = now();
    for (const [id, approval] of open) {
      if (Date.parse(approval.expiresAt) <= at) {
        open.delete(id);
        // Only the ones nobody answered. An answered question that was never spent expires too, and
        // announcing that as "nobody was reached" would be false about the one case where somebody
        // definitely was.
        if (approval.granted === undefined && options.onExpire) {
          try {
            options.onExpire(approval);
          } catch {
            // A notification is not worth a read of this registry. See the option's own comment.
          }
        }
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
        subject: input.subject,
        ...(input.preview ? { preview: input.preview } : {}),
        fingerprint: input.fingerprint,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.threadId && input.taskId ? { taskId: input.taskId } : {}),
        ...(input.step ? { step: input.step } : {}),
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

    answer: async (id, botId, actor, granted, tier) => {
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
      const given = granted ? tierGiven(approval, tier) : undefined;
      const answered: PendingApproval = {
        ...approval,
        granted,
        ...(given ? { tier: given } : {}),
        answeredBy: actor,
      };
      open.set(id, answered);
      // A No outlives the question it answered. See DECLINE_STICKS_MS.
      if (!granted) declines.record(answered);
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
      return { ok: true, approval };
    },

    recentlyDeclined: async (botId, fingerprint) =>
      declines.stands(botId, fingerprint),

    liftDecline: async (id, botId) => {
      const approval = declines.lift(id, botId);
      return approval ? { ok: true, approval } : { ok: false };
    },

    hold: async (id, botId, holderId) => {
      sweep();
      const approval = open.get(id);
      if (!approval || approval.botId !== botId || !holderId) {
        return { ok: false };
      }
      const at = now();
      const takenElsewhere =
        isHeld(approval, at) && approval.holder?.id !== holderId;
      if (takenElsewhere) return { ok: true, approval, holding: false };
      const held: PendingApproval = {
        ...approval,
        holder: { id: holderId, seenAt: at },
      };
      open.set(id, held);
      return { ok: true, approval: held, holding: true };
    },

    release: async (id, botId, holderId) => {
      sweep();
      const approval = open.get(id);
      if (
        !approval ||
        approval.botId !== botId ||
        approval.holder?.id !== holderId
      ) {
        return false;
      }
      const { holder: _released, ...rest } = approval;
      open.set(id, rest);
      return true;
    },

    withdraw: async (id, botId) => {
      sweep();
      const approval = open.get(id);
      if (!approval || approval.botId !== botId) return undefined;
      open.delete(id);
      return approval;
    },
  };
}

/**
 * The wider answer a question can actually give: "always" and "today" where a scope was derived,
 * "for this conversation" where it was also raised from one, and "for this task" where the server
 * also knew which task. Anything else is this once — the card did not offer it, and a request that
 * asks anyway gets the once it did give rather than an allowance nobody was shown.
 */
export function tierGiven(
  approval: Pick<PendingApproval, "scope" | "threadId" | "taskId">,
  tier: AllowanceTier | undefined,
): AllowanceTier | undefined {
  if (!tier || !approval.scope) return undefined;
  if (tier === "thread" && !approval.threadId) return undefined;
  if (tier === "task" && !(approval.threadId && approval.taskId)) {
    return undefined;
  }
  return tier;
}
