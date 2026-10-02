import { checkAgentEndpoint } from "./endpoint";

/**
 * Ask an endpoint whether it is really an agent before it is stored.
 *
 * The registration form is the cheap point to distinguish a typo, a dead host, and a reachable
 * service that is not an AG-UI agent.
 *
 * AG-UI requires one POST to the endpoint returning an SSE stream of events (`@ag-ui/client`'s
 * `HttpAgent` is `{ url, headers?, fetch? }`). The test is a real run with a trivial message.
 */

/** How long an endpoint gets to answer. Short: this is a person waiting on a form. */
const TEST_TIMEOUT_MS = 15_000;

/** Enough of the stream to prove it is an agent. Reading it all could mean reading a whole reply. */
const MAX_BYTES = 8_000;

/**
 * The opening of the answer, and whether the read broke before it had that much.
 *
 * The cap above was applied to a string this process had already taken in full: `response.text()`
 * reads a body to its end, and an agent's body ends when its run does. So the form waited for the
 * run, and a run that outlasted the deadline came back through `text()` as a rejected read — "The
 * agent started answering and the connection broke." Nothing had broken. Measured 2026-10-02
 * against a real server: an agent that sent RUN_STARTED and then thought was reported broken at the
 * deadline, and one streaming a kilobyte every 20 ms was reported broken after the whole four
 * seconds it was given. Upstream OpenBot met the second (#471, MIT).
 *
 * WHAT ARRIVED BEFORE A BREAK STILL ARRIVED, and that is the half upstream's fix does not have: it
 * reads to the cap, so an agent that has said less than 8,000 bytes when the deadline comes is
 * still "broke". The caller judges by the events in the text, and only an opening with none in it
 * is a connection that broke.
 *
 * Counted in bytes, which is what the cap is named in. The piece that crosses it is kept whole —
 * one read past the cap at most — and decoded as a stream, so a character split across two pieces
 * is not two replacement characters in a line the scan is about to read.
 */
async function openingOf(
  body: ReadableStream<Uint8Array>,
): Promise<{ text: string; broke: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return { text, broke: false };
  } catch {
    return { text, broke: true };
  }
}

export type ConnectionTestResult =
  | {
      ok: true;
      /** The AG-UI event types that came back, in order, so a person sees it really answered. */
      events: string[];
      status: number;
    }
  | { ok: false; reason: string; status?: number };

/**
 * The smallest thing that is still a real run.
 *
 * Not a HEAD or a bare GET: plenty of things answer those. Only a POST that produces AG-UI events
 * distinguishes "an agent" from "a web server that happens to be reachable".
 */
function probeBody() {
  return {
    threadId: `laf-connection-test-${crypto.randomUUID()}`,
    runId: `laf-connection-test-${crypto.randomUUID()}`,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content:
          "This is an automated connection test from LAF Agent. Reply with one short word.",
      },
    ],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

/** Pull `event:`/`data:` type names out of an SSE body, which is how AG-UI reports what it did. */
function eventTypesFrom(text: string): string[] {
  const types: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      types.push(trimmed.slice("event:".length).trim());
      continue;
    }
    // Most AG-UI servers put the type inside the JSON payload rather than on an `event:` line.
    if (trimmed.startsWith("data:")) {
      try {
        const parsed = JSON.parse(trimmed.slice("data:".length).trim()) as {
          type?: unknown;
        };
        if (typeof parsed.type === "string") types.push(parsed.type);
      } catch {
        // A fragment of a longer line. Not worth reporting: the summary is about whether events
        // arrived at all, and one unparsed chunk does not change that answer.
      }
    }
  }
  return [...new Set(types)];
}

/**
 * Try an endpoint and say what happened, in words a person can act on.
 *
 * Never throws. Every failure a person can cause, a typo, a dead host, an endpoint that answers HTML
 *, comes back as a reason, because this is rendered next to the field they just filled in.
 */
export async function testAgentConnection(
  rawEndpoint: unknown,
  options: {
    headers?: Record<string, string>;
    allowPrivateHosts?: boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ConnectionTestResult> {
  // Use the same target check that governs storing the endpoint, so this form cannot probe internal
  // addresses that registration would refuse.
  const verdict = checkAgentEndpoint(rawEndpoint, {
    allowPrivateHosts: options.allowPrivateHosts,
  });
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };

  const doFetch = options.fetchImpl ?? fetch;
  /*
   * Ours to end as well as the deadline's. The agent is very likely still writing when the check
   * has what it needs, and cancelling the body's reader does not hang up in Bun (measured on
   * 1.3.11: the far end went on sending until the request's signal fired) — so a test message would
   * keep somebody's agent running, and spending, until the deadline. Aborting the request does.
   */
  const enough = new AbortController();
  let response: Response;
  try {
    response = await doFetch(verdict.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...options.headers,
      },
      body: JSON.stringify(probeBody()),
      signal: AbortSignal.any([
        AbortSignal.timeout(options.timeoutMs ?? TEST_TIMEOUT_MS),
        enough.signal,
      ]),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      reason: timedOut
        ? "The agent did not answer in time. It may be starting up, or the address may be unreachable from this server."
        : "This server could not reach that address. If your agent runs on your own machine, it needs to be reachable from here, a tunnel, or somewhere this server can dial.",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason:
        response.status === 401 || response.status === 403
          ? "The agent refused this request. If it needs a key, add it as a header."
          : `The agent answered ${response.status}. An AG-UI endpoint answers a POST with a stream of events.`,
    };
  }

  const opening = response.body
    ? await openingOf(response.body)
    : { text: "", broke: false };
  enough.abort();

  const events = eventTypesFrom(opening.text);
  if (events.length === 0 && opening.broke) {
    return {
      ok: false,
      status: response.status,
      reason: "The agent started answering and the connection broke.",
    };
  }
  if (events.length === 0) {
    // Reachable, and not an agent. The most useful thing to say is what it looked like instead.
    const contentType = response.headers.get("content-type") ?? "nothing";
    return {
      ok: false,
      status: response.status,
      reason: `That address answered, but not with AG-UI events (it sent ${contentType}). Check it is the agent's AG-UI path and not its home page.`,
    };
  }

  return { ok: true, events, status: response.status };
}
