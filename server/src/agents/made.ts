/**
 * 만든 것: WHAT THE BOT MADE, READ OUT OF ITS CONVERSATION (`GET /api/agents/:agentId/made`).
 *
 * muse-shape plan §3.5, v1 (phase 6, 2026-09-27): no table. A card the Bot put on screen is already
 * a row — its call on the Bot's message in `laf_thread_messages`, with the title it gave the card as
 * an argument — and so is a table it wrote into an answer. This reads them, newest first, a page at
 * a time, and answers facts: which tool, the title the Bot wrote, when, and the transcript key to
 * jump to (a card's row is keyed by its call id, a written answer by its message id —
 * `app/src/components/channels/chat-messages.ts`). What counts and which shelf it goes on is
 * `shared/made.ts`.
 *
 * ONLY WHAT REACHED THE SCREEN. A card whose call was refused, threw, or never got its answer is not
 * something the person was shown, so it is not listed: its result must be the plain sentence a card
 * answers with, not a refusal's JSON or a thrown "Error: …".
 *
 * THE BOT'S OWN CONVERSATION WITH THIS PERSON, and nothing else: the thread is found by the person
 * and the Bot together (`soloConversationOf`), as every read in `day.ts` is scoped by both.
 *
 * MEASURED, not assumed (plan §3.5: "if it is slow, add an expression index, not a table"): on a
 * 520-message thread the page read is recorded in the phase's commit message.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  cardsOn,
  isMadeShelf,
  MADE_TABLE_PATTERN,
  MARKDOWN_TABLE,
  type MadeShelf,
  madeCardTitle,
  markdownTableTitles,
  shelfOf,
} from "../../../shared/made";
import type { AppVariables } from "../auth/guards";
import { soloConversationOf } from "../channels/solo-channel";
import type { Database } from "../db/client";
import { lafThreadMessages } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";

export type MadeItem = {
  /** A gallery card's name, or `markdownTable` for a table written into an answer. */
  tool: string;
  shelf: MadeShelf;
  /** What the Bot called it. Null for a card it gave no title. */
  title: string | null;
  at: string;
  channelId: string;
  /** The transcript row to jump to: the card's call id, or the answer's message id. */
  messageId: string;
};

export type MadePage = {
  items: MadeItem[];
  /** Pass back as `cursor` for the page before this one; null when there is none. */
  next: string | null;
};

/** Messages read per page. A message can hold several things, so a page can hold more items. */
export const MADE_PAGE_MESSAGES = 40;

export type MadeReader = (input: {
  userId: string;
  agentId: string;
  /** Only this shelf; null for everything. */
  shelf: MadeShelf | null;
  /** The `next` of the page before, or null for the newest. */
  cursor: string | null;
}) => Promise<MadePage>;

type Row = {
  seq: number;
  at: Date;
  id: string | null;
  text: string | null;
  calls: Array<{
    id?: unknown;
    name?: unknown;
    title?: unknown;
    /** A file card's file: what it is listed as, since it has no title (`madeCardTitle`). */
    path?: unknown;
  }> | null;
};

export function createMadeReader(options: { database: Database }): MadeReader {
  const { database } = options;
  return async ({ userId, agentId, shelf, cursor }) => {
    const conversation = await soloConversationOf(database, userId, agentId);
    if (!conversation) return { items: [], next: null };
    const before = cursor === null ? null : Number(cursor);
    const names = cardsOn(shelf);
    const wantsTables = shelf === null || shelf === "table";

    const message = lafThreadMessages.message;
    const calls = sql`jsonb_array_elements(case when jsonb_typeof(${message} -> 'toolCalls') = 'array' then ${message} -> 'toolCalls' else '[]'::jsonb end)`;
    const namesArray = sql`array[${sql.join(
      names.map((name) => sql`${name}`),
      sql`, `,
    )}]::text[]`;
    const isTable = sql`jsonb_typeof(${message} -> 'content') = 'string' and (${message} ->> 'content') ~ ${MADE_TABLE_PATTERN}`;
    const hasCard =
      names.length > 0
        ? sql`exists (select 1 from ${calls} as tc where tc -> 'function' ->> 'name' = any(${namesArray}))`
        : sql`false`;

    const rows = (await database
      .select({
        seq: lafThreadMessages.seq,
        at: lafThreadMessages.at,
        id: sql<string | null>`${message} ->> 'id'`,
        // The answer's words only when they hold a table: the titles are read from them here.
        text: wantsTables
          ? sql<
              string | null
            >`case when ${isTable} then ${message} ->> 'content' end`
          : sql<string | null>`null`,
        calls:
          names.length > 0
            ? sql<
                Row["calls"]
              >`(select jsonb_agg(jsonb_build_object('id', tc ->> 'id', 'name', tc -> 'function' ->> 'name', 'title', case when pg_input_is_valid(tc -> 'function' ->> 'arguments', 'jsonb') then (tc -> 'function' ->> 'arguments')::jsonb ->> 'title' end, 'path', case when pg_input_is_valid(tc -> 'function' ->> 'arguments', 'jsonb') then (tc -> 'function' ->> 'arguments')::jsonb ->> 'path' end)) from ${calls} as tc where tc -> 'function' ->> 'name' = any(${namesArray}))`
            : sql<Row["calls"]>`null`,
      })
      .from(lafThreadMessages)
      .where(
        and(
          eq(lafThreadMessages.threadId, conversation.threadId),
          sql`${message} ->> 'role' = 'assistant'`,
          before !== null && Number.isFinite(before)
            ? lt(lafThreadMessages.seq, before)
            : undefined,
          wantsTables ? sql`(${hasCard} or ${isTable})` : hasCard,
        ),
      )
      .orderBy(sql`${lafThreadMessages.seq} desc`)
      .limit(MADE_PAGE_MESSAGES)) as Row[];

    /*
     * Which of the cards reached the screen: their answers, read in one go. A card is answered by a
     * sentence (`shared/tools/gallery.ts`); a refusal is JSON and a thrown handler says "Error:".
     */
    const callIds = rows.flatMap((row) =>
      (row.calls ?? []).flatMap((call) =>
        typeof call.id === "string" ? [call.id] : [],
      ),
    );
    const shown = new Set<string>();
    if (callIds.length > 0) {
      const answers = await database
        .select({
          callId: sql<string>`${message} ->> 'toolCallId'`,
        })
        .from(lafThreadMessages)
        .where(
          and(
            eq(lafThreadMessages.threadId, conversation.threadId),
            inArray(sql`${message} ->> 'toolCallId'`, callIds),
            sql`jsonb_typeof(${message} -> 'content') = 'string'`,
            sql`left(ltrim(${message} ->> 'content'), 1) not in ('{', '[')`,
            sql`left(${message} ->> 'content', 6) <> 'Error:'`,
          ),
        );
      for (const answer of answers) shown.add(answer.callId);
    }

    const items: MadeItem[] = [];
    for (const row of rows) {
      const at = new Date(row.at).toISOString();
      // Newest first inside a message too: its last call was made last.
      const cards = [...(row.calls ?? [])].reverse();
      for (const call of cards) {
        const tool = typeof call.name === "string" ? call.name : "";
        const on = shelfOf(tool);
        if (!on || typeof call.id !== "string" || !shown.has(call.id)) continue;
        items.push({
          tool,
          shelf: on,
          title: madeCardTitle(tool, call),
          at,
          channelId: conversation.channelId,
          messageId: call.id,
        });
      }
      if (row.text && row.id) {
        for (const title of markdownTableTitles(row.text).reverse()) {
          items.push({
            tool: MARKDOWN_TABLE,
            shelf: "table",
            title,
            at,
            channelId: conversation.channelId,
            messageId: row.id,
          });
        }
      }
    }
    const last = rows.at(-1);
    return {
      items,
      next:
        rows.length === MADE_PAGE_MESSAGES && last ? String(last.seq) : null,
    };
  };
}

/** `GET /api/agents/:agentId/made?shelf=&cursor=`, mounted under `/api/agents` beside 오늘. */
export function createMadeRoutes(
  /** Whether this person may see this Bot at all: the profile store's own answer. */
  canSee: (actor: AppVariables["actor"], agentId: string) => Promise<boolean>,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  readMade: MadeReader,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/:agentId/made", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    const asked = context.req.query("shelf");
    const cursor = context.req.query("cursor");
    if (asked !== undefined && asked !== "" && !isMadeShelf(asked)) {
      return context.json(
        { error: "laf:made_shelf_unknown", code: "laf:made_shelf_unknown" },
        400,
      );
    }
    if (cursor !== undefined && cursor !== "" && !/^\d{1,18}$/.test(cursor)) {
      return context.json(
        { error: "laf:made_cursor_invalid", code: "laf:made_cursor_invalid" },
        400,
      );
    }
    try {
      if (!(await canSee(context.var.actor, agentId))) {
        return context.json(
          { error: "laf:agent_not_found", code: "laf:agent_not_found" },
          404,
        );
      }
      context.header("cache-control", "no-store");
      return context.json(
        await readMade({
          userId: context.var.actor.id,
          agentId,
          shelf: isMadeShelf(asked) ? asked : null,
          cursor: cursor ? cursor : null,
        }),
      );
    } catch (error) {
      log.error("bot_made_not_read", { reason: describeFailure(error) });
      return context.json(
        { error: "laf:made_unavailable", code: "laf:made_unavailable" },
        500,
      );
    }
  });
  return routes;
}
