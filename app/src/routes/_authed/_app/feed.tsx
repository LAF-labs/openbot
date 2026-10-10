import {
  type FeedPage,
  type FeedPost,
  type FeedRoutine,
  feedQuotePart,
} from "@shared/feed";
import { effectivePersona } from "@shared/persona";
import { IconPencil } from "@tabler/icons-react";
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
  feedKeys,
  feedQueryOptions,
  feedTopics,
  hidePost,
  likePost,
  makeFeedRoutine,
  markFeedSeen,
} from "@/lib/feed/queries";
import { offerFeedQuote } from "@/lib/feed/quote-offer";
import { useIsHomeDrawn } from "@/lib/home/home-panel";
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
 * did, what comes next — wherever 홈 is not on the screen. Since 2026-10-10 the panel at the left
 * of the window holds 오늘 (`layout/home-panel.tsx`), and this page, drawn beside it, leaves the
 * list to it; folded, or in a window with no 홈, the page draws it as it always did.
 * Under it the posts a 소식 routine wrote — at most three a morning, each from pages its run opened
 * (`server/src/routines/feed.ts`) — with 좋아요, 숨기기 and 이야기하기.
 *
 * MADE BY ONE PRESS, NEVER BY DEFAULT (plan D3). Before there is a 소식 routine the page says what
 * would come here and offers the one button; the 7:30 chip on a first conversation makes it too.
 * After, the first card is the routine itself — when it runs next, what it looks for, 지금 만들기 and
 * 대화에서 바꾸기 — so what it looks for is changed by talking, not by a form.
 *
 * SEEN IS WHAT THIS PAGE SHOWED. Posts drawn here are marked seen once they load, which is what the
 * sidebar's count and the unread pause read; the ones that were new keep their dot for this visit.
 *
 * THE TITLE STANDS ALONE (2026-10-04, the owner: too many words, and words where an icon would do).
 * The page opened on a sentence saying what it is, then two boxes saying it again: on a first day,
 * 417 of the page's 577 characters were the page explaining itself and its neighbours (the sentence
 * 25, the boxes and their line 123, the tour 269; Korean, whitespace removed). The sentence is gone,
 * the empty list says in one line what will come, and a post's presses are icons that say their
 * names when asked.
 */
export const Route = createFileRoute("/_authed/_app/feed")({
  component: FeedPageScreen,
});

function FeedPageScreen() {
  const mine = useMyBots();
  const bots = mine.bots ?? [];
  const isSeveral = bots.length > 1;
  /*
   * 오늘 IS IN 홈 WHEN 홈 IS ON THE SCREEN (2026-10-10, `layout/home-panel.tsx`), and this page is
   * drawn right beside it: the same rows twice, a hand's width apart. So the page leaves them to
   * the panel while the panel is there, and draws them itself when it is folded, has stepped
   * aside, or the window has none.
   */
  const isInHome = useIsHomeDrawn();
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;

  return (
    <PageShell title={t("Updates")}>
      {mine.bots === undefined && !mine.isError ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : null}
      {(isInHome ? [] : bots).map((one) => (
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
      {/* One line: when the next ones come, and the press that makes them now, are on the card above. */}
      {settled && routine && posts.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-feed-empty>
          {t("Nothing posted yet.")}
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
          {runNow.isPending ? t("Making them — a few minutes") : t("Make now")}
        </Button>
        {/*
         * A PENCIL, NAMED. 대화에서 바꾸기 is the card's second press, and the pencil is what this
         * app already draws for changing a thing (the Bot's name, its profile); the words are in
         * the label and the tooltip.
         */}
        {channelId ? (
          <a
            aria-label={t("Change in the conversation")}
            className={buttonVariants({ size: "icon-sm", variant: "outline" })}
            data-feed-change
            href={editInChatHref(channelId, routine.name)}
            title={t("Change in the conversation")}
          >
            <IconPencil aria-hidden="true" />
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

/**
 * Before 소식 exists: one line saying what will come here, and the one press that makes it (plan D3).
 *
 * IT WAS TWO BOXES, A SENTENCE AND A BUTTON — 123 characters in Korean around one press (measured
 * 2026-10-04). One box said the posts come here and how many; the other sent the person to 아이디어,
 * which the sidebar and the tour below already do; the sentence named the topics. What the press
 * makes is a routine that looks for these topics every morning, so that is the line.
 */
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
    <div className="flex flex-col items-start gap-2" data-feed-make>
      <p className="text-muted-foreground text-sm">
        {t("Every morning, posted here: {topics}", {
          topics: topics.join(", "),
        })}
      </p>
      <Button
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
  );
}
