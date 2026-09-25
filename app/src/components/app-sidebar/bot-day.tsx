import {
  IconAlertTriangle,
  IconBulb,
  IconClock,
  IconMessageCircle,
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
  useBotDay,
} from "@/lib/agents/day";
import {
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
import { routineListQueryOptions, whenLabel } from "@/lib/routines/queries";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/**
 * 오늘: THE BOT'S DAY — WHAT IS WAITING ON THE PERSON, WHAT IT DID, WHAT IS NEXT.
 *
 * The sidebar of one Bot held a face, one conversation row and five links, with the column's whole
 * height of nothing in between, while the Bot worked all day out of sight: a routine that found
 * nothing new said so nowhere, a browsing task was a card three screens up, and a fact it learned
 * was on the profile. This is that work, from the ledgers (`GET /api/agents/:agentId/day`), in the
 * column that is always there on the PC app (its window is never narrower than `lg`).
 *
 * THE SAME COMPONENT IN THE HEADER'S DRAWER, so the pill and the sidebar can never disagree about
 * what is waiting or what comes next. "지금" stays the drawer's own: the sidebar's identity row
 * already says what the Bot is doing.
 *
 * NOTHING IS ANSWERED HERE. A row goes to where the thing is — the Bot's first message of the turn,
 * the delivered answer, the card with the buttons (`lib/channels/jump.ts`), the routine, what it
 * remembers. An empty group is not drawn, except 한 일 for a Bot nobody has spoken to yet, which
 * offers the first things to hand it instead.
 *
 * NOTHING POLLS HERE either: see `lib/agents/day.ts` for what refreshes it.
 *
 * WHAT THE DRAWER SHOWS DEPENDS ON WHETHER THE SIDEBAR IS THERE (2026-09-25, UX review 0.5.4 item
 * 12). On the PC app the full column always is, and the pill's drawer repeated it word for word; there
 * the drawer asks for `waiting` only — what needs the owner now, beside 지금. Below `lg` the column is a
 * rail or a sheet that is away, and the drawer is the one place 한 일 and 다음 are, so it shows all.
 */
export function BotDay({
  botId,
  onLeave,
  placement,
  waitingOnly = false,
}: {
  botId: string;
  /** Called before a press leaves for somewhere else: the drawer closes, the phone's sheet goes. */
  onLeave?: () => void;
  placement: "sidebar" | "drawer";
  /** Only what is waiting on the owner: the drawer, beside a sidebar that shows the rest. */
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
  const visible = placement === "sidebar" ? SIDEBAR_ROWS : VISIBLE_ROWS;
  const shown = isExpanded ? items : items.slice(0, visible);
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
    if (item.kind === "learned") {
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

  const isSidebar = placement === "sidebar";
  /*
   * NOT BESIDE THE EMPTY CONVERSATION, WHICH OFFERS THE SAME SENTENCES. The first screen showed the
   * same chips twice, in the sidebar and under the face (UX review 0.5.4, item 12). The conversation's
   * are the ones to press: they are where the answer will appear.
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
    return null;
  }

  return (
    <section
      aria-label={t("Today")}
      className={cn(
        "flex flex-col",
        isSidebar ? "mt-3 gap-3 px-2" : "divide-y divide-border",
      )}
    >
      {isSidebar ? (
        <h2 className="font-medium text-muted-foreground text-xs">
          {t("Today")}
        </h2>
      ) : null}

      {waiting.length > 0 ? (
        <DayGroup placement={placement} title={t("Waiting on the owner")}>
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
                handleShowInConversation(conversation?.id, {
                  waitingCard: entry.card,
                })
              }
              text={entry.text}
              tone="attention"
            />
          ))}
        </DayGroup>
      ) : null}

      {items.length > 0 ? (
        <DayGroup placement={placement} title={t("What it did")}>
          {shown.map((item) => (
            <DayItemRow
              item={item}
              key={item.kind === "learned" ? item.memoryId : item.runId}
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
        <DayGroup placement={placement} title={t("What it did")}>
          <FirstThings botId={botId} onLeave={onLeave} />
        </DayGroup>
      ) : null}

      {next.length > 0 ? (
        <DayGroup placement={placement} title={t("Up next")}>
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

/** Six, then "n개 더 보기": the drawer is a glance, and the conversation holds the rest. */
const VISIBLE_ROWS = 6;
/**
 * Four in the sidebar: at the PC app's smallest window (1024×640) the column under the Bot and its
 * conversation has room for 기다리는 일, four of 한 일 and 다음 before it has to scroll.
 */
const SIDEBAR_ROWS = 4;

function DayGroup({
  children,
  placement,
  title,
}: {
  children: ReactNode;
  placement: "sidebar" | "drawer";
  title: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5",
        placement === "drawer" && "px-2 py-2.5",
      )}
    >
      <h3 className="px-1 pb-0.5 text-muted-foreground text-xs">{title}</h3>
      {children}
    </div>
  );
}

function DayItemRow({
  item,
  onPress,
  zone,
}: {
  item: BotDayItem;
  onPress: () => void;
  zone: string;
}) {
  const time = dayClock(item.at, zone);
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
  const { start, pending } = useStartChannel();
  const tasks = overview.data
    ? pickFirstTasks(overview.data, { shop: user.data?.shop }).flatMap(
        (task) => (task.kind === "ask" ? [task] : []),
      )
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

type Waiting = { key: string; card: string; text: string };

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
  const questions = JSON.parse(asking) as [string, string][];
  const waiting: Waiting[] = questions.map(([toolCallId, subject]) => ({
    key: toolCallId,
    card: toolCallId,
    text: t("Approval needed · {subject}", { subject }),
  }));
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
      ]),
  );
}
