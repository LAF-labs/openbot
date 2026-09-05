import { describe, expect, spyOn, test } from "bun:test";
import type { HttpAgent } from "@ag-ui/client";
import { spillLine, TOOL_RESULT_PREVIEW } from "../../shared/spillover";
import type { WriteFileInput } from "../src/computer/schema";
import { createResultSpill } from "../src/computer/spillover";
import { buildAgents } from "../src/copilot";

/**
 * A long tool result goes on file, and the model is shown a preview and the path.
 *
 * Two things are measured: what the computer was actually asked to write (the whole text, once,
 * under `.results/`, as the Bot), and what the endpoint is actually sent on the wire on the run
 * after — driven through the agent's own fetch, the way the effort test is, because the request
 * that leaves is what matters and the middleware is free to be renamed.
 */

const PAGE = "가".repeat(6_000);

function recorder(fail = false) {
  const writes: Array<WriteFileInput & { botId: string }> = [];
  const client = {
    forBot: (botId: string) => ({
      writeFile: async (input: WriteFileInput) => {
        if (fail) throw new Error("The assistant's computer is not running.");
        writes.push({ botId, ...input });
        return {
          path: input.path,
          bytes: input.contents.length,
          appended: false,
        };
      },
    }),
  };
  return { writes, client };
}

describe("filing a long tool result", () => {
  test("leaves a short result alone and writes nothing", async () => {
    const { writes, client } = recorder();
    const spill = createResultSpill(client);
    const short = "가".repeat(TOOL_RESULT_PREVIEW);
    expect(spill.forModel("bot-1", "call_1", short)).toBe(short);
    await spill.settled();
    expect(writes).toEqual([]);
  });

  test("shows the whole the first time, files it once, then shows the preview", async () => {
    const { writes, client } = recorder();
    const spill = createResultSpill(client);

    // The run that received the result is the run that needs it.
    expect(spill.forModel("bot-1", "call_1", PAGE)).toBe(PAGE);
    await spill.settled();
    expect(writes).toEqual([
      { botId: "bot-1", path: ".results/call_1.txt", contents: PAGE },
    ]);

    // Every run after resends the same result; it is recognised, not refiled.
    const shown = spill.forModel("bot-1", "call_1", PAGE);
    expect(shown.startsWith("가".repeat(TOOL_RESULT_PREVIEW))).toBe(true);
    expect(shown.endsWith(spillLine(".results/call_1.txt"))).toBe(true);
    expect(shown.length).toBeLessThan(TOOL_RESULT_PREVIEW + 100);
    spill.forModel("bot-1", "call_1", PAGE);
    await spill.settled();
    expect(writes).toHaveLength(1);
  });

  test("the same call for another Bot is another file, under that Bot", async () => {
    const { writes, client } = recorder();
    const spill = createResultSpill(client);
    spill.forModel("bot-1", "call_1", PAGE);
    spill.forModel("bot-2", "call_1", PAGE);
    await spill.settled();
    expect(writes.map((write) => write.botId)).toEqual(["bot-1", "bot-2"]);
  });

  /**
   * A preview names a file. If the file is not there the preview is a promise the model cannot
   * cash — it reads "there is no file at .results/…" and has lost the page as well. So a failed
   * write leaves the result whole, and says so in the log an operator reads.
   */
  test("never shows a preview for a file the computer did not confirm", async () => {
    const { client } = recorder(true);
    const logged: string[] = [];
    const spill = createResultSpill(client, {
      log: (line) => logged.push(line),
    });

    expect(spill.forModel("bot-1", "call_1", PAGE)).toBe(PAGE);
    await spill.settled();
    expect(spill.forModel("bot-1", "call_1", PAGE)).toBe(PAGE);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(".results/call_1.txt");
    // The failure is named, the page is not: a log line is not a place for page text.
    expect(logged[0]).not.toContain("가가가");
  });
});

/**
 * What the endpoint receives, on the wire, once a result is on file.
 */
describe("what a remote Bot is sent about a filed result", () => {
  const agent = {
    id: "agent_expense",
    name: "Expense Manager",
    type: "remote_ag_ui" as const,
    endpoint: "http://expense.internal/ag-ui",
    profile: {
      id: "agent_expense",
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
    },
    effort: "balanced" as const,
  };
  const model = {
    provider: "openai" as const,
    defaultModel: "laf-1",
    supportsEffort: false,
  };

  /** Run one turn against a fetch that records, and hand back the messages the endpoint got. */
  async function messagesSentBy(
    spill: ReturnType<typeof createResultSpill>,
  ): Promise<Array<{ role: string; content?: string; toolCallId?: string }>> {
    let sent: Record<string, unknown> = {};
    const recordingFetch = async (_url: unknown, init?: { body?: unknown }) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: "t1", runId: "r1" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const agents = buildAgents(
      [agent],
      model,
      { watch: () => recordingFetch as never, stop: () => undefined },
      "Asia/Seoul",
      spill,
    );
    const remote = agents.agent_expense as HttpAgent;
    // The conversation is the agent's own state, not a run parameter: `runAgent` reads
    // `this.messages`, which is why the effort test could ignore what it passed there.
    remote.setMessages([
      { id: "m1", role: "user", content: "창고 페이지 읽어줘" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "computer_read", arguments: "{}" },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "call_1", content: PAGE },
      { id: "t2", role: "tool", toolCallId: "call_2", content: "짧다" },
    ]);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await remote.runAgent({ forwardedProps: {} }).catch(() => {});
    } finally {
      consoleError.mockRestore();
    }
    return sent.messages as Array<{
      role: string;
      content?: string;
      toolCallId?: string;
    }>;
  }

  test("forwards the whole result on the run that received it, then the preview", async () => {
    const { writes, client } = recorder();
    const spill = createResultSpill(client);

    const first = await messagesSentBy(spill);
    expect(first.find((m) => m.toolCallId === "call_1")?.content).toBe(PAGE);
    await spill.settled();
    // Filed as this Bot, from the middleware, with nothing else asked of the computer.
    expect(writes).toEqual([
      { botId: "agent_expense", path: ".results/call_1.txt", contents: PAGE },
    ]);

    const again = await messagesSentBy(spill);
    const filed = again.find((m) => m.toolCallId === "call_1")?.content ?? "";
    expect(filed.startsWith("가".repeat(TOOL_RESULT_PREVIEW))).toBe(true);
    expect(filed).toContain('computer_read_file(".results/call_1.txt")');
    expect(filed.length).toBeLessThan(TOOL_RESULT_PREVIEW + 100);
    // The short one beside it is untouched, on both runs.
    expect(again.find((m) => m.toolCallId === "call_2")?.content).toBe("짧다");
    // And the prompt still comes first: the spill changes tool messages and nothing else.
    expect(again[0]?.role).toBe("system");
  });

  test("with no computer there is nothing to file, and the transcript goes as it was", async () => {
    let sent: Record<string, unknown> = {};
    const recordingFetch = async (_url: unknown, init?: { body?: unknown }) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: "t1", runId: "r1" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const agents = buildAgents([agent], model, {
      watch: () => recordingFetch as never,
      stop: () => undefined,
    });
    const remote = agents.agent_expense as HttpAgent;
    remote.setMessages([
      { id: "t1", role: "tool", toolCallId: "call_1", content: PAGE },
    ]);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await remote.runAgent({ forwardedProps: {} }).catch(() => {});
    } finally {
      consoleError.mockRestore();
    }
    const messages = sent.messages as Array<{ content?: string }>;
    expect(messages.at(-1)?.content).toBe(PAGE);
  });
});
