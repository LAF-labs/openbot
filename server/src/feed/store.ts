import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { type FeedSource, lafFeedPosts, lafRoutines } from "../db/schema";

/**
 * 소식's reads and the person's three presses (muse-shape plan §3.2, phase 7).
 *
 * Every read and write is the person's own posts: scoped by `user_id`, whatever id arrived. A post
 * that is not theirs is not found — the same answer as one that does not exist.
 */

export type FeedPost = {
  id: string;
  agentId: string;
  routineId: string | null;
  topic: string;
  title: string;
  body: string;
  sources: FeedSource[];
  createdAt: string;
  seen: boolean;
  liked: boolean;
};

export type FeedRoutine = {
  id: string;
  agentId: string;
  name: string;
  summary: string | null;
  instruction: string;
  enabled: boolean;
  pausedReason: string | null;
  nextRunAt: string;
  dailyLocal: string | null;
  dailyTimeZone: string | null;
};

export type FeedPage = {
  posts: FeedPost[];
  next: string | null;
  unseen: number;
  /** The person's 소식 routines — one per Bot — for the page's first card. */
  routines: FeedRoutine[];
};

export const FEED_PAGE_SIZE = 20;

/** A cursor: the last post's time and id, so two posts of one instant are not skipped or repeated. */
function parseCursor(cursor: string | null): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split("|");
  const when = new Date(at ?? "");
  if (!id || Number.isNaN(when.getTime())) return null;
  return { at: when, id };
}

export class FeedPostNotFound extends Error {
  readonly code = "laf:feed_post_not_found";
  constructor() {
    super("No such post.");
  }
}

export type FeedStore = ReturnType<typeof createFeedStore>;

export function createFeedStore(options: {
  database: Database;
  now?: () => Date;
}) {
  const { database } = options;
  const now = options.now ?? (() => new Date());

  const unseen = async (userId: string) => {
    const [row] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(lafFeedPosts)
      .where(
        and(
          eq(lafFeedPosts.userId, userId),
          isNull(lafFeedPosts.seenAt),
          isNull(lafFeedPosts.hiddenAt),
        ),
      );
    return Number(row?.count ?? 0);
  };

  /** The post, if it is this person's; the press changes it; its new state comes back. */
  const press = async (
    userId: string,
    id: string,
    set: Partial<Record<"likedAt" | "hiddenAt", Date | null>>,
  ) => {
    const [row] = await database
      .update(lafFeedPosts)
      .set(set)
      .where(and(eq(lafFeedPosts.id, id), eq(lafFeedPosts.userId, userId)))
      .returning({
        likedAt: lafFeedPosts.likedAt,
        hiddenAt: lafFeedPosts.hiddenAt,
      });
    if (!row) throw new FeedPostNotFound();
    return { liked: row.likedAt !== null, hidden: row.hiddenAt !== null };
  };

  return {
    async page(userId: string, cursor: string | null): Promise<FeedPage> {
      const after = parseCursor(cursor);
      const rows = await database
        .select()
        .from(lafFeedPosts)
        .where(
          and(
            eq(lafFeedPosts.userId, userId),
            isNull(lafFeedPosts.hiddenAt),
            after
              ? or(
                  lt(lafFeedPosts.createdAt, after.at),
                  and(
                    eq(lafFeedPosts.createdAt, after.at),
                    lt(lafFeedPosts.id, after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(lafFeedPosts.createdAt), desc(lafFeedPosts.id))
        .limit(FEED_PAGE_SIZE + 1);
      const shown = rows.slice(0, FEED_PAGE_SIZE);
      const last = shown.at(-1);
      const routines = await database
        .select({
          id: lafRoutines.id,
          agentId: lafRoutines.agentId,
          name: lafRoutines.name,
          summary: lafRoutines.summary,
          instruction: lafRoutines.instruction,
          enabled: lafRoutines.enabled,
          pausedReason: lafRoutines.pausedReason,
          nextRunAt: lafRoutines.nextRunAt,
          dailyLocal: lafRoutines.dailyLocal,
          dailyTimeZone: lafRoutines.dailyTimeZone,
        })
        .from(lafRoutines)
        .where(
          and(
            eq(lafRoutines.createdById, userId),
            eq(lafRoutines.delivery, "feed"),
          ),
        );
      return {
        posts: shown.map((row) => ({
          id: row.id,
          agentId: row.agentId,
          routineId: row.routineId,
          topic: row.topic,
          title: row.title,
          body: row.body,
          sources: Array.isArray(row.sources) ? row.sources : [],
          createdAt: row.createdAt.toISOString(),
          seen: row.seenAt !== null,
          liked: row.likedAt !== null,
        })),
        next:
          rows.length > FEED_PAGE_SIZE && last
            ? `${last.createdAt.toISOString()}|${last.id}`
            : null,
        unseen: await unseen(userId),
        routines: routines.map((routine) => ({
          ...routine,
          nextRunAt: routine.nextRunAt.toISOString(),
        })),
      };
    },
    unseen,
    /** 좋아요, on or off. */
    like: async (userId: string, id: string, liked: boolean) =>
      press(userId, id, { likedAt: liked ? now() : null }),
    /** 숨기기, or its undo. A hidden post is seen: it no longer counts as unread. */
    hide: async (userId: string, id: string, hidden: boolean) =>
      press(userId, id, { hiddenAt: hidden ? now() : null }),
    /** 소식 showed these. Only the person's own, and only ones not seen before. */
    async seen(userId: string, ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const marked = await database
        .update(lafFeedPosts)
        .set({ seenAt: now() })
        .where(
          and(
            eq(lafFeedPosts.userId, userId),
            inArray(lafFeedPosts.id, [...ids]),
            isNull(lafFeedPosts.seenAt),
          ),
        )
        .returning({ id: lafFeedPosts.id });
      return marked.length;
    },
    /** One post by id for the model, when this Bot wrote it (`quote.ts`). */
    async forQuote(agentId: string, id: string) {
      const [row] = await database
        .select({
          topic: lafFeedPosts.topic,
          title: lafFeedPosts.title,
          body: lafFeedPosts.body,
          sources: lafFeedPosts.sources,
          createdAt: lafFeedPosts.createdAt,
        })
        .from(lafFeedPosts)
        .where(and(eq(lafFeedPosts.id, id), eq(lafFeedPosts.agentId, agentId)));
      return row
        ? { ...row, sources: Array.isArray(row.sources) ? row.sources : [] }
        : null;
    },
  };
}
