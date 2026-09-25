import { describe, expect, test } from "bun:test";
import { buildAgents } from "../src/copilot";

/**
 * What actually leaves this deployment and reaches a model, through both halves at once.
 *
 * `copilot.test.ts` asserts what the middleware builds and `agent-bot/tests` asserts what that
 * service does with what it is handed. Neither can see the seam between them, and the seam is
 * where every failure this file exists for has happened: a setting that saved, showed its ring and
 * changed nothing about the request; a prompt one side thought the other was sending.
 *
 * So the two are wired together in one process. The server's agent map is built with a "stall
 * guard" whose watched fetch does not open a socket — it hands the AG-UI request body straight to
 * `agent-bot`'s own `runAgent`, whose provider is a fake that records the request. What that fake
 * receives is, byte for byte, what an OpenAI-compatible endpoint would have received.
 *
 * No credential and no network: the fake provider is the model.
 */

type ProviderRequest = {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  reasoning_effort?: string;
};

/**
 * One chunk of a chat completion, as much of it as this file uses.
 *
 * Written out rather than imported from `openai`. That package is `agent-bot`'s dependency, not
 * this workspace's, so the import resolved to nothing here — invisible while the type was erased
 * before Bun ever ran the file, and a hard error the moment `server/tests` was typechecked.
 */
type CompletionChunk = {
  choices: { delta: { content?: string }; finish_reason: string | null }[];
};

/** An empty stream. The request is the assertion; nothing is expected to come back. */
function emptyCompletion() {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        choices: [{ delta: { content: "네." }, finish_reason: "stop" }],
      } satisfies CompletionChunk;
    },
  };
}

const bot = {
  id: "agent_shop",
  name: "미소",
  type: "remote_ag_ui" as const,
  endpoint: "http://agent-bot.internal/ag-ui",
  profile: {
    id: "agent_shop",
    name: "미소",
    title: "가게 운영 도우미",
    roleDescription: "주문과 영수증을 챙긴다.",
    memories: ["일요일은 쉰다."],
  },
  effort: "thorough" as const,
};

/**
 * One turn, all the way through, and the provider request it produced.
 *
 * `forwardedProps` here is what a CALLER forwards — a room, a routine, or nothing at all for a
 * chat — not the Bot's own settings, which the middleware adds on the way past.
 */
async function requestFor(
  supportsEffort = true,
  forwardedProps: Record<string, unknown> = {},
): Promise<ProviderRequest> {
  /*
   * Set before the import, not after. `agent-bot` builds its OpenAI client at module scope, and
   * the client throws on construction with no key — so a static import at the top of this file
   * takes the whole suite down before a single test runs. The key is the string "test-key" and
   * nothing is ever sent anywhere: the fake provider below is the model.
   */
  // The machine's .env names the deployment's model, and the effort words are per model: a
  // checkout with BOT_MODEL=glm-5.3 read `max` where CI read `high` (2026-09-25). Pin it.
  process.env.BOT_MODEL = "";
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../../agent-bot/src/index");
  let sent: ProviderRequest = {};

  const agents = buildAgents(
    [bot],
    { provider: "openai", defaultModel: "laf-1", supportsEffort },
    {
      // Not a socket: the other service, in this process, reached through its public entry point.
      watch: () =>
        (async (_url: unknown, init?: { body?: unknown }) => {
          const input = JSON.parse(String(init?.body ?? "{}"));
          return runAgent(input, (async (request: ProviderRequest) => {
            sent = request;
            return emptyCompletion();
          }) as never);
        }) as never,
      stop: () => undefined,
    },
  );

  const agent = agents.agent_shop;
  agent?.setMessages([
    { id: "m1", role: "user", content: "오늘 주문 확인해줘" },
  ]);
  await agent?.runAgent({ forwardedProps } as never).catch(() => {});
  return sent;
}

describe("what reaches the model", () => {
  test("the whole prompt, composed by the server, as one system message", async () => {
    const request = await requestFor();
    const system = (request.messages ?? []).filter(
      (message) => message.role === "system",
    );

    // ONE. Two would mean `agent-bot` had started carrying a prompt of its own again.
    expect(system).toHaveLength(1);
    const prompt = system[0]?.content ?? "";
    expect(prompt).toContain("이 배포의 언어는 한국어다");
    // The name, and no job title after it: the profile is a name and a face (2026-09-24).
    expect(prompt).toContain("너는 미소다.");
    expect(prompt).toContain("주문과 영수증을 챙긴다.");
    expect(prompt).toContain("일요일은 쉰다.");
    // And the conversation is behind it, unchanged.
    expect(request.messages?.at(-1)).toEqual({
      role: "user",
      content: "오늘 주문 확인해줘",
    });
  });

  /**
   * The date line, from the server clock — the date and never the minute, which is the `now`
   * tool's (`context/conversations.ts`: an epoch freezes the date, a new day is a reminder).
   */
  test("today's date, on the Korean wall clock", async () => {
    const prompt =
      (await requestFor()).messages?.find(
        (message) => message.role === "system",
      )?.content ?? "";

    const expected = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .filter((part) => ["year", "month", "day"].includes(part.type))
      .map((part) => part.value);

    expect(prompt).toContain(`오늘은 ${expected.join("-")} (`);
    expect(prompt).toContain("Asia/Seoul(KST) 기준");
  });

  test("the effort, translated by the service that speaks that API", async () => {
    // `thorough` on the wire between the two services; the model's own word on the wire to the
    // provider. Which word depends on the model agent-bot read at import — another file in this
    // process may have imported it first with the machine's BOT_MODEL — so ask agent-bot's table
    // rather than hard-coding one model's spelling.
    const { MODEL } = await import("../../agent-bot/src/provider");
    const { reasoningEffortOf } = await import(
      "../../agent-bot/src/transcript"
    );
    const expected = reasoningEffortOf(
      { forwardedProps: { effort: "thorough" } } as never,
      MODEL,
    );
    const sent = await requestFor(true);
    if (expected === undefined) {
      // A model that defines no effort of its own (MiMo-V2.6) is sent none, whatever was asked.
      expect(sent).not.toHaveProperty("reasoning_effort");
      return;
    }
    expect(expected === "high" || expected === "max").toBe(true);
    expect(sent.reasoning_effort).toBe(expected);
  });

  test("no effort at all where the deployment's model takes none", async () => {
    // A model that does not reason answers a request carrying this with a 400 on some providers
    // and silence on others, so it must be absent — not defaulted, not null.
    expect(await requestFor(false)).not.toHaveProperty("reasoning_effort");
  });

  test("the mode a caller forwarded, which is what selects the prompt", async () => {
    const routine =
      (await requestFor(true, { mode: "routine" })).messages?.find(
        (message) => message.role === "system",
      )?.content ?? "";
    expect(routine).toContain("화면 앞에는 아무도 없다");
  });
});
