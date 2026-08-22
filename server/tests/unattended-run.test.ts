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
  UnattendedRunError,
  type UnattendedToolkit,
} from "../src/runner/unattended";

/** Scripted turns: what the "model" says each time it is run. */
type Stalled = { stalled: string; said?: string };
type Dropped = { dropped: string };

function fakeAgent(
  turns: Array<Message | Message[] | Stalled | Dropped>,
): LoopAgent & {
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
    async runAgent(
      _parameters?: unknown,
      subscriber?: {
        onRunErrorEvent?: (payload: { event: { message: string } }) => unknown;
        onRunFinishedEvent?: () => unknown;
      },
    ) {
      const turn = turns[agent.runs] ?? [];
      agent.runs += 1;
      if (!Array.isArray(turn) && "dropped" in turn) {
        // A connection that closed: prose so far, no RUN_FINISHED, no RUN_ERROR.
        agent.messages.push(say(turn.dropped));
        return { result: undefined, newMessages: [] };
      }
      if (!Array.isArray(turn) && "stalled" in turn) {
        // What a stalled or failed stream looks like from here: any prose that arrived, then the
        // RUN_ERROR event handed to the subscriber, and runAgent resolving all the same.
        if (turn.said) agent.messages.push(say(turn.said));
        subscriber?.onRunErrorEvent?.({ event: { message: turn.stalled } });
        return { result: undefined, newMessages: [] };
      }
      const added = Array.isArray(turn) ? turn : [turn];
      agent.messages.push(...added);
      subscriber?.onRunFinishedEvent?.();
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

import {
  ActionNeedsApprovalError,
  ActionRefusedError,
} from "../src/computer/gateway";
import { outcomeOfError } from "../src/runner/unattended";

describe("what a failed tool tells the model", () => {
  test("an ask-rule is a pause with the question, never a refusal", () => {
    const outcome = outcomeOfError(
      new ActionNeedsApprovalError({
        id: "appr-1",
        question: "Open bank.example?",
        rule: "ask: banking",
      } as never),
    );
    expect(outcome).toMatchObject({
      ok: false,
      awaitingApproval: true,
      approvalId: "appr-1",
      question: "Open bank.example?",
      rule: "ask: banking",
    });
    expect(outcome.refused).toBeUndefined();
  });

  test("a deny-rule is final and names the rule", () => {
    const outcome = outcomeOfError(
      new ActionRefusedError("Never submit a form.", "deny: submit"),
    );
    expect(outcome).toMatchObject({
      ok: false,
      refused: true,
      reason: "Never submit a form.",
      rule: "deny: submit",
    });
    expect(outcome.awaitingApproval).toBeUndefined();
  });

  test("anything else is an ordinary failure with its message", () => {
    expect(outcomeOfError(new Error("The computer is asleep."))).toEqual({
      ok: false,
      reason: "The computer is asleep.",
    });
    expect(outcomeOfError("???")).toEqual({
      ok: false,
      reason: "That did not work.",
    });
  });
});

describe("the ends of an unattended run", () => {
  test("after the budget, the model is run once more to answer", async () => {
    // Tool rounds past the budget, then — offered no tools — a sentence. Refusals alone are not
    // an answer, and the model has to be RUN to give one.
    const turns: Array<Message | Message[]> = Array.from(
      { length: 4 },
      (_, i) => call(`t${i}`, "computer_navigate", { url: `https://x/${i}` }),
    );
    turns.push(say("Here is what I found before I ran out of steps."));
    const agent = fakeAgent(turns);
    const offered: number[] = [];
    (agent as { runAgent: unknown }).runAgent = async (
      parameters?: { tools?: unknown[] },
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) => {
      offered.push(parameters?.tools?.length ?? -1);
      const turn = turns[agent.runs] ?? [];
      agent.runs += 1;
      const added = Array.isArray(turn) ? turn : [turn];
      agent.messages.push(...added);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: added };
    };

    const result = await runUnattended(agent, "loop", {
      toolkit: toolkit(async () => ({ ok: true })),
      timeoutMs: 5_000,
      maxSteps: 3,
    });

    expect(result.answer).toBe(
      "Here is what I found before I ran out of steps.",
    );
    expect(offered.at(-1)).toBe(0);
  });

  test("the deadline aborts the run it gave up on", async () => {
    const agent = fakeAgent([]);
    let aborted = false;
    (agent as { runAgent: unknown }).runAgent = () => new Promise(() => {});
    agent.abortRun = () => {
      aborted = true;
    };
    await expect(
      runUnattended(agent, "hang", {
        toolkit: toolkit(async () => ({ ok: true })),
        timeoutMs: 30,
      }),
    ).rejects.toThrow("did not finish in time");
    expect(aborted).toBe(true);
  });
});

describe("what the run reports", () => {
  test("a stream that ends in RUN_ERROR is a failed run, not a short answer", async () => {
    const agent = fakeAgent([
      call("c1", "computer_navigate", { url: "https://a" }),
      {
        stalled: "The Bot produced nothing for 60 seconds.",
        said: "Let me check",
      },
    ]);
    let thrown: unknown;
    try {
      await runUnattended(agent, "look", {
        toolkit: toolkit(async () => ({ ok: true })),
        timeoutMs: 5_000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnattendedRunError);
    const error = thrown as UnattendedRunError;
    expect(error.message).toContain("stopped before it finished");
    expect(error.message).toContain("60 seconds");
    // The turns it did take survive the failure: the record says how far it got.
    expect(error.steps).toHaveLength(2);
    expect(error.steps[0]?.calls).toEqual([
      { name: "computer_navigate", ok: true },
    ]);
  });

  test("a stream that ends without RUN_FINISHED is a failed run too", async () => {
    const agent = fakeAgent([{ dropped: "I checked and the email deliv" }]);
    let thrown: unknown;
    try {
      await runUnattended(agent, "send it", {
        toolkit: toolkit(async () => ({ ok: true })),
        timeoutMs: 5_000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnattendedRunError);
    expect((thrown as Error).message).toContain(
      "ended before the run finished",
    );
  });

  test("the answer is the last turn, not the narration before it", async () => {
    const agent = fakeAgent([
      [
        say("Let me look at both."),
        call("c1", "computer_navigate", { url: "https://a" }),
      ],
      say("Busan is warmer."),
    ]);
    const run = await runUnattended(agent, "which is warmer", {
      toolkit: toolkit(async () => ({ ok: true })),
      timeoutMs: 5_000,
    });
    expect(run.answer).toBe("Busan is warmer.");
    expect(run.steps.map((step) => step.calls.length)).toEqual([1, 0]);
    expect(run.steps[0]?.text).toBe("Let me look at both.".length);
  });

  test("a last turn that said nothing falls back to the last thing said", async () => {
    const agent = fakeAgent([
      [
        say("Opening it."),
        call("c1", "computer_navigate", { url: "https://a" }),
      ],
      call("c2", "computer_navigate", { url: "https://b" }),
      [],
    ]);
    const run = await runUnattended(agent, "look", {
      toolkit: toolkit(async () => ({ ok: false, reason: "down" })),
      timeoutMs: 5_000,
    });
    expect(run.answer).toBe("Opening it.");
    expect(run.toolCalls.every((entry) => !entry.ok)).toBe(true);
    expect(run.steps[1]?.calls).toEqual([
      { name: "computer_navigate", ok: false },
    ]);
  });
});
