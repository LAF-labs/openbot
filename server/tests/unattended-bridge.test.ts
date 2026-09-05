import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import type { CompletionProvider } from "../../agent-bot/src/index";
import { listTools as gmailTools } from "../src/plugins/gmail-rest";
import { toolNameFor } from "../src/plugins/store";
import {
  runUnattended,
  type UnattendedToolkit,
} from "../src/runner/unattended";

/**
 * A routine reaching a connected service through the bridge, over the real wire.
 *
 * The agent-bot tests read the SSE this service writes; this reads it the way the product does —
 * `@ag-ui/client`'s `HttpAgent`, the same class `copilot.ts` builds for every Bot, driving the
 * real unattended loop. What it proves is the contract between the two: a lookup answered inside
 * the run lands in the thread as an answered call, a `tool_call` reaches the loop's executor in the
 * real tool's name with the real arguments, and the step record says what happened in that order.
 *
 * Offline: agent-bot is served on an ephemeral port with a scripted model behind it.
 */

type Chunk = {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>;
};

/*
 * Typed through agent-bot's own seam rather than `openai`: the server workspace never declared
 * that package, so a type import of it resolved on one machine's hoisted install and on no other —
 * the typecheck went red the first time it ran in a clean worktree.
 */
function completion(chunks: Chunk[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Awaited<ReturnType<CompletionProvider>>;
}

const said = (text: string): Chunk[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];

const call = (id: string, name: string, args: object): Chunk[] => [
  {
    choices: [
      { delta: { tool_calls: [{ index: 0, id, function: { name } }] } },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

const MAIL = {
  to: "kim@shop.kr",
  subject: "9월 정산서",
  body: "정산 내역 확인 부탁드립니다.",
};

/** What the model says on each request: look, call through the bridge, then answer. */
const SCRIPTS: Chunk[][] = [
  call("look", "tool_search", { query: "메일 보내기" }),
  call("send", "tool_call", { name: "mcp__gmail__send_message", args: MAIL }),
  said("kim@shop.kr에게 보냈다."),
];

describe("a routine reaching Gmail through the bridge", () => {
  const requests: Array<{
    tools?: Array<{ function: { name: string } }>;
  }> = [];
  let server: ReturnType<typeof Bun.serve>;
  let url = "";

  beforeAll(async () => {
    // agent-bot builds its OpenAI client at import time and the client refuses an absent key.
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../../agent-bot/src/index");
    server = Bun.serve({
      port: 0,
      fetch: async (request) =>
        runAgent(await request.json(), async (sent) => {
          requests.push(sent as (typeof requests)[number]);
          return completion(SCRIPTS[requests.length - 1] ?? said("…"));
        }),
    });
    url = `http://127.0.0.1:${server.port}/`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("the real tool runs, in its real name, with the real arguments", async () => {
    const executed: Array<[string, Record<string, unknown>]> = [];
    const gmail = await gmailTools({ url: "" });
    const toolkit: UnattendedToolkit = {
      tools: [
        {
          name: "computer_navigate",
          description: "open",
          parameters: { type: "object", properties: {} },
        },
        ...gmail.map((tool) => ({
          name: toolNameFor(`gmail/${tool.name}`),
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      ],
      execute: async (name, args) => {
        executed.push([name, args]);
        return { ok: true, text: "sent" };
      },
    };

    const agent = new HttpAgent({ url });
    const result = await runUnattended(
      agent,
      "kim@shop.kr에 정산서 확인 메일 보내줘",
      { toolkit, timeoutMs: 10_000, mode: "routine" },
    );

    // The executor saw a direct call to Gmail's own tool. Nothing about the bridge reached it.
    expect(executed).toEqual([["mcp__gmail__send_message", MAIL]]);
    expect(result.answer).toBe("kim@shop.kr에게 보냈다.");

    // The model was offered the bridge, not Gmail's four tools.
    expect(requests[0]?.tools?.map((entry) => entry.function.name)).toEqual([
      "computer_navigate",
      "tool_search",
      "tool_describe",
      "tool_call",
    ]);

    // The lookup is in the thread as an answered call, filed by the client from TOOL_CALL_RESULT.
    const answer = agent.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "look",
    );
    expect(String(answer?.content)).toContain("mcp__gmail__send_message");

    // The record: the lookup went through, then the send went through — each in its own slot.
    expect(result.steps[0]?.calls).toEqual([
      { name: "tool_search", ok: true },
      { name: "mcp__gmail__send_message", ok: true },
    ]);
    // Two runs, three model requests: the lookup round and the call round share the first run.
    expect(requests).toHaveLength(3);
    expect(result.steps).toHaveLength(2);
  });
});
