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
import {
  ASK_TOKEN_BUDGET,
  canonicalArguments,
  charsOf,
  knownToolNames,
  MAX_TOOL_RECOVERIES,
  repeatsOf,
  spentSinceLastAsk,
  TOOL_LOOP_LIMIT,
} from "./guards";
import { log, runErrorCodeOf, runFailureOf } from "./log";
import {
  type CompletionProvider,
  liveProvider,
  MODEL,
  REQUEST_TIMEOUT_MS,
} from "./provider";
import {
  botIdOf,
  parseToolArguments,
  reasoningEffortOf,
  toProviderMessages,
  type TranscriptMessage,
} from "./transcript";
import {
  ConsumerGone,
  isEmptyTurn,
  RequestTimedOut,
  runTurn,
  type ToolCallRecord,
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
 * WHAT ELSE A RUN MAY END ON, besides the model finishing or asking for a real tool: a provider
 * failure (`./log`), a stream that was cut before the model finished (`laf:provider_stream_cut`),
 * and the guards in `./guards` — a name the run was never handed, arguments that are not an object,
 * the same call over and over, a question that has cost what one question may. Each guard is first
 * answered INSIDE the run with its fact, the way a bridge lookup is, so the model can recover; the
 * run ends on the fact only when it will not. None of them ends in RUN_FINISHED, because a run that
 * ends in RUN_FINISHED is filed as `done` and shown as an answer.
 */

/** Often enough that no sane stall timeout fires between two; rare enough to be nothing on the wire. */
const HEARTBEAT_MS = 15_000;

/** Effort, one step down. Lowered once when a completion comes back empty — see `runRounds`. */
const LOWER_EFFORT: Record<string, "low" | "medium"> = {
  high: "medium",
  medium: "low",
};

/**
 * The backstop on requests per run.
 *
 * Every way back to the model inside a run is bounded on its own — four lookup rounds
 * (`MAX_BRIDGE_ROUNDS`), two recoveries (`MAX_TOOL_RECOVERIES`), one loop warning, one round with no
 * tools once the budget is spent — so a run makes nine requests at the very most, not counting the
 * one retry an empty answer gets. This is the number a later change that adds another way back
 * cannot run past, and a run that reaches it ends as the loop it is.
 */
const MAX_ROUNDS = 16;

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

/** A call answered here rather than forwarded, to be put in front of the model on the next round. */
type Answered = {
  id: string;
  /** The name the model called it by, which for a bridge call is the bridge's. */
  name: string;
  arguments: string;
  text: string;
  /** A bridge lookup, or one of the guards' facts. Only lookups are bounded by the bridge rounds. */
  kind: "lookup" | "fact";
};

/** The envelope every tool result has, carrying a fact the model reads in Korean. */
function factResult(code: string): string {
  return JSON.stringify({ ok: false, code, reason: toolResultText(code) });
}

/**
 * ONE RUN, POSSIBLY SEVERAL REQUESTS. A turn that only asked the bridge where a tool is gets its
 * answer here and goes straight back to the model, inside the same run — a lookup is not something
 * the surface has to execute, and a round trip through it would cost a whole run per question. The
 * moment the model asks for a REAL tool, the run ends as it always did, and the surface executes it.
 * A call the guards stop is answered the same way a lookup is.
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
  const known = knownToolNames(input.tools, exposed);
  /**
   * What this run added on its own — lookups, facts, and the calls they answer — after the
   * conversation as it arrived. In the transcript's own shape rather than the provider's, so
   * each round converts them WITH the rest (see `toProviderMessages`): a lookup's answer is a
   * tool result like any other, weighed against the same turn budget and cut by the same rule
   * once it ages. Kept in the provider's shape and appended after the conversion, it would
   * have ridden past the budget uncounted.
   */
  const inRun: TranscriptMessage[] = [];
  const effort = reasoningEffortOf(input);

  /** Calls this run answered with `laf:tool_unknown` or `laf:tool_arguments_invalid`. */
  let recoveries = 0;
  /** Calls this run answered with `laf:tool_loop`. One warning; a second is the run's end. */
  let loopAnswers = 0;
  /**
   * The question has cost what it may, and the model has been told. Its next request is offered
   * no tools at all, so it can only speak — the same last turn a routine gets when its steps run
   * out — and a call it makes anyway ends the run.
   */
  let mustSpeak = false;
  /**
   * What this question cost before this run, read off the transcript once; the rounds of this
   * run add what they send. See `ASK_TOKEN_BUDGET` for what the number is and is not.
   */
  const spentBefore = spentSinceLastAsk(input.messages);
  let spentInRun = 0;
  /** How the run ends when a guard has had the last word. Null while the model still may. */
  let endsOn: string | null = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
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
    const transcript = [...input.messages, ...inRun];
    const messages = toProviderMessages(transcript);
    const tools = mustSpeak
      ? undefined
      : toProviderTools(
          round < MAX_BRIDGE_ROUNDS ? exposed.provider : exposed.withoutBridge,
        );
    /** Whether the question had already cost what it may before this request was made. */
    const overBudget = spentBefore + spentInRun >= ASK_TOKEN_BUDGET;
    spentInRun += charsOf(messages);
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
        /*
         * A bridge call is held back whole: its fragments are the arguments of a call whose
         * real name is inside those arguments, so nothing can be forwarded until the turn ends
         * and `answerBridgeCall` has read them. A name the run was never handed is held too —
         * no surface has a handler for it, and forwarding it is how a Bot's turn ended in
         * silence (audit A2, row 6).
         */
        holdOf: (name) =>
          isBridgeCall(name, exposed)
            ? "bridge"
            : known.has(name)
              ? null
              : "unknown",
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

    /**
     * A call answered here instead of forwarded. `opened` says whether its START is already on the
     * wire — a real call streams as it arrives; a held one has shown nothing yet.
     */
    const answer = (
      call: ToolCallRecord & { id: string; name: string },
      code: string,
      opened: boolean,
    ) => {
      const rawArguments = call.arguments || "{}";
      if (!opened) {
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
      }
      emit({ type: "TOOL_CALL_END", toolCallId: call.id } as BaseEvent);
      const result = factResult(code);
      emit({
        type: "TOOL_CALL_RESULT",
        messageId: `tool_${call.id}`,
        toolCallId: call.id,
        content: result,
        role: "tool",
      } as BaseEvent);
      answered.push({
        id: call.id,
        name: call.name,
        arguments: rawArguments,
        text: result,
        kind: "fact",
      });
      // The code and nothing of the call: its name may be one the model made up out of the
      // person's own words, and its arguments are theirs.
      log.warn("tool_call_answered", { bot: botId, run: input.runId, code });
    };

    /**
     * The checks every call about to reach a surface passes, direct or through the bridge: the
     * question's budget, then the loop. True when the call was answered instead.
     */
    const stopped = (
      call: ToolCallRecord & { id: string; name: string },
      target: { name: string; args: Record<string, unknown> },
      opened: boolean,
    ): boolean => {
      if (overBudget) {
        answer(call, "laf:tool_budget_spent", opened);
        mustSpeak = true;
        return true;
      }
      const repeats = repeatsOf(
        transcript,
        target.name,
        canonicalArguments(target.args),
      );
      if (repeats + 1 >= TOOL_LOOP_LIMIT) {
        answer(call, "laf:tool_loop", opened);
        loopAnswers += 1;
        if (loopAnswers > 1) endsOn = "laf:tool_loop";
        return true;
      }
      return false;
    };

    /*
     * Only the ends, after the stream. A call whose name never arrived was never opened and is
     * not closed either: closing one the surface never saw would be reporting a call nobody
     * made.
     */
    for (const record of toolCalls.values()) {
      if (!record.name) continue;
      /*
       * A call the provider named but never gave an id gets a minted one now, so its
       * fragments are not lost — the open and the args go out together, then the end.
       */
      record.id ??= `call_${input.runId}_${[...toolCalls.values()].indexOf(record)}`;
      const call = record as ToolCallRecord & { id: string; name: string };

      /*
       * OFFERED NO TOOLS, AND ASKED FOR ONE ANYWAY. The model was told the question had cost what
       * it may and given a request with no tools to answer in; some models call one out of habit.
       * It gets the same fact, nothing runs, and the run is over — a second round with no tools
       * would say what this one did.
       */
      if (mustSpeak && tools === undefined) {
        answer(call, "laf:tool_budget_spent", call.started && !call.held);
        endsOn = "laf:tool_budget_spent";
        continue;
      }

      if (call.held === "unknown") {
        recoveries += 1;
        answer(call, "laf:tool_unknown", false);
        if (recoveries > MAX_TOOL_RECOVERIES) endsOn = "laf:tool_unknown";
        continue;
      }

      if (call.held === "bridge") {
        /*
         * A BRIDGE CALL, held back whole until now. `isBridgeCall` only said yes to a name a
         * bridge was offered under, so the narrowing here is the same fact read twice.
         */
        const bridged = answerBridgeCall(
          call.name as Parameters<typeof answerBridgeCall>[0],
          call.arguments,
          exposed.deferred,
        );

        if (bridged.kind === "forward") {
          // The real call is what the budget and the loop are about, whichever way it was asked.
          if (stopped(call, bridged, false)) continue;
          /*
           * `tool_call` BECOMES THE REAL CALL, in the real tool's name, under the same id. The
           * surface cannot tell it from a direct call: same handler, same boundary, same audit
           * row with the real name on it. The bridge hides nothing on the way through.
           */
          emit({
            type: "TOOL_CALL_START",
            toolCallId: call.id,
            toolCallName: bridged.name,
            parentMessageId: messageId,
          } as BaseEvent);
          emit({
            type: "TOOL_CALL_ARGS",
            toolCallId: call.id,
            delta: JSON.stringify(bridged.args),
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
        const rawArguments = call.arguments || "{}";
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
          content: bridged.text,
          role: "tool",
        } as BaseEvent);
        answered.push({
          id: call.id,
          name: call.name,
          arguments: rawArguments,
          text: bridged.text,
          kind: "lookup",
        });
        continue;
      }

      // A real call: forwarded as it streamed, or not opened yet when its name came last.
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

      /*
       * ARGUMENTS THAT ARE NOT AN OBJECT never reach a surface. The browser would parse them, fail,
       * and put its parser's English into the transcript as the tool's result with no follow-up
       * run (audit A2, row 5); a routine turned them into `{}` and ran the tool with nothing.
       */
      const args = parseToolArguments(call.arguments);
      if (args === null) {
        recoveries += 1;
        answer(call, "laf:tool_arguments_invalid", true);
        if (recoveries > MAX_TOOL_RECOVERIES) {
          endsOn = "laf:tool_arguments_invalid";
        }
        continue;
      }

      if (stopped(call, { name: call.name, args }, true)) continue;

      emit({ type: "TOOL_CALL_END", toolCallId: call.id } as BaseEvent);
      forwarded += 1;
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
     * A guard has had the last word. Its answer is on the wire, so the thread holds no open call,
     * and the run ends on the same fact — into the ledger and onto the person's screen, rather
     * than into another request that would say what this one did.
     */
    if (endsOn) {
      log.error("run_failed", {
        bot: botId,
        run: input.runId,
        code: endsOn,
        reason: "guard",
        ms: Date.now() - context.startedAt,
      });
      emit({ type: "RUN_ERROR", message: endsOn } as BaseEvent);
      return;
    }

    /*
     * The run is over when the model spoke without a call answered here, when it asked for a real
     * tool (the surface must run it), or when a run that only looks things up has used its lookup
     * rounds. Otherwise the calls and their answers join the transcript — in its own shape, with
     * the ids the wire carried, so the next round's conversion counts and cuts them like any
     * result — and the model is asked again, here.
     */
    if (answered.length === 0 || forwarded > 0) break;
    if (
      round >= MAX_BRIDGE_ROUNDS &&
      answered.every((entry) => entry.kind === "lookup")
    ) {
      break;
    }
    if (round + 1 >= MAX_ROUNDS) {
      log.error("run_failed", {
        bot: botId,
        run: input.runId,
        code: "laf:tool_loop",
        reason: "rounds",
        ms: Date.now() - context.startedAt,
      });
      emit({ type: "RUN_ERROR", message: "laf:tool_loop" } as BaseEvent);
      return;
    }
    inRun.push({
      id: messageId,
      role: "assistant",
      ...(text ? { content: text } : {}),
      toolCalls: answered.map((entry) => ({
        id: entry.id,
        type: "function" as const,
        function: { name: entry.name, arguments: entry.arguments },
      })),
    });
    for (const entry of answered) {
      inRun.push({
        id: `tool_${entry.id}`,
        role: "tool",
        toolCallId: entry.id,
        content: entry.text,
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
