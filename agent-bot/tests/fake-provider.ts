/**
 * A fake OpenAI-compatible provider, over HTTP, that records what it was asked and when.
 *
 * The `CompletionProvider` seam is enough for most of what the loop does, and every other test
 * here uses it. It is NOT enough for the three things the real SDK decides on its own: what a
 * body that ends without `data: [DONE]` looks like from the far side of the SDK's iterator
 * (nothing — it ends silently, measured), how a 429 with `retry-after` is retried, and when an
 * abort actually reaches the socket. Those are only visible with the real client pointed at a
 * real endpoint, and this is that endpoint: `/v1/chat/completions`, server-sent events, one
 * scripted behaviour per request, everything timestamped in milliseconds from the start.
 *
 * The audit of 2026-09-10 (A2) measured the eight provider behaviours against a fixture like
 * this one; the fixture was never committed. This is the committed one.
 */

/** One OpenAI chunk's `choices[0]`, as the fake will send it. */
export type Choice = {
  delta?: Record<string, unknown>;
  finish_reason?: string | null;
};

export type Behaviour =
  /** Stream these choices, then end — properly, or cut. */
  | {
      kind: "stream";
      choices: Choice[];
      /** The usage chunk after the last choice, as OpenAI sends it. Absent: none. */
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
      /**
       * `done`: `data: [DONE]` then close, which is a finished stream. `eof`: close the body
       * with no `[DONE]` — a proxy's idle limit, a provider redeploying. `reset`: error the body
       * after the chunks have gone out, which is the connection dropping after a flush.
       */
      end?: "done" | "eof" | "reset";
      /** A pause before each chunk, so a hang mid-answer can be modelled. */
      chunkDelayMs?: number;
    }
  /** Answer with a status and no stream. */
  | { kind: "status"; status: number; retryAfter?: string }
  /** Accept the request and say nothing for this long, then behave as `then` (or hang for ever). */
  | { kind: "hang"; ms?: number; then?: Behaviour };

export type RecordedRequest = {
  /** Milliseconds since the fake started. */
  at: number;
  body: Record<string, unknown>;
  /** When the client gave up on this request, if it did. */
  abortedAt?: number;
  /** When the response body was fully written or ended. */
  endedAt?: number;
};

export type FakeProvider = {
  /** The base URL the SDK takes: ends in `/v1`. */
  url: string;
  requests: RecordedRequest[];
  /** Milliseconds since the fake started. */
  now: () => number;
  stop: () => void;
};

const encoder = new TextEncoder();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start one. `script` is either a list, one behaviour per request in order (the last one repeats),
 * or a function of the request's ordinal.
 */
export function startFakeProvider(
  script: Behaviour[] | ((ordinal: number) => Behaviour),
): FakeProvider {
  const startedAt = Date.now();
  const now = () => Date.now() - startedAt;
  const requests: RecordedRequest[] = [];
  const behaviourOf = (ordinal: number): Behaviour =>
    typeof script === "function"
      ? script(ordinal)
      : (script[Math.min(ordinal, script.length - 1)] ?? {
          kind: "status",
          status: 500,
        });

  const server = Bun.serve({
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        url.pathname !== "/v1/chat/completions" ||
        request.method !== "POST"
      ) {
        return Response.json({ error: "not here" }, { status: 404 });
      }
      const record: RecordedRequest = {
        at: now(),
        body: (await request.json()) as Record<string, unknown>,
      };
      requests.push(record);
      request.signal.addEventListener("abort", () => {
        record.abortedAt ??= now();
      });

      const respond = async (behaviour: Behaviour): Promise<Response> => {
        if (behaviour.kind === "status") {
          record.endedAt = now();
          return new Response(
            JSON.stringify({ error: { message: `fake ${behaviour.status}` } }),
            {
              status: behaviour.status,
              headers: {
                "content-type": "application/json",
                ...(behaviour.retryAfter
                  ? { "retry-after": behaviour.retryAfter }
                  : {}),
              },
            },
          );
        }
        if (behaviour.kind === "hang") {
          if (behaviour.ms === undefined || !behaviour.then) {
            // For ever, or until the client goes away — which is what the record is for.
            await new Promise<void>((resolve) => {
              request.signal.addEventListener("abort", () => resolve());
              if (behaviour.ms !== undefined) setTimeout(resolve, behaviour.ms);
            });
            record.endedAt = now();
            return new Response(null, { status: 499 });
          }
          await sleep(behaviour.ms);
          return respond(behaviour.then);
        }
        return new Response(
          sseBody(behaviour, record, now, () => server.stop(true)),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
          },
        );
      };
      return respond(behaviourOf(requests.length - 1));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    now,
    stop: () => server.stop(true),
  };
}

function sseBody(
  behaviour: Extract<Behaviour, { kind: "stream" }>,
  record: RecordedRequest,
  now: () => number,
  /**
   * Drop every connection the fake holds. Erroring the response stream is not a reset: Bun
   * keeps the socket open and the client waits on it (measured — the SDK sat there until this
   * service's own two-minute bound). Closing the server is the only way to make the wire drop.
   */
  dropConnections: () => void,
): ReadableStream<Uint8Array> {
  const line = (payload: unknown) =>
    encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (choice: Choice) => ({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [
      {
        index: 0,
        delta: choice.delta ?? {},
        finish_reason: choice.finish_reason ?? null,
      },
    ],
  });
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const choice of behaviour.choices) {
          if (behaviour.chunkDelayMs) await sleep(behaviour.chunkDelayMs);
          controller.enqueue(line(chunk(choice)));
        }
        if (behaviour.usage) {
          controller.enqueue(
            line({
              id: "chatcmpl-fake",
              object: "chat.completion.chunk",
              created: 0,
              model: "fake-model",
              choices: [],
              usage: behaviour.usage,
            }),
          );
        }
        record.endedAt = now();
        const end = behaviour.end ?? "done";
        if (end === "done") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } else if (end === "eof") {
          controller.close();
        } else {
          // Let what was written reach the socket before the connection is torn down.
          await sleep(20);
          dropConnections();
        }
      } catch {
        // The client went away first; nothing to write to.
      }
    },
  });
}

/* ── the chunks a provider sends, as the scripts here spell them ─────────────────────────── */

/** Prose in fragments, then a proper stop. */
export const says = (...fragments: string[]): Choice[] => [
  ...fragments.map((content) => ({ delta: { content } })),
  { delta: {}, finish_reason: "stop" },
];

/** One tool call: id and name, then the arguments in two fragments, then the finish. */
export const calls = (
  id: string,
  name: string,
  rawArguments: string,
): Choice[] => {
  const half = Math.ceil(rawArguments.length / 2);
  return [
    { delta: { tool_calls: [{ index: 0, id, function: { name } }] } },
    {
      delta: {
        tool_calls: [
          { index: 0, function: { arguments: rawArguments.slice(0, half) } },
        ],
      },
    },
    {
      delta: {
        tool_calls: [
          { index: 0, function: { arguments: rawArguments.slice(half) } },
        ],
      },
    },
    { delta: {}, finish_reason: "tool_calls" },
  ];
};
