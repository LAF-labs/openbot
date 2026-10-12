import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import type { CompletionProvider } from "../../agent-bot/src/index";
import { listTools as gmailTools } from "../src/plugins/gmail-rest";
import { toolNameFor } from "../src/plugins/store";
import { PUBLIC_DATA_TOOLS } from "../src/plugins/public-data-rest";
import {
  createUnattendedTools,
  runUnattended,
  type UnattendedToolkit,
} from "../src/runner/unattended";
import { CONNECT_CARD, GALLERY_DECISIONS } from "../../shared/tools/gallery";

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
    // In one sorted order, with `now`, which agent-bot answers itself on every run.
    expect(requests[0]?.tools?.map((entry) => entry.function.name)).toEqual([
      "computer_navigate",
      "now",
      "tool_call",
      "tool_search",
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

/*
 * A ROUTINE ASKED FOR A CALENDAR NOBODY CONNECTED (2026-10-05).
 *
 * In a chat that lookup is answered with what could be connected and the connect card
 * (`searchResultText`, `shared/tools/bridge.ts`), read off the card the turn handed on. A routine
 * has nobody to press one, and is handed none: its tools are the computer's, its grants and
 * `skill_view` (`createUnattendedTools`). So the lookup says nothing of connecting — there is no
 * such tool, nothing is connected, do not look again — and a Bot that asks for the card anyway,
 * remembering one from a chat, is told there is no such tool, inside the run, with nothing
 * reaching the executor.
 */
describe("a routine asked for a calendar nobody connected", () => {
  const scripts: Chunk[][] = [
    call("look", "tool_search", { query: "캘린더 일정 확인" }),
    call("card", "tool_call", {
      name: CONNECT_CARD,
      args: { services: ["google-calendar"] },
    }),
    said("오늘 일정은 확인하지 못했다. 연결된 캘린더가 없다."),
  ];
  const requests: unknown[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let url = "";

  beforeAll(async () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../../agent-bot/src/index");
    server = Bun.serve({
      port: 0,
      fetch: async (request) =>
        runAgent(await request.json(), async (sent) => {
          requests.push(sent);
          return completion(scripts[requests.length - 1] ?? said("…"));
        }),
    });
    url = `http://127.0.0.1:${server.port}/`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("is handed no card, told not to look again, and reaches nothing by asking for one", async () => {
    const called: string[] = [];
    /* What a routine's Bot holds with nothing connected: what runs on the fleet's own key. */
    const pluginStore = {
      offeredToModel: async () => ({
        tools: PUBLIC_DATA_TOOLS.map((tool) => ({
          ref: `public-data/${tool.name}`,
          toolName: toolNameFor(`public-data/${tool.name}`),
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        skills: [],
      }),
      callTool: async (input: { ref: string }) => {
        called.push(input.ref);
        return { text: "[]", isError: false };
      },
      viewSkill: async () => ({
        allowed: false as const,
        reason: "laf:skill_not_granted",
      }),
    } as unknown as NonNullable<
      Parameters<typeof createUnattendedTools>[0]["pluginStore"]
    >;
    const toolkit = await createUnattendedTools({ pluginStore })("bot-1", {
      id: "owner-1",
    });
    // No card of any kind: nothing that waits on a person is among a routine's tools.
    const names = toolkit.tools.map((tool) => tool.name);
    expect(names).not.toContain(CONNECT_CARD);
    expect(names.filter((name) => GALLERY_DECISIONS.has(name))).toEqual([]);

    const agent = new HttpAgent({ url });
    const result = await runUnattended(
      agent,
      "오늘 내 일정을 확인해서 알려줘.",
      {
        toolkit,
        timeoutMs: 10_000,
        mode: "routine",
      },
    );

    const answerTo = (id: string) =>
      String(
        agent.messages.find(
          (message) => message.role === "tool" && message.toolCallId === id,
        )?.content,
      );
    // The lookup: a miss with no card in it — no card's name, no schema, no second look. What
    // runs on the fleet's key is nobody's connection, so nothing is said to be connected.
    expect(answerTo("look")).toBe(
      [
        "'캘린더 일정 확인'에 맞는 도구가 없다.",
        "지금 연결된 서비스는 없다.",
        "다시 찾지 않는다. 지금 쓸 수 있는 도구로 하거나, 할 수 없다고 사람에게 말한다.",
      ].join("\n"),
    );
    // Asked for by name all the same, the card is a tool this run does not have.
    expect(answerTo("card")).toContain(`'${CONNECT_CARD}'이라는 도구는 없다`);
    // Nothing reached the executor, and the routine's answer says what it could not do.
    expect(called).toEqual([]);
    expect(result.steps.flatMap((step) => step.calls)).toEqual([
      { name: "tool_search", ok: true },
      { name: "tool_call", ok: true },
    ]);
    expect(result.answer).toBe(
      "오늘 일정은 확인하지 못했다. 연결된 캘린더가 없다.",
    );
    expect(requests).toHaveLength(3);
  });
});
