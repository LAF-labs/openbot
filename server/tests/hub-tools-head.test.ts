import { describe, expect, test } from "bun:test";
import { staticPrompt } from "../../shared/prompt";
import { COMPUTER_TOOLS } from "../../shared/tools/computer";
import { SELF_TOOLS } from "../../shared/tools/self";
import { SKILL_VIEW } from "../../shared/tools/skills";
import type { AgentStandingProfile } from "../src/copilot";
import { buildAgents, toolsFingerprint } from "../src/copilot";
import { createConversationStore } from "../src/context/conversations";
import { HUB_TOOLS, HUB_TOOLS_KEY } from "../src/hub/tools";
import { createDeploymentKeyRuntime } from "../src/plugins/deployment-key-runtime";
import { DEPLOYMENT_KEY_SERVICES } from "../src/plugins/deployment-key-services";
import { deploymentKeysFrom } from "../src/plugins/shared-clients";
import { toolNameFor } from "../src/plugins/store";

/**
 * The company hub's two tools change nothing at the head of the prompt.
 *
 * Measured where it is paid for: on the request the provider receives. The server's middleware and
 * `agent-bot` run in one process (`conversation-epochs.test.ts`'s harness), and the same turn is
 * sent twice — once with the tools a VM in no company offers, once with the hub's two beside them,
 * the way a turn lists a plugin's tools (`turns/chat-tools.ts`). The tools the model is sent and the
 * static layer of the system message must be the same bytes, and the epoch key the same; what moves
 * is one line of the context layer, under 회사.
 */

type ProviderRequest = {
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
};

const profile: AgentStandingProfile = {
  id: "agent_hub",
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

/** What a turn on a VM in no company lists: the core tools and a deployment's own. */
const ALONE = [
  ...COMPUTER_TOOLS.map(wire),
  ...SELF_TOOLS.map(wire),
  wire(SKILL_VIEW),
];

/** The hub's tools as the plugin listing names them: `mcp__hub__read`, `mcp__hub__write`. */
const HUB_WIRE = HUB_TOOLS.map((tool) =>
  wire({ ...tool, name: toolNameFor(`${HUB_TOOLS_KEY}/${tool.name}`) }),
);

async function sent(tools: unknown[]): Promise<ProviderRequest> {
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
  agent.threadId = "thread_hub";
  agent.setMessages([
    { id: "u0", role: "user", content: "팀 자료에서 견적 찾아 줘" },
  ] as never);
  await agent.runAgent({ tools, forwardedProps: {} } as never).catch(() => {});
  return request;
}

const systemOf = (request: ProviderRequest) =>
  request.messages.find((message) => message.role === "system")?.content ?? "";

describe("the hub's tools and the head of the prompt", () => {
  test("the tools sent and the static layer are the same bytes with and without the hub", async () => {
    const alone = await sent(ALONE);
    const joined = await sent([...ALONE, ...HUB_WIRE]);

    expect(alone.tools?.length).toBeGreaterThan(0);
    expect(JSON.stringify(joined.tools)).toBe(JSON.stringify(alone.tools));
    expect(JSON.stringify(joined.tools)).not.toContain("mcp__hub__");

    const head = staticPrompt("chat");
    expect(systemOf(alone).startsWith(head)).toBe(true);
    expect(systemOf(joined).startsWith(head)).toBe(true);

    // What moved is the context layer, and only by the company's line.
    expect(systemOf(joined)).toContain(
      "- 회사: mcp__hub__read, mcp__hub__write",
    );
    expect(systemOf(alone)).not.toContain("mcp__hub__");
  });

  test("the epoch key does not move: the hub's tools are not counted as the head", () => {
    expect(toolsFingerprint([...ALONE, ...HUB_WIRE])).toBe(
      toolsFingerprint(ALONE),
    );
  });
});

describe("a VM without the hub lines lists no hub tool at all", () => {
  test("the pass is what says whether the entry and its tools exist", () => {
    const without = createDeploymentKeyRuntime({
      keys: deploymentKeysFrom({}),
      services: DEPLOYMENT_KEY_SERVICES,
      listBots: async () => [],
    });
    expect(without.has(HUB_TOOLS_KEY)).toBe(false);
    expect(without.toolNames).not.toContain("read");
    expect(without.transports["laf-hub"]).toBeUndefined();

    const joined = createDeploymentKeyRuntime({
      keys: deploymentKeysFrom({ LAF_HUB_VM_KEY: "a".repeat(64) }),
      services: DEPLOYMENT_KEY_SERVICES,
      listBots: async () => [],
    });
    expect(joined.has(HUB_TOOLS_KEY)).toBe(true);
    expect(joined.toolNames).toEqual(expect.arrayContaining(["read", "write"]));
    expect(joined.transports["laf-hub"]).toBeDefined();
  });
});
