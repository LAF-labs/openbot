import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { builtInAgentConfiguration } from "../src/copilot";

/**
 * That the effort setting actually leaves the process.
 *
 * `copilot.test.ts` asserts the configuration object, which is everything this codebase writes and
 * not the thing anybody cares about. `providerOptions` is a contract with somebody else's library:
 * if the runtime stopped forwarding it — a version bump, a renamed key — the control on the profile
 * would keep saving, keep showing the ring, and change nothing about how the Bot answers. A setting
 * that lies is the one failure this whole feature was built to avoid, so the wire is what is
 * checked.
 *
 * No credential is involved. The base URL points at a server started here, the key is the string
 * "test-key", and the sink answers with a refusal — the request is the assertion, and nothing is
 * expected to come back.
 */

const received: Array<Record<string, unknown>> = [];
let sink: ReturnType<typeof Bun.serve> | undefined;
let previousBaseUrl: string | undefined;

beforeAll(() => {
  sink = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push(
        (await request.json().catch(() => ({}))) as Record<string, unknown>,
      );
      // Refused rather than answered: a streaming response would have to be faked convincingly, and
      // the request has already been recorded by the time this returns.
      return Response.json({ error: { message: "sink" } }, { status: 400 });
    },
  });
  previousBaseUrl = process.env.OPENAI_BASE_URL;
  // How this deployment already reaches OpenRouter: the SDK takes the base URL from the environment,
  // which is what lets a test stand somewhere else without any of the code under test knowing.
  process.env.OPENAI_BASE_URL = `http://localhost:${sink.port}/v1`;
});

afterAll(() => {
  if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previousBaseUrl;
  sink?.stop(true);
});

const bot = {
  id: "analyst",
  name: "Analyst",
  type: "built_in" as const,
  standing: "You are Analyst.",
  systemPrompt: "Be careful.",
};

/** Run one turn against the sink and hand back the body it received. */
async function bodySentFor(
  effort: "quick" | "balanced" | "thorough",
  supportsEffort: boolean,
) {
  received.length = 0;
  const agent = new BuiltInAgent(
    builtInAgentConfiguration(
      { ...bot, effort },
      // A NAME THE PROVIDER DOES NOT RECOGNISE, deliberately. Its own heuristic sends an effort for
      // `gpt-5` and drops it for everything else, so a test written against `gpt-5` would pass
      // while the deployment's real model — served by us, under a name only we choose — silently
      // sent nothing. See `forceReasoning` in `builtInAgentConfiguration`.
      { provider: "openai", defaultModel: "laf-1", supportsEffort },
      "test-key",
    ),
  );
  await agent
    .runAgent({
      messages: [{ id: "m1", role: "user", content: "Hello" }],
    })
    // The sink refuses, so this rejects. The request is what was being tested.
    .catch(() => {});
  return received[0];
}

describe("the effort setting", () => {
  test("reaches the model provider", async () => {
    /*
     * `reasoning: { effort }`, not `reasoning_effort`: the runtime calls the Responses API, which
     * nests it. The first version of this test asserted the chat-completions spelling and failed
     * against a request that was carrying the setting perfectly well — a small lesson about
     * checking the wire rather than the intention.
     *
     * The field alone rather than the whole body, which also carries the tools and the messages.
     */
    expect((await bodySentFor("thorough", true))?.reasoning).toEqual({
      effort: "high",
    });
    expect((await bodySentFor("quick", true))?.reasoning).toEqual({
      effort: "low",
    });
  });

  test("is absent from the request where the model takes none", async () => {
    // Not sent as a default, not sent as null. A model that does not reason must receive exactly
    // what it received before this feature existed.
    const body = await bodySentFor("thorough", false);
    expect(body).toBeDefined();
    expect(body).not.toHaveProperty("reasoning");
  });
});
