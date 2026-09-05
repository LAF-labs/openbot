import {
  IconBolt,
  IconBox,
  IconClock,
  IconCopy,
  IconEye,
  IconEyeOff,
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
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BotRow } from "@/components/app-sidebar/bot-row";
import { GroupRow } from "@/components/app-sidebar/group-row";
import { PersonAvatar } from "@/components/avatar/person-avatar";
import { Button } from "@/components/ui/button";
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
import { t } from "@/lib/i18n";

/**
 * THE ROSTER: 280px, one row per colleague, newest first.
 *
 * This replaced a 72px column of faces, which was the wrong read of the reference. An icon rail
 * suits a product where the column is a switcher between workspaces; here the column IS the inbox.
 * A row carries the face, the name, when the Bot last spoke and what it said — and it is that
 * preview line that lets somebody glance at the window and know which of four Bots needs them,
 * without opening any of them. A face alone cannot say "3 orders are sorted, take a look".
 *
 * A Bot has exactly one conversation, so a row is never a session and the list never grows a second
 * entry for the same colleague.
 */
const SIDEBAR_WIDTH = "var(--sand-sidebar-width)";

/** The nav that is not a colleague. Small, at the bottom, so the faces own the column. */
const FOOTER_LINKS = [
  { to: "/routines", icon: IconClock, label: "Routines" },
  { to: "/skills", icon: IconBox, label: "Skills" },
  { to: "/agents", icon: IconBolt, label: "Bots" },
] as const;

/**
 * The time a roster row shows: clock for today, weekday inside a week, date beyond it.
 *
 * The same shape a mail client uses, and for the same reason — "14:32" answers "how long ago" only
 * while today is still today, and a bare date answers it only once it is not.
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
    return at.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: "short" });
  return at.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
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
    const needle = query.trim().toLocaleLowerCase();
    return (channels.data ?? [])
      .filter((channel) => channel.agentIds.length > 1)
      .filter((channel) =>
        needle
          ? `${channel.name} ${channel.lastMessage ?? ""}`
              .toLocaleLowerCase()
              .includes(needle)
          : true,
      )
      .map((channel) => ({
        channel,
        // A channel is named after its members, and until somebody speaks the last message is the
        // first one — so the preview would repeat the title back in a smaller size.
        subtitle:
          channel.lastMessage &&
          !channel.name.startsWith(channel.lastMessage.trim())
            ? channel.lastMessage
            : undefined,
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
    const needle = query.trim().toLocaleLowerCase();
    return (agents.data ?? [])
      .map((agent) => {
        const channel = channelFor.get(agent.id);
        return {
          agent,
          channel,
          subtitle: channel?.lastMessage ?? agent.title ?? undefined,
          at: channel?.lastMessageAt ?? null,
        };
      })
      .filter(({ agent, subtitle }) =>
        needle
          ? `${agent.name} ${agent.title ?? ""} ${subtitle ?? ""}`
              .toLocaleLowerCase()
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

  return (
    <nav
      aria-label={t("Your team")}
      className="flex h-full shrink-0 flex-col border-border border-r bg-sidebar"
      style={{ width: SIDEBAR_WIDTH }}
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
        className="flex h-[var(--sand-titlebar-block)] shrink-0 items-center justify-end gap-0.5 px-2.5"
        data-tauri-drag-region
      >
        {/* Only once there is something to reveal: an eye over an empty set is a control that
         * teaches nothing and never does anything. */}
        {(hidden.data ?? []).length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label={
                    showingHidden
                      ? t("Hide hidden Bots")
                      : t("Show hidden Bots")
                  }
                  aria-pressed={showingHidden}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--sand-fill-ghost-hover)] hover:text-foreground aria-pressed:bg-[var(--sand-fill-ghost-selected)] aria-pressed:text-foreground"
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
            <TooltipContent side="bottom">
              {showingHidden ? t("Hide hidden Bots") : t("Show hidden Bots")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                aria-label={t("Start a new channel")}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--sand-fill-ghost-hover)] hover:text-foreground"
                to="/channel/new"
              />
            }
          >
            <IconPlus className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("Start a new channel")}
          </TooltipContent>
        </Tooltip>
      </div>

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

      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {agents.isPending
          ? [0, 1, 2].map((slot) => (
              <li className="px-2 py-2" key={slot}>
                <Skeleton className="h-[38px] w-full rounded-lg" />
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
              lastMessageAt={rosterTime(at)}
              name={channel.name}
              participantIds={channel.agentIds}
              subtitle={subtitle}
              unread={unread}
            />
          </li>
        ))}

        {/* A roster that filtered to nothing is not an empty roster, and must not read as one. */}
        {!agents.isPending && rows.length === 0 && groups.length === 0 ? (
          <li className="px-2 py-6 text-center text-muted-foreground text-sm">
            {query.trim() ? t("Nobody matches that.") : t("No Bots yet.")}
          </li>
        ) : null}
      </ul>

      <div className="shrink-0 border-border border-t px-2 py-2">
        {FOOTER_LINKS.map(({ to, icon: Icon, label }) => (
          <Link
            className="flex h-10 items-center gap-2.5 rounded-lg px-2 text-base transition-colors hover:bg-[var(--sand-fill-ghost-hover)] data-[status=active]:bg-[var(--sand-fill-ghost-selected)]"
            key={to}
            to={to}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--sand-fill-secondary)] text-muted-foreground">
              <Icon className="size-3.5" />
            </span>
            {t(label)}
          </Link>
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={
                  currentUser?.name || currentUser?.email || t("Account")
                }
                className="h-10 w-full justify-start gap-2.5 px-2 font-normal text-base hover:bg-[var(--sand-fill-ghost-hover)]"
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
            <span className="min-w-0 truncate">
              {currentUser?.name || currentUser?.email || t("Account")}
            </span>
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
