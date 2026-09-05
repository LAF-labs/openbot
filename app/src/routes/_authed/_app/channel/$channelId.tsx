import { IconDeviceDesktop, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { ChannelAvatar } from "@/components/channels/avatar";
import { BotPanel } from "@/components/channels/bot-panel";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ParticipantsMenu } from "@/components/channels/participants-menu";
import { GroupChat } from "@/components/channels/group-chat";
import { useNeedsYou } from "@/components/computer/needs-you";
import { DetailPanel } from "@/components/layout/detail-panel";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { t } from "@/lib/i18n";

const chatSearchSchema = z
  .object({
    settings: z.boolean().optional(),
    /** Opens the Bot's screen in the shared detail pane. */
    watch: z.boolean().optional(),
  })
  /* `.catch({})` so `?settings=yes` is ignored rather than throwing out of
   * validateSearch and taking the whole route down with it. */
  .catch({});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/** Shared detail pane width for the live screen view. */
/*
 * 320px, the same as the pane's resting width — see DEFAULT_DETAIL_WIDTH.
 *
 * Watching used to widen the pane to 400px, which took 80px off the conversation every time
 * somebody glanced at the screen and gave it back when they looked away. The thumbnail is a
 * thumbnail; full size is a click on it.
 */
const SCREEN_PANEL_WIDTH = 320;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  /**
   * THE TWO REQUESTS THIS SCREEN CANNOT DRAW WITHOUT, STARTED TOGETHER AND BEFORE IT MOUNTS.
   *
   * On mount, the channel was fetched first; the Bot's id only exists once it lands; the header's
   * name comes from the roster; and the settings pane's profile comes from the Bot. That is a
   * three-deep waterfall on a screen somebody just clicked a roster row to reach, and it is three
   * round trips of a spinner rather than one.
   *
   * The two that do not depend on each other start here, in parallel, while the router is still
   * navigating. `ensureQueryData` is a cache read when the roster already fetched the list, which
   * is the common case — opening a second channel costs one request, not two.
   *
   * Deliberately not awaited as a pair that can fail the navigation: a channel that cannot be read
   * still has a screen to draw, and the roster is not worth blocking on at all.
   */
  loader: async ({ context, params }) => {
    const channel = context.queryClient.ensureQueryData(
      channelQueryOptions(params.channelId),
    );
    const roster = context.queryClient.ensureQueryData(agentListQueryOptions());
    await Promise.allSettled([channel, roster]);
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /**
   * Whose profile the settings pane edits, and — for a room with one Bot — whose name titles it.
   *
   * A room with several is titled by the ROOM: the sidebar row says "일상 비서, 지식" and a header
   * that answered "일상 비서" would name one member of a conversation the list just named three
   * people for. The pane still edits the Bot that speaks for the room, because there is no such
   * thing as a group's profile.
   */
  const agentId = channel.data?.agentIds[0];
  const isGroup = (channel.data?.agentIds.length ?? 0) > 1;
  const roster = useQuery(agentListQueryOptions());
  const headerAgent = roster.data?.find((agent) => agent.id === agentId);
  /*
   * POLLED WHETHER OR NOT THE PANE IS OPEN, which it was not before, and that was a trap: the poll
   * ran only while the screen was closed, so closing the pane restarted it, it immediately found the
   * Bot still waiting, and the pane opened itself again. While a Bot genuinely needed somebody, the
   * screen could not be dismissed at all.
   */
  const needsYou = useNeedsYou(agentId, true);

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const dismissedEpoch = useRef<number | null>(null);
  const runEpoch = useRef<number | null>(null);

  // Settings and watch share one pane; opening either clears the other URL flag.
  // Stable, because the needs-you effect below depends on it and must not re-run every render.
  const show = useCallback(
    (next: "settings" | "watch" | null) => {
      // Dismissal applies only to the current browser-activity run.
      if (next !== "watch" && isWatching)
        dismissedEpoch.current = runEpoch.current;
      return navigate({
        search: (previous) => ({
          ...previous,
          settings: next === "settings" ? true : undefined,
          watch: next === "watch" ? true : undefined,
        }),
      });
    },
    [isWatching, navigate],
  );

  /*
   * Opened once per need, not once per render. This effect had no dependency array, so it navigated
   * on every render for as long as the flag was set; and with nothing remembering that this need
   * had already been answered, a person who closed the pane got it straight back.
   */
  const openedForNeed = useRef(false);
  useEffect(() => {
    if (!needsYou) {
      // The need is over. A later one is a new one, and may open the screen again.
      openedForNeed.current = false;
      return;
    }
    if (openedForNeed.current) return;
    openedForNeed.current = true;
    void show("watch");
  }, [needsYou, show]);

  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissedEpoch.current === activity.epoch) return;
      navigate({
        search: (previous) =>
          previous.watch === true || previous.settings === true
            ? previous
            : { ...previous, settings: undefined, watch: true },
      });
    });
  }, [agentId, navigate]);

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={(isSettingsOpen || isWatching) && agentId !== undefined}
      detailWidth={isWatching ? SCREEN_PANEL_WIDTH : undefined}
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action. Named after
          // the coworker, never the conversation.
          <BotPanel agentId={agentId} name={headerAgent?.name} />
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      <div className="flex flex-col">
        {/*
         * 44px, and NO RULE UNDER IT.
         *
         * The header is the height of the window chrome beside it, so the roster's title row and
         * this one share a baseline across the whole window. The divider is gone because there is
         * nothing to divide: the transcript below is the same surface, and a line drawn across the
         * top of a conversation reads as a toolbar the conversation is filed under.
         *
         * It is also what the window is dragged by. `titleBarStyle: "Overlay"` in the shell means
         * there is no title bar left to grab; `data-tauri-drag-region` gives this row that job and
         * is inert in a browser tab.
         */}
        <div
          className="sticky top-0 flex h-[var(--sand-titlebar-block)] flex-row items-center justify-between gap-2 px-3"
          data-tauri-drag-region
        >
          {/* Keyed on the displayed name so cold channel loads animate the resolved name, not the id. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <motion.div
              animate={{ opacity: 1 }}
              className="shrink-0"
              initial={{ opacity: 0 }}
              /*
               * Keyed on WHO, not on what the channel is called. Keyed on the name, the face
               * remounted and faded in again the moment a first message retitled the channel —
               * an avatar that re-announces itself because the words beside it changed.
               */
              key={`avatar:${(channel.data?.agentIds ?? []).join(",")}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              {/*
               * 24, not 20. A generated face carries a silhouette and an accessory as well as a
               * colour, and at 20 the accessory is three pixels of noise — measured beside the
               * 14px title it sits next to, 24 is where the shape starts reading as a shape.
               */}
              <ChannelAvatar
                participantIds={channel.data?.agentIds ?? []}
                // The header is on the page's own ground, not the sidebar's. See ChannelAvatar.
                ringClassName="ring-background"
                size={24}
              />
            </motion.div>
            <motion.span
              animate={
                prefersReducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, transform: "translateY(0px)" }
              }
              className="min-w-0 text-sm tracking-tight truncate"
              initial={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, transform: HEADING_ENTRANCE_OFFSET }
              }
              key={`name:${headerAgent?.id ?? channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              {/*
               * THE COLLEAGUE, THE WAY A MESSAGING APP NAMES A THREAD.
               *
               * A Bot has one conversation now, so the room IS the Bot, and the header is their
               * name — one line, the way a messaging app titles a thread. It used to lead with a
               * title taken from the first message, which was right while every task minted its own
               * channel and is now just the Bot's name said twice.
               *
               * The standing role that used to sit under it has gone with it: the roster row beside
               * this header already carries it, and repeating it here made the header two lines
               * tall to say nothing new.
               */}
              <span className="truncate font-semibold text-base">
                {isGroup
                  ? (channel.data?.name ?? t("Channel"))
                  : (headerAgent?.name ?? channel.data?.name ?? t("Channel"))}
              </span>
            </motion.span>
          </div>
          <div className="flex flex-row gap-1.5">
            {/*
             * ONLY IN A ROOM. A one-to-one conversation has one member and the header already
             * says who it is; a menu offering to take them out of it would offer a room of one,
             * which the server refuses and which nothing in the product wants.
             */}
            {isGroup && channel.data ? (
              <ParticipantsMenu channel={channel.data} />
            ) : null}
            <Button
              aria-label={
                needsYou
                  ? t("This Bot is waiting for you. Open its screen")
                  : t("Watch this Bot's screen")
              }
              aria-pressed={isWatching}
              className={`relative ${isWatching ? "bg-foreground/5" : ""}`}
              disabled={agentId === undefined}
              onClick={() => show(isWatching ? null : "watch")}
              variant="ghost"
              size="icon"
            >
              <IconDeviceDesktop className="size-4.5" />
              {/*
               * Only while the screen is closed: with it open the prompt itself is on screen, and a
               * dot on the button that opens what you are already looking at is noise. `bg-primary`
               * because the product has one accent colour and this is what it is for — the amber
               * that was here belonged to no palette in the app.
               */}
              {needsYou && !isWatching ? (
                <span className="absolute top-1 right-1 size-2 rounded-full bg-primary" />
              ) : null}
            </Button>
            <Button
              aria-label={t("Bot in this conversation")}
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isSettingsOpen ? null : "settings")}
              variant="ghost"
              size="icon"
            >
              <IconSettings className="size-4.5" />
            </Button>
          </div>
        </div>
      </div>
      <ChannelBody
        channel={channel.data}
        isPending={channel.isPending}
        hasError={Boolean(channel.error)}
      />
    </DetailPanel>
  );
}

/**
 * A channel holds exactly one coworker. More than one is not supported yet, and rendering a shared
 * transcript for several agents before the runtime can route between them would look like it works.
 */
function ChannelBody({
  channel,
  isPending,
  hasError,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
}) {
  if (isPending) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {t("Loading channel…")}
      </p>
    );
  }
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {t("Could not load this channel.")}
      </p>
    );
  }

  /*
   * A ROOM WITH SEVERAL BOTS OPENS, AND THE FIRST MEMBER ANSWERS — UNTIL SOMEBODY NAMES ANOTHER.
   *
   * This used to be a dead end: a sentence saying multi-coworker channels were not supported, on a
   * channel the server had happily created, named and listed. The transcript is the same
   * transcript; what a group needs is a rule for whose turn it is, and it is now two rules. An `@`
   * mention names the Bot the message is for and the room asks that one. Nothing named falls back
   * to this default, which stays the room's first member so that opening a room twice does not get
   * two different Bots — `agentIds` comes back in a stable order (sorted by id, server-side).
   */
  const defaultAgentId = channel.agentIds[0];
  if (!defaultAgentId) {
    return (
      <p className="p-8 text-muted-foreground text-sm">
        {t("This conversation has no Bot in it.")}
      </p>
    );
  }

  /*
   * A ROOM IS WATCHED; A CONVERSATION IS DRIVEN.
   *
   * A channel with several Bots runs its turn on the server and this screen only listens
   * (`GroupChat`). A channel with one Bot keeps the browser-driven path, which streams for free
   * and needs no relay. Both are keyed on the channel so nothing leaks between rooms.
   */
  if (channel.agentIds.length > 1) {
    return <GroupChat channel={channel} key={channel.id} />;
  }

  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={defaultAgentId}
    />
  );
}
