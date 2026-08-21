import {
  IconBolt,
  IconBox,
  IconClock,
  IconCopy,
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
import { useId, useMemo, useState } from "react";
import { BotRow } from "@/components/app-sidebar/bot-row";
import { GroupRow } from "@/components/app-sidebar/group-row";
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
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setChannelReadMutationOptions } from "@/lib/channels/mutations";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
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
  { to: "/agents", icon: IconBolt, label: "Agents" },
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
 * The right-click menu on a roster row.
 *
 * Every item here is something the product could already do and had buried: pin lives on the new
 * per-person preference, and hide, duplicate and delete were three buttons stacked at the bottom of
 * a side panel you had to open the Bot to reach. A roster is a list of things you act on, and the
 * gesture for acting on a row in a list is a right-click.
 *
 * "Mark unread" and "Move to section" are deliberately absent rather than disabled: neither has any
 * state behind it — there is no read tracking and there are no sections — and a menu item that
 * cannot do anything is a promise the product does not keep.
 */
function BotRowMenu({
  agent,
  channelId,
  children,
}: {
  agent: AgentProfile;
  channelId: string | undefined;
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const preferences = useMutation(
    setAgentPreferencesMutationOptions(queryClient),
  );
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const remove = useMutation(deleteAgentMutationOptions(queryClient));
  const setRead = useMutation(setChannelReadMutationOptions(queryClient));
  const pinned = agent.pinnedAt !== null;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => {
            preferences.mutate({
              agentId: agent.id,
              patch: { pinned: !pinned },
            });
          }}
        >
          {pinned ? <IconPinnedOff /> : <IconPin />}
          {pinned ? t("Unpin") : t("Pin")}
        </ContextMenuItem>

        {/*
         * Only where there is a conversation to mark. A Bot nobody has spoken to has no room, and
         * an item that silently does nothing is worse than one that is not offered.
         */}
        {channelId ? (
          <ContextMenuItem
            onClick={() => {
              setRead.mutate({ channelId, read: false });
            }}
          >
            <IconMailOpened />
            {t("Mark as unread")}
          </ContextMenuItem>
        ) : null}

        <ContextMenuItem
          onClick={() => {
            void navigate({ search: { agent: agent.id }, to: "/agents" });
          }}
        >
          <IconPencil />
          {t("Edit profile")}
        </ContextMenuItem>

        <ContextMenuItem
          onClick={async () => {
            const copy = await duplicate.mutateAsync(agent.id);
            await navigate({ search: { agent: copy.id }, to: "/agents" });
          }}
        >
          <IconCopy />
          {t("Duplicate")}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          onClick={() => {
            setHidden.mutate({ agentId: agent.id, hidden: true });
          }}
        >
          <IconEyeOff />
          {t("Hide from sidebar")}
        </ContextMenuItem>

        {/*
         * Only for a Bot this person can actually manage. The server refuses the rest, and offering
         * Delete on a coworker the deployment shipped is a menu item whose only outcome is an error.
         */}
        {agent.canManage ? (
          <ContextMenuItem
            onClick={async () => {
              await remove.mutateAsync(agent.id);
              if (channelId) await navigate({ to: "/" });
            }}
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
  const searchId = useId();
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();

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
    for (const channel of channels.data ?? []) {
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

  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <nav
      aria-label={t("Your team")}
      className="flex h-full shrink-0 flex-col border-border border-r bg-sidebar"
      style={{ width: SIDEBAR_WIDTH }}
    >
      {/*
       * The title row is the height of the window chrome it sits under, so the desktop build's
       * traffic lights land in it instead of on top of the search field.
       */}
      <div className="flex h-[var(--sand-titlebar-block)] shrink-0 items-center justify-end px-2.5">
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
                <BotRowMenu agent={agent} channelId={channel?.id}>
                  <BotRow
                    agentId={agent.id}
                    avatarSeed={agent.avatarSeed}
                    channelId={channel?.id}
                    lastMessageAt={rosterTime(at)}
                    name={agent.name}
                    pinned={agent.pinnedAt !== null}
                    subtitle={subtitle}
                    unread={channel?.unread ?? false}
                  />
                </BotRowMenu>
              </li>
            ))}
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
            <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--sand-fill-secondary)] text-muted-foreground text-xs">
              {initials}
            </span>
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
