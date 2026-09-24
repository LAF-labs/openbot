/**
 * What 다시 시도 under a failed question does to the thread, and which stored failures still stand.
 *
 * MEASURED 2026-09-10 (audit A4, finding 1): the button sent the words again as a NEW message. The
 * failed one was already stored — the server writes a person's side the moment a run begins, so a
 * crash mid-turn keeps it — and so the thread held "지금 몇 시야" twice: on screen, in
 * `laf_thread_messages`, in the export, and in every prompt the model read from then on.
 *
 * A retry is the same question asked again, so it is the thread run again with that question where
 * it already is, under the id the store already holds. `appendMessages` (server, runner/
 * thread-store.ts) treats a message id it holds as an edit of that row and never as a second one,
 * which is what makes this the whole fix rather than half of one.
 */
import type { FailureGroup } from "./turn-failure";

/** The part of a message these rules read. An AG-UI message has it. */
export type ThreadMessage = {
  id: string;
  role: string;
  content?: unknown;
};

/** Words in a message's content, as opposed to an empty assistant turn that only called tools. */
function hasWords(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const text = (part as { text?: unknown } | null)?.text;
    return typeof text === "string" && text.trim().length > 0;
  });
}

/**
 * Can this question be asked again in place, so that nothing is said twice?
 *
 * ONLY WHILE NOBODY HAS ASKED ANYTHING SINCE. Run again, a thread answers what is at its end; a
 * question with a later question under it would not be the one answered, and the only other way to
 * ask it — sending the words again — is exactly the duplicate this exists to stop. So there is no
 * button there at all: the line still says the question went unanswered, which stays true.
 *
 * What may sit between the question and the end is tool traffic only — an assistant turn that
 * called tools and said nothing, and the results. That is the run's own continuation, and running
 * again from it is what every browser action already does. A turn that had started to ANSWER in
 * words is not retried in place: the provider would be handed a conversation ending in the Bot's
 * own half-sentence, which OpenAI-compatible endpoints do not all accept. (A room took any
 * member's reply here too, until rooms were removed on 2026-09-24.)
 */
export function retriesInPlace(
  messages: readonly ThreadMessage[],
  messageId: string,
): boolean {
  const at = messages.findIndex((message) => message.id === messageId);
  if (at === -1 || messages[at]?.role !== "user") return false;
  for (const later of messages.slice(at + 1)) {
    // Skill instructions `say` puts in front of the words; they are never the thread moving on.
    if (later.role === "system") continue;
    if (later.role === "user") return false;
    if (later.role === "tool") continue;
    if (later.role === "assistant" && !hasWords(later.content)) continue;
    return false;
  }
  return true;
}

/**
 * How a question can be asked again, if it can: in place (`retriesInPlace`), or by saying its
 * words again as a new message — or not at all.
 *
 * SAYING IT AGAIN IS THE HONEST RETRY ONCE THE BOT HAS SPOKEN. MEASURED 2026-09-24 (UI/UX audit,
 * item 5): agent-bot stopped two seconds into a reply, and "가게 마감" sat above "봇이 답하지
 * 않았습니다" with nothing to press — the button was drawn only under the person's own words, and
 * with half an answer in between the failure is under the Bot's. Running in place is still refused
 * there, for the reason above. But the thread already holds the half answer, and the person asking
 * again after it is what happened — so it is sent as what it is, a new message, and the store keeps
 * both: the question, what the Bot got out, and the question again.
 *
 * Only for the last question: under one somebody has asked past, the thread has moved on, and the
 * answer would land under the wrong question.
 */
export type RetryWay = "in-place" | "ask-again";

export function retryWay(
  messages: readonly ThreadMessage[],
  messageId: string,
): RetryWay | null {
  if (retriesInPlace(messages, messageId)) return "in-place";
  const at = messages.findIndex((message) => message.id === messageId);
  if (at === -1 || messages[at]?.role !== "user") return null;
  const askedSince = messages
    .slice(at + 1)
    .some((later) => later.role === "user");
  return askedSince ? null : "ask-again";
}

/** A failed turn as `GET /api/channels/:id/failures` reports it. */
export type StoredFailure = {
  messageId: string;
  code: string;
  at: string;
  /** The person's message the run was answering, when the failure is under the Bot's half answer. */
  askedId?: string;
  group?: FailureGroup;
};

/**
 * What the transcript draws under one message: the code, and the group it stands for, if any.
 *
 * `askedId` marks a failure under the Bot's half answer, which is drawn faded with "여기까지
 * 받았어요", and `askedAgain` one the person has since asked past — the half answer keeps its mark,
 * and the red line goes, because the question has been asked again below it.
 */
export type StandingFailure = {
  code: string;
  group?: FailureGroup;
  askedId?: string;
  askedAgain?: boolean;
};

/**
 * The stored failures that still stand, as the transcript draws them: message id to failure.
 *
 * A RETRY IN PLACE LEAVES THE FIRST FAILURE ON THE SERVER'S RECORD. The ledger keys a failure to the
 * last message its run wrote, the question keeps the run id it was first written under, and the
 * re-run that answered it wrote nothing new about that question — so the failures route reports the
 * first failure for as long as the thread exists, and drawing it would put "no answer came back"
 * directly above the answer.
 *
 * So a failure under a QUESTION is superseded by a reply to that question the server stamped after
 * the failure — anything but the person's own words and system rows, between the question and the
 * next thing the person asked. A reply stamped before it is one the failed turn itself produced —
 * — and the failure stands beside it.
 * A reply with no stamp yet is one that arrived after the stamps were read, which is after every
 * failure that read could know about.
 *
 * A failure under a routine's heading stands: nothing is retried there, so nothing can have
 * superseded it. One under the half answer a turn left stands until the person asks again after it
 * (`askedAgain`), which is how 다시 시도 retries it (`retryWay`).
 *
 * Nothing is reported until `times` has been read: without the stamps a superseded line cannot be
 * told from a standing one, and a red line that appears and then vanishes is worse than one that
 * arrives a moment late.
 */
export function standingFailures(
  failures: readonly StoredFailure[] | undefined,
  messages: readonly ThreadMessage[],
  times: Readonly<Record<string, string>> | undefined,
): Record<string, StandingFailure> {
  const standing: Record<string, StandingFailure> = {};
  if (!failures?.length || !times) return standing;
  const position = new Map(
    messages.map((message, index) => [message.id, index]),
  );
  const drawn = (failure: StoredFailure): StandingFailure => ({
    code: failure.code,
    ...(failure.group ? { group: failure.group } : {}),
    ...(failure.askedId ? { askedId: failure.askedId } : {}),
  });
  for (const failure of failures) {
    const at = position.get(failure.messageId);
    if (at === undefined || messages[at]?.role !== "user") {
      /*
       * Under the Bot's half answer: superseded by the person asking again after it — which is
       * what 다시 시도 there does — and never by anything else, since nothing else answers it.
       */
      const askedAgain =
        failure.askedId !== undefined &&
        at !== undefined &&
        messages.slice(at + 1).some((later) => later.role === "user");
      standing[failure.messageId] = askedAgain
        ? { ...drawn(failure), askedAgain: true }
        : drawn(failure);
      continue;
    }
    const failedAt = Date.parse(failure.at);
    let superseded = false;
    for (const later of messages.slice(at + 1)) {
      if (later.role === "user") break;
      if (later.role === "system") continue;
      const stamped = times[later.id];
      if (stamped === undefined || Date.parse(stamped) > failedAt) {
        superseded = true;
        break;
      }
    }
    if (!superseded) standing[failure.messageId] = drawn(failure);
  }
  return standing;
}
