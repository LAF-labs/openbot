import type { Persona } from "@shared/persona";
import { BUSINESS_KINDS, type BusinessKindId } from "@shared/shop/catalogue";
import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { RequestRefusedError, requestOrRefusal } from "@/lib/refusals";
import { routineKeys, routineRequest } from "@/lib/routines/queries";

/**
 * 소식 on the wire, and what the page says (muse-shape plan §3.2, phase 7).
 *
 * The server answers posts and facts (`server/src/feed/`); every word the page draws is this
 * module's or the component's, through `t()`. The posts' own words are the Bot's, from the pages its
 * run opened — the same standing as its answers in the conversation.
 */

export type FeedSource = { title: string; url: string };

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
  routines: FeedRoutine[];
};

export const feedKeys = {
  all: ["feed"] as const,
  posts: ["feed", "posts"] as const,
  unseen: ["feed", "unseen"] as const,
};

/** The refusals the doors answer with, as the codes they send. */
export const FEED_REFUSALS: Readonly<Record<string, string>> = {
  "laf:feed_post_not_found": "That post is no longer there.",
};

const feedRequest = (path: string, init?: RequestInit) =>
  requestOrRefusal(path, init, FEED_REFUSALS);

export function feedQueryOptions() {
  return infiniteQueryOptions({
    queryKey: feedKeys.posts,
    initialPageParam: null as string | null,
    getNextPageParam: (last: FeedPage) => last.next,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    queryFn: async ({ pageParam }) =>
      (await feedRequest(
        `/api/feed${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
      )) as unknown as FeedPage,
  });
}

/**
 * The unseen count for the sidebar's row and the phone's tab. A minute's staleness, and read again
 * whenever the window comes forward: posts arrive at 06:30 and on 지금 만들기, never mid-sentence.
 */
export function feedUnseenQueryOptions() {
  return queryOptions({
    queryKey: feedKeys.unseen,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () =>
      Number((await feedRequest("/api/feed/unseen"))?.count ?? 0),
  });
}

export async function markFeedSeen(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await feedRequest("/api/feed/seen", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function likePost(id: string, liked: boolean) {
  return (await feedRequest(`/api/feed/${encodeURIComponent(id)}/like`, {
    method: "POST",
    body: JSON.stringify({ liked }),
  })) as { liked: boolean; hidden: boolean };
}

export async function hidePost(id: string, hidden: boolean) {
  return (await feedRequest(`/api/feed/${encodeURIComponent(id)}/hide`, {
    method: "POST",
    body: JSON.stringify({ hidden }),
  })) as { liked: boolean; hidden: boolean };
}

/**
 * WHAT 소식 LOOKS FOR, BY WHO THE PERSON SAID THEY ARE (plan §2.3's row) — defaults only. The
 * routine's instruction is the person's to read on Routines and to change by talking ("소식에 부동산
 * 뉴스도 넣어 줘"). The same for everyone past the first morning; a 사장님 gets the 학생's topics by
 * asking. English keys, walked by `app/tests/feed.test.ts`.
 */
export const FEED_TOPICS: Readonly<Record<Persona | "unknown", string[]>> = {
  owner: [
    "News about my line of business",
    "Changes to rules and support for small businesses",
  ],
  student: [
    "Exam and certificate dates",
    "Scholarships and competitions",
    "News in the field I study",
  ],
  worker: [
    "News about my industry",
    "Today's economy in three lines",
    "Tax season reminders such as year-end settlement",
  ],
  other: ["News about what I am interested in", "This week's weather"],
  unknown: ["News about what I am interested in", "This week's weather"],
};

/** The skill the instruction names: `tenant/laf/skills/feed.md`. */
export const FEED_SKILL = "소식";

/** When 소식 runs: early, so it is there before the day starts and before the 7:30 briefing. */
export const FEED_TIME = "06:30";

/** The topics this person starts with: the persona's, with a shop's own kind named. */
export function feedTopics(
  persona: Persona | null,
  shopKind: BusinessKindId | null | undefined,
): string[] {
  const topics = FEED_TOPICS[persona ?? "unknown"].map((topic) => t(topic));
  if (persona === "owner" && shopKind) {
    const kind = BUSINESS_KINDS.find((one) => one.id === shopKind);
    if (kind) topics[0] = `${topics[0]} (${t(kind.name)})`;
  }
  return topics;
}

/** The routine's instruction: the skill named, then one line per topic. The person reads it back. */
export function feedInstruction(topics: readonly string[]): string {
  return [
    t("Post today's updates the way the {skill} skill says, on these topics:", {
      skill: FEED_SKILL,
    }),
    ...topics.map((topic) => `- ${topic}`),
  ].join("\n");
}

/**
 * MAKE 소식: one press (plan D3), through the Routines door with `delivery: "feed"`. A Bot that
 * already has its 소식 answers `laf:routine_feed_exists`, which is not a failure: it is made.
 */
export async function makeFeedRoutine(
  queryClient: QueryClient,
  input: { agentId: string; topics: readonly string[]; timeZone: string },
): Promise<void> {
  try {
    await routineRequest("/api/routines", {
      method: "POST",
      body: JSON.stringify({
        agentId: input.agentId,
        name: t("Updates"),
        instruction: feedInstruction(input.topics),
        summary: t("Every morning at 6:30: {topics}", {
          topics: input.topics.join(", "),
        }),
        schedule: { kind: "daily", time: FEED_TIME, timeZone: input.timeZone },
        delivery: "feed",
      }),
    });
  } catch (caught) {
    if (
      !(caught instanceof RequestRefusedError) ||
      caught.code !== "laf:routine_feed_exists"
    ) {
      throw caught;
    }
  }
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: routineKeys.all }),
    queryClient.invalidateQueries({ queryKey: feedKeys.all }),
  ]);
}
