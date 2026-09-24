import { describe, expect, test } from "bun:test";
import { NO_WHEREABOUTS, type Whereabouts } from "../../shared/whereabouts";
import {
  promptPersonOf,
  withPersonContext,
} from "../src/agents/person-context";
import { buildAgents, type RegisteredAgent } from "../src/copilot";

/**
 * Whose clock and whose place a run is told, on the wire.
 *
 * The Bot's browser runs on a cloud VM, and a Bot once told its owner the weather "in 제주시, 사장님
 * 위치" off a site's guess of the VM's place. What reaches the endpoint here is the person's: the zone
 * the device a chat run came from says, else the zone the person's last session kept (all a routine
 * has), else the deployment's; and the place the person set — never one a run's props claim.
 *
 * Driven through a real AG-UI endpoint, because what matters is the system message that leaves.
 */

const model = {
  provider: "openai" as const,
  defaultModel: "laf-1",
  supportsEffort: true,
};

function fakeAgUiEndpoint() {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const input = (await request.json()) as Record<string, unknown>;
      requests.push(input);
      const { threadId, runId } = input as { threadId: string; runId: string };
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "RUN_FINISHED", threadId, runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    requests,
    url: `http://localhost:${server.port}/ag-ui`,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}

function remoteBot(endpoint: string): RegisteredAgent {
  return {
    id: "bot_miso",
    name: "미소",
    type: "remote_ag_ui",
    endpoint,
    profile: { id: "bot_miso", name: "미소", roleDescription: "" },
    effort: "balanced",
  };
}

/** The loader every run path resolves through, wrapped as `main.ts` wraps it. */
async function loadedFor(endpoint: string, kept: Whereabouts) {
  const load = withPersonContext(
    async () => [remoteBot(endpoint)],
    async () => kept,
  );
  return load({ id: "owner", role: "user" });
}

async function systemMessageOf(
  endpoint: ReturnType<typeof fakeAgUiEndpoint>,
  registered: RegisteredAgent[],
  forwardedProps?: Record<string, unknown>,
) {
  const agent = buildAgents(
    registered,
    model,
    undefined,
    "Asia/Seoul",
  ).bot_miso;
  agent?.setMessages([{ id: "u1", role: "user", content: "지금 몇 시야?" }]);
  await agent?.runAgent(
    (forwardedProps ? { forwardedProps } : undefined) as never,
  );
  const messages = (endpoint.requests.at(-1)?.messages ?? []) as Array<{
    role: string;
    content: string;
  }>;
  return messages.find((message) => message.role === "system")?.content ?? "";
}

describe("the clock a run is told", () => {
  test("a chat run is on the zone its device says, not the deployment's", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const registered = await loadedFor(endpoint.url, {
      ...NO_WHEREABOUTS,
      timeZone: "Asia/Seoul",
    });
    const prompt = await systemMessageOf(endpoint, registered, {
      device: { timeZone: "Asia/Dubai", locale: "ko-KR" },
    });
    const clock = prompt.split("\n\n").at(-1) ?? "";
    expect(clock).toMatch(
      /^지금은 \d{4}-\d{2}-\d{2} \(.\) \d{2}:\d{2} Asia\/Dubai다 \(사장님 기기 시간대 Asia\/Dubai, 언어 ko-KR\)\.$/,
    );
    expect(clock).not.toContain("KST");
  });

  test("a routine, with no device, is on the zone the person's last session kept", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const registered = await loadedFor(endpoint.url, {
      ...NO_WHEREABOUTS,
      timeZone: "Asia/Dubai",
      locale: "ko-KR",
    });
    const clock =
      (await systemMessageOf(endpoint, registered, { mode: "routine" }))
        .split("\n\n")
        .at(-1) ?? "";
    expect(clock).toMatch(
      /^지금은 \d{4}-\d{2}-\d{2} \(.\) \d{2}:\d{2} Asia\/Dubai다/,
    );
  });

  test("somebody whose device never said is on the deployment's clock, and is not told it is theirs", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const registered = await loadedFor(endpoint.url, NO_WHEREABOUTS);
    const clock =
      (await systemMessageOf(endpoint, registered)).split("\n\n").at(-1) ?? "";
    expect(clock).toMatch(/KST다\.$/);
    expect(clock).not.toContain("사장님 기기");
  });

  test("a zone this runtime does not know is dropped, not handed to Intl mid-run", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const registered = await loadedFor(endpoint.url, {
      ...NO_WHEREABOUTS,
      timeZone: "Asia/Seoul",
    });
    const clock =
      (
        await systemMessageOf(endpoint, registered, {
          device: { timeZone: "Mars/Olympus" },
        })
      )
        .split("\n\n")
        .at(-1) ?? "";
    expect(clock).toContain("KST");
    expect(clock).toContain("Asia/Seoul");
  });
});

describe("the place a run is told", () => {
  test("the person's place, named, with the reason not to trust a site's", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const registered = await loadedFor(endpoint.url, {
      ...NO_WHEREABOUTS,
      place: "서울 강남구",
    });
    const prompt = await systemMessageOf(endpoint, registered);
    expect(prompt).toContain("사장님 가게 위치: 서울 강남구.");
    expect(prompt).toContain("네 컴퓨터가 있는 곳이지 사장님 위치가 아니다");
  });

  test("a run's props cannot name a place — it is the person's, kept on the account", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const registered = await loadedFor(endpoint.url, NO_WHEREABOUTS);
    const prompt = await systemMessageOf(endpoint, registered, {
      device: { timeZone: "Asia/Seoul", place: "제주시" },
      person: { place: "제주시" },
    });
    expect(prompt).not.toContain("제주시");
    expect(prompt).toContain("사장님 가게 위치는 아직 모른다");
    expect(prompt).toContain("remember의 place로 저장");
  });

  test("a routine that has no place says it could not, and does not ask a screen nobody is at", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const registered = await loadedFor(endpoint.url, NO_WHEREABOUTS);
    const prompt = await systemMessageOf(endpoint, registered, {
      mode: "routine",
    });
    expect(prompt).toContain("사장님 위치를 모른다");
    expect(prompt).not.toContain("여쭤보고");
  });

  test("a read that fails leaves the run on the deployment's clock, with the place unknown", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const load = withPersonContext(
      async () => [remoteBot(endpoint.url)],
      async () => {
        throw new Error("database gone");
      },
    );
    const registered = await load({ id: "owner", role: "user" });
    const prompt = await systemMessageOf(endpoint, registered);
    expect(prompt).toContain("사장님 가게 위치는 아직 모른다");
    expect(prompt.split("\n\n").at(-1)).toMatch(/KST다\.$/);
  });
});

describe("the kept facts as the prompt takes them", () => {
  test("a missing fact is absent, never an empty string", () => {
    expect(promptPersonOf(NO_WHEREABOUTS)).toEqual({});
    expect(
      promptPersonOf({
        timeZone: "Asia/Seoul",
        locale: "ko-KR",
        place: "서울 강남구",
        coordinates: { latitude: 37.5, longitude: 127.03 },
      }),
    ).toEqual({
      timeZone: "Asia/Seoul",
      locale: "ko-KR",
      place: "서울 강남구",
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
  });
});
