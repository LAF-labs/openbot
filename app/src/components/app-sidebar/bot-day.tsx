import {
  IconAlertTriangle,
  IconBulb,
  IconClock,
  IconMessageCircle,
  IconSparkles,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { useControl } from "@/components/computer/use-control";
import { focusRing } from "@/components/ui/focus";
import {
  type BotDayItem,
  type DayMark,
  dayClock,
  dayMark,
  isOvernight,
  useBotDay,
} from "@/lib/agents/day";
import {
  firstTaskDeal,
  isFirstConversation,
  pickFirstTasks,
  reportFirstTaskPressed,
} from "@/lib/agents/first-tasks";
import { conversationOf } from "@/lib/agents/my-bots";
import {
  describeSubject,
  openQuestionCalls,
  watchQuestions,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { requestJump, revealWhenDrawn } from "@/lib/channels/jump";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useStartChannel } from "@/lib/channels/start";
import { frameAddress } from "@/lib/computer/last-frame";
import { connectionsOverviewQueryOptions } from "@/lib/connections/queries";
import { t } from "@/lib/i18n";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import { routineListQueryOptions, whenLabel } from "@/lib/routines/queries";
import { cardThread } from "@/lib/turns/questions";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/**
 * 오늘: THE BOT'S DAY — WHAT IS WAITING ON THE PERSON, WHAT IT DID, WHAT IS NEXT.
 *
 * The Bot worked all day out of sight: a routine that found nothing new said so nowhere, a browsing
 * task was a card three screens up, and a fact it learned was on the profile. This is that work,
 * from the ledgers (`GET /api/agents/:agentId/day`).
 *
 * DRAWN IN THREE PLACES, AND NO LONGER IN THE SIDEBAR. It was written for the sidebar (2026-09-25):
 * one Bot's column had its whole height empty under the conversation, which is why this file is in
 * this directory, and the list stood there under a heading of its own, three rows and then a link
 * to 소식 for the rest. The owner had it taken out on 2026-10-04 — too much text on the screen. What
 * draws it now is 홈, the panel at the left of the window, as the first thing in it (2026-10-10,
 * `layout/home-panel.tsx` — a panel a person folds, which the column was not); 소식, as a page,
 * wherever 홈 is not on the screen (`routes/_authed/_app/feed.tsx`); and the header's drawer, under
 * 지금 (`channels/presence-drawer.tsx`): one component, so the three can never disagree about what
 * is waiting or what comes next.
 *
 * NOTHING IS ANSWERED HERE. A row goes to where the thing is — the Bot's first message of the turn,
 * the delivered answer, the card with the buttons (`lib/channels/jump.ts`), the routine, what it
 * remembers. An empty group is not drawn, except 한 일 for a Bot nobody has spoken to yet, which
 * offers the first things to hand it instead.
 *
 * NOTHING POLLS HERE either: see `lib/agents/day.ts` for what refreshes it.
 *
 * THE DRAWER ON THE PC APP ASKS FOR `waitingOnly` (2026-09-25, UX review 0.5.4 item 12). The full
 * column beside it showed 한 일 and 다음 then, and the drawer repeated them word for word. The column
 * went, and from 2026-10-04 to 2026-10-10 they were on 소식 and nowhere else; 홈 lists them beside
 * the conversation again, which is the reason the drawer was given in the first place. With 홈
 * folded they are a press away, in 홈 or on 소식. Below `lg` the drawer shows the whole day.
 */
export function BotDay({
  botId,
  empty = null,
  onLeave,
  rows = VISIBLE_ROWS,
  waitingOnly = false,
}: {
  botId: string;
  /**
   * What to draw when there is nothing in any group. Nothing, in the drawer, which has 지금 above
   * it and goes on without it; a line on 소식, which is a page of its own and would otherwise be a
   * title over a blank screen.
   */
  empty?: ReactNode;
  /** Called before a press leaves for somewhere else: the drawer closes. */
  onLeave?: () => void;
  /**
   * How many of 한 일 are drawn before "n개 더 보기". Six on a page and in the drawer; 홈 asks for
   * three, as the column this was written for did — it has cards under the list, and at the PC
   * app's smallest window six rows put every one of them below the fold.
   */
  rows?: number;
  /** Only what is waiting on the owner: the drawer on the PC app, for the reason above. */
  waitingOnly?: boolean;
}) {
  const now = useNow();
  const navigate = useNavigate();
  const day = useBotDay(botId);
  const channels = useQuery(channelListQueryOptions());
  const conversation = conversationOf(botId, channels.data);
  const routines = useQuery(routineListQueryOptions());
  const upcoming = (routines.data ?? [])
    .filter((routine) => routine.agentId === botId && routine.enabled)
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
    .slice(0, 2);
  const waiting = useWaiting(botId);
  const [isExpanded, setIsExpanded] = useState(false);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const items = waitingOnly ? [] : (day.data?.items ?? []);
  const shown = isExpanded ? items : items.slice(0, rows);
  const hidden = items.length - shown.length;
  const isNewBot =
    channels.data !== undefined && isFirstConversation(channels.data, botId);

  /** Go to a conversation, and leave word of which row to show when it is drawn. */
  const handleShowInConversation = (
    channelId: string | null | undefined,
    target: { messageId?: string | null; waitingCard?: string },
  ) => {
    onLeave?.();
    if (!channelId) return;
    if (target.messageId || target.waitingCard) {
      requestJump({
        channelId,
        ...(target.messageId ? { messageId: target.messageId } : {}),
        ...(target.waitingCard ? { waitingCard: target.waitingCard } : {}),
      });
    }
    void navigate({ params: { channelId }, to: "/channel/$channelId" });
  };

  /** A routine's card, or what the Bot remembers: another screen, and the element on it. */
  const handleShowOnPage = async (
    to: "/routines" | "/notebook",
    hash: string | undefined,
  ) => {
    onLeave?.();
    await navigate({
      ...(hash ? { hash } : {}),
      ...(to === "/notebook" ? { search: { agent: botId } } : {}),
      to,
    });
    if (hash) revealWhenDrawn(hash);
  };

  const handlePress = (item: BotDayItem) => {
    if (item.kind === "learned" || item.kind === "tidied") {
      void handleShowOnPage("/notebook", undefined);
      return;
    }
    if (item.kind === "routine" && (item.silent || !item.messageId)) {
      void handleShowOnPage(
        "/routines",
        item.routineId ? `routine-${item.routineId}` : undefined,
      );
      return;
    }
    handleShowInConversation(item.channelId, { messageId: item.messageId });
  };

  /*
   * NOT OVER THE EMPTY CONVERSATION, WHICH OFFERS THE SAME SENTENCES. The first screen showed the
   * same chips twice, under the face and in the sidebar beside it, where this list was then (UX
   * review 0.5.4, item 12); the drawer opened on that screen would be the second copy now. The
   * conversation's are the ones to press: they are where the answer will appear.
   */
  const isFirstThings =
    items.length === 0 &&
    day.isSuccess &&
    isNewBot &&
    !waitingOnly &&
    pathname !== "/channel/new";
  const next = waitingOnly ? [] : upcoming;
  // Nothing in any group: no heading over nothing, which would read as a list that failed to load.
  if (
    waiting.length === 0 &&
    items.length === 0 &&
    !isFirstThings &&
    next.length === 0
  ) {
    return day.isSuccess ? empty : null;
  }

  /*
   * NAMED 오늘 ONLY OVER SOMETHING OF TODAY. With a routine made and nothing run yet, the sidebar
   * read "오늘 / 다음 / 아침 브리핑" — a heading for today over nothing but tomorrow's plan (first-hour
   * walk, 2026-09-27). The heading went with the sidebar's copy (2026-10-04); the name a screen
   * reader is given keeps the rule. 다음 says what it is by itself.
   */
  const hasToday = waiting.length > 0 || items.length > 0 || isFirstThings;

  return (
    <section
      aria-label={hasToday ? t("Today") : t("Up next")}
      className="flex flex-col divide-y divide-border"
    >
      {waiting.length > 0 ? (
        <DayGroup title={t("Waiting on the owner")}>
          {waiting.map((entry) => (
            <DayRow
              icon={
                <IconAlertTriangle
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
              }
              key={entry.key}
              onPress={() =>
                handleShowInConversation(
                  /*
                   * The conversation the question was raised in, where the record has said; the
                   * Bot's own otherwise. An account that kept several with one Bot has its
                   * questions listed from all of them, and the card is on one.
                   */
                  (entry.threadId
                    ? channels.data?.find(
                        (channel) => channel.threadId === entry.threadId,
                      )?.id
                    : undefined) ?? conversation?.id,
                  { waitingCard: entry.card },
                )
              }
              text={entry.text}
              tone="attention"
            />
          ))}
        </DayGroup>
      ) : null}

      {items.length > 0 ? (
        <DayGroup title={t("What it did")}>
          {shown.map((item) => (
            <DayItemRow
              isAsking={waiting.length > 0}
              item={item}
              key={
                item.kind === "learned"
                  ? item.memoryId
                  : item.kind === "tidied"
                    ? item.receiptId
                    : item.runId
              }
              onPress={() => handlePress(item)}
              zone={day.data?.zone ?? ""}
            />
          ))}
          {hidden > 0 ? (
            <button
              className={cn(
                "self-start rounded-sm px-1 font-medium text-link text-xs underline-offset-4 hover:underline",
                focusRing,
              )}
              onClick={() => setIsExpanded(true)}
              type="button"
            >
              {t("Show {count} more", { count: hidden })}
            </button>
          ) : null}
        </DayGroup>
      ) : isFirstThings ? (
        <DayGroup title={t("What it did")}>
          <FirstThings botId={botId} onLeave={onLeave} />
        </DayGroup>
      ) : null}

      {next.length > 0 ? (
        <DayGroup title={t("Up next")}>
          {next.map((routine) => (
            <DayRow
              icon={
                <IconClock aria-hidden="true" className="size-3.5 shrink-0" />
              }
              key={routine.id}
              note={whenLabel(routine.nextRunAt, now)}
              onPress={() =>
                void handleShowOnPage("/routines", `routine-${routine.id}`)
              }
              text={routine.name}
            />
          ))}
          <Link
            className={cn(
              "self-start rounded-sm px-1 font-medium text-link text-xs underline-offset-4 hover:underline",
              focusRing,
            )}
            onClick={onLeave}
            to="/routines"
          >
            {t("See all routines")}
          </Link>
        </DayGroup>
      ) : null}
    </section>
  );
}

/** Six, then "n개 더 보기", unless whoever draws it asks for fewer (`rows`). */
const VISIBLE_ROWS = 6;

function DayGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-2.5">
      <h3 className="px-1 pb-0.5 text-muted-foreground text-xs">{title}</h3>
      {children}
    </div>
  );
}

function DayItemRow({
  isAsking,
  item,
  onPress,
  zone,
}: {
  /** A question is open for the owner: what a `waiting` row is waiting on. */
  isAsking: boolean;
  item: BotDayItem;
  onPress: () => void;
  zone: string;
}) {
  const time = dayClock(item.at, zone);
  /*
   * THE MEMORY'S BACKGROUND WORK, as a receipt: what the hourly curation settled, what the nightly
   * dream noted about how the owner likes to work. Before six in the morning it is "밤사이", which is
   * when the dream runs and when the owner was not looking.
   */
  if (item.kind === "tidied") {
    const overnight = isOvernight(item.at, zone);
    const text =
      item.job === "dream"
        ? overnight
          ? t("Overnight: noted how you like to work")
          : t("Noted how you like to work")
        : overnight
          ? t("Overnight: tidied {count} memories", { count: item.count })
          : t("Tidied {count} memories", { count: item.count });
    return (
      <DayRow
        detail={time}
        icon={<IconSparkles aria-hidden="true" className="size-3.5 shrink-0" />}
        onPress={onPress}
        text={text}
      />
    );
  }
  if (item.kind === "learned") {
    return (
      <DayRow
        detail={time}
        icon={<IconBulb aria-hidden="true" className="size-3.5 shrink-0" />}
        onPress={onPress}
        text={t("Remembered · {fact}", { fact: item.head })}
      />
    );
  }
  const mark = dayMark(
    item.status,
    item.kind === "chat" ? (item.reason ?? null) : null,
    isAsking,
  );
  /*
   * What it remembered while doing this, on this row: one message that taught the Bot three things
   * was four rows before (UX review 0.5.4, item 12). The facts themselves are on its profile. Beside
   * the time rather than after the words, which a long request cuts off at 375px.
   */
  const learned = item.learned ?? 0;
  const detail =
    learned > 0
      ? `${time} · ${t("Remembered {count}", { count: learned })}`
      : time;
  if (item.kind === "routine") {
    return (
      <DayRow
        detail={detail}
        icon={<IconClock aria-hidden="true" className="size-3.5 shrink-0" />}
        mark={mark}
        note={item.silent ? t("Nothing new") : undefined}
        onPress={onPress}
        text={item.name}
      />
    );
  }
  return (
    <DayRow
      detail={detail}
      icon={
        <IconMessageCircle aria-hidden="true" className="size-3.5 shrink-0" />
      }
      mark={mark}
      onPress={onPress}
      text={item.label ?? t("Conversation")}
      thumbnail={
        item.frameToolCallId && item.channelId
          ? frameAddress(item.channelId, item.frameToolCallId)
          : undefined
      }
    />
  );
}

function DayRow({
  detail,
  icon,
  mark,
  note,
  onPress,
  text,
  thumbnail,
  tone,
}: {
  detail?: string;
  icon: ReactNode;
  mark?: DayMark | null;
  /** Said after the text, quieter: "새 소식 없음". */
  note?: string | undefined;
  onPress: () => void;
  text: string;
  thumbnail?: string | undefined;
  tone?: "attention";
}) {
  return (
    <button
      className={cn(
        "flex min-h-8 w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-sm transition-colors",
        tone === "attention"
          ? "bg-warning/12 text-warning hover:bg-warning/20"
          : "text-foreground hover:bg-accent",
        focusRing,
      )}
      onClick={onPress}
      type="button"
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center",
          tone === "attention" ? "text-warning" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          {text}
          {note ? (
            <span className="text-muted-foreground"> · {note}</span>
          ) : null}
        </span>
        {detail || mark ? (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
            {/* The time never wraps: a reason beside it is cut first ("못 끝냄 · 봇의 컴퓨터에…"). */}
            {detail ? (
              <span className="shrink-0 whitespace-nowrap">{detail}</span>
            ) : null}
            {mark ? (
              <span
                className={cn(
                  "min-w-0 truncate",
                  mark.tone === "active"
                    ? "text-link"
                    : mark.tone === "failed"
                      ? "text-warning"
                      : "text-muted-foreground",
                )}
              >
                {mark.text}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      {thumbnail ? (
        <img
          alt={t("The last screen of this task")}
          className="size-8 shrink-0 rounded-md border border-border object-cover"
          height={32}
          loading="lazy"
          src={thumbnail}
          width={32}
        />
      ) : null}
    </button>
  );
}

/**
 * A Bot nobody has spoken to yet: nothing done today is the honest state, and the first things to
 * hand it are the useful one. The same catalogue as the empty conversation's chips
 * (`first-tasks.ts`), three of the sentences, sent the same way — a sentence pressed is a sentence
 * typed.
 */
function FirstThings({
  botId,
  onLeave,
}: {
  botId: string;
  onLeave: (() => void) | undefined;
}) {
  const overview = useQuery(connectionsOverviewQueryOptions());
  const user = useQuery(currentUserQueryOptions());
  // What this Bot holds decides the 지원사업 chip; drawn once it has answered, never swapped in later.
  const granted = useQuery(agentPluginsQueryOptions(botId));
  const { start, pending } = useStartChannel();
  // Dealt as the first screen deals them: who the person is orders the row (`firstTaskDeal`).
  const tasks =
    overview.data && !granted.isPending
      ? pickFirstTasks(
          overview.data,
          firstTaskDeal(user.data, granted.data),
        ).flatMap((task) => (task.kind === "ask" ? [task] : []))
      : [];

  return (
    <div className="flex flex-col gap-2 px-1">
      <p className="text-muted-foreground text-sm">
        {t("Nothing done yet today. Try handing over one of these.")}
      </p>
      <div className="flex flex-col items-start gap-1.5">
        {tasks.slice(0, 3).map((task) => (
          <button
            className={cn(
              "rounded-2xl border border-border bg-card px-3 py-1.5 text-left text-sm transition-colors hover:border-ring/40 hover:bg-muted/60 disabled:opacity-50",
              focusRing,
            )}
            disabled={pending}
            key={task.sentence}
            onClick={() => {
              reportFirstTaskPressed({
                agentId: botId,
                kind: "ask",
                pattern: task.pattern,
                sentence: task.sentence,
                via: task.via,
                hint: null,
              });
              onLeave?.();
              /*
               * The Korean, not the key: the Bot is asked in the person's own language. Sent, on every
               * screen: an empty conversation already on screen takes it as it is stashed
               * (`hearFirstMessages`), where it used to land in the composer instead.
               */
              void start([botId], t(task.sentence)).catch(() => undefined);
            }}
            type="button"
          >
            {t(task.sentence)}
          </button>
        ))}
      </div>
    </div>
  );
}

type Waiting = {
  key: string;
  card: string;
  text: string;
  /** The conversation that draws the card, where a watch has read it off the record. */
  threadId?: string;
};

/**
 * What is waiting on the person for this Bot: the approvals its conversation has open, and a
 * request for help at its computer. The tab's own state, the same the drawer always read.
 */
function useWaiting(botId: string): Waiting[] {
  /*
   * The questions as one string, so the snapshot is a value React can compare: a fresh array from
   * `openQuestionCalls()` on every read would be a new snapshot every time and render forever.
   */
  const asking = useSyncExternalStore(
    watchQuestions,
    () => questionsKey(botId),
    () => "[]",
  );
  const control = useControl(botId, false);
  const questions = JSON.parse(asking) as [string, string, string][];
  const waiting: Waiting[] = questions.map(
    ([toolCallId, subject, threadId]) => ({
      key: toolCallId,
      card: toolCallId,
      text: t("Approval needed · {subject}", { subject }),
      ...(threadId ? { threadId } : {}),
    }),
  );
  if (
    control !== null &&
    (control.requested || control.secretWanted !== undefined)
  ) {
    waiting.push({
      key: "help",
      card: "help",
      text: t("Help needed · {reason}", {
        reason: control.reason?.trim() || t("The Bot needs your help"),
      }),
    });
  }
  return waiting;
}

function questionsKey(botId: string): string {
  return JSON.stringify(
    openQuestionCalls()
      .filter(({ question }) => question.botId === botId)
      .map(({ toolCallId, question }) => [
        toolCallId,
        question.subject
          ? describeSubject(question.subject)
          : t(
              "It is waiting on an answer about something this screen cannot name.",
            ),
        // In the key, so a row is drawn again once the record has said where its card is.
        cardThread(botId, toolCallId) ?? "",
      ]),
  );
}
