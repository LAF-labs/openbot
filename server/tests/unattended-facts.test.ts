import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  createUnattendedTools,
  type LoopAgent,
  runUnattended,
} from "../src/runner/unattended";

/**
 * What the unattended loop and its executor say when a call cannot be run, and what the run's
 * record says about it.
 *
 * MEASURED IN THE AUDIT (A2, 2026-09-10, rows 5 and 6): a routine answered a made-up tool with the
 * English "There is no tool called computer_fly.", turned broken JSON arguments into `{}` and ran
 * the tool with nothing — so the model read "the field is missing" about a field it had sent — and
 * refused a click without a ref with "A ref and its snapshotId are required." Every one of those
 * was read by a model whose prompt tells it to answer in Korean. They are facts from the one table
 * now, the same ones `agent-bot` answers inside a run.
 */

const actor = { id: "person-1", userId: "person-1" };

/**
 * A gateway nothing may reach. Every call here is refused before the executor would touch it, and
 * a refusal that did touch it would throw on the missing method and fail the test.
 */
const UNTOUCHED = {} as unknown as ComputerGateway;

/** A model that asks for one call — its arguments exactly as written — and then reports. */
function agentCalling(name: string, rawArguments: string): LoopAgent {
  const turns: Message[] = [
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name, arguments: rawArguments },
        },
      ],
    },
    { id: "a2", role: "assistant", content: "다시 하겠다." },
  ];
  let runs = 0;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      _parameters?: unknown,
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) {
      const turn = turns[runs];
      runs += 1;
      if (turn) agent.messages.push(turn);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: turn ? [turn] : [] };
    },
  };
  return agent as unknown as LoopAgent;
}

describe("what the executor refuses on its own", () => {
  test("arguments that are not what the tool takes", async () => {
    const toolkit = await createUnattendedTools({ gateway: UNTOUCHED })(
      "bot-1",
      actor,
    );
    expect(await toolkit.execute("computer_click", { ref: "e1" })).toEqual({
      ok: false,
      code: "laf:tool_arguments_invalid",
      reason: toolResultText("laf:tool_arguments_invalid"),
    });
    expect(await toolkit.execute("computer_key", {})).toMatchObject({
      code: "laf:tool_arguments_invalid",
    });
  });

  test("a name it has no tool for", async () => {
    const toolkit = await createUnattendedTools({ gateway: UNTOUCHED })(
      "bot-1",
      actor,
    );
    expect(await toolkit.execute("computer_fly", {})).toEqual({
      ok: false,
      code: "laf:tool_unknown",
      reason: toolResultText("laf:tool_unknown"),
    });
  });

  test("arguments that are not JSON are answered with the fact and never executed", async () => {
    // A routine turned these into `{}` and ran the tool with nothing, so the model read "the field
    // is missing" about a field it had sent (audit A2, row 5).
    const executed: string[] = [];
    const agent = agentCalling("computer_click", '{"ref": "e1" oops');
    const result = await runUnattended(agent, "결제해 줘", {
      toolkit: {
        tools: [],
        execute: async (name) => {
          executed.push(name);
          return { ok: true };
        },
      },
      timeoutMs: 5_000,
      mode: "routine",
    });
    expect(executed).toEqual([]);
    const answer = agent.messages.find((message) => message.role === "tool");
    expect(JSON.parse(String(answer?.content))).toEqual({
      ok: false,
      code: "laf:tool_arguments_invalid",
      reason: toolResultText("laf:tool_arguments_invalid"),
    });
    expect(result.steps[0]?.calls).toEqual([
      { name: "computer_click", ok: false },
    ]);
  });
});

describe("what the run's record says about a call the Bot service answered", () => {
  test("a guard's fact is recorded as not done, and a lookup as done", async () => {
    // agent-bot answers some calls inside the run — a bridge lookup, and now a made-up tool name —
    // and the thread comes back with the call and its answer. Both used to be recorded as `ok`.
    const turns: Message[][] = [
      [
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "look",
              type: "function",
              function: { name: "tool_search", arguments: '{"query":"메일"}' },
            },
            {
              id: "fly",
              type: "function",
              function: { name: "computer_fly", arguments: "{}" },
            },
          ],
        },
        {
          id: "r1",
          role: "tool",
          toolCallId: "look",
          content: "찾은 도구: mcp__gmail__send_message",
        },
        {
          id: "r2",
          role: "tool",
          toolCallId: "fly",
          content: JSON.stringify({
            ok: false,
            code: "laf:tool_unknown",
            reason: toolResultText("laf:tool_unknown"),
          }),
        },
        { id: "a2", role: "assistant", content: "없는 도구였다." },
      ],
    ];
    let runs = 0;
    const agent = {
      messages: [] as Message[],
      setMessages(messages: Message[]) {
        agent.messages = [...messages];
      },
      addMessage(message: Message) {
        agent.messages.push(message);
      },
      async runAgent(
        _parameters?: unknown,
        subscriber?: { onRunFinishedEvent?: () => unknown },
      ) {
        const added = turns[runs] ?? [];
        runs += 1;
        agent.messages.push(...added);
        subscriber?.onRunFinishedEvent?.();
        return { result: undefined, newMessages: added };
      },
    };
    const result = await runUnattended(agent as unknown as LoopAgent, "메일", {
      toolkit: { tools: [], execute: async () => ({ ok: true }) },
      timeoutMs: 5_000,
      mode: "routine",
    });
    expect(result.steps[0]?.calls).toEqual([
      { name: "tool_search", ok: true },
      { name: "computer_fly", ok: false },
    ]);
  });
});
