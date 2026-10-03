import { useEffect, useState } from "react";

/**
 * WHETHER THE LAST ROW OF THE CONVERSATION IS BEING WRITTEN RIGHT NOW.
 *
 * "The turn is running and this is the last row" is not it. The turn runs from the moment the
 * person sends, and their message joins the rows only after the wait for the runtime and for the
 * conversation's history (`deliver` in `channel-chat.tsx` — a second and a half just after a
 * conversation is opened). For that long the last row is still the answer BEFORE, finished long
 * ago, and whatever waits for a row to be finished was taken from under it: the source line under
 * a weather answer went with the send and came back with the message (Codex on #50).
 *
 * So the last row there was while nothing was running is remembered. A row that once stood
 * finished is never the one being written.
 *
 * A turn found already running, with nothing remembered, takes its last row as being written:
 * waiting a moment for a line is the smaller wrong.
 */
export function useLastRowIsBeingWritten(
  lastRowId: string | null,
  busy: boolean,
): boolean {
  const [restedOn, setRestedOn] = useState<string | null>(null);
  useEffect(() => {
    if (!busy) setRestedOn(lastRowId);
  }, [busy, lastRowId]);
  return busy && lastRowId !== null && lastRowId !== restedOn;
}
