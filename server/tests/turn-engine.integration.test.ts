import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { isFirstMove } from "../../shared/first-move";
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
import type { ChatToolkit, ChatTurnContext } from "../src/turns/chat-tools";
import { createTurnEngine } from "../src/turns/engine";
import type { FirstMove } from "../src/turns/first-move";
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
    runIds: [] as Array<string | undefined>,
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      input: { runId?: string } | undefined,
      subscriber?: Subscriber,
    ) {
      agent.inputs.push([...agent.messages]);
      agent.runIds.push(input?.runId);
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
  execute:
    | ChatToolkit["execute"]
    | ((context: ChatTurnContext) => ChatToolkit["execute"]),
  options: {
    lane?: ReturnType<typeof createBotLane>;
    resolveAgents?: () => Promise<Record<string, LoopAgent | undefined>>;
    timeoutMs?: number;
    firstMove?: () => Promise<FirstMove | null>;
    /** The thread's store as the engine reaches it — a test's may refuse a write. */
    store?: typeof database;
  } = {},
) {
  const hub = createTurnHub({ keepEndedMs: 50 });
  const announced: string[] = [];
  const engine = createTurnEngine({
    database: options.store ?? database,
    // A test waits milliseconds for a write to be tried again, not seconds.
    persistRetryMs: [5, 5, 5],
    ledger: createRunLedger(database),
    hub,
    ...(options.lane ? { lane: options.lane } : {}),
    work: createWorkInFlight(),
    resolveAgents:
      options.resolveAgents ??
      (async () => ({ [BOT]: bot as unknown as LoopAgent })),
    tools: async (context) => ({
      tools: [{ name: "computer_navigate", description: "go", parameters: {} }],
      execute:
        execute.length === 1
          ? (execute as (context: ChatTurnContext) => ChatToolkit["execute"])(
              context,
            )
          : (execute as ChatToolkit["execute"]),
    }),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.firstMove ? { firstMove: options.firstMove } : {}),
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
    // And every run answered in the conversation's own thread, which its epoch is kept under.
    expect((bot as { threadId?: string }).threadId).toBe(threadId);
    await until(async () => announced.length > 0);
    expect(announced).toEqual(["다 됐어요."]);
    // And it reads back a page at a time, newest last, each with its durable cursor. A page of
    // two would begin on the tool's answer: it reaches back to the message that began the turn.
    const page = await historyPage(database, threadId, { limit: 2 });
    expect(page.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(page.messages[0]?.id).toBe(question.id);
    expect(page.hasOlder).toBe(false);
    // The cursor is the oldest message's own, and nothing is above it.
    const above = await historyPage(database, threadId, {
      before: page.oldestSeq,
    });
    expect(above.messages).toEqual([]);
    expect(above.hasOlder).toBe(false);
  });

  test("a tool's answer cut through an emoji is filed sound, and the turn is kept", async () => {
    /*
     * A connected service's answer is a string, cut at a length — and a cut between an emoji's two
     * halves used to be filed as it was. Postgres then refused the turn's rows, so the turn was
     * gone on reload, and the Bots' model refused the request that carried it (measured 2026-10-02:
     * HTTP 400, "unexpected end of hex escape"). `shared/sound-text.ts`.
     */
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot("메일은 이래요.");
    const half = "😀".charAt(0);
    const { engine } = engineWith(bot, async () => `${"가".repeat(30)}${half}`);
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("메일 읽어줘")],
      tools: null,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    await until(async () => (await statusOf(sent.turnId)) === "done");
    // What the Bot's second run was handed: nothing the model would refuse.
    const handed = bot.inputs[1]?.at(-1);
    expect(handed?.role).toBe("tool");
    expect(handed?.content).toBe(`${"가".repeat(30)}\ufffd`);
    // And every step of the turn is in the store, the answer included.
    const stored = await messagesFor(database, threadId);
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(stored[2]?.content).toBe(`${"가".repeat(30)}\ufffd`);
    expect(stored.at(-1)?.content).toBe("메일은 이래요.");
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

/**
 * A store whose writes can be made to fail: the thread's own, with `transaction` — the one door
 * `appendMessages` writes through — refusing while `refusing` says how many more to refuse.
 */
function flakyStore() {
  const state = { refusing: 0, refused: 0 };
  const store = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (...args: unknown[]) => {
          if (state.refusing > 0) {
            state.refusing -= 1;
            state.refused += 1;
            return Promise.reject(new Error("connection terminated"));
          }
          return (target.transaction as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as typeof database;
  return { store, state };
}

/*
 * A TURN WHOSE END IS NOT WRITTEN IS NOT A TURN THAT FINISHED (refactoring review, 2026-10-02).
 * Every write of a turn's rows went through a function that swallowed its failure, and the turn was
 * settled `done` regardless: the person watched the whole answer arrive, reloaded, and found their
 * question alone, with no word that anything had gone wrong.
 */
describe("the end of a turn, and the store it is written to", () => {
  test("a store that refuses for a moment is written to again, and the turn is done", async () => {
    const { threadId, channelId } = await aConversation();
    const { store, state } = flakyStore();
    const bot = scriptedBot("다 됐어요.");
    /*
     * Refused from the moment the Bot has said its answer: the step's own write, and the first try
     * at the turn's last one. Earlier in a turn a refused write is carried by the next step's, so
     * only here does the retry decide whether the answer is kept.
     */
    const answer = bot.runAgent;
    bot.runAgent = async (input, subscriber) => {
      // A model takes its time: the tool's answer is written before the reply exists. (The
      // scripted Bot answers within the same tick, and that write would carry the reply with it.)
      if (bot.runs === 1)
        await new Promise((resolve) => setTimeout(resolve, 40));
      const result = await answer(input, subscriber);
      if (bot.runs === 2) state.refusing = 2;
      return result;
    };
    const { engine } = engineWith(bot, async () => ({ ok: true }), { store });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("잠깐 끊겨도 남겨줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(state.refused).toBe(2);
    const stored = await messagesFor(database, threadId);
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(stored.at(-1)?.content).toBe("다 됐어요.");
  });

  test("a store that goes on refusing is a turn that failed, and every window is told", async () => {
    const { threadId, channelId } = await aConversation();
    const { store, state } = flakyStore();
    const bot = scriptedBot("다 됐어요.");
    const { engine, hub } = engineWith(
      bot,
      async () => {
        state.refusing = Number.POSITIVE_INFINITY;
        return { ok: true };
      },
      { store },
    );
    const frames: TurnFrame[] = [];
    hub.subscribe(threadId, { epoch: null, after: null }, (frame) => {
      if (frame.kind !== "snapshot") frames.push(frame);
    });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("끝내 못 남기면 말해줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "error");
    state.refusing = 0;
    // The first try and three more, on top of the two steps' own.
    expect(state.refused).toBeGreaterThanOrEqual(4);
    // Not `done`: what the person watched is not in the thread, and the turn says so.
    const ended = frames.find(
      (frame) => frame.kind === "turn" && frame.turn.status === "error",
    );
    expect(ended && ended.kind === "turn" ? ended.turn.code : null).toBe(
      "laf:turn_failed",
    );
    expect(
      frames.some(
        (frame) => frame.kind === "event" && frame.event.type === "RUN_ERROR",
      ),
    ).toBe(true);
    const stored = await messagesFor(database, threadId);
    expect(stored.at(-1)?.content).not.toBe("다 됐어요.");
  });
});

/*
 * WHAT A TURN HAS MADE IS WRITTEN BEFORE THE PROCESS LEAVES. Every upgrade restarts the server, and
 * SIGTERM was `process.exit` on the same tick: the part of an answer that had streamed, and a step
 * whose write was still in flight, went with it (refactoring review, 2026-10-02).
 */
describe("a turn in flight when the server is asked to leave", () => {
  test("is written as far as it has got, without being finished", async () => {
    const { threadId, channelId } = await aConversation();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const half: Message = {
      id: `a-${randomUUID()}`,
      role: "assistant",
      content: "지금까지 찾은 건",
    } as Message;
    // A Bot part-way through its answer: the words so far are in its messages, and no end has come.
    const bot = {
      messages: [] as Message[],
      setMessages(messages: Message[]) {
        bot.messages = [...messages];
      },
      addMessage(message: Message) {
        bot.messages.push(message);
      },
      async runAgent(_input: unknown, subscriber?: Subscriber) {
        subscriber?.onEvent?.({ event: event("RUN_STARTED") });
        subscriber?.onEvent?.({
          event: event("TEXT_MESSAGE_START", {
            messageId: half.id,
            role: "assistant",
          }),
        });
        bot.messages.push(half);
        await held;
        subscriber?.onEvent?.({ event: event("RUN_FINISHED") });
        subscriber?.onRunFinishedEvent?.();
        return { result: undefined, newMessages: [] };
      },
    };
    const { engine } = engineWith(
      bot as unknown as ReturnType<typeof scriptedBot>,
      async () => ({ ok: true }),
    );
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("길게 답해줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => bot.messages.includes(half));
    // Nothing has written it yet: a turn writes at its steps, and this one is inside its first.
    expect(
      (await messagesFor(database, threadId)).map((message) => message.id),
    ).not.toContain(half.id);

    await engine.flush();
    const stored = await messagesFor(database, threadId);
    expect(stored.at(-1)?.id).toBe(half.id);
    expect(stored.at(-1)?.content).toBe("지금까지 찾은 건");
    // And the turn is still the turn it was: flushed, not ended.
    expect(await statusOf(sent.turnId)).toBe("running");

    release();
    await until(async () => (await statusOf(sent.turnId)) === "done");
  });

  test("with no turn in flight there is nothing to wait for", async () => {
    const { engine } = engineWith(scriptedBot(), async () => ({ ok: true }));
    await engine.flush();
  });
});

describe("a turn and the Bot's lane", () => {
  test("a turn waiting on a person lets a routine have the Bot, and takes it back before it acts", async () => {
    /*
     * Review H1: a turn held the lane through every wait on a person — up to ten minutes a
     * question — and the 07:30 briefing queued behind it ran at nine. The lane is let go of for the
     * wait, and whoever reads the wait's outcome is told a routine drove the Bot meanwhile.
     */
    const { threadId, channelId } = await aConversation();
    const lane = createBotLane();
    const bot = scriptedBot();
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const order: string[] = [];
    const seen: { moved: boolean | null } = { moved: null };
    const { engine, hub } = engineWith(
      bot,
      (context: ChatTurnContext) => async () => {
        order.push("turn: asked the person");
        const waited = await context.awaitPerson?.(() => answered);
        seen.moved = waited?.moved ?? null;
        order.push("turn: acts again");
        return { ok: true };
      },
      { lane },
    );
    const statuses: string[] = [];
    hub.subscribe(threadId, { epoch: null, after: null }, (frame) => {
      if (frame.kind === "turn") statuses.push(frame.turn.status);
    });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("결제 전에 물어봐줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => order.length === 1);
    // The routine due now runs now, not when the person gets round to answering.
    await lane.run(BOT, async () => {
      order.push("routine ran");
    });
    expect(order).toEqual(["turn: asked the person", "routine ran"]);
    // A routine that is still on the Bot when the person answers: the turn has to wait for it.
    const routine = await lane.acquire(BOT);
    answer();
    await until(async () => statuses.at(-1) === "queued");
    /*
     * Waiting for the Bot again is SAID. It used to go quiet here — the window showed a Bot
     * thinking for as long as the routine took (refactoring review, 2026-10-02).
     */
    expect(statuses).toEqual(["queued", "running", "queued"]);
    expect(order).not.toContain("turn: acts again");
    routine.release();
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(statuses).toEqual([
      "queued",
      "running",
      "queued",
      "running",
      "done",
    ]);
    expect(order).toEqual([
      "turn: asked the person",
      "routine ran",
      "turn: acts again",
    ]);
    expect(seen.moved).toBe(true);
  });

  test("a stop while the turn waits for the Bot does not wait for the Bot", async () => {
    const { threadId, channelId } = await aConversation();
    const lane = createBotLane();
    const busy = await lane.acquire(BOT);
    const bot = scriptedBot();
    const { engine } = engineWith(bot, async () => ({ ok: true }), { lane });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("루틴 끝나면 해줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    expect(engine.stop(threadId)).toBe(true);
    await until(async () => (await statusOf(sent.turnId)) === "stopped");
    expect(bot.runs).toBe(0);
    // And the lane it never got is not kept from whoever comes next.
    busy.release();
    expect(await lane.run(BOT, async () => "next")).toBe("next");
  });
});

describe("how a turn ends", () => {
  test("a correction sent the moment the end is heard is taken, not refused as in progress", async () => {
    // Review L1: the end frame went out before the conversation was freed.
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    const { engine, hub } = engineWith(bot, async () => ({ ok: true }));
    const next: Array<Promise<{ ok: boolean }>> = [];
    hub.subscribe(threadId, { epoch: null, after: null }, (frame) => {
      if (
        frame.kind === "turn" &&
        frame.turn.status === "done" &&
        next.length === 0
      ) {
        next.push(
          engine.send({
            threadId,
            channelId,
            owner: { id: OWNER, role: "user" },
            botId: BOT,
            messages: [asked("아 그리고 하나 더")],
            tools: null,
          }),
        );
      }
    });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("첫 번째")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => next.length === 1);
    const second = await next[0];
    expect(second?.ok).toBe(true);
    if (second && "turnId" in second) {
      await until(
        async () => (await statusOf(String(second.turnId))) !== "running",
      );
    }
  });

  /*
   * THE BOT'S STREAM STOPPED IN THE MIDDLE OF A CALL (2026-09-27). Nobody answered the call, and
   * filed as merely unanswered it went back to the model on every later request as `remember({})`
   * — its arguments were half an object. It is the cut, so the Bot service leaves it out of every
   * request after (`shared/stream-cut.ts`); the retry in place then runs as any turn does.
   */
  test("a call cut partway through its arguments is filed as the cut, and the retry answers", async () => {
    const { threadId, channelId } = await aConversation();
    const answer = "가게 정보를 적어 뒀어요.";
    const bot = scriptedBot(answer);
    const scripted = bot.runAgent;
    bot.runAgent = async (input, subscriber) => {
      if (bot.runs > 0) return scripted(input, subscriber);
      bot.runs += 1;
      bot.inputs.push([...bot.messages]);
      const emit = (e: BaseEvent) => subscriber?.onEvent?.({ event: e });
      const id = `a-${randomUUID()}`;
      emit(event("RUN_STARTED"));
      emit(
        event("TOOL_CALL_START", {
          toolCallId: "half-1",
          toolCallName: "remember",
          parentMessageId: id,
        }),
      );
      emit(
        event("TOOL_CALL_ARGS", {
          toolCallId: "half-1",
          delta: '{"fact": "가게는',
        }),
      );
      bot.messages.push({
        id,
        role: "assistant",
        toolCalls: [
          {
            id: "half-1",
            type: "function",
            function: { name: "remember", arguments: '{"fact": "가게는' },
          },
        ],
      } as Message);
      // And then nothing: no result, no RUN_ERROR, no RUN_FINISHED — the connection went.
      return { result: undefined, newMessages: [] };
    };
    const executed: string[] = [];
    const { engine } = engineWith(bot, async (name, _args) => {
      executed.push(name);
      return { ok: true };
    });
    const question = asked("춘천에서 한식당 해요. 기억해 둬.");
    const first = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [question],
      tools: null,
    });
    if (!first.ok) throw new Error("not sent");
    await until(async () => (await statusOf(first.turnId)) === "error");

    const filed = await messagesFor(database, threadId);
    const result = filed.find(
      (message) =>
        message.role === "tool" &&
        (message as { toolCallId?: string }).toolCallId === "half-1",
    );
    expect(JSON.parse(String(result?.content))).toMatchObject({
      ok: false,
      code: "laf:provider_stream_cut",
    });
    // Half an argument list was never carried out.
    expect(executed).toEqual([]);

    // 다시 시도, in place: the question again under the id the store already holds.
    const retry = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [question],
      tools: null,
    });
    if (!retry.ok) throw new Error("not sent");
    await until(async () => (await statusOf(retry.turnId)) === "done");
    const after = await messagesFor(database, threadId);
    expect(after.filter((message) => message.id === question.id)).toHaveLength(
      1,
    );
    expect(after.at(-1)).toMatchObject({ role: "assistant", content: answer });
    // Only the cut's answer is filed for the half call; nothing marks it merely unanswered.
    expect(
      after.filter(
        (message) =>
          message.role === "tool" &&
          (message as { toolCallId?: string }).toolCallId === "half-1",
      ),
    ).toHaveLength(1);
  });

  test("what broke is logged and the window and the ledger are handed a fact, never its words", async () => {
    // Review M4: a Drizzle failure's message is its statement and its parameters.
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    const { engine, hub } = engineWith(bot, async () => ({ ok: true }), {
      resolveAgents: async () => {
        throw new Error(
          'Failed query: select * from "agents" where "id" = $1 params: 사장님 비밀',
        );
      },
    });
    const errors: string[] = [];
    hub.subscribe(threadId, { epoch: null, after: null }, (frame) => {
      if (frame.kind === "event" && frame.event.type === "RUN_ERROR") {
        errors.push(String((frame.event as { message?: string }).message));
      }
    });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("안녕")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "error");
    const [row] = await database
      .select({ error: lafThreadRuns.error })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, sent.turnId));
    expect(row?.error).toBe("laf:turn_failed");
    expect(errors).toEqual(["laf:turn_failed"]);
  });

  test("a turn out of its whole time ends on the deadline's fact", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    const { engine } = engineWith(
      bot,
      () =>
        new Promise<{ ok: boolean }>((resolve) =>
          setTimeout(() => resolve({ ok: true }), 400),
        ),
      { timeoutMs: 100 },
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
    await until(async () => (await statusOf(sent.turnId)) === "error");
    const [row] = await database
      .select({ error: lafThreadRuns.error })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, sent.turnId));
    expect(row?.error).toBe("laf:run_timed_out");
  });

  test("each request of a turn is filed under the turn, and the roster sees it however long it runs", async () => {
    // Review M6 and M5.
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engine } = engineWith(bot, async () => {
      await held;
      return { ok: true };
    });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("길게 해줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => bot.runs === 1);
    expect(engine.working(OWNER)).toEqual([
      expect.objectContaining({ agentId: BOT, origin: "chat" }),
    ]);
    release();
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(bot.runIds).toEqual([sent.turnId, `${sent.turnId}.1`]);
    expect(engine.working(OWNER)).toEqual([]);
  });

  test("an account's deletion stops its turns and waits for them to end", async () => {
    // Review M2: a turn went on writing into a conversation being deleted.
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
      messages: [asked("끝없는 일")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => bot.runs === 1);
    await engine.stopFor(OWNER);
    // Written its end before `stopFor` came back: nothing of it runs after the deletion starts.
    expect(await statusOf(sent.turnId)).toBe("stopped");
    expect(engine.busy(threadId)).toBe(false);
  });
});

/**
 * A Bot that only answers: what the first move leaves its model to do. `inputs` is what each run
 * was handed, which is the whole point — the result has to be there before the model is asked.
 */
function answeringBot(answer: string) {
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
      const id = `a-${randomUUID()}`;
      emit(event("RUN_STARTED"));
      emit(event("TEXT_MESSAGE_START", { messageId: id, role: "assistant" }));
      emit(event("TEXT_MESSAGE_CONTENT", { messageId: id, delta: answer }));
      agent.messages.push({
        id,
        role: "assistant",
        content: answer,
      } as Message);
      emit(event("RUN_FINISHED"));
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [] };
    },
  };
  return agent as unknown as ReturnType<typeof scriptedBot>;
}

const WEATHER = "mcp__kma-weather__get_weather";
const aMove: FirstMove = {
  kind: "weather",
  tool: WEATHER,
  args: {},
  asked: ["weather"],
  decided: { forecast: 0.93, ownPlace: 0.88 },
};

describe("the turn's first move", () => {
  test("the call is made before the Bot's model is asked, and filed as a call the Bot made", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = answeringBot("춘천 기준 지금 7.8도예요.");
    const executed: Array<{ name: string; args: unknown; id: string }> = [];
    // A move for the first turn only: the second, below, is a thank-you.
    let decided = 0;
    const { engine, hub } = engineWith(
      bot,
      async (name, args, call) => {
        executed.push({ name, args, id: call.id });
        return '{"source":"기상청","now":{"temp":7.8}}';
      },
      { firstMove: async () => (decided++ === 0 ? aMove : null) },
    );
    const frames: TurnFrame[] = [];
    hub.subscribe(threadId, { epoch: null, after: null }, (frame) => {
      if (frame.kind !== "snapshot") frames.push(frame);
    });
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("오늘 날씨 어때?")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");

    // One call, with no argument, and the model asked once — with the result already in hand.
    expect(executed.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: WEATHER, args: {} },
    ]);
    expect(bot.runs).toBe(1);
    expect(bot.inputs[0]?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);

    // The thread reads as any turn that called a tool: asked, called, answered, said.
    const stored = await messagesFor(database, threadId);
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const [, asking, result] = stored;
    const call = asking?.role === "assistant" ? asking.toolCalls?.[0] : null;
    expect(call?.function).toEqual({ name: WEATHER, arguments: "{}" });
    expect(call?.id).toBe(executed[0]?.id);
    /*
     * As a call the Bot made in every way but one field of the message that carries it, which is
     * how the app tells a move the Bot asked again after from a place it was asked about
     * (`shared/first-move.ts`). The id is an ordinary one — "call_" and 32 hex digits, which the
     * fleet's providers take — and the mark is on that message and nowhere else.
     */
    expect(call?.id).toMatch(/^call_[0-9a-f]{32}$/);
    expect(asking?.lafFirstMove).toBe(true);
    expect(
      stored.filter((message) => isFirstMove(message)).map(({ id }) => id),
    ).toEqual([asking?.id]);
    expect((result as { toolCallId?: string }).toolCallId).toBe(call?.id);
    expect(result?.content).toBe('{"source":"기상청","now":{"temp":7.8}}');
    expect(asking?.lafAgentId).toBe(BOT);

    // A window reading the thread back is handed the mark with the message.
    const page = await historyPage(database, threadId);
    expect(
      page.messages
        .filter((message) => isFirstMove(message))
        .map(({ id }) => id),
    ).toEqual([asking?.id]);

    // And every window is told in that order: the call, marked, its result, then the first word.
    const told = frames.flatMap((frame) => {
      if (frame.kind === "messages") {
        return frame.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.toolCalls?.[0]?.id === call?.id,
        )
          ? [
              frame.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.toolCalls?.[0]?.id === call?.id &&
                  isFirstMove(message),
              )
                ? "call"
                : "unmarked call",
            ]
          : [];
      }
      if (frame.kind !== "event") return [];
      const type = String(frame.event.type);
      return type === "TOOL_CALL_RESULT" || type === "TEXT_MESSAGE_START"
        ? [type]
        : [];
    });
    expect(told.slice(0, 3)).toEqual([
      "call",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
    ]);
    // Every copy any window was sent, the step's and the end's as well as the first.
    expect(told).not.toContain("unmarked call");

    /*
     * THE NEXT TURN IS HANDED THE THREAD WITHOUT IT, as without the other stamps (`forTheBot`) —
     * and the thread still holds it after that turn has written itself.
     */
    const next = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("고마워")],
      tools: null,
    });
    if (!next.ok) throw new Error("not sent");
    await until(async () => (await statusOf(next.turnId)) === "done");
    expect(bot.inputs[1]?.some((message) => "lafFirstMove" in message)).toBe(
      false,
    );
    expect(
      (await messagesFor(database, threadId))
        .filter((message) => isFirstMove(message))
        .map(({ id }) => id),
    ).toEqual([asking?.id]);
  });

  test("no move is the turn it always was", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = answeringBot("안녕하세요.");
    const executed: string[] = [];
    const { engine } = engineWith(
      bot,
      async (name, _args) => {
        executed.push(name);
        return { ok: true };
      },
      { firstMove: async () => null },
    );
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("안녕")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(executed).toEqual([]);
    expect(
      (await messagesFor(database, threadId)).map((message) => message.role),
    ).toEqual(["user", "assistant"]);
  });

  test("a decision that throws makes no move, and the turn answers all the same", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = answeringBot("확인해 볼게요.");
    const executed: string[] = [];
    const { engine } = engineWith(
      bot,
      async (name, _args) => {
        executed.push(name);
        return { ok: true };
      },
      {
        firstMove: async () => {
          throw new Error("the decisions model is down");
        },
      },
    );
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("오늘 날씨 어때?")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(executed).toEqual([]);
    expect(bot.runs).toBe(1);
    expect(
      (await messagesFor(database, threadId)).map((message) => message.role),
    ).toEqual(["user", "assistant"]);
  });

  test("a refusal from the tool is filed as its answer, for the Bot to read", async () => {
    // Nobody's place known by the time the call runs: the Bot is told, and asks — as it does today.
    const { threadId, channelId } = await aConversation();
    const bot = answeringBot("어느 지역 날씨를 볼까요?");
    const { engine } = engineWith(
      bot,
      async () => ({ ok: false, code: "laf:weather_place_unknown" }),
      { firstMove: async () => aMove },
    );
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("오늘 날씨 어때?")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");
    const stored = await messagesFor(database, threadId);
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(String(stored[2]?.content)).toContain("laf:weather_place_unknown");
    expect(bot.inputs[0]?.at(-1)?.role).toBe("tool");
  });
});
