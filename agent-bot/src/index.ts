import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { serve } from "bun";
import OpenAI from "openai";
import { textOf } from "../../shared/message-content";
import { toolResultText } from "../../shared/prompt/tool-results.ko";

/**
 * The built-in Bot is an AG-UI HTTP service registered the same way as any customer-provided Bot.
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
 */

const PORT = Number.parseInt(process.env.PORT ?? "4200", 10);
/**
 * Which model drives the Bot. No default, on purpose.
 *
 * It used to fall back to `gpt-5.5` while the tenant package fell back to `gpt-4.1` and the
 * deployment ran `z-ai/glm-5.3-flash`: three answers to one question, and the two written here were
 * both wrong. A default in this file cannot be the deployment's decision — it is not where the
 * deployment is described — so the fallback lives once, in the tenant package's `model.yaml`, and
 * `BOT_MODEL` carries it here. Unset, the service refuses to start (see the bottom of this file)
 * rather than answering on a model nobody chose.
 *
 * Whatever it names is sent verbatim through `/v1/chat/completions`, which is the API this file
 * uses. `gpt-5.6-*` models require the Responses API for tool use and cannot be used by this
 * chat-completions streaming loop.
 */
const MODEL = process.env.BOT_MODEL?.trim() ?? "";

/**
 * Where that model is answered from.
 *
 * Unset, this is OpenAI. Set, it is any endpoint speaking the same `/v1/chat/completions` API: a
 * gateway in front of several providers, a proxy, or a model on hardware you control. Which is the
 * point of writing against that API by hand rather than against one company's URL.
 *
 * `BOT_MODEL` is sent verbatim, because an endpoint names its own catalogue.
 */
const BASE_URL = process.env.OPENAI_BASE_URL?.trim() || undefined;

/** Often enough that no sane stall timeout fires between two; rare enough to be nothing on the wire. */
const HEARTBEAT_MS = 15_000;

/**
 * The longest one model request may take before this service gives up on it.
 *
 * There was no bound at all. A provider that accepts a request and then never finishes it held the
 * turn open until something further up the chain got bored, and the person watched a spinner with
 * nothing behind it. Generous — a reasoning model on a long page genuinely takes a minute — and
 * finite, which is the whole point.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * How many of the most recent tool results are forwarded whole.
 *
 * A page's readable text comes back up to 6,000 characters (`agent-computer`), and in Korean that
 * is roughly as many tokens. Ten steps of browsing therefore put forty to sixty thousand tokens of
 * page text in front of the model, most of it pages it has already finished with, and every one of
 * those turns is paid for again. The recent ones are what the model is still working from; the
 * older ones only have to be recognisable.
 */
const TOOL_RESULTS_IN_FULL = 4;

/** How much of an older tool result survives. Enough to know what page it was. */
const TRIMMED_TOOL_RESULT_CHARS = 500;

/** Effort, one step down. Lowered once when a completion comes back empty — see `runAgent`. */
const LOWER_EFFORT: Record<string, "low" | "medium"> = {
  high: "medium",
  medium: "low",
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: BASE_URL,
});

/**
 * The one call this service makes to a model, as a seam.
 *
 * A test hands in a fake that yields scripted chunks; the service itself never notices. Narrower
 * than the whole client on purpose: it is the only method used, and a fake of one method cannot
 * drift from a client it does not pretend to be.
 */
export type CompletionProvider = (
  request: Parameters<typeof openai.chat.completions.create>[0],
  /** Aborted when the request outlives `REQUEST_TIMEOUT_MS`. Optional, so a test fake may ignore it. */
  options?: { signal?: AbortSignal },
) => Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;

const liveProvider: CompletionProvider = (request, options) =>
  openai.chat.completions.create({ ...request, stream: true }, options);

/**
 * Which tool results are old enough to be trimmed.
 *
 * By position, not by tool name: the name of the tool a result answers is only knowable by walking
 * back to the assistant message that called it, and the thing that actually costs tokens is length.
 * A short result — an approval question, a saved file — is under the cut either way, so the rule
 * that reads on length is the same rule as the one that reads on "is this page text", without
 * needing to be right about which tool produced it.
 */
function trimOldToolResults(
  messages: readonly RunAgentInput["messages"][number][],
): Set<number> {
  const toolResults: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "tool") toolResults.push(index);
  });
  return new Set(toolResults.slice(0, -TOOL_RESULTS_IN_FULL));
}

/** Translate the conversation AG-UI carries into the shape the model provider expects. */
export function toProviderMessages(input: RunAgentInput) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const trimmable = trimOldToolResults(input.messages);
  let at = -1;

  for (const message of input.messages) {
    at += 1;
    if (message.role === "user") {
      // Not `String(content)`: a user message's content can be an array of parts, and stringifying
      // one hands the model "[object Object]" with nothing anywhere saying so. See message-content.
      messages.push({ role: "user", content: textOf(message.content) });
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push({ role: "system", content: textOf(message.content) });
      continue;
    }
    if (message.role === "tool") {
      /*
       * Tool results are appended so the model can continue from the completed call — the older
       * ones cut, and SAID TO BE CUT. A silent truncation is read by the model as "that page did
       * not say anything about it", which is a confident wrong answer rather than a missing one.
       */
      const content = textOf(message.content);
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content:
          trimmable.has(at) && content.length > TRIMMED_TOOL_RESULT_CHARS
            ? `${content.slice(0, TRIMMED_TOOL_RESULT_CHARS)}\n${toolResultText("laf:tool_result_trimmed")}`
            : content,
      });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }));
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return messages;
}

/** Every tool comes from the caller. This service publishes none of its own, on purpose. */
function toProviderTools(input: RunAgentInput) {
  if (!input.tools?.length) return undefined;
  return input.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

/**
 * How hard to think, as the caller asked and this API spells it.
 *
 * The words on the wire are the product's — `quick`, `balanced`, `thorough` — because the server
 * and this service speak different APIs and would otherwise each need the other's spelling. Each
 * end translates its own, so a third would be one file, not a change everywhere upstream.
 *
 * Undefined for anything else, including nothing at all. A caller that says nothing gets exactly
 * the request this service made before the setting existed, which is the only safe reading of
 * silence — and a value this service does not recognise is silence.
 */
function reasoningEffortOf(
  input: RunAgentInput,
): "low" | "medium" | "high" | undefined {
  const forwarded = input.forwardedProps;
  if (!forwarded || typeof forwarded !== "object") return undefined;
  const effort = (forwarded as Record<string, unknown>).effort;
  if (effort === "quick") return "low";
  if (effort === "balanced") return "medium";
  if (effort === "thorough") return "high";
  return undefined;
}

/**
 * Which Bot this run belongs to, for this service's own log.
 *
 * It had no way to know. A Bot's whole identity arrived as a system message, so every line this
 * service logged named a run and a model and no Bot, and an operator reading them could not tell
 * whose turn had failed. The server puts it in `forwardedProps`; this only reads it.
 */
export function botIdOf(input: RunAgentInput): string {
  const forwarded = input.forwardedProps;
  if (!forwarded || typeof forwarded !== "object") return "unknown-bot";
  const botId = (forwarded as Record<string, unknown>).botId;
  return typeof botId === "string" && botId ? botId : "unknown-bot";
}

/**
 * The closed set a failed run may report, and how a provider failure lands in it.
 *
 * `laf:` because the surface translates exactly these and shows anything else verbatim — a prefix
 * an English sentence can never accidentally carry is what keeps the two apart. The stall guard's
 * own sentences (server-side) deliberately stay sentences; this only covers what THIS service's
 * provider throws.
 */
export function runErrorCodeOf(error: unknown): string {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 429) return "laf:model_rate_limited";
  if (typeof status === "number") return "laf:model_unavailable";
  return "laf:model_failed";
}

/** Nothing said and nothing asked for. Distinct from a Bot with nothing to add, which is a choice. */
function isEmptyTurn(turn: {
  textOpen: boolean;
  toolCalls: Map<number, { name: string | null }>;
}): boolean {
  return (
    !turn.textOpen &&
    ![...turn.toolCalls.values()].some((call) => call.name !== null)
  );
}

export async function runAgent(
  input: RunAgentInput,
  provider: CompletionProvider = liveProvider,
  /**
   * How long one model request may take. Overridable so a test can prove the bound exists without
   * waiting two minutes for it — a two-minute test is a test somebody eventually deletes.
   */
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const encoder = new EventEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

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

      /** Whose turn this is, for this service's own log. See `botIdOf`. */
      const botId = botIdOf(input);
      /** Set by the deadline below, read by the catch: a timeout is not a provider failure. */
      let timedOut = false;

      /**
       * One request to the model, streamed out as it arrives.
       *
       * Split out so an EMPTY completion can be tried once more at a lower effort. Nothing is
       * emitted for an empty turn by construction — text opens on the first content delta and a
       * tool call opens on its first id-and-name — so a retry cannot leave half an answer on the
       * wire in front of the second attempt.
       */
      const runTurn = async (effort: "low" | "medium" | "high" | undefined) => {
        /*
         * The bound that was missing. A provider that accepted the request and then went quiet held
         * the turn open for as long as it liked. Aborted AND raced against nothing else: the signal
         * is what stops the work, and the abort is what makes the `for await` below throw.
         */
        const abort = new AbortController();
        const expiry = setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, timeoutMs);
        expiry.unref?.();

        try {
          const completion = await provider(
            {
              model: MODEL,
              messages: toProviderMessages(input),
              tools: toProviderTools(input),
              stream: true,
              // The final chunk then carries token counts. Part of the OpenAI spec since 2024 and
              // answered by every compatible endpoint measured here; a provider that ignores it
              // simply sends no usage chunk, and the run proceeds without a usage event.
              stream_options: { include_usage: true },
              // Omitted rather than sent as a default: a model that does not reason answers a
              // request carrying this with a 400 on some providers and silence on others, and a
              // deployment that has not said its model reasons must get the request it always got.
              ...(effort ? { reasoning_effort: effort } : {}),
            },
            { signal: abort.signal },
          );

          const messageId = `msg_${input.runId}`;
          let textOpen = false;
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
          const toolCalls = new Map<
            number,
            {
              id: string | null;
              name: string | null;
              /** Fragments that arrived before the call could legally open. */
              pending: string;
              started: boolean;
            }
          >();

          let usage: OpenAI.CompletionUsage | null = null;
          /** Why the model stopped. `length` means the answer was cut off mid-sentence. */
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
                send({
                  type: "TEXT_MESSAGE_START",
                  messageId,
                  role: "assistant",
                } as BaseEvent);
                textOpen = true;
              }
              send({
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
                send({
                  type: "TOOL_CALL_START",
                  toolCallId: existing.id,
                  toolCallName: existing.name,
                  parentMessageId: messageId,
                } as BaseEvent);
              }
              if (existing.started && existing.pending) {
                send({
                  type: "TOOL_CALL_ARGS",
                  toolCallId: existing.id,
                  delta: existing.pending,
                } as BaseEvent);
                existing.pending = "";
              }
            }
          }

          return { messageId, textOpen, toolCalls, usage, finishReason };
        } finally {
          clearTimeout(expiry);
        }
      };

      try {
        const effort = reasoningEffortOf(input);
        let turn = await runTurn(effort);

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
            console.warn(
              `[agent-bot] ${botId} answered empty at effort ${effort}; retrying at ${lowered}`,
            );
            turn = await runTurn(lowered);
          }
          if (isEmptyTurn(turn)) {
            console.warn(`[agent-bot] ${botId} answered empty; giving up`);
            send({
              type: "CUSTOM",
              name: "laf.empty_answer",
              value: { botId },
            } as BaseEvent);
          }
        }

        const { messageId, textOpen, toolCalls, usage, finishReason } = turn;

        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }

        /*
         * Only the ends, after the stream. A call whose name never arrived was never opened and is
         * not closed either: closing one the surface never saw would be reporting a call nobody
         * made.
         */
        for (const call of toolCalls.values()) {
          /*
           * A call that never got both an id and a name never opened, so it is not closed either;
           * a call the provider named but never gave an id gets a minted one now, so its
           * fragments are not lost — the open and the args go out together, then the end.
           */
          if (!call.started) {
            if (!call.name) continue;
            call.id ??= `call_${input.runId}_${[...toolCalls.values()].indexOf(call)}`;
            send({
              type: "TOOL_CALL_START",
              toolCallId: call.id,
              toolCallName: call.name,
              parentMessageId: messageId,
            } as BaseEvent);
            if (call.pending) {
              send({
                type: "TOOL_CALL_ARGS",
                toolCallId: call.id,
                delta: call.pending,
              } as BaseEvent);
            }
          }
          send({ type: "TOOL_CALL_END", toolCallId: call.id } as BaseEvent);
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
          console.warn(`[agent-bot] ${botId} hit the length limit mid-answer`);
          send({
            type: "CUSTOM",
            name: "laf.answer_truncated",
            value: { botId },
          } as BaseEvent);
        }

        /*
         * What this turn cost, said inside the stream because that is the only channel this
         * service has: it holds no server URL and no database, on purpose. The runner tees every
         * run's events and writes this one to the audit trail — the number the per-Bot monthly
         * cost KPI is computed from. Counts only, never content.
         */
        if (usage) {
          send({
            type: "CUSTOM",
            name: "laf.model.usage",
            value: {
              model: MODEL,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            },
          } as BaseEvent);
        }

        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
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
         * front of an instant refusal is how a working feature looks broken. The full error still
         * goes to this service's own log, where an operator reads it and no customer does.
         */
        console.error(`[agent-bot] ${botId} run failed:`, error);
        send({
          type: "RUN_ERROR",
          // A timeout is its own next step — the request was accepted and never came back — so it
          // is its own code rather than being flattened into "the model failed".
          message: timedOut ? "laf:model_timed_out" : runErrorCodeOf(error),
        } as BaseEvent);
      } finally {
        clearInterval(heartbeat);
        controller.close();
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

/*
 * Only when run as the service. Importing this module — a test driving `runAgent` against a fake
 * provider — must not bind a port, or the second test file in a run fails with EADDRINUSE against
 * the first.
 */
if (import.meta.main) {
  /*
   * Loudly, and here rather than at module scope: a throw while this file is being imported would
   * take the test suite's own import of `runAgent` with it, and a suite that never runs reports
   * nothing rather than failing. Nothing that serves a person gets past this line without a model.
   */
  if (!MODEL) {
    console.error(
      "BOT_MODEL is not set. This service sends the model name verbatim to OPENAI_BASE_URL and has no default of its own — the deployment's model is declared once, in the tenant package's model.yaml, and docker-compose passes BOT_MODEL through from .env. Set it there (.env.example ships it set) and start again.",
    );
    process.exit(1);
  }

  serve({
    port: PORT,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: MODEL });
      }

      if (url.pathname === "/ag-ui" && request.method === "POST") {
        const input = (await request.json()) as RunAgentInput;
        return runAgent(input);
      }

      return Response.json({ error: "Not found." }, { status: 404 });
    },
  });

  console.info(`agent-bot listening on http://localhost:${PORT}/ag-ui`);
}
