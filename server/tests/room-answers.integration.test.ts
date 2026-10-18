import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import { eq, inArray, like } from "drizzle-orm";
import { isFirstMove } from "../../shared/first-move";
import {
  type HubRoomMessages,
  type HubRooms,
  roomMessageRef,
} from "../../shared/hub/protocol";
import {
  ROOM_ANSWER_WINDOW_MS,
  roomConversationId,
} from "../../shared/hub/room-answers";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { openRoomConversation } from "../src/channels/conversations";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  hubOutbox,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import { createHubOutbox } from "../src/hub/outbox";
import { createRoomAnswers, roomQuestionId } from "../src/hub/room-answers";
import { createHubToolTransport } from "../src/hub/tools";
import { createRunLedger } from "../src/runner/run-ledger";
import { messagesFor } from "../src/runner/thread-store";
import type { LoopAgent, LoopOutcome } from "../src/runner/turn-loop";
import type { ChatToolkit } from "../src/turns/chat-tools";
import { createTurnEngine } from "../src/turns/engine";
import { createTurnHub } from "../src/turns/hub";
import { TEST_POOL } from "./support/database";

/**
 * "@라피 …" in a team room, answered by the asker's own VM (`hub/room-answers.ts`): the real engine,
 * the real thread store and the real outbox against Postgres; the hub is a script, and so is the Bot.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
const ME = `room-answers-${tag}`;
const BOT = `room-answers-bot-${tag}`;
/** This VM's member id in its company. */
const MEMBER = `m_me_${tag}`;
const OTHER = `m_other_${tag}`;
const owner: AgentActor = { id: ME, role: "user" };

beforeAll(async () => {
  await database.insert(users).values({
    id: ME,
    email: `${ME}@laf.test`,
    name: ME,
    emailVerified: true,
  });
  await database.insert(agents).values({
    id: BOT,
    name: "라피",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: BOT,
    ownerUserId: ME,
    roleDescription: "",
    avatarSeed: "seed",
  });
});

afterAll(async () => {
  const threads = (
    await database
      .select({ threadId: channelThreads.threadId })
      .from(channelThreads)
      .where(eq(channelThreads.userId, ME))
  ).map((row) => row.threadId);
  if (threads.length > 0) {
    await database
      .delete(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, threads));
    await database
      .delete(lafThreadRuns)
      .where(inArray(lafThreadRuns.threadId, threads));
  }
  await database.delete(hubOutbox).where(like(hubOutbox.path, `%${tag}%`));
  await database.delete(channels).where(like(channels.id, `room_%${tag}`));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(eq(users.id, ME));
  await database.$client.end();
});

const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as BaseEvent;

/**
 * A Bot that says `answer`, after asking for `call` on its first run when it is given one. What it
 * was handed each run is kept.
 */
function scriptedBot(
  answer: string,
  options: {
    call?: { name: string; args: string };
    fails?: boolean;
    /** Steps a delegated run leaves on the thread before the answer (`lafDelegated`). */
    delegatedSteps?: number;
    /** Awaited at the start of every run: a turn that takes as long as a case needs. */
    onRun?: (run: number) => Promise<void> | void;
  } = {},
) {
  const bot = {
    messages: [] as Message[],
    inputs: [] as Message[][],
    runs: 0,
    threadId: undefined as string | undefined,
    setMessages(messages: Message[]) {
      bot.messages = [...messages];
    },
    addMessage(message: Message) {
      bot.messages.push(message);
    },
    async runAgent(
      _input: unknown,
      subscriber?: {
        onEvent?: (payload: { event: BaseEvent }) => unknown;
        onRunFinishedEvent?: () => unknown;
      },
    ) {
      bot.inputs.push([...bot.messages]);
      bot.runs += 1;
      await options.onRun?.(bot.runs);
      if (options.fails) {
        // Half an answer arrived, then the stream broke: words that must not reach the room.
        bot.messages.push({
          id: `a-${randomUUID()}`,
          role: "assistant",
          content: answer,
        });
        throw new Error("laf:model_rate_limited");
      }
      const emit = (e: BaseEvent) => subscriber?.onEvent?.({ event: e });
      emit(event("RUN_STARTED"));
      const id = `a-${randomUUID()}`;
      if (bot.runs === 1 && options.call) {
        const callId = `call-${randomUUID().slice(0, 8)}`;
        emit(
          event("TOOL_CALL_START", {
            toolCallId: callId,
            toolCallName: options.call.name,
            parentMessageId: id,
          }),
        );
        emit(
          event("TOOL_CALL_ARGS", {
            toolCallId: callId,
            delta: options.call.args,
          }),
        );
        emit(event("TOOL_CALL_END", { toolCallId: callId }));
        bot.messages.push({
          id,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: callId,
              type: "function",
              function: {
                name: options.call.name,
                arguments: options.call.args,
              },
            },
          ],
        } as Message);
      } else {
        for (let step = 0; step < (options.delegatedSteps ?? 0); step += 1) {
          bot.messages.push({
            id: `step-${randomUUID()}`,
            role: "assistant",
            content: `페이지 ${step}`,
            lafDelegated: "call-browse",
          } as Message);
        }
        emit(event("TEXT_MESSAGE_START", { messageId: id, role: "assistant" }));
        emit(event("TEXT_MESSAGE_CONTENT", { messageId: id, delta: answer }));
        bot.messages.push({ id, role: "assistant", content: answer });
      }
      emit(event("RUN_FINISHED"));
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [] };
    },
  };
  return bot;
}

type Line = {
  seq: number;
  by: string;
  text: string;
  mentions: string[];
  at: string;
};

/** A hub with one room, scripted: what it was asked is kept. */
function scriptedHub(room: string, lines: Line[]) {
  const asked: HubRequest[] = [];
  const posted: HubRequest[] = [];
  const http: HubHttp = {
    async request(request) {
      asked.push(request);
      const ok = (body: unknown): HubAnswer<never> =>
        ({ ok: true, status: 200, body }) as HubAnswer<never>;
      if (request.method === "POST") {
        posted.push(request);
        return ok({ ok: true, seq: lines.length + posted.length });
      }
      if (request.path === "/rooms") {
        return ok({
          ok: true,
          rooms: [
            {
              id: room,
              name: "영업팀",
              members: [MEMBER],
              lastSeq: 9,
              createdBy: MEMBER,
              createdAt: new Date().toISOString(),
            },
          ],
        } satisfies HubRooms);
      }
      const newest = request.path.match(/messages\?limit=(\d+)$/);
      if (newest) {
        const page = lines
          .slice(-Number(newest[1]))
          .map((line) => ({ ...line, runId: null, files: [] }));
        return ok({
          ok: true,
          messages: page,
          seq: page.at(-1)?.seq ?? 0,
          more: false,
        } satisfies HubRoomMessages);
      }
      const one = request.path.match(/messages\?since=(\d+)&limit=1$/);
      if (one) {
        const since = Number(one[1]);
        const page = lines
          .filter((line) => line.seq === since + 1)
          .map((line) => ({ ...line, runId: null, files: [] }));
        return ok({
          ok: true,
          messages: page,
          seq: page.at(-1)?.seq ?? since,
          more: false,
        } satisfies HubRoomMessages);
      }
      return {
        ok: false,
        status: 404,
        code: "laf:hub_not_found",
      } as HubAnswer<never>;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  return { http, asked, posted };
}

const READ = "mcp__hub__read";
const WRITE = "mcp__hub__write";

/**
 * What the person's boundary says about a hub write, standing where `plugins/call.ts` does for the
 * turn's executor: `allow`; `deny`; or `ask`, answered when the case says, `granted` carrying it out.
 */
type Boundary =
  | "allow"
  | "deny"
  | { ask: () => Promise<"granted" | "declined" | "nobody"> };

function answering(input: {
  room: string;
  lines: Line[];
  bot: ReturnType<typeof scriptedBot>;
  /** What the turn's hub tools are, as its toolkit offers them; both, unless a case says. */
  offered?: string[];
  now?: () => number;
  boundary?: Boundary;
  /** Another process's hub, for a case that is two processes one after the other. */
  hub?: ReturnType<typeof scriptedHub>;
}) {
  const hub = input.hub ?? scriptedHub(input.room, input.lines);
  const outbox = createHubOutbox({
    database,
    http: hub.http,
    sleep: async () => {},
  });
  // The hub tools' own transport, as the catalogue entry carries out a call the boundary let by.
  const transport = createHubToolTransport({
    http: hub.http,
    outbox,
    database,
    // Never resolves: the answer comes from the sweep having finished, not from a timer.
    sleep: () => new Promise<void>(() => {}),
  });
  const written = async (args: Record<string, unknown>) =>
    (
      await transport.callTool(
        { url: "https://hub.example", botId: BOT, drawnOn: "conversation" },
        "write",
        args,
      )
    ).text;
  const boundary = async (
    args: Record<string, unknown>,
  ): Promise<LoopOutcome> => {
    const said = input.boundary ?? "allow";
    if (said === "allow") return written(args);
    if (said === "deny") {
      return { ok: false, code: "laf:policy_denied", reason: "denied" };
    }
    const answer = await said.ask();
    if (answer === "granted") return written(args);
    return answer === "declined"
      ? { ok: false, code: "laf:person_declined", reason: "declined" }
      : { ok: false, code: "laf:nobody_answered", reason: "nobody" };
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const decided: unknown[] = [];
  const turns = createTurnHub({ keepEndedMs: 50 });
  const engine = createTurnEngine({
    database,
    persistRetryMs: [5, 5, 5],
    ledger: createRunLedger(database),
    hub: turns,
    resolveAgents: async () => ({ [BOT]: input.bot as unknown as LoopAgent }),
    tools: async (): Promise<ChatToolkit> => ({
      tools: (input.offered ?? [READ, WRITE]).map((name) => ({
        name,
        description: name,
        parameters: {},
      })),
      execute: async (name, args) => {
        calls.push({ name, args });
        return name === READ
          ? {
              ok: true,
              source: "회사",
              kind: "room",
              id: input.room,
              messages: input.lines,
            }
          : boundary(args);
      },
    }),
    // The decisions model, which a room's turn must not ask.
    firstMove: async (asked) => {
      decided.push(asked);
      return { move: null, verdict: "no_word", asked: [] };
    },
  });
  const profileStore = createAgentProfileStore(
    database,
    new URL("https://managed.example.test/ag-ui"),
  );
  const threadIdentity = createThreadIdentity("test-deployment");
  const answers = createRoomAnswers({
    database,
    http: hub.http,
    me: () => MEMBER,
    answerer: async () => ({ owner, botId: BOT }),
    conversation: async (answerer, room) => {
      const made = await openRoomConversation(
        { database, profileStore, threadIdentity },
        answerer.owner,
        answerer.botId,
        room,
      );
      return { channelId: made.id, threadId: made.threadId };
    },
    engine,
    turns,
    ...(input.now ? { now: input.now } : {}),
  });
  const mention = (seq: number) =>
    answers.onEvent({
      seq,
      type: "room.mention",
      refId: roomMessageRef(input.room, seq),
      actor: MEMBER,
      at: new Date().toISOString(),
    });
  /** The room's conversation's messages, once the outbox has nothing left to send. */
  const thread = async () => {
    const [row] = await database
      .select({ threadId: channelThreads.threadId })
      .from(channelThreads)
      .where(eq(channelThreads.channelId, roomConversationId(input.room, BOT)));
    return row ? messagesFor(database, row.threadId) : null;
  };
  /** Every question taken, and whatever the outbox was handed sent. */
  const settled = async () => {
    await answers.settled();
    await outbox.sweep();
  };
  return { settled, mention, hub, calls, decided, thread, answers };
}

const roomOf = () => `r_${randomUUID().slice(0, 8)}_${tag}`;
const line = (seq: number, by: string, text: string, mentions: string[]) => ({
  seq,
  by,
  text,
  mentions,
  at: new Date().toISOString(),
});

describe("a person's @라피 in a team room", () => {
  test("is a turn in the room's own conversation that reads the room first, and its last words go to the room as their 라피", async () => {
    const room = roomOf();
    const bot = scriptedBot("오늘은 10월 16일이에요.");
    const lines = [
      line(1, `m:${OTHER}`, "회의는 몇 시죠?", []),
      line(2, `m:${MEMBER}`, "@라피 오늘 날짜 알려줘", ["lafi"]),
    ];
    const { settled, mention, hub, calls, decided, thread } = answering({
      room,
      lines,
      bot,
    });
    mention(2);
    await settled();

    // Its own conversation, of its own kind, named after the room.
    const [made] = await database
      .select({ kind: channels.kind, name: channels.name })
      .from(channels)
      .where(eq(channels.id, roomConversationId(room, BOT)));
    expect(made).toEqual({ kind: "room", name: "영업팀" });

    // The person's words, then the room read for the Bot, then its answer, then the post.
    const stored = (await thread()) ?? [];
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "assistant",
      "tool",
    ]);
    expect(stored[0]).toMatchObject({
      id: roomQuestionId(room, 2),
      content: "@라피 오늘 날짜 알려줘",
    });
    expect(isFirstMove(stored[1] as Message)).toBe(true);
    // The post is a call of the turn's, through its executor — where the boundary judges it.
    expect(isFirstMove(stored[4] as Message)).toBe(false);
    expect(calls).toEqual([
      { name: READ, args: { kind: "room", id: room } },
      {
        name: WRITE,
        args: {
          kind: "post",
          room,
          text: "오늘은 10월 16일이에요.",
          mentions: [],
        },
      },
    ]);
    // The model was handed the room as a tool result before it said anything.
    expect(bot.inputs[0]?.at(-1)?.role).toBe("tool");
    expect(String(bot.inputs[0]?.at(-1)?.content)).toContain("회의는 몇 시죠?");
    // A step the server decided asks the decisions model nothing.
    expect(decided).toEqual([]);

    // Posted once, as the person's 라피, mentioning nobody.
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0]).toMatchObject({
      method: "POST",
      path: `/rooms/${room}/messages`,
      body: { text: "오늘은 10월 16일이에요.", mentions: [], as: "bot" },
    });
    // Every hub call this made itself said it was the room's; the post is the hub tool's.
    expect(
      hub.asked
        .filter((request) => request.method !== "POST")
        .every((request) => request.origin === "room"),
    ).toBe(true);
  });

  test("somebody else's mention of this person, and their 라피's own post, start nothing", async () => {
    const room = roomOf();
    const bot = scriptedBot("안 불려야 해요.");
    const { settled, mention, hub, thread } = answering({
      room,
      bot,
      lines: [
        line(1, `m:${OTHER}`, "@나 이거 봐 줘요", [MEMBER]),
        line(2, `bot:${MEMBER}`, "제 사람에게 알려요", [MEMBER]),
        // Another member asking their own 라피: their VM's, never this one's.
        line(3, `m:${OTHER}`, "@라피 요약해 줘", ["lafi"]),
        line(4, `m:${MEMBER}`, "@라피 오늘 날짜", ["lafi"]),
      ],
    });
    mention(1);
    mention(2);
    mention(3);
    await settled();
    expect(bot.runs).toBe(0);
    expect(await thread()).toBeNull();
    expect(hub.posted).toEqual([]);
    // The same room, this person's own question: answered.
    mention(4);
    await settled();
    expect(bot.runs).toBe(1);
    expect(hub.posted).toHaveLength(1);
  });

  test("heard again, it is answered once; a second question waits for the first", async () => {
    const room = roomOf();
    const bot = scriptedBot("네.");
    const { settled, mention, hub, thread } = answering({
      room,
      bot,
      lines: [
        line(1, `m:${MEMBER}`, "@라피 하나", ["lafi"]),
        line(2, `m:${MEMBER}`, "@라피 둘", ["lafi"]),
      ],
    });
    mention(1);
    mention(1);
    mention(2);
    await settled();
    // After it was answered, as a restart replaying the line would hear it.
    mention(1);
    await settled();
    const asked = ((await thread()) ?? []).filter(
      (message) => message.role === "user",
    );
    expect(asked.map((message) => message.id)).toEqual([
      roomQuestionId(room, 1),
      roomQuestionId(room, 2),
    ]);
    expect(hub.posted).toHaveLength(2);
  });

  test("a question older than the window is not answered late", async () => {
    const room = roomOf();
    const bot = scriptedBot("늦었어요.");
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const { settled, mention, hub } = answering({
      room,
      bot,
      lines: [
        { ...line(1, `m:${MEMBER}`, "@라피 아까 그거", ["lafi"]), at: old },
        line(2, `m:${MEMBER}`, "@라피 지금 이거", ["lafi"]),
      ],
    });
    mention(1);
    await settled();
    expect(bot.runs).toBe(0);
    mention(2);
    await settled();
    expect(bot.runs).toBe(1);
    expect(hub.posted).toHaveLength(1);
  });

  test("when the Bot posted to the room itself, its last words are not posted again", async () => {
    const room = roomOf();
    const bot = scriptedBot("방에 올렸어요.", {
      call: {
        name: WRITE,
        args: JSON.stringify({ kind: "post", room, text: "오늘은 16일" }),
      },
    });
    const { settled, mention, hub, calls } = answering({
      room,
      bot,
      lines: [line(1, `m:${MEMBER}`, "@라피 방에 날짜 올려줘", ["lafi"])],
    });
    mention(1);
    await settled();
    expect(calls.map((call) => call.name)).toEqual([READ, WRITE]);
    expect(bot.runs).toBe(2);
    // The Bot's own post, once; its last words after it are not a second.
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0]).toMatchObject({ body: { text: "오늘은 16일" } });
  });

  test("a turn long enough to push the question out of any window still posts its last words", async () => {
    const room = roomOf();
    // More rows after the question than a 400-row tail of the thread held.
    const bot = scriptedBot("다 찾아봤어요.", { delegatedSteps: 420 });
    const { settled, mention, hub, thread } = answering({
      room,
      bot,
      lines: [line(1, `m:${MEMBER}`, "@라피 찾아봐 줘", ["lafi"])],
    });
    mention(1);
    await settled();
    expect(((await thread()) ?? []).length).toBeGreaterThan(400);
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0]).toMatchObject({
      body: { text: "다 찾아봤어요.", mentions: [], as: "bot" },
    });
  });

  test("a turn that fails posts nothing to the room", async () => {
    const room = roomOf();
    const bot = scriptedBot("오늘은 10월", { fails: true });
    const { settled, mention, hub, thread } = answering({
      room,
      bot,
      lines: [line(1, `m:${MEMBER}`, "@라피 해 줘", ["lafi"])],
    });
    mention(1);
    await settled();
    expect(bot.runs).toBe(1);
    // The person's question is kept in their conversation, where the failure is theirs to see.
    expect(((await thread()) ?? []).map((message) => message.id)).toContain(
      roomQuestionId(room, 1),
    );
    expect(hub.posted).toEqual([]);
  });

  test("without the hub's read in the turn's tools, the turn starts as any other", async () => {
    const room = roomOf();
    const bot = scriptedBot("네.");
    const { settled, mention, calls, decided, thread } = answering({
      room,
      bot,
      offered: [WRITE],
      lines: [line(1, `m:${MEMBER}`, "@라피 해 줘", ["lafi"])],
    });
    mention(1);
    await settled();
    expect(calls.map((call) => call.name)).toEqual([WRITE]);
    expect(decided).toHaveLength(1);
    expect(((await thread()) ?? []).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "tool",
    ]);
  });

  test("a Bot not given the hub's write posts nothing to the room", async () => {
    const room = roomOf();
    const bot = scriptedBot("네.");
    const { settled, mention, calls, hub } = answering({
      room,
      bot,
      offered: [READ],
      lines: [line(1, `m:${MEMBER}`, "@라피 해 줘", ["lafi"])],
    });
    mention(1);
    await settled();
    expect(bot.runs).toBe(1);
    expect(calls.map((call) => call.name)).toEqual([READ]);
    expect(hub.posted).toEqual([]);
  });

  test("a boundary that denies hub writes: nothing reaches the room, and the refusal is in the person's conversation", async () => {
    const room = roomOf();
    const bot = scriptedBot("오늘은 16일이에요.");
    const { settled, mention, calls, hub, thread } = answering({
      room,
      bot,
      boundary: "deny",
      lines: [line(1, `m:${MEMBER}`, "@라피 오늘 날짜", ["lafi"])],
    });
    mention(1);
    await settled();
    expect(calls.at(-1)).toEqual({
      name: WRITE,
      args: { kind: "post", room, text: "오늘은 16일이에요.", mentions: [] },
    });
    expect(hub.posted).toEqual([]);
    const last = ((await thread()) ?? []).at(-1);
    expect(last?.role).toBe("tool");
    expect(String(last?.content)).toContain("laf:policy_denied");
  });

  test("a boundary that asks: nothing goes while the person is asked or when nobody answers; a yes posts it once", async () => {
    const room = roomOf();
    const bot = scriptedBot("네, 알아봤어요.");
    const answers: Array<"granted" | "nobody"> = ["nobody", "granted"];
    let asked = () => {};
    let reply: (answer: "granted" | "nobody") => void = () => {};
    const { settled, mention, hub } = answering({
      room,
      bot,
      boundary: {
        ask: () =>
          new Promise((resolve) => {
            reply = resolve;
            asked();
          }),
      },
      lines: [
        line(1, `m:${MEMBER}`, "@라피 하나", ["lafi"]),
        line(2, `m:${MEMBER}`, "@라피 둘", ["lafi"]),
      ],
    });
    for (const [index, answer] of answers.entries()) {
      const asking = new Promise<void>((resolve) => {
        asked = resolve;
      });
      mention(index + 1);
      await asking;
      expect(hub.posted).toHaveLength(0);
      reply(answer);
      await settled();
    }
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0]).toMatchObject({
      body: { text: "네, 알아봤어요.", as: "bot" },
    });
  });

  test("a question that waited behind a long turn is answered: it was fresh when it was heard", async () => {
    const room = roomOf();
    let clock = Date.now();
    // The first turn runs past the window.
    const bot = scriptedBot("네.", {
      onRun: (run) => {
        if (run === 1) clock += ROOM_ANSWER_WINDOW_MS + 60_000;
      },
    });
    const { settled, mention, hub } = answering({
      room,
      bot,
      now: () => clock,
      lines: [
        line(1, `m:${MEMBER}`, "@라피 오래 걸리는 것", ["lafi"]),
        line(2, `m:${MEMBER}`, "@라피 그다음 것", ["lafi"]),
      ],
    });
    mention(1);
    mention(2);
    await settled();
    expect(bot.runs).toBe(2);
    expect(hub.posted).toHaveLength(2);
  });

  test("a restart while a question waits loses nothing: the next process answers what was never filed, once", async () => {
    const room = roomOf();
    const lines = [
      line(1, `m:${MEMBER}`, "@라피 하나", ["lafi"]),
      line(2, `m:${MEMBER}`, "@라피 둘", ["lafi"]),
      line(3, `m:${OTHER}`, "@라피 남의 것", ["lafi"]),
    ];
    const hub = scriptedHub(room, lines);
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The process before: the first question's turn is under way, the second waits behind it.
    const before = answering({
      room,
      lines,
      hub,
      bot: scriptedBot("하나요.", {
        onRun: () => {
          started();
          return held;
        },
      }),
    });
    before.mention(1);
    before.mention(2);
    await running;

    // The process after: its line's cursor is past both mentions, so it hears neither again.
    const bot = scriptedBot("둘이요.");
    const after = answering({ room, lines, hub, bot });
    await after.answers.catchUp();
    await after.settled();
    // Connected again: everything it would take is filed.
    await after.answers.catchUp();
    await after.settled();
    expect(bot.runs).toBe(1);
    const asked = bot.inputs[0]?.filter((message) => message.role === "user");
    expect(asked?.map((message) => message.id)).toEqual([
      roomQuestionId(room, 1),
      roomQuestionId(room, 2),
    ]);
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0]).toMatchObject({ body: { text: "둘이요." } });

    release();
    await before.settled();
  });
});

describe("the room's conversation (openRoomConversation)", () => {
  test("is made once per room and Bot, and found again by its id", async () => {
    const room = roomOf();
    const deps = {
      database,
      profileStore: createAgentProfileStore(
        database,
        new URL("https://managed.example.test/ag-ui"),
      ),
      threadIdentity: createThreadIdentity("test-deployment"),
    };
    const first = await openRoomConversation(deps, owner, BOT, {
      id: room,
      name: "디자인팀",
    });
    const again = await openRoomConversation(deps, owner, BOT, {
      id: room,
      name: "이름이 바뀐 방",
    });
    expect(first).toMatchObject({
      id: roomConversationId(room, BOT),
      kind: "room",
      name: "디자인팀",
    });
    expect(again.threadId).toBe(first.threadId);
    const rows = await database
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, first.id));
    expect(rows).toHaveLength(1);
  });
});
