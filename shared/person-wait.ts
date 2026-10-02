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
