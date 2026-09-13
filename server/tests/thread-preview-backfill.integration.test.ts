import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelMemberships,
  channels,
  channelThreads,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * Migration 0038's backfill: each conversation's preview comes from that conversation.
 *
 * The preview moved from `channels` (one per room) to `channel_threads` (one per person in it),
 * because a room two people share showed each of them the other's last sentence — and a leaver's
 * last words stayed on the survivor's roster (audit A5-7). The first draft of the migration filled
 * the new column by copying the channel's old preview into every member's row, which writes exactly
 * that leak into the rows meant to end it. The statement that shipped reads each thread's own
 * newest thing said instead; this runs that statement, out of the migration file itself, over a
 * shared room and a solo conversation, inside a transaction that is rolled back — the statement
 * updates every row it can see, and the rest of the suite's rows are not this file's to touch.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const run = randomUUID().slice(0, 8);
const OWNER = `backfill-owner-${run}`;
const STAFF = `backfill-staff-${run}`;
const BOT = `agent_backfill_${run}`;
const ROOM = `channel_backfill_room_${run}`;
const SOLO = `channel_backfill_solo_${run}`;
const threads = {
  ownerRoom: `backfill-owner-room-${run}`,
  staffRoom: `backfill-staff-room-${run}`,
  ownerSolo: `backfill-owner-solo-${run}`,
};

/** The backfill, as the migration file has it. Found by what it does, so a reorder cannot hide it. */
function backfillStatement(): string {
  const file = readFileSync(
    join(import.meta.dir, "../drizzle/0038_thread_preview_fleet_outbox.sql"),
    "utf8",
  );
  const statement = file
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .find((part) => part.startsWith('UPDATE "channel_threads"'));
  if (!statement) throw new Error("0038 has no backfill statement");
  return statement.replace(/;\s*$/, "");
}

const said = (seq: number, message: Record<string, unknown>) => ({
  seq,
  message: { id: randomUUID(), ...message },
});

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, Object.values(threads)));
  await database.delete(channels).where(inArray(channels.id, [ROOM, SOLO]));
  await database.delete(agents).where(inArray(agents.id, [BOT]));
  await database.delete(users).where(inArray(users.id, [OWNER, STAFF]));
});

describe("the 0038 roster preview backfill", () => {
  test("gives every person the last thing said in their own conversation, and nobody else's", async () => {
    await database.insert(users).values([
      { id: OWNER, email: `${OWNER}@laf.test`, name: "Owner" },
      { id: STAFF, email: `${STAFF}@laf.test`, name: "Staff" },
    ]);
    await database.insert(agents).values({
      id: BOT,
      name: "Bot",
      type: "remote_ag_ui",
      configuration: {},
    });
    await database.insert(channels).values([
      { id: ROOM, name: "Room", description: "shared" },
      { id: SOLO, name: "Solo", description: "one person" },
    ]);
    await database.insert(channelMemberships).values([
      { channelId: ROOM, userId: OWNER },
      { channelId: ROOM, userId: STAFF },
      { channelId: SOLO, userId: OWNER },
    ]);
    await database.insert(channelThreads).values([
      { channelId: ROOM, userId: OWNER, threadId: threads.ownerRoom },
      { channelId: ROOM, userId: STAFF, threadId: threads.staffRoom },
      { channelId: SOLO, userId: OWNER, threadId: threads.ownerSolo },
    ]);
    const at = (minute: number) =>
      `2026-09-01T07:${String(minute).padStart(2, "0")}:00.000Z`;
    const rows = [
      // The owner's side of the room: their own words last.
      [
        threads.ownerRoom,
        said(1, {
          role: "assistant",
          content: "네, 확인했습니다.",
          lafAt: at(1),
          lafAgentId: BOT,
        }),
      ],
      [
        threads.ownerRoom,
        said(2, {
          role: "user",
          content: "사장님만 아는 매출 12,400,000원",
          lafAt: at(9),
        }),
      ],
      // The staff member's side: the Bot's answer last, then a tool result that is not a thing said.
      [
        threads.staffRoom,
        said(1, { role: "user", content: "재고 알려줘", lafAt: at(2) }),
      ],
      [
        threads.staffRoom,
        said(2, {
          role: "assistant",
          content: "**재고** 3종 남음",
          lafAt: at(3),
          lafAgentId: BOT,
        }),
      ],
      [
        threads.staffRoom,
        said(3, { role: "tool", content: '{"rows":3}', toolCallId: "t1" }),
      ],
      // A routine's delivery into the owner's own conversation with the Bot.
      [
        threads.ownerSolo,
        said(1, {
          role: "assistant",
          content: "**아침 보고**\n\n오늘 할 일: 재고 확인",
          lafAt: at(30),
          lafAgentId: BOT,
        }),
      ],
    ] as const;
    for (const [threadId, row] of rows) {
      await database.insert(lafThreadMessages).values({
        threadId,
        seq: row.seq,
        message: row.message,
        at: new Date(at(59)),
      });
    }

    type Preview = {
      threadId: string;
      lastMessage: string | null;
      lastMessageAt: Date | null;
      lastMessageAgentId: string | null;
    };
    let previews: Preview[] = [];
    await database
      .transaction(async (transaction) => {
        await transaction.execute(sql.raw(backfillStatement()));
        previews = await transaction
          .select({
            threadId: channelThreads.threadId,
            lastMessage: channelThreads.lastMessage,
            lastMessageAt: channelThreads.lastMessageAt,
            lastMessageAgentId: channelThreads.lastMessageAgentId,
          })
          .from(channelThreads)
          .where(inArray(channelThreads.threadId, Object.values(threads)));
        // Everything the statement touched outside this file goes back the way it was.
        transaction.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });

    const byThread = Object.fromEntries(
      previews.map((row) => [row.threadId, row]),
    );
    expect(byThread[threads.staffRoom]).toEqual({
      threadId: threads.staffRoom,
      lastMessage: "재고 3종 남음",
      lastMessageAt: new Date(at(3)),
      lastMessageAgentId: BOT,
    });
    // The owner's sentence is on the owner's row and on no one else's.
    expect(byThread[threads.ownerRoom]).toEqual({
      threadId: threads.ownerRoom,
      lastMessage: "사장님만 아는 매출 12,400,000원",
      lastMessageAt: new Date(at(9)),
      lastMessageAgentId: null,
    });
    expect(JSON.stringify(byThread[threads.staffRoom])).not.toContain("매출");
    expect(byThread[threads.ownerSolo]).toEqual({
      threadId: threads.ownerSolo,
      lastMessage: "아침 보고 오늘 할 일: 재고 확인",
      lastMessageAt: new Date(at(30)),
      lastMessageAgentId: BOT,
    });
  });
});
