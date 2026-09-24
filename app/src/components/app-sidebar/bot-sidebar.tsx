import {
  IconBox,
  IconClock,
  IconHelp,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMailOpened,
  IconPencil,
  IconPlayerStop,
  IconPlugConnected,
  IconRefresh,
  IconSettings,
  IconShieldLock,
  IconUserCircle,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BotRow } from "@/components/app-sidebar/bot-row";
import { StopAllDialog } from "@/components/app-sidebar/stop-all-dialog";
import { PersonAvatar } from "@/components/avatar/person-avatar";
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
import { conversationOf, useMyBots } from "@/lib/agents/my-bots";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { rosterNotice } from "@/lib/agents/roster-state";
import { workingLabel, workingQueryOptions } from "@/lib/agents/working";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setChannelReadMutationOptions } from "@/lib/channels/mutations";
import { channelKeys, channelListQueryOptions } from "@/lib/channels/queries";
import { activeLocale, t } from "@/lib/i18n";
import { settledOf, useReading } from "@/lib/reading";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/**
 * THE ROSTER: 280px, one row per colleague, newest first — and a 64px rail when the window is not
 * wide enough to spend 280 on it.
 *
 * The full column replaced a 72px strip of faces, which was the wrong read of the reference. An icon
 * rail suits a product where the column is a switcher between workspaces; here the column IS the
 * inbox. A row carries the face, the name, when the Bot last spoke and what it said — and it is that
 * preview line that lets somebody glance at the window and know which of four Bots needs them,
 * without opening any of them. A face alone cannot say "3 orders are sorted, take a look".
 *
 * THE RAIL IS WHAT HAPPENS WHEN THERE IS NO ROOM FOR THAT ARGUMENT. Measured at an 800px window,
 * the fixed 280 was 35% of everything the person could see, and the conversation — the thing they
 * came for — got the rest. Below `lg` the column drops to faces with their names in tooltips, and
 * the toggle in the titlebar puts the full list back for as long as somebody wants it. It is a
 * width, not a mode: nothing else about the roster changes.
 *
 * A Bot has exactly one conversation, so a row is never a session and the list never grows a second
 * entry for the same colleague.
 */

/**
 * WIDE ENOUGH FOR THE FULL COLUMN — Tailwind's `lg`, read in JavaScript rather than in CSS.
 *
 * A media query in the class list can hide the words but it cannot take them out of the document,
 * and a 64px rail whose names are still in the accessibility tree, still being measured, still being
 * truncated, is a rail only to the eye. `rem` inside a media query is the INITIAL root font size and
 * not this app's 14px root, so 64rem here is the same 1024px `lg:` compiles to.
 */
/**
 * The two widths this column has, as values rather than as classes.
 *
 * `--sand-sidebar-width` is the token that decides how wide the open column is, and written into a
 * class it becomes `w-[var(--sand-…)]` — a raw variable in a class string, which is what
 * `app/tests/design-tokens.test.ts` counts as drift. The rail's 64px sits beside it so the two are
 * read from one place.
 */
const SIDEBAR_WIDTH = "var(--sand-sidebar-width)";
const RAIL_WIDTH = "4rem";

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
 * The nav that is not the Bot. The Bot is the row at the top, and every one of these is somewhere
 * a person goes to change how it works.
 *
 * 연결 IS HERE SINCE 2026-09-24. It lived only under Settings, and with the Bot's own screen gone
 * from the roster the places it signs into are the most-used thing a person sets up.
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
 * that ring; the sand ghost fills are put back over it because they work in both themes.
 */
const ICON_BUTTON_CLASS = cn(
  buttonVariants({ size: "icon-sm", variant: "ghost" }),
  "text-muted-foreground hover:bg-[var(--sand-fill-ghost-hover)] hover:text-foreground dark:hover:bg-[var(--sand-fill-ghost-hover)]",
);

/** The footer's links, sharing the Bot row's focus ring. */
const NAV_LINK_CLASS = `flex h-10 items-center rounded-lg border border-transparent bg-clip-padding text-base outline-none transition-colors hover:bg-[var(--sand-fill-ghost-hover)] ${focusRing} data-[status=active]:bg-[var(--sand-fill-ghost-selected)]`;

const FooterLink = ({
  icon: Icon,
  isCompact,
  label,
  to,
}: (typeof FOOTER_LINKS)[number] & { isCompact: boolean }) => {
  const badge = (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--sand-fill-secondary)] text-muted-foreground">
      <Icon className="size-3.5" />
    </span>
  );

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
          {badge}
        </TooltipTrigger>
        <TooltipContent side="right">{t(label)}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link className={cn(NAV_LINK_CLASS, "gap-2.5 px-2")} to={to}>
      {badge}
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
 * What a right-click on the Bot's row offers: the two things that are about the row itself.
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
 * THE SIDEBAR OF ONE BOT (2026-09-24).
 *
 * It was a roster: a search field, an eye for hidden Bots, a `+` for a new conversation, a row per
 * Bot sorted by who spoke last, a row per room, and "새 봇" where the list was empty. A person has
 * one Bot now (docs/laf/deployment-model.md, "봇은 하나다"), so the column is that Bot — its row is
 * the way back to the conversation, which is where everything happens — and the places a person
 * goes to change how it works.
 *
 * AN ACCOUNT FROM BEFORE THE CAP CAME DOWN keeps every Bot it had, and this is how it reaches them:
 * with more than one, the row becomes a short list under "내 봇", each one its own conversation. It
 * is drawn only in that case; nothing else in the app behaves as if there were several.
 */
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
   * be to take it away on a window that has room for it is a control worth not drawing.
   */
  const railToggle = isWide ? null : (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-expanded={!isRail}
            aria-label={railToggleLabel}
            className={ICON_BUTTON_CLASS}
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

  return (
    <nav
      aria-label={t("Your Bot")}
      className="flex h-full shrink-0 flex-col border-border border-r bg-sidebar transition-[width] duration-200 ease-out"
      style={{ width: isRail ? RAIL_WIDTH : SIDEBAR_WIDTH }}
    >
      {/*
       * The title row is the height of the window chrome it sits under, so the desktop build's
       * traffic lights land in it. AND IT IS THE WINDOW'S HANDLE: the shell sets `titleBarStyle:
       * "Overlay"`, so without `data-tauri-drag-region` the reserved row could not move the window.
       * The attribute is inert in a browser tab.
       */}
      <div
        className={cn(
          "flex h-[var(--sand-titlebar-block)] shrink-0 items-center gap-0.5 px-2.5",
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
        {/* Only on an account that still has several: see the component's comment. */}
        {isLegacy && !isRail ? (
          <p className="px-2 pt-1 pb-1.5 text-muted-foreground text-xs">
            {t("Your Bots")}
          </p>
        ) : null}
        <ul
          aria-label={isLegacy ? t("Your Bots") : undefined}
          className="flex flex-col gap-0.5"
        >
          {mine.bots === undefined && !mine.isError
            ? [0].map((slot) => (
                <li
                  className={cn(
                    "py-2",
                    isRail ? "flex justify-center" : "px-2",
                  )}
                  key={slot}
                >
                  <Skeleton
                    className={
                      isRail
                        ? "size-9 rounded-lg"
                        : "h-[38px] w-full rounded-lg"
                    }
                  />
                </li>
              ))
            : rows.map(({ agent, channel, subtitle, at, working: doing }) => (
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
          {/*
           * The rail has no room for a sentence, so it keeps only what somebody has to act on — a
           * list that could not be read — as a button with its sentence in the tooltip.
           */}
          {isRail && line?.kind === "failed" ? (
            <li className="flex justify-center py-2">
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
            </li>
          ) : null}
        </ul>
      </div>

      <div className="shrink-0 border-border border-t px-2 py-2">
        {FOOTER_LINKS.map((link) => (
          <FooterLink {...link} isCompact={isRail} key={link.to} />
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={
                  currentUser?.name || currentUser?.email || t("Account")
                }
                className={cn(
                  "h-10 w-full font-normal text-base hover:bg-[var(--sand-fill-ghost-hover)]",
                  isRail ? "justify-center px-0" : "justify-start gap-2.5 px-2",
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
  );
}
