import { afterAll, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { createComputerClient } from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import {
  createUnattendedTools,
  type LoopAgent,
  RUN_STOPPED,
  RunStopped,
  runUnattended,
  UnattendedRunError,
} from "../src/runner/unattended";

/**
 * A person stopping work nobody is watching — a routine, a room member's turn — from `모두 멈추기`.
 *
 * The loop already knew how to end itself: its deadline aborts the model and the call in flight
 * (`unattended-deadline.test.ts`). A stop is the same cut made on a person's word instead of a
 * clock's, and it has to reach exactly as far: the model's stream is abandoned, and a click that is
 * on its way to the Bot's browser is abandoned at the socket rather than landing after the run was
 * reported stopped.
 */

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A model that is still thinking until somebody aborts it, and says whether it was. */
function thinkingAgent(): LoopAgent & { aborted: () => boolean; runs: number } {
  let aborted = false;
  let release: (() => void) | undefined;
  const agent = {
    messages: [] as Message[],
    runs: 0,
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent() {
      agent.runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { result: undefined, newMessages: [] };
    },
    abortRun() {
      aborted = true;
      release?.();
    },
    aborted: () => aborted,
  };
  return agent as unknown as LoopAgent & {
    aborted: () => boolean;
    runs: number;
  };
}

/** A model that asks for one click and would report afterwards. */
function clickingAgent(): LoopAgent {
  const turns: Message[] = [
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "computer_click",
            arguments: JSON.stringify({ ref: "e1", snapshotId: 1 }),
          },
        },
      ],
    },
    { id: "a2", role: "assistant", content: "보냈다." },
  ];
  let runs = 0;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      _parameters?: unknown,
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) {
      const turn = turns[runs];
      runs += 1;
      if (turn) agent.messages.push(turn);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: turn ? [turn] : [] };
    },
  };
  return agent as unknown as LoopAgent;
}

/** A computer whose site takes its time over a click, counting the clicks that land. */
function slowComputer(actMs: number) {
  let received = 0;
  let landed = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/snapshot") {
        return Response.json({
          snapshotId: 1,
          url: "https://shop.example/orders",
          title: "주문",
          truncated: false,
          elements: [{ ref: "e1", role: "button", name: "발송 처리" }],
        });
      }
      if (pathname === "/click") {
        received += 1;
        await Promise.race([
          sleep(actMs),
          new Promise((resolve) =>
            request.signal.addEventListener("abort", resolve, { once: true }),
          ),
        ]);
        if (request.signal.aborted) {
          return Response.json({ stopped: true }, { status: 499 });
        }
        landed += 1;
        return Response.json({
          action: "click",
          url: "https://shop.example/orders",
          title: "주문",
          text: "",
        });
      }
      return Response.json({ error: "not here" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    received: () => received,
    landed: () => landed,
    stop: () => server.stop(true),
  };
}

const noTools = {
  tools: [],
  execute: async () => ({ ok: true }),
};

describe("stopping an unattended run", () => {
  const computers: Array<{ stop: () => void }> = [];
  afterAll(() => {
    for (const computer of computers) computer.stop();
  });

  test("a model still thinking is abandoned, and the run ends as stopped rather than failed", async () => {
    const agent = thinkingAgent();
    const stop = new AbortController();
    const running = runUnattended(agent, "오늘 주문 정리해 줘", {
      toolkit: noTools,
      timeoutMs: 60_000,
      mode: "routine",
      signal: stop.signal,
    });
    await sleep(20);
    const at = Date.now();
    stop.abort();

    const error = await running.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RunStopped);
    // Still the loop's own error, so a routine's record keeps the turns it did take.
    expect(error).toBeInstanceOf(UnattendedRunError);
    expect((error as RunStopped).message).toBe(RUN_STOPPED);
    expect(Date.now() - at).toBeLessThan(500);
    // The stream itself was told, not merely walked away from.
    expect(agent.aborted()).toBe(true);
  });

  test("a stop that arrived before the run started asks the model nothing", async () => {
    const agent = thinkingAgent();
    const stop = new AbortController();
    stop.abort();
    await expect(
      runUnattended(agent, "오늘 주문 정리해 줘", {
        toolkit: noTools,
        timeoutMs: 60_000,
        mode: "routine",
        signal: stop.signal,
      }),
    ).rejects.toBeInstanceOf(RunStopped);
    expect(agent.runs).toBe(0);
  });

  test("a click on its way to the Bot's browser is abandoned at the socket and never lands", async () => {
    // The site takes 400 ms over the click; the person presses stop 80 ms in.
    const computer = slowComputer(400);
    computers.push(computer);
    const gateway = createComputerGateway({
      client: createComputerClient({
        baseUrl: computer.url,
        token: "test-token",
        allowPrivateHosts: true,
      }),
      auditStore: { insert: async () => {} },
      policy: () => ({ deny: [], ask: [], allow: ["true"] }),
    });
    await gateway.snapshot("bot-1");
    const toolkit = await createUnattendedTools({ gateway })("bot-1", {
      id: "person-1",
      userId: "person-1",
    });

    const stop = new AbortController();
    const running = runUnattended(clickingAgent(), "발송 처리해 줘", {
      toolkit,
      timeoutMs: 60_000,
      mode: "routine",
      signal: stop.signal,
    });
    await sleep(80);
    stop.abort();

    await expect(running).rejects.toBeInstanceOf(RunStopped);
    await sleep(550);
    // It had left, so it reached the computer — and the computer was told to stop.
    expect(computer.received()).toBe(1);
    expect(computer.landed()).toBe(0);
  });

  test("a run nobody stops is untouched by the signal it was handed", async () => {
    const stop = new AbortController();
    const result = await runUnattended(
      {
        messages: [] as Message[],
        setMessages() {},
        addMessage() {},
        async runAgent(
          _parameters?: unknown,
          subscriber?: { onRunFinishedEvent?: () => unknown },
        ) {
          subscriber?.onRunFinishedEvent?.();
          return { result: undefined, newMessages: [] };
        },
      } as unknown as LoopAgent,
      "안녕",
      {
        toolkit: noTools,
        timeoutMs: 60_000,
        mode: "routine",
        signal: stop.signal,
      },
    );
    expect(result.steps).toHaveLength(1);
    // Aborting after the run is over reaches nothing and throws nowhere.
    stop.abort();
    await sleep(10);
  });
});
