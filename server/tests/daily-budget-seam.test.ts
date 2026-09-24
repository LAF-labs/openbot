import { describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import type { AuditEventInput } from "../src/audit";
import {
  classifyTurnFailure,
  TURN_FAILURE_CODES,
} from "../src/channels/turn-failures";
import { buildAgents, type RunMeter } from "../src/copilot";
import { runAgentOnce } from "../src/routines/run-once";
import { type ToolExecutor, runUnattended } from "../src/runner/unattended";
import {
  DAILY_BUDGET_REACHED,
  type DailyBudget,
} from "../src/usage/daily-budget";

/**
 * Where a trial's day is judged: before a run leaves this server, at the one seam every run shares.
 *
 * Chat, a room's turn, a routine and one Bot asking another all build their agents through
 * `copilot.ts`, so a judgement made there reaches all four without any of them knowing (self-serve
 * contract §4.6). What is asserted is what the Bot's endpoint RECEIVED — nothing, on a spent day —
 * and what the run said instead, because a refusal that also sent the request would be a refusal in
 * name only, and one that sent nothing and said nothing would be a Bot that simply went quiet.
 */

const BOT = "agent_shop";

function endpoint() {
  const received: Array<{ runId?: string; threadId?: string }> = [];
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as {
      runId?: string;
      threadId?: string;
    };
    received.push(body);
    const messageId = `said-${body.runId}`;
    const events = [
      { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
      {
        type: "CUSTOM",
        name: "laf.model.usage",
        value: {
          model: "laf-1",
          promptTokens: 900,
          completionTokens: 34,
          totalTokens: 934,
        },
      },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "주문은 3건이에요." },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  return { received, fetch };
}

/** A judge whose verdict the test sets, counting how often it was asked. */
function judge(reached: boolean) {
  const state = { reached, asked: 0 };
  const budget: DailyBudget = {
    tokens: 3_000_000,
    usedToday: async () => (state.reached ? 3_000_000 : 0),
    reachedToday: async () => {
      state.asked += 1;
      return state.reached;
    },
  };
  return { budget, state };
}

function shop(fetch: ReturnType<typeof endpoint>["fetch"], meter?: RunMeter) {
  const agents = buildAgents(
    [
      {
        id: BOT,
        name: "미소",
        type: "remote_ag_ui",
        endpoint: "http://agent-bot.internal/ag-ui",
        profile: {
          id: BOT,
          name: "미소",
          roleDescription: "주문을 챙긴다.",
        },
        effort: "balanced",
      },
    ],
    { provider: "openai", defaultModel: "laf-1", supportsEffort: false },
    // Not a socket: the endpoint, reached through the agent's own fetch.
    { watch: () => fetch as never, stop: () => undefined },
    "Asia/Seoul",
    undefined,
    meter,
  );
  const agent = agents[BOT];
  if (!agent) throw new Error("the agent was not built");
  return agent;
}

/** One chat-shaped run, and what its subscriber heard. */
async function chat(agent: AbstractAgent) {
  agent.setMessages([{ id: "ask", role: "user", content: "주문 확인해줘" }]);
  const heard = { errors: [] as string[], finished: false };
  await agent.runAgent(
    {},
    {
      onRunErrorEvent: ({ event }) => {
        heard.errors.push(event.message);
      },
      onRunFinishedEvent: () => {
        heard.finished = true;
      },
    },
  );
  return heard;
}

const noTools: { tools: []; execute: ToolExecutor } = {
  tools: [],
  execute: async () => ({ ok: true }),
};

describe("a run on a day the trial has spent", () => {
  test("never leaves this server: the endpoint receives nothing, and the run ends on the fact", async () => {
    const { received, fetch } = endpoint();
    const { budget } = judge(true);

    const heard = await chat(shop(fetch, { dailyBudget: budget }));

    expect(received).toEqual([]);
    expect(heard).toEqual({ errors: [DAILY_BUDGET_REACHED], finished: false });
  });

  test("is judged on the copy the runtime runs, which is how every chat turn is driven", async () => {
    const { received, fetch } = endpoint();
    const heard = await chat(
      shop(fetch, { dailyBudget: judge(true).budget }).clone(),
    );
    expect(received).toEqual([]);
    expect(heard.errors).toEqual([DAILY_BUDGET_REACHED]);
  });

  test("is refused in a routine's loop the same way, and the routine's record names why", async () => {
    const { received, fetch } = endpoint();
    const agent = shop(fetch, { dailyBudget: judge(true).budget });

    const failure = await runUnattended(agent, "매일 아침 주문 요약해줘", {
      toolkit: noTools,
      timeoutMs: 5_000,
      mode: "routine",
    }).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(received).toEqual([]);
    expect(failure?.message).toContain(DAILY_BUDGET_REACHED);
    // What `routine.ran`, the notification and the transcript after a reload all read.
    expect(classifyTurnFailure(failure?.message ?? null)).toBe(
      TURN_FAILURE_CODES.dailyBudgetReached,
    );
  });

  test("is refused in a routine's toolless run, which never reaches the endpoint either", async () => {
    const { received, fetch } = endpoint();
    await runAgentOnce(
      shop(fetch, { dailyBudget: judge(true).budget }),
      "재고 알려줘",
      5_000,
    );
    expect(received).toEqual([]);
  });
});

describe("a run on a day with room left", () => {
  test("reaches the endpoint exactly as before, having asked the judge once", async () => {
    const { received, fetch } = endpoint();
    const { budget, state } = judge(false);

    const heard = await chat(shop(fetch, { dailyBudget: budget }));

    expect(received).toHaveLength(1);
    expect(heard).toEqual({ errors: [], finished: true });
    expect(state.asked).toBe(1);
  });

  test("is judged per run, so the run after the day fills is the one refused", async () => {
    const { received, fetch } = endpoint();
    const { budget, state } = judge(false);
    const agent = shop(fetch, { dailyBudget: budget });

    expect((await chat(agent)).finished).toBe(true);
    state.reached = true;
    expect((await chat(agent)).errors).toEqual([DAILY_BUDGET_REACHED]);
    expect(received).toHaveLength(1);
  });

  test("with no judge at all — a deployment that is not a trial — nothing is asked and nothing refused", async () => {
    const { received, fetch } = endpoint();
    const heard = await chat(shop(fetch, {}));
    expect(received).toHaveLength(1);
    expect(heard.finished).toBe(true);
  });
});

describe("what every run costs, on the trail the judge reads", () => {
  /*
   * MEASURED BY READING, THEN BY THIS TEST: until the seam wrote it, a `model.usage` row came only
   * from the runner the chat endpoint drives. A routine runs its agent directly, and its
   * `laf.model.usage` events were read by nobody — so the budget a trial is held to would have
   * counted chat and nothing else.
   */
  test("a routine, a toolless routine and a chat turn each write one row per usage event", async () => {
    const rows: AuditEventInput[] = [];
    const { received, fetch } = endpoint();
    const agent = shop(fetch, {
      auditStore: { insert: async (event) => void rows.push(event) },
    });

    await runUnattended(agent, "매일 아침 주문 요약해줘", {
      toolkit: noTools,
      timeoutMs: 5_000,
      mode: "routine",
    });
    await runAgentOnce(agent, "재고 알려줘", 5_000);
    const copy = agent.clone();
    copy.threadId = "thread-chat";
    copy.setMessages([{ id: "ask", role: "user", content: "주문 확인해줘" }]);
    await copy.runAgent({ runId: "run-chat" });

    expect(received).toHaveLength(3);
    const usage = rows.filter((row) => row.eventType === "model.usage");
    expect(usage.map((row) => row.payload.runId)).toEqual(
      received.map((request) => request.runId),
    );
    expect(usage.at(-1)).toEqual({
      eventType: "model.usage",
      targetType: "agent",
      targetId: BOT,
      payload: {
        runId: "run-chat",
        threadId: "thread-chat",
        botId: BOT,
        model: "laf-1",
        promptTokens: 900,
        completionTokens: 34,
        totalTokens: 934,
        source: "bot-turn",
      },
    });
  });

  test("a refused run costs nothing and writes nothing", async () => {
    const rows: AuditEventInput[] = [];
    const { fetch } = endpoint();
    await chat(
      shop(fetch, {
        auditStore: { insert: async (event) => void rows.push(event) },
        dailyBudget: judge(true).budget,
      }),
    );
    expect(rows).toEqual([]);
  });
});
