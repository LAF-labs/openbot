import { describe, expect, spyOn, test } from "bun:test";
import type OpenAI from "openai";

/**
 * What this service does to a transcript before it hands it to a model, and what it says about a
 * turn that did not come back whole.
 *
 * THESE WERE MISSING, and none of them was visible from a green gate:
 *
 * - `finish_reason: "length"` was never read, so an answer cut off mid-sentence was delivered as a
 *   finished one and the person had no way to know there had been more.
 * - An empty completion — a reasoning model that spent its whole budget deliberating — ended the
 *   run with RUN_FINISHED and no text, which every reader downstream takes for a Bot that chose to
 *   say nothing. In a room that is a legitimate silence; in a chat it is a Bot ignoring you.
 * - There was no request timeout at all.
 *
 * And one thing that was here and is gone on purpose: a cut of older tool results, which rewrote
 * the conversation under the provider's cache on every step (see "the transcript" below).
 */

type Chunk = {
  choices?: Array<{
    delta?: Record<string, unknown>;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

function completion(chunks: Chunk[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
}

const said = (text: string, finish = "stop"): Chunk[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: finish }] },
];

/** One message the surface would have appended after executing a tool call. */
const toolResult = (id: string, text: string) => ({
  id: `t_${id}`,
  role: "tool",
  toolCallId: id,
  content: JSON.stringify({ ok: true, text }),
});

/** Run one turn against a scripted provider; hand back the requests it made and the events out. */
async function turnFor(
  messages: unknown[],
  scripts: Chunk[][],
  forwardedProps: Record<string, unknown> = {},
  /** The tools the run is handed. A call to a name not in here is answered, not forwarded. */
  tools: unknown[] = [],
) {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../src/index");
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
    reasoning_effort?: string;
  }> = [];
  const response = await runAgent(
    {
      threadId: "t1",
      runId: "r1",
      messages,
      tools,
      context: [],
      forwardedProps,
      state: {},
    } as never,
    (async (request: (typeof requests)[number]) => {
      requests.push(request);
      return completion(scripts[requests.length - 1] ?? []);
    }) as never,
  );
  const body = await response.text();
  const events = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
  return { requests, events };
}

/** A page at the computer's own limit. */
const LONG_PAGE = "가".repeat(6_000);

describe("the transcript", () => {
  /**
   * EVERY RESULT GOES THROUGH EXACTLY AS IT ARRIVED (agent-harness-design row 8).
   *
   * This service used to keep the newest four whole and cut the rest to 500 characters, then cut
   * the whole ones again against a 20,000-character budget — so each step of a browsing task
   * rewrote a result the provider had cached one step before, and 54% of the prompt was read from
   * cache (eval:cache, 2026-09-25). A result is cut once, at creation, by the server.
   */
  test("forwards every tool result as it arrived, however old and however many", async () => {
    const messages = [
      { id: "u1", role: "user", content: "창고 열두 개 확인해줘" },
      ...Array.from({ length: 12 }, (_, at) => toolResult(`c${at}`, LONG_PAGE)),
    ];
    const { requests } = await turnFor(messages, [said("네.")]);
    const tools = (requests[0]?.messages ?? []).filter(
      (message) => message.role === "tool",
    );
    expect(tools).toHaveLength(12);
    tools.forEach((tool, at) => {
      expect(tool.content).toBe(
        (messages[at + 1] as { content: string }).content,
      );
    });
  });

  /**
   * THE PREFIX PROPERTY ITSELF: what a request sent is sent again, byte for byte, at the front of
   * the next one. That is what a provider's prefix cache reads, and what the old cut broke.
   */
  test("a later request begins with exactly the bytes the earlier one sent", async () => {
    const early = [
      { id: "u1", role: "user", content: "확인해줘" },
      ...Array.from({ length: 4 }, (_, at) => toolResult(`c${at}`, LONG_PAGE)),
    ];
    const late = [
      ...early,
      ...Array.from({ length: 4 }, (_, at) => toolResult(`d${at}`, LONG_PAGE)),
    ];
    const first = await turnFor(early, [said("네.")]);
    const second = await turnFor(late, [said("네.")]);
    const sent = JSON.stringify(first.requests[0]?.messages ?? []);
    const again = JSON.stringify(
      (second.requests[0]?.messages ?? []).slice(0, early.length),
    );
    expect(again).toBe(sent);
  });

  /** The prompt is the server's. This service adds nothing of its own in front of it. */
  test("forwards the system message it was given and writes none", async () => {
    const { requests } = await turnFor(
      [
        { id: "s1", role: "system", content: "너는 미소다." },
        { id: "u1", role: "user", content: "안녕" },
      ],
      [said("네.")],
    );
    expect(requests[0]?.messages).toEqual([
      { role: "system", content: "너는 미소다." },
      { role: "user", content: "안녕" },
    ]);
  });
});

describe("a turn that did not come back whole", () => {
  test("says so when the model stopped at its length limit", async () => {
    const { events } = await turnFor(
      [{ id: "u1", role: "user", content: "길게 설명해줘" }],
      [said("첫 문장은 여기까지이고 그 다음", "length")],
    );
    const custom = events.filter((event) => event.type === "CUSTOM");
    expect(custom.map((event) => event.name)).toContain("laf.answer_truncated");
    // The half that arrived is kept: a RUN_ERROR would have thrown it away.
    expect(events.map((event) => event.type)).toContain("TEXT_MESSAGE_CONTENT");
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  /**
   * An empty completion is a reasoning budget spent on thinking, so it is asked again with less of
   * it — the same answer `model-call.ts` records for `askModel`. Once only: a model that comes back
   * empty twice is not going to come back full on the third.
   */
  test("asks again once, AT THE SAME EFFORT, when nothing came back", async () => {
    const { requests, events } = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [[], said("안녕하세요.")],
      { effort: "thorough" },
    );

    /*
     * It used to drop one step (high → medium). The effort is rendered at the head of the prompt,
     * in front of the tools, so the lower retry re-read the whole conversation uncached
     * (agent-harness-review §4.4) — Claude Code's rule: never change effort inside a session.
     */
    expect(requests.map((request) => request.reasoning_effort)).toEqual([
      "high",
      "high",
    ]);
    // The retry answered, so nothing is reported: this is a recovery, not an incident.
    expect(
      events.filter((event) => event.name === "laf.empty_answer"),
    ).toHaveLength(0);
    expect(events.map((event) => event.type)).toContain("TEXT_MESSAGE_CONTENT");
  });

  /**
   * The transcript is converted once per run. A retry is the same run asked again, so it is sent
   * the same messages — the memory the server snapshotted for this run, the same results cut the
   * same way — rather than a second conversion that could disagree with the first.
   */
  test("sends the retry the transcript it converted once for the run", async () => {
    const { requests } = await turnFor(
      [
        {
          id: "s1",
          role: "system",
          content: "너는 미소다. 기억: 일요일은 쉰다.",
        },
        { id: "u1", role: "user", content: "안녕" },
        toolResult("c1", LONG_PAGE),
      ],
      [[], said("안녕하세요.")],
      { effort: "thorough" },
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toBe(requests[0]?.messages);
  });

  /**
   * Both attempts were paid for. The first used to be overwritten by the retry, and the monthly cost
   * KPI — a sum of these events — missed exactly the days a reasoning model spent its budget on
   * nothing (audit A2: two requests, one usage event).
   */
  test("counts what the empty first attempt cost, as well as the retry", async () => {
    const usage = (prompt: number): Chunk => ({
      choices: [],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: 900,
        total_tokens: prompt + 900,
      },
    });
    const { requests, events } = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [[usage(120)], [...said("안녕하세요."), usage(120)]],
      { effort: "balanced" },
    );

    expect(requests).toHaveLength(2);
    const counted = events.filter((event) => event.name === "laf.model.usage");
    expect(counted).toHaveLength(2);
    expect(
      counted.map(
        (event) => (event.value as { totalTokens: number }).totalTokens,
      ),
    ).toEqual([1_020, 1_020]);
  });

  test("reports an empty answer when the second try is empty too", async () => {
    const { requests, events } = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [[], []],
      { effort: "balanced" },
    );

    expect(requests).toHaveLength(2);
    expect(events.map((event) => event.name)).toContain("laf.empty_answer");
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });

  test("retries once whatever the effort, and a second empty answer is reported", async () => {
    // `quick`, and a deployment whose model sends no effort at all: the same one retry, the same
    // request, and no third.
    const { requests, events } = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [[], []],
      { effort: "quick" },
    );
    expect(requests.map((request) => request.reasoning_effort)).toEqual([
      "low",
      "low",
    ]);
    expect(events.map((event) => event.name)).toContain("laf.empty_answer");

    const none = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [[], []],
    );
    expect(none.requests).toHaveLength(2);
    expect(none.requests[1]).not.toHaveProperty("reasoning_effort");
  });

  test("a turn that answered is not an empty one", async () => {
    const { requests, events } = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [said("안녕하세요.")],
      { effort: "thorough" },
    );
    expect(requests).toHaveLength(1);
    expect(events.map((event) => event.name)).not.toContain("laf.empty_answer");
  });

  /**
   * A tool call is an answer too.
   *
   * A turn whose whole content is `computer_navigate` has no text in it, and treating that as
   * empty would ask the model to do the same work twice — and in a room, where speaking IS a tool
   * call, would double every message.
   */
  test("a turn that only asked for a tool is not an empty one", async () => {
    const { requests } = await turnFor(
      [{ id: "u1", role: "user", content: "열어줘" }],
      [
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: {
                        name: "computer_navigate",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ],
      ],
      { effort: "thorough" },
      // Handed the tool it calls, as a real run is; an unknown name would be answered in-run.
      [
        {
          name: "computer_navigate",
          description: "연다",
          parameters: { type: "object", properties: {} },
        },
      ],
    );
    expect(requests).toHaveLength(1);
  });
});

describe("a request that never comes back", () => {
  /**
   * The bound that was missing entirely.
   *
   * A provider that accepts a request and then goes quiet held the turn open for as long as it
   * liked, and the person watched a spinner with nothing behind it. Its own code, not
   * `laf:model_failed`: a timeout's next step is different from a refusal's.
   */
  test("ends the turn with its own code rather than holding it open", async () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    const { runAgent } = await import("../src/index");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const response = await runAgent(
      {
        threadId: "t1",
        runId: "r1",
        messages: [{ id: "u1", role: "user", content: "안녕" }],
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
      } as never,
      // A provider that hangs until its signal is aborted, which is what a hung endpoint looks like.
      (async (_request: unknown, options?: { signal?: AbortSignal }) => {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
        return completion([]);
      }) as never,
      // The real bound is two minutes. A two-minute test is a test somebody eventually deletes.
      { timeoutMs: 40 },
    );

    const body = await response.text();
    logged.mockRestore();
    const error = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map(
        (line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>,
      )
      .find((event) => event.type === "RUN_ERROR");
    expect(error?.message).toBe("laf:model_timed_out");
  });
});
