/**
 * The questions a boundary raised, from the browser's side: reading them, answering them, and
 * knowing which tool call each one belongs to.
 *
 * One module for all of it because the two halves have to agree. A tool call that met an `ask` rule
 * holds itself open waiting for an answer, and the card a person answers on is drawn on that same
 * tool call's line in the transcript. Those are different components on different render passes, so
 * the id travels through here.
 *
 * A question is held against the tool call that raised it rather than against the Bot. The Bot's
 * list is the wrong key: nothing withdraws a question when the wait around it ends, so pressing
 * Stop, reloading the tab or a turn that errors all leave an unanswered entry sitting in the
 * server's registry until it expires. A card that showed "the oldest thing this Bot is waiting on"
 * would then put a stale question in front of somebody on an unrelated line, record their Allow
 * against an action nobody is waiting for, and leave the action they were actually looking at
 * waiting out the full ten minutes.
 *
 * IT IS ALSO WHERE THE QUESTION BECOMES A SENTENCE. The server sends what the action is; the words
 * are chosen here, once, for every card that asks. See `describeSubject`.
 */
import { t } from "@/lib/i18n";

/**
 * How long the surface holds a tool call open for an answer, and how often it looks.
 *
 * Ten minutes matches the server's own window, so the wait ends because the question expired rather
 * than because the two sides disagreed about when it had.
 */
const WAIT_FOR_ANSWER_MS = 10 * 60_000;
const WAIT_POLL_MS = 1_000;

/**
 * How wide "always allow" would be, decided by the server from the action itself.
 *
 * `host` covers every action on one site, `file` one path, `tool` one tool by name. It is here so
 * the button can say which — a person cannot consent to a widening they were not shown — and it is
 * never sent back when the button is pressed: the server reads the scope off its own record, so
 * nothing a page could do makes the grant wider than the sentence somebody read.
 */
export type AllowanceScope = {
  kind: "host" | "file" | "tool";
  value: string;
};

/**
 * How long a yes is meant to last, as the three buttons on a card say it.
 *
 * `once` is this action. `thread` is this conversation — bound to the thread the question came
 * from, and to a day. `always` is until somebody takes it back. The middle one exists because the
 * other two are a day apart in weight, and somebody clearing an obstacle for one afternoon had
 * nothing honest to press.
 */
export type ApprovalTier = "once" | "thread" | "always";

/**
 * The header the server reads the current conversation from, so an answer can be "for this
 * conversation". Sent on every acting call the surface makes while a channel is open; absent, the
 * question is asked in the standing terms alone. Mirrors `THREAD_HEADER` in
 * `server/src/computer/gateway.ts`.
 */
export const THREAD_HEADER = "x-openbot-thread-id";

/**
 * The scope out of a pause reply, or undefined if it was not one.
 *
 * One parser for both callers — the computer's tools and the plugin call — because a scope that
 * half-validates in one of them is a button offering a widening the server will not perform. Not
 * knowing means offering "this once" alone, which is the safe direction and the behaviour this card
 * had before the wider button existed.
 */
export function allowanceScopeOf(value: unknown): AllowanceScope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, value: scoped } = value as Record<string, unknown>;
  if (kind !== "host" && kind !== "file" && kind !== "tool") return undefined;
  if (typeof scoped !== "string" || !scoped) return undefined;
  return { kind, value: scoped };
}

/**
 * WHAT THE BOT IS ABOUT TO DO, AS FACTS. The sentence is written here and nowhere else.
 *
 * The server used to send a finished English sentence in a field called `question`, assembled by
 * `describeAsk` in `server/src/computer/policy.ts`, and three screens rendered it as it arrived —
 * while the MCP guard's questions in that same field were Korean. One field, two languages, and a
 * Korean reader shown "The Bot wants to press “결제하기”" whatever the dictionary said
 * (docs/laf/redesign-2026-09.md §3.1, §5.1(b)).
 *
 * Mirrors `AskSubject` on the server. Every field is what the SERVER resolved — the element off its
 * own snapshot of the page, the host off the address it is about to open — never anything the model
 * said it was doing, which is the property that makes the question worth answering at all.
 */
export type AskSubject = {
  kind: "browser" | "file" | "tool";
  intent:
    | "navigate"
    | "activate"
    | "type"
    | "read"
    | "read_file"
    | "write_file"
    | "list_files"
    | "upload"
    | "call_tool"
    | "act";
  host?: string;
  path?: string;
  element?: { role: string; name: string };
  file?: { path: string };
  tool?: {
    server: string;
    name: string;
    guard?: "money" | "external" | "destructive" | "unannotated";
  };
  repeatCount?: number;
  reason: "policy_ask" | "guard_floor" | "repeat" | "unannotated";
};

export type PendingApproval = {
  id: string;
  botId: string;
  /** The expression that asked, shown as a rule so a person can see which boundary they are at. */
  rule: string;
  /** What is about to happen, in facts. `describeSubject` turns it into a sentence. */
  subject: AskSubject;
  /** Absent when nothing durable could be derived; the card then offers "this once" alone. */
  scope?: AllowanceScope;
  /** Present when "for this conversation" is on offer. See `OpenQuestion.threadId`. */
  threadId?: string;
  requestedAt: string;
  expiresAt: string;
  /** Absent while nobody has answered. False is an answer. */
  granted?: boolean;
  answeredBy?: string;
};

/**
 * The subject out of a pause reply, or undefined if there was not one.
 *
 * Checked rather than cast. It arrives as JSON over HTTP and a card that trusted the shape would
 * render "undefined" into the sentence somebody is being asked to consent to; not knowing what the
 * question is about is a thing to say plainly rather than to paper over.
 */
export function askSubjectOf(value: unknown): AskSubject | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, intent, reason } = value as Record<string, unknown>;
  if (kind !== "browser" && kind !== "file" && kind !== "tool")
    return undefined;
  if (
    !INTENTS.has(intent as AskSubject["intent"]) ||
    !REASONS.has(reason as AskSubject["reason"])
  ) {
    return undefined;
  }
  return value as AskSubject;
}

const INTENTS = new Set<AskSubject["intent"]>([
  "navigate",
  "activate",
  "type",
  "read",
  "read_file",
  "write_file",
  "list_files",
  "upload",
  "call_tool",
  "act",
]);

const REASONS = new Set<AskSubject["reason"]>([
  "policy_ask",
  "guard_floor",
  "repeat",
  "unannotated",
]);

/**
 * The 을/를 that follows a label, decided by the label's last letter.
 *
 * Korean picks the object particle by whether the preceding syllable ends in a consonant, and an
 * element's label is a variable, so the sentence cannot carry it. It is passed in as a parameter
 * instead and the dictionary entry places it: "‘출금 승인’{particle} 누르려 합니다".
 *
 * Anything not ending in Hangul — "Submit", a number, an icon's label — gets the form Korean writing
 * uses when the reading is not known. It is slightly stiff and it is never wrong, which is the right
 * way round for a sentence somebody is being asked to consent to.
 */
function objectParticle(word: string): string {
  const last = [...word].at(-1) ?? "";
  const code = last.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return "을(를)";
  return (code - 0xac00) % 28 === 0 ? "를" : "을";
}

/** One sentence to say, as a dictionary key and the values that go into it. */
type Phrase = { key: string; params: Record<string, string | number> };

/**
 * THE WORDS FOR ONE QUESTION, chosen from the facts and never sent by a server.
 *
 * Exported as keys rather than as finished text so a test can walk every intent and reason the
 * server can emit and check the dictionary has each one — `t()` on a variable is invisible to
 * `i18n-coverage.test.ts`, which is why `approval-subject.test.ts` exists (the arrangement
 * `agent-presets.test.ts` set up for the presets).
 */
export function subjectPhrases(subject: AskSubject): {
  action: Phrase;
  /** Why it stopped, where that is not already obvious from the rule. */
  reason?: Phrase;
} {
  return {
    action: actionPhrase(subject),
    ...(reasonPhrase(subject) ? { reason: reasonPhrase(subject) } : {}),
  };
}

function actionPhrase(subject: AskSubject): Phrase {
  const host = subject.host ?? "";
  const name = subject.element?.name ?? "";
  const named = { name, host, particle: objectParticle(name) };
  switch (subject.intent) {
    case "activate":
      if (name && host) {
        return { key: "It wants to press “{name}” on {host}.", params: named };
      }
      if (name) return { key: "It wants to press “{name}”.", params: named };
      return host
        ? { key: "It wants to press something on {host}.", params: { host } }
        : {
            key: "It wants to press something on the page it has open.",
            params: {},
          };
    case "type":
      if (name && host) {
        return {
          key: "It wants to type into “{name}” on {host}.",
          params: named,
        };
      }
      if (name)
        return { key: "It wants to type into “{name}”.", params: named };
      return host
        ? { key: "It wants to type into a field on {host}.", params: { host } }
        : {
            key: "It wants to type into a field on the page it has open.",
            params: {},
          };
    case "navigate":
      if (host && subject.path) {
        return {
          key: "It wants to open {host}{path}.",
          params: { host, path: subject.path },
        };
      }
      return host
        ? { key: "It wants to open {host}.", params: { host } }
        : { key: "It wants to open a page.", params: {} };
    case "read":
      return host
        ? { key: "It wants to look at {host}.", params: { host } }
        : { key: "It wants to look at the page it has open.", params: {} };
    case "read_file":
      return {
        key: "It wants to read the file {path}.",
        params: { path: subject.file?.path ?? "" },
      };
    case "write_file":
      return {
        key: "It wants to write to the file {path}.",
        params: { path: subject.file?.path ?? "" },
      };
    case "list_files": {
      // The workspace root arrives as ".", which is a path nobody would recognise as their folder.
      const path = subject.file?.path ?? "";
      return path && path !== "."
        ? { key: "It wants to list what is in {path}.", params: { path } }
        : { key: "It wants to list what is in the workspace.", params: {} };
    }
    case "upload": {
      // A workspace file handed to a site: the file is what a person recognises, the host is where
      // it goes.
      const path = subject.file?.path ?? "";
      return host
        ? {
            key: "It wants to upload the file {path} to {host}.",
            params: { path, host },
          }
        : { key: "It wants to upload the file {path}.", params: { path } };
    }
    case "call_tool":
      return {
        key: "It wants to use the “{tool}” tool on {server}.",
        params: {
          tool: subject.tool?.name ?? "",
          server: subject.tool?.server ?? "",
        },
      };
    default:
      return host
        ? { key: "It wants to do something on {host}.", params: { host } }
        : {
            key: "It wants to do something on the page it has open.",
            params: {},
          };
  }
}

function reasonPhrase(subject: AskSubject): Phrase | undefined {
  if (subject.reason === "repeat") {
    return {
      key: "It has just done the same thing {count} times.",
      params: { count: subject.repeatCount ?? 0 },
    };
  }
  if (subject.reason === "unannotated") {
    return {
      key: "The tool declared no risk at all, so it is treated as the most dangerous thing it could be.",
      params: {},
    };
  }
  if (subject.reason !== "guard_floor") return undefined;
  switch (subject.tool?.guard) {
    case "money":
      return {
        key: "The tool is declared as one that moves money.",
        params: {},
      };
    case "external":
      return {
        key: "The tool is declared as one that sends something outward.",
        params: {},
      };
    case "destructive":
      return {
        key: "The tool is declared as one that can destroy something.",
        params: {},
      };
    default:
      return undefined;
  }
}

/**
 * How long is left to answer, in words, or null once there is nothing left to say.
 *
 * A question expires after ten minutes and the card simply vanished when it did — no clock, no
 * sentence, nothing to explain why the buttons a person was about to press were gone
 * (docs/laf/redesign-2026-09.md §5.6(g)-7). Seconds only under a minute, because "1분 남음" sitting
 * there while the last thirty seconds run out is the part that reads as broken.
 *
 * Null for an approval that carries no expiry — an older reply, or a room frame from a server that
 * has not been restarted — rather than a guess at one.
 */
export function timeLeftToAnswer(
  expiresAt: string,
  now: number = Date.now(),
): string | null {
  const at = Date.parse(expiresAt);
  if (!expiresAt || Number.isNaN(at)) return null;
  const left = Math.max(0, at - now);
  if (left === 0) return t("Time is up");
  const seconds = Math.ceil(left / 1000);
  if (seconds < 60) return t("{seconds}s left", { seconds });
  return t("{minutes}m left", { minutes: Math.ceil(seconds / 60) });
}

/**
 * The question, in one sentence, in the language the person reads.
 *
 * One function for every surface that asks — the line-level card, the room's card and the admin
 * list — because the same press has to mean the same thing on all three, and two copies of this
 * would be two descriptions of one grant.
 */
export function describeSubject(subject: AskSubject): string {
  const said = subjectPhrases(subject);
  const action = t(said.action.key, said.action.params);
  if (!said.reason) return action;
  return `${action} ${t(said.reason.key, said.reason.params)}`;
}

/**
 * A pause reply, read once, in one place.
 *
 * Two callers meet this shape — an acting call on the computer and a call to somebody else's server
 * — and until this existed they each unpicked it field by field, in their own file, into their own
 * object. Which meant that adding a field to the reply and forwarding it in one of them left the
 * other silently dropping it, with both sides' tests green: measured, the "always allow" button
 * simply never appeared, because one of the two hops had not been told the scope existed.
 *
 * Null for anything that is not a pause, so a caller can ask this question and the "is it one"
 * question at the same time.
 */
export function pauseFrom(
  body: Record<string, unknown> | null,
): Omit<OpenQuestion, "botId"> | null {
  if (body?.awaitingApproval !== true) return null;
  return {
    approvalId: typeof body.approvalId === "string" ? body.approvalId : "",
    // Undefined where the reply carried no subject or one this build does not recognise. The card
    // then says it is being asked about something it cannot name, which is the honest failure: the
    // alternative is a sentence somebody consents to that describes an action nobody sent.
    subject: askSubjectOf(body.subject),
    rule: typeof body.rule === "string" ? body.rule : null,
    scope: allowanceScopeOf(body.scope),
    // The conversation the question came from, when the server said so. The third button is drawn
    // off this and nothing else: a card that offered "for this conversation" for a question raised
    // from nowhere would be a button the answering route silently ignores.
    ...(typeof body.threadId === "string" && body.threadId
      ? { threadId: body.threadId }
      : {}),
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
  };
}

/** A question one tool call is waiting on, as its own line in the transcript needs to draw it. */
export type OpenQuestion = {
  approvalId: string;
  botId: string;
  /** What it is about, in facts. Undefined when the reply did not carry a subject we understand. */
  subject: AskSubject | undefined;
  rule: string | null;
  /** What answering "always" would cover, or undefined when only this once is on offer. */
  scope?: AllowanceScope | undefined;
  /**
   * The conversation the question came from, when it came from one.
   *
   * Present means "for this conversation" is on offer beside "always". The server decided which
   * thread from the request that raised the question; it is never sent back when the button is
   * pressed, for the same reason the scope is not.
   */
  threadId?: string | undefined;
  /** When the question stops being answerable, so the card can count down. Empty when unknown. */
  expiresAt: string;
};

const open = new Map<string, OpenQuestion>();
const watchers = new Set<() => void>();

/**
 * Say that this tool call is waiting on an answer, so its line can draw the card.
 *
 * Handed over rather than fetched again: the server said all of it in the reply that paused the
 * call, and a card that re-derived its question from a list would be back to guessing which entry
 * in that list was its own.
 */
export function openQuestion(toolCallId: string, question: OpenQuestion): void {
  if (!toolCallId) return;
  open.set(toolCallId, question);
  for (const watcher of watchers) watcher();
}

/** The wait is over, whichever way it went. Nothing should still be offering buttons for it. */
export function closeQuestion(toolCallId: string): void {
  if (!open.delete(toolCallId)) return;
  for (const watcher of watchers) watcher();
}

export function questionOn(toolCallId: string): OpenQuestion | undefined {
  return open.get(toolCallId);
}

/** Everything currently waiting, for a reader that wants the set rather than one entry. */
export function openQuestions(): OpenQuestion[] {
  return [...open.values()];
}

/**
 * Whether anything at all is waiting on an answer.
 *
 * The card itself is a transcript row, so scrolling up past it takes the only sign that a Bot is
 * blocked off the screen — and a Bot that has stopped to ask looks exactly like a Bot that has
 * stopped. The transcript's status slot uses this to keep saying so wherever the reader is.
 */
export function anyQuestionOpen(): boolean {
  return open.size > 0;
}

export function watchQuestions(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

/**
 * The open questions for one Bot, or null if the server could not be asked.
 *
 * Null and an empty list are kept apart on purpose. A caller waiting for its own answer must not read
 * a failed request as "the question is gone", which is what an empty list means here.
 */
export async function readApprovals(
  botId: string,
): Promise<PendingApproval[] | null> {
  try {
    const response = await fetch(`/api/approvals/${botId}`, {
      credentials: "include",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { approvals?: PendingApproval[] };
    return body.approvals ?? [];
  } catch {
    return null;
  }
}

/**
 * What became of an answer.
 *
 * `gone` is the server's 409: the question expired, or somebody answered it in another tab. Nothing
 * is broken and there is nothing to retry, so a card that hears it should come down rather than sit
 * there with an error beside two buttons that will never work again.
 *
 * No prose crosses this boundary. The server's sentences are English, and a component that rendered
 * them would show a Korean reader English no matter what the dictionary said — so this reports what
 * happened and the surface owns the words.
 */
export type ApprovalAnswerResult = { ok: true } | { ok: false; gone: boolean };

export async function answerApproval(
  botId: string,
  approvalId: string,
  granted: boolean,
  /**
   * "And stop asking me about this" — for this conversation, or for good.
   *
   * A tier, not a scope and not a thread. What it covers and which conversation were decided when
   * the question was raised and are held on the server's own record; sending either from here
   * would let a page grant itself something other than what it displayed. Only meaningful
   * alongside `granted: true` — there is no "always deny", because a thing that should never
   * happen belongs in the boundary where everybody can read it.
   */
  tier: ApprovalTier = "once",
): Promise<ApprovalAnswerResult> {
  try {
    const response = await fetch(`/api/approvals/${botId}/${approvalId}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granted, tier }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, gone: response.status === 409 };
  } catch {
    return { ok: false, gone: false };
  }
}

/**
 * Hold a tool call open until somebody answers its question.
 *
 * Polled rather than pushed. The answer arrives on a server this tab has no other channel to, and it
 * may well be given in a different tab or by a different person, so the only honest way to learn it
 * is to keep asking. A second between looks costs one request while a Bot is stopped and nothing at
 * all the rest of the time.
 */
export async function waitForApproval(
  botId: string,
  approvalId: string,
  signal: AbortSignal | undefined,
): Promise<"granted" | "declined" | "gave up" | "cancelled"> {
  const deadline = Date.now() + WAIT_FOR_ANSWER_MS;
  while (Date.now() < deadline) {
    // Stop must work out of this wait as well, or pressing it leaves a Bot parked on a question
    // nobody is going to answer.
    if (signal?.aborted) return "cancelled";
    const approvals = await readApprovals(botId);
    if (approvals) {
      const mine = approvals.find((one) => one.id === approvalId);
      // Gone from a list we did read means it expired and was swept, which is the same outcome as
      // running out of patience here. A list we could NOT read says nothing, so it is not read as an
      // answer.
      if (!mine) return "gave up";
      if (mine.granted === true) return "granted";
      if (mine.granted === false) return "declined";
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return "gave up";
}
