import type { BaseEvent } from "@ag-ui/core";
import type OpenAI from "openai";
import type { CompletionProvider } from "./provider";

/**
 * One request to the model, streamed out as AG-UI events as it arrives.
 *
 * This is the translation layer and nothing else: a provider's chunks in, events out, plus the
 * record of what the turn contained so the loop (`./run`) can decide what to do with it. It does
 * not know about rounds, retries, the bridge's answers or the budget — only that some calls must
 * be HELD rather than forwarded as they stream, and the loop says which.
 */

/** What is known about one of the turn's tool calls, keyed by the provider's index. */
export type ToolCallRecord = {
  id: string | null;
  name: string | null;
  /** Fragments that arrived and have not gone out yet. Emptied as they are forwarded. */
  pending: string;
  /** Whether TOOL_CALL_START went out. A held call never opens while it streams. */
  started: boolean;
  /**
   * Why nothing of this call goes on the wire as it streams. `bridge`: its arguments name the
   * REAL tool, and that is only known once they are complete.
   */
  held: "bridge" | null;
};

/** Everything a finished request produced, for the loop to act on. */
export type Turn = {
  messageId: string;
  /** The prose of this round, for the transcript the next round is given. */
  text: string;
  textOpen: boolean;
  toolCalls: Map<number, ToolCallRecord>;
  usage: OpenAI.CompletionUsage | null;
  /** Why the model stopped. `length` means the answer was cut off mid-sentence. */
  finishReason: string | null;
};

/** The request outlived its bound. Its own error, because a timeout is not a provider failure. */
export class RequestTimedOut extends Error {
  constructor() {
    super("The model request outlived its bound.");
    this.name = "RequestTimedOut";
  }
}

export type TurnOptions = {
  provider: CompletionProvider;
  model: string;
  effort: "low" | "medium" | "high" | undefined;
  /**
   * Which request of the run this is. A later round is a second assistant message in the same
   * run, so it needs its own message id.
   */
  round: number;
  runId: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: OpenAI.Chat.ChatCompletionTool[] | undefined;
  timeoutMs: number;
  emit: (event: BaseEvent) => void;
  /** Whether a call by this name is held back whole rather than forwarded as it streams. */
  holdOf: (name: string) => ToolCallRecord["held"];
};

/** Nothing said and nothing asked for. Distinct from a Bot with nothing to add, which is a choice. */
export function isEmptyTurn(turn: Turn): boolean {
  return (
    !turn.textOpen &&
    ![...turn.toolCalls.values()].some((call) => call.name !== null)
  );
}

/**
 * Nothing is emitted for an empty turn by construction — text opens on the first content delta
 * and a tool call opens on its first id-and-name — so a retry cannot leave half an answer on the
 * wire in front of the second attempt.
 */
export async function runTurn(options: TurnOptions): Promise<Turn> {
  const { emit, provider, round, runId } = options;
  /*
   * The bound that was missing. A provider that accepted the request and then went quiet held
   * the turn open for as long as it liked. Aborted AND raced against nothing else: the signal
   * is what stops the work, and the abort is what makes the `for await` below throw.
   */
  const abort = new AbortController();
  let expired = false;
  const expiry = setTimeout(() => {
    expired = true;
    abort.abort();
  }, options.timeoutMs);
  expiry.unref?.();

  try {
    const completion = await provider(
      {
        model: options.model,
        messages: options.messages,
        tools: options.tools,
        stream: true,
        // The final chunk then carries token counts. Part of the OpenAI spec since 2024 and
        // answered by every compatible endpoint measured here; a provider that ignores it
        // simply sends no usage chunk, and the run proceeds without a usage event.
        stream_options: { include_usage: true },
        // Omitted rather than sent as a default: a model that does not reason answers a
        // request carrying this with a 400 on some providers and silence on others, and a
        // deployment that has not said its model reasons must get the request it always got.
        ...(options.effort ? { reasoning_effort: options.effort } : {}),
      },
      { signal: abort.signal },
    );

    const messageId = round === 0 ? `msg_${runId}` : `msg_${runId}_${round}`;
    let textOpen = false;
    let text = "";
    /*
     * Providers stream a tool call's arguments in fragments across many chunks, keyed only by
     * index. Each fragment is FORWARDED AS IT ARRIVES and also kept, because the two halves
     * serve different readers: `@ag-ui/client` reassembles the fragments into the finished call
     * (`arguments += delta`), and anything watching the stream can read the partial value.
     *
     * It used to buffer everything and emit one TOOL_CALL_START / ARGS / END after the model
     * had finished. Measured: with that, a room turn showed nothing at all while a Bot wrote —
     * speaking in a room IS a tool call, so the whole message arrived at once or not at all,
     * and every Bot a person creates in this product runs through this service.
     */
    const toolCalls = new Map<number, ToolCallRecord>();

    let usage: OpenAI.CompletionUsage | null = null;
    let finishReason: string | null = null;
    for await (const chunk of completion) {
      // The usage chunk has no choices; read it before the delta guard skips it.
      if (chunk.usage) usage = chunk.usage;
      const reason = chunk.choices[0]?.finish_reason;
      if (reason) finishReason = reason;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        if (!textOpen) {
          emit({
            type: "TEXT_MESSAGE_START",
            messageId,
            role: "assistant",
          } as BaseEvent);
          textOpen = true;
        }
        text += delta.content;
        emit({
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: delta.content,
        } as BaseEvent);
      }

      for (const call of delta.tool_calls ?? []) {
        const existing = toolCalls.get(call.index) ?? {
          id: null as string | null,
          name: null as string | null,
          pending: "",
          started: false,
          held: null as ToolCallRecord["held"],
        };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name = call.function.name;
        toolCalls.set(call.index, existing);

        /*
         * A call opens only once BOTH its id and its name are known, and the fragments that
         * arrived before that moment go out right behind the open. Providers do not agree on
         * order — measured: one sends an arguments fragment before the name, another sends
         * the id a chunk after the name — and opening early put an ARGS event on the wire for
         * an id no START had announced, which AG-UI's verifier rejects and the whole run
         * fails on. The old all-at-the-end buffering was order-proof; this keeps that
         * property while still forwarding as soon as forwarding is legal.
         */
        if (call.function?.arguments) {
          existing.pending += call.function.arguments;
        }
        if (!existing.started && existing.id && existing.name) {
          existing.started = true;
          existing.held = options.holdOf(existing.name);
          if (!existing.held) {
            emit({
              type: "TOOL_CALL_START",
              toolCallId: existing.id,
              toolCallName: existing.name,
              parentMessageId: messageId,
            } as BaseEvent);
          }
        }
        if (existing.started && !existing.held && existing.pending) {
          emit({
            type: "TOOL_CALL_ARGS",
            toolCallId: existing.id,
            delta: existing.pending,
          } as BaseEvent);
          existing.pending = "";
        }
      }
    }

    return { messageId, text, textOpen, toolCalls, usage, finishReason };
  } catch (error) {
    if (expired) throw new RequestTimedOut();
    throw error;
  } finally {
    clearTimeout(expiry);
  }
}
