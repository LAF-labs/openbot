import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { isFirstMove } from "../../shared/first-move";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
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
import { appendMessages, messagesFor } from "../src/runner/thread-store";
import type { LoopAgent } from "../src/runner/turn-loop";
import type { ChatToolkit, ChatTurnContext } from "../src/turns/chat-tools";
import { createTurnEngine, repairUnanswered } from "../src/turns/engine";
import type { FirstMove, FirstMoveFor } from "../src/turns/first-move";
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
function scriptedBot(
  answer = "다 됐어요.",
  /** The one call its first reply makes. A second Bot in one turn needs an id of its own. */
  calls: { id: string; name: string; args: string } = {
    id: "call-1",
    name: "computer_navigate",
    args: '{"url":"https://example.com"}',
  },
) {
  const agent = {
    messages: [] as Message[],
    runs: 0,
    inputs: [] as Message[][],
    runIds: [] as Array<string | undefined>,
    /** What rode on each run beside the conversation and the tools. */
    forwarded: [] as unknown[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      input: { runId?: string; forwardedProps?: unknown } | undefined,
      subscriber?: Subscriber,
    ) {
      agent.inputs.push([...agent.messages]);
      agent.runIds.push(input?.runId);
      agent.forwarded.push(input?.forwardedProps);
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
            toolCallId: calls.id,
            toolCallName: calls.name,
            parentMessageId: id,
          }),
        );
        emit(
          event("TOOL_CALL_ARGS", {
            toolCallId: calls.id,
            delta: calls.args,
          }),
        );
        emit(event("TOOL_CALL_END", { toolCallId: calls.id }));
        agent.messages.push({
          id,
          role: "assistant",
          content: "찾아볼게요.",
          toolCalls: [
            {
              id: calls.id,
              type: "function",
              function: { name: calls.name, arguments: calls.args },
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
    /** The whole of what a turn is told of its first move, where a case reads the turn's measure. */
    decision?: () => ReturnType<FirstMoveFor>;
    /** Whether the person may still act here, asked once by `send` and once by the run. */
    admits?: () => Promise<boolean>;
    /** The clock the turn's measure is read off, moved by the case's own hand. */
    now?: () => number;
    /** The thread's store as the engine reaches it — a test's may refuse a write. */
    store?: typeof database;
    /** What the turn's listing counted and could not list (`ChatToolkit.withheld`). */
    withheld?: NonNullable<ChatToolkit["withheld"]>;
    /** Who is told the turn's run is over (`TurnEngineOptions.runEnded`). */
    runEnded?: (run: { botId: string; threadId: string }) => Promise<void>;
    /** What records the Bot's answer at the turn's end, where a case holds it open. */
    announce?: () => Promise<void>;
  } = {},
) {
  const hub = createTurnHub({ keepEndedMs: 50 });
  const announced: string[] = [];
  // A case that only cares which call is made hands over the move; the turn is told the rest.
  const made = options.firstMove;
  const firstMove =
    options.decision ??
    (made
      ? async (): ReturnType<FirstMoveFor> => {
          const move = await made();
          return move
            ? { move, verdict: "moved", asked: move.asked }
            : { move: null, verdict: "no_word", asked: [] };
        }
      : undefined);
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
      ...(options.withheld ? { withheld: options.withheld } : {}),
    }),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(firstMove ? { firstMove } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.admits ? { admits: options.admits } : {}),
    ...(options.runEnded ? { runEnded: options.runEnded } : {}),
    announce: async ({ text }) => {
      announced.push(text);
      await options.announce?.();
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

/**
 * A call that uses the browser, as `chat-tools.ts` carries one out: the browser is asked for
 * first, and a call that did not get it — the turn was stopped while it waited — never leaves.
 */
const browsing =
  (act: () => void = () => {}) =>
  (context: ChatTurnContext): ChatToolkit["execute"] =>
  async () => {
    if (!(await context.borrowBrowser?.())) {
      return { ok: false, code: "laf:stopped", stopped: true };
    }
    act();
    return { ok: true };
  };

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

  /*
   * WHAT THE BOT'S COMPUTER HELD FOR THE RUN IS LET GO OF AT ITS END (2026-10-10, record §6): a
   * value put into the browser for a person is hidden, and its tab kept, until the computer is
   * told the run is over. Told once the next turn had begun, it would close the tab that turn was
   * working in — so the turn is not over, for anybody, until it has been told.
   */
  test("its run is said to be over once, with its Bot and its conversation, before the conversation takes another turn", async () => {
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    const ends: { botId: string; threadId: string }[] = [];
    let release = () => {};
    const told = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engine } = engineWith(
      bot,
      async () => ({ ok: true, title: "Example" }),
      {
        runEnded: async (run) => {
          ends.push(run);
          await told;
        },
      },
    );
    const send = () =>
      engine.send({
        threadId,
        channelId,
        owner: { id: OWNER, role: "user" },
        botId: BOT,
        messages: [asked("예시 페이지 확인해줘")],
        tools: null,
      });
    const sent = await send();
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    await until(async () => ends.length === 1);
    expect(ends).toEqual([{ botId: BOT, threadId }]);
    // While the computer is being told, the turn is still going: nothing is started beside it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await send()).toEqual({ ok: false, code: "laf:turn_in_progress" });
    expect(await statusOf(sent.turnId)).not.toBe("done");
    release();
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(ends).toHaveLength(1);
  });

  test("a turn whose end could not be told still ends", async () => {
    const { threadId, channelId } = await aConversation();
    const { engine } = engineWith(
      scriptedBot(),
      async () => ({ ok: true, title: "Example" }),
      {
        runEnded: async () => {
          throw new Error("the computer did not answer");
        },
      },
    );
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("예시 페이지 확인해줘")],
      tools: null,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
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

  test("a turn waiting for the Bot's browser already has its record", async () => {
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
    const { engine } = engineWith(bot, browsing(), { lane });
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
    // The Bot was asked, and its call is what waits: nothing has been asked of it since.
    await until(async () => bot.runs === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bot.runs).toBe(1);
    expect(await statusOf(sent.turnId)).toBe("running");
    free();
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(bot.runs).toBe(2);
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

describe("a turn and the lane of the Bot's browser", () => {
  /** Every status a conversation's windows were told, in order. */
  const statusesOf = (
    hub: ReturnType<typeof engineWith>["hub"],
    id: string,
  ) => {
    const statuses: string[] = [];
    hub.subscribe(id, { epoch: null, after: null }, (frame) => {
      if (frame.kind === "turn") statuses.push(frame.turn.status);
    });
    return statuses;
  };

  test("a turn that never uses the browser runs while a routine has it", async () => {
    /*
     * Piece 5-4: the lane was the Bot's, so "안녕" waited for as long as a routine browsed. What
     * it keeps apart is two loops on one browser, and this turn's call is not one.
     */
    const { threadId, channelId } = await aConversation();
    const lane = createBotLane();
    const routine = await lane.acquire(BOT);
    const bot = scriptedBot();
    const { engine, hub } = engineWith(bot, async () => ({ ok: true }), {
      lane,
    });
    const statuses = statusesOf(hub, threadId);
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
    // Done with the routine still on the browser, and never said to be waiting for it.
    expect(lane.busy(BOT)).toBe(true);
    expect(bot.runs).toBe(2);
    expect(statuses).toEqual(["queued", "running", "done"]);
    // And it took nothing: the routine is the only holder there has been.
    expect(lane.grants(BOT)).toBe(1);
    routine.release();
  });

  test("the call that uses the browser is what waits for it, and the wait is said", async () => {
    const { threadId, channelId } = await aConversation();
    const lane = createBotLane();
    const routine = await lane.acquire(BOT);
    const bot = scriptedBot();
    const order: string[] = [];
    const { engine, hub } = engineWith(
      bot,
      browsing(() => order.push("turn: acted")),
      { lane },
    );
    const statuses = statusesOf(hub, threadId);
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("가격 좀 찾아줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    // The Bot's model was asked without waiting for anybody; its call is what stands in line.
    await until(async () => statuses.at(-1) === "queued" && bot.runs === 1);
    expect(statuses).toEqual(["queued", "running", "queued"]);
    expect(order).toEqual([]);
    order.push("routine: done");
    routine.release();
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(order).toEqual(["routine: done", "turn: acted"]);
    expect(statuses).toEqual([
      "queued",
      "running",
      "queued",
      "running",
      "done",
    ]);
    // Let go of at the turn's end: whoever is next has it at once.
    expect(await lane.run(BOT, async () => "next")).toBe("next");
  });

  test("a free browser is taken without a word about waiting", async () => {
    const { threadId, channelId } = await aConversation();
    const lane = createBotLane();
    const bot = scriptedBot();
    const { engine, hub } = engineWith(bot, browsing(), { lane });
    const statuses = statusesOf(hub, threadId);
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("가격 좀 찾아줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(statuses).toEqual(["queued", "running", "done"]);
    expect(lane.grants(BOT)).toBe(1);
  });

  test("the browser is kept to the turn's end: another conversation that browses waits, one that only talks does not", async () => {
    const lane = createBotLane();
    const first = await aConversation();
    const second = await aConversation();
    const third = await aConversation();
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const order: string[] = [];
    // Three conversations of one Bot's, one engine: who a call belongs to is read off its turn.
    const { engine } = engineWith(
      scriptedBot(),
      (context: ChatTurnContext) => async () => {
        if (context.threadId === second.threadId) {
          order.push("talking: answered");
          return { ok: true };
        }
        if (!(await context.borrowBrowser?.())) {
          return { ok: false, code: "laf:stopped", stopped: true };
        }
        if (context.threadId === first.threadId) {
          order.push("first: has the browser");
          await finished;
          order.push("first: done with it");
        } else {
          order.push("third: has the browser");
        }
        return { ok: true };
      },
      {
        lane,
        // Each turn its own Bot object: a scripted one counts its runs.
        resolveAgents: async () => ({
          [BOT]: scriptedBot() as unknown as LoopAgent,
        }),
      },
    );
    const send = async (
      conversation: { threadId: string; channelId: string },
      text: string,
    ) => {
      const sent = await engine.send({
        ...conversation,
        owner: { id: OWNER, role: "user" },
        botId: BOT,
        messages: [asked(text)],
        tools: null,
      });
      if (!sent.ok) throw new Error("not sent");
      return sent.turnId;
    };
    const browsingTurn = await send(first, "가격 좀 찾아줘");
    await until(async () => order.length === 1);
    const waitingTurn = await send(third, "이 사이트도 봐줘");
    const talkingTurn = await send(second, "안녕");
    await until(async () => (await statusOf(talkingTurn)) === "done");
    expect(order).toEqual(["first: has the browser", "talking: answered"]);
    expect(await statusOf(waitingTurn)).toBe("running");
    finish();
    await until(async () => (await statusOf(browsingTurn)) === "done");
    await until(async () => (await statusOf(waitingTurn)) === "done");
    expect(order).toEqual([
      "first: has the browser",
      "talking: answered",
      "first: done with it",
      "third: has the browser",
    ]);
  });

  test("a turn waiting on a person lets a routine have the browser, and takes it back before it acts", async () => {
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
        // A press on a page: the browser is this turn's before anybody is asked about it.
        await context.borrowBrowser?.();
        order.push("turn: asked the person");
        const waited = await context.awaitPerson?.(() => answered);
        seen.moved = waited?.moved ?? null;
        order.push("turn: acts again");
        return { ok: true };
      },
      { lane },
    );
    const statuses = statusesOf(hub, threadId);
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

  test("a turn that waited on a person without having used the browser takes nothing afterwards", async () => {
    /*
     * A question about a plugin's call. Taken "back" after the answer, the lane would be held to
     * the turn's end by a turn that never browsed — and waited for, behind the routine below.
     */
    const { threadId, channelId } = await aConversation();
    const lane = createBotLane();
    const bot = scriptedBot();
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const seen: { moved: boolean | null; asked: boolean } = {
      moved: null,
      asked: false,
    };
    const { engine, hub } = engineWith(
      bot,
      (context: ChatTurnContext) => async () => {
        seen.asked = true;
        const waited = await context.awaitPerson?.(() => answered);
        seen.moved = waited?.moved ?? null;
        return { ok: true };
      },
      { lane },
    );
    const statuses = statusesOf(hub, threadId);
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("메일 보내기 전에 물어봐줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => seen.asked);
    // A routine takes the browser while the person decides, and is still on it at the answer.
    const routine = await lane.acquire(BOT);
    answer();
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(lane.busy(BOT)).toBe(true);
    expect(statuses).toEqual(["queued", "running", "done"]);
    // Nothing of this turn's was on a page, so nothing can have moved under it.
    expect(seen.moved).toBe(false);
    expect(lane.grants(BOT)).toBe(1);
    routine.release();
  });

  test("a stop while a call waits for the browser does not wait for the browser", async () => {
    const { threadId, channelId } = await aConversation();
    const lane = createBotLane();
    const busy = await lane.acquire(BOT);
    const bot = scriptedBot();
    const order: string[] = [];
    const { engine, hub } = engineWith(
      bot,
      browsing(() => order.push("turn: acted")),
      { lane },
    );
    const statuses = statusesOf(hub, threadId);
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("루틴 끝나면 해줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => statuses.at(-1) === "queued" && bot.runs === 1);
    expect(engine.stop(threadId)).toBe(true);
    await until(async () => (await statusOf(sent.turnId)) === "stopped");
    // The call it was waiting to make never left, and is answered as stopped.
    expect(order).toEqual([]);
    const stored = await messagesFor(database, threadId);
    const result = stored.find((message) => message.role === "tool");
    expect(JSON.parse(String(result?.content))).toMatchObject({
      code: "laf:stopped",
      stopped: true,
    });
    expect(bot.runs).toBe(1);
    // And the lane it never got is not kept from whoever comes next.
    busy.release();
    expect(await lane.run(BOT, async () => "next")).toBe("next");
    expect(order).toEqual([]);
  });
});

/*
 * A RUN THE TURN HANDED ITS BROWSING TO (piece 6-2). The Bot of a conversation calls `delegate`,
 * and what browses is the same Bot in a conversation of its own. Two records come of it: the
 * thread's, for a person — with every step of the delegated run in it — and the Bot's, which holds
 * the call and the one answer it was handed back.
 */
describe("a run the turn delegated to", () => {
  const TASK = "네이버에서 오늘 서울 날씨를 찾아 기온을 알려 줘.";
  const HANDED_BACK = "서울은 지금 21도이고 맑아요.";
  /** The conversation's Bot: one `delegate` call, then its answer to the person. */
  const delegating = () =>
    scriptedBot("서울은 지금 21도래요.", {
      id: "call-delegate",
      name: "delegate",
      args: JSON.stringify({ to: "browser", task: TASK }),
    });
  /** The run it is handed to: one page opened, then what it hands back. */
  const browsing = () =>
    scriptedBot(HANDED_BACK, {
      id: "call-open",
      name: "computer_navigate",
      args: '{"url":"https://naver.com"}',
    });
  /**
   * A turn's tools as `chat-tools.ts` carries `delegate` out: the work goes to `context.delegate`
   * and its last words come back as the call's answer. Every other call is the delegated run's.
   */
  const handingOver =
    (act: () => Promise<void> | void = () => {}) =>
    (context: ChatTurnContext): ChatToolkit["execute"] =>
    async (name, args, call) => {
      if (name !== "delegate") {
        await act();
        return { ok: true, title: "네이버" };
      }
      const handed = await context.delegate?.({
        callId: call.id,
        mode: "browse",
        instruction: String(args.task),
        tools: [
          { name: "computer_navigate", description: "go", parameters: {} },
        ],
        execute: handingOver(act)(context),
        signal: call.signal,
      });
      return { ok: true, answer: handed?.answer ?? "" };
    };
  /** One engine whose first Bot is the conversation's and whose every later one is delegated to. */
  const engineHandingOver = (
    act?: () => Promise<void> | void,
    made: ReturnType<typeof scriptedBot>[] = [],
  ) => {
    const main = delegating();
    const built = engineWith(main, handingOver(act), {
      resolveAgents: async () => {
        const next = made.length === 0 ? main : browsing();
        made.push(next);
        return { [BOT]: next as unknown as LoopAgent };
      },
    });
    return { ...built, main, made };
  };
  const send = async (
    engine: ReturnType<typeof engineWith>["engine"],
    conversation: { threadId: string; channelId: string },
    text: string,
  ) => {
    const sent = await engine.send({
      ...conversation,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked(text)],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    return sent.turnId;
  };
  const delegatedBy = (message: Message) =>
    (message as { lafDelegated?: string }).lafDelegated;

  test("its steps are in the thread for a person, between the call and its answer — and its last words only in that answer", async () => {
    const conversation = await aConversation();
    const { engine } = engineHandingOver();
    const turnId = await send(engine, conversation, "서울 날씨 찾아줘");
    await until(async () => (await statusOf(turnId)) === "done");
    const stored = await messagesFor(database, conversation.threadId);
    const shape = stored.map((message) => [
      message.role,
      message.role === "assistant"
        ? (message.toolCalls?.[0]?.function.name ?? "says")
        : message.role === "tool"
          ? message.toolCallId
          : "asks",
      delegatedBy(message) ?? null,
    ]);
    expect(shape).toEqual([
      ["user", "asks", null],
      ["assistant", "delegate", null],
      ["assistant", "computer_navigate", "call-delegate"],
      ["tool", "call-open", "call-delegate"],
      ["tool", "call-delegate", null],
      ["assistant", "says", null],
    ]);
    // What it handed back is the call's answer, and no message of its own: said once, by the Bot.
    expect(
      JSON.parse(
        String(
          stored.find((m) => m.role === "tool" && !delegatedBy(m))?.content,
        ),
      ),
    ).toEqual({ ok: true, answer: HANDED_BACK });
    expect(
      stored.filter(
        (message) =>
          message.role === "assistant" && message.content === HANDED_BACK,
      ),
    ).toEqual([]);
    // Each step is stamped like any message of the turn's: when, and which Bot.
    const step = stored[2] as Message & { lafAt?: string; lafAgentId?: string };
    expect(step.lafAgentId).toBe(BOT);
    expect(typeof step.lafAt).toBe("string");
  });

  test("every window is sent the steps as they happen, in the turn's order", async () => {
    const conversation = await aConversation();
    const { engine, hub } = engineHandingOver();
    const seen: string[] = [];
    hub.subscribe(
      conversation.threadId,
      { epoch: null, after: null },
      (frame) => {
        if (frame.kind === "messages") {
          seen.push(
            `messages: ${frame.messages
              .map(
                (message) =>
                  (message.role === "assistant"
                    ? message.toolCalls?.[0]?.function.name
                    : undefined) ?? message.role,
              )
              .join(", ")}`,
          );
        }
        if (frame.kind === "event" && frame.event.type === "TOOL_CALL_RESULT") {
          seen.push(`result: ${String(frame.event.toolCallId)}`);
        }
      },
    );
    const turnId = await send(engine, conversation, "서울 날씨 찾아줘");
    await until(async () => (await statusOf(turnId)) === "done");
    // The delegated step is drawn before its page comes back, and that before the call's answer.
    const order = [
      "messages: delegate, computer_navigate",
      "result: call-open",
      "result: call-delegate",
    ].map((line) => seen.indexOf(line));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // And the turn's last frame is the whole of it, woven: the step between call and answer.
    expect(seen.at(-1)).toBe(
      "messages: user, delegate, computer_navigate, tool, tool, assistant",
    );
  });

  test("the delegated run has a conversation of its own: the task alone, under the turn's id", async () => {
    const conversation = await aConversation();
    const { engine, made } = engineHandingOver();
    const turnId = await send(engine, conversation, "서울 날씨 찾아줘");
    await until(async () => (await statusOf(turnId)) === "done");
    const worker = made[1];
    if (!worker) throw new Error("nothing was delegated to");
    // Nothing of the person's thread: the instruction, and then its own steps.
    expect(worker.inputs[0]?.map((message) => message.content)).toEqual([TASK]);
    expect(worker.forwarded).toEqual([{ mode: "browse" }, { mode: "browse" }]);
    // Filed under the turn like every run of it, and apart from the turn's own `.1`.
    expect(worker.runIds).toEqual([`${turnId}.d1.0`, `${turnId}.d1.1`]);
    expect(made[0]?.runIds).toEqual([turnId, `${turnId}.1`]);
    const threadOf = (bot: unknown) => (bot as { threadId?: string }).threadId;
    expect(threadOf(made[0])).toBe(conversation.threadId);
    expect(threadOf(worker)).not.toBe(conversation.threadId);
    expect(typeof threadOf(worker)).toBe("string");
  });

  test("the Bot that delegated is never handed the steps: not in the turn, not on the next one", async () => {
    const conversation = await aConversation();
    const { engine, main, made } = engineHandingOver();
    const first = await send(engine, conversation, "서울 날씨 찾아줘");
    await until(async () => (await statusOf(first)) === "done");
    // Within the turn: its second request holds the call and its answer, and nothing between.
    expect(
      main.inputs[1]?.map(
        (message) =>
          (message.role === "assistant"
            ? message.toolCalls?.[0]?.function.name
            : undefined) ?? message.role,
      ),
    ).toEqual(["user", "delegate", "tool"]);
    // The turn after it: a Bot resolved afresh is handed the thread without them.
    made.length = 0;
    const again = scriptedBot("그럼요.");
    const next = engineWith(again, async () => ({ ok: true }));
    const second = await send(next.engine, conversation, "고마워");
    await until(async () => (await statusOf(second)) === "done");
    const handed = again.inputs[0] ?? [];
    expect(handed.some((message) => delegatedBy(message) !== undefined)).toBe(
      false,
    );
    expect(JSON.stringify(handed)).not.toContain("computer_navigate");
    expect(JSON.stringify(handed)).not.toContain("call-open");
    // And what it was handed back is still there to read.
    expect(JSON.stringify(handed)).toContain(HANDED_BACK);
    // While the thread still holds them, for the person who scrolls up.
    expect(
      (await messagesFor(database, conversation.threadId)).filter(
        (message) => delegatedBy(message) === "call-delegate",
      ),
    ).toHaveLength(2);
  });

  test("what it called is counted on the turn's own row", async () => {
    const conversation = await aConversation();
    const { engine } = engineHandingOver();
    const turnId = await send(engine, conversation, "서울 날씨 찾아줘");
    await until(async () => (await statusOf(turnId)) === "done");
    const [row] = await database
      .select({ toolCalls: lafThreadRuns.toolCalls })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, turnId));
    // The Bot's `delegate` and the page the delegated run opened.
    expect(row?.toolCalls).toBe(2);
  });

  test("a stop while it works ends the turn, and no step is left looking as though it were still going", async () => {
    const conversation = await aConversation();
    let reached: () => void = () => {};
    const working = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const main = delegating();
    const made: ReturnType<typeof scriptedBot>[] = [];
    const { engine } = engineWith(
      main,
      (context: ChatTurnContext): ChatToolkit["execute"] =>
        async (name, args, call) => {
          if (name === "delegate") {
            const handed = await context.delegate?.({
              callId: call.id,
              mode: "browse",
              instruction: String(args.task),
              tools: [],
              // The page that never comes back: cut by the stop, as a call to the computer is.
              execute: (_name, _args, step) =>
                new Promise((resolve) => {
                  reached();
                  step.signal.addEventListener("abort", () =>
                    resolve({ ok: false, code: "laf:stopped", stopped: true }),
                  );
                }),
              signal: call.signal,
            });
            return { ok: true, answer: handed?.answer ?? "" };
          }
          return { ok: true };
        },
      {
        resolveAgents: async () => {
          const next = made.length === 0 ? main : browsing();
          made.push(next);
          return { [BOT]: next as unknown as LoopAgent };
        },
      },
    );
    const turnId = await send(engine, conversation, "서울 날씨 찾아줘");
    await working;
    expect(engine.stop(conversation.threadId)).toBe(true);
    await until(async () => (await statusOf(turnId)) === "stopped");
    const stored = await messagesFor(database, conversation.threadId);
    const answers = stored
      .filter((message) => message.role === "tool")
      .map((message) => [
        (message as { toolCallId: string }).toolCallId,
        delegatedBy(message) ?? null,
        JSON.parse(String(message.content)).code,
      ]);
    expect(answers).toEqual([
      ["call-open", "call-delegate", "laf:stopped"],
      ["call-delegate", null, "laf:stopped"],
    ]);
    // Neither Bot was asked anything after the stop.
    expect(main.runs).toBe(1);
    expect(made[1]?.runs).toBe(1);
    expect(engine.busy(conversation.threadId)).toBe(false);
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

  test("a question a turn's call raises is counted on that turn's own row, by the run the call was handed", async () => {
    /*
     * Piece 5-1. The chain has three links and each has its own test — the call names the turn's
     * run (`chat-tools.test.ts`), the gateway writes the run on the question's row
     * (`approval-routes.test.ts`), the ledger counts by it (`run-ledger.integration.test.ts`) —
     * and this is the one place they are the same id: what the engine hands a call as its run is
     * the row it later settles.
     */
    const { threadId, channelId } = await aConversation();
    const bot = scriptedBot();
    const handed: string[] = [];
    const { engine } = engineWith(
      bot,
      (context: ChatTurnContext) => async () => {
        handed.push(context.runId);
        // As the gateway files it (`gateway/trail.ts`), under the run the call was carried out as.
        await database.insert(auditEvents).values({
          eventType: "approval.requested",
          targetType: "computer",
          targetId: BOT,
          payload: {
            bot: BOT,
            approval: `engine-${randomUUID()}`,
            run: context.runId,
          },
        });
        return { ok: true };
      },
    );
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("눌러 줘")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");

    expect(handed).toEqual([sent.turnId]);
    const [row] = await database
      .select({ asked: lafThreadRuns.approvalsAsked })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, sent.turnId));
    expect(row?.asked).toBe(1);
  });

  /*
   * WHAT THE LISTING COUNTED AND COULD NOT LIST RIDES ON THE RUN (the review of #116). A tool that
   * waits for review under no name is in no tool list, and a lookup is answered by the Bot's
   * service from the list alone — so the count goes beside the list, as a forwarded prop, on every
   * request of the turn. A turn with nothing waiting forwards what it always did.
   */
  test("what a turn's listing counted as waiting for review is forwarded on every request, beside the device — and nothing where nothing waits", async () => {
    const send = async (
      withheld: NonNullable<ChatToolkit["withheld"]> | undefined,
      device: unknown,
    ) => {
      const { threadId, channelId } = await aConversation();
      const bot = scriptedBot();
      const { engine } = engineWith(bot, async () => ({ ok: true }), {
        ...(withheld ? { withheld } : {}),
      });
      const sent = await engine.send({
        threadId,
        channelId,
        owner: { id: OWNER, role: "user" },
        botId: BOT,
        messages: [asked("카카오로 길 찾아줘")],
        tools: null,
        ...(device === undefined ? {} : { device }),
      });
      if (!sent.ok) throw new Error("not sent");
      await until(async () => (await statusOf(sent.turnId)) === "done");
      return bot.forwarded;
    };
    const waiting = [{ server: "kakao-playmcp", count: 2 }];
    const device = { timeZone: "Asia/Seoul" };
    // Two requests of the model in the turn, and both carry it.
    expect(await send(waiting, device)).toEqual([
      { device, toolsWithheld: waiting },
      { device, toolsWithheld: waiting },
    ]);
    expect(await send(waiting, undefined)).toEqual([
      { toolsWithheld: waiting },
      { toolsWithheld: waiting },
    ]);
    // Nothing counted: the same props as before there was anything to count.
    expect(await send(undefined, device)).toEqual([{ device }, { device }]);
    expect(await send([], undefined)).toEqual([{}, {}]);
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

  test("a project's deletion stops that conversation's turn and waits for it to end — and no other's", async () => {
    // Record §3, piece 4-5: the rows are removed only once the turn has written its last.
    const one = await aConversation();
    const other = await aConversation();
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
    const send = (conversation: { threadId: string; channelId: string }) =>
      engine.send({
        ...conversation,
        owner: { id: OWNER, role: "user" },
        botId: BOT,
        messages: [asked("끝없는 일")],
        tools: null,
      });
    const first = await send(one);
    if (!first.ok) throw new Error("not sent");
    await until(async () => bot.runs === 1);
    await engine.stopThread(one.threadId);
    expect(await statusOf(first.turnId)).toBe("stopped");
    expect(engine.busy(one.threadId)).toBe(false);

    // A conversation with nothing going is stopped already; asking is not an error.
    await engine.stopThread(other.threadId);
    await engine.stopThread("no-such-thread");
  });

  test("a turn that has freed the conversation and is still writing its end is waited for", async () => {
    /*
     * The conversation is free for the next message before the turn has settled its row and
     * recorded what the Bot said. A deletion that asked in that moment found no turn, removed the
     * thread, and those rows landed after it (review, 2026-10-10).
     */
    const one = await aConversation();
    const bot = scriptedBot();
    let record: () => void = () => {};
    const recording = new Promise<void>((resolve) => {
      record = resolve;
    });
    let reached: () => void = () => {};
    const atItsEnd = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { engine } = engineWith(bot, async () => ({ ok: true }), {
      announce: async () => {
        reached();
        await recording;
      },
    });
    const sent = await engine.send({
      ...one,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("짧은 일")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await atItsEnd;
    // Free for the next message, and not over.
    expect(engine.busy(one.threadId)).toBe(false);
    let stopped = false;
    const stopping = engine.stopThread(one.threadId).then(() => {
      stopped = true;
    });
    const forOwner = engine.stopFor(OWNER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    record();
    await stopping;
    await forOwner;
    expect(await statusOf(sent.turnId)).toBe("done");
  });
});

/**
 * What a provider refuses (OpenAI's chat completions, and every endpoint that keeps its rule): a
 * call answered anywhere but in the run of results right after the message that made it, and a
 * result that is not in that run. Each breach, said by the call's id, so a failure says which.
 */
function unpaired(messages: readonly Message[]): string[] {
  const breaches: string[] = [];
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      const answered = new Set<string>();
      for (let at = index + 1; messages[at]?.role === "tool"; at += 1) {
        answered.add((messages[at] as { toolCallId: string }).toolCallId);
      }
      for (const call of message.toolCalls ?? []) {
        if (!answered.has(call.id)) breaches.push(`call ${call.id}`);
      }
    }
    if (message.role === "tool") {
      const id = (message as { toolCallId: string }).toolCallId;
      let at = index - 1;
      while (messages[at]?.role === "tool") at -= 1;
      const maker = messages[at];
      if (
        maker?.role !== "assistant" ||
        !(maker.toolCalls ?? []).some((call) => call.id === id)
      ) {
        breaches.push(`result ${id}`);
      }
    }
  });
  return breaches;
}

describe("a call a turn left without an answer", () => {
  test("is answered where it was made, on the turn after it and on every turn after that", async () => {
    /*
     * WHAT AN UPGRADE LEAVES. The server is stopped mid-step: `flush` writes the step's call, and no
     * answer is ever written for it. The next turn — 이어서 하기 — answers it, and that turn was
     * always handed the conversation in order. The answer was FILED after the person's new
     * message, though, so every turn after it read the call, then the person, then the answer: a
     * conversation the provider refuses with a 400 on every request — "봇이 모델에 닿지 못했어요",
     * and 다시 시도 the same again (measured here before the fix: the third turn handed
     * `call call-gone`, `result call-gone`).
     */
    const { threadId, channelId } = await aConversation();
    const calling = {
      id: `a-${randomUUID()}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-gone",
          type: "function",
          function: { name: "computer_click", arguments: '{"ref":"e12"}' },
        },
      ],
    } as Message;
    await appendMessages(database, threadId, [asked("엔비디아 봐봐"), calling]);
    const bot = scriptedBot();
    const { engine } = engineWith(bot, async () => ({ ok: true }));
    const say = async (text: string) => {
      const sent = await engine.send({
        threadId,
        channelId,
        owner: { id: OWNER, role: "user" },
        botId: BOT,
        messages: [asked(text)],
        tools: null,
      });
      if (!sent.ok) throw new Error("not sent");
      await until(async () => (await statusOf(sent.turnId)) === "done");
    };

    await say("하던 일 이어서 해 주세요.");
    await say("고마워요");

    // Two runs for the turn that carried on, and one for the turn after it.
    expect(bot.inputs).toHaveLength(3);
    for (const handed of bot.inputs) expect(unpaired(handed)).toEqual([]);
  });

  test("a thread already in order is handed back as the very messages it was", () => {
    const thread = [
      { id: "q", role: "user", content: "날씨 봐줘" },
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "now", arguments: "{}" },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "computer_read", arguments: "{}" },
          },
        ],
      },
      // Filed in the order they came back, which a provider has cached: not call order.
      { id: "r2", role: "tool", toolCallId: "c2", content: "page" },
      { id: "r1", role: "tool", toolCallId: "c1", content: "9:00" },
      { id: "b", role: "assistant", content: "맑아요." },
      { id: "q2", role: "user", content: "지금 몇 시야?" },
      // An endpoint that numbers its calls gives the next turn's call the same id: it is that
      // turn's own, and its answer stays with it.
      {
        id: "a2",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "now", arguments: "{}" },
          },
        ],
      },
      { id: "r1-again", role: "tool", toolCallId: "c1", content: "9:05" },
      { id: "b2", role: "assistant", content: "9시 5분이에요." },
    ] as Message[];
    const repaired = repairUnanswered(thread);
    expect(repaired).toHaveLength(thread.length);
    for (const [index, message] of thread.entries()) {
      expect(repaired[index]).toBe(message);
    }
  });

  test("a result filed after the person spoke again goes back behind its call, after the results already there", () => {
    const thread = [
      { id: "q", role: "user", content: "엔비디아 봐봐" },
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "computer_read", arguments: "{}" },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "computer_click", arguments: '{"ref":"e3"}' },
          },
          {
            id: "c3",
            type: "function",
            function: { name: "computer_click", arguments: '{"ref":"e4"}' },
          },
        ],
      },
      { id: "r1", role: "tool", toolCallId: "c1", content: "page" },
      { id: "u", role: "user", content: "하던 일 이어서 해 주세요." },
      { id: "r2", role: "tool", toolCallId: "c2", content: "unanswered" },
      { id: "b", role: "assistant", content: "이어서 볼게요." },
    ] as Message[];
    const repaired = repairUnanswered(thread);
    expect(unpaired(repaired)).toEqual([]);
    expect(repaired.map((message) => message.id).slice(0, 5)).toEqual([
      "q",
      "a",
      "r1",
      "r2",
      // c3 never got an answer anywhere: one is made for it, last in the run.
      repaired[4]?.id,
    ]);
    expect(repaired[4]).toMatchObject({ role: "tool", toolCallId: "c3" });
    expect(repaired.slice(5).map((message) => message.id)).toEqual(["u", "b"]);
    // Moved, not copied: the answer is in the conversation once.
    expect(repaired.filter((message) => message.id === "r2")).toHaveLength(1);
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

/** A clock a case moves by hand: the turn's measure is read off it, so each part took what the case says. */
function handClock(start = 7_000_000) {
  let at = start;
  return {
    now: () => at,
    pass: (ms: number) => {
      at += ms;
    },
  };
}

/** One run of the model as a case tells it: how long the Bot's service took to start, then what it did. */
type TimedRun = {
  queued?: number;
  does?: (say: {
    /** Some of the answer, as one delta. */
    text: (words: string) => void;
    /** A call, announced the way the service streams one. */
    call: (name: string, id: string) => void;
  }) => void;
};

/** A Bot that does what each run is told to, on the case's own clock. */
function timedBot(time: ReturnType<typeof handClock>, runs: TimedRun[]) {
  const agent = {
    messages: [] as Message[],
    runs: 0,
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(_input: unknown, subscriber?: Subscriber) {
      const run = runs[agent.runs] ?? {};
      agent.runs += 1;
      const emit = (e: BaseEvent) => subscriber?.onEvent?.({ event: e });
      time.pass(run.queued ?? 0);
      emit(event("RUN_STARTED"));
      const id = `a-${randomUUID()}`;
      let content = "";
      let opened = false;
      const toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];
      run.does?.({
        text(words) {
          if (!opened) {
            emit(
              event("TEXT_MESSAGE_START", { messageId: id, role: "assistant" }),
            );
            opened = true;
          }
          emit(event("TEXT_MESSAGE_CONTENT", { messageId: id, delta: words }));
          content += words;
        },
        call(name, toolCallId) {
          emit(
            event("TOOL_CALL_START", {
              toolCallId,
              toolCallName: name,
              parentMessageId: id,
            }),
          );
          emit(event("TOOL_CALL_ARGS", { toolCallId, delta: "{}" }));
          emit(event("TOOL_CALL_END", { toolCallId }));
          toolCalls.push({
            id: toolCallId,
            type: "function",
            function: { name, arguments: "{}" },
          });
        },
      });
      if (content || toolCalls.length > 0) {
        agent.messages.push({
          id,
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        } as Message);
      }
      emit(event("RUN_FINISHED"));
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [] };
    },
  };
  return agent as unknown as ReturnType<typeof scriptedBot> & {
    runs: number;
  };
}

/**
 * THE WAIT AS THE PERSON HAS IT, on the turn's own row (`telemetry/run-meter.ts`).
 *
 * The measure used to start in the middle of a turn and stop at the model's first output, a tool
 * call included, so nothing said how long somebody waited for the first word, and a first move's
 * time sat inside "queued" with no name. Each case here moves the clock itself — the Bot's service
 * starting, the model thinking, a tool out, the decisions model answering — and reads what the
 * ledger wrote when the turn ended.
 */
describe("the wait a turn measured", () => {
  const MAIL = "mcp__gmail__search_messages";

  const sentTurn = async (
    engine: ReturnType<typeof engineWith>["engine"],
    text: string,
  ) => {
    const { threadId, channelId } = await aConversation();
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked(text)],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    return { threadId, turnId: sent.turnId };
  };

  const rowOf = async (runId: string) => {
    const [row] = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));
    if (!row) throw new Error(`run ${runId} has no row`);
    return row;
  };

  /** The five columns of a first move, as a turn nobody was asked about leaves them. */
  const NO_FIRST_MOVE = {
    firstMoveAsked: null,
    firstMoveVerdict: null,
    firstMoveKind: null,
    firstMoveDecisionMs: null,
    firstMoveCallMs: null,
  };

  test("words only: the first word is the first sign, counted from the message and not from the Bot's start", async () => {
    const time = handClock();
    const bot = timedBot(time, [
      {
        queued: 200,
        does: ({ text }) => {
          time.pass(1_500);
          // A blank line is the model's first output, and nothing for anybody to read yet.
          text("\n");
          time.pass(40);
          text("안녕하세요.");
          time.pass(300);
        },
      },
    ]);
    const { engine } = engineWith(bot, async () => ({ ok: true }), {
      now: time.now,
    });
    const { turnId } = await sentTurn(engine, "안녕");
    await until(async () => (await statusOf(turnId)) === "done");
    expect(await rowOf(turnId)).toMatchObject({
      queuedMs: 200,
      // What it always meant: the Bot's start → the model's first output, the blank line included.
      firstTokenMs: 1_500,
      firstSignMs: 1_740,
      firstWordMs: 1_740,
      streamMs: 340,
      totalMs: 2_040,
      toolCalls: 0,
      ...NO_FIRST_MOVE,
    });
  });

  test("what the engine does with a message before its run starts is in the two new waits, and in none of the numbers that were there before", async () => {
    /*
     * TWO ORIGINS (`telemetry/run-meter.ts`). The wait to the first sign and to the first word
     * starts when the engine is handed the message. `queuedMs` and `totalMs` — and the fleet's
     * first answer, which is `queuedMs + firstTokenMs` — start where they did before those two
     * existed, when the run begins: a series compared from one release to the next must not move
     * because a column was added beside it.
     *
     * Seventy milliseconds pass here INSIDE `send`, while the person's admission is asked about
     * and before the run is started. Start the new waits at the run and they lose the seventy;
     * start the old numbers at the message and they gain it. Either fails this.
     */
    const time = handClock();
    const bot = timedBot(time, [
      {
        queued: 100,
        does: ({ text }) => {
          time.pass(400);
          text("안녕하세요.");
        },
      },
    ]);
    let asks = 0;
    const { engine } = engineWith(bot, async () => ({ ok: true }), {
      now: time.now,
      admits: async () => {
        // `send` asks first, before the turn exists; the run asks again, and that takes no time.
        asks += 1;
        if (asks === 1) time.pass(70);
        return true;
      },
    });
    const { turnId } = await sentTurn(engine, "안녕");
    await until(async () => (await statusOf(turnId)) === "done");
    expect(asks).toBe(2);
    expect(await rowOf(turnId)).toMatchObject({
      firstSignMs: 570,
      firstWordMs: 570,
      queuedMs: 100,
      firstTokenMs: 400,
      totalMs: 500,
    });
  });

  test("a call first and words after: the step is drawn long before the first word is", async () => {
    const time = handClock();
    const bot = timedBot(time, [
      {
        queued: 100,
        does: ({ call }) => {
          time.pass(900);
          call("computer_navigate", "call-wait-1");
        },
      },
      {
        queued: 150,
        does: ({ text }) => {
          time.pass(250);
          text("찾았어요.");
        },
      },
    ]);
    const { engine } = engineWith(
      bot,
      async () => {
        time.pass(2_000);
        return { ok: true };
      },
      { now: time.now },
    );
    const { turnId } = await sentTurn(engine, "예시 페이지 확인해줘");
    await until(async () => (await statusOf(turnId)) === "done");
    const row = await rowOf(turnId);
    expect(row).toMatchObject({
      queuedMs: 100,
      firstTokenMs: 900,
      // The step is drawn the moment the model asks for it, long before anything is said.
      firstSignMs: 1_000,
      // The call out for two seconds, the Bot's service starting again, and then the answer.
      firstWordMs: 3_400,
      toolCalls: 1,
      ...NO_FIRST_MOVE,
    });
    expect(row.firstSignMs).toBeLessThan(row.firstWordMs ?? 0);
  });

  test("opened by a first move: its step is the first sign, and what deciding and the call cost has a name", async () => {
    const time = handClock();
    const bot = timedBot(time, [
      {
        queued: 80,
        does: ({ text }) => {
          time.pass(2_000);
          text("새 메일이 두 통 있어요.");
        },
      },
    ]);
    const executed: string[] = [];
    const { engine, hub } = engineWith(
      bot,
      async (name, _args) => {
        executed.push(name);
        time.pass(1_100);
        return '{"messages":2}';
      },
      {
        now: time.now,
        // The turn's own setup, before anything is decided.
        resolveAgents: async () => {
          time.pass(60);
          return { [BOT]: bot as unknown as LoopAgent };
        },
        decision: async () => {
          time.pass(240);
          return {
            move: {
              kind: "mail",
              tool: MAIL,
              args: { query: "is:unread in:inbox" },
              asked: ["calendar", "mail"],
              decided: {
                schedule: 0.2,
                today: 0.9,
                mail: 0.97,
                unfiltered: 0.9,
              },
            },
            verdict: "moved",
            asked: ["calendar", "mail"],
          };
        },
      },
    );
    /** The clock when the move's step went out to a window, and when the first word did. */
    const drawn: Record<string, number> = {};
    const { threadId, channelId } = await aConversation();
    hub.subscribe(threadId, { epoch: null, after: null }, (frame) => {
      if (
        frame.kind === "messages" &&
        frame.messages.some((message) => isFirstMove(message))
      ) {
        drawn.step ??= time.now();
      }
      if (
        frame.kind === "event" &&
        String(frame.event.type) === "TEXT_MESSAGE_CONTENT"
      ) {
        drawn.word ??= time.now();
      }
    });
    const startedAt = time.now();
    const sent = await engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("새 메일 왔어?")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "done");
    expect(executed).toEqual([MAIL]);
    const row = await rowOf(sent.turnId);
    expect(row).toMatchObject({
      firstMoveAsked: ["calendar", "mail"],
      firstMoveVerdict: "moved",
      firstMoveKind: "mail",
      firstMoveDecisionMs: 240,
      firstMoveCallMs: 1_100,
      // Setup and the decision, and the step is out: before the call has come back.
      firstSignMs: 300,
      // The call, the Bot's service starting, the model writing: everything the person sat through.
      firstWordMs: 3_480,
      // The Bot's service started after the move, so the move's time is still inside "queued"…
      queuedMs: 1_480,
      // …and the model's own first output is counted from its own start, as it always was.
      firstTokenMs: 2_000,
      // The server's call, not the model's.
      toolCalls: 0,
    });
    // And they are when a window was handed each, not when something else happened.
    expect(drawn.step).toBe(startedAt + 300);
    expect(drawn.word).toBe(startedAt + 3_480);
  });

  test("a move's call has a time whatever came back, and none only when it never left", async () => {
    /*
     * The trail's `turn.first_move` row is written when the decision is made, before the turn has
     * made the call or looked at a stop. So the turn's own row says `moved` in both cases here, as
     * the trail does, and the call's time says the rest: there whatever came back — a throw as
     * much as an answer — and null only when the person stopped the turn while the decision was
     * out, and the call never left.
     */
    const time = handClock();
    const moved = async (): ReturnType<FirstMoveFor> => {
      time.pass(100);
      return {
        move: {
          kind: "mail",
          tool: MAIL,
          args: { query: "is:unread in:inbox" },
          asked: ["mail"],
          decided: { mail: 0.95, unfiltered: 0.9 },
        },
        verdict: "moved",
        asked: ["mail"],
      };
    };
    const fell = engineWith(
      timedBot(time, []),
      async () => {
        time.pass(900);
        throw new Error("the service fell over");
      },
      { now: time.now, decision: moved },
    );
    const failed = await sentTurn(fell.engine, "새 메일 왔어?");
    await until(async () => (await statusOf(failed.turnId)) === "error");
    expect(await rowOf(failed.turnId)).toMatchObject({
      firstMoveVerdict: "moved",
      firstMoveKind: "mail",
      firstMoveDecisionMs: 100,
      firstMoveCallMs: 900,
      // The step was on the window before the call fell over.
      firstSignMs: 100,
    });

    const { threadId, channelId } = await aConversation();
    let stop: () => boolean = () => false;
    const stopped = engineWith(timedBot(time, []), async () => ({ ok: true }), {
      now: time.now,
      decision: async () => {
        // The person presses stop while the decisions model is still out.
        stop();
        return moved();
      },
    });
    stop = () => stopped.engine.stop(threadId);
    const sent = await stopped.engine.send({
      threadId,
      channelId,
      owner: { id: OWNER, role: "user" },
      botId: BOT,
      messages: [asked("새 메일 왔어?")],
      tools: null,
    });
    if (!sent.ok) throw new Error("not sent");
    await until(async () => (await statusOf(sent.turnId)) === "stopped");
    expect(await rowOf(sent.turnId)).toMatchObject({
      firstMoveVerdict: "moved",
      firstMoveKind: "mail",
      firstMoveDecisionMs: 100,
      firstMoveCallMs: null,
      // Nothing was drawn: the step never went out.
      firstSignMs: null,
    });
  });

  test("a decision that left the step to the Bot is on the row too, and a message nobody was asked about is not", async () => {
    const time = handClock();
    const answers = (words: string): TimedRun => ({
      queued: 50,
      does: ({ text }) => {
        time.pass(1_000);
        text(words);
      },
    });
    const bot = timedBot(time, [
      answers("우산은 없어도 돼요."),
      answers("네."),
    ]);
    let turns = 0;
    const { engine } = engineWith(bot, async () => ({ ok: true }), {
      now: time.now,
      decision: async () => {
        turns += 1;
        // The decisions model answered, short of the bar; then a message with no word of any kind.
        if (turns === 1) {
          time.pass(180);
          return { move: null, verdict: "below_bar", asked: ["weather"] };
        }
        time.pass(3);
        return { move: null, verdict: "no_word", asked: [] };
      },
    });
    const left = await sentTurn(engine, "우산 챙길까 말까 고민이네");
    await until(async () => (await statusOf(left.turnId)) === "done");
    expect(await rowOf(left.turnId)).toMatchObject({
      firstMoveAsked: ["weather"],
      firstMoveVerdict: "below_bar",
      firstMoveKind: null,
      firstMoveDecisionMs: 180,
      firstMoveCallMs: null,
      firstSignMs: 1_230,
      firstWordMs: 1_230,
    });
    const unasked = await sentTurn(engine, "고마워");
    await until(async () => (await statusOf(unasked.turnId)) === "done");
    expect(await rowOf(unasked.turnId)).toMatchObject({
      ...NO_FIRST_MOVE,
      firstWordMs: 1_053,
    });
  });

  test("a turn that did something and said nothing has a first sign and no first word", async () => {
    const time = handClock();
    const bot = timedBot(time, [
      {
        queued: 100,
        does: ({ call }) => {
          time.pass(500);
          call("computer_navigate", "call-wait-2");
        },
      },
      // Asked again with the result in hand, and it has nothing to add.
      { queued: 100 },
    ]);
    const { engine } = engineWith(
      bot,
      async () => {
        time.pass(300);
        return { ok: true };
      },
      { now: time.now },
    );
    const { turnId } = await sentTurn(engine, "예시 페이지 열어둬");
    await until(async () => (await statusOf(turnId)) === "done");
    expect(await rowOf(turnId)).toMatchObject({
      status: "done",
      firstSignMs: 600,
      firstWordMs: null,
      totalMs: 1_000,
    });
  });

  test("a turn the person stopped keeps what it measured up to the stop", async () => {
    const time = handClock();
    const bot = timedBot(time, [
      {
        queued: 100,
        does: ({ call }) => {
          time.pass(400);
          call("computer_navigate", "call-wait-3");
        },
      },
    ]);
    const { engine } = engineWith(
      bot,
      (_name, _args, call) =>
        new Promise((resolve) => {
          call.signal.addEventListener("abort", () =>
            resolve({ ok: false, code: "laf:stopped", stopped: true }),
          );
        }),
      { now: time.now },
    );
    const { threadId, turnId } = await sentTurn(engine, "오래 걸리는 일");
    await until(async () => bot.runs === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Five seconds of watching a step that does not come back, and then the person stops it.
    time.pass(5_000);
    expect(engine.stop(threadId)).toBe(true);
    await until(async () => (await statusOf(turnId)) === "stopped");
    expect(await rowOf(turnId)).toMatchObject({
      status: "stopped",
      ending: "stopped",
      firstSignMs: 500,
      firstWordMs: null,
      totalMs: 5_500,
      toolCalls: 1,
    });
  });

  test("nothing the row measured holds a word of what the person said", async () => {
    const time = handClock();
    const bot = timedBot(time, [
      {
        queued: 70,
        does: ({ text }) => {
          time.pass(900);
          text("김영희 과장님 메일이 한 통 와 있어요.");
        },
      },
    ]);
    const { engine } = engineWith(
      bot,
      async () => {
        time.pass(800);
        return '{"from":"김영희 과장","subject":"견적서 7731"}';
      },
      {
        now: time.now,
        decision: async () => {
          time.pass(200);
          return {
            move: {
              kind: "mail",
              tool: MAIL,
              args: { query: "is:unread in:inbox" },
              asked: ["mail"],
              decided: { mail: 0.95, unfiltered: 0.9 },
            },
            verdict: "moved",
            asked: ["mail"],
          };
        },
      },
    );
    const said = "김영희 과장 메일 왔는지 봐줘 7731";
    const { turnId } = await sentTurn(engine, said);
    await until(async () => (await statusOf(turnId)) === "done");
    const { label, error, ...measured } = await rowOf(turnId);
    // Not vacuous: the older column beside these does hold the words, for 오늘 to name the turn by.
    expect(label).toBe(said);
    expect(error).toBeNull();
    expect(measured).toMatchObject({
      firstMoveAsked: ["mail"],
      firstMoveVerdict: "moved",
      firstMoveKind: "mail",
      firstWordMs: 1_970,
    });
    const serialised = JSON.stringify(measured);
    for (const word of [
      "김영희",
      "과장",
      "메일 왔는지",
      "봐줘",
      "7731",
      "견적서",
    ]) {
      expect([word, serialised.includes(word)]).toEqual([word, false]);
    }
  });
});
