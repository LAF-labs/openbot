import { describe, expect, test } from "bun:test";
import { staticPrompt } from "../../shared/prompt";
import { COMPUTER_TOOLS } from "../../shared/tools/computer";
import { SELF_TOOLS } from "../../shared/tools/self";
import { SKILL_VIEW } from "../../shared/tools/skills";
import type { AgentStandingProfile } from "../src/copilot";
import { buildAgents } from "../src/copilot";
import { createConversationStore } from "../src/context/conversations";
import { HUB_TOOLS, HUB_TOOLS_KEY } from "../src/hub/tools";
import { toolNameFor } from "../src/plugins/store";

/**
 * A room's turn changes nothing at the head of the prompt (`hub/room-answers.ts`).
 *
 * Measured where it is paid for, on the request the provider receives, with the harness
 * `hub-tools-head.test.ts` uses: the server's middleware and `agent-bot` in one process. The same
 * VM's turn is sent twice — once as a chat turn, once as a room's: the person's words, the server's
 * read of the room filed as the first step, and its result. The tools sent and the system message
 * are the same bytes; the room's words are in the tool result and nowhere else.
 */

type ProviderRequest = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
};

const profile: AgentStandingProfile = {
  id: "agent_room",
  name: "미소",
  roleDescription: "",
  memories: [],
  person: { timeZone: "Asia/Seoul", locale: "ko-KR" },
};

const wire = (tool: {
  name: string;
  description: string;
  inputSchema?: unknown;
  parameters?: unknown;
}) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters ?? tool.inputSchema ?? {},
});

/** A VM in a company: the core tools, a deployment's own, and the hub's two. */
const TOOLS = [
  ...COMPUTER_TOOLS.map(wire),
  ...SELF_TOOLS.map(wire),
  wire(SKILL_VIEW),
  ...HUB_TOOLS.map((tool) =>
    wire({ ...tool, name: toolNameFor(`${HUB_TOOLS_KEY}/${tool.name}`) }),
  ),
];

/** A line of the room nobody would type in a chat: where it shows up is what is measured. */
const ROOM_LINE = "회의실 B는 3시부터 비어 있어요";

const QUESTION = { id: "room:r_1:2", role: "user", content: "@라피 오늘 날짜" };
const ROOM_TURN = [
  QUESTION,
  {
    id: "a-move",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call_room",
        type: "function",
        function: {
          name: "mcp__hub__read",
          arguments: JSON.stringify({ kind: "room", id: "r_1" }),
        },
      },
    ],
  },
  {
    id: "t-move",
    role: "tool",
    toolCallId: "call_room",
    content: JSON.stringify({
      source: "회사",
      kind: "room",
      id: "r_1",
      messages: [
        { seq: 2, by: "m:m_kim", text: "@라피 오늘 날짜", mentions: ["lafi"] },
        { seq: 1, by: "m:m_park", text: ROOM_LINE, mentions: [] },
      ],
    }),
  },
];

async function sent(messages: unknown[]): Promise<ProviderRequest> {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../../agent-bot/src/index");
  let request: ProviderRequest = { messages: [] };
  const agents = buildAgents(
    [
      {
        id: profile.id,
        name: profile.name,
        type: "remote_ag_ui",
        endpoint: "http://agent-bot.internal/ag-ui",
        profile,
      },
    ],
    {
      provider: "openai",
      defaultModel: "z-ai/glm-5.3-flash",
      supportsEffort: true,
    },
    {
      watch: () =>
        (async (_url: unknown, init?: { body?: unknown }) =>
          runAgent(JSON.parse(String(init?.body ?? "{}")), (async (
            body: ProviderRequest,
          ) => {
            request = body;
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [
                    { delta: { content: "네." }, finish_reason: "stop" },
                  ],
                };
              },
            };
          }) as never)) as never,
      stop: () => undefined,
    },
    "Asia/Seoul",
    undefined,
    { conversations: createConversationStore() },
  );
  const agent = agents[profile.id];
  if (!agent) throw new Error("no agent was built");
  agent.threadId = "thread_room";
  agent.setMessages(messages as never);
  await agent
    .runAgent({ tools: TOOLS, forwardedProps: {} } as never)
    .catch(() => {});
  return request;
}

const systemOf = (request: ProviderRequest) =>
  String(
    request.messages.find((message) => message.role === "system")?.content ??
      "",
  );

describe("a room's turn and the head of the prompt", () => {
  test("the tools and the system message are the same bytes as a chat turn's; the room is a tool result", async () => {
    const chat = await sent([QUESTION]);
    const room = await sent(ROOM_TURN);

    expect(chat.tools?.length).toBeGreaterThan(0);
    expect(JSON.stringify(room.tools)).toBe(JSON.stringify(chat.tools));
    expect(systemOf(room).startsWith(staticPrompt("chat"))).toBe(true);
    expect(systemOf(room)).toBe(systemOf(chat));

    const holding = room.messages.filter((message) =>
      JSON.stringify(message.content ?? "").includes(ROOM_LINE),
    );
    expect(holding.map((message) => message.role)).toEqual(["tool"]);
    expect(systemOf(room)).not.toContain(ROOM_LINE);
  });
});
