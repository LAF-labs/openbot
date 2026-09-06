/**
 * A routine's answer, delivered where the person already reads.
 *
 * Without this a routine's output lives on the Routines page behind a disclosure — work you have to
 * go and find, which is work you stop reading. The Bot has exactly one conversation and that is
 * where you would have asked the question by hand, so that is where the answer belongs: it becomes
 * the roster preview, it lights the unread dot, and the transcript reads as one continuous
 * relationship rather than two logs of the same colleague.
 *
 * Written straight into the store rather than through a run of the conversation's agent. The
 * routine already ran — this is recording what was said, not saying it again, and re-running it
 * against the chat thread would double the cost and could answer differently the second time.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type {
  AnnounceChannelActivity,
  ChannelActivityEvent,
} from "../channels/events";
import { previewOf } from "../channels/preview";
import { soloChannelFor } from "../channels/solo-channel";
import type { Database } from "../db/client";
import { channelMemberships, channels } from "../db/schema";
import { appendMessages, type StoredMessage } from "../runner/thread-store";

export type RoutineDelivery = {
  agentId: string;
  userId: string;
  /** The routine's name, which is what the transcript announces before the answer. */
  routineName: string;
  answer: string;
  at: Date;
};

/**
 * What a routine answers when it has nothing to say.
 *
 * Borrowed from Hermes' cron prompt: the routine prompt (`shared/prompt/mode/routine.ko.ts`) asks
 * for exactly `[SILENT]` when there is truly nothing to report, and this is the half that honours
 * it — a silent answer is not written to the conversation and rings no bell. Without it the 07:30
 * "새 주문 확인" delivers "새 주문이 없습니다" every morning, and a person who reads the same
 * nothing for a week stops opening the ones that are not nothing.
 *
 * Three spellings, because models paraphrase markers: the bracketed one the prompt asks for, the
 * bare word, and the Korean the prompt is written in.
 */
export const SILENT_MARKERS: readonly string[] = [
  "[SILENT]",
  "SILENT",
  "조용히",
  "[조용히]",
];

/** One line, with the decoration a model wraps a marker in taken off: `**[SILENT]**`, `` `SILENT` ``. */
function bareLine(line: string): string {
  return line
    .trim()
    .replace(/^[`*_"'「『]+|[`*_"'」』.。!]+$/g, "")
    .trim()
    .toUpperCase();
}

function isMarkerLine(line: string): boolean {
  const bare = bareLine(line);
  return SILENT_MARKERS.some((marker) => marker.toUpperCase() === bare);
}

/**
 * Whether an answer is the marker and not a report.
 *
 * The whole answer, its first line or its last line: a model that writes the marker and then
 * explains itself, or explains itself and then writes the marker, meant silence either way. A
 * marker INSIDE a sentence is content — "오늘은 [SILENT] 규칙을 쓰지 않았다" is a report — and an
 * empty answer is not silence, it is nothing, which the service already declines to deliver.
 */
export function isSilentAnswer(answer: string): boolean {
  const lines = answer
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) return false;
  return isMarkerLine(first) || isMarkerLine(last);
}

/** One thing a Bot said, appended to the one conversation it has with this person. */
export type SoloAppend = {
  agentId: string;
  userId: string;
  /** The bold line above the body: a routine's name, or who asked. Never a sentence — see below. */
  heading: string;
  body: string;
  at: Date;
  /**
   * The ledger run this message belongs to, when it belongs to one.
   *
   * A routine's failure mark carries one so `GET /api/channels/:id/failures` can key the red line
   * to it — the reader joins the ledger to the transcript by `run_id`, and a message without one is
   * a message no failure can be drawn under. An answer carries none: nothing is drawn under an
   * answer.
   */
  runId?: string;
};

/**
 * Write a message into a Bot's own conversation, and say nothing else about it.
 *
 * The half that two callers share: a routine delivering what it found, and a coworker recording
 * what it was asked. What they do NOT share is the roster row — a routine is news and rings the
 * bell, a handoff is a receipt for something the person watched happen a second ago in the other
 * Bot's window. Ringing for that would send them to read what they had just read.
 *
 * THE HEADING CARRIES NAMES, NEVER PROSE. Everything written here lands in a transcript, and the
 * server does not own the words on this surface (CLAUDE.md). A routine's name and a Bot's name are
 * facts the person authored; a sentence explaining them would be the server writing Korean.
 *
 * Returns the thread it wrote to, or null when the Bot has no conversation with this person yet —
 * creating one as a side effect of a schedule or a handoff is a surprise, not a feature.
 */
export async function appendToSoloConversation(
  database: Database,
  append: SoloAppend,
): Promise<{ channelId: string; threadId: string } | null> {
  const target = await soloChannelFor(database, append.userId, append.agentId);
  if (!target) return null;

  /*
   * One message, from the Bot, that says which routine spoke.
   *
   * Not two — the instruction is not something the person typed, and rendering it as their own
   * message would put words in their mouth every morning. The routine's name carries the "why is
   * this here" that the instruction would have carried.
   */
  const message = {
    id: randomUUID(),
    role: "assistant",
    // A heading alone when there is no body — a failure mark says which routine and nothing more.
    content: append.body
      ? `**${append.heading}**\n\n${append.body}`
      : `**${append.heading}**`,
    lafAt: append.at.toISOString(),
    // The Bot whose routine it was. A message it left unattributed would be a hole in a record the
    // transcript reads as complete.
    lafAgentId: append.agentId,
  } as StoredMessage;

  /*
   * APPENDED, NOT READ-MODIFIED-WRITTEN.
   *
   * A chat run can write this thread at the same instant — the person may be mid-turn with the
   * same Bot when its routine fires — and whichever wrote second used to erase the other's message.
   * `appendMessages` takes a per-thread lock and adds a row, so neither side can lose the other's
   * and neither has to know the other exists.
   */
  await appendMessages(database, target.threadId, [message], {
    at: append.at,
    ...(append.runId ? { runId: append.runId } : {}),
  });

  return target;
}

/**
 * Move the roster row for a message just appended, and announce it.
 *
 * The half a person actually notices. `lastMessageAgentId` being set is what makes the room count
 * as unread — an answer nobody has read yet is exactly the state the unread dot exists for, and so
 * is a routine that did not finish. Shared by the answer and the failure mark so the two cannot
 * disagree about what "unread" means.
 *
 * POSTGRES' CLOCK AND THE SAME FORWARD-ONLY GUARD THE OTHER WRITER USES.
 *
 * This is the second thing that writes `last_message_at`, and it was writing Bun's clock —
 * measured ~66 ms behind Postgres on this machine — with no ordering guard at all. A message a
 * person sent (stamped by `recordActivity` with Postgres `now()`) followed 50 ms later by a
 * delivery would be overwritten by a time EARLIER than itself, and `unread` is
 * `last_message_at > last_read_at`: the room could fail to go unread for the delivery and sort
 * below where it belongs. Same clock, same `lt` guard, so the two writers cannot disagree.
 */
async function moveRosterRow(
  database: Database,
  target: { channelId: string },
  moved: { agentId: string; preview: string; at: Date },
  announce?: AnnounceChannelActivity,
): Promise<void> {
  const [row] = await database
    .update(channels)
    .set({
      lastMessage: moved.preview,
      lastMessageAt: sql`now()`,
      lastMessageAgentId: moved.agentId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(channels.id, target.channelId),
        or(
          isNull(channels.lastMessageAt),
          lt(channels.lastMessageAt, sql`now()`),
        ),
      ),
    )
    .returning({
      name: channels.name,
      lastMessage: channels.lastMessage,
      lastMessageAt: channels.lastMessageAt,
    });
  /*
   * Nothing moved, which means something newer is already there. The message itself is in the
   * thread — it was appended before this, atomically — so the transcript has it and the roster row
   * is already showing something more recent. Announcing a stale preview would be the news going
   * backwards on every open tab.
   */
  if (!row) return;

  /*
   * And announced, the way a message typed into the room is (channels/routes.ts,
   * recordActivity): the same event to the same hub, so the roster row moves and the open
   * transcript picks the message up without anybody reloading. Without this the delivery was a
   * row in Postgres that the screen learned about from a four-second poll, or not at all.
   *
   * Nothing here is inside a transaction — the append and the roster update are each their own —
   * so the write above has committed by the time this line runs. See `channels/events.ts`.
   */
  const members = await database
    .select({ userId: channelMemberships.userId })
    .from(channelMemberships)
    .where(eq(channelMemberships.channelId, target.channelId));
  const event: ChannelActivityEvent = {
    channelId: target.channelId,
    memberIds: members.map((member) => member.userId),
    name: row.name,
    lastMessage: row.lastMessage,
    // The time that was WRITTEN, on the database's clock, not the one this process guessed.
    lastMessageAt: (row.lastMessageAt ?? moved.at).toISOString(),
    lastMessageAgentId: moved.agentId,
  };
  announce?.(event);
}

export function createRoutineDelivery(
  database: Database,
  /** Moves the roster row on every open tab. Absent in tests; the row is still written. */
  announce?: AnnounceChannelActivity,
) {
  return async (delivery: RoutineDelivery): Promise<void> => {
    // Nothing to report is nothing to deliver: no message, no preview, no bell. The run itself is
    // still recorded, and the audit row says it was silent — see `routines/service.ts`.
    if (isSilentAnswer(delivery.answer)) return;
    const target = await appendToSoloConversation(database, {
      agentId: delivery.agentId,
      userId: delivery.userId,
      // The routine's name, which is the "why is this here" the instruction would have carried.
      heading: delivery.routineName,
      body: delivery.answer,
      at: delivery.at,
    });
    if (!target) return;
    await moveRosterRow(
      database,
      target,
      {
        agentId: delivery.agentId,
        preview: previewOf(delivery.answer),
        at: delivery.at,
      },
      announce,
    );
  };
}

export type DeliverRoutineAnswer = ReturnType<typeof createRoutineDelivery>;

/** A routine's run that ended without an answer, to be marked where the answer would have gone. */
export type RoutineFailure = {
  agentId: string;
  userId: string;
  routineName: string;
  /** The ledger run that failed. What the transcript's failure line is keyed to. */
  runId: string;
  at: Date;
};

/**
 * A routine that did not finish, marked in the Bot's conversation the way its answer would have been.
 *
 * WHAT IT WRITES IS A NAME, AND WHAT THE PERSON READS IS A SENTENCE. The message is the routine's
 * heading alone — `**아침 브리핑**` — carrying the failed run's id; the transcript then draws the
 * red line under it from `GET /api/channels/:id/failures`, which reads the ledger row and says the
 * failure in the surface's own words. Nothing here is prose, and the sentence is not in the
 * transcript, so the model does not read its own obituary on the next turn (the rule in
 * `channels/turn-failures.ts`). What the model does read is that this routine spoke and said
 * nothing, which is true.
 *
 * Before this, a routine that hit its deadline at 07:30 left a red line in its own history behind
 * a disclosure on the Routines page, and the conversation the person actually opens showed nothing
 * — a briefing that simply did not come, indistinguishable from one that had nothing to say.
 *
 * Returns the conversation it marked, so the notification about it can point there. Null when the
 * Bot has no conversation with this person yet, for the same reason the answer's delivery says
 * null: a conversation is not a side effect of a failure.
 */
export function createRoutineFailureDelivery(
  database: Database,
  /**
   * Moves the roster row on every open tab. Not the answer's announce: that one also raises
   * `run.finished` for anybody not connected, and a failure is not a finish — its own row is
   * `run.failed`, raised from the audit trail (notifications/from-audit.ts).
   */
  announce?: AnnounceChannelActivity,
) {
  return async (
    failure: RoutineFailure,
  ): Promise<{ channelId: string; threadId: string } | null> => {
    const target = await appendToSoloConversation(database, {
      agentId: failure.agentId,
      userId: failure.userId,
      heading: failure.routineName,
      body: "",
      at: failure.at,
      runId: failure.runId,
    });
    if (!target) return null;
    await moveRosterRow(
      database,
      target,
      // The roster shows the routine's name; the red line is the transcript's to draw.
      {
        agentId: failure.agentId,
        preview: failure.routineName,
        at: failure.at,
      },
      announce,
    );
    return target;
  };
}

export type DeliverRoutineFailure = ReturnType<
  typeof createRoutineFailureDelivery
>;
