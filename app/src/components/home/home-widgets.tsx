import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BotDay } from "@/components/app-sidebar/bot-day";
import { focusRing } from "@/components/ui/focus";
import { Skeleton } from "@/components/ui/skeleton";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { requestJump } from "@/lib/channels/jump";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { feedQueryOptions, feedUnseenQueryOptions } from "@/lib/feed/queries";
import { goalsQueryOptions, measureLine } from "@/lib/goals/queries";
import { t } from "@/lib/i18n";
import { kindLabel, type MadeItem, madeQueryOptions } from "@/lib/made/queries";
import { type Reading, settledOf, useReading } from "@/lib/reading";
import { cn } from "@/lib/utils";

/**
 * THE HOME PANEL'S FIRST WIDGETS: 오늘 · 소식 · 목표 · 만든 것 (`docs/laf/redesign-2026-10.md` §1,
 * "이미 고정된 패널처럼 동작한다").
 *
 * These four were screens that already behaved like fixed panels, so they are the panel's first
 * contents: each widget is the top of one of those screens, drawn small, and its title is the way
 * to the whole of it. The panels a person asks the Bot to make come later (§2) and will be composed
 * from the gallery's cards; these are not that, and nothing here offers to make one.
 *
 * A WIDGET READS AND NEVER MARKS. 소식 marks a post seen when its page shows it
 * (`routes/_authed/_app/feed.tsx`), and the count of unseen ones is what the profile button's dot
 * says. The panel is open on every screen, so a widget that marked what it drew would mark every
 * post seen the moment it arrived and put that dot out without anybody having read a word. A row
 * here shows a title; reading is what the page is for.
 *
 * WHAT A DEPLOYMENT DOES NOT HAVE IS NOT DRAWN. A deployment started without the feed or the goals
 * answers "not here"; a card saying so on every screen would be a control that does nothing. A read
 * that failed is different — that is something that can be asked again — and says so in the page's
 * own sentence.
 *
 * THE SAME FOR EVERYBODY. The first run's answer (학생 / 직장인 / 사장님 / 기타) may one day order
 * these; it never shows or hides one.
 */

/** How many rows a widget draws: the top of a list, not the list. */
const WIDGET_ROWS = 3;

const ROW_CLASS = cn(
  "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
  focusRing,
);

/** A widget's card: a pane of glass on the backdrop, its title the way to the whole screen. */
function Widget({
  children,
  count,
  name,
  title,
  to,
}: {
  children: ReactNode;
  /** Drawn at the end of the title's line: how many are new, how many are going. */
  count?: ReactNode;
  /** For a test and for the eye of whoever reads the tree: which widget this is. */
  name: string;
  title: string;
  /** The screen this is the top of. 오늘 has none of its own: it is on 소식. */
  to: "/feed" | "/goals" | "/made";
}) {
  return (
    <section
      className="rounded-3xl border border-glass-border bg-glass text-card-foreground shadow-card backdrop-blur-xl"
      data-home-widget={name}
    >
      <h2 className="px-1.5 pt-1.5">
        <Link
          className={cn(
            "flex items-center justify-between gap-2 rounded-2xl px-2 py-1.5 font-medium text-sm transition-colors hover:bg-accent",
            focusRing,
          )}
          to={to}
        >
          {title}
          {count}
        </Link>
      </h2>
      <div className="px-1.5 pb-2">{children}</div>
    </section>
  );
}

/** A widget's one line when it has no rows: nothing yet, or the read that failed. */
function WidgetLine({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-0.5 pb-1.5 text-muted-foreground text-sm">
      {children}
    </p>
  );
}

/**
 * What a widget draws for a read that has no rows to show: a line of grey while it loads, the
 * page's own sentence when it failed with nothing from before, the page's own line when there is
 * nothing yet. Null when there are rows, and the caller draws them.
 */
function lineOf<T>(
  reading: Reading<T>,
  words: { failed: string; empty: string },
): ReactNode {
  if (reading.state === "loading") {
    return <Skeleton className="mx-2 my-1.5 h-4 w-2/3 rounded-md" />;
  }
  if (reading.state === "failed" && reading.previous === null) {
    return <WidgetLine>{words.failed}</WidgetLine>;
  }
  const settled = settledOf(reading);
  if (!settled || settled.state === "empty") {
    return <WidgetLine>{words.empty}</WidgetLine>;
  }
  return null;
}

export function HomeWidgets() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  if (!bot) return null;
  return (
    <>
      <TodayWidget botId={bot.id} />
      <UpdatesWidget />
      <GoalsWidget />
      <MadeWidget botId={bot.id} />
    </>
  );
}

/**
 * 오늘: what is waiting on the person, what the Bot did, what is next — the Bot's day, which lived
 * on this height once before and was drawn for a column this narrow (`bot-day.tsx`).
 */
function TodayWidget({ botId }: { botId: string }) {
  return (
    <Widget name="today" title={t("Today")} to="/feed">
      <BotDay
        botId={botId}
        empty={
          <WidgetLine>
            {t(
              "Nothing yet today. What you hand over in the conversation shows up here.",
            )}
          </WidgetLine>
        }
      />
    </Widget>
  );
}

/** 소식: the newest things the Bot found, by their titles. Read here, never marked seen here. */
function UpdatesWidget() {
  const feed = useInfiniteQuery(feedQueryOptions());
  const reading = useReading(feed, {
    isEmpty: (data) => data.pages.every((page) => page.posts.length === 0),
  });
  const unseen = useQuery(feedUnseenQueryOptions());
  if (reading.state === "unavailable") return null;

  const posts = (settledOf(reading)?.data.pages ?? [])
    .flatMap((page) => page.posts)
    .slice(0, WIDGET_ROWS);
  const unseenCount = unseen.data ?? 0;

  return (
    <Widget
      count={
        unseenCount > 0 ? (
          <span
            className="rounded-full bg-mark px-1.5 font-medium text-white text-xs leading-5"
            data-unseen-count
          >
            <span aria-hidden="true">{unseenCount}</span>
            <span className="sr-only">
              {t("{count} new", { count: unseenCount })}
            </span>
          </span>
        ) : null
      }
      name="updates"
      title={t("Updates")}
      to="/feed"
    >
      {lineOf(reading, {
        failed: t("Updates could not be loaded."),
        empty: t("Nothing posted yet."),
      }) ?? (
        <ul className="flex flex-col">
          {posts.map((post) => (
            <li key={post.id}>
              <Link className={ROW_CLASS} data-widget-row to="/feed">
                <span className="line-clamp-2 min-w-0 flex-1">
                  {post.title}
                </span>
                {post.seen ? null : (
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full bg-mark"
                    data-mark="unseen"
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

/** 목표: the goals in progress, each with the number it is watched by where it has one. */
function GoalsWidget() {
  const goals = useQuery(goalsQueryOptions());
  const reading = useReading(goals, {
    isEmpty: (data) => data.goals.every((goal) => goal.status !== "active"),
  });
  if (reading.state === "unavailable") return null;

  const settled = settledOf(reading);
  const active = (settled?.data.goals ?? [])
    .filter((goal) => goal.status === "active")
    .slice(0, WIDGET_ROWS);
  const activeCount = settled?.data.active ?? 0;

  return (
    <Widget
      count={
        activeCount > 0 ? (
          <span
            className="text-muted-foreground text-xs tabular-nums"
            data-active-goals
          >
            <span aria-hidden="true">{activeCount}</span>
            <span className="sr-only">
              {t("{count} in progress", { count: activeCount })}
            </span>
          </span>
        ) : null
      }
      name="goals"
      title={t("Goals")}
      to="/goals"
    >
      {lineOf(reading, {
        failed: t("Goals could not be loaded."),
        empty: t("Goals you set in the conversation are kept here."),
      }) ?? (
        <ul className="flex flex-col">
          {active.map((goal) => {
            const watched = measureLine(goal);
            return (
              <li key={goal.id}>
                <Link
                  className={cn(ROW_CLASS, "flex-col items-stretch gap-0")}
                  data-widget-row
                  search={{ goal: goal.id }}
                  to="/goals"
                >
                  <span className="line-clamp-2 min-w-0">{goal.title}</span>
                  {watched ? (
                    <span className="truncate text-muted-foreground text-xs">
                      {watched}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Widget>
  );
}

/** 만든 것: the last things the Bot handed over, each a press away from where it handed them over. */
function MadeWidget({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const made = useInfiniteQuery(madeQueryOptions(botId, null));
  const reading = useReading(made, {
    isEmpty: (data) => data.pages.every((page) => page.items.length === 0),
  });
  if (reading.state === "unavailable") return null;

  const items = (settledOf(reading)?.data.pages ?? [])
    .flatMap((page) => page.items)
    .slice(0, WIDGET_ROWS);

  /** To the message that made it, as the card on 만든 것 goes (`lib/channels/jump.ts`). */
  const handleOpen = (item: MadeItem) => {
    requestJump({ channelId: item.channelId, messageId: item.messageId });
    void navigate({
      params: { channelId: item.channelId },
      to: "/channel/$channelId",
    });
  };

  return (
    <Widget name="made" title={t("Made")} to="/made">
      {lineOf(reading, {
        failed: t("What your Bot made could not be read."),
        empty: t("Nothing here yet."),
      }) ?? (
        <ul className="flex flex-col">
          {items.map((item) => {
            const kind = kindLabel(item.tool);
            return (
              <li key={`${item.messageId}:${item.title}`}>
                <button
                  className={cn(
                    ROW_CLASS,
                    "w-full flex-col items-stretch gap-0",
                  )}
                  data-widget-row
                  onClick={() => handleOpen(item)}
                  type="button"
                >
                  {/* A thing the Bot gave no title is called by its kind, and the kind said once. */}
                  <span className="line-clamp-2 min-w-0">
                    {item.title ?? kind}
                  </span>
                  {item.title && kind ? (
                    <span className="truncate text-muted-foreground text-xs">
                      {kind}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Widget>
  );
}
