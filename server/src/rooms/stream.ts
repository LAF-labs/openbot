/**
 * Watching a member think, so the room can show it typing.
 *
 * The only file that touches AG-UI's event stream, and it is deliberately small: a room turn runs
 * on the server, so without this a person watches nothing at all for the minute a Bot takes and
 * then sees a finished paragraph appear.
 *
 * TWO MEASURED FACTS ABOUT `@ag-ui/client` 0.0.57 HOLD THIS UP, and both would fail silently if
 * they changed, so `server/tests/room-partial-args.test.ts` pins them:
 *
 * 1. `partialToolCallArgs` is typed `Record<string, any>` and IS NOT ONE. The implementation
 *    computes it as `untruncate-json(buffer)`, and that package returns a STRING: measured,
 *    `untruncate('{"text":"hello wor')` is the string `'{"text":"hello wor"}'`. Indexing it as an
 *    object — which the published type invites — yields `undefined` and the typing indicator
 *    simply never appears, with nothing anywhere saying why.
 *
 * 2. BOTH `toolCallBuffer` and `partialToolCallArgs` are the buffer BEFORE the current delta: the
 *    client computes them, calls the subscriber, and only then appends (`arguments += delta`).
 *    Measured in the dist, not read from the type. So the indicator trails the model by exactly one
 *    fragment, and the final fragment reaches us only through `onToolCallEndEvent`'s complete
 *    `toolCallArgs` — which is why `close` is NOT where the bubble comes off the screen. The
 *    settled message, carrying the final text, is what replaces it.
 *
 * EVERY SUBSCRIBER HERE IS SYNCHRONOUS. `@ag-ui/client` dispatches subscribers through `concatMap`
 * and awaits each in order, so an `await` in here back-pressures the Bot's own stream — the model
 * would be made to wait on our socket write.
 */
import type { AgentSubscriber } from "@ag-ui/client";
import { SEND_MESSAGE } from "./send-message";

/** What the room is told while a member is still speaking. */
export type RoomStreamWatcher = {
  /** A message is opening: the author is known, the text so far may be empty. */
  open: (toolCallId: string) => void;
  /** The whole text so far, never an increment — a dropped frame heals on the next one. */
  text: (toolCallId: string, text: string) => void;
  /**
   * The member stopped writing this message. NOT the moment it is delivered — the tool has not
   * run yet when this fires — so a caller must not take the bubble down here. See service.ts.
   */
  close: (toolCallId: string) => void;
};

/**
 * The text of a `send_message` call as it is being written.
 *
 * Whole-value, not incremental, on purpose: the browser needs no reassembly, a frame that never
 * arrives costs nothing, and a reconnecting tab is correct as soon as the next delta lands.
 */
export function textOfPartialArgs(partial: unknown): string | null {
  if (typeof partial !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(partial);
    const text = (parsed as { text?: unknown } | null)?.text;
    return typeof text === "string" ? text : null;
  } catch {
    // Untruncated JSON that still will not parse is a fragment too early to read. The next delta
    // carries the whole value again, so there is nothing to recover and nothing to report.
    return null;
  }
}

/**
 * An AG-UI subscriber that reports a member's `send_message` as it is written.
 *
 * Only `send_message` — a member's other tool calls are its private working, and relaying those
 * would put "reading the supplier's page…" in front of everybody in the room.
 */
export function watchRoomSpeech(watcher: RoomStreamWatcher): AgentSubscriber {
  const speaking = new Set<string>();

  return {
    onToolCallStartEvent: ({ event }) => {
      const { toolCallId, toolCallName } = event as {
        toolCallId?: string;
        toolCallName?: string;
      };
      if (!toolCallId || toolCallName !== SEND_MESSAGE) return;
      speaking.add(toolCallId);
      watcher.open(toolCallId);
    },
    onToolCallArgsEvent: ({ event, partialToolCallArgs }) => {
      const { toolCallId } = event as { toolCallId?: string };
      if (!toolCallId || !speaking.has(toolCallId)) return;
      /*
       * One fragment behind the model (fact #2), and left that way on purpose. Closing the live
       * buffer ourselves would mean importing untruncate-json, which is @ag-ui/client's dependency
       * and not ours; a typing indicator one fragment late is invisible, and the complete text
       * arrives through the END event below regardless.
       */
      const text = textOfPartialArgs(partialToolCallArgs);
      if (text !== null) watcher.text(toolCallId, text);
    },
    onToolCallEndEvent: ({ event, toolCallArgs }) => {
      const { toolCallId } = event as { toolCallId?: string };
      if (!toolCallId || !speaking.has(toolCallId)) return;
      // The authoritative value: the client has parsed the complete buffer by now.
      const text = (toolCallArgs as { text?: unknown } | undefined)?.text;
      if (typeof text === "string") watcher.text(toolCallId, text);
      speaking.delete(toolCallId);
      watcher.close(toolCallId);
    },
  };
}
