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
import { own } from "@/lib/own";

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
  /**
   * WHAT THE STREAM HAS SAID OF SOMETHING HELD FURTHER THAN THAT — a message's words
   * (`text:<id>`), a call's arguments (`args:<id>`) — until it has said more.
   *
   * A page can bring a message before the stream does. The record holds part of an answer while
   * it is being written — the engine writes the turn's messages on a queue, and the next message
   * may have begun by the time a write runs — and the whole of it once the turn is over, and a
   * window whose stream is behind reads either. The stream then says the message from its first
   * piece. Each piece was added to what the page had brought, and the answer read twice over until
   * the step's own copy put it right; begun again from nothing instead, an answer that was whole
   * on the screen shrank to its first piece and grew back (model check, 2026-10-03).
   *
   * So what is held stands for as long as what the stream has said is the start of it, and the
   * stream's is the message from the piece that says more — or says otherwise.
   */
  behind: Readonly<Record<string, string>>;
};

export const EMPTY_THREAD: ThreadState = {
  messages: [],
  turn: null,
  waiting: [],
  epoch: null,
  seq: 0,
  failure: null,
  notice: null,
  behind: {},
};

/** Whether a turn in this state is still going: accepted, and not ended. */
export function isTurnGoing(turn: TurnState | null): boolean {
  return turn?.status === "queued" || turn?.status === "running";
}

/**
 * Whether the turn is waiting for the Bot instead of driving it: the Bot is finishing something
 * else first — a routine, most often — and the turn runs when it is free.
 *
 * A STATE OF ITS OWN, NOT A KIND OF RUNNING. `isTurnGoing` was the only thing that read the word,
 * so a queued turn was drawn as a Bot that has the turn and has not spoken yet: "생각 중" for as
 * long as the routine took (review, 2026-10-02).
 *
 * At any point in a turn, and more than once: the engine announces it on accepting the turn, and
 * again whenever the turn takes the Bot back after waiting on a person. Most of those last a few
 * milliseconds — the Bot was free — so whoever says it to a person waits first (`useLasting`).
 */
export function isTurnQueued(turn: TurnState | null): boolean {
  return turn?.status === "queued";
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

/**
 * THE TURN'S MESSAGES AS THE STREAM SENDS THEM WHOLE — a snapshot, or the server's own copies at
 * the end of a step — over what is held.
 *
 * They are the turn from its first row, in order, every time. So what they hold says where each
 * row belongs: one that is held is replaced where it stands; one that is not, and comes after the
 * last row both hold, is new and goes last; one between two rows both hold goes before the later
 * of them.
 *
 * AND ONE THAT COMES BEFORE THE FIRST ROW BOTH HOLD IS ABOVE WHAT IS HELD, AND IS LEFT THERE. A
 * window holds the newest page and what came after it; a turn longer than a page begins above
 * that. Every one of these frames brought the turn's first rows again, and added as new they went
 * last: the question, and the first steps of a long task, drawn under its newest (model check,
 * 2026-10-03). They are read where they belong, by scrolling up to them.
 */
export function mergeTurn(
  held: readonly Message[],
  incoming: readonly Message[],
): readonly Message[] {
  if (incoming.length === 0) return held;
  const at = new Map(held.map((message, index) => [message.id, index]));
  const first = incoming.findIndex((message) => at.has(message.id));
  // Nothing in common: all of it is new.
  if (first === -1) return [...held, ...incoming];
  const next = [...held];
  /** What goes in before a held row, by that row's place: rows met since the last one both hold. */
  const before = new Map<number, Message[]>();
  let pending: Message[] = [];
  for (const message of incoming.slice(first)) {
    const place = at.get(message.id);
    if (place === undefined) {
      pending.push(message);
      continue;
    }
    next[place] = message;
    if (pending.length > 0) before.set(place, pending);
    pending = [];
  }
  if (before.size === 0) return [...next, ...pending];
  return [
    ...next.flatMap((message, index) => [
      ...(before.get(index) ?? []),
      message,
    ]),
    ...pending,
  ];
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

/** A message's words, where it has any. */
function textOf(message: Message | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : "";
}

type Behind = ThreadState["behind"];

/** The stream is no longer behind on these: it has said more, or will say no more of them. */
function caughtUp(behind: Behind, keys: readonly string[]): Behind {
  if (!keys.some((key) => key in behind)) return behind;
  return Object.fromEntries(
    Object.entries(behind).filter(([key]) => !keys.includes(key)),
  );
}

/** The same, for messages the stream has sent whole: its own copy is the one held now. */
function caughtUpOn(behind: Behind, messages: readonly Message[]): Behind {
  if (Object.keys(behind).length === 0) return behind;
  return caughtUp(
    behind,
    messages.flatMap((message) => [
      `text:${message.id}`,
      ...((message as { toolCalls?: ToolCall[] }).toolCalls ?? []).map(
        (call) => `args:${call.id}`,
      ),
    ]),
  );
}

/**
 * A SNAPSHOT'S COPY OF A MESSAGE OVER THE ONE HELD: the snapshot's — but for words, and a call's
 * arguments, of which more is held than the snapshot says. Those stand, and the stream is behind
 * on them from what the snapshot said (`into`).
 *
 * A snapshot is the turn as it stood when the stream was opened, and it is not the first thing a
 * window hears after that: a page read since can be on the screen before the snapshot arrives,
 * holding what the record came to hold meanwhile. The snapshot took it back to where the turn had
 * stood, and the pieces after it said it again (model check, 2026-10-03).
 */
function overHeld(
  held: Message | undefined,
  incoming: Message,
  into: Record<string, string>,
): Message {
  if (!held) return incoming;
  let next = incoming;
  const words = textOf(held);
  const said = textOf(incoming);
  if (words !== said && words.startsWith(said)) {
    into[`text:${incoming.id}`] = said;
    next = { ...next, content: words } as Message;
  }
  const heldCalls = (held as { toolCalls?: ToolCall[] }).toolCalls ?? [];
  if (heldCalls.length === 0) return next;
  const calls = (incoming as { toolCalls?: ToolCall[] }).toolCalls ?? [];
  const merged = calls.map((call) => {
    const known = heldCalls.find((one) => one.id === call.id);
    const args = known?.function.arguments ?? "";
    const saidOfIt = call.function.arguments;
    if (!known || args === saidOfIt || !args.startsWith(saidOfIt)) return call;
    into[`args:${call.id}`] = saidOfIt;
    return known;
  });
  // A call the snapshot has not come to yet: its start is still on its way.
  const more = heldCalls.filter(
    (known) => !calls.some((call) => call.id === known.id),
  );
  if (more.length === 0 && merged.every((call, at) => call === calls[at])) {
    return next;
  }
  return { ...next, toolCalls: [...merged, ...more] } as Message;
}

type Held = Pick<ThreadState, "messages" | "behind">;

function applyEvent(held: Held, event: Event): Held {
  const { messages, behind } = held;
  switch (event.type) {
    case "TEXT_MESSAGE_START": {
      const id = String(event.messageId ?? "");
      if (!id) return held;
      const at = indexOf(messages, id);
      if (at === -1) {
        const role = event.role === "user" ? "user" : "assistant";
        return {
          ...held,
          messages: [...messages, { id, role, content: "" } as Message],
        };
      }
      // Held already, with words a page brought: the stream is behind on it from here (`behind`).
      if (textOf(messages[at]) === "") return held;
      return { ...held, behind: { ...behind, [`text:${id}`]: "" } };
    }
    case "TEXT_MESSAGE_CONTENT":
    case "TEXT_MESSAGE_CHUNK": {
      const id = String(event.messageId ?? "");
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!id || !delta) return held;
      const key = `text:${id}`;
      const at = indexOf(messages, id);
      if (at === -1) {
        // Let go of meanwhile, where the stream was behind on it: what it had said is still its.
        return {
          messages: [
            ...messages,
            {
              id,
              role: "assistant",
              content: (own(behind, key) ?? "") + delta,
            } as Message,
          ],
          behind: caughtUp(behind, [key]),
        };
      }
      const message = messages[at] as Message;
      const words = textOf(message);
      const said = (own(behind, key) ?? words) + delta;
      // Still the start of what is held: the held words stand.
      if (key in behind && words.startsWith(said) && words !== said) {
        return { ...held, behind: { ...behind, [key]: said } };
      }
      return {
        messages:
          said === words
            ? messages
            : withMessage(messages, at, {
                ...message,
                content: said,
              } as Message),
        behind: caughtUp(behind, [key]),
      };
    }
    case "TEXT_MESSAGE_END": {
      const key = `text:${String(event.messageId ?? "")}`;
      return key in behind
        ? { ...held, behind: caughtUp(behind, [key]) }
        : held;
    }
    case "TOOL_CALL_START": {
      const toolCallId = String(event.toolCallId ?? "");
      if (!toolCallId) return held;
      const call: ToolCall = {
        id: toolCallId,
        type: "function",
        function: { name: String(event.toolCallName ?? ""), arguments: "" },
      };
      const parent =
        typeof event.parentMessageId === "string" ? event.parentMessageId : "";
      const at = parent ? indexOf(messages, parent) : -1;
      if (at === -1) {
        return {
          ...held,
          messages: [
            ...messages,
            {
              id: parent || toolCallId,
              role: "assistant",
              content: "",
              toolCalls: [call],
            } as Message,
          ],
        };
      }
      const message = messages[at] as Message & { toolCalls?: ToolCall[] };
      const calls = message.toolCalls ?? [];
      const known = calls.find((one) => one.id === toolCallId);
      if (!known) {
        return {
          ...held,
          messages: withMessage(messages, at, {
            ...message,
            toolCalls: [...calls, call],
          } as Message),
        };
      }
      // The same as a message's words: a call a page brought, begun by the stream only now.
      if (known.function.arguments === "") return held;
      return { ...held, behind: { ...behind, [`args:${toolCallId}`]: "" } };
    }
    case "TOOL_CALL_ARGS": {
      const toolCallId = String(event.toolCallId ?? "");
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!toolCallId || !delta) return held;
      const key = `args:${toolCallId}`;
      for (let at = messages.length - 1; at >= 0; at -= 1) {
        const message = messages[at] as Message & { toolCalls?: ToolCall[] };
        const calls = message.toolCalls ?? [];
        const which = calls.findIndex((known) => known.id === toolCallId);
        if (which === -1) continue;
        const known = calls[which] as ToolCall;
        const args = known.function.arguments;
        const said = (own(behind, key) ?? args) + delta;
        if (key in behind && args.startsWith(said) && args !== said) {
          return { ...held, behind: { ...behind, [key]: said } };
        }
        if (said === args) return { ...held, behind: caughtUp(behind, [key]) };
        const next = [...calls];
        next[which] = {
          ...known,
          function: { ...known.function, arguments: said },
        };
        return {
          messages: withMessage(messages, at, {
            ...message,
            toolCalls: next,
          } as Message),
          behind: caughtUp(behind, [key]),
        };
      }
      return held;
    }
    case "TOOL_CALL_END": {
      const key = `args:${String(event.toolCallId ?? "")}`;
      return key in behind
        ? { ...held, behind: caughtUp(behind, [key]) }
        : held;
    }
    case "TOOL_CALL_RESULT": {
      const id = String(event.messageId ?? "");
      const toolCallId = String(event.toolCallId ?? "");
      if (!id || !toolCallId) return held;
      const result = {
        id,
        role: "tool",
        toolCallId,
        content: typeof event.content === "string" ? event.content : "",
      } as Message;
      const at = indexOf(messages, id);
      if (at !== -1) {
        return { ...held, messages: withMessage(messages, at, result) };
      }
      // A result already filed for the call under another id is the same answer; keep the first.
      const answered = messages.some(
        (message) =>
          message.role === "tool" &&
          (message as { toolCallId?: string }).toolCallId === toolCallId,
      );
      return answered ? held : { ...held, messages: [...messages, result] };
    }
    case "MESSAGES_SNAPSHOT": {
      if (!Array.isArray(event.messages)) return held;
      const whole = event.messages as Message[];
      return {
        messages: mergeMessages(messages, whole),
        behind: caughtUpOn(behind, whole),
      };
    }
    default:
      return held;
  }
}

/** One frame, applied. Frames older than what was already applied are ignored. */
export function applyFrame(state: ThreadState, frame: TurnFrame): ThreadState {
  if (frame.kind === "snapshot") {
    // The stream starts over from these copies: it is behind only on what is held further.
    const behind: Record<string, string> = {};
    const held = new Map(
      state.messages.map((message) => [message.id, message]),
    );
    const copies = frame.messages.map((message) =>
      overHeld(held.get(message.id), message, behind),
    );
    return {
      ...state,
      epoch: frame.epoch,
      seq: frame.seq,
      turn: frame.turn,
      waiting: frame.waiting,
      messages: mergeTurn(state.messages, copies),
      behind: Object.keys(behind).length === 0 ? EMPTY_THREAD.behind : behind,
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
          ? {
              failure: null,
              notice: null,
              waiting: [],
              behind: EMPTY_THREAD.behind,
            }
          : {}),
        // A turn that is over says no more of anything.
        ...(isTurnGoing(frame.turn)
          ? {}
          : { waiting: [], behind: EMPTY_THREAD.behind }),
      };
    case "waiting":
      return { ...next, waiting: frame.toolCallIds };
    case "messages":
      return {
        ...next,
        messages: mergeTurn(state.messages, frame.messages),
        behind: caughtUpOn(state.behind, frame.messages),
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
      const applied = applyEvent(state, event);
      return applied === state ||
        (applied.messages === state.messages && applied.behind === state.behind)
        ? next
        : { ...next, messages: applied.messages, behind: applied.behind };
    }
    default:
      return next;
  }
}
