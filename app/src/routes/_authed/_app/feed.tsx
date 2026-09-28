import { feedQuotePart } from "@shared/feed";
import { effectivePersona } from "@shared/persona";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BotDay } from "@/components/app-sidebar/bot-day";
import { FeedTour } from "@/components/feed/feed-tour";
import { FeedPostCard } from "@/components/feed/feed-post-card";
import { LiveRegion } from "@/components/layout/live-region";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { editInChatHref } from "@/components/routines/edit-in-chat";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type FeedPage,
  type FeedPost,
  type FeedRoutine,
  feedKeys,
  feedQueryOptions,
  feedTopics,
  hidePost,
  likePost,
  makeFeedRoutine,
  markFeedSeen,
} from "@/lib/feed/queries";
import { offerFeedQuote } from "@/lib/feed/quote-offer";
import { t } from "@/lib/i18n";
import { COMPOSE_SCREEN_KEY } from "@/components/channels/composer/prefill";
import { failureSentence } from "@/lib/press";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { routineRequest, whenLabel } from "@/lib/routines/queries";
import { useNow } from "@/lib/use-now";

/**
 * 소식 — WHAT THE BOT DID TODAY, AND WHAT IT FOUND (muse-shape plan §3.2, phases 3 and 7).
 *
 * 오늘 on top, as it has been since phase 3 (`bot-day.tsx`): what waits on the person, what the Bot
 * did, what comes next. Under it the posts a 소식 routine wrote — at most three a morning, each from
 * pages its run opened (`server/src/routines/feed.ts`) — with 좋아요, 숨기기 and 이야기하기.
 *
 * MADE BY ONE PRESS, NEVER BY DEFAULT (plan D3). Before there is a 소식 routine the page says what
 * would come here and offers the one button; the 7:30 chip on a first conversation makes it too.
 * After, the first card is the routine itself — when it runs next, what it looks for, 지금 만들기 and
 * 대화에서 바꾸기 — so what it looks for is changed by talking, not by a form.
 *
 * SEEN IS WHAT THIS PAGE SHOWED. Posts drawn here are marked seen once they load, which is what the
 * sidebar's count and the unread pause read; the ones that were new keep their dot for this visit.
 */
export const Route = createFileRoute("/_authed/_app/feed")({
  component: FeedPageScreen,
});

function FeedPageScreen() {
  const mine = useMyBots();
  const bots = mine.bots ?? [];
  const isSeveral = bots.length > 1;
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;

  return (
    <PageShell
      description={t(
        "What your Bot did today, what is waiting on you, and what it found for you.",
      )}
      title={t("Updates")}
    >
      {mine.bots === undefined && !mine.isError ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : null}
      {bots.map((one) => (
        <PageSection key={one.id} title={isSeveral ? one.name : t("Today")}>
          <div className="rounded-xl border border-border">
            <BotDay
              botId={one.id}
              empty={
                <p className="px-4 py-6 text-muted-foreground text-sm">
                  {t(
                    "Nothing yet today. What you hand over in the conversation shows up here.",
                  )}
                </p>
              }
              placement="drawer"
            />
          </div>
        </PageSection>
      ))}
      {bot ? (
        <PageSection title={t("What it found")}>
          <FeedPosts
            agentId={bot.id}
            channelId={conversationOf(bot.id, channels.data)?.id}
          />
        </PageSection>
      ) : null}
    </PageShell>
  );
}

function FeedPosts({
  agentId,
  channelId,
}: {
  agentId: string;
  channelId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const feed = useInfiniteQuery(feedQueryOptions());
  const reading = useReading(feed);
  const settled = settledOf(reading);
  const pages = settled?.data.pages ?? [];
  const posts = pages.flatMap((page) => page.posts);
  const routines = pages[0]?.routines ?? [];
  const routine = routines.find((one) => one.agentId === agentId) ?? null;
  const [problem, setProblem] = useState<string | null>(null);
  /** The posts that were new when this visit loaded them: their dot stays until the page is left. */
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());

  const unseenIds = posts.filter((post) => !post.seen).map((post) => post.id);
  const unseenKey = unseenIds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ids, not the array made each render.
  useEffect(() => {
    if (unseenIds.length === 0) return;
    setNewIds((before) => new Set([...before, ...unseenIds]));
    void markFeedSeen(unseenIds)
      .then(() => {
        queryClient.setQueryData<{ pages: FeedPage[]; pageParams: unknown[] }>(
          feedKeys.posts,
          (current) =>
            current
              ? {
                  ...current,
                  pages: current.pages.map((page) => ({
                    ...page,
                    unseen: 0,
                    posts: page.posts.map((post) => ({ ...post, seen: true })),
                  })),
                }
              : current,
        );
        return queryClient.invalidateQueries({ queryKey: feedKeys.unseen });
      })
      .catch(() => {
        // Marked on the next visit instead; the count stays up a little longer.
      });
  }, [unseenKey, queryClient]);

  /** One post changed in the cache, at once — the press is the person's decision. */
  const patch = (id: string, change: (post: FeedPost) => FeedPost | null) =>
    queryClient.setQueryData<{ pages: FeedPage[]; pageParams: unknown[] }>(
      feedKeys.posts,
      (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                posts: page.posts.flatMap((post) => {
                  if (post.id !== id) return [post];
                  const next = change(post);
                  return next ? [next] : [];
                }),
              })),
            }
          : current,
    );

  const handleLike = async (post: FeedPost) => {
    setProblem(null);
    patch(post.id, (current) => ({ ...current, liked: !post.liked }));
    await likePost(post.id, !post.liked).catch((caught: unknown) => {
      patch(post.id, (current) => ({ ...current, liked: post.liked }));
      setProblem(failureSentence(caught));
    });
  };

  const [hidden, setHidden] = useState<FeedPost | null>(null);
  const handleHide = async (post: FeedPost) => {
    setProblem(null);
    patch(post.id, () => null);
    setHidden(post);
    await hidePost(post.id, true).catch((caught: unknown) => {
      setHidden(null);
      void feed.refetch();
      setProblem(failureSentence(caught));
    });
  };
  const handleUnhide = async () => {
    if (!hidden) return;
    const post = hidden;
    setHidden(null);
    await hidePost(post.id, false)
      .then(() => feed.refetch())
      .catch((caught: unknown) => setProblem(failureSentence(caught)));
  };

  /** 이야기하기: the post, by its id, waiting in the conversation's box. Nothing is sent. */
  const handleDiscuss = (post: FeedPost) => {
    const part = feedQuotePart(post);
    if (channelId) {
      offerFeedQuote(channelId, part);
      void navigate({ params: { channelId }, to: "/channel/$channelId" });
      return;
    }
    offerFeedQuote(COMPOSE_SCREEN_KEY, part);
    void navigate({ search: { agent: agentId }, to: "/channel/new" });
  };

  return (
    <div className="flex flex-col gap-3">
      <ReadNotice
        line={readLineOf(reading, {
          failed: t("Updates could not be loaded."),
          notHere: t("This deployment does not post updates."),
        })}
        onRetry={() => void feed.refetch()}
      />
      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {problem}
      </LiveRegion>
      {reading.state === "loading" ? (
        <Skeleton className="h-28 rounded-xl" />
      ) : null}
      {settled ? (
        routine ? (
          <RoutineCard channelId={channelId} routine={routine} />
        ) : (
          <MakeFeed agentId={agentId} />
        )
      ) : null}
      {hidden ? (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          {t("Hidden. The next updates will pick fewer like it.")}
          <button
            className="font-medium text-link underline-offset-4 hover:underline"
            onClick={() => void handleUnhide()}
            type="button"
          >
            {t("Undo")}
          </button>
        </p>
      ) : null}
      {settled && routine && posts.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-feed-empty>
          {t(
            "Nothing posted yet. The first updates come at the next run, or press Make now.",
          )}
        </p>
      ) : null}
      {settled && posts.length === 0 ? <FeedTour /> : null}
      {posts.map((post) => (
        <FeedPostCard
          isNew={newIds.has(post.id)}
          key={post.id}
          onDiscuss={() => handleDiscuss(post)}
          onHide={() => void handleHide(post)}
          onLike={() => void handleLike(post)}
          post={post}
          routineName={
            routines.find((one) => one.id === post.routineId)?.name ?? null
          }
        />
      ))}
      {feed.hasNextPage ? (
        <Button
          className="self-center"
          disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}
          variant="outline"
        >
          {feed.isFetchingNextPage ? t("Loading…") : t("Show older")}
        </Button>
      ) : null}
    </div>
  );
}

/** The 소식 routine: when it runs next, what it looks for, and the two presses on it. */
function RoutineCard({
  channelId,
  routine,
}: {
  channelId: string | undefined;
  routine: FeedRoutine;
}) {
  const queryClient = useQueryClient();
  const now = useNow();
  const runNow = useMutation({
    mutationFn: () =>
      routineRequest(`/api/routines/${routine.id}/run`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedKeys.all }),
  });
  const topics = routine.instruction
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-muted/40 p-4"
      data-feed-routine
    >
      <p className="font-medium text-sm">
        {routine.enabled
          ? t("Next updates: {when}", {
              when: whenLabel(routine.nextRunAt, now),
            })
          : routine.pausedReason === "unread"
            ? t("Paused: updates piled up unseen for a week.")
            : t("Paused.")}
      </p>
      {topics.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("Looks for: {topics}", { topics: topics.join(", ") })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-feed-run
          disabled={runNow.isPending}
          onClick={() => runNow.mutate()}
          size="sm"
        >
          {/* The run is answered when it has finished — a minute or two — and the posts come with it. */}
          {runNow.isPending
            ? t("Making them — they appear here in a few minutes")
            : t("Make now")}
        </Button>
        {channelId ? (
          <a
            className={buttonVariants({ size: "sm", variant: "outline" })}
            href={editInChatHref(channelId, routine.name)}
          >
            {t("Change in the conversation")}
          </a>
        ) : null}
        {!routine.enabled ? (
          <Link
            className={buttonVariants({ size: "sm", variant: "ghost" })}
            to="/routines"
          >
            {t("Turn it back on in Routines")}
          </Link>
        ) : null}
      </div>
      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {runNow.isError ? failureSentence(runNow.error) : null}
      </LiveRegion>
    </div>
  );
}

/** Before 소식 exists: what would come here, and the one press that makes it (plan D3). */
function MakeFeed({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const { data: user } = useQuery(currentUserQueryOptions());
  const persona = effectivePersona(user?.persona, user?.shop);
  const topics = feedTopics(persona, user?.shop?.kind);
  const make = useMutation({
    mutationFn: () =>
      makeFeedRoutine(queryClient, {
        agentId,
        topics,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }),
  });
  return (
    <div className="flex flex-col gap-3" data-feed-make>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border border-dashed p-4 text-sm">
          <p className="font-medium">{t("What I find comes here")}</p>
          <p className="mt-1 text-muted-foreground">
            {t(
              "Every morning I look up what changed and post up to three, each with where it came from. Tell me in the conversation what to look for.",
            )}
          </p>
        </div>
        <div className="rounded-xl border border-border border-dashed p-4 text-sm">
          <p className="font-medium">{t("Not sure what to ask?")}</p>
          <p className="mt-1 text-muted-foreground">
            {t("Ideas has things I can do for you.")}{" "}
            <Link
              className="text-link underline-offset-4 hover:underline"
              to="/ideas"
            >
              {t("See ideas")}
            </Link>
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          {t("It starts by looking for: {topics}", {
            topics: topics.join(", "),
          })}
        </p>
        <Button
          className="self-start"
          data-feed-start
          disabled={make.isPending}
          onClick={() => make.mutate()}
        >
          {t("Get updates every morning")}
        </Button>
        <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
          {make.isError ? failureSentence(make.error) : null}
        </LiveRegion>
      </div>
    </div>
  );
}
