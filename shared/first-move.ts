/**
 * HOW A CALL THE SERVER MADE FOR THE BOT IS TOLD FROM ONE THE BOT MADE: BY A FIELD ON THE MESSAGE
 * THAT CARRIES IT, `lafFirstMove`.
 *
 * A turn's first move (`server/src/turns/first-move.ts`) is a call the server makes before the
 * Bot's model is asked, filed in the thread exactly as a call the Bot made, so that the model reads
 * it as its own and answers from it — an assistant message that asks, with an ordinary call id, and
 * a result that answers. The message that asks says it was the server's, and nothing else does.
 *
 * WHO NEEDS TO KNOW. The conversation draws a weather call's answer as a card (`WeatherCard`). A
 * move made for the wrong place — the person asked about 해운대, and the server fetched where they
 * live — is put right by the Bot asking again, and the first answer must not be left standing in
 * the conversation as a forecast somebody asked for (`row-kinds.ts`; Codex on pull request 62).
 * Without this, those two calls are a Bot that asked about two places, which is drawn as two cards
 * and should be.
 *
 * A FIELD, NOT THE CALL'S ID. The mark was a prefix on the id at first (`first_move_…`): the id is
 * kept wherever the call is, so the fact travelled with no field of its own. But an id is a name,
 * and a fact read out of a name is a second meaning for it — one kept short enough for the
 * providers that refuse an id past 40 characters, and unlike anything a provider's own ids begin
 * with. On the message it rides the way the thread's other facts do (`lafAt`, `lafAgentId`,
 * `server/src/runner/thread-store.ts`): written with the thread, sent to every window, never handed
 * to the model on a later turn.
 */
export type FirstMoveMark = {
  /** Present, and true, only on the assistant message that carries a turn's first move. */
  lafFirstMove?: true;
};

/** Whether a message carries a call the server made as the turn's first move. */
export function isFirstMove(message: object): boolean {
  return (message as FirstMoveMark).lafFirstMove === true;
}
