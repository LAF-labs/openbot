import {
  IconBox,
  IconClock,
  IconHelp,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMailOpened,
  IconMessageCircle,
  IconPencil,
  IconPlayerStop,
  IconPlugConnected,
  IconRefresh,
  IconSettings,
  IconShieldLock,
  IconUserCircle,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BotDay } from "@/components/app-sidebar/bot-day";
import {
  BotRow,
  ROSTER_RAIL_ROW_CLASS,
  ROSTER_ROW_CLASS,
  RosterRowLines,
  RosterUnreadDot,
} from "@/components/app-sidebar/bot-row";
import { StopAllDialog } from "@/components/app-sidebar/stop-all-dialog";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { PersonAvatar } from "@/components/avatar/person-avatar";
import { PresencePillBody } from "@/components/channels/bot-header";
import { usePresence } from "@/components/channels/use-presence";
import { ReadNotice } from "@/components/layout/read-states";
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
import type { AgentProfile } from "@/lib/agents/queries";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { rosterNotice } from "@/lib/agents/roster-state";
import { workingLabel, workingQueryOptions } from "@/lib/agents/working";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setChannelReadMutationOptions } from "@/lib/channels/mutations";
import { channelKeys, channelListQueryOptions } from "@/lib/channels/queries";
import { activeLocale, t } from "@/lib/i18n";
import {
  closeMobileNav,
  registerMobileNav,
  useMobileNavOpen,
} from "@/lib/mobile-nav";
import { settledOf, useReading } from "@/lib/reading";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/**
 * THE SIDEBAR OF ONE BOT (2026-09-24): WHO IT IS, THE CONVERSATION, AND WHERE ELSE TO GO.
 *
 * It was built as a roster — one row per colleague, newest first, a preview line so somebody could
 * glance at four Bots and see which needed them — and after the decision that a person has one Bot
 * (docs/laf/deployment-model.md, "봇은 하나다") it held one row and a footer of links, with the
 * column's whole height of nothing in between. Now it says three things, top to bottom:
 *
 *  1. THE BOT. Its face, alive (the same presence as the conversation's header: working, waiting on
 *     the person, glad it finished), its name, and one word for what it is doing. Pressing it opens
 *     its profile — the only place its name and face change.
 *  2. THE CONVERSATION. One row: the last thing said, when, and whether it is unread — and under
 *     it 오늘, what the Bot did today, what is waiting on the person and what is next
 *     (`bot-day.tsx`), in the height that used to be empty.
 *  3. THE PLACES A PERSON GOES TO CHANGE HOW IT WORKS, right under it rather than pushed to the
 *     bottom, and the account below them all.
 *
 * AN ACCOUNT FROM BEFORE THE CAP CAME DOWN keeps every Bot it had, and reaches them the old way: with
 * more than one, the list under "내 봇" is back, a row per Bot, each its own conversation, and 봇
 * 프로필 is a link again. Nothing else in the app behaves as if there were several.
 *
 * THREE WIDTHS. The full column (280px) at `lg` and up. Below it, a 64px rail of faces and icons with
 * their names in tooltips, which the titlebar's toggle puts back to full for as long as somebody
 * wants — measured at an 800px window, the fixed 280 was 35% of everything the person could see.
 * And below `md`, NO COLUMN: at 375px the rail was 15% of the screen and five unlabelled icons
 * (UI/UX audit 0.5.3, item 20). There the whole column, labels and all, is a sheet that slides over
 * the page from the menu button in each screen's header (`lib/mobile-nav.ts`) and goes away when a
 * place is chosen, on Escape, or on a press outside it. The installed app's window cannot be
 * narrower than 1024 (`desktop/src-tauri/tauri.conf.json`), so the sheet is the phone's and the
 * browser's, never the PC app's.
 */

/**
 * WIDE ENOUGH FOR THE FULL COLUMN — Tailwind's `lg`, read in JavaScript rather than in CSS.
 *
 * A media query in the class list can hide the words but it cannot take them out of the document,
 * and a 64px rail whose names are still in the accessibility tree, still being measured, still being
 * truncated, is a rail only to the eye. `rem` inside a media query is the INITIAL root font size and
 * not this app's 14px root, so 64rem here is the same 1024px `lg:` compiles to.
 *
 * The phone's sheet needs no second query: it is `max-md:` classes, and whether it is out is a
 * press, not a width.
 */
const WIDE_QUERY = "(min-width: 64rem)";

const isWideViewport = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(WIDE_QUERY).matches;

const subscribeToViewport = (onChange: () => void) => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => {};
  }
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  /*
   * AND `resize`, because the media query's own event is not always delivered. Measured: with the
   * window emulated from 800 to 1280 while the tab was backgrounded, `matchMedia(…).matches` read
   * true and the column stayed a rail until the next reload — the `change` never arrived. Dragging
   * a window edge is how this switch is normally reached in the installed app, and a roster that
   * only notices on reload is a roster that noticed nothing. `resize` fires often and costs nothing
   * here: the snapshot is a boolean, so React re-renders only when it actually flips.
   */
  window.addEventListener("resize", onChange);
  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
};

const useIsWideViewport = () =>
  useSyncExternalStore(subscribeToViewport, isWideViewport, () => true);

/**
 * The nav that is not the Bot. Every one of these is somewhere a person goes to change how it works.
 *
 * 연결 IS HERE SINCE 2026-09-24. It lived only under Settings, and with the Bot's own screen gone
 * from the roster the places it signs into are the most-used thing a person sets up. 봇 프로필 is
 * drawn only for an account with several Bots: with one, the Bot at the top of the column is the
 * way to its profile, and the same link twice is a list padding itself out.
 */
const FOOTER_LINKS = [
  { to: "/agents", icon: IconUserCircle, label: "Bot profile" },
  { to: "/routines", icon: IconClock, label: "Routines" },
  { to: "/skills", icon: IconBox, label: "Skills" },
  {
    to: "/settings/connected-accounts",
    icon: IconPlugConnected,
    label: "Connections",
  },
  /*
   * ONE `?`, AT THE BOTTOM. The help page and the 문의·의견 box behind it are the only way a person
   * who is stuck can say so; a way out that lives only under Settings is a way out that a person
   * who does not know where Settings is cannot take.
   */
  { to: "/help", icon: IconHelp, label: "Help" },
] as const;

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

const FooterLink = ({
  icon: Icon,
  isCompact,
  label,
  to,
}: (typeof FOOTER_LINKS)[number] & { isCompact: boolean }) => {
  const icon = <Icon aria-hidden="true" className="size-4.5 shrink-0" />;

  if (isCompact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label={t(label)}
              className={cn(NAV_LINK_CLASS, "justify-center")}
              to={to}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipContent side="right">{t(label)}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link className={cn(NAV_LINK_CLASS, "gap-2.5 px-2.5")} to={to}>
      {icon}
      {t(label)}
    </Link>
  );
};

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
 * THE BOT, AT THE TOP OF ITS COLUMN: the face with what it is doing on it, the name, the one word.
 * The way to its profile, which is why the pencil shows on hover.
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
  const label = `${agent.name} · ${t(presence.label)}`;

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

  return (
    <Link
      aria-label={`${label}. ${t("Bot profile")}`}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border border-transparent px-2 py-2.5 transition-colors hover:bg-accent data-[status=active]:bg-sidebar-accent",
        focusRing,
      )}
      search={{ agent: agent.id }}
      to="/agents"
    >
      <BotAvatar
        className="shrink-0"
        seed={agent.avatarSeed}
        size={44}
        state={face}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-semibold text-lg leading-6">
          {agent.name}
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <PresencePillBody presence={presence} />
        </span>
      </span>
      <IconPencil
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </Link>
  );
}

/** THE CONVERSATION: one row, the last thing said and when, and a dot when it is unread. */
function ConversationRow({
  agentId,
  channelId,
  isCompact,
  subtitle,
  time,
  unread,
  working,
}: {
  agentId: string;
  channelId: string | undefined;
  isCompact: boolean;
  subtitle: string | undefined;
  time: string | undefined;
  unread: boolean;
  working: string | undefined;
}) {
  const icon = (
    <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
      <IconMessageCircle aria-hidden="true" className="size-4.5" />
      {unread ? <RosterUnreadDot /> : null}
    </span>
  );
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
          {icon}
        </TooltipTrigger>
        <TooltipContent side="right">{name}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link className={ROSTER_ROW_CLASS} {...destination}>
      {unread ? <span className="sr-only">{t("Unread")}</span> : null}
      {icon}
      <RosterRowLines
        isSubtitleLive={Boolean(working)}
        isUnread={unread}
        name={name}
        subtitle={working ?? subtitle}
        time={time}
      />
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
  const isMobileOpen = useMobileNavOpen();
  // The phone's sheet is always the full column: it is there to be read.
  const isRail = !isWide && !isRailExpanded && !isMobileOpen;
  const working = useQuery(workingQueryOptions());
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const navRef = useRef<HTMLElement>(null);
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
    }
  }, [workingIds, queryClient]);

  /*
   * THE PHONE'S SHEET GOES AWAY WHEN A PLACE IS CHOSEN — the new screen is what was asked for, and a
   * sheet still covering it is a second press nobody asked to make. And on Escape. And while it is
   * out, the keyboard starts inside it rather than behind it.
   */
  useEffect(registerMobileNav, []);
  const lastPathname = useRef(pathname);
  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    closeMobileNav();
  }, [pathname]);
  useEffect(() => {
    if (!isMobileOpen) return;
    navRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobileNav();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isMobileOpen]);

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
    } catch (caught) {
      setSignOutError(
        caught instanceof Error ? caught.message : t("Could not log out."),
      );
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
   * phone either, where the sheet has its own way out.
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
  const links = FOOTER_LINKS.filter(
    (link) => isLegacy || link.to !== "/agents",
  );

  return (
    <>
      {/* The press outside the sheet that puts it away, on a phone only. */}
      {isMobileOpen ? (
        <button
          aria-label={t("Close the menu")}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={closeMobileNav}
          tabIndex={-1}
          type="button"
        />
      ) : null}
      <nav
        aria-label={t("Your Bot")}
        className={cn(
          "flex h-full shrink-0 select-none flex-col border-border border-r bg-sidebar transition-[width,translate] duration-200 ease-out",
          isRail ? "w-16" : "w-sidebar",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(85vw,300px)] max-md:shadow-popover",
          isMobileOpen
            ? "max-md:translate-x-0"
            : "max-md:invisible max-md:-translate-x-full",
        )}
        ref={navRef}
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
          <button
            aria-label={t("Close the menu")}
            className={cn(ICON_BUTTON_CLASS, "md:hidden")}
            onClick={closeMobileNav}
            type="button"
          >
            <IconX className="size-4" />
          </button>
        </div>

        {/*
         * THE LINE, OVER THE ROW AND MOUNTED BEFORE IT SPEAKS. The rail keeps the words for a screen
         * reader and has no room to show them; its press is the button in the list below.
         */}
        <ReadNotice
          className={
            isRail ? "sr-only" : "justify-center px-4 pb-2 text-center"
          }
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
                  isRail
                    ? "mx-auto size-9 rounded-xl"
                    : "h-11 w-full rounded-xl"
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
                      subtitle={only.subtitle}
                      time={rosterTime(only.at, now)}
                      unread={only.channel?.unread ?? false}
                      working={only.working}
                    />
                  </BotRowMenu>
                </li>
              </ul>
              {/*
               * 오늘: what the Bot did today, between its conversation and the links. Not in the
               * rail, which has no room for a sentence — the face's dot already says something waits.
               */}
              {isRail ? null : (
                <BotDay
                  botId={only.agent.id}
                  onLeave={closeMobileNav}
                  placement="sidebar"
                />
              )}
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
                {rows.map(
                  ({ agent, channel, subtitle, at, working: doing }) => (
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
                  ),
                )}
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

          <div
            className="mt-2 flex flex-col gap-0.5 border-border border-t pt-2"
            data-sidebar-nav
          >
            {links.map((link) => (
              <FooterLink {...link} isCompact={isRail} key={link.to} />
            ))}
          </div>
        </div>

        <div className="shrink-0 border-border border-t px-2 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={
                    currentUser?.name || currentUser?.email || t("Account")
                  }
                  className={cn(
                    "h-10 w-full font-normal text-sm hover:bg-accent",
                    isRail
                      ? "justify-center px-0"
                      : "justify-start gap-2.5 px-2",
                  )}
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
              {isRail ? null : (
                <span className="min-w-0 truncate">
                  {currentUser?.name || currentUser?.email || t("Account")}
                </span>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="p-1.5" side="top">
              {/*
               * FIRST IN THE MENU, because it is the one item here somebody reaches for in a hurry: a
               * conversation and a routine can both be running, and Stop lives inside one
               * conversation at a time.
               */}
              <DropdownMenuItem
                className="gap-2 px-2 py-1.5"
                onClick={() => setStoppingAll(true)}
              >
                <IconPlayerStop />
                {t("Stop everything")}
              </DropdownMenuItem>
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

          {/* Outside the menu, which closes on click: an error inside it dies with the interaction. */}
          {signOutError ? (
            <p className="px-2 pt-1 text-destructive text-xs" role="alert">
              {signOutError}
            </p>
          ) : null}
          <StopAllDialog onOpenChange={setStoppingAll} open={stoppingAll} />
        </div>
      </nav>
    </>
  );
}
