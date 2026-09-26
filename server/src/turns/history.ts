/**
 * A conversation's history, a page at a time (G2 in `~/laf/docs/muse-2.2-architecture-teardown.md`).
 *
 * One Bot per person means one conversation that only ever grows, and opening it used to download
 * all of it — every message since the first day, after the join, one request after the other. A
 * window now opens on the newest page and asks for the one before it as the person scrolls up, by
 * the thread store's own `seq`: the durable cursor, which never changes for a message once written.
 *
 * A PAGE NEVER STARTS ON A RESULT. A tool's result read without the call it answers draws as nothing
 * and looks like a gap; the page reaches back past results to the message that asked for them.
 */
import type { Message } from "@ag-ui/client";
import { and, desc, eq, lt } from "drizzle-orm";
import { lafThreadMessages } from "../db/schema";
import { redactSecretTyping } from "../runner/secret-redaction";
import {
  type Executor,
  parseMessage,
  type StoredMessage,
} from "../runner/thread-store";

/** Muse's page, and a screen and a half of an ordinary conversation. */
export const HISTORY_PAGE = 80;

/** The most a window may ask for in one page. */
export const HISTORY_PAGE_MAX = 200;

/** How far a page reaches back past results for the call they answer. */
const REACH_BACK = 40;

export type HistoryPage = {
  /** Oldest first, as the transcript draws them. */
  messages: Message[];
  /** When each was first seen, where the store knows. */
  times: Record<string, string>;
  /** Each message's durable cursor, so a window that lets go of old ones knows where to ask again. */
  seqs: Record<string, number>;
  /** The durable cursor of the oldest message here; ask for `before` it for the page above. */
  oldestSeq: number | null;
  newestSeq: number | null;
  hasOlder: boolean;
};

/** A stored message as a window is handed it: AG-UI's fields, none of the store's own. */
function forTheWindow(message: StoredMessage): Message {
  const {
    lafAt: _at,
    lafAgentId: _by,
    lafRedacted: _redacted,
    // The Bot's reasoning rides its message for the next run; no window draws it.
    encryptedValue: _reasoning,
    ...rest
  } = message as StoredMessage & { encryptedValue?: unknown };
  return rest as Message;
}

export async function historyPage(
  database: Executor,
  threadId: string,
  options: { before?: number | null; limit?: number } = {},
): Promise<HistoryPage> {
  const limit = Math.max(
    1,
    Math.min(options.limit ?? HISTORY_PAGE, HISTORY_PAGE_MAX),
  );
  const rows = await database
    .select({ seq: lafThreadMessages.seq, message: lafThreadMessages.message })
    .from(lafThreadMessages)
    .where(
      options.before !== null && options.before !== undefined
        ? and(
            eq(lafThreadMessages.threadId, threadId),
            lt(lafThreadMessages.seq, options.before),
          )
        : eq(lafThreadMessages.threadId, threadId),
    )
    .orderBy(desc(lafThreadMessages.seq))
    .limit(limit + REACH_BACK + 1);

  const parsed = rows.flatMap((row) => {
    const message = parseMessage(row.message);
    return message ? [{ seq: row.seq, message }] : [];
  });
  // Newest first here: keep the page, then reach past any results at its top for their call.
  let take = Math.min(limit, parsed.length);
  while (take < parsed.length && parsed[take - 1]?.message.role === "tool") {
    take += 1;
  }
  const page = parsed.slice(0, take).reverse();
  // More was read than kept, or the read itself stopped at its limit with older rows beyond it.
  const hasOlder =
    parsed.length > take || rows.length === limit + REACH_BACK + 1;

  const stored = page.map((entry) => entry.message);
  const redacted = redactSecretTyping(stored, stored);
  const times: Record<string, string> = {};
  for (const message of redacted) {
    if (typeof message.lafAt === "string") times[message.id] = message.lafAt;
  }
  const seqs: Record<string, number> = {};
  for (const entry of page) seqs[entry.message.id] = entry.seq;
  return {
    messages: redacted.map(forTheWindow),
    times,
    seqs,
    oldestSeq: page[0]?.seq ?? null,
    newestSeq: page.at(-1)?.seq ?? null,
    hasOlder,
  };
}
