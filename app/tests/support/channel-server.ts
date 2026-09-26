import type { StoredFailure } from "../../src/lib/channels/retry";
import type { ApiRequest } from "./app-router";
import { agentFixture, json } from "./app-router";

/**
 * THE SERVER FOR ONE CONVERSATION WITH ONE BOT, AT THE NETWORK EDGE.
 *
 * For `mountApp`'s `api`: everything the channel route asks for on the way to a transcript — the
 * channel, the roster, stamps, failures, the read mark — and CopilotKit's runtime, speaking the SSE
 * the server speaks. The `/info`, `/connect` and `/run` answers were captured from a running server
 * (2026-09-13) rather than written from the client's types: a runtime double that only agrees with
 * the code it is testing proves nothing about the protocol.
 *
 * Every run request is kept with its body, because the body IS the thread the server receives —
 * the store keys messages by id, so what a retry sends is what the thread will hold.
 */

export const BOT_ID = "agent_edge-bot";
export const THREAD_ID = "thread-edge";

export type WireMessage = { id: string; role: string; content?: unknown };
export type RunInput = { runId: string; messages: WireMessage[] };

/**
 * An SSE answer as a stream. happy-dom's `Response` gives an empty string body no stream at all, and
 * the runtime client refuses a response it cannot read from.
 */
export function sse(events: object[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A run that answers with one sentence, event for event the way the server streams one. */
export function answering(words: string) {
  return ({ runId }: RunInput) =>
    sse([
      { type: "RUN_STARTED", threadId: THREAD_ID, runId },
      {
        type: "TEXT_MESSAGE_START",
        messageId: `msg_${runId}`,
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: `msg_${runId}`,
        delta: words,
      },
      { type: "TEXT_MESSAGE_END", messageId: `msg_${runId}` },
      { type: "RUN_FINISHED", threadId: THREAD_ID, runId },
    ]);
}

/** The control state a Bot at work holds: its own wheel, nobody asked for. */
export const BOT_AT_THE_WHEEL = {
  holder: "bot",
  since: "2026-09-10T00:00:00Z",
  requested: false,
};

export function channelServer(options: {
  channelId: string;
  history?: WireMessage[];
  failures?: StoredFailure[];
  /** Answers to the run requests, in order. A run past the end fails the test. */
  runs?: Array<(input: RunInput) => Response>;
  /**
   * Whether this deployment has a computer. With one, the control route answers a state every time,
   * which is what the polls were measured against; without one it is a 404 learned once.
   */
  computer?: boolean;
  /**
   * The run the runtime still holds in memory, replayed when the page joins the thread — the last
   * one that went through it, which is not always the last thing the thread holds. Absent is a
   * thread with no run in memory, answered with an empty stream.
   */
  replay?: { runId: string; asked: WireMessage[]; answer: string };
}) {
  const runs: RunInput[] = [];
  /** Every time the page marked the room read, in order: on opening, and when a turn ends. */
  const reads: string[] = [];
  const channel = {
    id: options.channelId,
    name: "닻",
    agentIds: [BOT_ID],
    threadId: THREAD_ID,
    active: true,
  };
  const api = (request: ApiRequest): Response | undefined => {
    const { pathname, method } = request;
    const base = `/api/channels/${options.channelId}`;
    if (pathname === "/api/agents") {
      return json({ agents: [agentFixture({ id: BOT_ID, name: "닻" })] });
    }
    if (pathname === base) return json({ channel });
    if (pathname === `${base}/message-times`) {
      return json({ times: {}, speakers: {} });
    }
    if (pathname === `${base}/failures`) {
      return json({ failures: options.failures ?? [] });
    }
    if (pathname === `${base}/read`) {
      reads.push(new Date().toISOString());
      return json({ previousReadAt: null, readAt: new Date().toISOString() });
    }
    if (pathname === `${base}/activity`) {
      return new Response(null, { status: 204 });
    }
    if (pathname === `/api/computers/${BOT_ID}/control`) {
      return options.computer
        ? json(BOT_AT_THE_WHEEL)
        : json({ error: "Not found." }, 404);
    }
    if (pathname === "/api/sandboxed/published") {
      return json({ components: [] });
    }
    if (pathname === "/api/copilotkit/info") {
      return json({
        version: "1.67.1",
        agents: {
          [BOT_ID]: { name: BOT_ID, description: "", className: "Fe" },
        },
        mode: "sse",
      });
    }
    if (pathname === `/api/copilotkit/threads/${THREAD_ID}/messages`) {
      return json({ messages: options.history ?? [] });
    }
    if (pathname === `/api/copilotkit/agent/${BOT_ID}/connect`) {
      const replay = options.replay;
      // A thread with no run in memory: measured, the server answers 200 with an empty stream.
      if (!replay) return sse([]);
      // And one with a run: its input, its answer, its end — the shape captured from the server.
      return sse([
        {
          type: "RUN_STARTED",
          threadId: THREAD_ID,
          runId: replay.runId,
          input: {
            threadId: THREAD_ID,
            runId: replay.runId,
            state: {},
            messages: replay.asked,
            tools: [],
            context: [],
            forwardedProps: {},
          },
        },
        {
          type: "TEXT_MESSAGE_START",
          messageId: `msg_${replay.runId}`,
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: `msg_${replay.runId}`,
          delta: replay.answer,
        },
        { type: "TEXT_MESSAGE_END", messageId: `msg_${replay.runId}` },
        { type: "RUN_FINISHED", threadId: THREAD_ID, runId: replay.runId },
      ]);
    }
    if (
      pathname === `/api/copilotkit/agent/${BOT_ID}/run` &&
      method === "POST"
    ) {
      const body = request.body as RunInput;
      runs.push({ runId: body.runId, messages: body.messages });
      const answer = options.runs?.[runs.length - 1];
      if (!answer) throw new Error(`run ${runs.length} was not expected`);
      return answer(body);
    }
    return undefined;
  };
  return { api, runs, reads };
}
