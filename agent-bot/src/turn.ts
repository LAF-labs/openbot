import type { BaseEvent } from "@ag-ui/core";
import type OpenAI from "openai";
import { describeFailure } from "../../shared/failure-text";
import type { CompletionProvider } from "./provider";
import { mergeReasoningDetails, type ReasoningDetail } from "./reasoning";
import type { ProviderEffort } from "./transcript";

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
  /**
   * Every fragment that arrived, whole: the arguments exactly as the model sent them. `pending`
   * is emptied as fragments go out, so this is the copy the loop parses once the turn is over.
   */
  arguments: string;
  /** Fragments that arrived and have not gone out yet. Emptied as they are forwarded. */
  pending: string;
  /** Whether TOOL_CALL_START went out. A held call never opens while it streams. */
  started: boolean;
  /**
   * Why nothing of this call goes on the wire as it streams. `bridge`: its arguments name the
   * REAL tool, and that is only known once they are complete. `service`: a tool this service
   * answers itself (`now`), which no surface has a handler for. `unknown`: a name the run was never
   * handed, which no surface can execute and which the loop answers itself. `deferred`: a tool
   * behind the bridge called by its own name, whose arguments are settled like a `tool_call`'s once
   * they are complete (`settleDeferredCall`).
   */
  held: "bridge" | "service" | "deferred" | "unknown" | null;
};

/**
 * How a stream that did not finish came to an end, for the log.
 *
 * - `ended_without_finish`: the body ended cleanly with no finish reason — a proxy's idle limit, a
 *   provider redeploying. The SDK's iterator simply stops, so nothing throws.
 * - `failed_midway`: the read threw after some of the answer had been flushed — the connection
 *   dropped, or the provider sent an error event in the middle. `failure` says which kind, in the
 *   closed words `describeFailure` gives a provider's error, never in the provider's own.
 * - `timed_out`: this service's own bound (`REQUEST_TIMEOUT_MS`) ended the request after some of
 *   the answer had gone out. Not the provider's cut, and the run ends on `laf:model_timed_out`.
 */
export type Cut =
  | { reason: "ended_without_finish" }
  | { reason: "failed_midway"; failure: string }
  | { reason: "timed_out" };

/** Everything a finished request produced, for the loop to act on. */
export type Turn = {
  messageId: string;
  /** The prose of this round, for the transcript the next round is given. */
  text: string;
  textOpen: boolean;
  toolCalls: Map<number, ToolCallRecord>;
  usage: OpenAI.CompletionUsage | null;
  /**
   * Which provider answered, where the endpoint says so. OpenRouter puts `provider` on every chunk;
   * a plain OpenAI-compatible endpoint says nothing and this stays null. Recorded because a prefix
   * cache lives with one provider (agent-harness-review §3), so a hit rate means nothing without it.
   */
  provider: string | null;
  /** Why the model stopped. `length` means the answer was cut off mid-sentence. */
  finishReason: string | null;
  /**
   * What the model thought before it answered, as OpenRouter's `reasoning_details` — merged the way
   * OpenRouter's own SDK merges the stream (`./reasoning`). Kept only to be handed back with a turn
   * that called a tool; empty where the endpoint sends none.
   */
  reasoning: ReasoningDetail[];
  /**
   * THE STREAM STOPPED BEFORE THE MODEL SAID IT WAS DONE, with something already on the wire.
   *
   * Null for every stream that ended the way a stream ends. See `runTurn` for the rule.
   */
  cut: Cut | null;
  /**
   * Where the round's time went, in milliseconds from the request: the first chunk of any kind
   * (reasoning included), and the first thing a person could see — prose or a tool call. Null
   * where it never came. Measured because "생각 중" sat for 25 s on a first message and nothing
   * could say whether the provider was slow to start, the model was thinking, or the run was
   * several rounds long (ux-review-0.5.4, item 9).
   */
  timing: { firstChunkMs: number | null; firstOutputMs: number | null };
};

/** The request outlived its bound. Its own error, because a timeout is not a provider failure. */
export class RequestTimedOut extends Error {
  constructor() {
    super("The model request outlived its bound.");
    this.name = "RequestTimedOut";
  }
}

/**
 * Whoever was reading this run's stream has gone: a person pressed Stop, a tab closed, the runtime
 * cancelled the request. Nothing can be sent to nobody.
 *
 * Its own class because the two things it used to be confused with want nothing in common with it.
 * It was logged as `run_failed code=laf:model_failed reason="Invalid state: Controller is already
 * closed"` — a person's Stop counted as a model outage (audit A2, S3-10) — and a Stop that lands
 * after the first token must not read as a stream the provider cut either.
 */
export class ConsumerGone extends Error {
  constructor() {
    super("The run's consumer went away.");
    this.name = "ConsumerGone";
  }
}

/**
 * Who this conversation is, to the provider, in hashes (`./session`). Never an email, a name or a
 * thread id as it is: the provider is told only that two requests belong together.
 */
export type ProviderSession = {
  /** Sent as `x-session-id`: OpenRouter keeps one conversation on the provider holding its cache. */
  id: string;
  /** Sent as `user`: a stable end-user id — the Bot's, hashed. */
  user: string;
};

export type TurnOptions = {
  provider: CompletionProvider;
  model: string;
  effort: ProviderEffort | undefined;
  /** Absent sends neither: a test, or a caller that named no conversation. */
  session?: ProviderSession;
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

  const messageId = round === 0 ? `msg_${runId}` : `msg_${runId}_${round}`;
  const requestedAt = Date.now();
  let firstChunkMs: number | null = null;
  let firstOutputMs: number | null = null;
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
  let answeredBy: string | null = null;
  let finishReason: string | null = null;
  const reasoning: ReasoningDetail[] = [];
  /** Whether any prose or any tool-call fragment arrived. What separates a cut from an empty turn. */
  let delivered = false;

  const turn = (cut: Cut | null): Turn => ({
    messageId,
    text,
    textOpen,
    toolCalls,
    usage,
    provider: answeredBy,
    finishReason,
    reasoning,
    cut,
    timing: { firstChunkMs, firstOutputMs },
  });

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
        // `max` is GLM's own word, which the OpenAI SDK's type does not name; it is sent as is.
        ...(options.effort
          ? {
              reasoning_effort:
                options.effort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
            }
          : {}),
        // The Bot, hashed, as the end user: a standard field of this API, which every
        // compatible endpoint accepts.
        ...(options.session ? { user: options.session.user } : {}),
      },
      {
        signal: abort.signal,
        /*
         * STICKY ROUTING, ASKED FOR. OpenRouter spreads this model over 31 endpoints, each with its
         * own cache, and without a session it pins a conversation by hashing the first system
         * message — which, while the clock sat in it, changed every minute (agent-harness-review
         * §2). A header rather than the body's `session_id`, because a header an endpoint does not
         * know is ignored, where an unknown body field is a 400 on OpenAI's own API.
         */
        ...(options.session
          ? { headers: { "x-session-id": options.session.id } }
          : {}),
      },
    );

    for await (const chunk of completion) {
      firstChunkMs ??= Date.now() - requestedAt;
      // The usage chunk has no choices; read it before the delta guard skips it.
      if (chunk.usage) usage = chunk.usage;
      const named = (chunk as { provider?: unknown }).provider;
      if (typeof named === "string" && named) answeredBy = named;
      const reason = chunk.choices[0]?.finish_reason;
      if (reason) finishReason = reason;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      // Not a type the SDK knows: OpenRouter's extension of the delta, read where it is sent.
      mergeReasoningDetails(
        reasoning,
        (delta as { reasoning_details?: unknown }).reasoning_details,
      );

      if (delta.content) {
        delivered = true;
        firstOutputMs ??= Date.now() - requestedAt;
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
        delivered = true;
        firstOutputMs ??= Date.now() - requestedAt;
        const existing = toolCalls.get(call.index) ?? {
          id: null as string | null,
          name: null as string | null,
          arguments: "",
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
          existing.arguments += call.function.arguments;
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

    /*
     * A STREAM THAT REACHED ITS END SAYS SO, and one that delivered something and then stopped
     * without saying so was cut.
     *
     * Measured (audit A2, row 8): "주문이 세 건 " and "들어왔고, 그중", then the body ended. The
     * SDK's iterator ends silently on a body that stops before `data: [DONE]` (openai 4.104,
     * `streaming.mjs`: `done = true` after the loop, no throw), so the half-sentence went out as
     * a finished answer, the ledger said `done`, and a routine delivered it as its morning report.
     * The evidence is in the chunks: the last choice of a completed stream carries a
     * `finish_reason`, and the usage chunk is computed only once the end is reached — either one
     * is an end. [DONE] itself is not visible from this side of the SDK, and not every
     * compatible endpoint sends it, where every one measured sends a finish reason.
     *
     * Nothing delivered is not a cut: it is an empty turn, and the loop already asks an empty
     * turn again, which is the same recovery a cut before the first token wants.
     *
     * UNLESS OUR OWN BOUND ENDED IT, which the SDK does not say either. Once the response has
     * begun, aborting it makes the SDK's iterator RETURN rather than throw (openai 4.104,
     * `streaming.js`: an `AbortError` is swallowed), so the `catch` below never sees the timeout.
     * Measured 2026-09-26 with the real client against a local endpoint that sent a reasoning chunk
     * and then went quiet: the bound came out as an empty answer, was asked again for a second full
     * bound, and the run ended RUN_FINISHED with `laf.empty_answer` — filed as done. With prose
     * already on the wire it came out as `laf:provider_stream_cut`, "the connection dropped". Every
     * OpenRouter request is in that state within a second, because OpenRouter sends its headers
     * and a `: OPENROUTER PROCESSING` comment before the model has said anything; the hung provider
     * the bound exists for was never reported as one.
     */
    if (expired) {
      if (delivered) return turn({ reason: "timed_out" });
      throw new RequestTimedOut();
    }
    const ended = finishReason !== null || usage !== null;
    return turn(
      delivered && !ended ? { reason: "ended_without_finish" } : null,
    );
  } catch (error) {
    if (expired) {
      // What went out stays on the wire and is closed by the loop, as a cut's is.
      if (delivered) return turn({ reason: "timed_out" });
      throw error instanceof RequestTimedOut ? error : new RequestTimedOut();
    }
    // Nobody is reading: not the provider's cut, and nothing more is to be sent.
    if (error instanceof ConsumerGone) throw error;
    /*
     * The connection went after the flush, or the provider failed in the middle: the same
     * half-answer, arriving as a throw. What arrived is already on the wire, and ending the run on
     * a model-failure code would leave it there looking finished, so it is the same cut.
     */
    if (delivered) {
      return turn({ reason: "failed_midway", failure: describeFailure(error) });
    }
    throw error;
  } finally {
    clearTimeout(expiry);
  }
}
