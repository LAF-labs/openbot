import { afterAll, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { createComputerClient } from "../src/computer/client";
import {
  type ComputerGateway,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import {
  createUnattendedTools,
  type LoopAgent,
  runUnattended,
} from "../src/runner/unattended";

/**
 * A routine's deadline, all the way to the Bot's browser.
 *
 * MEASURED IN THE AUDIT (A2 §2, 2026-09-10) BY READING, and now by counting: `withDeadline` raced the
 * tool call against a timer, rejected, and walked away. The run was marked failed and the person
 * told — and the gateway call it walked away from went on, so the click landed afterwards. On a slow
 * site the last action of a run can be a payment or a send, and a side effect arriving after
 * "failed" is the worst order there is short of acting unasked.
 *
 * Nothing here is faked between the loop and the socket: `runUnattended`, the real executor, the
 * real gateway with its policy and settle step, the real HTTP client. Only the far end is a fixture —
 * a computer that takes its time over a click and counts the clicks that land, and that does what
 * `agent-computer` does with a request whose caller went away (stops, and answers 499).
 */

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type FakeComputer = {
  url: string;
  /** Acting requests that reached the computer at all. */
  received: () => number;
  /** Of those, the ones carried out: the caller was still there when the browser finished. */
  landed: () => number;
  stop: () => void;
};

/** A computer whose site takes `actMs` over every click and navigation. */
function startComputer(actMs: number): FakeComputer {
  let received = 0;
  let landed = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/snapshot") {
        return Response.json({
          snapshotId: 1,
          url: "https://pay.example/checkout",
          title: "결제",
          truncated: false,
          elements: [{ ref: "e1", role: "button", name: "결제하기" }],
        });
      }
      if (pathname === "/click" || pathname === "/navigate") {
        received += 1;
        await Promise.race([
          sleep(actMs),
          new Promise((resolve) =>
            request.signal.addEventListener("abort", resolve, { once: true }),
          ),
        ]);
        if (request.signal.aborted) {
          return Response.json(
            { error: "Stopped.", stopped: true },
            { status: 499 },
          );
        }
        landed += 1;
        return Response.json({
          action: pathname.slice(1),
          url: "https://pay.example/done",
          title: "완료",
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

const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
/** Every action asks, so the owner's instruction is consulted before anything happens. */
const ASKS: ActionPolicy = { deny: [], ask: ["true"], allow: ["true"] };

const actor = { id: "person-1", userId: "person-1" };

async function gatewayFor(
  computer: FakeComputer,
  options: {
    policy: ActionPolicy;
    autoReviewMs?: number;
  },
): Promise<ComputerGateway> {
  const gateway = createComputerGateway({
    client: createComputerClient({
      baseUrl: computer.url,
      token: "test-token",
      allowPrivateHosts: true,
    }),
    auditStore: { insert: async () => {} },
    policy: () => options.policy,
    ...(options.autoReviewMs === undefined
      ? {}
      : {
          // The owner's own instruction, judged by a model that takes its time over it.
          autoReview: async () => {
            await sleep(options.autoReviewMs as number);
            return { allowed: true, reason: "결제는 허락했다" };
          },
        }),
  });
  // The page the Bot is looking at, as the real flow has it before any click.
  await gateway.snapshot("bot-1");
  return gateway;
}

/** A model that asks for one call — its arguments exactly as written — and then reports. */
function agentCalling(name: string, rawArguments: string): LoopAgent {
  const turns: Message[] = [
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name, arguments: rawArguments },
        },
      ],
    },
    { id: "a2", role: "assistant", content: "결제했다." },
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

describe("a routine's deadline and the Bot's computer", () => {
  const computers: FakeComputer[] = [];
  afterAll(() => {
    for (const computer of computers) computer.stop();
  });

  async function runAgainst(
    gateway: ComputerGateway,
    call: { name: string; args: object },
    timeoutMs: number,
  ) {
    const toolkit = await createUnattendedTools({ gateway })("bot-1", actor);
    return runUnattended(
      agentCalling(call.name, JSON.stringify(call.args)),
      "결제해 줘",
      {
        toolkit,
        timeoutMs,
        mode: "routine",
      },
    );
  }

  test("a click still being decided when the deadline passes never reaches the computer", async () => {
    const computer = startComputer(10);
    computers.push(computer);
    // The judge answers yes at 150 ms; the routine's time is up at 60.
    const gateway = await gatewayFor(computer, {
      policy: ASKS,
      autoReviewMs: 150,
    });

    await expect(
      runAgainst(
        gateway,
        { name: "computer_click", args: { ref: "e1", snapshotId: 1 } },
        60,
      ),
    ).rejects.toThrow("did not finish in time");

    // Long after the yes arrived and the click would have gone out.
    await sleep(300);
    expect(computer.received()).toBe(0);
    expect(computer.landed()).toBe(0);
  });

  test("a click in flight when the deadline passes is abandoned at the socket and does not land", async () => {
    // The site takes 300 ms over the click; the routine's time is up at 60.
    const computer = startComputer(300);
    computers.push(computer);
    const gateway = await gatewayFor(computer, { policy: PERMISSIVE });

    await expect(
      runAgainst(
        gateway,
        { name: "computer_click", args: { ref: "e1", snapshotId: 1 } },
        60,
      ),
    ).rejects.toThrow("did not finish in time");

    await sleep(450);
    // It left before the deadline, so it reached the computer — and the computer was told to stop.
    expect(computer.received()).toBe(1);
    expect(computer.landed()).toBe(0);
  });

  test("a navigation in flight is abandoned the same way", async () => {
    const computer = startComputer(300);
    computers.push(computer);
    const gateway = await gatewayFor(computer, { policy: PERMISSIVE });

    await expect(
      runAgainst(
        gateway,
        { name: "computer_navigate", args: { url: "https://pay.example/" } },
        60,
      ),
    ).rejects.toThrow("did not finish in time");

    await sleep(450);
    expect(computer.received()).toBe(1);
    expect(computer.landed()).toBe(0);
  });

  test("the same click with time to spare lands, once", async () => {
    // The counter can count: without a deadline in the way, the slow site finishes the click.
    const computer = startComputer(80);
    computers.push(computer);
    const gateway = await gatewayFor(computer, {
      policy: ASKS,
      autoReviewMs: 20,
    });

    const result = await runAgainst(
      gateway,
      { name: "computer_click", args: { ref: "e1", snapshotId: 1 } },
      5_000,
    );

    expect(result.answer).toBe("결제했다.");
    expect(computer.received()).toBe(1);
    expect(computer.landed()).toBe(1);
  });
});
