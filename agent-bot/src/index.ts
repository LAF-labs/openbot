import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { serve } from "bun";
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "../../shared/bot-prompt";
import { textOf } from "../../shared/message-content";

/**
 * The built-in Bot is an AG-UI HTTP service registered the same way as any customer-provided Bot.
 *
 * It publishes no tools of its own. Every callable tool arrives in `input.tools`, forwarded by the
 * runtime from the surface registration.
 *
 * The loop runs on the client. When this emits a tool call it ends the run; the surface executes the
 * tool, appends the result, and starts a new run with the fuller conversation. That keeps the tool
 * running where its effects are visible to the person watching.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4200", 10);
/**
 * Which model drives the Bot.
 *
 * `gpt-5.5` works through `/v1/chat/completions`, which is the API this file uses.
 *
 * `gpt-5.6-*` models require the Responses API for tool use and cannot be used by this
 * chat-completions streaming loop.
 */
const MODEL = process.env.BOT_MODEL ?? "gpt-5.5";

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
) => Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;

const liveProvider: CompletionProvider = (request) =>
  openai.chat.completions.create({ ...request, stream: true });

/** Translate the conversation AG-UI carries into the shape the model provider expects. */
function toProviderMessages(input: RunAgentInput) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  for (const message of input.messages) {
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
      // Tool results are appended so the model can continue from the completed call.
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: textOf(message.content),
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

export async function runAgent(
  input: RunAgentInput,
  provider: CompletionProvider = liveProvider,
): Promise<Response> {
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

      try {
        const completion = await provider({
          model: MODEL,
          messages: toProviderMessages(input),
          tools: toProviderTools(input),
          stream: true,
        });

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

        for await (const chunk of completion) {
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
             * order — measured: one sends an arguments fragment before the name, another sends the
             * id a chunk after the name — and opening early put an ARGS event on the wire for an id
             * no START had announced, which AG-UI's verifier rejects and the whole run fails on.
             * The old all-at-the-end buffering was order-proof; this keeps that property while
             * still forwarding as soon as forwarding is legal.
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

        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
        // Reported as a run error rather than a dropped connection, so the transcript can say what
        // went wrong. A stream that simply ends leaves the surface waiting forever with no reason.
        send({
          type: "RUN_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "The Bot could not answer.",
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
