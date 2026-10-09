/**
 * HOW LONG A BOT WAITS FOR A PERSON IT ASKED — to take the wheel, or to type a value it must not see.
 *
 * Long enough for somebody to come back, finite so the turn can end.
 *
 * ONE NUMBER, READ IN THREE PLACES THAT MUST AGREE. The two that wait — the turn the server carries
 * out (`server/src/turns/chat-tools.ts`) and a window's own (`app/src/lib/copilot/computer-tools.tsx`)
 * — and the computer, which keeps an ask nobody answered for longer than this, and only a little
 * (`REQUEST_TTL_MS` in `agent-computer/src/control.ts`). It was two copies of ten minutes and the
 * computer kept an ask for ever. Written down once, because of what the two waits read: an ask that
 * is gone, with the Bot holding the wheel, means the person handed it back. An ask the computer
 * dropped at or before this would turn "nobody came" into "they came, and it is done".
 */
export const PERSON_WAIT_MS = 10 * 60_000;

/**
 * What a wait makes of an ask that is gone: answered, or let go of with nobody having come.
 *
 * AN ASK THAT IS GONE IS READ AS ANSWERED, which is why the computer keeps one nobody answered for
 * longer than the wait (above). It also ends one in the MIDDLE of a wait, when the tab the ask was
 * about goes from under the Bot — its renderer died, or its site closed it — because a password
 * typed after that would go into another page (`agent-computer/src/tab-loss.ts`). That ask was not
 * answered either, and the computer's state says so (`unanswered`). The wait reads it here, so the
 * Bot — and the card a person is looking at — is not told that somebody came and did it.
 *
 * AND ONE ENDS BECAUSE SOMEBODY DID COME, AND THEIR VALUES DID NOT ALL GO IN (`unfilled`,
 * 2026-10-10): a box was gone, or called something else, by the time its value arrived. That is
 * neither of the other two. Read as "nobody came" the Bot was told nobody had entered anything —
 * over a page that, since a card holds several boxes, may be holding the first of them.
 */
export function askOutcome(state: {
  unanswered?: unknown;
  unfilled?: unknown;
}): "answered" | "gave up" | "unfilled" {
  if (state.unanswered !== true) return "answered";
  return state.unfilled === true ? "unfilled" : "gave up";
}
