import {
  IconBulb,
  IconLayoutGrid,
  IconLayoutList,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMailOpened,
  IconMenu2,
  IconMessageCircle,
  IconPencil,
  IconPlayerStop,
  IconRefresh,
  IconSettings,
  IconShieldLock,
  IconTarget,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  BotRow,
  ROSTER_RAIL_ROW_CLASS,
  RosterUnreadDot,
} from "@/components/app-sidebar/bot-row";
import { footerLinksFor } from "@/components/app-sidebar/places";
import { StopAllDialog } from "@/components/app-sidebar/stop-all-dialog";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { PersonAvatar } from "@/components/avatar/person-avatar";
import { PILL_CLASS, PILL_TONES } from "@/components/channels/bot-header";
import { usePresence } from "@/components/channels/use-presence";
import { ReadNotice } from "@/components/layout/read-states";
import { UpdateNotice } from "@/components/layout/update-notice";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRing } from "@/components/ui/focus";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBotMood } from "@/lib/agents/bot-mood";
import { conversationOf, useMyBots } from "@/lib/agents/my-bots";
import type { Presence } from "@/lib/agents/presence";
import type { AgentProfile } from "@/lib/agents/queries";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { rosterNotice } from "@/lib/agents/roster-state";
import { workingLabel, workingQueryOptions } from "@/lib/agents/working";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setChannelReadMutationOptions } from "@/lib/channels/mutations";
import { channelKeys, channelListQueryOptions } from "@/lib/channels/queries";
import { feedKeys, feedUnseenQueryOptions } from "@/lib/feed/queries";
import { goalKeys, goalsQueryOptions } from "@/lib/goals/queries";
import { activeLocale, t } from "@/lib/i18n";
import { settledOf, useReading } from "@/lib/reading";
import { useNow } from "@/lib/use-now";
import { useIsWideViewport } from "@/lib/use-wide-viewport";
import { cn } from "@/lib/utils";

/**
 * THE SIDEBAR OF ONE BOT (2026-09-24): WHO IT IS, THE CONVERSATION, AND WHERE ELSE TO GO.
 *
 * It was built as a roster — one row per colleague, newest first, a preview line so somebody could
 * glance at four Bots and see which needed them — and after the decision that a person has one Bot
 * (docs/laf/deployment-model.md, "봇은 하나다") it held one row and a footer of links, with the
 * column's whole height of nothing in between. Then it filled up: a word under the face for what
 * the Bot was doing, the last thing said and when, the Bot's whole day, four places, a 메뉴 row and
 * the account's address.
 *
 * 216px OF FACE, NAME AND FIVE LABELLED ROWS (2026-10-04, the layout the owner chose). The
 * complaint was the number of words on the screen — "아이콘으로도 되는 걸 항상 글자로 표시하는 게
 * 문제" — so a word is drawn where it is the only way to say the thing, and a face, an icon or a
 * dot says the rest. Top to bottom:
 *
 *  1. THE BOT, on one row of 44px: its face (32px), alive — the same presence as the conversation's
 *     header: working, waiting on the person, glad it finished — and its name. What it is doing is
 *     a dot beside the name; the word is drawn only when it is the person's turn (`BotIdentity`).
 *     Pressing the row opens the profile, the only place the name changes.
 *  2. THE CONVERSATION AND THE PLACES A PERSON GOES TO LOOK: five rows of 36px, an icon and a name
 *     each — 대화 · 소식 · 아이디어 · 목표 · 만든 것. These keep their names because they are the
 *     navigation (`LOOK_ROWS`). 대화 no longer carries the last thing said or when
 *     (`ConversationRow`). Under the rows, nothing.
 *  3. THE FOOT, one button pinned under the part that scrolls: the account's picture and the
 *     menu's icon, opening one list — the places that change how the Bot works, and what is about
 *     the account (`menu` in `BotSidebar`). No word beside it.
 *
 * WHAT WAS MEASURED ON THE WAY HERE AND STILL DECIDES SOMETHING:
 *
 *  - THE FOOT DOES NOT SCROLL. The places that change how the Bot works sat in the one scrolling
 *    column until 2026-09-25, and at the PC app's smallest window (1024×640) what was above them
 *    pushed 루틴, 스킬, 연결 and 도움말 below the fold (UX review 0.5.4, item 4).
 *  - THOSE PLACES ARE BEHIND ONE CONTROL. Three of them and 더 보기 in sight cut what was above them
 *    at 1024×640 (the note above `menu` in `BotSidebar` has the numbers).
 *  - 오늘 IS NOT HERE. From 2026-09-25 the height under the rows held the Bot's day — what is
 *    waiting on the person, what it did, what is next (`bot-day.tsx`) — and it was the first thing
 *    the owner had taken out, the same day and for the same reason. The day is a row away, on 소식;
 *    that something waits on the person is still said here, by the face and the amber pill.
 *  - THE WIDTH WAS 280px, a roster's: a face, a name, a line of preview and a time. One Bot's name
 *    and five short labels have no line that long. Settings and Admin draw their rails at this
 *    column's width, so they narrowed with it — at different widths, crossing into Settings read as
 *    the whole frame moving (`settings-frame.test.tsx` holds the three together).
 *
 * AN ACCOUNT FROM BEFORE THE CAP CAME DOWN keeps every Bot it had, and reaches them the old way: with
 * more than one, the list under "내 봇" is back, a row per Bot, each its own conversation, and 봇
 * 프로필 is a link again. Those rows are the roster's still — the name, the last thing said and
 * when, at 54px (`bot-row.tsx`) — because with several faces in a list that line is how somebody
 * sees which one said what. Nothing else in the app behaves as if there were several.
 *
 * THREE WIDTHS. The full column (216px) at `lg` and up. Below it, a 64px rail of faces and icons
 * with their names in tooltips, which the titlebar's toggle puts back to full for as long as
 * somebody wants — measured at an 800px window, a fixed 280 was 35% of everything the person could
 * see. The rail had no words to lose on 2026-10-04; its foot is the one button too, the picture
 * alone (2026-10-06).
 * And below `md`, NO COLUMN: at 375px the rail was 15% of the screen and five unlabelled icons
 * (UI/UX audit 0.5.3, item 20). There the phone's bottom bar is the way around — 대화 · 소식 · 메뉴
 * (`phone-tab-bar.tsx`) — and the sheet this column used to slide in as, from a menu button in each
 * screen's header, is gone (2026-09-27, muse-shape plan phase 3). The column stays MOUNTED there,
 * only hidden (`max-md:hidden` on the nav): its watch on the working poll is what refreshes the
 * conversation's unread mark when a routine's answer lands, and the bar's dot reads the same list.
 * The installed app's window cannot be narrower than 1024 (`desktop/src-tauri/tauri.conf.json`), so
 * the phone's width is the phone's and the browser's, never the PC app's.
 */

/**
 * The titlebar's controls, with a real focus ring. `buttonVariants` is the app's one source for
 * that ring; the ghost fill is put back over it because it works in both themes.
 */
const ICON_BUTTON_CLASS = cn(
  buttonVariants({ size: "icon-sm", variant: "ghost" }),
  "text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent",
);

/**
 * The nav's rows: 36px and 13px, a desktop list rather than a web page's menu. The icon is bare —
 * the grey discs it used to sit in made five links look like five avatars.
 */
const NAV_LINK_CLASS = `flex h-9 items-center rounded-lg border border-transparent bg-clip-padding text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground ${focusRing} data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-foreground`;

/**
 * The time a row shows: clock for today, weekday inside a week, date beyond it.
 *
 * `activeLocale` IS PASSED: with no locale argument the browser answers with its own, so a
 * Korean-language app on an en-US machine printed "Sat" and "9/6".
 */
function rosterTime(iso: string | null, now: Date): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) {
    return at.toLocaleTimeString(activeLocale, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 7) {
    return at.toLocaleDateString(activeLocale, { weekday: "short" });
  }
  return at.toLocaleDateString(activeLocale, {
    month: "numeric",
    day: "numeric",
  });
}

/**
 * What a right-click on the Bot's conversation offers: the two things that are about the row itself.
 *
 * Pin, Duplicate, Hide and Delete went on 2026-09-24 — ordering, copying and tidying away belonged
 * to a roster of several, and deleting the one Bot is a decision for its profile, where it is asked
 * in a dialog, not a right-click away from the conversation.
 */
function BotRowMenu({
  agentId,
  channelId,
  children,
}: {
  agentId: string;
  channelId: string | undefined;
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setRead = useMutation(setChannelReadMutationOptions(queryClient));

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {/* Only with a conversation to mark: a Bot nobody has spoken to has nothing unread. */}
        {channelId ? (
          <ContextMenuItem
            onClick={() => setRead.mutate({ channelId, read: false })}
          >
            <IconMailOpened />
            {t("Mark as unread")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onClick={() =>
            void navigate({ search: { agent: agentId }, to: "/agents" })
          }
        >
          <IconPencil />
          {t("Edit profile")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The dot beside the Bot's name, per tone: amber for the person's turn, the Bot's colour while it
 * is busy, grey at rest. The conversation header's pill has the same three (`DOT_TONES` in
 * `channels/bot-header.tsx`), which that file keeps to itself.
 */
const PRESENCE_DOT_TONES: Readonly<Record<Presence["tone"], string>> = {
  attention: "animate-pulse bg-warning",
  active: "animate-pulse bg-primary",
  quiet: "bg-muted-foreground/50",
};

/**
 * THE BOT, AT THE TOP OF ITS COLUMN, ON ONE ROW: the face with what it is doing on it, and the
 * name. The way to its profile, which is why the pencil shows on hover.
 *
 * NO LINE OF STATUS WORDS UNDER THE NAME (2026-10-04). It read 쉬는 중 all day under a face that
 * already says so, and the owner's complaint about the column was its words: "아이콘으로도 되는 걸
 * 항상 글자로 표시하는 게 문제". So what the Bot is doing is a dot beside the name, and the word is
 * the dot's name and title — and the link's own name, as it always was, for whoever cannot see a
 * dot. ONE WORD IS STILL DRAWN: when the Bot is waiting on the person, the amber pill stays, with
 * 확인 필요 or 도움 필요 in it, because that is the one state that asks them for something and a
 * dot changing colour at the edge of what somebody is reading is not them being asked.
 *
 * Drawn here rather than through the header's `PresencePillBody`: the conversation's header is
 * having the same done to it on another branch, in that component, and the two would have met in
 * one file. When both are in, one of them can read the other.
 */
function BotIdentity({
  agent,
  isCompact,
  lastMessageAt,
}: {
  agent: AgentProfile;
  isCompact: boolean;
  lastMessageAt: string | undefined;
}) {
  const presence = usePresence(agent.id);
  const mood = useBotMood({
    working: presence.tone === "active",
    blocked: presence.tone === "attention",
    lastMessageAt,
  });
  const face = mood === "working" ? presence.face : mood;
  const word = t(presence.label);
  const label = `${agent.name} · ${word}`;

  if (isCompact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label={label}
              className={cn(
                "flex h-12 w-full items-center justify-center rounded-xl border border-transparent transition-colors hover:bg-accent data-[status=active]:bg-sidebar-accent",
                focusRing,
              )}
              search={{ agent: agent.id }}
              to="/agents"
            />
          }
        >
          <BotAvatar seed={agent.avatarSeed} size={36} state={face} />
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  const isAsking = presence.tone === "attention";
  return (
    <Link
      aria-label={`${label}. ${t("Bot profile")}`}
      className={cn(
        "group flex h-11 w-full items-center gap-2 rounded-xl border border-transparent px-2 transition-colors hover:bg-accent data-[status=active]:bg-sidebar-accent",
        focusRing,
      )}
      search={{ agent: agent.id }}
      to="/agents"
    >
      <BotAvatar
        className="shrink-0"
        seed={agent.avatarSeed}
        size={32}
        state={face}
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate font-semibold text-base">
          {agent.name}
        </span>
        {isAsking ? (
          <span
            className={cn(PILL_CLASS, PILL_TONES.attention, "shrink-0")}
            data-presence="attention"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                PRESENCE_DOT_TONES.attention,
              )}
            />
            <span className="truncate">{word}</span>
          </span>
        ) : (
          <span
            aria-label={word}
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              PRESENCE_DOT_TONES[presence.tone],
            )}
            data-presence={presence.tone}
            role="img"
            title={word}
          />
        )}
      </span>
      {/* Not beside the pill: at 216px there is room for the name and one of the two. */}
      {isAsking ? null : (
        <IconPencil
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      )}
    </Link>
  );
}

/**
 * THE PLACES A PERSON GOES TO LOOK (muse-shape plan §4): the rows under the conversation, rather than
 * the footer's places that change how the Bot works. 아이디어 came first (phase 5), 만든 것 with its
 * page (phase 6), 소식 on top with its posts (phase 7), and 목표 last, with its own (phase 9), in the
 * plan's order: 소식 · 아이디어 · 목표 · 만든 것. One line each, an icon and the place's name: they
 * were kept that short for 오늘, which lived on the height under them until 2026-10-04, and a
 * place's name needs no more.
 *
 * THE NAMES STAY, in a column that lost most of its other words that day. These rows are how a
 * person gets about, and navigation by icon alone is what the rail's five unlabelled icons were at
 * 375px (UI/UX audit 0.5.3, item 20) — the phone's bar was given its labels for that.
 */
const LOOK_ROWS = [
  { to: "/feed", icon: IconLayoutList, label: "Updates", row: "feed" },
  { to: "/ideas", icon: IconBulb, label: "Ideas", row: "ideas" },
  { to: "/goals", icon: IconTarget, label: "Goals", row: "goals" },
  { to: "/made", icon: IconLayoutGrid, label: "Made", row: "made" },
] as const;

/**
 * 목표's number: how many goals are in progress (plan §3.4, "a sidebar row with the active count").
 * Quiet, not the mark 소식's count wears — nothing here is new, it is what is being worked on.
 */
function ActiveGoals({ isCompact }: { isCompact: boolean }) {
  const goals = useQuery(goalsQueryOptions());
  const count = goals.data?.active ?? 0;
  if (count <= 0 || isCompact) return null;
  return (
    <span
      className="ml-auto text-muted-foreground text-xs tabular-nums"
      data-active-goals
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t("{count} in progress", { count })}</span>
    </span>
  );
}

/**
 * 소식's count of posts not yet seen (phase 7): the one number on these rows, because it is the one
 * that changes without the person doing anything. Nothing drawn at zero or while it loads.
 */
function UnseenCount({ isCompact }: { isCompact: boolean }) {
  const unseen = useQuery(feedUnseenQueryOptions());
  const count = unseen.data ?? 0;
  if (count <= 0) return null;
  const label = t("{count} new", { count });
  return isCompact ? (
    <span
      aria-hidden="true"
      className="absolute top-1 right-2 size-2 rounded-full bg-mark"
    />
  ) : (
    <span
      className="ml-auto rounded-full bg-mark px-1.5 font-medium text-white text-xs leading-5"
      data-unseen-count
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function LookRow({
  icon: Icon,
  isCompact,
  label,
  row,
  to,
}: (typeof LOOK_ROWS)[number] & { isCompact: boolean }) {
  const icon = <Icon aria-hidden="true" className="size-4.5 shrink-0" />;
  if (isCompact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label={t(label)}
              className={cn(NAV_LINK_CLASS, "relative justify-center")}
              to={to}
            />
          }
        >
          {icon}
          {row === "feed" ? <UnseenCount isCompact /> : null}
          {row === "goals" ? <ActiveGoals isCompact /> : null}
        </TooltipTrigger>
        <TooltipContent side="right">{t(label)}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link
      className={cn(NAV_LINK_CLASS, "gap-2.5 px-2.5")}
      data-sidebar-row={row}
      to={to}
    >
      {icon}
      {t(label)}
      {row === "feed" ? <UnseenCount isCompact={false} /> : null}
      {row === "goals" ? <ActiveGoals isCompact={false} /> : null}
    </Link>
  );
}

/**
 * THE CONVERSATION: one row like the four under it — an icon, 대화, and a dot at the right edge
 * when something in it is unread.
 *
 * IT CARRIED THE LAST THING SAID AND WHEN UNTIL 2026-10-04, at the roster row's 54px: the
 * preview a roster of several needs to tell which colleague said what. With one Bot it was a
 * sentence the person had just read, or was a press away from reading, drawn again beside the
 * conversation it came from — and it was the longest run of words in the column the owner asked to
 * have fewer words in. What a routine is doing as it runs went with it; the face and the dot beside
 * the name say the Bot is busy. The several-Bots list keeps its preview (`bot-row.tsx`).
 *
 * In the rail it is what it was: the icon in its tile, the dot on the tile's corner.
 */
function ConversationRow({
  agentId,
  channelId,
  isCompact,
  unread,
}: {
  agentId: string;
  channelId: string | undefined;
  isCompact: boolean;
  unread: boolean;
}) {
  const name = t("Conversation");
  const announced = unread ? `${name} · ${t("Unread")}` : name;
  const destination = channelId
    ? ({ params: { channelId }, to: "/channel/$channelId" } as const)
    : ({ search: { agent: agentId }, to: "/channel/new" } as const);

  if (isCompact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label={announced}
              className={ROSTER_RAIL_ROW_CLASS}
              {...destination}
            />
          }
        >
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <IconMessageCircle aria-hidden="true" className="size-4.5" />
            {unread ? <RosterUnreadDot /> : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{name}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      className={cn(NAV_LINK_CLASS, "gap-2.5 px-2.5")}
      data-sidebar-row="conversation"
      {...destination}
    >
      <IconMessageCircle aria-hidden="true" className="size-4.5 shrink-0" />
      {name}
      {unread ? (
        <>
          <span
            aria-hidden="true"
            className="ml-auto size-2 shrink-0 rounded-full bg-mark"
            data-mark="unread"
          />
          <span className="sr-only">{t("Unread")}</span>
        </>
      ) : null}
    </Link>
  );
}

export function BotSidebar() {
  const agents = useQuery(agentListQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  const mine = useMyBots();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [signOutError, setSignOutError] = useState<string | null>(null);
  /** `모두 멈추기`'s dialog. Outside the menu, which closes on the press that opens it. */
  const [stoppingAll, setStoppingAll] = useState(false);
  /*
   * The person's override at a narrow width, and only there: above `lg` the full column is simply
   * what the sidebar is, so this state has nothing to say.
   */
  const [isRailExpanded, setIsRailExpanded] = useState(false);
  const isWide = useIsWideViewport();
  const isRail = !isWide && !isRailExpanded;
  const working = useQuery(workingQueryOptions());
  /*
   * What is drawn is what was read — the answer, or the one from before when refreshing it failed —
   * and never data a refusal has said this account cannot have.
   */
  const bots = useReading(agents);
  const conversations = useReading(channels);
  const channelList = settledOf(conversations)?.data;
  /*
   * The clock, as an input: "14:32" becomes a weekday at midnight only if something redraws the
   * row then.
   */
  const now = useNow();
  const isLegacy = (mine.bots?.length ?? 0) > 1;

  /*
   * A run ending is the moment a routine's answer lands in the conversation, and nothing pushes
   * that to the browser — the socket carries only what a browser reported. The working poll
   * already notices the run end; this turns that into a refresh of the conversations, so the
   * delivered answer and its unread dot appear within a poll interval.
   */
  const workingIds = (working.data ?? []).map((run) => run.agentId).join(",");
  const previousWorkingIds = useRef(workingIds);
  useEffect(() => {
    const before = new Set(
      previousWorkingIds.current.split(",").filter(Boolean),
    );
    const after = new Set(workingIds.split(",").filter(Boolean));
    previousWorkingIds.current = workingIds;
    if ([...before].some((id) => !after.has(id))) {
      void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      // And 소식's count: a feed run's posts land when it ends, and nothing else says so (phase 7).
      void queryClient.invalidateQueries({ queryKey: feedKeys.all });
      // And 목표's: a goal is saved, and progress logged, by a turn or a check-in run (phase 9).
      void queryClient.invalidateQueries({ queryKey: goalKeys.all });
    }
  }, [workingIds, queryClient]);

  const rows = (mine.bots ?? []).map((agent) => {
    const channel = conversationOf(agent.id, channelList);
    const run = working.data?.find((entry) => entry.agentId === agent.id);
    return {
      agent,
      channel,
      // The last thing said; before anything has been, nothing — a Bot has no job title to show.
      subtitle: channel?.lastMessage ?? undefined,
      at: channel ? (channel.lastMessageAt ?? channel.createdAt) : null,
      working: run ? workingLabel(run) : undefined,
    };
  });

  const line = rosterNotice({ bots, conversations });
  /** Asks again for whichever of the two lists failed; a list that answered is left alone. */
  const handleRetry = () => {
    if (bots.state === "failed") void agents.refetch();
    if (conversations.state === "failed") void channels.refetch();
  };

  const handleSignOut = async () => {
    setSignOutError(null);
    try {
      await signOut.mutateAsync();
    } catch {
      // The surface's own words, never what was thrown (`settings/index.tsx` says what that drew).
      setSignOutError(t("Could not log out."));
      return;
    }
    await navigate({ to: "/sign" });
  };

  const railToggleLabel = isRail
    ? t("Expand the sidebar")
    : t("Collapse the sidebar");

  /*
   * Only below `lg`. Above it the full column is the sidebar, and a control whose only effect would
   * be to take it away on a window that has room for it is a control worth not drawing. Not on a
   * phone either, where there is no column to narrow.
   */
  const railToggle = isWide ? null : (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-expanded={!isRail}
            aria-label={railToggleLabel}
            className={cn(ICON_BUTTON_CLASS, "max-md:hidden")}
            onClick={() => setIsRailExpanded((expanded) => !expanded)}
            type="button"
          />
        }
      >
        {isRail ? (
          <IconLayoutSidebarLeftExpand className="size-4" />
        ) : (
          <IconLayoutSidebarLeftCollapse className="size-4" />
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">{railToggleLabel}</TooltipContent>
    </Tooltip>
  );

  const [only] = rows;
  const links = footerLinksFor(isLegacy);

  /*
   * WHO IS SIGNED IN, as the picture's name and title: the name and the address, whichever there
   * are. One of them was written out beside the picture until 2026-10-04 — the name, or the
   * address where there was none, which was the longest word in the column and one a person reads
   * once. Both are a hover away now, and a screen reader's. The rail's picture is named as it
   * always was, by the one that used to be written out.
   *
   * In two statements: joined and defaulted in one, the React Compiler left the whole column
   * uncompiled ("Unexpected terminal kind `optional` for logical test block").
   */
  const signedInAs = [currentUser?.name, currentUser?.email]
    .filter((part) => Boolean(part))
    .join(" · ");
  const accountName = isRail
    ? currentUser?.name || currentUser?.email || t("Account")
    : signedInAs || t("Account");

  /*
   * ONE BUTTON AT THE FOOT, AND ONE LIST UNDER IT, SINCE 2026-10-06. It was two buttons since
   * 2026-10-04 — the account's picture, opening 모두 멈추기 · 설정 · 로그아웃, and 메뉴 beside it,
   * opening the places — and the owner, looking for 설정 in the installed app, read the pair as one
   * thing drawn twice: "각각 별개인 건 아닌 듯. 합쳐야 함." So the picture and the menu's icon are
   * one button with one name, and everything either opened is in the one list.
   *
   * THE PLACES — 수첩 · 루틴 · 스킬 · 연결 · 도움말, the same list the phone's 메뉴 page draws
   * (`places.ts`) — ARE STILL A PRESS AWAY AND NOT ROWS OF THE COLUMN (muse-shape plan §4, settled
   * with phase 9). Measured at 1024×640, the PC app's smallest window, in the Korean app with all
   * four rows above (소식 · 아이디어 · 목표 · 만든 것 at 170–320): with 수첩 · 루틴 · 연결 · 더 보기
   * as rows the footer began at 420 and cut what stood under those rows, which ran to 426; folded
   * into one row it began at 534. What stood there (오늘) left the column on 2026-10-04 and the
   * places stayed folded: four rows of words back in sight is what the owner asked to have less of.
   * The price is a second press for 수첩 and 루틴.
   *
   * THE ORDER. 모두 멈추기 first, because it is the one item here somebody reaches for in a hurry:
   * a conversation and a routine can both be running, and Stop lives inside one conversation at a
   * time. Then the places, then what is about the account, and leaving last.
   */
  const menuName = `${t("Menu")} · ${accountName}`;
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={menuName}
            className={
              isRail
                ? "h-10 w-full justify-center px-0 font-normal text-sm hover:bg-accent"
                : "h-10 w-full justify-between rounded-lg px-1 font-normal hover:bg-accent"
            }
            data-sidebar-menu
            title={menuName}
            variant="ghost"
          />
        }
      >
        {/* The person's own picture when the provider handed one over, which all three do. */}
        <PersonAvatar
          email={currentUser?.email}
          image={currentUser?.image}
          name={currentUser?.name}
          size="sm"
        />
        {/* 64px does not seat the picture and the icon side by side: the rail keeps the picture. */}
        {isRail ? null : (
          <IconMenu2
            aria-hidden="true"
            className="mr-1.5 size-4.5 shrink-0 text-muted-foreground"
          />
        )}
      </DropdownMenuTrigger>
      {/*
       * A width of its own in the full column, 192px, as both lists had when each opened from a
       * 36px button and would have taken that width by default.
       */}
      <DropdownMenuContent
        align="start"
        className={isRail ? "p-1.5" : "w-48 p-1.5"}
        side="top"
      >
        <DropdownMenuItem
          className="gap-2 px-2 py-1.5"
          onClick={() => setStoppingAll(true)}
        >
          <IconPlayerStop />
          {t("Stop everything")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {links.map(({ icon: Icon, label: name, to }) => (
          <DropdownMenuItem
            className="gap-2 px-2 py-1.5"
            key={to}
            render={<Link to={to} />}
          >
            <Icon />
            {t(name)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {currentUser?.role === "admin" ? (
          <DropdownMenuItem
            className="gap-2 px-2 py-1.5"
            render={<Link to="/admin" />}
          >
            <IconShieldLock />
            {t("Admin")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="gap-2 px-2 py-1.5"
          render={<Link to="/settings" />}
        >
          <IconSettings />
          {t("Settings")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 px-2 py-1.5"
          disabled={signOut.isPending}
          onClick={handleSignOut}
          variant="destructive"
        >
          <IconLogout />
          {signOut.isPending ? t("Logging out…") : t("Log out")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /* Outside the menu, which closes on click: an error inside it dies with the interaction. */
  const underAccount = (
    <>
      {signOutError ? (
        <p className="px-2 pt-1 text-destructive text-xs" role="alert">
          {signOutError}
        </p>
      ) : null}
      <StopAllDialog onOpenChange={setStoppingAll} open={stoppingAll} />
    </>
  );

  return (
    <nav
      aria-label={t("Your Bot")}
      className={cn(
        "flex h-full shrink-0 select-none flex-col border-border border-r bg-sidebar transition-[width,translate] duration-200 ease-out",
        isRail ? "w-16" : "w-sidebar",
        /*
         * Not drawn on a phone, and HIDDEN HERE rather than by the seam around it: that seam's class
         * dresses only its own fallback, and with the sheet's classes gone the rail stood 812px tall
         * in the phone's column and pushed the bar off the screen (measured at 375).
         */
        "max-md:hidden",
      )}
    >
      {/*
       * The title row is the height of the window chrome it sits under, so the desktop build's
       * traffic lights land in it. AND IT IS THE WINDOW'S HANDLE: the shell sets `titleBarStyle:
       * "Overlay"`, so without `data-tauri-drag-region` the reserved row could not move the window.
       * The attribute is inert in a browser tab.
       */}
      <div
        className={cn(
          "flex h-titlebar shrink-0 items-center gap-0.5 px-2.5",
          isRail ? "justify-center" : "justify-end",
        )}
        data-tauri-drag-region
      >
        {railToggle}
      </div>

      {/*
       * THE LINE, OVER THE ROW AND MOUNTED BEFORE IT SPEAKS. The rail keeps the words for a screen
       * reader and has no room to show them; its press is the button in the list below.
       */}
      <ReadNotice
        className={isRail ? "sr-only" : "justify-center px-4 pb-2 text-center"}
        hasButton={!isRail}
        line={line}
        onRetry={handleRetry}
        size="compact"
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        {mine.bots === undefined && !mine.isError ? (
          <div className={cn("flex flex-col gap-2 py-2", !isRail && "px-2")}>
            <Skeleton
              className={
                isRail ? "mx-auto size-9 rounded-xl" : "h-11 w-full rounded-xl"
              }
            />
            <Skeleton
              className={
                isRail ? "mx-auto size-9 rounded-xl" : "h-9 w-full rounded-lg"
              }
            />
          </div>
        ) : null}

        {/* One Bot: who it is, then its conversation. */}
        {!isLegacy && only ? (
          <>
            <BotIdentity
              agent={only.agent}
              isCompact={isRail}
              lastMessageAt={only.channel?.lastMessageAt ?? undefined}
            />
            <ul className="mt-1 flex flex-col gap-0.5">
              <li>
                <BotRowMenu
                  agentId={only.agent.id}
                  channelId={only.channel?.id}
                >
                  <ConversationRow
                    agentId={only.agent.id}
                    channelId={only.channel?.id}
                    isCompact={isRail}
                    unread={only.channel?.unread ?? false}
                  />
                </BotRowMenu>
              </li>
              {LOOK_ROWS.map((place) => (
                <li key={place.to}>
                  <LookRow {...place} isCompact={isRail} />
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {/* Several, on an account from before the cap: see the component's comment. */}
        {isLegacy ? (
          <>
            {isRail ? null : (
              <p className="px-2 pt-1 pb-1.5 text-muted-foreground text-xs">
                {t("Your Bots")}
              </p>
            )}
            <ul aria-label={t("Your Bots")} className="flex flex-col gap-0.5">
              {rows.map(({ agent, channel, subtitle, at, working: doing }) => (
                <li key={agent.id}>
                  <BotRowMenu agentId={agent.id} channelId={channel?.id}>
                    <BotRow
                      agentId={agent.id}
                      avatarSeed={agent.avatarSeed}
                      channelId={channel?.id}
                      isCompact={isRail}
                      lastMessageAt={rosterTime(at, now)}
                      name={agent.name}
                      subtitle={subtitle}
                      unread={channel?.unread ?? false}
                      {...(doing ? { working: doing } : {})}
                    />
                  </BotRowMenu>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {/*
         * The rail has no room for a sentence, so it keeps only what somebody has to act on — a
         * list that could not be read — as a button with its sentence in the tooltip.
         */}
        {isRail && line?.kind === "failed" ? (
          <div className="flex justify-center py-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label={`${line.message} ${t("Try again")}`}
                    className={ICON_BUTTON_CLASS}
                    onClick={handleRetry}
                    type="button"
                  />
                }
              >
                <IconRefresh className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="right">{line.message}</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>

      {/*
       * THE FOOT: the one button, at either width. PINNED, outside the part that scrolls: when the
       * places scrolled with the rows above them, the smallest window put 루틴, 스킬, 연결 and
       * 도움말 below the fold (UX review 0.5.4, item 4). No word is written beside it — the owner
       * had the column's words cut to the ones that navigate ("아이콘으로도 되는 걸 항상 글자로
       * 표시하는 게 문제", 2026-10-04), and this is not a place but the way to a list of them.
       *
       * AND, ONLY WHILE THERE IS A NEWER VERSION, ONE ROW OVER IT (`update-notice.tsx`). The foot is
       * where this column keeps what is about the app rather than about the Bot, and it does not
       * scroll, so the row is in sight at 1024×640 and covers nothing. It draws nothing otherwise:
       * the foot is the one button every other day.
       */}
      <div
        className="shrink-0 border-border border-t px-2 py-2"
        data-sidebar-nav
      >
        <UpdateNotice className="pb-1" shape={isRail ? "icon" : "row"} />
        {menu}
        {underAccount}
      </div>
    </nav>
  );
}
