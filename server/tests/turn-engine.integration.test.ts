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
import { createBotLane } from "../src/runner/bot-lane";
import { createWorkInFlight } from "../src/runner/in-flight";
import { createRunLedger } from "../src/runner/run-ledger";
import { messagesFor } from "../src/runner/thread-store";
import type { LoopAgent } from "../src/runner/turn-loop";
import type { ChatToolkit } from "../src/turns/chat-tools";
import { createTurnEngine } from "../src/turns/engine";
import { historyPage } from "../src/turns/history";
import {
  createTurnHub,
  type TurnFrame,
  type TurnSnapshot,
} from "../src/turns/hub";
import { TEST_POOL } from "./support/database";

/**
 * The server owns the turn (`turns/engine.ts`): what the person said is filed the moment it
 * arrives, the Bot's tools are carried out here, every step is written as it ends, and the turn
 * finishes whether or not any window is watching. These drive it with a scripted Bot and a real
 * thread store, the way `chat-stop.integration.test.ts` drives the runner.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suffix = randomUUID().slice(0, 8);
const OWNER = `turn-engine-${suffix}`;
const BOT = `turn-engine-bot-${suffix}`;
const threads: string[] = [];
const madeChannels: string[] = [];

beforeAll(async () => {
  await database.insert(users).values({
    id: OWNER,
    email: `${OWNER}@laf.test`,
    name: "서버 턴 테스트",
  });
  await database.insert(agents).values({
    id: BOT,
    name: "서버 턴 비서",
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

async function aConversation(): Promise<{
  threadId: string;
  channelId: string;
}> {
  const threadId = randomUUID();
  const channelId = `channel_turn-engine-${randomUUID().slice(0, 8)}`;
  threads.push(threadId);
  madeChannels.push(channelId);
  await database.insert(channels).values({
    id: channelId,
    name: "서버 턴 비서",
    description: "Private agent channel.",
  });
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: OWNER });
  await database.insert(channelAgents).values({ channelId, agentId: BOT });
  await database
    .insert(channelThreads)
    .values({ userId: OWNER, channelId, threadId });
  return { threadId, channelId };
}

const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as BaseEvent;

type Subscriber = {
  onEvent?: (payload: { event: BaseEvent }) => unknown;
  onRunErrorEvent?: (payload: { event: { message: string } }) => unknown;
  onRunFinishedEvent?: () => unknown;
};

/**
 * A Bot that asks for one tool on its first run and answers on its second, reporting what it does
 * as the AG-UI events a real endpoint streams — which is what every watching window is handed.
 */
function scriptedBot(answer = "다 됐어요.") {
  const agent = {
    messages: [] as Message[],
    runs: 0,
    inputs: [] as Message[][],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(_input: unknown, subscriber?: Subscriber) {
      agent.inputs.push([...agent.messages]);
      agent.runs += 1;
      const emit = (e: BaseEvent) => subscriber?.onEvent?.({ event: e });
      emit(event("RUN_STARTED"));
      if (agent.runs === 1) {
        const id = `a-${randomUUID()}`;
        emit(event("TEXT_MESSAGE_START", { messageId: id, role: "assistant" }));
        emit(
          event("TEXT_MESSAGE_CONTENT", {
            messageId: id,
            delta: "찾아볼게요.",
          }),
        );
        emit(
          event("TOOL_CALL_START", {
            toolCallId: "call-1",
            toolCallName: "computer_navigate",
            parentMessageId: id,
          }),
        );
        emit(
          event("TOOL_CALL_ARGS", {
            toolCallId: "call-1",
            delta: '{"url":"https://example.com"}',
          }),
        );
        emit(event("TOOL_CALL_END", { toolCallId: "call-1" }));
        agent.messages.push({
          id,
          role: "assistant",
          content: "찾아볼게요.",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "computer_navigate",
                arguments: '{"url":"https://example.com"}',
              },
            },
          ],
        } as Message);
      } else {
        const id = `a-${randomUUID()}`;
        emit(event("TEXT_MESSAGE_START", { messageId: id, role: "assistant" }));
        emit(event("TEXT_MESSAGE_CONTENT", { messageId: id, delta: answer }));
        agent.messages.push({
          id,
          role: "assistant",
          content: answer,
        } as Message);
      }
      emit(event("RUN_FINISHED"));
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [] };
    },
  };
  return agent;
}

function engineWith(
  bot: ReturnType<typeof scriptedBot>,
  execute: ChatToolkit["execute"],
  options: { lane?: ReturnType<typeof createBotLane> } = {},
) {
  const hub = createTurnHub({ keepEndedMs: 50 });
  const announced: string[] = [];
  const engine = createTurnEngine({
    database,
    ledger: createRunLedger(database),
    hub,
    ...(options.lane ? { lane: options.lane } : {}),
    work: createWorkInFlight(),
    resolveAgents: async () => ({ [BOT]: bot as unknown as LoopAgent }),
    tools: async () => ({
      tools: [{ name: "computer_navigate", description: "go", parameters: {} }],
      execute,
    }),
    announce: async ({ text }) => {
      announced.push(text);
    },
  });
  return { engine, hub, announced };
}

const asked = (text: string): Message => ({
  id: randomUUID(),
  role: "user",
  content: text,
});

async function until(check: () => Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting");
}

const statusOf = async (runId: string) =>
  (
    await database
      .select({ status: lafThreadRuns.status })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId))
  )[0]?.status;

describe("a turn the server owns", () => {
  test("runs to its end with nobody watching, and every step is filed", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    const { engine, announced } = engineWith(bot, async () => ({
      ok: true,
      title: "Example",
    }));
    const question = asked("예시 페이지 확인해줘");
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [question],
      tools: null,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    // The person's words are safe before the Bot is asked anything.
    expect((await messagesFor(database, threadId)).map((m) => m.id)).toContain(
      question.id,
    );
    await until(async () => (await statusOf(sent.turnId)) === "done");
    const stored = await messagesFor(database, threadId);
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(stored[2]?.content).toBe('{"ok":true,"title":"Example"}');
    expect(stored.at(-1)?.lafAgentId).toBe(BOT);
    // The second run was handed the result the server filed, as the window's second run was.
    expect(bot.inputs[1]?.at(-1)?.role).toBe("tool");
    await until(async () => announced.length > 0);
    expect(announced).toEqual(["다 됐어요."]);
    // And it reads back a page at a time, newest last, each with its durable cursor.
    const page = await historyPage(database, threadId, { limit: 2 });
    expect(page.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(page.hasOlder).toBe(true);
    const above = await historyPage(database, threadId, {
      before: page.oldestSeq,
    });
    expect(above.messages.map((message) => message.id)).toEqual([question.id]);
  });

  test("every window sees one run, however many times the model is asked", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    const { engine, hub } = engineWith(bot, async () => ({ ok: true }));
    const frames: TurnFrame[] = [];
    hub.subscribe(threadId, { epoch: null, after: null }, (frame) => {
      if (frame.kind !== "snapshot") frames.push(frame);
    });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("한 번에 보여줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");
    await until(async () =>
      frames.some(
        (frame) => frame.kind === "turn" && frame.turn.status === "done",
      ),
    );
    const types = frames.flatMap((frame) =>
      frame.kind === "event" ? [String(frame.event.type)] : [],
    );
    expect(types.filter((type) => type === "RUN_STARTED")).toHaveLength(1);
    expect(types.filter((type) => type === "RUN_FINISHED")).toHaveLength(1);
    expect(types).toContain("TOOL_CALL_RESULT");
    // Numbered in order, with nothing skipped: a window's cursor can resume anywhere in it.
    const seqs = frames.map((frame) => frame.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
  });

  test("a window joining mid-turn is handed the turn so far, then the rest", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engine, hub } = engineWith(bot, async () => {
      await held;
      return { ok: true };
    });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("천천히 해줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => bot.runs === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    let snapshot: TurnSnapshot | null = null;
    hub.subscribe(threadId, { epoch: "another-process", after: 7 }, (frame) => {
      if (frame.kind === "snapshot") snapshot = frame;
    });
    const joined = snapshot as TurnSnapshot | null;
    expect(joined?.turn?.status).toBe("running");
    expect(joined?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    // A second message while the turn is going is not started beside it.
    const second = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("이것도")],
      tools: null,
    });
    expect(second).toEqual({ ok: false, code: "laf:turn_in_progress" });
    release();
    await until(async () => (await statusOf(sent.turnId)) === "done");
  });

  test("a stop from any window ends the turn, and the call it cut is answered as stopped", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    const { engine } = engineWith(
      bot,
      (_name, _args, call) =>
        new Promise((resolve) => {
          call.signal.addEventListener("abort", () =>
            resolve({ ok: false, code: "laf:stopped", stopped: true }),
          );
        }),
    );
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("오래 걸리는 일")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => bot.runs === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(engine.stop(threadId)).toBe(true);
    await until(async () => (await statusOf(sent.turnId)) === "stopped");
    const stored = await messagesFor(database, threadId);
    const result = stored.find((message) => message.role === "tool");
    expect(JSON.parse(String(result?.content))).toMatchObject({
      code: "laf:stopped",
      stopped: true,
    });
    // The model was not asked again after the stop.
    expect(bot.runs).toBe(1);
    expect(engine.busy(threadId)).toBe(false);
  });

  test("a turn waiting behind the Bot's lane already has its record", async () => {
    const { threadId, channelId } = await aConversation();
    const lane = createBotLane();
    let free: () => void = () => {};
    void lane.run(
      BOT,
      () =>
        new Promise<void>((resolve) => {
          free = resolve;
        }),
    );
    const bot = scriptedBot();
    const { engine } = engineWith(bot, async () => ({ ok: true }), { lane });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("루틴 다음에")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    // Queued behind a routine: the row is open, so a process that dies now is found at boot.
    expect(await statusOf(sent.turnId)).toBe("running");
    expect(bot.runs).toBe(0);
    free();
    await until(async () => (await statusOf(sent.turnId)) === "done");
  });
});
