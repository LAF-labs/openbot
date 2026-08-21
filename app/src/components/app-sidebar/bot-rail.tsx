import {
  IconBolt,
  IconBox,
  IconClock,
  IconLogout,
  IconPlus,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkOptions, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Mascot } from "@/components/agents/mascot";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { t } from "@/lib/i18n";

/**
 * The team, as a column of faces.
 *
 * A 340px rail with names, previews and timestamps is a web page's answer, and it spent a third of
 * a laptop screen restating what the faces already say. This product caps a roster at a handful of
 * Bots, each drawn as a distinct character, so an icon column is legible at a glance and hands the
 * conversation back the 270px — which is the difference between a page with a sidebar and an app.
 *
 * Names are not lost, they are on hover and in the accessible name. Nothing else about a colleague
 * belongs here: a Bot has one conversation, so there is no thread to preview and no choice to make
 * between several of them.
 */
const RAIL_WIDTH = 72;

/** The nav that is not a colleague, kept small and at the bottom so the faces own the column. */
const FOOTER_LINKS = [
  { to: "/routines", icon: IconClock, label: "Routines" },
  { to: "/skills", icon: IconBox, label: "Skills" },
  { to: "/agents", icon: IconBolt, label: "Agents" },
] as const;

function RailButton({
  children,
  label,
  ...link
}: {
  children: React.ReactNode;
  label: string;
} & LinkOptions) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label={label}
            className="flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground data-[status=active]:bg-foreground/8 data-[status=active]:text-foreground"
            {...link}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function BotRail() {
  const agents = useQuery(agentListQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [signOutError, setSignOutError] = useState<string | null>(null);
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();

  /** A Bot's conversation, once it has one. Single-Bot channels only; a group is not a colleague. */
  const channelFor = new Map<string, string>();
  for (const channel of channels.data ?? []) {
    if (channel.agentIds.length !== 1) continue;
    const agentId = channel.agentIds[0];
    if (agentId && !channelFor.has(agentId))
      channelFor.set(agentId, channel.id);
  }

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
      className="flex h-full shrink-0 flex-col items-center gap-1 border-border border-r bg-sidebar py-2"
      style={{ width: RAIL_WIDTH }}
    >
      <RailButton label={t("Start a new channel")} to="/channel/new">
        <IconPlus className="size-5" />
      </RailButton>

      <div className="my-1 h-px w-8 shrink-0 bg-border" />

      <ul className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto no-scrollbar">
        {agents.isPending
          ? [0, 1, 2].map((slot) => (
              <li key={slot}>
                <Skeleton className="size-11 rounded-xl" />
              </li>
            ))
          : (agents.data ?? []).map((agent) => {
              const channelId = channelFor.get(agent.id);
              const label = agent.title
                ? `${agent.name} · ${agent.title}`
                : agent.name;
              return (
                <li key={agent.id}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        channelId ? (
                          <Link
                            aria-label={label}
                            className="flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-foreground/5 data-[status=active]:bg-foreground/10"
                            params={{ channelId }}
                            to="/channel/$channelId"
                          />
                        ) : (
                          <Link
                            aria-label={label}
                            className="flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-foreground/5 data-[status=active]:bg-foreground/10"
                            search={{ agent: agent.id }}
                            to="/channel/new"
                          />
                        )
                      }
                    >
                      <span className="inline-flex size-8 overflow-hidden rounded-full ring-1 ring-border">
                        <Mascot
                          className="size-full object-cover"
                          seed={agent.avatarSeed}
                          size={32}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right">{label}</TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
      </ul>

      <div className="my-1 h-px w-8 shrink-0 bg-border" />

      {FOOTER_LINKS.map(({ to, icon: Icon, label }) => (
        <RailButton key={to} label={t(label)} to={to}>
          <Icon className="size-5" />
        </RailButton>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={
                currentUser?.name || currentUser?.email || t("Account")
              }
              className="size-11 rounded-xl"
              size="icon"
              variant="ghost"
            />
          }
        >
          <span className="flex size-8 items-center justify-center overflow-hidden rounded-full bg-muted-foreground/10 text-foreground/70 text-xs">
            {initials}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="p-1.5" side="right">
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
        <p className="px-1 text-[10px] text-destructive" role="alert">
          {signOutError}
        </p>
      ) : null}
    </nav>
  );
}
