import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createFrameStore } from "../src/channels/frames";
import { createDatabase } from "../src/db/client";
import { lafThreadMessages } from "../src/db/schema";
import {
  appendMessages,
  messagesFor,
  type StoredMessage,
} from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * THE PICTURE LIVES ON THE RESULT'S ROW, AND THE ROW'S OWN WRITER CANNOT ERASE IT.
 *
 * Every run hands the whole history back, and a message that arrives changed is written over its row
 * (`appendMessages`). A picture kept in the message itself would be gone the next turn, because the
 * client never sends it back. So it is a column, and this is where that is held: kept, read, still
 * there after the row is rewritten, and never in what the thread reads out.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const frames = createFrameStore(database);

const threads: string[] = [];
const JPEG = `/9j/4AAQSkZJRgABAQ${"B".repeat(300)}`;

afterEach(async () => {
  const mine = threads.splice(0);
  if (mine.length > 0) {
    await database
      .delete(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, mine));
  }
});

afterAll(async () => {
  await database.$client.close();
});

/** A thread with one browser call and its result, as a run leaves it. */
async function threadWithACall() {
  const threadId = `test-frames-${randomUUID()}`;
  threads.push(threadId);
  const callId = `call-${randomUUID()}`;
  const call = {
    id: `assistant-${randomUUID()}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: callId,
        type: "function",
        function: {
          name: "computer_navigate",
          arguments: '{"url":"https://example.com"}',
        },
      },
    ],
  } as unknown as StoredMessage;
  const result = {
    id: `tool-${randomUUID()}`,
    role: "tool",
    toolCallId: callId,
    content: '{"ok":true,"url":"https://example.com/"}',
  } as unknown as StoredMessage;
  await appendMessages(database, threadId, [call, result]);
  return { threadId, callId, call, result };
}

describe("the last picture of a task", () => {
  test("is kept on the call's result and read back by the call's id", async () => {
    const { threadId, callId } = await threadWithACall();
    expect(await frames.frameFor(threadId, callId)).toBeNull();
    expect(await frames.keepFrame(threadId, callId, JPEG)).toBe(true);
    expect(await frames.frameFor(threadId, callId)).toBe(JPEG);
  });

  test("is listed by its call, and only in its own thread", async () => {
    const { threadId, callId } = await threadWithACall();
    const other = await threadWithACall();
    expect(await frames.framedCalls(threadId)).toEqual([]);
    await frames.keepFrame(threadId, callId, JPEG);
    expect(await frames.framedCalls(threadId)).toEqual([callId]);
    expect(await frames.framedCalls(other.threadId)).toEqual([]);
  });

  test("is not kept for a call the thread does not hold, nor in another thread", async () => {
    const { threadId, callId } = await threadWithACall();
    const other = await threadWithACall();
    expect(await frames.keepFrame(threadId, "no-such-call", JPEG)).toBe(false);
    // The same id asked of the wrong thread finds nothing: the thread is part of the address.
    expect(await frames.keepFrame(other.threadId, callId, JPEG)).toBe(false);
    expect(await frames.frameFor(other.threadId, callId)).toBeNull();
  });

  /*
   * A STEP STOPPED WHILE ITS WINDOW WAS MAKING IT: the call is in the thread, its result is only in
   * that window until the next turn (0.5.4 final QA: five 404s in the console per Stop). The door
   * tells that picture "early" from one for a call the thread does not hold.
   */
  test("knows a call the thread holds without its result from one it does not hold", async () => {
    const threadId = `test-frames-${randomUUID()}`;
    threads.push(threadId);
    const callId = `call-${randomUUID()}`;
    await appendMessages(database, threadId, [
      {
        id: `assistant-${randomUUID()}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: callId,
            type: "function",
            function: { name: "computer_click", arguments: "{}" },
          },
        ],
      } as unknown as StoredMessage,
    ]);
    const other = await threadWithACall();
    expect(await frames.keepFrame(threadId, callId, JPEG)).toBe(false);
    expect(await frames.holdsCall(threadId, callId)).toBe(true);
    expect(await frames.holdsCall(threadId, "no-such-call")).toBe(false);
    // The thread is part of the address here too.
    expect(await frames.holdsCall(other.threadId, callId)).toBe(false);
    expect(await frames.holdsCall(threadId, other.callId)).toBe(false);
  });

  test("survives the row being written over by the next run's copy", async () => {
    const { threadId, callId, result } = await threadWithACall();
    await frames.keepFrame(threadId, callId, JPEG);
    // A later copy that differs is written over the row in place; the picture is not in it.
    await appendMessages(database, threadId, [
      {
        ...result,
        content: '{"ok":true,"url":"https://example.com/after"}',
      } as StoredMessage,
    ]);
    const stored = await messagesFor(database, threadId);
    expect(
      stored.find((message) => message.id === result.id)?.content,
    ).toContain("/after");
    expect(await frames.frameFor(threadId, callId)).toBe(JPEG);
  });

  test("never rides along on what the thread reads out", async () => {
    const { threadId, callId } = await threadWithACall();
    await frames.keepFrame(threadId, callId, JPEG);
    const read = JSON.stringify(await messagesFor(database, threadId));
    expect(read).not.toContain(JPEG.slice(0, 40));
  });
});
