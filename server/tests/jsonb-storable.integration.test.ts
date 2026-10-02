import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { recordAuditEvent } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  channels,
  channelThreads,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import {
  appendMessages,
  messagesFor,
  type StoredMessage,
} from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * A STRING POSTGRES REFUSES MUST NOT TAKE THE TURN WITH IT.
 *
 * `jsonb` will not hold half of a character or a NUL, and a conversation's messages and the trail's
 * rows are `jsonb` filled mostly with what somebody else wrote. Until 2026-10-02 nothing stood
 * between the two: a connected service's answer cut at 20,000 characters through an emoji made
 * `appendMessages` throw, the turn engine caught it so as not to break the turn, and none of that
 * turn's rows were kept. Found by reading upstream OpenBot's fix for the cut itself (#525) and
 * asking what the broken string did HERE, which upstream's note does not say — against a running
 * database, because the refusal is the database's.
 *
 * The first two cases below throw without the door in `db/schema/json.ts`.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const HALF = "😀".charAt(0);
const threads: string[] = [];
const owners: { userId: string; channelId: string }[] = [];

afterEach(async () => {
  const mine = threads.splice(0);
  if (mine.length > 0) {
    await database
      .delete(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, mine));
  }
  const made = owners.splice(0);
  if (made.length > 0) {
    await database.delete(channels).where(
      inArray(
        channels.id,
        made.map((row) => row.channelId),
      ),
    );
    await database.delete(users).where(
      inArray(
        users.id,
        made.map((row) => row.userId),
      ),
    );
  }
});

afterAll(async () => {
  await database.$client.close();
});

/** A thread somebody owns, which is the only kind a read answers for. */
async function ownedThread(): Promise<string> {
  const threadId = `jsonb-storable-${randomUUID()}`;
  const userId = `jsonb-storable-user-${randomUUID()}`;
  const channelId = `jsonb-storable-channel-${randomUUID()}`;
  threads.push(threadId);
  owners.push({ userId, channelId });
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@laf.test`, name: "Store" });
  await database
    .insert(channels)
    .values({ id: channelId, name: "Store", description: "store" });
  await database.insert(channelThreads).values({ userId, channelId, threadId });
  return threadId;
}

const message = (id: string, more: Record<string, unknown>) =>
  ({ id, ...more }) as unknown as StoredMessage;

describe("a turn whose tool answered with text Postgres refuses", () => {
  test("is kept whole: half an emoji at the end of a cut result", async () => {
    const threadId = await ownedThread();
    const cut = `${"가".repeat(40)}${HALF}`;
    await appendMessages(database, threadId, [
      message("asked", { role: "user", content: "메일 읽어줘" }),
      message("called", {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "tool_call", arguments: "{}" },
          },
        ],
      }),
      message("answered", { role: "tool", toolCallId: "call-1", content: cut }),
      message("said", { role: "assistant", content: "메일은 이래요." }),
    ]);
    const stored = await messagesFor(database, threadId);
    // Every row of the turn, the Bot's answer included — not none of them.
    expect(stored.map((row) => row.id)).toEqual([
      "asked",
      "called",
      "answered",
      "said",
    ]);
    expect(stored[2]?.content).toBe(`${"가".repeat(40)}�`);
  });

  test("is kept whole: a NUL, as a file that is not text has", async () => {
    const threadId = await ownedThread();
    await appendMessages(database, threadId, [
      message("asked", { role: "user", content: "이 파일 읽어줘" }),
      message("answered", {
        role: "tool",
        toolCallId: "call-2",
        content: "PK\u0003\u0004\u0000\u0000binary",
      }),
    ]);
    const stored = await messagesFor(database, threadId);
    expect(stored.map((row) => row.id)).toEqual(["asked", "answered"]);
    expect(stored[1]?.content).toBe("PK\u0003\u0004��binary");
  });

  test("and appended again, the mended message is the one already there", async () => {
    const threadId = await ownedThread();
    const broken = message("answered", {
      role: "tool",
      toolCallId: "call-3",
      content: `결과 ${HALF}`,
    });
    const first = await appendMessages(database, threadId, [broken]);
    // What the function hands back is what the row holds.
    expect(first.at(-1)?.content).toBe("결과 �");
    // A run hands its whole history back on every append; the same broken message again is no edit.
    await appendMessages(database, threadId, [
      broken,
      message("next", { role: "assistant", content: "다음" }),
    ]);
    const stored = await messagesFor(database, threadId);
    expect(stored.map((row) => row.content)).toEqual(["결과 �", "다음"]);
  });
});

describe("a trail row about something with such a name", () => {
  test("is written, where it used to be refused before the action it describes", async () => {
    // Undeletable, like every row of the trail: marked as this file's, in a disposable database.
    const targetId = `jsonb-storable.integration.test.ts ${randomUUID()}`;
    await recordAuditEvent(
      {
        insert: async (event) => {
          await database.insert(auditEvents).values(event);
        },
      } as Parameters<typeof recordAuditEvent>[0],
      {
        eventType: "configuration.changed",
        targetType: "test",
        targetId,
        payload: {
          // An element's name cut at 200 characters through an emoji, as a snapshot used to cut it.
          element: { role: "link", name: `리뷰 보기 ${HALF}` },
          said: ["앞\u0000뒤"],
        },
      } as Parameters<typeof recordAuditEvent>[1],
    );
    const [row] = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, targetId));
    expect(row?.payload).toEqual({
      element: { role: "link", name: "리뷰 보기 �" },
      said: ["앞�뒤"],
    });
  });
});
