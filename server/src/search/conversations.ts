/**
 * 통합검색: WHAT WAS SAID, IN EVERY CONVERSATION A PERSON HAS (`POST /api/search`).
 *
 * Record §3, piece 4-3 (2026-10-10). The main conversation and every project are one Bot's, and a
 * person who remembers a sentence does not remember which of them it was said in. This reads them
 * all at once: a person's messages and the Bot's answers that hold every word asked for, newest
 * first, a page at a time, each with the place to go to.
 *
 * WHOSE: the threads this person has (`channel_threads`), in channels they are still a member of
 * — the two joins `soloConversationOf` makes. Nothing else names a thread, so nothing else is read.
 *
 * WHAT: words, as the conversation drew them (`laf_message_text`, migration 0065). Never a tool's
 * result: a page the Bot read is not something anybody said, and what a person typed into a login
 * box was never a message at all. The role test is the index's own predicate, word for word —
 * that is what lets the plan use it.
 *
 * A POST, THOUGH IT CHANGES NOTHING. What a person searches for is content: a name, a diagnosis,
 * an amount. In a query string it would be in every access log between the window and here.
 *
 * FACTS, NOT SENTENCES. The answer says where and when and gives the words around the match; "메인
 * 대화" and "프로젝트" are the screen's to say. The main agent's search tool (record §3) will read
 * through `createConversationSearch` too; it is 4-4's, with the rest of what the Bot is told.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type SearchHit,
  type SearchPage,
  searchTerms,
} from "../../../shared/search";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  channelMemberships,
  channels,
  channelThreads,
  lafThreadMessages,
} from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";

/** Hits per page. */
export const SEARCH_PAGE = 30;
/** How much of a message a hit carries: about two lines of the results' column. */
export const SNIPPET_LENGTH = 160;
/** How much of that comes before the match, so the match is read with what led to it. */
const SNIPPET_LEAD = 40;

export type ConversationSearch = (input: {
  userId: string;
  terms: readonly string[];
  /** The `next` of the page before, or null for the newest. */
  cursor: SearchCursor | null;
}) => Promise<SearchPage>;

/** Where a page ended: the last row's own place in the order, to the microsecond it was written. */
export type SearchCursor = { at: string; threadId: string; seq: number };

const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)~([\w-]{1,80})~(\d{1,18})$/;

export function parseSearchCursor(raw: unknown): SearchCursor | null {
  if (typeof raw !== "string") return null;
  const found = CURSOR.exec(raw);
  if (!found) return null;
  const [, at, threadId, seq] = found;
  if (!at || !threadId || !seq || Number.isNaN(Date.parse(at))) return null;
  return { at, seq: Number(seq), threadId };
}

/**
 * A term as a LIKE pattern that means its own characters: `%` and `_` are what a person typed
 * ("50%"), not wildcards, and the backslash that says so is escaped first.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * The words around the first term found, on one line. Cut by characters and not by bytes or
 * UTF-16 halves: half an emoji is not text (`shared/sound-text.ts` is the same lesson).
 */
export function snippetOf(text: string, terms: readonly string[]): string {
  const line = [...text.replace(/\s+/gu, " ").trim()];
  const folded = line.map((character) => character.toLowerCase()).join("");
  let first = -1;
  for (const term of terms) {
    const found = folded.indexOf(term.toLowerCase());
    if (found !== -1 && (first === -1 || found < first)) first = found;
  }
  // `found` counts UTF-16 units of the folded line; the cut is made in characters.
  const lead = first <= 0 ? 0 : [...folded.slice(0, first)].length;
  const start =
    line.length <= SNIPPET_LENGTH ? 0 : Math.max(0, lead - SNIPPET_LEAD);
  const end = Math.min(line.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${line.slice(start, end).join("")}${
    end < line.length ? "…" : ""
  }`;
}

type Row = {
  threadId: string;
  seq: number;
  cursorAt: string;
  at: Date;
  saidAt: string | null;
  id: string | null;
  role: string | null;
  text: string | null;
  channelId: string;
  kind: string;
  channelName: string;
};

export function createConversationSearch(options: {
  database: Database;
}): ConversationSearch {
  const { database } = options;
  return async ({ userId, terms, cursor }) => {
    if (terms.length === 0) return { hits: [], next: null };
    const message = lafThreadMessages.message;
    const said = sql`laf_message_text(${message})`;
    const rows = (await database
      .select({
        threadId: lafThreadMessages.threadId,
        seq: lafThreadMessages.seq,
        // The row's own instant, whole: a JavaScript date drops the microseconds a cursor needs.
        cursorAt: sql<string>`to_char(${lafThreadMessages.at} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        at: lafThreadMessages.at,
        saidAt: sql<string | null>`${message} ->> 'lafAt'`,
        id: sql<string | null>`${message} ->> 'id'`,
        role: sql<string | null>`${message} ->> 'role'`,
        text: sql<string | null>`${said}`,
        channelId: channels.id,
        kind: channels.kind,
        channelName: channels.name,
      })
      .from(lafThreadMessages)
      .innerJoin(
        channelThreads,
        and(
          eq(channelThreads.threadId, lafThreadMessages.threadId),
          eq(channelThreads.userId, userId),
        ),
      )
      .innerJoin(
        channels,
        and(
          eq(channels.id, channelThreads.channelId),
          // A project being deleted is not read: its words are on their way out (`deleting.ts`).
          isNull(channels.deletingAt),
        ),
      )
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, userId),
        ),
      )
      .where(
        and(
          // The partial index's predicate, as the migration wrote it.
          sql`${message} ->> 'role' in ('user', 'assistant')`,
          ...terms.map(
            (term) => sql`${said} ilike ${likePattern(term)} escape '\\'`,
          ),
          cursor
            ? sql`(${lafThreadMessages.at}, ${lafThreadMessages.threadId}, ${lafThreadMessages.seq}) < (${cursor.at}::timestamptz, ${cursor.threadId}, ${cursor.seq})`
            : undefined,
        ),
      )
      .orderBy(
        sql`${lafThreadMessages.at} desc`,
        sql`${lafThreadMessages.threadId} desc`,
        sql`${lafThreadMessages.seq} desc`,
      )
      .limit(SEARCH_PAGE + 1)) as Row[];

    const page = rows.slice(0, SEARCH_PAGE);
    const hits: SearchHit[] = [];
    for (const row of page) {
      // A row with no id is on no screen: there is nowhere to go to.
      if (!row.id || !row.text) continue;
      if (row.role !== "user" && row.role !== "assistant") continue;
      const stamped =
        row.saidAt && !Number.isNaN(Date.parse(row.saidAt))
          ? new Date(row.saidAt)
          : new Date(row.at);
      hits.push({
        at: stamped.toISOString(),
        channelId: row.channelId,
        channelName: row.channelName,
        kind: row.kind,
        messageId: row.id,
        role: row.role,
        snippet: snippetOf(row.text, terms),
      });
    }
    const last = page.at(-1);
    return {
      hits,
      next:
        rows.length > SEARCH_PAGE && last
          ? `${last.cursorAt}~${last.threadId}~${last.seq}`
          : null,
    };
  };
}

/** `POST /api/search` `{ q, cursor? }`. */
export function createSearchRoutes(
  search: ConversationSearch,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/", requireUser, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const asked =
      body !== null && typeof body === "object"
        ? (body as { q?: unknown; cursor?: unknown })
        : {};
    const terms = searchTerms(asked.q);
    if (!terms) {
      return context.json(
        { error: "laf:search_query_invalid", code: "laf:search_query_invalid" },
        400,
      );
    }
    const hasCursor = asked.cursor !== undefined && asked.cursor !== null;
    const cursor = hasCursor ? parseSearchCursor(asked.cursor) : null;
    if (hasCursor && !cursor) {
      return context.json(
        {
          error: "laf:search_cursor_invalid",
          code: "laf:search_cursor_invalid",
        },
        400,
      );
    }
    try {
      context.header("cache-control", "no-store");
      return context.json(
        await search({ cursor, terms, userId: context.var.actor.id }),
      );
    } catch (error) {
      log.error("search_not_read", { reason: describeFailure(error) });
      return context.json(
        { error: "laf:search_unavailable", code: "laf:search_unavailable" },
        500,
      );
    }
  });
  return routes;
}
