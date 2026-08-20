import {
  IconBolt,
  IconBox,
  IconClock,
  IconLogout,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkOptions, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { t } from "@/lib/i18n";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Channel } from "./channel";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;
const settingsLinkOptions = { to: "/settings" } satisfies LinkOptions;

const userMenuItemClassName = "gap-2 px-2 py-1.5";

/**
 * One rhythm for the footer nav. The stacked active+hover variant outranks the
 * plain hover by specificity, so hovering the row you are on does not dip it
 * back to the lighter hover fill.
 */
const footerRowClassName =
  "h-10 hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:hover:bg-foreground/8";

const footerLinks = [
  { to: "/routines", icon: IconClock, label: "Routines" },
  // Beside Agents rather than inside Admin: writing a skill is something anybody does.
  { to: "/skills", icon: IconBox, label: "Skills" },
  { to: "/agents", icon: IconBolt, label: "Agents" },
] as const;

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <div className="size-8 bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
      {initials}
    </div>
  );
}

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

const ENTRANCE_SECONDS = 0.2;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name and the last thing said in it, because those are the two things the
 * row actually shows — searching against something invisible returns results a person cannot
 * account for. Message history beyond the last line is not here to search: it lives in the thread
 * store, and reaching for it is a server endpoint rather than a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function ChannelRow({
  channel,
  animateOrder,
  animateRows,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  /**
   * Whether a row appearing or disappearing is worth animating.
   *
   * FALSE WHILE SEARCHING, AND THE FLAG ABOVE WAS NOT ENOUGH. `animateOrder` only ever governed
   * `layout`, so filtering still ran the full fade-and-drop entrance on every keystroke: the list
   * thrashed under somebody who was still typing, and the moving target was the very thing they
   * were trying to read.
   */
  animateRows: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
  const still = !animateRows || shouldReduceMotion;
  return (
    // `li`, because this is one row of the roster's list. See the <ul> that wraps it.
    <motion.li
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={
        animateRows
          ? {
              opacity: 0,
              transform: shouldReduceMotion ? "none" : "translateY(-8px)",
            }
          : false
      }
      exit={still ? { opacity: 1 } : { opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={
        still ? { duration: 0 } : { duration: ENTRANCE_SECONDS, ease: EASE_OUT }
      }
    >
      <Channel
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        lastMessage={channel.lastMessage ?? undefined}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt)
            : undefined
        }
      />
    </motion.li>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const channels = useQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const [search, setSearch] = useState("");
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const searching = search.trim().length > 0;
  const visibleChannels = matchingChannels(channels.data, search);
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;

  /*
   * A FAILED SIGN-OUT MUST SAY SO. It was an unhandled rejection: the menu closed, the session
   * stayed open, and somebody who signed out on a shared machine walked away believing they had.
   */
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
    <Sidebar {...props}>
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row gap-1.5">
            <SidebarMenuButton
              className="font-semibold text-[14px] tracking-tighter h-full leading-tight"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  {appConfig.brand.productName}
                </Link>
              )}
            />
            <Button
              // An icon with no text needs a name, or it announces itself as "link".
              aria-label={t("Start a new channel")}
              size="icon"
              variant="ghost"
              render={(props) => (
                <Link
                  {...props}
                  to="/channel/new"
                  activeProps={{
                    className: "bg-foreground/8",
                  }}
                />
              )}
            >
              <IconPlus />
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      {/*
       * The box stays with the rail, not with the list it filters. Inside the scroller it left the
       * screen as soon as anybody scrolled — so clearing a search, on the roster that a search had
       * just made long, meant scrolling back up to find the control that caused it.
       */}
      <div className="shrink-0 px-2 pb-2">
        <InputGroup className="bg-background text-sm rounded-lg h-9">
          <InputGroupInput
            aria-label={t("Search channels")}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search...")}
            value={search}
          />
          <InputGroupAddon>
            <IconSearch />
          </InputGroupAddon>
        </InputGroup>
      </div>
      <SidebarContent className="scroll-fade-b">
        <SidebarMenu>
          <SidebarGroup className="gap-px pt-0">
            {/*
             * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
             * used yet needs telling how to start. A roster that simply does not match what is in
             * the box has to say so and quote it back — told "you don't have channels yet" while
             * holding a typo, a person reads their conversations as gone.
             */}
            {/*
             * Quiet text, not a dashed box: a 248px sidebar has no room for furniture, and an
             * outlined panel reads as a broken widget rather than an absence.
             */}
            {searching && visibleChannels.length === 0 ? (
              <Empty className="py-12">
                <EmptyHeader className="gap-1">
                  <EmptyTitle className="text-[13px]">
                    {t("No channels match your search")}
                  </EmptyTitle>
                  <EmptyDescription className="text-[12px]/relaxed text-pretty">
                    {t(
                      "Nothing here is named “{query}”, and nobody has said it recently either.",
                      { query: search.trim() },
                    )}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {/*
             * A FAILED FETCH IS NOT AN EMPTY ROSTER, AND SAYING SO IS ALARMING. The list rendered
             * nothing at all when /api/channels failed, so a person whose network blinked watched
             * every conversation they have ever had disappear from the rail with no explanation.
             */}
            {channels.isError ? (
              <Empty className="gap-2 py-12">
                <EmptyHeader className="gap-1">
                  <EmptyTitle className="text-[13px]">
                    {t("Your channels could not be loaded.")}
                  </EmptyTitle>
                  <EmptyDescription className="text-[12px]/relaxed text-pretty">
                    {t("They are still there. This was a problem reaching us.")}
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  onClick={() => void channels.refetch()}
                  size="sm"
                  variant="ghost"
                >
                  {t("Try again")}
                </Button>
              </Empty>
            ) : null}
            {channels.isPending ? (
              <div className="flex flex-col gap-px py-1" aria-hidden>
                {[0, 1, 2, 3, 4].map((slot) => (
                  <div className="flex items-center gap-2 px-2 py-2" key={slot}>
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-2.5 w-5/6" />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {!searching && channels.data?.length === 0 ? (
              <Empty className="py-12">
                <EmptyHeader className="gap-1">
                  <EmptyTitle className="text-[13px]">
                    {t("You don't have channels yet")}
                  </EmptyTitle>
                  <EmptyDescription className="text-[12px]/relaxed text-pretty">
                    {t(
                      "Start talking to agents and your channels will appear here.",
                    )}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {/*
             * A LIST, NAMED, AND SAID TO BE ONE. The roster was a stack of divs, so a screen reader
             * announced a run of links with no count and no boundary — no way to know how many
             * conversations there are or where the list ends. The rows are `<li>` (see ChannelRow)
             * and the skeleton, empty and error blocks stay outside, because none of them is a row.
             */}
            <nav aria-label={t("Conversations")}>
              <ul className="flex flex-col gap-px">
                <AnimatePresence initial={false}>
                  {visibleChannels.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      animateOrder={animateOrder}
                      animateRows={!searching}
                      channel={channel}
                    />
                  ))}
                </AnimatePresence>
              </ul>
            </nav>
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-px">
          {footerLinks.map(({ to, icon: Icon, label }) => (
            <SidebarMenuItem key={to}>
              <SidebarMenuButton
                className={footerRowClassName}
                render={(props) => <Link {...props} to={to} />}
              >
                {/* size-8 matches the roster avatar column, so labels share one left edge. */}
                <div className="size-8 flex items-center justify-center text-muted-foreground group-data-[status=active]/menu-button:text-foreground">
                  <Icon />
                </div>
                <span className="text-sm tracking-tight">{t(label)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                <span className="text-sm tracking-tight">
                  {currentUser?.name || currentUser?.email}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {/* Admin routes are server-guarded; hide the entry for users who cannot open them. */}
                {currentUser?.role === "admin" ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    render={<Link {...adminLinkOptions} />}
                  >
                    <IconShieldLock />
                    {t("Admin")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  render={<Link {...settingsLinkOptions} />}
                >
                  <IconSettings />
                  {t("Settings")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  disabled={signOut.isPending}
                  onClick={handleSignOut}
                  variant="destructive"
                >
                  <IconLogout />
                  {signOut.isPending ? t("Logging out…") : t("Log out")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          {/*
           * Outside the menu, which closes on click: an error rendered inside it would be destroyed
           * by the very interaction that produced it.
           */}
          {signOutError ? (
            <SidebarMenuItem>
              <p
                className="px-2 py-1 text-[11px] text-destructive"
                role="alert"
              >
                {signOutError}
              </p>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/** Locale-aware relative timestamp, e.g. "2 minutes ago". */
function relativeTime(iso: string) {
  const elapsed = Date.now() - new Date(iso).getTime();
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return relativeFormat.format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}
