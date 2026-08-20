import { IconDeviceDesktop, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ComputerView } from "@/components/computer/computer-view";
import { useNeedsYou } from "@/components/computer/needs-you";
import { DetailPanel } from "@/components/layout/detail-panel";
import { Button } from "@/components/ui/button";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { t } from "@/lib/i18n";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
});

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const HEADING_ENTRANCE_SECONDS = 0.18;
const HEADING_ENTRANCE_OFFSET = "translateY(4px)";

/** Shared detail pane width for the live screen view. */
const SCREEN_PANEL_WIDTH = 400;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

function ComputerViewPanel({
  agentId,
  name,
}: {
  agentId: string;
  name?: string;
}) {
  return (
    <div className="px-4 mt-4">
      <div className="p-4">
        <ComputerView active computerId={agentId} />
        <span className="flex items-center justify-center w-full text-center text-muted-foreground mt-4 text-sm">
          {name ? t("{name}'s screen", { name }) : t("The assistant's screen")}
        </span>
      </div>
    </div>
  );
}

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const prefersReducedMotion = useReducedMotion();
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = channel.data?.agentIds[0];
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
          // the coworker, not the channel: once the first message titles the channel, "«that whole
          // sentence»'s screen" is nobody's screen.
          <ComputerViewPanel
            agentId={agentId}
            name={headerAgent?.name ?? channel?.data?.name}
          />
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      <div className="flex flex-col">
        <div className="h-12 border-b border-border sticky top-0 flex flex-row items-center justify-between px-3 gap-2">
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
              <ChannelAvatar
                participantIds={channel.data?.agentIds ?? []}
                size={28}
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
              key={`name:${channel.data?.name ?? channelId}`}
              transition={{
                duration: HEADING_ENTRANCE_SECONDS,
                ease: EASE_OUT,
              }}
            >
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[13px] tracking-tight">
                  {channel.data?.name ?? t("Channel")}
                </span>
                {/*
                 * Who this is. The top line carries the topic once the channel is titled by its
                 * first message, so the coworker's name moves down here beside the standing role.
                 *
                 * ALWAYS RENDERED, EMPTY UNTIL THE ROSTER LANDS: conditionally mounting it made the
                 * title above jump up half a line and back down a moment later, on every channel
                 * open.
                 */}
                <span className="h-[16px] truncate text-[11px] text-muted-foreground">
                  {headerAgent
                    ? headerAgent.title
                      ? `${headerAgent.name} · ${headerAgent.title}`
                      : headerAgent.name
                    : null}
                </span>
              </span>
            </motion.span>
          </div>
          <div className="flex flex-row gap-1.5">
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
              aria-label={t("Channel coworker")}
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

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  if (!runtimeAgentId) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {t(
          "This channel has more than one coworker, which is not supported yet.",
        )}
      </p>
    );
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />
  );
}
