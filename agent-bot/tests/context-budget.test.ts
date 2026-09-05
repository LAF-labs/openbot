import { describe, expect, spyOn, test } from "bun:test";
import type OpenAI from "openai";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import { previewOf, spillLine } from "../../shared/spillover";

/**
 * What this service does to a transcript before it hands it to a model, and what it says about a
 * turn that did not come back whole.
 *
 * ALL FOUR OF THESE WERE MISSING, and none of them was visible from a green gate:
 *
 * - Every message went through verbatim. A page's readable text comes back up to 6,000 characters,
 *   so ten steps of browsing put forty to sixty thousand tokens of Korean page text in front of the
 *   model — most of it pages it had already finished with, paid for again on every turn.
 * - `finish_reason: "length"` was never read, so an answer cut off mid-sentence was delivered as a
 *   finished one and the person had no way to know there had been more.
 * - An empty completion — a reasoning model that spent its whole budget deliberating — ended the
 *   run with RUN_FINISHED and no text, which every reader downstream takes for a Bot that chose to
 *   say nothing. In a room that is a legitimate silence; in a chat it is a Bot ignoring you.
 * - There was no request timeout at all.
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
      tools: [],
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

/** A page under the turn budget four times over, so the count rule can be seen on its own. */
const PAGE = "가".repeat(3_000);
/** A page at the computer's own limit. Four of these are over the turn budget together. */
const LONG_PAGE = "가".repeat(6_000);

const TURN_BUDGET = 20_000;

describe("the context budget", () => {
  test("keeps the last four tool results whole and cuts the ones before them", async () => {
    const messages = [
      { id: "u1", role: "user", content: "창고 열두 개 확인해줘" },
      ...Array.from({ length: 12 }, (_, at) => toolResult(`c${at}`, PAGE)),
    ];
    const { requests } = await turnFor(messages, [said("네.")]);

    const tools = (requests[0]?.messages ?? []).filter(
      (message) => message.role === "tool",
    );
    expect(tools).toHaveLength(12);

    const marker = toolResultText("laf:tool_result_trimmed");
    // The last four are what the model is still working from.
    for (const kept of tools.slice(-4)) {
      expect(kept.content).not.toContain(marker);
      expect(kept.content.length).toBeGreaterThan(3_000);
    }
    // The eight before them are recognisable and no longer expensive.
    for (const cut of tools.slice(0, -4)) {
      expect(cut.content).toContain(marker);
      expect(cut.content.length).toBeLessThan(700);
    }
  });

  /**
   * CUT, AND SAID TO BE CUT.
   *
   * A silent truncation reads to the model as "that page did not say anything about it", which is
   * a confident wrong answer rather than a missing one — the same lesson the coworker answer's
   * visible `[truncated: …]` records.
   */
  test("says that an older result was cut, rather than shortening it quietly", async () => {
    const messages = [
      { id: "u1", role: "user", content: "확인해줘" },
      ...Array.from({ length: 6 }, (_, at) => toolResult(`c${at}`, PAGE)),
    ];
    const { requests } = await turnFor(messages, [said("네.")]);
    const first = (requests[0]?.messages ?? []).find(
      (message) => message.role === "tool",
    );
    expect(first?.content).toContain("잘렸다");
  });

  test("leaves a short transcript exactly as it arrived", async () => {
    const messages = [
      { id: "u1", role: "user", content: "확인해줘" },
      toolResult("c1", PAGE),
      toolResult("c2", PAGE),
    ];
    const { requests } = await turnFor(messages, [said("네.")]);
    const tools = (requests[0]?.messages ?? []).filter(
      (message) => message.role === "tool",
    );
    expect(tools.every((tool) => tool.content.length > 3_000)).toBe(true);
  });

  /**
   * THE COUNT WAS NEVER A WEIGHT.
   *
   * Four whole pages at the computer's limit are 24,000 characters, and a file read can be
   * 64,000 on its own. Over the turn budget the oldest of the whole ones go too — never the
   * newest, which is the result the model just asked for.
   */
  test("trims the oldest of the whole ones too, until the turn is under budget", async () => {
    const messages = [
      { id: "u1", role: "user", content: "창고 열두 개 확인해줘" },
      ...Array.from({ length: 12 }, (_, at) => toolResult(`c${at}`, LONG_PAGE)),
    ];
    const { requests } = await turnFor(messages, [said("네.")]);
    const tools = (requests[0]?.messages ?? []).filter(
      (message) => message.role === "tool",
    );
    const marker = toolResultText("laf:tool_result_trimmed");

    const total = tools.reduce((sum, tool) => sum + tool.content.length, 0);
    expect(total).toBeLessThanOrEqual(TURN_BUDGET);
    // Two whole pages fit under the budget beside ten trimmed ones; a third does not.
    for (const kept of tools.slice(-2)) {
      expect(kept.content.length).toBeGreaterThan(6_000);
    }
    for (const cut of tools.slice(0, -2)) {
      expect(cut.content).toContain(marker);
    }
  });

  test("never cuts the newest result, even one over the budget on its own", async () => {
    const messages = [
      { id: "u1", role: "user", content: "파일 읽어줘" },
      toolResult("c1", LONG_PAGE),
      toolResult("c2", "가".repeat(25_000)),
    ];
    const { requests } = await turnFor(messages, [said("네.")]);
    const tools = (requests[0]?.messages ?? []).filter(
      (message) => message.role === "tool",
    );
    expect(tools[1]?.content.length).toBeGreaterThan(25_000);
    // The one before it paid for the excess instead.
    expect(tools[0]?.content).toContain(
      toolResultText("laf:tool_result_trimmed"),
    );
  });

  /**
   * A result the server has already filed ends in the line naming its file. When it ages past the
   * cut, that line is what survives — a trim that lost the path would turn a result the model can
   * still read whole into one it cannot.
   */
  test("keeps the line naming a filed result's file when it trims the result", async () => {
    const filed = previewOf(
      JSON.stringify({ ok: true, text: LONG_PAGE }),
      ".results/c0.txt",
    );
    const messages = [
      { id: "u1", role: "user", content: "확인해줘" },
      { id: "t_c0", role: "tool", toolCallId: "c0", content: filed },
      ...Array.from({ length: 5 }, (_, at) => toolResult(`c${at + 1}`, PAGE)),
    ];
    const { requests } = await turnFor(messages, [said("네.")]);
    const first = (requests[0]?.messages ?? []).find(
      (message) => message.role === "tool",
    );
    expect(first?.content.endsWith(spillLine(".results/c0.txt"))).toBe(true);
    expect(first?.content).not.toContain(
      toolResultText("laf:tool_result_trimmed"),
    );
    expect(first?.content.length).toBeLessThan(700);
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
  test("asks again one step lower when nothing came back", async () => {
    const { requests, events } = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [[], said("안녕하세요.")],
      { effort: "thorough" },
    );

    expect(requests.map((request) => request.reasoning_effort)).toEqual([
      "high",
      "medium",
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

  test("does not retry when there is no lower effort to drop to", async () => {
    // `quick` is the floor, and a deployment whose model does not reason sends none at all. Asking
    // the same question twice for nothing is latency the person pays and no better answer.
    const { requests, events } = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [[], []],
      { effort: "quick" },
    );
    expect(requests).toHaveLength(1);
    expect(events.map((event) => event.name)).toContain("laf.empty_answer");

    const none = await turnFor(
      [{ id: "u1", role: "user", content: "안녕" }],
      [[], []],
    );
    expect(none.requests).toHaveLength(1);
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
        ],
      ],
      { effort: "thorough" },
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
