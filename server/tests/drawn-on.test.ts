import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createPluginRoutes } from "../src/plugins/routes";
import type { PluginStore } from "../src/plugins/store";
import { createUnattendedTools } from "../src/runner/unattended";
import { createChatTools } from "../src/turns/chat-tools";
import { createPersonAnswers } from "../src/turns/people";

/**
 * WHERE A CALL'S ANSWER WILL BE DRAWN IS SAID BY THE DOOR THE CALL CAME IN THROUGH (`DrawnOn`,
 * `plugins/transport.ts`).
 *
 * Two things hang on it inside the store: whether a code withheld from a mail is kept to be shown
 * on the call's row (`plugin-mail-secrets.integration.test.ts`), and whether the weather tool says
 * its forecast is on the screen as a card (`kma-weather-rest.test.ts`). Those hold what each value
 * does; these hold that each of the three doors hands the value it should — a routine's call most of
 * all, since nothing of it is drawn and a routine told otherwise would say one vague sentence about
 * a card nobody has.
 */

const REF = "kma-weather/get_weather";
const TOOL_NAME = "mcp__kma-weather__get_weather";

type CallInput = Parameters<PluginStore["callTool"]>[0];

/** A store whose one tool answers anything, and which keeps what every call was handed. */
function recordingStore() {
  const calls: CallInput[] = [];
  const store = {
    listForAgent: async () => ({
      tools: [
        {
          ref: REF,
          toolName: TOOL_NAME,
          description: "날씨",
          inputSchema: { type: "object" },
        },
      ],
      skills: [],
    }),
    callTool: async (input: CallInput) => {
      calls.push(input);
      return { text: "{}", isError: false };
    },
    viewSkill: async () => ({
      allowed: false as const,
      reason: "laf:skill_not_granted",
    }),
  };
  return { store, calls };
}

describe("where a call's answer is drawn", () => {
  test("a chat turn's call is a line of the conversation", async () => {
    const { store, calls } = recordingStore();
    const toolkit = await createChatTools({
      people: createPersonAnswers(),
      pluginStore: store as unknown as Parameters<
        typeof createChatTools
      >[0]["pluginStore"],
    })(
      {
        botId: "bot-1",
        owner: { id: "owner-1", role: "user" },
        threadId: "thread-1",
        runId: "run-1",
      },
      [{ name: TOOL_NAME, description: TOOL_NAME, parameters: {} }],
    );
    await toolkit.execute(
      TOOL_NAME,
      {},
      { id: "call-1", signal: new AbortController().signal },
    );
    expect(calls.map((call) => call.drawnOn)).toEqual(["conversation"]);
  });

  test("a routine's call is drawn nowhere", async () => {
    const { store, calls } = recordingStore();
    const toolkit = await createUnattendedTools({ pluginStore: store })(
      "bot-1",
      { id: "person-1", userId: "person-1" },
    );
    await toolkit.execute(TOOL_NAME, {});
    expect(calls.map((call) => call.drawnOn)).toEqual(["nowhere"]);
  });

  test("the app's own call is a line of the conversation it was made from", async () => {
    const { store, calls } = recordingStore();
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "person-1",
        email: "person-1@laf.test",
        role: "user",
      });
      context.set("mayDriveBot", async () => true);
      await next();
    };
    const app = new Hono().route(
      "/api/plugins",
      createPluginRoutes(store as unknown as PluginStore, requireUser),
    );
    const response = await app.request("http://t/api/plugins/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: REF, args: {}, agentId: "bot-1" }),
    });
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.drawnOn)).toEqual(["conversation"]);
  });
});
