import { describe, expect, test } from "bun:test";
import type { AbstractAgent, AgentSubscriber, Message } from "@ag-ui/client";
import { outcomeOf, runMemberTurn } from "../src/rooms/member-turn";
import { runRoomTurn } from "../src/rooms/orchestrator";
import {
  type MemberOutcome,
  settleOutcome,
  summariseOutcomes,
} from "../src/rooms/outcomes";
import type { RoomMember } from "../src/rooms/prompt";

/**
 * HOW A MEMBER'S TURN CAME OUT, AS A KIND. Measured 2026-09-21: a Bot that chose silence in a room
 * of three looked to the person as if it were not in the room — silence, failure and a timeout
 * were the same zero. Each kind is pinned here against the real member loop with a scripted agent,
 * and the rule that folds a member asked twice into one outcome is pinned beside it.
 */

type Script = (turn: number, subscriber: AgentSubscriber) => Promise<Message[]>;

/** A scripted agent: each run calls `script`, adds what it returns, and ends the way it says. */
function scripted(
  script: Script,
  end: "finished" | "error" | "throw" | "hang" = "finished",
) {
  let turn = 0;
  let release: (() => void) | undefined;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(_input: unknown, subscriber: AgentSubscriber) {
      turn += 1;
      if (end === "throw") {
        throw new Error(
          "Unable to connect. Is the computer able to access the url?",
        );
      }
      agent.messages.push(...(await script(turn, subscriber)));
      const params = {} as never;
      if (end === "hang") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { result: undefined, newMessages: [] };
      }
      if (end === "error") {
        await subscriber.onRunErrorEvent?.({
          ...(params as object),
          event: { message: "laf:model_failed" },
        } as never);
      } else {
        await subscriber.onRunFinishedEvent?.({
          ...(params as object),
          event: {},
        } as never);
      }
      return { result: undefined, newMessages: [] };
    },
    abortRun() {
      release?.();
    },
  };
  return agent as unknown as AbstractAgent;
}

/** An assistant turn that calls `send_message` once, told to the room's watcher as it streams. */
function speaks(text: string, id = "call_1"): Script {
  return async (turn, subscriber) => {
    if (turn > 1) return [];
    await subscriber.onToolCallStartEvent?.({
      event: { toolCallId: id, toolCallName: "send_message" },
    } as never);
    await subscriber.onToolCallEndEvent?.({
      event: { toolCallId: id },
      toolCallArgs: { text },
    } as never);
    return [
      {
        id: `m_${id}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id,
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ text }),
            },
          },
        ],
      } as Message,
    ];
  };
}

const quiet: Script = async () => [
  { id: "m_scratch", role: "assistant", content: "보탤 게 없네." } as Message,
];

const member: RoomMember = { id: "review", name: "리뷰봇" };

async function turnOf(agent: AbstractAgent | null, timeoutMs = 2_000) {
  const delivered: string[] = [];
  const result = await runMemberTurn({
    room: { channelId: "channel_x", name: "방" },
    threadId: "thread_x",
    runId: "run_x",
    member,
    peers: [member, { id: "stock", name: "재고봇" }],
    lines: [{ agentId: null, name: "사장님", text: "우유 언제 주문해?" }],
    windingDown: false,
    reason: "everybody",
    answeringNow: 2,
    agent,
    toolkit: { tools: [], execute: async () => ({ ok: true }) },
    deliver: async (text) => {
      delivered.push(text);
    },
    watch: { open: () => {}, text: () => {}, close: () => {} },
    timeoutMs,
    userId: "user_x",
  });
  return { result, delivered };
}

describe("a member's turn, as a kind", () => {
  test("a member that sends a message spoke", async () => {
    const { result, delivered } = await turnOf(
      scripted(speaks("내일 오전에 주문하세요.")),
    );
    expect(result).toMatchObject({ spoke: 1, failed: null, outcome: "spoke" });
    expect(delivered).toEqual(["내일 오전에 주문하세요."]);
  });

  test("a member that ends normally without send_message passed — read it, nothing to add", async () => {
    const { result, delivered } = await turnOf(scripted(quiet));
    expect(result).toMatchObject({ spoke: 0, failed: null, outcome: "passed" });
    // Its private working is not the room's: nothing was posted.
    expect(delivered).toEqual([]);
  });

  test("a member whose endpoint is dead failed, which is not silence", async () => {
    const { result } = await turnOf(scripted(quiet, "throw"));
    expect(result.outcome).toBe("failed");
    expect(result.failed).toContain("Unable to connect");
  });

  test("a member whose stream reported an error failed", async () => {
    const { result } = await turnOf(scripted(quiet, "error"));
    expect(result.outcome).toBe("failed");
  });

  test("a member that ran out of time timed out, which is not a failure either", async () => {
    const { result } = await turnOf(scripted(quiet, "hang"), 50);
    expect(result.outcome).toBe("timed_out");
    expect(result.spoke).toBe(0);
  });

  test("a Bot that no longer resolves failed", async () => {
    const { result } = await turnOf(null);
    expect(result.outcome).toBe("failed");
  });
});

describe("a reply finished as the clock ran out", () => {
  /*
   * Hermes keeps a reply that arrives after a member's timeout (`harvestStrandedGroupReply`). Here
   * the member had finished writing its message — the words were on the person's screen as it
   * typed — and the deadline fell before the loop ran the call. It used to be taken back down.
   */
  test("is delivered, not dropped", async () => {
    const { result, delivered } = await turnOf(
      scripted(speaks("늦었지만 제 답은 이거예요."), "hang"),
      50,
    );
    expect(delivered).toEqual(["늦었지만 제 답은 이거예요."]);
    expect(result.spoke).toBe(1);
    // Its words are in the room, so the room shows its words and not a failure.
    expect(result.outcome).toBe("spoke");
    // The trail still says what happened to the run.
    expect(result.failed).toContain("did not finish in time");
  });

  test("but a message still being written when the clock ran out is not", async () => {
    const halfWritten: Script = async (_turn, subscriber) => {
      await subscriber.onToolCallStartEvent?.({
        event: { toolCallId: "call_half", toolCallName: "send_message" },
      } as never);
      return [];
    };
    const { result, delivered } = await turnOf(
      scripted(halfWritten, "hang"),
      50,
    );
    expect(delivered).toEqual([]);
    expect(result.outcome).toBe("timed_out");
  });
});

describe("reading a run into a kind", () => {
  test("words first: a member that spoke and then failed spoke", () => {
    expect(outcomeOf({ spoke: 1, failed: "laf:provider_stream_cut" })).toBe(
      "spoke",
    );
  });

  test("a stop is a stop, not a failure and not silence", () => {
    expect(outcomeOf({ spoke: 0, failed: null, stopped: true })).toBe(
      "stopped",
    );
  });

  test("the model's own timeout is a timeout, by the transcript's own classifier", () => {
    expect(outcomeOf({ spoke: 0, failed: "laf:model_timed_out" })).toBe(
      "timed_out",
    );
    expect(outcomeOf({ spoke: 0, failed: "laf:model_rate_limited" })).toBe(
      "failed",
    );
  });
});

describe("a member asked twice in one turn", () => {
  test("spoke at any point wins; otherwise the later asking; a stop changes nothing", () => {
    expect(settleOutcome("spoke", "failed")).toBe("spoke");
    expect(settleOutcome("failed", "passed")).toBe("passed");
    expect(settleOutcome("passed", "timed_out")).toBe("timed_out");
    expect(settleOutcome("passed", "stopped")).toBe("passed");
    expect(settleOutcome(undefined, "stopped")).toBe("stopped");
  });

  test("the turn keeps one outcome per member and leaves out one only a stop ever reached", () => {
    expect(
      summariseOutcomes([
        { id: "a", outcome: "passed" },
        { id: "b", outcome: "spoke" },
        { id: "c", outcome: "stopped" },
        { id: "a", outcome: "failed" },
        { id: "b", outcome: "passed" },
      ]),
    ).toEqual([
      { id: "a", outcome: "failed" },
      { id: "b", outcome: "spoke" },
    ]);
  });
});

describe("the orchestrator collects the kinds", () => {
  const roster: RoomMember[] = [
    { id: "sales", name: "매출봇" },
    { id: "stock", name: "재고봇" },
    { id: "review", name: "리뷰봇" },
  ];

  test("each member asked, once, with how it came out — and a silent round still ends the turn", async () => {
    const kinds: Record<string, MemberOutcome> = {
      sales: "passed",
      stock: "passed",
      review: "timed_out",
    };
    const outcome = await runRoomTurn({
      members: roster,
      addressedIds: [],
      isCurrent: async () => true,
      runMember: async ({ member: asked }) => ({
        spoke: 0,
        said: [],
        outcome: kinds[asked.id] ?? "passed",
      }),
    });
    expect(outcome.ended).toBe("silent-round");
    expect(
      Object.fromEntries(
        outcome.members.map((entry) => [entry.id, entry.outcome]),
      ),
    ).toEqual(kinds);
  });

  test("a caller that reports only words is read off them", async () => {
    const outcome = await runRoomTurn({
      members: roster,
      addressedIds: ["stock"],
      isCurrent: async () => true,
      runMember: async ({ member: asked }) => ({
        spoke: asked.id === "stock" ? 1 : 0,
        said: asked.id === "stock" ? ["내일 주문하세요"] : [],
      }),
    });
    expect(outcome.members).toEqual([{ id: "stock", outcome: "spoke" }]);
  });
});
