import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import {
  answerBridgeCall,
  exposeTools,
  isBridgeCall,
  MAX_BRIDGE_ROUNDS,
  toolDeferralOf,
  toProviderTools,
} from "./deferral";
import { log, runErrorCodeOf, runFailureOf } from "./log";
import {
  type CompletionProvider,
  liveProvider,
  MODEL,
  REQUEST_TIMEOUT_MS,
} from "./provider";
import {
  botIdOf,
  reasoningEffortOf,
  toProviderMessages,
  type TranscriptMessage,
} from "./transcript";
import {
  ConsumerGone,
  isEmptyTurn,
  RequestTimedOut,
  runTurn,
  type Turn,
} from "./turn";

/**
 * The loop: one run of one Bot, as an AG-UI event stream.
 *
 * It publishes no tools of its own. Every callable tool arrives in `input.tools`, forwarded by the
 * runtime from the surface registration.
 *
 * IT PUBLISHES NO PROMPT OF ITS OWN EITHER, and that is newer. It used to prepend upstream's
 * English system prompt to every request, so a Bot read two system messages written by two
 * different places — and the second one contradicted the first (one said "answer in plain
 * language", the room's said "plain text is invisible here"). The whole prompt is now composed by
 * the server, in `shared/prompt`, and arrives as an ordinary system message. This service forwards
 * what it is given.
 *
 * The loop runs on the client. When this emits a tool call it ends the run; the surface executes the
 * tool, appends the result, and starts a new run with the fuller conversation. That keeps the tool
 * running where its effects are visible to the person watching.
 *
 * A RUN THAT DID NOT FINISH NEVER ENDS IN RUN_FINISHED, because RUN_FINISHED is filed as `done` and
 * shown as an answer. A provider failure ends in RUN_ERROR with its code (`./log`), and so does a
 * stream cut before the model finished (`laf:provider_stream_cut`).
 */

/** Often enough that no sane stall timeout fires between two; rare enough to be nothing on the wire. */
const HEARTBEAT_MS = 15_000;

/** Effort, one step down. Lowered once when a completion comes back empty — see `runRounds`. */
const LOWER_EFFORT: Record<string, "low" | "medium"> = {
  high: "medium",
  medium: "low",
};

export type RunOptions = {
  /**
   * How long one model request may take. Overridable so a test can prove the bound exists without
   * waiting two minutes for it — a two-minute test is a test somebody eventually deletes.
   */
  timeoutMs?: number;
};

/** Everything one run's rounds share. */
type RunContext = {
  input: RunAgentInput;
  provider: CompletionProvider;
  timeoutMs: number;
  emit: (event: BaseEvent) => void;
  /** Whose turn this is, for this service's own log. See `botIdOf`. */
  botId: string;
  /** When the run began, so the log can say how long a turn took without saying what it said. */
  startedAt: number;
};

export async function runAgent(
  input: RunAgentInput,
  provider: CompletionProvider = liveProvider,
  options: RunOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const encoder = new EventEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      /*
       * The one way anything leaves this run. An enqueue that throws means the reader has gone —
       * the runtime cancelled the request because a person pressed Stop — and that is said as
       * such, so neither the cut detection nor the failure report below mistakes it for the model.
       */
      const emit = (event: BaseEvent) => {
        try {
          controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
        } catch {
          throw new ConsumerGone();
        }
      };

      /*
       * A heartbeat while the model is quiet.
       *
       * A reasoning model can sit for a minute before its first token, and to the runtime watching
       * this stream that minute is indistinguishable from a provider that has hung — its stall
       * watchdog ends the turn at the configured silence (60 s by default) and the person reads an
       * answer cut off at nothing. An SSE comment line is the protocol's own keepalive: it is bytes
       * on the wire, so the watchdog sees a live stream, and it carries no `data:` field, so every
       * AG-UI parser drops it without reading it. Sent between tokens too — the quiet can come
       * mid-answer, when a model stops to think before a tool call.
       */
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(utf8.encode(": keepalive\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_MS);

      const context: RunContext = {
        input,
        provider,
        timeoutMs,
        emit,
        botId: botIdOf(input),
        startedAt: Date.now(),
      };

      try {
        emit({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        await runRounds(context);
      } catch (error) {
        /*
         * A consumer that left is not a failure of anything. Leaving the `for await` by this throw
         * is also what makes the SDK abort the provider's request, so nothing more is paid for.
         */
        if (error instanceof ConsumerGone) {
          log.info("consumer_gone", {
            bot: context.botId,
            run: input.runId,
            ms: Date.now() - context.startedAt,
          });
          return;
        }
        /*
         * Reported as a run error rather than a dropped connection, so the transcript can say what
         * went wrong — but as a FACT CODE, never the provider's sentence. The provider's error body
         * names its vendor, its model catalogue and its URLs ("This model was ZAI's GLM-5.3
         * Flash… openrouter.ai/…", measured on the wire the day the stealth alpha died), and this
         * stream ends on a customer's screen. The product's model is served under a name only we
         * choose (tenant model.yaml), and one leaked refusal undoes that.
         *
         * Three codes because there are three different next steps, and collapsing them is the trap
         * model-call.ts documents: a rate limit wants WAITING, and telling somebody "try again" in
         * front of an instant refusal is how a working feature looks broken.
         *
         * THE LOG GETS THE SAME DISCIPLINE. It used to get the whole error object, on the argument
         * that an operator reads it and no customer does — and the object carried the provider's
         * body, the response headers and the stack, into a file that is rotated, shipped and
         * pasted into tickets. `describeFailure` turns the client's error into the kind it was
         * (`provider_rate_limited`, `provider_refused`, `reply_unusable`), which is also the only
         * part an operator acts on.
         */
        // A timeout is its own next step — the request was accepted and never came back — so it
        // is its own code rather than being flattened into "the model failed".
        const code =
          error instanceof RequestTimedOut
            ? "laf:model_timed_out"
            : runErrorCodeOf(error);
        log.error("run_failed", {
          bot: context.botId,
          run: input.runId,
          code,
          reason: runFailureOf(error),
          ms: Date.now() - context.startedAt,
        });
        try {
          emit({ type: "RUN_ERROR", message: code } as BaseEvent);
        } catch {
          // The reader left while the provider was failing. There is nobody left to tell.
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed from the reader's side.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** A bridge lookup answered here, to be put in front of the model on the next round. */
type Answered = { id: string; name: string; arguments: string; text: string };

/** The envelope every tool result has, carrying a fact the model reads in Korean. */
function factResult(code: string): string {
  return JSON.stringify({ ok: false, code, reason: toolResultText(code) });
}

/**
 * ONE RUN, POSSIBLY SEVERAL REQUESTS. A turn that only asked the bridge where a tool is gets its
 * answer here and goes straight back to the model, inside the same run — a lookup is not something
 * the surface has to execute, and a round trip through it would cost a whole run per question. The
 * moment the model asks for a REAL tool, the run ends as it always did, and the surface executes it.
 */
async function runRounds(context: RunContext): Promise<void> {
  const { input, emit, botId } = context;
  /*
   * WHAT THE MODEL IS OFFERED, which is no longer everything this service was handed.
   *
   * The connected-service tools sit behind the bridge (`./deferral`): the schema carries the
   * core tools and three more, instead of every tool of every service the person connected.
   * The whole list is kept, because a lookup is answered from it.
   */
  const exposed = exposeTools(input.tools, toolDeferralOf(input));
  /**
   * What this run added on its own — bridge lookups and their answers — after the
   * conversation as it arrived. In the transcript's own shape rather than the provider's, so
   * each round converts them WITH the rest (see `toProviderMessages`): a lookup's answer is a
   * tool result like any other, weighed against the same turn budget and cut by the same rule
   * once it ages. Kept in the provider's shape and appended after the conversion, it would
   * have ridden past the budget uncounted.
   */
  const inRun: TranscriptMessage[] = [];
  const effort = reasoningEffortOf(input);

  for (let round = 0; ; round += 1) {
    /*
     * THE TRANSCRIPT IS CONVERTED ONCE PER ROUND, NOT ONCE PER TURN.
     *
     * The system message it starts with carries the Bot's memory as the server snapshotted
     * it for this run, and the tool results in it are trimmed against one budget. A retry
     * at lower effort is the same round asked again, so it is sent the same transcript —
     * converting it inside each turn would let the two attempts of one round disagree
     * about what was cut. A new round IS a different transcript: the lookups the last one
     * answered are in it now, counted against the budget and cut like every other result.
     */
    const messages = toProviderMessages([...input.messages, ...inRun]);
    const tools = toProviderTools(
      round < MAX_BRIDGE_ROUNDS ? exposed.provider : exposed.withoutBridge,
    );
    const request = (attemptEffort: typeof effort) =>
      runTurn({
        provider: context.provider,
        model: MODEL,
        effort: attemptEffort,
        round,
        runId: input.runId,
        messages,
        tools,
        timeoutMs: context.timeoutMs,
        emit,
        // A bridge call is held back whole: its fragments are the arguments of a call whose
        // real name is inside those arguments, so nothing can be forwarded until the turn ends
        // and `answerBridgeCall` has read them.
        holdOf: (name) => (isBridgeCall(name, exposed) ? "bridge" : null),
      });
    let turn = await request(effort);

    /*
     * AN EMPTY COMPLETION IS A REASONING BUDGET SPENT ON THINKING.
     *
     * No text, no tool calls, RUN_FINISHED — which every reader downstream takes for a Bot that
     * chose to say nothing. In a room that is a legitimate silence; in a chat it is a Bot that
     * ignored the person. Same trap `model-call.ts` records for `askModel`, same answer: ask
     * again with less of the budget going to deliberation. Once only — a model that comes back
     * empty twice is not going to come back full on the third.
     */
    if (isEmptyTurn(turn)) {
      const lowered = effort ? LOWER_EFFORT[effort] : undefined;
      if (lowered) {
        log.warn("reply_empty_retrying", {
          bot: botId,
          run: input.runId,
          effort,
          retryingAt: lowered,
        });
        // The first attempt was paid for too. Overwriting it here is how the monthly cost KPI
        // missed exactly the days a reasoning model spent its budget on nothing (audit A2, S3-5).
        emitUsage(context, turn);
        turn = await request(lowered);
      }
      if (isEmptyTurn(turn)) {
        log.warn("reply_empty", { bot: botId, run: input.runId });
        emit({
          type: "CUSTOM",
          name: "laf.empty_answer",
          value: { botId },
        } as BaseEvent);
      }
    }

    const { messageId, text, textOpen, toolCalls, finishReason } = turn;

    if (textOpen) {
      emit({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
    }

    /*
     * THE STREAM WAS CUT, with some of the answer already on the wire.
     *
     * The half that arrived is real and stays — its message is closed properly above, so it is
     * kept on screen and in the thread — but the run FAILS: RUN_ERROR is what the ledger files as
     * `error`, what `/failures` lists and what puts the sentence under the half on the person's
     * screen, where RUN_FINISHED would have delivered it as the whole. A call caught partway
     * through its arguments is closed and answered with the same fact, so the thread holds no
     * open call and no surface executes half an argument list.
     */
    if (turn.cut) {
      for (const call of toolCalls.values()) {
        if (!call.started || call.held || !call.id) continue;
        emit({ type: "TOOL_CALL_END", toolCallId: call.id } as BaseEvent);
        emit({
          type: "TOOL_CALL_RESULT",
          messageId: `tool_${call.id}`,
          toolCallId: call.id,
          content: factResult("laf:provider_stream_cut"),
          role: "tool",
        } as BaseEvent);
      }
      log.error("reply_cut", {
        bot: botId,
        run: input.runId,
        ...turn.cut,
        // How much arrived, in characters: enough to tell half a sentence from nearly all of one.
        chars: text.length,
        ms: Date.now() - context.startedAt,
      });
      emit({
        type: "RUN_ERROR",
        message: "laf:provider_stream_cut",
      } as BaseEvent);
      return;
    }

    /** Calls the surface has to execute this run — real ones, and bridged ones in real names. */
    let forwarded = 0;
    const answered: Answered[] = [];

    /*
     * Only the ends, after the stream. A call whose name never arrived was never opened and is
     * not closed either: closing one the surface never saw would be reporting a call nobody
     * made.
     */
    for (const call of toolCalls.values()) {
      if (!call.name) continue;
      /*
       * A call the provider named but never gave an id gets a minted one now, so its
       * fragments are not lost — the open and the args go out together, then the end.
       */
      call.id ??= `call_${input.runId}_${[...toolCalls.values()].indexOf(call)}`;

      if (!call.held) {
        if (!call.started) {
          emit({
            type: "TOOL_CALL_START",
            toolCallId: call.id,
            toolCallName: call.name,
            parentMessageId: messageId,
          } as BaseEvent);
          if (call.pending) {
            emit({
              type: "TOOL_CALL_ARGS",
              toolCallId: call.id,
              delta: call.pending,
            } as BaseEvent);
          }
        }
        emit({ type: "TOOL_CALL_END", toolCallId: call.id } as BaseEvent);
        forwarded += 1;
        continue;
      }

      /*
       * A BRIDGE CALL, held back whole until now. `isBridgeCall` only said yes to a name a
       * bridge was offered under, so the narrowing here is the same fact read twice.
       */
      const answer = answerBridgeCall(
        call.name as Parameters<typeof answerBridgeCall>[0],
        call.pending,
        exposed.deferred,
      );

      if (answer.kind === "forward") {
        /*
         * `tool_call` BECOMES THE REAL CALL, in the real tool's name, under the same id. The
         * surface cannot tell it from a direct call: same handler, same boundary, same audit
         * row with the real name on it. The bridge hides nothing on the way through.
         */
        emit({
          type: "TOOL_CALL_START",
          toolCallId: call.id,
          toolCallName: answer.name,
          parentMessageId: messageId,
        } as BaseEvent);
        emit({
          type: "TOOL_CALL_ARGS",
          toolCallId: call.id,
          delta: JSON.stringify(answer.args),
        } as BaseEvent);
        emit({ type: "TOOL_CALL_END", toolCallId: call.id } as BaseEvent);
        forwarded += 1;
        continue;
      }

      /*
       * A lookup, answered from the list this service was handed. On the wire in full — the
       * call and its result — so the transcript says the Bot looked, rather than the Bot
       * appearing to know a tool it was never shown. AG-UI's TOOL_CALL_RESULT is what an agent
       * that executed its own tool sends; the client files it as an ordinary tool message.
       */
      const rawArguments = call.pending || "{}";
      emit({
        type: "TOOL_CALL_START",
        toolCallId: call.id,
        toolCallName: call.name,
        parentMessageId: messageId,
      } as BaseEvent);
      emit({
        type: "TOOL_CALL_ARGS",
        toolCallId: call.id,
        delta: rawArguments,
      } as BaseEvent);
      emit({ type: "TOOL_CALL_END", toolCallId: call.id } as BaseEvent);
      emit({
        type: "TOOL_CALL_RESULT",
        messageId: `tool_${call.id}`,
        toolCallId: call.id,
        content: answer.text,
        role: "tool",
      } as BaseEvent);
      answered.push({
        id: call.id,
        name: call.name,
        arguments: rawArguments,
        text: answer.text,
      });
    }

    /*
     * THE ANSWER STOPPED MID-SENTENCE AND NOTHING SAID SO.
     *
     * `finish_reason: "length"` was never read, so a cut-off answer was delivered as a finished
     * one and the person read half a paragraph with no way to know there had been more. A
     * CUSTOM event rather than a RUN_ERROR: the half that arrived is real and worth keeping,
     * and the surface says so in Korean beside it.
     */
    if (finishReason === "length") {
      log.warn("reply_truncated", { bot: botId, run: input.runId });
      emit({
        type: "CUSTOM",
        name: "laf.answer_truncated",
        value: { botId },
      } as BaseEvent);
    }

    emitUsage(context, turn);

    /*
     * The run is over when the model spoke without looking anything up, when it asked for a
     * real tool (the surface must run it), or when the lookup budget is spent. Otherwise the
     * lookups and their answers join the transcript — in its own shape, with the ids the
     * wire carried, so the next round's conversion counts and cuts them like any result —
     * and the model is asked again, here.
     */
    if (answered.length === 0 || forwarded > 0 || round >= MAX_BRIDGE_ROUNDS) {
      break;
    }
    inRun.push({
      id: messageId,
      role: "assistant",
      ...(text ? { content: text } : {}),
      toolCalls: answered.map((lookup) => ({
        id: lookup.id,
        type: "function" as const,
        function: { name: lookup.name, arguments: lookup.arguments },
      })),
    });
    for (const lookup of answered) {
      inRun.push({
        id: `tool_${lookup.id}`,
        role: "tool",
        toolCallId: lookup.id,
        content: lookup.text,
      });
    }
  }

  /*
   * Counts only. The tools a run was handed and the tools the model was shown are the two
   * numbers an operator asks for when a turn was slow or a Bot could not find a tool; the
   * names, the transcript and the answer are the person's and never go here.
   */
  log.info("run_finished", {
    bot: botId,
    run: input.runId,
    tools: input.tools?.length ?? 0,
    exposed: exposed.provider.length,
    deferred: exposed.deferred.length,
    ms: Date.now() - context.startedAt,
  });
  emit({
    type: "RUN_FINISHED",
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent);
}

/**
 * What this turn cost, said inside the stream because that is the only channel this service
 * has: it holds no server URL and no database, on purpose. The runner tees every run's events
 * and writes this one to the audit trail — the number the per-Bot monthly cost KPI is computed
 * from. Counts only, never content. One per request: a run that looked twice paid three times,
 * and the audit row says so.
 */
function emitUsage(context: RunContext, turn: Turn): void {
  const { usage } = turn;
  if (!usage) return;
  /*
   * How much of the prompt the provider served from its cache, where it says so.
   * OpenAI-style endpoints put it in `prompt_tokens_details.cached_tokens` and OpenRouter
   * normalises to the same field; Anthropic-shaped ones say `cache_read_input_tokens`.
   * Left OUT rather than written as zero when neither is there — a zero would read as
   * "measured, nothing hit", which is a different fact from "this endpoint does not say".
   */
  const said = usage as {
    prompt_tokens_details?: { cached_tokens?: unknown };
    cache_read_input_tokens?: unknown;
  };
  const cached =
    typeof said.prompt_tokens_details?.cached_tokens === "number"
      ? said.prompt_tokens_details.cached_tokens
      : typeof said.cache_read_input_tokens === "number"
        ? said.cache_read_input_tokens
        : undefined;
  context.emit({
    type: "CUSTOM",
    name: "laf.model.usage",
    value: {
      model: MODEL,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    },
  } as BaseEvent);
}
