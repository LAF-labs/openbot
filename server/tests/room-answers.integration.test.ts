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
import { roomConversationId } from "../../shared/hub/room-answers";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { openRoomConversation } from "../src/channels/conversations";
import { createTurnFailureReader } from "../src/channels/turn-failures";
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
import { createRunBudget } from "../src/hub/budget";
import { createHubOutbox } from "../src/hub/outbox";
import { createRoomAnswers, roomQuestionId } from "../src/hub/room-answers";
import { createRunLedger } from "../src/runner/run-ledger";
import { messagesFor } from "../src/runner/thread-store";
import type { LoopAgent } from "../src/runner/turn-loop";
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
  options: { call?: { name: string; args: string }; fails?: boolean } = {},
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

/**
 * A hub with one room, scripted: what it was asked is kept. Its budget refuses every reservation
 * when the workspace's day is `spent`, and keeps each reservation and settle apart from the posts.
 */
function scriptedHub(
  room: string,
  lines: Line[],
  budget: { spent: boolean } = { spent: false },
) {
  const asked: HubRequest[] = [];
  const posted: HubRequest[] = [];
  const reserved: HubRequest[] = [];
  const settled: HubRequest[] = [];
  const http: HubHttp = {
    async request(request) {
      asked.push(request);
      const ok = (body: unknown): HubAnswer<never> =>
        ({ ok: true, status: 200, body }) as HubAnswer<never>;
      if (request.path === "/budget/reserve") {
        if (budget.spent) {
          return {
            ok: false,
            status: 409,
            code: "laf:budget_reached",
          } as HubAnswer<never>;
        }
        reserved.push(request);
        return ok({ ok: true });
      }
      if (request.path === "/budget/settle") {
        settled.push(request);
        return ok({ ok: true });
      }
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
  return { http, asked, posted, reserved, settled };
}

const READ = "mcp__hub__read";
const WRITE = "mcp__hub__write";

function answering(input: {
  room: string;
  lines: Line[];
  bot: ReturnType<typeof scriptedBot>;
  /** What the turn's hub tools are, as its toolkit offers them; both, unless a case says. */
  offered?: string[];
  now?: number;
  /** The company's budget, asked before each question: spent, or with room. Absent: no budget. */
  budget?: { spent: boolean };
}) {
  const hub = scriptedHub(input.room, input.lines, input.budget);
  const ledger = createRunLedger(database);
  const outbox = createHubOutbox({
    database,
    http: hub.http,
    sleep: async () => {},
  });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const decided: unknown[] = [];
  const turns = createTurnHub({ keepEndedMs: 50 });
  const engine = createTurnEngine({
    database,
    persistRetryMs: [5, 5, 5],
    ledger,
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
          : { ok: true, kind: "post", sent: true };
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
    outbox,
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
    ...(input.now === undefined ? {} : { now: () => input.now as number }),
    ...(input.budget
      ? {
          budget: {
            runs: createRunBudget({ http: hub.http, outbox }),
            ledger,
          },
        }
      : {}),
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
  return { settled, mention, hub, calls, decided, thread };
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

    // The person's words, then the room read for the Bot, then its answer.
    const stored = (await thread()) ?? [];
    expect(stored.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(stored[0]).toMatchObject({
      id: roomQuestionId(room, 2),
      content: "@라피 오늘 날짜 알려줘",
    });
    expect(isFirstMove(stored[1] as Message)).toBe(true);
    expect(calls).toEqual([{ name: READ, args: { kind: "room", id: room } }]);
    // The model was handed the room as a tool result before it said anything.
    expect(bot.inputs[0]?.at(-1)?.role).toBe("tool");
    expect(String(bot.inputs[0]?.at(-1)?.content)).toContain("회의는 몇 시죠?");
    // A step the server decided asks the decisions model nothing.
    expect(decided).toEqual([]);

    // Posted once, as the person's 라피, mentioning nobody, under the turn's run.
    expect(hub.posted).toHaveLength(1);
    expect(hub.posted[0]).toMatchObject({
      method: "POST",
      path: `/rooms/${room}/messages`,
      body: { text: "오늘은 10월 16일이에요.", mentions: [], as: "bot" },
      origin: "room",
    });
    expect(hub.posted[0]?.run).toBeTruthy();
    // Every hub call this made said it was the room's.
    expect(hub.asked.every((request) => request.origin === "room")).toBe(true);
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
    expect(hub.posted).toEqual([]);
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
    expect(calls).toEqual([]);
    expect(decided).toHaveLength(1);
    expect(((await thread()) ?? []).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
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

describe("a room's question and the company's budget", () => {
  test("over the limit: the model is never asked, the room gets nothing, and the asker's conversation holds the question with the company's fact", async () => {
    const room = roomOf();
    const bot = scriptedBot("안 불려야 해요.");
    const { settled, mention, hub, calls, thread } = answering({
      room,
      bot,
      lines: [line(1, `m:${MEMBER}`, "@라피 오늘 매출 정리해줘", ["lafi"])],
      budget: { spent: true },
    });
    mention(1);
    await settled();

    expect(bot.runs).toBe(0);
    expect(calls).toEqual([]);
    expect(hub.posted).toEqual([]);
    expect(hub.settled).toEqual([]);
    // The question is in the room's conversation, and the failure under it is the company's day.
    const stored = (await thread()) ?? [];
    expect(stored.map((message) => [message.id, message.role])).toEqual([
      [roomQuestionId(room, 1), "user"],
    ]);
    const [row] = await database
      .select({ threadId: channelThreads.threadId })
      .from(channelThreads)
      .where(eq(channelThreads.channelId, roomConversationId(room, BOT)));
    const failures = await createTurnFailureReader(database)(
      row?.threadId ?? "",
    );
    expect(
      failures.map(({ messageId, code }) => ({ messageId, code })),
    ).toEqual([
      {
        messageId: roomQuestionId(room, 1),
        code: "laf:turn_company_budget_reached",
      },
    ]);

    // Heard again, it is not asked again: the question is filed.
    mention(1);
    await settled();
    expect(bot.runs).toBe(0);
    expect(
      hub.asked.filter((request) => request.path === "/budget/reserve"),
    ).toHaveLength(1);
  });

  test("with room: reserved on the workspace alone before the turn, under the question's id, and settled after through the outbox", async () => {
    const room = roomOf();
    const bot = scriptedBot("정리했어요.");
    const { settled, mention, hub } = answering({
      room,
      bot,
      lines: [line(1, `m:${MEMBER}`, "@라피 오늘 매출 정리해줘", ["lafi"])],
      budget: { spent: false },
    });
    // How many times the model had been asked when the hub was asked for the reservation.
    const asksAtReserve: number[] = [];
    const sent = hub.http.request.bind(hub.http);
    hub.http.request = ((request: HubRequest) => {
      if (request.path === "/budget/reserve") asksAtReserve.push(bot.runs);
      return sent(request);
    }) as HubHttp["request"];
    mention(1);
    await settled();

    expect(asksAtReserve).toEqual([0]);
    expect(bot.runs).toBe(1);
    expect(hub.reserved).toHaveLength(1);
    expect(hub.reserved[0]).toMatchObject({
      body: { runId: roomQuestionId(room, 1), scopes: ["workspace"] },
      origin: "room",
    });
    expect(hub.settled).toHaveLength(1);
    expect(hub.settled[0]?.body).toEqual({
      runId: roomQuestionId(room, 1),
      actual: 0,
    });
    expect(hub.posted).toHaveLength(1);
  });
});
