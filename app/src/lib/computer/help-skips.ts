/**
 * "건너뛰기" on a request for help, told to the call that is waiting for the answer.
 *
 * The computer has two answers to a request: the wheel comes back (`/control/release`), or a person
 * types the secret in. Neither says "skip this". Handing back is how a skip clears the request on
 * the computer — the next request has to find it clear — but the call waiting on it would read that
 * as "done", and tell the model a login it never got had happened. So the skip is also written here,
 * by the call's id, and the wait reads it first (`computer-tools.tsx`).
 *
 * In this tab, where the waiting call is when the window drives the turn — and on the server too,
 * where it is when the server owns it (`server/src/turns/people.ts`): the skip is sent there before
 * the release that follows it, so the call reads the skip first there as well.
 */
import { skipOnServer } from "@/lib/turns/client";

const skipped = new Set<string>();

export async function skipHelp(
  toolCallId: string,
  botId?: string,
): Promise<void> {
  skipped.add(toolCallId);
  if (botId) await skipOnServer(botId, toolCallId);
}

/** Read once by the waiting call, which forgets it: a skip answers one request. */
export function takeSkip(toolCallId: string | undefined): boolean {
  if (!toolCallId || !skipped.has(toolCallId)) return false;
  skipped.delete(toolCallId);
  return true;
}
