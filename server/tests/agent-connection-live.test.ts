import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AGUIMock } from "@copilotkit/aimock/agui";
import { testAgentConnection } from "../src/agents/connection-test";

/**
 * The connection test, against something that really speaks AG-UI.
 *
 * Uses a real AG-UI mock rather than a stubbed fetch. The other tests for this hand it a function that returns a hand-written
 * SSE body, which proves the parsing and nothing about the protocol: every one of them would still
 * pass if AG-UI changed its wire format underneath us, or if we had misread it in the first place.
 * The whole promise is that somebody else's agent works if it speaks this protocol, so the
 * test that matters is one where an implementation we did not write answers.
 *
 * `@copilotkit/aimock` is ours, which is the point: it is the org's deterministic backend for
 * exactly this, it tracks the protocol as the protocol moves, and using it here means LAF Agent finds
 * out about a drift in the same week as everything else that depends on it rather than in a
 * customer's integration.
 *
 * Deterministic and offline. No key, no network, no spend, and the same answer on every run, so
 * this belongs in CI, which is where an agent-facing contract most needs watching.
 */

describe("registering an agent that really answers", () => {
  const mock = new AGUIMock();
  let url = "";

  beforeAll(async () => {
    // The events a well-behaved agent sends for a trivial run: it starts, says something, finishes.
    mock.onRun(/.*/, [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "ready" },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    ] as never);
    url = await mock.start();
  });

  afterAll(async () => {
    await mock.stop?.();
  });

  test("an agent speaking real AG-UI is reported as working, with what it sent", async () => {
    const result = await testAgentConnection(url, { allowPrivateHosts: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The events are shown to the person registering it, so that they can see it really answered
    // rather than being told it did.
    expect(result.events).toContain("RUN_STARTED");
    expect(result.events).toContain("RUN_FINISHED");
  });

  test("the address is still checked before anything is dialled", async () => {
    // Same guard as registration: the button must not become a way to probe the internal network,
    // and a live server on the other end does not change that.
    const result = await testAgentConnection("http://169.254.169.254/", {
      allowPrivateHosts: true,
    });
    expect(result.ok).toBe(false);
  });

  test("a port with nothing on it reports the direction of the connection", async () => {
    // The server dials the agent, so localhost must be tested from the server side.
    const dead = await testAgentConnection("http://127.0.0.1:9/", {
      allowPrivateHosts: true,
      timeoutMs: 2_000,
    });
    expect(dead.ok).toBe(false);
    if (!dead.ok) {
      expect(dead.reason).toMatch(/reachable from|did not answer/);
    }
  });
});

/**
 * An agent whose run is not over when the check has seen enough.
 *
 * The check wants the opening of the stream and has a cap that says so, but the cap was applied to
 * a string `response.text()` had already read to the end — so it waited for the agent to stop, and
 * an agent that had not stopped by the deadline was reported as a connection that broke. A real
 * server and a real `fetch`, because a stubbed one hands the body no signal: there the old read
 * would wait forever instead of failing at the deadline, which is not what a person sees.
 *
 * From upstream OpenBot (#471, MIT) — its talkative agent, and one upstream's fix still gets wrong:
 * the agent that says it has started and then thinks.
 */
describe("registering an agent that is still answering", () => {
  const encoder = new TextEncoder();

  /** An agent on a port of its own, saying when the far end let go of it. */
  function agentThat(
    run: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  ) {
    const state = { hungUp: Promise.withResolvers<void>() };
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        request.signal.addEventListener("abort", () => state.hungUp.resolve());
        return new Response(new ReadableStream<Uint8Array>({ start: run }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}/ag-ui`,
      hungUp: state.hungUp.promise,
      stop: () => server.stop(true),
    };
  }

  test("one that has started and is thinking is an agent, not a broken connection", async () => {
    // RUN_STARTED, and then nothing: a reasoning model that takes longer than the form waits.
    const agent = agentThat((controller) => {
      controller.enqueue(encoder.encode('data: {"type":"RUN_STARTED"}\n\n'));
    });

    try {
      const result = await testAgentConnection(agent.url, {
        allowPrivateHosts: true,
        timeoutMs: 200,
      });

      expect(result).toEqual({
        ok: true,
        events: ["RUN_STARTED"],
        status: 200,
      });
    } finally {
      agent.stop();
    }
  });

  test("one that streams a long answer is reported without waiting for it to finish", async () => {
    // Two events, then a kilobyte every 20 ms for longer than any deadline: a Bot working through
    // a long document. Nothing here closes, which is the point.
    let writing: ReturnType<typeof setInterval> | undefined;
    const agent = agentThat((controller) => {
      controller.enqueue(
        encoder.encode(
          'event: RUN_STARTED\ndata: {"type":"RUN_STARTED"}\n\n' +
            'event: TEXT_MESSAGE_START\ndata: {"type":"TEXT_MESSAGE_START"}\n\n',
        ),
      );
      writing = setInterval(() => {
        controller.enqueue(
          encoder.encode(
            `event: TEXT_MESSAGE_CONTENT\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"${"x".repeat(960)}"}\n\n`,
          ),
        );
      }, 20);
    });

    try {
      const started = Date.now();
      const result = await testAgentConnection(agent.url, {
        allowPrivateHosts: true,
        timeoutMs: 4_000,
      });
      const took = Date.now() - started;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.events).toContain("RUN_STARTED");
      // The cap is 8,000 bytes, which this agent has sent within a fifth of a second.
      expect(took).toBeLessThan(2_000);
      /*
       * And the agent is let go of, well before the deadline would have done it. Somebody's agent
       * is mid-run on a test message, and a socket left open keeps it writing — and spending —
       * for as long as that run cares to go on.
       */
      const letGo = await Promise.race([
        agent.hungUp.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ]);
      expect(letGo).toBe(true);
    } finally {
      clearInterval(writing);
      agent.stop();
    }
    // Longer than bun's five seconds: the old read came back only at the deadline above.
  }, 15_000);

  test("one that sends no event before the deadline is still not called an agent", async () => {
    // An SSE comment, so the 200 and its headers are on the wire, and then silence.
    const agent = agentThat((controller) => {
      controller.enqueue(encoder.encode(": waiting\n\n"));
    });

    try {
      const result = await testAgentConnection(agent.url, {
        allowPrivateHosts: true,
        timeoutMs: 200,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("connection broke");
    } finally {
      agent.stop();
    }
  });

  test("one that never answers at all is still told apart from an address that cannot be reached", async () => {
    // The deadline now shares its signal with the check's own hang-up, and it is the deadline's
    // name — not a bare abort — that chooses this sentence.
    const agent = agentThat(() => {});

    try {
      const result = await testAgentConnection(agent.url, {
        allowPrivateHosts: true,
        timeoutMs: 200,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("did not answer in time");
    } finally {
      agent.stop();
    }
  });
});
