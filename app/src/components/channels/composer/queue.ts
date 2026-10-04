import type { AttachmentPart } from "@shared/attachments";

/**
 * What happens to a message typed while the Bot already has the turn.
 *
 * The composer used to refuse it. Enter did nothing, the words stayed in the box, and a person
 * watching their coworker head off in the wrong direction had two options: stop the turn and start
 * again, losing whatever it had already done, or wait for it to finish being wrong. Neither is the
 * thing they wanted, which was to say "no, the other one" while it was working and have that land.
 *
 * So a message typed mid-turn is parked rather than dropped, and everything parked goes in ONE
 * follow-up turn when the current one settles. One turn and not one per message, because three
 * quick corrections are usually one correction typed in three breaths: replaying them separately
 * makes the Bot answer the first, act on it, and only then read the sentence saying not to. They go
 * as the separate messages they were typed as, in the order they were typed, under the ids they
 * were kept with — a send that may be repeated has to be the same message each time.
 *
 * Settling is not the same as succeeding. What is parked goes on the turn ENDING and never asks how
 * it ended, which is what makes Stop a way of steering rather than a way of giving up: park a
 * correction, press Stop, and the correction is what runs next. Nothing special-cases the stop
 * button, and that is the point — a path with its own branch is a path that can be forgotten.
 *
 * WHERE IT IS KEPT: the outbox (`outbox.ts`, `waiting`), on the device, by `ServerChannelChat`,
 * which hands `ConversationView` the list to draw. The turn goes on with the laptop closed, which
 * is the point of it, so what is parked has to outlive a reload too. Until 2026-10-05 this file
 * also held a queue that was React state in one mount (`reduceQueue`), for the screen whose window
 * drove the turn: there the turn died with the window and its queue could die with it. That screen
 * was removed, and the queue with it; `queued-message-kept.test.tsx` holds the rules above.
 */

/** A message waiting for the Bot to finish, as it is drawn: the words and the files with them. */
export type ParkedMessage = {
  /** What taking one back is done by: two identical corrections are two entries. */
  id: string;
  text: string;
  /** Files parked with the words, sent with them. */
  attachments?: AttachmentPart[];
};
