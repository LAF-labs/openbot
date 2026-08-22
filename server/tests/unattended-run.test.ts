/**
 * The server-side tool loop, driven by a fake agent.
 *
 * The loop is the thing that turns a scheduler into an agent: without it a routine could only
 * think, never look. These pin the contract the browser's loop keeps and this one has to keep too
 * — every tool call answered, results attached by id, the run ending when the model stops asking —
 * plus the two ways an unattended run ends that a conversation never does.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  type LoopAgent,
  runUnattended,
  type UnattendedToolkit,
} from "../src/runner/unattended";

/** Scripted turns: what the "model" says each time it is run. */
function fakeAgent(turns: Array<Message | Message[]>): LoopAgent & {
  runs: number;
} {
  const agent = {
    messages: [] as Message[],
    runs: 0,
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent() {
      const turn = turns[agent.runs] ?? [];
      agent.runs += 1;
      const added = Array.isArray(turn) ? turn : [turn];
      agent.messages.push(...added);
      return { result: undefined, newMessages: added };
    },
  };
  return agent as unknown as LoopAgent & { runs: number };
}

const call = (id: string, name: string, args: object): Message => ({
  id: `a-${id}`,
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const say = (text: string): Message => ({
  id: `s-${text.length}`,
  role: "assistant",
  content: text,
});

const toolkit = (execute: UnattendedToolkit["execute"]): UnattendedToolkit => ({
  tools: [
    {
      name: "computer_navigate",
      description: "open",
      parameters: { type: "object", properties: {} },
    },
  ],
  execute,
});

describe("an unattended run", () => {
  test("executes what the model asks for and hands the result back by id", async () => {
    const executed: Array<[string, Record<string, unknown>]> = [];
    const agent = fakeAgent([
      call("t1", "computer_navigate", { url: "https://example.com" }),
      say("The page says Example Domain."),
    ]);

    const result = await runUnattended(
      agent,
      "Open example.com and tell me the title.",
      {
        toolkit: toolkit(async (name, args) => {
          executed.push([name, args]);
          return { ok: true, title: "Example Domain" };
        }),
        timeoutMs: 5_000,
      },
    );

    expect(executed).toEqual([
      ["computer_navigate", { url: "https://example.com" }],
    ]);
    const answer = agent.messages.find((m) => m.role === "tool") as
      | { toolCallId: string; content: string }
      | undefined;
    expect(answer?.toolCallId).toBe("t1");
    expect(JSON.parse(answer?.content ?? "{}")).toEqual({
      ok: true,
      title: "Example Domain",
    });
    expect(result.answer).toBe("The page says Example Domain.");
    expect(result.toolCalls).toEqual([{ name: "computer_navigate", ok: true }]);
    expect(result.awaiting).toBeNull();
    expect(agent.runs).toBe(2);
  });

  test("opens with the note that nobody is watching", async () => {
    const agent = fakeAgent([say("ok")]);
    await runUnattended(agent, "hello", {
      toolkit: toolkit(async () => ({ ok: true })),
      timeoutMs: 5_000,
    });
    const [first, second] = agent.messages;
    expect(first?.role).toBe("system");
    expect(String(first?.content)).toContain("unattended");
    expect(second).toMatchObject({ role: "user", content: "hello" });
  });

  test("reports what it is waiting for when a tool needs a person", async () => {
    // An ask-rule cannot be answered at six in the morning. The run must not hang on it, and the
    // answer must say what it was — that is the whole value of the run to the person reading it.
    const agent = fakeAgent([
      call("t1", "computer_navigate", { url: "https://bank.example" }),
      say("I could not open the bank: a person has to allow that first."),
    ]);
    const result = await runUnattended(agent, "Check the balance.", {
      toolkit: toolkit(async () => ({
        ok: false,
        awaitingApproval: true,
        question: "Open bank.example?",
        reason: "A person has to allow that.",
      })),
      timeoutMs: 5_000,
    });
    expect(result.awaiting).toBe("Open bank.example?");
    expect(result.toolCalls).toEqual([
      { name: "computer_navigate", ok: false },
    ]);
  });

  test("stops a model that never stops asking, and leaves no call unanswered", async () => {
    /*
     * Two things at once: the budget ends the loop, and the final round's calls still get a tool
     * message. A thread that ends on an unanswered tool call is rejected by the provider on the
     * NEXT run, which would break the Bot's conversation — not just this routine.
     */
    const endless = Array.from({ length: 20 }, (_, i) =>
      call(`t${i}`, "computer_navigate", { url: `https://x/${i}` }),
    );
    let executed = 0;
    const agent = fakeAgent(endless);
    const result = await runUnattended(agent, "loop", {
      toolkit: toolkit(async () => {
        executed += 1;
        return { ok: true };
      }),
      timeoutMs: 5_000,
      maxSteps: 3,
    });

    expect(executed).toBe(3);
    const calls = agent.messages.flatMap((m) =>
      m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [],
    );
    const answered = new Set(
      agent.messages
        .filter((m) => m.role === "tool")
        .map((m) => (m as { toolCallId: string }).toolCallId),
    );
    expect(calls.every((id) => answered.has(id))).toBe(true);
    expect(result.toolCalls.at(-1)?.ok).toBe(false);
  });

  test("gives up at the deadline rather than running all night", async () => {
    const agent = fakeAgent([]);
    (agent as { runAgent: unknown }).runAgent = () => new Promise(() => {});
    await expect(
      runUnattended(agent, "hang", {
        toolkit: toolkit(async () => ({ ok: true })),
        timeoutMs: 30,
      }),
    ).rejects.toThrow("did not finish in time");
  });
});
