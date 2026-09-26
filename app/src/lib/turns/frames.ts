/**
 * A conversation as a window holds it, and what each frame of a server-owned turn does to it.
 *
 * The server runs the turn (`server/src/turns/engine.ts`) and sends every window the same numbered
 * frames (`server/src/turns/hub.ts`). This folds them into the messages the transcript draws. It is
 * deliberately NOT AG-UI's own client: that one checks the order of a run's events as they arrive,
 * and a window that joins a turn halfway — or rejoins after its laptop slept — is by definition
 * handed the middle of one. So every step here is idempotent and keyed by id: a message it already
 * holds is replaced or grown, one it does not is added, and the server's own copies (`messages` and
 * `snapshot` frames) put right anything pieced together from deltas.
 *
 * Pure, and new objects for anything that changed: the transcript is compiled, and a compiled
 * component keeps what it drew while its inputs are the same objects.
 */
import type { Message } from "@ag-ui/core";

export type TurnStatus = "queued" | "running" | "done" | "error" | "stopped";

export type TurnState = {
  id: string;
  status: TurnStatus;
  asked: string[];
  code?: string;
};

type Event = { type: string } & Record<string, unknown>;

export type TurnFrame =
  | { seq: number; kind: "turn"; turn: TurnState }
  | { seq: number; kind: "event"; turn: string; event: Event }
  | { seq: number; kind: "messages"; turn: string; messages: Message[] }
  | { seq: number; kind: "waiting"; turn: string; toolCallIds: string[] }
  | {
      seq: number;
      kind: "snapshot";
      epoch: string;
      turn: TurnState | null;
      messages: Message[];
      waiting: string[];
    };

export type ThreadState = {
  messages: readonly Message[];
  turn: TurnState | null;
  /** Cards the turn is waiting on a person to answer. */
  waiting: readonly string[];
  /** Which process the cursor below belongs to. */
  epoch: string | null;
  /** The last frame applied: where a window that reconnects asks to be taken from. */
  seq: number;
  /** What ended the turn in flight, as the Bot's stream said it, when it failed. */
  failure: string | null;
  /** A turn that arrived and is still not the whole answer (`laf.answer_truncated`, …). */
  notice: string | null;
};

export const EMPTY_THREAD: ThreadState = {
  messages: [],
  turn: null,
  waiting: [],
  epoch: null,
  seq: 0,
  failure: null,
  notice: null,
};

/** Whether a turn in this state still has the Bot. */
export function isTurnGoing(turn: TurnState | null): boolean {
  return turn?.status === "queued" || turn?.status === "running";
}

/** The index of a message by id, looked for from the end, where a turn's messages are. */
function indexOf(messages: readonly Message[], id: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.id === id) return index;
  }
  return -1;
}

/** These messages over those: the same id is replaced where it stands, a new one goes last. */
export function mergeMessages(
  held: readonly Message[],
  incoming: readonly Message[],
): readonly Message[] {
  if (incoming.length === 0) return held;
  const next = [...held];
  for (const message of incoming) {
    const at = indexOf(next, message.id);
    if (at === -1) next.push(message);
    else next[at] = message;
  }
  return next;
}

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function withMessage(
  messages: readonly Message[],
  at: number,
  message: Message,
): readonly Message[] {
  const next = [...messages];
  next[at] = message;
  return next;
}

function applyEvent(
  messages: readonly Message[],
  event: Event,
): readonly Message[] {
  switch (event.type) {
    case "TEXT_MESSAGE_START": {
      const id = String(event.messageId ?? "");
      if (!id || indexOf(messages, id) !== -1) return messages;
      const role = event.role === "user" ? "user" : "assistant";
      return [...messages, { id, role, content: "" } as Message];
    }
    case "TEXT_MESSAGE_CONTENT":
    case "TEXT_MESSAGE_CHUNK": {
      const id = String(event.messageId ?? "");
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!id || !delta) return messages;
      const at = indexOf(messages, id);
      if (at === -1) {
        return [
          ...messages,
          { id, role: "assistant", content: delta } as Message,
        ];
      }
      const held = messages[at] as Message & { content?: unknown };
      const content = typeof held.content === "string" ? held.content : "";
      return withMessage(messages, at, {
        ...held,
        content: content + delta,
      } as Message);
    }
    case "TOOL_CALL_START": {
      const toolCallId = String(event.toolCallId ?? "");
      if (!toolCallId) return messages;
      const call: ToolCall = {
        id: toolCallId,
        type: "function",
        function: { name: String(event.toolCallName ?? ""), arguments: "" },
      };
      const parent =
        typeof event.parentMessageId === "string" ? event.parentMessageId : "";
      const at = parent ? indexOf(messages, parent) : -1;
      if (at === -1) {
        return [
          ...messages,
          {
            id: parent || toolCallId,
            role: "assistant",
            content: "",
            toolCalls: [call],
          } as Message,
        ];
      }
      const held = messages[at] as Message & { toolCalls?: ToolCall[] };
      if ((held.toolCalls ?? []).some((known) => known.id === toolCallId)) {
        return messages;
      }
      return withMessage(messages, at, {
        ...held,
        toolCalls: [...(held.toolCalls ?? []), call],
      } as Message);
    }
    case "TOOL_CALL_ARGS": {
      const toolCallId = String(event.toolCallId ?? "");
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!toolCallId || !delta) return messages;
      for (let at = messages.length - 1; at >= 0; at -= 1) {
        const held = messages[at] as Message & { toolCalls?: ToolCall[] };
        const calls = held.toolCalls ?? [];
        const which = calls.findIndex((known) => known.id === toolCallId);
        if (which === -1) continue;
        const next = [...calls];
        const known = next[which] as ToolCall;
        next[which] = {
          ...known,
          function: {
            ...known.function,
            arguments: known.function.arguments + delta,
          },
        };
        return withMessage(messages, at, {
          ...held,
          toolCalls: next,
        } as Message);
      }
      return messages;
    }
    case "TOOL_CALL_RESULT": {
      const id = String(event.messageId ?? "");
      const toolCallId = String(event.toolCallId ?? "");
      if (!id || !toolCallId) return messages;
      const result = {
        id,
        role: "tool",
        toolCallId,
        content: typeof event.content === "string" ? event.content : "",
      } as Message;
      const at = indexOf(messages, id);
      if (at !== -1) return withMessage(messages, at, result);
      // A result already filed for the call under another id is the same answer; keep the first.
      const answered = messages.some(
        (message) =>
          message.role === "tool" &&
          (message as { toolCallId?: string }).toolCallId === toolCallId,
      );
      return answered ? messages : [...messages, result];
    }
    case "MESSAGES_SNAPSHOT":
      return Array.isArray(event.messages)
        ? mergeMessages(messages, event.messages as Message[])
        : messages;
    default:
      return messages;
  }
}

/** One frame, applied. Frames older than what was already applied are ignored. */
export function applyFrame(state: ThreadState, frame: TurnFrame): ThreadState {
  if (frame.kind === "snapshot") {
    return {
      ...state,
      epoch: frame.epoch,
      seq: frame.seq,
      turn: frame.turn,
      waiting: frame.waiting,
      messages: mergeMessages(state.messages, frame.messages),
      ...(frame.turn?.id !== state.turn?.id
        ? { failure: null, notice: null }
        : {}),
    };
  }
  if (frame.seq <= state.seq) return state;
  const next = { ...state, seq: frame.seq };
  switch (frame.kind) {
    case "turn":
      return {
        ...next,
        turn: frame.turn,
        ...(frame.turn.id !== state.turn?.id
          ? { failure: null, notice: null, waiting: [] }
          : {}),
        ...(isTurnGoing(frame.turn) ? {} : { waiting: [] }),
      };
    case "waiting":
      return { ...next, waiting: frame.toolCallIds };
    case "messages":
      return {
        ...next,
        messages: mergeMessages(state.messages, frame.messages),
      };
    case "event": {
      const { event } = frame;
      if (event.type === "RUN_ERROR") {
        return {
          ...next,
          failure: typeof event.message === "string" ? event.message : "",
        };
      }
      if (event.type === "CUSTOM") {
        const name = typeof event.name === "string" ? event.name : null;
        // The same stream carries the run's cost and its retries, which are nothing to a person.
        return name && name !== "laf.model.usage" && name !== "laf.retry"
          ? { ...next, notice: name }
          : next;
      }
      const messages = applyEvent(state.messages, event);
      return messages === state.messages ? next : { ...next, messages };
    }
    default:
      return next;
  }
}
