/**
 * The last failed turn this tab drew, remembered for the 문의·의견 box.
 *
 * The box offers to send "what is on screen", and the one fact about a screen worth an operator's
 * time is the failure it last showed — the same code the red line under the message was drawn
 * from (`channels/turn-failure.ts`), so the operator reads the code and the person never has to
 * describe a sentence they did not understand.
 *
 * MODULE STATE, ON PURPOSE. One tab, one last failure; a reload forgets it, and a box opened on a
 * fresh tab attaches nothing — which is honest, because that tab has drawn nothing. A store or a
 * query would outlive the screen it describes.
 */
export type RememberedFailure = {
  code: string;
  at: string;
};

let last: RememberedFailure | null = null;

/** Called by the line that draws a failure, once per code it draws. */
export function noteTurnFailure(code: string): void {
  last = { code, at: new Date().toISOString() };
}

export function lastTurnFailure(): RememberedFailure | null {
  return last;
}

/** For tests, which share one module registry. */
export function forgetTurnFailures(): void {
  last = null;
}
