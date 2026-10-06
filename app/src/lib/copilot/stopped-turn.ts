import { t } from "@/lib/i18n";
import { own } from "@/lib/own";

/**
 * A turn that ARRIVED and is still not the whole answer.
 *
 * Not failures — a RUN_ERROR would throw away the half that came — so `agent-bot` says them as
 * CUSTOM events on its own stream, the same channel it reports token counts on. Two things a
 * person cannot otherwise tell apart from an ordinary short answer:
 *
 * - `laf.answer_truncated`: the model hit its length limit mid-sentence. There IS more, and asking
 *   it to carry on works.
 * - `laf.empty_answer`: nothing came back at all, twice — a reasoning model that spent its whole
 *   budget deliberating. Asking again is the right move and nothing about the question was wrong.
 */
export const TURN_NOTICES: Record<string, string> = {
  "laf.answer_truncated":
    "The answer was cut off before it finished. Ask the Bot to carry on.",
  "laf.empty_answer":
    "The Bot thought about it and answered with nothing. Ask again.",
};

/**
 * The sentence for a CUSTOM event the Bot's own stream carries, or null for one this ignores.
 *
 * The conversation's store keeps the event's name off the turn's stream (`lib/turns/frames.ts`,
 * `notice`) and the transcript asks this for the words. The hook that once listened
 * (`useStoppedTurn`) was mounted only by the `/bot` route, and when `4e68b040` deleted that route
 * the two notices reached no screen for three weeks — a half answer read as a whole one
 * (`turn-notice.test.tsx`).
 */
export function turnNotice(name: unknown): string | null {
  const known = typeof name === "string" ? own(TURN_NOTICES, name) : undefined;
  return known ? t(known) : null;
}
