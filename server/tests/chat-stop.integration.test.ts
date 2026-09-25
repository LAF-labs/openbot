import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createWorkInFlight } from "../src/runner/in-flight";
import { LafPostgresRunner } from "../src/runner/laf-runner";
import { createRunLedger } from "../src/runner/run-ledger";
import { messagesFor } from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * A one-to-one conversation, stopped by `모두 멈추기` from anywhere.
 *
 * WHAT WAS TRACED. The browser's own Stop does not stop a turn in the browser alone: CopilotKit's
 * `stopAgent` posts `/api/copilotkit/agent/:bot/stop/:thread`, and the runner aborts the Bot's
 * stream on the server. So the part of a turn that is ON THE WIRE the server can stop for itself,
 * from any window. What only a browser can stop is the part in between: a Bot's action is a tool the
 * browser runs, the run ENDS while it does, and the browser then starts the next run carrying the
 * result. Nothing is running on the server during that step.
 *
 * So the runner lists both: the run on the wire, stopped by aborting it; and a turn whose last run
 * handed a step to a browser, stopped by not continuing it — the step already under way finishes
 * (work done is not undone) and the run that would have carried its result onward ends before the
 * model is asked. A person's own next message is never refused.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suffix = randomUUID().slice(0, 8);
const OWNER = `chat-stop-${suffix}`;
const BOT = `chat-stop-bot-${suffix}`;
const threads: string[] = [];
const madeChannels: string[] = [];

beforeAll(async () => {
  await database.insert(users).values({
    id: OWNER,
    email: `${OWNER}@laf.test`,
    name: "대화 멈춤 테스트",
  });
  await database.insert(agents).values({
    id: BOT,
    name: "상담 비서",
    type: "remote_ag_ui",
    configuration: {},
  });
});

afterAll(async () => {
  for (const threadId of threads) {
    await database
      .delete(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, threadId));
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  if (madeChannels.length > 0) {
    await database.delete(channels).where(inArray(channels.id, madeChannels));
  }
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(eq(users.id, OWNER));
  await database.$client.close();
});

/**
 * A conversation of this person's with the Bot, as the channel store would have made it. One per
 * test: a person has one thread per channel, so each test gets a channel of its own.
 */
async function aThread(): Promise<string> {
  const threadId = randomUUID();
  const channelId = `channel_chat-stop-${randomUUID().slice(0, 8)}`;
  threads.push(threadId);
  madeChannels.push(channelId);
  await database.insert(channels).values({
    id: channelId,
    name: "상담 비서",
    description: "Private agent channel.",
  });
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: OWNER });
  await database.insert(channelAgents).values({ channelId, agentId: BOT });
  await database
    .insert(channelThreads)
    .values({ userId: OWNER, channelId, threadId });
  return threadId;
}

const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as BaseEvent;

type Subscriber = { onEvent?: (payload: { event: BaseEvent }) => unknown };

/** A Bot that starts answering and keeps going until it is aborted, the way a transport ends. */
function streamingBot() {
  let asked = 0;
  let abort: (() => void) | undefined;
  const agent = {
    agentId: BOT,
    messages: [] as Message[],
    abortRun() {
      abort?.();
    },
    async runAgent(_input: unknown, subscriber?: Subscriber) {
      asked += 1;
      subscriber?.onEvent?.({ event: event("RUN_STARTED") });
      subscriber?.onEvent?.({
        event: event("TEXT_MESSAGE_START", {
          messageId: "m1",
          role: "assistant",
        }),
      });
      subscriber?.onEvent?.({
        event: event("TEXT_MESSAGE_CONTENT", {
          messageId: "m1",
          delta: "주문을 확인하는 중",
        }),
      });
      await new Promise<void>((_, reject) => {
        abort = () => reject(new Error("The operation was aborted."));
      });
      return { result: undefined, newMessages: [] };
    },
  };
  return { agent, asked: () => asked };
}

/** A Bot whose run ends by handing one click to the browser, as every computer tool does. */
function clickingBot() {
  let asked = 0;
  const agent = {
    agentId: BOT,
    messages: [] as Message[],
    abortRun() {},
    async runAgent(_input: unknown, subscriber?: Subscriber) {
      asked += 1;
      for (const one of [
        event("RUN_STARTED"),
        event("TOOL_CALL_START", {
          toolCallId: "call-1",
          toolCallName: "computer_click",
        }),
        event("TOOL_CALL_ARGS", {
          toolCallId: "call-1",
          delta: '{"ref":"e1","snapshotId":1}',
        }),
        event("TOOL_CALL_END", { toolCallId: "call-1" }),
        event("RUN_FINISHED"),
      ]) {
        subscriber?.onEvent?.({ event: one });
      }
      return { result: undefined, newMessages: [] };
    },
  };
  return { agent, asked: () => asked };
}

/** A Bot that answers in one line. */
function answeringBot() {
  let asked = 0;
  const agent = {
    agentId: BOT,
    messages: [] as Message[],
    abortRun() {},
    async runAgent(_input: unknown, subscriber?: Subscriber) {
      asked += 1;
      for (const one of [
        event("RUN_STARTED"),
        event("TEXT_MESSAGE_START", { messageId: "m9", role: "assistant" }),
        event("TEXT_MESSAGE_CONTENT", { messageId: "m9", delta: "네." }),
        event("TEXT_MESSAGE_END", { messageId: "m9" }),
        event("RUN_FINISHED"),
      ]) {
        subscriber?.onEvent?.({ event: one });
      }
      return { result: undefined, newMessages: [] };
    },
  };
  return { agent, asked: () => asked };
}

function start(
  runner: LafPostgresRunner,
  threadId: string,
  agent: unknown,
  messages: Message[],
) {
  const runId = randomUUID();
  const seen: BaseEvent[] = [];
  const events = runner.run({
    threadId,
    agent: agent as never,
    input: {
      threadId,
      runId,
      messages,
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    } as never,
  });
  const ended = new Promise<void>((resolve) => {
    events.subscribe({
      next: (one) => void seen.push(one),
      complete: resolve,
      error: () => resolve(),
    });
  });
  return { runId, seen, ended };
}

async function until(ready: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (!(await ready())) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

async function statusOf(runId: string) {
  const [row] = await database
    .select({ status: lafThreadRuns.status })
    .from(lafThreadRuns)
    .where(eq(lafThreadRuns.runId, runId));
  return row?.status;
}

const asked: Message = {
  id: "u1",
  role: "user",
  content: "오늘 주문 정리해 줘",
};

describe("a one-to-one conversation stopped from anywhere", () => {
  test("a run on the wire is its owner's chat, and stopping it ends the stream as stopped", async () => {
    const work = createWorkInFlight();
    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
      work,
    );
    const threadId = await aThread();
    const bot = streamingBot();

    const run = start(runner, threadId, bot.agent, [asked]);
    await until(() => work.of(OWNER).length === 1, "the run to be listed");
    expect(
      work.of(OWNER).map(({ kind, agentId, threadId: thread }) => ({
        kind,
        agentId,
        thread,
      })),
    ).toEqual([{ kind: "chat", agentId: BOT, thread: threadId }]);
    expect(work.of("somebody-else")).toEqual([]);

    expect(await work.of(OWNER)[0]?.stop()).toBe(true);
    await run.ended;
    // The browser sees the run end, not fail.
    expect(run.seen.at(-1)?.type).toBe("RUN_FINISHED" as never);
    expect(work.of(OWNER)).toEqual([]);
    await until(
      async () => (await statusOf(run.runId)) === "stopped",
      "the ledger to say stopped",
    );
  }, 20_000);

  test("a turn handed to a browser is listed, and a stop keeps that step from being carried on", async () => {
    const work = createWorkInFlight();
    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
      work,
    );
    const threadId = await aThread();

    // The Bot asks the browser for a click, and the run ends while the browser does it.
    const first = start(runner, threadId, clickingBot().agent, [asked]);
    await first.ended;
    await until(() => work.of(OWNER).length === 1, "the step to be listed");
    expect(work.of(OWNER).map((entry) => entry.kind)).toEqual(["chat"]);

    expect(await work.of(OWNER)[0]?.stop()).toBe(true);

    // The browser finishes the click and starts the run that would carry its result onward.
    const carrier = answeringBot();
    const clicked: Message[] = [
      asked,
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "computer_click",
              arguments: '{"ref":"e1","snapshotId":1}',
            },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "call-1", content: '{"ok":true}' },
    ];
    const second = start(runner, threadId, carrier.agent, clicked);
    await second.ended;

    // The model is not asked, and the browser sees an ordinary end rather than an error.
    expect(carrier.asked()).toBe(0);
    expect(second.seen.map((one) => one.type)).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
    ] as never);
    await until(
      async () => (await statusOf(second.runId)) === "stopped",
      "the ledger to say stopped",
    );
    // The step that happened is kept: its result is in the conversation.
    await until(
      async () =>
        (await messagesFor(database, threadId)).some(
          (message) => message.id === "t1",
        ),
      "the step's result to be kept",
    );
    expect(work.of(OWNER)).toEqual([]);

    // And the person's own next message is answered as always.
    const next = answeringBot();
    const third = start(runner, threadId, next.agent, [
      ...clicked,
      { id: "u2", role: "user", content: "다시 해 줘" },
    ]);
    await third.ended;
    expect(next.asked()).toBe(1);
  }, 20_000);

  test("a step nobody stopped is carried on as always", async () => {
    const work = createWorkInFlight();
    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
      work,
    );
    const threadId = await aThread();
    await start(runner, threadId, clickingBot().agent, [asked]).ended;
    const carrier = answeringBot();
    await start(runner, threadId, carrier.agent, [
      asked,
      { id: "t1", role: "tool", toolCallId: "call-1", content: "{}" },
    ]).ended;
    expect(carrier.asked()).toBe(1);
    // The continuation ended the step: nothing is left listed for this thread.
    expect(work.of(OWNER)).toEqual([]);
  }, 20_000);
});

/**
 * THE LEDGER SAYS HOW A HANDED-OVER STEP REALLY ENDED (UX review 0.5.4, finding 1). A run that ends
 * by handing a step to a window used to be written `done` at once, so a task that died with its
 * window — its approval card with it — read as finished everywhere.
 */
describe("a run whose step is with a window", () => {
  async function handedOver() {
    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
      createWorkInFlight(),
    );
    const threadId = await aThread();
    const first = start(runner, threadId, clickingBot().agent, [asked]);
    await first.ended;
    await until(
      async () => (await statusOf(first.runId)) === "waiting",
      "the ledger to say waiting",
    );
    expect(runner.stepState(threadId)).toEqual({
      running: false,
      waiting: true,
    });
    return { runner, threadId, first };
  }

  test("is waiting, and done once its result carries the turn on", async () => {
    const { runner, threadId, first } = await handedOver();
    await start(runner, threadId, answeringBot().agent, [
      asked,
      { id: "t1", role: "tool", toolCallId: "call-1", content: "{}" },
    ]).ended;
    await until(
      async () => (await statusOf(first.runId)) === "done",
      "the step's run to say done",
    );
    expect(runner.stepState(threadId).waiting).toBe(false);
  }, 20_000);

  test("is stopped when the person presses Stop while the window has the step", async () => {
    const { runner, threadId, first } = await handedOver();
    await runner.stop({ threadId } as never);
    await until(
      async () => (await statusOf(first.runId)) === "stopped",
      "the step's run to say stopped",
    );
  }, 20_000);

  test("is stopped, with why, when its window goes away without it", async () => {
    const { runner, threadId, first } = await handedOver();
    expect(runner.abandonStep(threadId)).toBe(true);
    await until(
      async () => (await statusOf(first.runId)) === "stopped",
      "the step's run to say stopped",
    );
    const [row] = await database
      .select({ error: lafThreadRuns.error })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, first.runId));
    expect(row?.error).toBe("laf:step_not_returned");
    expect(runner.abandonStep(threadId)).toBe(false);
  }, 20_000);

  test("is stopped when the person says something new instead of the step coming back", async () => {
    const { runner, threadId, first } = await handedOver();
    await start(runner, threadId, answeringBot().agent, [
      asked,
      { id: "u2", role: "user", content: "그거 말고 다른 거" },
    ]).ended;
    await until(
      async () => (await statusOf(first.runId)) === "stopped",
      "the step's run to say stopped",
    );
  }, 20_000);
});
