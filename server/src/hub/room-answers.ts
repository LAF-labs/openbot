/**
 * "@라피 …" in a team room, answered by the asker's own VM.
 *
 * THE SHAPE (hub design §7.2, appendix A.2). The hub tells only the author of a `lafi` mention
 * (`room.mention`), so this runs on the asker's VM and on no other. It reads the message the event
 * names, makes sure it is this person asking their own 라피, and starts a turn through the engine —
 * the one every conversation's turns go through — in a conversation of its own for that room
 * (`openRoomConversation`, kind `room`). The turn's first step is the room's newest messages, read
 * through the hub tool as a first move, so they reach the model as a tool result and the head of
 * the prompt is the bytes it always is. When the turn is over, its last words are posted to the
 * room as this person's 라피 (`as: "bot"`), through the outbox.
 *
 * AN ATTENDED TURN, NOT A ROUTINE'S. The person asked, a moment ago, from their own account: what
 * the turn needs to ask them — an approval, a login — is a card in that conversation on their own
 * screen, as in any chat, and the boundary judges every call as it does there. Nobody else in the
 * room can answer it, and nothing about it is posted to the room.
 *
 * WHAT THE ROOM SEES WHILE IT WORKS is nothing posted: the screens read it off the question
 * itself (`shared/hub/room-answers.ts`, `lafiWorking`).
 *
 * ONE QUESTION AT A TIME PER ROOM, in the order they were asked: two at once would be two turns on
 * one conversation, which the engine refuses. Different rooms go on side by side.
 *
 * THE COMPANY'S DAY, ASKED BEFORE THE TURN (lafi-dev-design §7, `budget.ts`). A room's question is an
 * unattended run as far as the company's ledger goes — nobody chose to spend on it but the asker,
 * and the room sees the answer — so it reserves against the workspace's day before the engine is
 * handed anything, under an id made from the room and the message's number (a question heard again
 * gets its reservation back, never a second one), and what the turn cost is settled after, through
 * the outbox, however the turn ended. Refused, nothing reaches the model and nothing reaches the
 * room: the question is filed in the room's conversation with the refusal as its run's fact, which
 * the asker's own screen puts into words (`turn-failures.ts`, `laf:turn_company_budget_reached`).
 *
 * NEVER TWICE. The person's message is filed in the conversation under an id made from the room
 * and the message's number, so a mention heard again — a restart that replays the line from its
 * cursor — finds it there and starts nothing. And when the Bot already posted to the room itself
 * during the turn (`mcp__hub__write`), its last words are not posted again.
 */
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  HUB_ROOM_LIMITS,
  type HubEvent,
  type HubRoomPost,
} from "../../../shared/hub/protocol";
import {
  asksOwnLafi,
  isFresh,
  ROOM_ANSWER_WINDOW_MS,
} from "../../../shared/hub/room-answers";
import { jsonObjectOf } from "../../../shared/json-object";
import { cutAtCodeUnits } from "../../../shared/sound-text";
import { DEFERRED_TOOL_PREFIX } from "../../../shared/tools/bridge";
import { isDelegated } from "../../../shared/tools/delegate";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  lafThreadMessages,
  lafThreadRuns,
  userRoles,
} from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { chatLabelOf, type RunLedger } from "../runner/run-ledger";
import { appendMessages, messagesFor } from "../runner/thread-store";
import { CHAT_TURN_TIMEOUT_MS, type TurnEngine } from "../turns/engine";
import type { TurnHub, TurnStatus } from "../turns/hub";
import type { RunBudget } from "./budget";
import type { HubHttp } from "./http";
import type { HubOutbox } from "./outbox";
import { HUB_TOOLS_KEY } from "./tools";
import {
  HUB_TOOL_PATHS,
  readRoomMessages,
  readRooms,
  roomPostBody,
} from "./wire";

/** The hub tools by the names a turn's toolkit offers them under (`toolNameFor`). */
const HUB_READ_TOOL = `${DEFERRED_TOOL_PREFIX}${HUB_TOOLS_KEY}__read`;
const HUB_WRITE_TOOL = `${DEFERRED_TOOL_PREFIX}${HUB_TOOLS_KEY}__write`;

/** A room's id as the hub makes them: what may go into a conversation's id and a message's. */
const ROOM_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** How often a room's question looks again whether its conversation is free. */
const IDLE_POLL_MS = 500;

/** How long the turn's ledger row is waited for after its end is heard: the engine settles it after. */
const COST_WAIT_MS = 5_000;

/** Longer than any turn may run: past this the turn's end was never heard, and nothing is posted. */
const TURN_WAIT_MS = CHAT_TURN_TIMEOUT_MS + 60_000;

/** The person, and the Bot that answers for them. */
export type RoomAnswerer = { owner: AgentActor; botId: string };

export type RoomAnswersDeps = {
  database: Database;
  http: HubHttp;
  outbox: Pick<HubOutbox, "enqueue" | "sweep">;
  /** This VM's member id in its company, from the line's last `/me`; null before it answered. */
  me: () => string | null;
  /** Who answers. Null while there is nobody to — before the person has made their Bot. */
  answerer: () => Promise<RoomAnswerer | null>;
  /** The room's conversation with this Bot, made the first time (`openRoomConversation`). */
  conversation: (
    answerer: RoomAnswerer,
    room: { id: string; name: string },
  ) => Promise<{ channelId: string; threadId: string }>;
  engine: Pick<TurnEngine, "send" | "busy">;
  turns: Pick<TurnHub, "subscribe">;
  /**
   * The company's budget (`budget.ts`), asked before each question's turn and told after, and the
   * ledger a refused question is filed in. Absent: a question is answered as it was before.
   */
  budget?: {
    runs: RunBudget;
    ledger: Pick<RunLedger, "begin" | "settle">;
  };
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** `<room id>:<seq>`, as `roomMessageRef` writes it; null for anything else. */
export function parseMessageRef(
  ref: string | null,
): { roomId: string; seq: number } | null {
  if (!ref) return null;
  const at = ref.lastIndexOf(":");
  if (at <= 0) return null;
  const roomId = ref.slice(0, at);
  const seq = Number(ref.slice(at + 1));
  if (!ROOM_ID.test(roomId) || !Number.isSafeInteger(seq) || seq < 1) {
    return null;
  }
  return { roomId, seq };
}

/** The id the person's message is filed under in the room's conversation. */
export const roomQuestionId = (roomId: string, seq: number): string =>
  `room:${roomId}:${seq}`;

/**
 * What the turn has to post: its last words, unless the Bot posted to this room itself during the
 * turn. Read off the turn's messages after the question, the delegated runs' left out — their
 * words are a step's, never the answer.
 */
export function answerOf(
  messages: readonly Message[],
  questionId: string,
  roomId: string,
): { text: string; postedItself: boolean } {
  const from = messages.findIndex((message) => message.id === questionId);
  const turn = (from === -1 ? [] : messages.slice(from + 1)).filter(
    (message) => !isDelegated(message),
  );
  let postedItself = false;
  for (const message of turn) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.function.name !== HUB_WRITE_TOOL) continue;
      const args = jsonObjectOf(call.function.arguments ?? "");
      if (args?.kind === "post" && args.room === roomId) postedItself = true;
    }
  }
  let text = "";
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const message = turn[index];
    if (message?.role === "user") break;
    if (
      message?.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.trim()
    ) {
      text = message.content.trim();
      break;
    }
  }
  return { text, postedItself };
}

/**
 * The person and their Bot, read from the deployment's rows: one person, one Bot
 * (`docs/laf/deployment-model.md`). An account from before the one-Bot rule that still has several
 * is answered by the oldest, the one its main conversation was first made with.
 */
export async function answererOf(
  database: Database,
): Promise<RoomAnswerer | null> {
  const [row] = await database
    .select({ userId: agentProfiles.ownerUserId, botId: agentProfiles.agentId })
    .from(agentProfiles)
    .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
    .where(
      and(
        isNull(agentProfiles.deletedAt),
        isNotNull(agentProfiles.ownerUserId),
      ),
    )
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .limit(1);
  if (!row?.userId) return null;
  const roles = await database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, row.userId));
  return {
    owner: {
      id: row.userId,
      role: roles.some((one) => one.role === "admin") ? "admin" : "user",
    },
    botId: row.botId,
  };
}

export function createRoomAnswers(deps: RoomAnswersDeps) {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  /** Each room's questions, one after another. */
  const queues = new Map<string, Promise<void>>();
  /** Mentions taken in this process: the same event twice starts one turn. */
  const taken = new Set<string>();
  /** Each room's conversation, once opened. Keyed on the Bot too: a new Bot has its own. */
  const opened = new Map<string, { channelId: string; threadId: string }>();

  const ask = async <T>(path: string): Promise<T | null> => {
    const answer = await deps.http.request<T>({ path, origin: "room" });
    if (answer.ok) return answer.body;
    log.warn("room_answer_not_read", { code: answer.code });
    return null;
  };

  const roomName = async (roomId: string): Promise<string> => {
    const rooms = readRooms(await ask(HUB_TOOL_PATHS.rooms));
    return rooms?.find((room) => room.id === roomId)?.name || roomId;
  };

  /** Whether the conversation already holds this question: the line heard it again. */
  const filed = async (threadId: string, id: string): Promise<boolean> => {
    const [row] = await deps.database
      .select({ one: sql<number>`1` })
      .from(lafThreadMessages)
      .where(
        and(
          eq(lafThreadMessages.threadId, threadId),
          sql`(${lafThreadMessages.message} ->> 'id') = ${id}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  };

  /**
   * Start the turn and wait for its end. Listening starts before the send, so an end that comes
   * at once is not missed; a conversation busy with a turn of the person's own is waited for.
   */
  const runTurn = async (input: {
    answerer: RoomAnswerer;
    channelId: string;
    threadId: string;
    roomId: string;
    question: Message;
  }): Promise<{ turnId: string; status: TurnStatus | null } | null> => {
    const ended = new Map<string, TurnStatus>();
    let heard: (() => void) | null = null;
    const unsubscribe = deps.turns.subscribe(
      input.threadId,
      { epoch: null, after: null },
      (frame) => {
        if (frame.kind !== "turn") return;
        const { status } = frame.turn;
        if (status === "queued" || status === "running") return;
        ended.set(frame.turn.id, status);
        heard?.();
      },
    );
    try {
      const giveUpAt = now() + ROOM_ANSWER_WINDOW_MS;
      let turnId: string | null = null;
      for (;;) {
        const sent = await deps.engine.send({
          threadId: input.threadId,
          channelId: input.channelId,
          owner: input.answerer.owner,
          botId: input.answerer.botId,
          messages: [input.question],
          tools: null,
          origin: "room",
          firstMove: {
            tool: HUB_READ_TOOL,
            args: { kind: "room", id: input.roomId },
          },
        });
        if (sent.ok) {
          turnId = sent.turnId;
          break;
        }
        if (sent.code !== "laf:turn_in_progress" || now() > giveUpAt) {
          log.warn("room_answer_not_started", { code: sent.code });
          return null;
        }
        await sleep(IDLE_POLL_MS);
      }
      const until = now() + TURN_WAIT_MS;
      while (!ended.has(turnId)) {
        const left = until - now();
        if (left <= 0) return { turnId, status: null };
        await new Promise<void>((resolve) => {
          heard = resolve;
          setTimeout(resolve, Math.min(left, 60_000)).unref?.();
        });
        heard = null;
      }
      return { turnId, status: ended.get(turnId) as TurnStatus };
    } finally {
      unsubscribe();
    }
  };

  /**
   * What the turn cost, off its ledger row — which the engine settles just after the end it
   * announces, so a row still `running` is looked at again for a few seconds. Zero for a row that
   * never appears: the hub's day then counts the reservation's release, never a guess.
   */
  const spentBy = async (turnId: string): Promise<number> => {
    const giveUpAt = now() + COST_WAIT_MS;
    for (;;) {
      const [row] = await deps.database
        .select({ status: lafThreadRuns.status, cost: lafThreadRuns.costUsd })
        .from(lafThreadRuns)
        .where(eq(lafThreadRuns.runId, turnId))
        .limit(1);
      if (row && row.status !== "running") return row.cost;
      if (now() > giveUpAt) return row?.cost ?? 0;
      await sleep(IDLE_POLL_MS);
    }
  };

  /**
   * A question the company's budget refused: filed in the room's conversation under a run of its
   * own that ended on the hub's fact and asked the model nothing. A failure is not a message
   * (`channels/turn-failures.ts`): the asker's screen reads it off the run, beside their question,
   * and the question's id keeps it from being taken again when the line is heard twice.
   */
  const refused = async (
    ledger: Pick<RunLedger, "begin" | "settle">,
    input: { answerer: RoomAnswerer; threadId: string; question: Message },
    code: string,
  ): Promise<void> => {
    const runId = randomUUID();
    await ledger.begin({
      runId,
      threadId: input.threadId,
      agentId: input.answerer.botId,
      userId: input.answerer.owner.id,
      origin: "chat",
      // What the person asked, for 오늘 to name the run by, as a chat turn's is.
      label: chatLabelOf([input.question]),
    });
    await appendMessages(deps.database, input.threadId, [input.question], {
      runId,
    });
    await ledger.settle(runId, { status: "error", error: code, eventCount: 0 });
  };

  const answer = async (roomId: string, seq: number): Promise<void> => {
    const me = deps.me();
    if (!me) return;
    const lines = readRoomMessages(
      await ask(HUB_TOOL_PATHS.roomMessage(roomId, seq)),
    );
    const line = lines?.find((one) => one.seq === seq);
    // A member mentioning this person is told too; only their own 라피 call is answered here.
    if (!line || !asksOwnLafi(line, me)) return;
    if (!isFresh(line, now())) {
      log.info("room_answer_too_old", { room: roomId, seq });
      return;
    }
    const answerer = await deps.answerer();
    if (!answerer) {
      log.info("room_answer_no_bot", { room: roomId, seq });
      return;
    }
    const key = `${roomId}\u0000${answerer.botId}`;
    let conversation = opened.get(key);
    if (!conversation) {
      conversation = await deps.conversation(answerer, {
        id: roomId,
        name: await roomName(roomId),
      });
      opened.set(key, conversation);
    }
    const questionId = roomQuestionId(roomId, seq);
    if (await filed(conversation.threadId, questionId)) {
      log.info("room_answer_already", { room: roomId, seq });
      return;
    }
    const question: Message = {
      id: questionId,
      role: "user",
      content: line.text,
    };
    const verdict = deps.budget
      ? await deps.budget.runs.reserve({
          runId: questionId,
          scopes: [],
          origin: "room",
        })
      : null;
    if (verdict && !verdict.go && deps.budget) {
      await refused(
        deps.budget.ledger,
        { answerer, threadId: conversation.threadId, question },
        verdict.code,
      );
      log.info("room_answer_refused", { room: roomId, seq });
      return;
    }
    log.info("room_answer_started", { room: roomId, seq });
    const run = await runTurn({
      answerer,
      ...conversation,
      roomId,
      question,
    });
    // What it cost, however it ended — a turn never started cost nothing and frees what was set aside.
    if (deps.budget && verdict?.go) {
      await deps.budget.runs.settle({
        runId: questionId,
        actual: run ? await spentBy(run.turnId) : 0,
        origin: "room",
      });
    }
    if (run?.status !== "done") {
      // Stopped by the person, or failed: they see why in the conversation; the room is not told.
      log.info("room_answer_not_posted", {
        room: roomId,
        seq,
        status: run?.status ?? "unheard",
      });
      return;
    }
    const { text, postedItself } = answerOf(
      await messagesFor(deps.database, conversation.threadId, {
        last: 400,
      }),
      questionId,
      roomId,
    );
    if (postedItself || !text) {
      log.info("room_answer_not_posted", {
        room: roomId,
        seq,
        status: postedItself ? "posted_itself" : "no_words",
      });
      return;
    }
    // The rooms' own shape (`HubRoomPost`): as this person's 라피, mentioning nobody.
    const post: HubRoomPost = roomPostBody({
      text: cutAtCodeUnits(text, HUB_ROOM_LIMITS.text),
      mentions: [],
    });
    await deps.outbox.enqueue({
      method: "POST",
      path: HUB_TOOL_PATHS.roomPost(roomId),
      body: post,
      origin: "room",
      runId: run.turnId,
    });
    log.info("room_answer_posted", { room: roomId, seq });
    void deps.outbox.sweep();
  };

  return {
    /** Every event the line applies; only a `room.mention` is anything to this. */
    onEvent(event: HubEvent): void {
      if (event.type !== "room.mention") return;
      const ref = parseMessageRef(event.refId);
      if (!ref) return;
      const id = `${ref.roomId}:${ref.seq}`;
      if (taken.has(id)) return;
      taken.add(id);
      const before = queues.get(ref.roomId) ?? Promise.resolve();
      const next = before
        .then(() => answer(ref.roomId, ref.seq))
        .catch((error: unknown) => {
          log.warn("room_answer_failed", {
            room: ref.roomId,
            reason: describeFailure(error),
          });
        })
        // Done with, either way: heard again, the conversation's own copy of it is what answers.
        .then(() => {
          taken.delete(id);
        });
      queues.set(ref.roomId, next);
      void next.then(() => {
        if (queues.get(ref.roomId) === next) queues.delete(ref.roomId);
      });
    },

    /** Every question taken so far, answered or given up on. For tests and a clean stop. */
    async settled(): Promise<void> {
      while (queues.size > 0) {
        await Promise.all([...queues.values()]);
      }
    },
  };
}
