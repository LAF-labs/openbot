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
 * which is what makes this the whole fix rather than half of one. A room reaches the same store
 * through `room-turn` with the message's own id.
 */

/** The part of a message these rules read. An AG-UI message has it, and so does a room's. */
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
 * What may sit between the question and the end differs by surface, which is `keepsReplies`:
 *
 *  - In a conversation with one Bot (the default), tool traffic only — an assistant turn that called
 *    tools and said nothing, and the results. That is the run's own continuation, and running again
 *    from it is what every browser action already does. A turn that had started to ANSWER in words
 *    is not retried in place: the provider would be handed a conversation ending in the Bot's own
 *    half-sentence, which OpenAI-compatible endpoints do not all accept.
 *  - In a room, any member's reply. A room turn is composed by the server from the whole transcript
 *    (`readRoomLines`), so a member that answered stays answered and the one that failed speaks.
 */
export function retriesInPlace(
  messages: readonly ThreadMessage[],
  messageId: string,
  { keepsReplies = false }: { keepsReplies?: boolean } = {},
): boolean {
  const at = messages.findIndex((message) => message.id === messageId);
  if (at === -1 || messages[at]?.role !== "user") return false;
  for (const later of messages.slice(at + 1)) {
    // Skill instructions `say` puts in front of the words; they are never the thread moving on.
    if (later.role === "system") continue;
    if (later.role === "user") return false;
    if (keepsReplies || later.role === "tool") continue;
    if (later.role === "assistant" && !hasWords(later.content)) continue;
    return false;
  }
  return true;
}

/** A failed turn as `GET /api/channels/:id/failures` reports it. */
export type StoredFailure = { messageId: string; code: string; at: string };

/**
 * The stored failures that still stand, as the transcript draws them: message id to code.
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
 * the member of a room that did answer while another did not — and the failure stands beside it.
 * A reply with no stamp yet is one that arrived after the stamps were read, which is after every
 * failure that read could know about.
 *
 * A failure under anything else — a routine's heading, the half-answer a stalled turn left — stands:
 * nothing is retried there, so nothing can have superseded it.
 *
 * Nothing is reported until `times` has been read: without the stamps a superseded line cannot be
 * told from a standing one, and a red line that appears and then vanishes is worse than one that
 * arrives a moment late.
 */
export function standingFailures(
  failures: readonly StoredFailure[] | undefined,
  messages: readonly ThreadMessage[],
  times: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const standing: Record<string, string> = {};
  if (!failures?.length || !times) return standing;
  const position = new Map(
    messages.map((message, index) => [message.id, index]),
  );
  for (const failure of failures) {
    const at = position.get(failure.messageId);
    if (at === undefined || messages[at]?.role !== "user") {
      standing[failure.messageId] = failure.code;
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
    if (!superseded) standing[failure.messageId] = failure.code;
  }
  return standing;
}
