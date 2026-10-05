import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { type FeedSource, feedUrlKey, urlsIn } from "../../../shared/feed";
import {
  FEED_REACTIONS_CARRIED,
  feedReactionsText,
} from "../../../shared/prompt/feed.ko";
import { toolResultText } from "../../../shared/prompt/tool-results.ko";
import {
  FEED_BODY_MAX,
  FEED_POST,
  FEED_POSTS_PER_RUN,
  FEED_SOURCES_MAX,
  FEED_TITLE_MAX,
  FEED_TOPIC_MAX,
} from "../../../shared/tools/feed-post";
import type { Database } from "../db/client";
import { lafFeedPosts } from "../db/schema";
import type { Executor } from "../runner/thread-store";
import type { ToolOutcome, UnattendedToolkit } from "../runner/unattended";

/**
 * 소식: A FEED RUN'S POSTS — offered, judged, held, and landed with the run's record (phase 7).
 *
 * THE TOOL IS OFFERED ONLY TO A ROUTINE WHOSE `delivery` IS `feed` (`withFeed`, from `run.ts`), the
 * rung `routine_note` is on (`shared/tools/feed-post.ts` writes down the rung skipped below it).
 *
 * EVERY SOURCE IS ONE THIS RUN'S TOOLS RETURNED. The wrapper reads every result the run's other
 * tools hand back — the page a navigation landed on, a search's links, a plugin's rows — and keeps
 * the addresses in them, by `feedUrlKey`. A post citing an address that is not among them is refused
 * in the same run (`laf:feed_source_unseen`), which is the judge the 지원사업 eval applies after
 * the fact (`evals/support-programs.ts`), moved to before the post exists: a post with a wrong fact
 * looks public (plan §5.4), and an address the model remembered is how one gets written.
 *
 * NOTHING REPEATS. A title, or a source, that a post of this Bot's already carried in the last
 * `REPEAT_WINDOW_DAYS` is refused (`laf:feed_repeat`) — the skill's watermark is the Bot's way of
 * not looking again; this is the guarantee that what it did find twice is not posted twice.
 *
 * NOTHING IS WRITTEN WHILE THE RUN IS OUT. Posts are held in memory and written by the settlement
 * in the transaction that writes the run's record (`settlement.ts`), and only for a run that
 * succeeded — the notepad's rule, for the notepad's reason.
 */

/** How far back a repeated title or source counts. A month of a daily feed. */
export const REPEAT_WINDOW_DAYS = 30;

export type StagedPost = {
  topic: string;
  title: string;
  body: string;
  sources: FeedSource[];
};

export type FeedDraft = {
  readonly routineId: string;
  readonly agentId: string;
  readonly userId: string;
  readonly posts: readonly StagedPost[];
  /** Every result another tool of this run returned, read for the addresses in it. */
  observe(name: string, args: Record<string, unknown>, outcome: unknown): void;
  /** One `feed_post` call, judged and held — or refused with the fact the run reads. */
  apply(args: Record<string, unknown>): ToolOutcome;
};

const titleKey = (title: string) =>
  title.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** What this Bot has posted lately: the titles and source keys a new post may not repeat. */
export async function recentPostKeys(
  database: Pick<Database, "select">,
  input: { userId: string; agentId: string; now: Date },
): Promise<{ titles: Set<string>; sources: Set<string> }> {
  const since = new Date(
    input.now.getTime() - REPEAT_WINDOW_DAYS * 24 * 60 * 60_000,
  );
  const rows = await database
    .select({ title: lafFeedPosts.title, sources: lafFeedPosts.sources })
    .from(lafFeedPosts)
    .where(
      and(
        eq(lafFeedPosts.userId, input.userId),
        eq(lafFeedPosts.agentId, input.agentId),
        gte(lafFeedPosts.createdAt, since),
      ),
    );
  const titles = new Set<string>();
  const sources = new Set<string>();
  for (const row of rows) {
    titles.add(titleKey(row.title));
    for (const source of Array.isArray(row.sources) ? row.sources : []) {
      const key = feedUrlKey(String(source?.url ?? ""));
      if (key) sources.add(key);
    }
  }
  return { titles, sources };
}

/**
 * Whether a tool's result is something the outside world said, and so may name a source.
 *
 * NOT EVERY RESULT (2026-09-27 code sprint). Every result used to be read for addresses, and some
 * results echo what the Bot itself sent: `routine_note`'s refusal names the key it was given, so
 * `delete` with a made-up article address as the key made that address "seen";
 * `computer_write_file` then `computer_read_file` did the same through the workspace. So the
 * browser counts only through the tools that read a page, the Bot's own tools never count, and a
 * connected service's answer (a portal search, a partner's lookup) counts as what that service said.
 * A place anything else names must be opened with `computer_navigate` before it is cited.
 */
const PAGE_READERS: ReadonlySet<string> = new Set([
  "computer_navigate",
  "computer_click",
  "computer_snapshot",
  "computer_read",
  "computer_scroll",
  "computer_switch_tab",
]);

/** The Bot's own tools: what they hand back is what the Bot wrote or what this deployment keeps. */
const OWN_TOOLS: ReadonlySet<string> = new Set([
  "routine_note",
  "skill_view",
  "now",
  "remember",
  "update_profile",
  "manage_routine",
  "tool_search",
  FEED_POST.name,
]);

export function countsAsSource(name: string): boolean {
  if (name.startsWith("computer_")) return PAGE_READERS.has(name);
  if (name.startsWith("mcp__goals__")) return false;
  return !OWN_TOOLS.has(name);
}

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const invalid = (field: string): ToolOutcome => ({
  ok: false,
  code: "laf:feed_post_invalid",
  field,
  reason: toolResultText("laf:feed_post_invalid"),
});

export function feedDraftOf(input: {
  routineId: string;
  agentId: string;
  userId: string;
  recent: { titles: Set<string>; sources: Set<string> };
}): FeedDraft {
  const seen = new Set<string>();
  const posts: StagedPost[] = [];

  const remember = (raw: string) => {
    const key = feedUrlKey(raw);
    if (key) seen.add(key);
  };

  return {
    routineId: input.routineId,
    agentId: input.agentId,
    userId: input.userId,
    posts,
    observe(name, args, outcome) {
      // Where a navigation was sent is a page this run opened, whatever its result says of it.
      if (name === "computer_navigate" && typeof args.url === "string") {
        const ok =
          outcome && typeof outcome === "object"
            ? (outcome as { ok?: unknown }).ok !== false
            : true;
        if (ok) remember(args.url);
      }
      // Only what a page said. A tool that hands back what the Bot itself wrote is no evidence.
      if (!countsAsSource(name)) return;
      const written =
        typeof outcome === "string" ? outcome : JSON.stringify(outcome ?? "");
      for (const url of urlsIn(written)) remember(url);
    },
    apply(args) {
      if (posts.length >= FEED_POSTS_PER_RUN) {
        return {
          ok: false,
          code: "laf:feed_full",
          reason: toolResultText("laf:feed_full"),
        };
      }
      const topic = text(args.topic);
      const title = text(args.title);
      const body = text(args.body);
      if (!topic || topic.length > FEED_TOPIC_MAX) return invalid("topic");
      if (!title || title.length > FEED_TITLE_MAX) return invalid("title");
      if (!body || body.length > FEED_BODY_MAX) return invalid("body");
      const given = Array.isArray(args.sources) ? args.sources : null;
      if (!given || given.length === 0 || given.length > FEED_SOURCES_MAX) {
        return invalid("sources");
      }
      const sources: FeedSource[] = [];
      for (const entry of given) {
        const one = entry && typeof entry === "object" ? entry : {};
        const url = text((one as { url?: unknown }).url);
        const name = text((one as { title?: unknown }).title);
        const key = feedUrlKey(url);
        if (!key || !name || name.length > FEED_TITLE_MAX) {
          return invalid("sources");
        }
        if (!seen.has(key)) {
          return {
            ok: false,
            code: "laf:feed_source_unseen",
            url,
            reason: toolResultText("laf:feed_source_unseen"),
          };
        }
        sources.push({ title: name, url });
      }
      const staged = [
        ...posts.map((post) => titleKey(post.title)),
        ...input.recent.titles,
      ];
      const stagedSources = new Set([
        ...input.recent.sources,
        ...posts.flatMap((post) =>
          post.sources.flatMap((source) => {
            const key = feedUrlKey(source.url);
            return key ? [key] : [];
          }),
        ),
      ]);
      if (
        staged.includes(titleKey(title)) ||
        sources.some((source) =>
          stagedSources.has(feedUrlKey(source.url) ?? ""),
        )
      ) {
        return {
          ok: false,
          code: "laf:feed_repeat",
          reason: toolResultText("laf:feed_repeat"),
        };
      }
      posts.push({ topic, title, body, sources });
      return {
        ok: true,
        posted: posts.length,
        remaining: FEED_POSTS_PER_RUN - posts.length,
        reason: toolResultText("laf:feed_staged"),
      };
    },
  };
}

/**
 * The run's tools, with `feed_post` beside them, and every other result read for its addresses.
 *
 * Here and nowhere else: a chat turn and every other routine are handed the toolkit without it.
 */
export function withFeed(
  toolkit: UnattendedToolkit,
  draft: FeedDraft,
): UnattendedToolkit {
  return {
    tools: [
      ...toolkit.tools,
      {
        name: FEED_POST.name,
        description: FEED_POST.description,
        parameters: FEED_POST.parameters,
      },
    ],
    execute: async (name, args, call) => {
      if (name === FEED_POST.name) return draft.apply(args);
      const outcome = await toolkit.execute(name, args, call);
      draft.observe(name, args, outcome);
      return outcome;
    },
  };
}

/** The held posts, written on the settlement's transaction. How many were written. */
export async function settleFeed(
  executor: Pick<Executor, "insert">,
  draft: FeedDraft,
  runId: string,
  at: Date,
): Promise<number> {
  if (draft.posts.length === 0) return 0;
  const written = await executor
    .insert(lafFeedPosts)
    .values(
      draft.posts.map((post, index) => ({
        id: `feed_${randomUUID()}`,
        userId: draft.userId,
        agentId: draft.agentId,
        routineId: draft.routineId,
        runId,
        topic: post.topic,
        title: post.title,
        body: post.body,
        sources: post.sources,
        // In the order they were posted, the first on top: a millisecond apart.
        createdAt: new Date(at.getTime() - index),
      })),
    )
    .returning({ id: lafFeedPosts.id });
  return written.length;
}

/**
 * What the person liked and hid lately, as the lines the next run's instruction carries. Empty when
 * they pressed nothing. The titles only: a title is what the person saw when they pressed.
 */
export async function reactionsFor(
  database: Pick<Database, "select">,
  input: { userId: string; agentId: string },
): Promise<string> {
  const read = (
    column: typeof lafFeedPosts.likedAt | typeof lafFeedPosts.hiddenAt,
  ) =>
    database
      .select({ title: lafFeedPosts.title })
      .from(lafFeedPosts)
      .where(
        and(
          eq(lafFeedPosts.userId, input.userId),
          eq(lafFeedPosts.agentId, input.agentId),
          isNotNull(column),
        ),
      )
      .orderBy(desc(column))
      .limit(FEED_REACTIONS_CARRIED);
  const [liked, hidden] = await Promise.all([
    read(lafFeedPosts.likedAt),
    read(lafFeedPosts.hiddenAt),
  ]);
  return feedReactionsText({
    liked: liked.map((row) => row.title),
    hidden: hidden.map((row) => row.title),
  });
}
