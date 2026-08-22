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
 */

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

export type PendingApproval = {
  id: string;
  botId: string;
  /** The expression that asked, shown as a rule so a person can see which boundary they are at. */
  rule: string;
  /** What is about to happen, in one sentence. */
  question: string;
  /** Absent when nothing durable could be derived; the card then offers "this once" alone. */
  scope?: AllowanceScope;
  requestedAt: string;
  expiresAt: string;
  /** Absent while nobody has answered. False is an answer. */
  granted?: boolean;
  answeredBy?: string;
};

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
    // The error is the question in different clothes — the pause error's message IS the question —
    // so a reply that carried only one of them still names what is being asked about.
    question:
      typeof body.question === "string" && body.question
        ? body.question
        : typeof body.error === "string"
          ? body.error
          : "",
    rule: typeof body.rule === "string" ? body.rule : null,
    scope: allowanceScopeOf(body.scope),
  };
}

/** A question one tool call is waiting on, as its own line in the transcript needs to draw it. */
export type OpenQuestion = {
  approvalId: string;
  botId: string;
  question: string;
  rule: string | null;
  /** What answering "always" would cover, or undefined when only this once is on offer. */
  scope?: AllowanceScope | undefined;
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
   * "And stop asking me about this."
   *
   * A flag, not a scope. What it covers was decided when the question was raised and is held on the
   * server's own record; sending the scope from here would let a page grant itself something other
   * than what it displayed. Only meaningful alongside `granted: true` — there is no "always deny",
   * because a thing that should never happen belongs in the boundary where everybody can read it.
   */
  always = false,
): Promise<ApprovalAnswerResult> {
  try {
    const response = await fetch(`/api/approvals/${botId}/${approvalId}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granted, always }),
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
