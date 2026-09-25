/**
 * The last picture of a browsing task: kept once, on the message it belongs to, read by one route.
 *
 * A task the Bot did in its browser leaves a card in the conversation, and the card shows what the
 * browser looked like when the task ended — so that a person scrolling back sees what was done, and
 * a Bot that closed its page has not closed it out of sight. The surface takes one screenshot when
 * the task ends, shrinks it to a small JPEG and hands it here; it lands on the row of the result of
 * the task's last browser action, which is the row that says the task got that far.
 *
 * WHY THE SURFACE MAKES IT. The screenshot is a full-size PNG and this process has no image library;
 * the browser the person is looking at already decodes one a second. What arrives is a JPEG a few
 * tens of kilobytes long, and the checks below are what keep it one.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadMessages } from "../db/schema";

/**
 * The most a kept picture may be, as base64.
 *
 * The surface sends 400 pixels wide at quality 0.7, measured at 12–30 kB for ordinary pages. The cap
 * is three times the largest of those, so a busy page is never refused, and a megabyte of anything
 * is.
 */
export const FRAME_MAX_BASE64 = 96_000;

/** `FF D8 FF`, the start of every JPEG, as base64 writes it. */
const JPEG_START = "/9j/";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Whether this is a picture this store keeps: a base64 JPEG, and not a large one. */
export function isKeepableFrame(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= FRAME_MAX_BASE64 &&
    value.startsWith(JPEG_START) &&
    BASE64.test(value)
  );
}

/**
 * The row a tool call's result lives on.
 *
 * By the call's id, because that is what both ends know: the card is drawn from the call, and the
 * result message carries it as `toolCallId`. There is no index on it and none is needed — the thread
 * narrows the scan to one conversation, and this runs once per task, never per render.
 */
function resultOf(threadId: string, toolCallId: string) {
  return and(
    eq(lafThreadMessages.threadId, threadId),
    sql`${lafThreadMessages.message} ->> 'role' = 'tool'`,
    sql`${lafThreadMessages.message} ->> 'toolCallId' = ${toolCallId}`,
  );
}

export function createFrameStore(database: Database) {
  return {
    /** The kept picture as base64, or null when there is none. */
    async frameFor(threadId: string, toolCallId: string) {
      const [row] = await database
        .select({ frame: lafThreadMessages.frame })
        .from(lafThreadMessages)
        .where(
          and(
            resultOf(threadId, toolCallId),
            isNotNull(lafThreadMessages.frame),
          ),
        )
        .limit(1);
      return row?.frame ?? null;
    },

    /**
     * Which calls in the thread have a kept picture: the result rows with one, by their call.
     *
     * The ids and never the pictures, so a transcript learns which cards have one in a single read
     * instead of asking once per card and being told 404 by most (0.5.4 QA: a console of 404s).
     */
    async framedCalls(threadId: string): Promise<string[]> {
      const rows = await database
        .select({
          toolCallId: sql<
            string | null
          >`${lafThreadMessages.message} ->> 'toolCallId'`,
        })
        .from(lafThreadMessages)
        .where(
          and(
            eq(lafThreadMessages.threadId, threadId),
            sql`${lafThreadMessages.message} ->> 'role' = 'tool'`,
            isNotNull(lafThreadMessages.frame),
          ),
        );
      return rows.flatMap((row) => (row.toolCallId ? [row.toolCallId] : []));
    },

    /**
     * Keep a picture on a result. False when the thread holds no such result — yet: the result
     * arrives with the next run's input, and the surface asks again a moment later.
     *
     * Written over whatever was there: the surface writes one per task, when it sees the task end,
     * and if it ever writes twice the later picture is the later truth.
     */
    async keepFrame(threadId: string, toolCallId: string, frame: string) {
      const written = await database
        .update(lafThreadMessages)
        .set({ frame })
        .where(resultOf(threadId, toolCallId))
        .returning({ seq: lafThreadMessages.seq });
      return written.length > 0;
    },
  };
}
