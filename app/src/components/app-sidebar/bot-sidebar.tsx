import {
  IconBox,
  IconClock,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconHelp,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMailOpened,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShieldLock,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BotRow } from "@/components/app-sidebar/bot-row";
import { GroupRow } from "@/components/app-sidebar/group-row";
import { PersonAvatar } from "@/components/avatar/person-avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPreferencesMutationOptions,
} from "@/lib/agents/mutations";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { workingLabel, workingQueryOptions } from "@/lib/agents/working";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setChannelReadMutationOptions } from "@/lib/channels/mutations";
import { channelKeys, channelListQueryOptions } from "@/lib/channels/queries";
import { activeLocale, t } from "@/lib/i18n";
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

/** The nav that is not a colleague. Small, at the bottom, so the faces own the column. */
const FOOTER_LINKS = [
  { to: "/routines", icon: IconClock, label: "Routines" },
  { to: "/skills", icon: IconBox, label: "Skills" },
  /*
   * A LIGHTNING BOLT SAID NOTHING ABOUT BOTS. It was the one glyph in the footer that named no part
   * of the product — speed, power, an integration, take your pick — sitting under a column of faces
   * it leads back to. People are what this screen is made of, so people is the icon.
   */
  { to: "/agents", icon: IconUsers, label: "Bots" },
  /*
   * ONE `?`, AT THE BOTTOM. The help page and the 문의·의견 box behind it are the only way a person
   * who is stuck can say so; a way out that lives only under Settings is a way out that a person
   * who does not know where Settings is cannot take.
   */
  { to: "/help", icon: IconHelp, label: "Help" },
] as const;

/**
 * The titlebar's controls, with a real focus ring.
 *
 * The eye and the `+` were hand-rolled elements carrying a hover fill and nothing else, so tabbing
 * to either of them changed nothing on screen. `buttonVariants` is the app's one source for that
 * ring. The sand ghost fills are put back over it because `--sand-fill-ghost-hover` is a grey alpha
 * that works in both themes, where `ghost`'s own `hover:bg-muted` needs a dark-mode variant to.
 */
const ICON_BUTTON_CLASS = cn(
  buttonVariants({ size: "icon-sm", variant: "ghost" }),
  "text-muted-foreground hover:bg-[var(--sand-fill-ghost-hover)] hover:text-foreground dark:hover:bg-[var(--sand-fill-ghost-hover)]",
);

/** The footer's links, sharing the roster rows' focus ring for the same reason they now have one. */
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
 * The time a roster row shows: clock for today, weekday inside a week, date beyond it.
 *
 * The same shape a mail client uses, and for the same reason — "14:32" answers "how long ago" only
 * while today is still today, and a bare date answers it only once it is not.
 *
 * `activeLocale` IS PASSED, and it was not. With no locale argument the browser answers with its
 * own, so a Korean-language app on an en-US machine printed "Sat" and "9/6" down a column of Korean
 * names — the one place in the roster where the app's language setting reached nothing.
 */
function rosterTime(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const now = new Date();
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
 * What the roster's right-click menu can do, made once for the whole roster.
 *
 * THE MUTATIONS ARE NOT PER ROW. `BotRowMenu` wraps every `BotRow`, and it used to call
 * `useMutation` five times inside itself — so a roster of twelve Bots stood up sixty mutation
 * subscriptions to the query cache, all of them subscribed to the same five mutation keys, and
 * every one of them re-rendered its row's wrapper on any mutation anywhere. `BotRow` is memoised
 * and its props are all primitives, so the row itself was never the cost; its wrapper was.
 *
 * One set at the list level, handed down. The menu below is now a plain function component with no
 * hooks at all, which is as cheap as an element tree gets.
 */
type RowActions = {
  setPinned: (agentId: string, pinned: boolean) => void;
  markUnread: (channelId: string) => void;
  editProfile: (agentId: string) => void;
  duplicate: (agentId: string) => void;
  setHidden: (agentId: string, hidden: boolean) => void;
  remove: (agentId: string, channelId: string | undefined) => void;
};

function useRowActions(): RowActions {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const preferences = useMutation(
    setAgentPreferencesMutationOptions(queryClient),
  );
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const remove = useMutation(deleteAgentMutationOptions(queryClient));
  const setRead = useMutation(setChannelReadMutationOptions(queryClient));

  const preferencesMutate = preferences.mutate;
  const setHiddenMutate = setHidden.mutate;
  const setReadMutate = setRead.mutate;
  const duplicateAsync = duplicate.mutateAsync;
  const removeAsync = remove.mutateAsync;

  return useMemo(
    () => ({
      setPinned: (agentId, pinned) =>
        preferencesMutate({ agentId, patch: { pinned } }),
      markUnread: (channelId) => setReadMutate({ channelId, read: false }),
      editProfile: (agentId) => {
        void navigate({ search: { agent: agentId }, to: "/agents" });
      },
      duplicate: (agentId) => {
        void duplicateAsync(agentId).then((copy) =>
          navigate({ search: { agent: copy.id }, to: "/agents" }),
        );
      },
      setHidden: (agentId, hidden) => setHiddenMutate({ agentId, hidden }),
      remove: (agentId, channelId) => {
        void removeAsync(agentId).then(() => {
          if (channelId) void navigate({ to: "/" });
        });
      },
    }),
    [
      duplicateAsync,
      navigate,
      preferencesMutate,
      removeAsync,
      setHiddenMutate,
      setReadMutate,
    ],
  );
}

/**
 * The right-click menu on a roster row.
 *
 * Every item here is something the product could already do and had buried: pin lives on the new
 * per-person preference, and hide, duplicate and delete were three buttons stacked at the bottom of
 * a side panel you had to open the Bot to reach. A roster is a list of things you act on, and the
 * gesture for acting on a row in a list is a right-click.
 *
 * "Move to section" is deliberately absent rather than disabled: it has no state behind it — there
 * are no sections — and a menu item that cannot do anything is a promise the product does not keep.
 */
function BotRowMenu({
  actions,
  agent,
  channelId,
  children,
}: {
  actions: RowActions;
  agent: AgentProfile;
  channelId: string | undefined;
  children: React.ReactNode;
}) {
  const pinned = agent.pinnedAt !== null;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => actions.setPinned(agent.id, !pinned)}>
          {pinned ? <IconPinnedOff /> : <IconPin />}
          {pinned ? t("Unpin") : t("Pin")}
        </ContextMenuItem>

        {/*
         * Only where there is a conversation to mark. A Bot nobody has spoken to has no room, and
         * an item that silently does nothing is worse than one that is not offered.
         */}
        {channelId ? (
          <ContextMenuItem onClick={() => actions.markUnread(channelId)}>
            <IconMailOpened />
            {t("Mark as unread")}
          </ContextMenuItem>
        ) : null}

        <ContextMenuItem onClick={() => actions.editProfile(agent.id)}>
          <IconPencil />
          {t("Edit profile")}
        </ContextMenuItem>

        <ContextMenuItem onClick={() => actions.duplicate(agent.id)}>
          <IconCopy />
          {t("Duplicate")}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          onClick={() => actions.setHidden(agent.id, !agent.hidden)}
        >
          {agent.hidden ? <IconEye /> : <IconEyeOff />}
          {agent.hidden ? t("Unhide") : t("Hide from sidebar")}
        </ContextMenuItem>

        {/*
         * Only for a Bot this person can actually manage. The server refuses the rest, and offering
         * Delete on a coworker the deployment shipped is a menu item whose only outcome is an error.
         */}
        {agent.canManage ? (
          <ContextMenuItem
            onClick={() => actions.remove(agent.id, channelId)}
            variant="destructive"
          >
            <IconTrash />
            {t("Delete")}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function BotSidebar() {
  const agents = useQuery(agentListQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /*
   * Hiding a Bot took it out of the roster with no way back from the roster — the only route to
   * unhide was the Agents page, which is a different screen for a thing you did here. Hermes' Bot
   * Mode answers this with an eye that only appears once something is hidden; so does this.
   */
  const [showingHidden, setShowingHidden] = useState(false);
  /*
   * The person's override at a narrow width, and only there: above `lg` the full column is simply
   * what the sidebar is, so this state has nothing to say.
   */
  const [isRailExpanded, setIsRailExpanded] = useState(false);
  const isWide = useIsWideViewport();
  const isRail = !isWide && !isRailExpanded;
  const hidden = useQuery(agentListQueryOptions(true));
  const working = useQuery(workingQueryOptions());
  const searchId = useId();
  const rowActions = useRowActions();

  /** A Bot's conversation, once it has one. Single-Bot channels only; a group is not a colleague. */
  const channelFor = useMemo(() => {
    const byAgent = new Map<
      string,
      {
        id: string;
        createdAt: string;
        lastMessage: string | null;
        lastMessageAt: string | null;
        unread: boolean;
      }
    >();
    /*
     * THE OLDEST solo channel is the Bot's conversation — the same rule `create` uses on the
     * server, which is what the Home screen and the compose screen send through. The list arrives
     * newest-first, so taking the first match picked the NEWEST, and on an account with legacy
     * duplicates (every early send minted a channel) the roster row and the composer were two
     * different conversations with one colleague.
     */
    const oldestFirst = [...(channels.data ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const channel of oldestFirst) {
      if (channel.agentIds.length !== 1) continue;
      const agentId = channel.agentIds[0];
      if (!agentId || byAgent.has(agentId)) continue;
      byAgent.set(agentId, {
        id: channel.id,
        createdAt: channel.createdAt,
        lastMessage: channel.lastMessage,
        lastMessageAt: channel.lastMessageAt,
        unread: channel.unread,
      });
    }
    return byAgent;
  }, [channels.data]);

  /*
   * ORDERED BY WHO SPOKE LAST, then by name for the Bots who never have.
   *
   * A roster sorted by creation date is a list of when you hired people; sorted by last activity it
   * is a list of what is happening. The search is a plain substring over the name, the role and the
   * last message — the three things visible in a row, so nothing is filtered on that cannot be seen.
   */
  /**
   * The rooms with more than one Bot in them.
   *
   * They cannot be rows on the Bot list above, because that list is keyed on the Bot and a group
   * has no single Bot to belong to — which is why they were skipped entirely rather than filtered
   * out: there was no slot to put one in. The server has created, named and listed them all along.
   */
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(activeLocale);
    return (channels.data ?? [])
      .filter((channel) => channel.agentIds.length > 1)
      .filter((channel) =>
        needle
          ? `${channel.name} ${channel.lastMessage ?? ""}`
              .toLocaleLowerCase(activeLocale)
              .includes(needle)
          : true,
      )
      .map((channel) => ({
        channel,
        /*
         * A channel is named after its members, and until somebody speaks the last message is the
         * first one — so the preview would repeat the title back in a smaller size. Who is in the
         * room stands in, because the alternative was an empty second line, and an empty second
         * line is exactly what made a room row look like a different kind of row from a Bot's.
         */
        subtitle:
          channel.lastMessage &&
          !channel.name.startsWith(channel.lastMessage.trim())
            ? channel.lastMessage
            : t("{count} Bots in this room", {
                count: channel.agentIds.length,
              }),
        at: channel.lastMessageAt ?? channel.createdAt,
        unread: channel.unread,
      }));
  }, [channels.data, query]);

  /*
   * A run ending is the moment a routine's answer lands in a room, and nothing pushes that to the
   * browser — the socket carries only what a browser reported. The working poll already notices
   * the run end; this turns that into a roster refresh, so the delivered answer and its unread dot
   * appear within a poll interval rather than whenever the list next happens to refetch.
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

  /** Bot id to what it is doing, so a row is one map lookup rather than a scan per render. */
  const workingByAgent = useMemo(() => {
    const byAgent = new Map<string, string>();
    for (const run of working.data ?? []) {
      byAgent.set(run.agentId, workingLabel(run));
    }
    return byAgent;
  }, [working.data]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(activeLocale);
    return (agents.data ?? [])
      .map((agent) => {
        const channel = channelFor.get(agent.id);
        return {
          agent,
          channel,
          subtitle: channel?.lastMessage ?? agent.title ?? undefined,
          /*
           * The same rule a room row uses — `lastMessageAt ?? createdAt`, which is the server's own
           * `coalesce` — so that a colleague and a room on the same list are never one with a time
           * and one without. A Bot nobody has opened yet still has no channel and so still has no
           * time, which is the only honest answer for it.
           */
          at: channel ? (channel.lastMessageAt ?? channel.createdAt) : null,
        };
      })
      .filter(({ agent, subtitle }) =>
        needle
          ? `${agent.name} ${agent.title ?? ""} ${subtitle ?? ""}`
              .toLocaleLowerCase(activeLocale)
              .includes(needle)
          : true,
      )
      .sort((a, b) => {
        /*
         * Pinned first, and pinned Bots hold their own order by WHEN they were pinned — not by
         * activity like everything else. Sorting the pinned group by recency would re-shuffle it
         * on every message, which is the one thing a pin exists to stop.
         */
        const pinA = a.agent.pinnedAt;
        const pinB = b.agent.pinnedAt;
        if (pinA && pinB) return pinA.localeCompare(pinB);
        if (pinA) return -1;
        if (pinB) return 1;

        if (a.at && b.at) return b.at.localeCompare(a.at);
        if (a.at) return -1;
        if (b.at) return 1;
        return a.agent.name.localeCompare(b.agent.name);
      });
  }, [agents.data, channelFor, query]);

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

  const handleToggleRail = () => {
    const willExpand = !isRailExpanded;
    /*
     * Collapsing takes the search field away with it. A rail quietly holding a filter would read as
     * colleagues having gone missing, with no field on screen to explain why.
     */
    if (!willExpand) setQuery("");
    setIsRailExpanded(willExpand);
  };

  const railToggleLabel = isRail
    ? t("Expand the sidebar")
    : t("Collapse the sidebar");

  /*
   * Only below `lg`. Above it the full column is the sidebar, and a control whose only effect would
   * be to take the roster away on a window that has room for it is a control worth not drawing.
   */
  const railToggle = isWide ? null : (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-expanded={!isRail}
            aria-label={railToggleLabel}
            className={ICON_BUTTON_CLASS}
            onClick={handleToggleRail}
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

  /* Only once there is something to reveal: an eye over an empty set is a control that teaches
   * nothing and never does anything. */
  const hiddenToggle =
    (hidden.data ?? []).length > 0 ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={
                showingHidden ? t("Hide hidden Bots") : t("Show hidden Bots")
              }
              aria-pressed={showingHidden}
              className={cn(
                ICON_BUTTON_CLASS,
                "aria-pressed:bg-[var(--sand-fill-ghost-selected)] aria-pressed:text-foreground",
              )}
              onClick={() => setShowingHidden((on) => !on)}
              type="button"
            />
          }
        >
          {showingHidden ? (
            <IconEyeOff className="size-4" />
          ) : (
            <IconEye className="size-4" />
          )}
        </TooltipTrigger>
        <TooltipContent side={isRail ? "right" : "bottom"}>
          {showingHidden ? t("Hide hidden Bots") : t("Show hidden Bots")}
        </TooltipContent>
      </Tooltip>
    ) : null;

  const newChannelButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label={t("Start a new channel")}
            className={ICON_BUTTON_CLASS}
            to="/channel/new"
          />
        }
      >
        <IconPlus className="size-4" />
      </TooltipTrigger>
      <TooltipContent side={isRail ? "right" : "bottom"}>
        {t("Start a new channel")}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <nav
      aria-label={t("Your team")}
      className="flex h-full shrink-0 flex-col border-border border-r bg-sidebar transition-[width] duration-200 ease-out"
      style={{ width: isRail ? RAIL_WIDTH : SIDEBAR_WIDTH }}
    >
      {/*
       * The title row is the height of the window chrome it sits under, so the desktop build's
       * traffic lights land in it instead of on top of the search field.
       *
       * AND IT IS THE WINDOW'S HANDLE. The shell sets `titleBarStyle: "Overlay"`, which puts the
       * traffic lights over this row and takes away the bar the window used to be dragged by — so
       * without `data-tauri-drag-region` the reserved 44px was empty space that also could not move
       * the window. The attribute is inert in a browser tab.
       */}
      <div
        className={cn(
          "flex h-[var(--sand-titlebar-block)] shrink-0 items-center gap-0.5 px-2.5",
          isRail ? "justify-center" : "justify-end",
        )}
        data-tauri-drag-region
      >
        {railToggle}
        {isRail ? null : hiddenToggle}
        {isRail ? null : newChannelButton}
      </div>

      {isRail ? (
        /* 64px cannot hold a search field, and the two controls the titlebar has no width for stack
         * under it rather than vanishing along with the words. */
        <div className="flex shrink-0 flex-col items-center gap-1 px-2 pb-2">
          {newChannelButton}
          {hiddenToggle}
        </div>
      ) : (
        <div className="shrink-0 px-2.5 pb-2">
          {/* A label, not a placeholder: the placeholder disappears the moment somebody types. */}
          <label className="sr-only" htmlFor={searchId}>
            {t("Search your team")}
          </label>
          <div className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--sand-fill-secondary)] px-2.5 text-muted-foreground focus-within:outline focus-within:outline-2 focus-within:outline-ring">
            <IconSearch className="size-3.5 shrink-0" />
            <input
              className="min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
              id={searchId}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search")}
              type="search"
              value={query}
            />
          </div>
        </div>
      )}

      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {agents.isPending
          ? [0, 1, 2].map((slot) => (
              <li
                className={cn("py-2", isRail ? "flex justify-center" : "px-2")}
                key={slot}
              >
                <Skeleton
                  className={
                    isRail ? "size-9 rounded-lg" : "h-[38px] w-full rounded-lg"
                  }
                />
              </li>
            ))
          : rows.map(({ agent, channel, subtitle, at }) => (
              <li key={agent.id}>
                <BotRowMenu
                  actions={rowActions}
                  agent={agent}
                  channelId={channel?.id}
                >
                  <BotRow
                    agentId={agent.id}
                    avatarSeed={agent.avatarSeed}
                    channelId={channel?.id}
                    isCompact={isRail}
                    lastMessageAt={rosterTime(at)}
                    name={agent.name}
                    pinned={agent.pinnedAt !== null}
                    subtitle={subtitle}
                    unread={channel?.unread ?? false}
                    {...(workingByAgent.has(agent.id)
                      ? { working: workingByAgent.get(agent.id) }
                      : {})}
                  />
                </BotRowMenu>
              </li>
            ))}
        {showingHidden
          ? (hidden.data ?? []).map((agent) => (
              <li className="opacity-50" key={`hidden:${agent.id}`}>
                <BotRowMenu
                  actions={rowActions}
                  agent={agent}
                  channelId={channelFor.get(agent.id)?.id}
                >
                  <BotRow
                    agentId={agent.id}
                    avatarSeed={agent.avatarSeed}
                    channelId={channelFor.get(agent.id)?.id}
                    isCompact={isRail}
                    lastMessageAt={t("Hidden")}
                    name={agent.name}
                    subtitle={agent.title}
                  />
                </BotRowMenu>
              </li>
            ))
          : null}

        {groups.map(({ channel, subtitle, at, unread }) => (
          <li key={channel.id}>
            <GroupRow
              channelId={channel.id}
              isCompact={isRail}
              lastMessageAt={rosterTime(at)}
              name={channel.name}
              participantIds={channel.agentIds}
              subtitle={subtitle}
              unread={unread}
            />
          </li>
        ))}

        {/* A roster that filtered to nothing is not an empty roster, and must not read as one. The
         * rail has no room for either sentence and no search field to have caused one. */}
        {!agents.isPending &&
        !isRail &&
        rows.length === 0 &&
        groups.length === 0 ? (
          <li className="px-2 py-6 text-center text-muted-foreground text-sm">
            {query.trim() ? t("Nobody matches that.") : t("No Bots yet.")}
          </li>
        ) : null}
      </ul>

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
            {/* The person's own picture when the provider handed one over, which all three do.
                It was two grey letters built inline here, and for a Korean name they were one
                syllable by accident rather than by rule. */}
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
      </div>
    </nav>
  );
}
