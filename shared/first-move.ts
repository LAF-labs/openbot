/**
 * HOW A CALL THE SERVER MADE FOR THE BOT IS TOLD FROM ONE THE BOT MADE: BY HOW ITS ID BEGINS.
 *
 * A turn's first move (`server/src/turns/first-move.ts`) is a call the server makes before the
 * Bot's model is asked, filed in the thread exactly as a call the Bot made, so that the model
 * reads it as its own and answers from it. Exactly as, but for the id the server gives the call.
 * An id is the one thing about a call the model never chooses and never reads for meaning, and it
 * is kept wherever the call is kept — the thread, a page of history, another window — so the fact
 * travels with no field of its own.
 *
 * WHO NEEDS TO KNOW. The conversation draws a weather call's answer as a card (`WeatherCard`). A
 * move made for the wrong place — the person asked about 해운대, and the server fetched where they
 * live — is put right by the Bot asking again, and the first answer must not be left standing in
 * the conversation as a forecast somebody asked for (`weatherCardsOf`; Codex on pull request 62).
 * Without this, those two calls are a Bot that asked about two places, which is drawn as two cards
 * and should be.
 *
 * NO LONGER THAN THE ID IT REPLACES — "call_" and 32 hex digits, 37 characters: some model
 * providers refuse a call id past 40 — and nothing a provider's own ids begin with.
 */
export const FIRST_MOVE_CALL_PREFIX = "first_move_";

/** A new first move's id, from a random UUID: the prefix and 26 of its hex digits. */
export function firstMoveCallId(uuid: string): string {
  return `${FIRST_MOVE_CALL_PREFIX}${uuid.replaceAll("-", "").slice(0, 26)}`;
}

/** Whether a call was the server's first move rather than one the Bot made. */
export function isFirstMoveCall(callId: string): boolean {
  return callId.startsWith(FIRST_MOVE_CALL_PREFIX);
}
