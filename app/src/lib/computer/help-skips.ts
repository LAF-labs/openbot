/**
 * "건너뛰기" on a request for help, told to the call that is waiting for the answer.
 *
 * The computer has two answers to a request: the wheel comes back (`/control/release`), or a person
 * types the secret in. Neither says "skip this". Handing back is how a skip clears the request on
 * the computer — the next request has to find it clear — but the call waiting on it would read that
 * as "done", and tell the model a login it never got had happened. So the skip is also written here,
 * by the call's id, and the wait reads it first (`computer-tools.tsx`).
 *
 * In this tab only, which is where the waiting call is. A reload ends the call anyway: its card then
 * shows how it ended and offers nothing to press.
 */
const skipped = new Set<string>();

export function skipHelp(toolCallId: string): void {
  skipped.add(toolCallId);
}

/** Read once by the waiting call, which forgets it: a skip answers one request. */
export function takeSkip(toolCallId: string | undefined): boolean {
  if (!toolCallId || !skipped.has(toolCallId)) return false;
  skipped.delete(toolCallId);
  return true;
}
