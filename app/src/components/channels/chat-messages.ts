import type { Message, ToolCall } from "@ag-ui/core";

/**
 * Transcript projection that pairs assistant tool calls with later tool-result messages.
 */

/**
 * Who said a message in a room, as the transcript needs it: a name to write and a face to draw.
 *
 * Both resolved by the caller from the roster, because only the caller knows about the Bots that
 * 숨기기 took out of the list and are still talking in rooms they were already in.
 */
export type ChatSpeaker = {
  name: string;
  /** What `BotAvatar` draws. Absent for a Bot whose profile the roster could not answer for. */
  avatarSeed?: string;
};

export type VisibleChatItem =
  | {
      kind: "text";
      id: string;
      role: "user" | "assistant";
      text: string;
      /** ISO-8601, when this message was first seen. Absent for anything said before stamping. */
      at?: string;
      /**
       * The name to draw above it, in a room where more than one Bot can answer. Assistant
       * messages only, and absent whenever the room has one Bot or the record does not say who
       * spoke — a name guessed would be one colleague's words under another's.
       */
      speaker?: string;
      /**
       * That speaker's face, flattened out of `speaker` rather than nested with it.
       *
       * TWO PRIMITIVES AND NOT ONE OBJECT, on purpose. `TranscriptMessage` is memoised on
       * primitives because a streamed answer rebuilds every item on every chunk, and `continues()`
       * decides whether two bubbles are one turn by comparing speakers with `===`. An object here
       * would be a new one per render: the memo would miss on every message and every reply in a
       * room would start its own turn.
       */
      speakerSeed?: string;
    }
  | {
      kind: "tool";
      id: string;
      toolCall: ToolCall;
      /** The result, once there is one. Absent means the call is still in flight. */
      result?: string;
    };

/** A tool result, as it arrives, its own message, pointing back at the call it answers. */
type ToolResultMessage = { role: "tool"; toolCallId: string; content?: string };

function isToolResult(
  message: Readonly<Message>,
): message is Readonly<Message> & ToolResultMessage {
  return message.role === "tool" && "toolCallId" in message;
}

export function toVisibleChatItems(
  messages: ReadonlyArray<Readonly<Message>>,
  /**
   * Message id to ISO-8601. Only text items carry a time: a tool call is an action inside a turn,
   * not something said, and a separator drawn above one would split a turn in half.
   */
  times: Readonly<Record<string, string>> = {},
  /**
   * Message id to the Bot that said it, already resolved by the caller. Empty in a room with one
   * Bot, where the header already says whose room it is.
   */
  speakers: Readonly<Record<string, ChatSpeaker>> = {},
): VisibleChatItem[] {
  // Gather results first so calls render with their current completion state in the same pass.
  const results = new Map<string, string | undefined>();
  for (const message of messages) {
    if (isToolResult(message)) results.set(message.toolCallId, message.content);
  }

  return messages.flatMap((message): VisibleChatItem[] => {
    if (message.role === "assistant") {
      const items: VisibleChatItem[] = [];
      if (message.content) {
        const said = speakers[message.id];
        items.push({
          kind: "text",
          id: message.id,
          role: "assistant",
          text: message.content,
          ...(times[message.id] ? { at: times[message.id] } : {}),
          ...(said ? { speaker: said.name } : {}),
          ...(said?.avatarSeed ? { speakerSeed: said.avatarSeed } : {}),
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        // A call streams in pieces: the id arrives before the function, the function before its
        // arguments. An entry that has no function yet is a call still being spoken, not a call —
        // rendering it would mean reading fields that are not there, and one interrupted run in a
        // thread's replay would crash the whole transcript for good. It appears on the render after
        // the stream completes it; an entry a dead run left permanently half-built never does,
        // which is the right way to remember a sentence nobody finished.
        if (!toolCall.function?.name) continue;
        items.push({
          kind: "tool",
          // One assistant message can carry multiple tool calls.
          id: toolCall.id,
          toolCall,
          ...(results.has(toolCall.id)
            ? { result: results.get(toolCall.id) }
            : {}),
        });
      }
      return items;
    }

    if (message.role !== "user") return [];

    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");

    return text
      ? [
          {
            kind: "text",
            id: message.id,
            role: "user",
            text,
            ...(times[message.id] ? { at: times[message.id] } : {}),
          },
        ]
      : [];
  });
}

/**
 * Where the turn still being written begins: just after the person's last message while a turn is
 * running, and past the end of the list when none is.
 *
 * Everything from here on can still change under the reader — a reply mid-stream, a second reply
 * after a tool line — so it is not yet an answer anybody can say they liked or did not. Counted from
 * the person's own message rather than from the last reply, because a turn can answer in several
 * bubbles and the first of them is no more finished than the last until the turn is over.
 */
export function unsettledFrom(
  items: readonly VisibleChatItem[],
  busy: boolean,
): number {
  if (!busy) return items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "text" && item.role === "user") return index + 1;
  }
  return 0;
}
