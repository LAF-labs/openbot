/**
 * WHOSE LOOK AT THE PAGE A CALL IS: the Bot's own, or a person's.
 *
 * Three calls look at the Bot's page — a read, a snapshot, and opening an address — and they are
 * made for two different readers. A turn or a routine makes them for the Bot's model, which reads
 * the answer. The app makes the same calls for a person: 다 했어요 on a site hand-off reads the page
 * to see whether they are signed in, and the hand-off opens the site's own page for them.
 *
 * The Bot's computer has to tell the two apart, because a look is what lets the Bot act again after
 * the tab it was on went from under it (`agent-computer/src/tab-loss.ts`). Until 2026-10-05 it could
 * not: a person pressing 다 했어요 counted as the Bot having seen its tab, the fact that the tab was
 * gone rode out on an answer nobody read, and the Bot's next key press — judged for the sign-in
 * window that had closed — landed on the page behind it.
 *
 * SAID BY THE SERVER, NEVER BY A BROWSER. The server's client writes this header on each of the
 * three calls, from which code is asking and from nothing a request carried: a look is the Bot's
 * only where the Bot's own loop said so (`server/src/turns/chat-tools.ts`,
 * `server/src/runner/unattended.ts`), and every other caller's is a person's.
 *
 * A call with no header at all is the Bot's, as every look was before there was one: a server one
 * version older says nothing, and its Bot must not be left unable to act for the length of a
 * rollout.
 */
export const LOOK_HEADER = "x-openbot-look";

/** A turn's or a routine's look: the Bot's model reads the answer. */
export const BOTS_LOOK = "bot";

/** Anybody else's: the answer is for a screen, and the Bot has seen nothing. */
export const PERSONS_LOOK = "person";
