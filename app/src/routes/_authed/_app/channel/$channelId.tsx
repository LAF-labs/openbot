import { IconDeviceDesktop, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { BotHeader } from "@/components/channels/bot-header";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  offerDraft,
  withdrawDraft,
} from "@/components/channels/composer/prefill";
import { LiveView } from "@/components/computer/live-view";
import { useControl } from "@/components/computer/use-control";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SectionBoundary } from "@/components/layout/section-boundary";
import { Button, buttonVariants } from "@/components/ui/button";
import { agentKeys, agentListQueryOptions } from "@/lib/agents/queries";
import {
  type AgentChannel,
  ChannelGoneError,
  channelKeys,
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { isInUse, useBrowsingNow } from "@/lib/computer/browsing-now";
import {
  setScreenOpen,
  useScreenPanel,
  useScreenPanelWidth,
} from "@/lib/computer/screen-panel";
import { CopilotProvider } from "@/lib/copilot/provider";
import { t } from "@/lib/i18n";

const chatSearchSchema = z
  .object({
    settings: z.boolean().optional(),
    /*
     * A sentence to start the composer with, which the conversation takes and then drops from the
     * address (below). The routines screen's 고치기 sends "'주간 매출 요약'을 이렇게 바꿔 줘: " here
     * (UI/UX audit 0.5.3, item 8). Its own `.catch`, so a malformed one costs only itself and not
     * the `settings` beside it.
     */
    draft: z.string().optional().catch(undefined),
  })
  /* `.catch({})` so `?settings=yes` is ignored rather than throwing out of
   * validateSearch and taking the whole route down with it. */
  .catch({});

/*
 * THE BOT'S SCREEN OPENS WHEN A PERSON ASKS, AND ONLY THEN.
 *
 * It used to open itself: once per "run" of browser calls — any two within ten seconds — and once
 * per request for help. A model that thinks for longer than ten seconds between steps made every
 * step a new run, so a screen somebody had closed was open again at the next one. Now the Bot's
 * browsing is a banner and a card in the conversation, the header's button says when the browser is
 * in use, and the screen opens from any of them, by hand (`lib/computer/screen-panel.ts`).
 */

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
  component: ChannelScreen,
});

/**
 * THE COPILOTKIT PROVIDER LIVES ON THE SCREENS THAT RUN A BOT, NOT ON EVERY SCREEN.
 *
 * It used to wrap `_authed`'s Outlet, which made its 800 kB — and the transcript renderer it
 * drags in — a static part of Home, Settings and every admin page (audit A4, finding 5). A route
 * component is split into a chunk of its own by the router, so from here the runtime is fetched on
 * the way to a conversation and not before. The compose screen and the playground do the same.
 */
function ChannelScreen() {
  return (
    <CopilotProvider>
      <RouteComponent />
    </CopilotProvider>
  );
}

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, draft } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  const navigate = Route.useNavigate();

  /*
   * THE SENTENCE GOES TO THE COMPOSER, AND OUT OF THE ADDRESS. Offered to this conversation's
   * composer (`composer/prefill.ts`), which takes it once it has loaded, and removed from the
   * search with `replace`, so neither a reload nor the back button types it in a second time.
   */
  useEffect(() => {
    if (draft === undefined) return;
    offerDraft(channelId, draft);
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, draft: undefined }),
    });
  }, [channelId, draft, navigate]);
  // Leaving before its composer took it: it was for this conversation, and nowhere else.
  useEffect(() => () => withdrawDraft(channelId), [channelId]);
  const isSettingsOpen = settings === true;
  /** Whose profile the settings pane edits, and whose name titles the conversation. */
  const agentId = channel.data?.agentIds[0];
  const roster = useQuery(agentListQueryOptions());
  const headerAgent = roster.data?.find((agent) => agent.id === agentId);
  // When it last spoke, for the face: a Bot quiet for half an hour dozes (`useBotMood`).
  const conversations = useQuery(channelListQueryOptions());
  const lastSpokenAt = conversations.data?.find(
    (summary) => summary.id === channelId,
  )?.lastMessageAt;
  const panel = useScreenPanel();
  const isWatching = panel.isOpen && agentId !== undefined;
  // Only while the screen is open: that is the one place a person can be holding the wheel from.
  const control = useControl(isWatching ? agentId : undefined, true);
  const screenWidth = useScreenPanelWidth(control?.holder === "human");
  const isComputerInUse = isInUse(useBrowsingNow(), agentId);

  // Settings and the screen share one pane: asking for the screen puts the profile away.
  useEffect(() => {
    if (isWatching && isSettingsOpen) {
      void navigate({
        search: (previous) => ({ ...previous, settings: undefined }),
      });
    }
  }, [isWatching, isSettingsOpen, navigate]);

  const showSettings = (open: boolean) => {
    if (open) setScreenOpen(false);
    return navigate({
      search: (previous) => ({
        ...previous,
        settings: open ? true : undefined,
      }),
    });
  };

  return (
    <DetailPanel
      onClose={() => {
        if (isWatching) setScreenOpen(false);
        else void showSettings(false);
      }}
      open={(isSettingsOpen || isWatching) && agentId !== undefined}
      detailWidth={isWatching ? screenWidth : undefined}
      isSheetWhenNarrow={isWatching}
      title={
        isWatching ? (
          // Named after the coworker, never the conversation.
          <span className="truncate font-medium text-sm">
            {headerAgent?.name
              ? t("{name}'s screen", { name: headerAgent.name })
              : t("The Bot's screen")}
          </span>
        ) : undefined
      }
      detail={
        agentId === undefined ? null : isWatching ? (
          <LiveView botId={agentId} />
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      {/*
       * THE BOT, AS A PRESENCE: its face with the expression of what it is doing, its name, and the
       * pill that says it in a word and opens the drawer (`BotHeader`). No rule under it — the
       * transcript below is the same surface, and a line across the top of a conversation reads as
       * a toolbar the conversation is filed under.
       */}
      <BotHeader
        actions={
          <>
            {/*
             * THE SCREEN'S BUTTON, WHICH SAYS WHEN THE BROWSER IS IN USE — and stays saying it for a
             * moment after (`LINGER_MS`), so it does not blink between one step and the next. This
             * is the one thing about the Bot's browser the header does unasked; opening is the
             * person's.
             */}
            <Button
              aria-label={
                isComputerInUse
                  ? t("The Bot is using its browser. View its screen")
                  : t("Watch this Bot's screen")
              }
              aria-pressed={isWatching}
              className={isWatching ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => {
                if (!isWatching) void showSettings(false);
                setScreenOpen(!isWatching);
              }}
              size={isComputerInUse ? "sm" : "icon"}
              variant="ghost"
            >
              <IconDeviceDesktop className="size-4.5" />
              {isComputerInUse ? (
                <>
                  <span
                    aria-hidden="true"
                    className="size-1.5 animate-pulse rounded-full bg-primary"
                  />
                  <span className="text-muted-foreground text-xs">
                    {t("In use")}
                  </span>
                </>
              ) : null}
            </Button>
            {/*
             * Named for what it opens, the Bot's profile — the same words the sidebar uses for it.
             * "이 대화의 봇" was from when a conversation could hold several Bots and this picked
             * which (UI/UX audit 0.5.3, item 9); a person has one.
             */}
            <Button
              aria-label={t("Bot profile")}
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => void showSettings(!isSettingsOpen)}
              variant="ghost"
              size="icon"
            >
              <IconSettings className="size-4.5" />
            </Button>
          </>
        }
        agentId={agentId}
        avatarSeed={headerAgent?.avatarSeed}
        lastMessageAt={lastSpokenAt ?? undefined}
        name={headerAgent?.name ?? channel.data?.name ?? t("Channel")}
      />
      {/*
       * THE CONVERSATION, BELOW ITS HEADER. The header stays out of it on purpose: it holds the two
       * buttons that open the Bot's screen and its profile, and a conversation that failed is
       * exactly when somebody wants to look at the Bot instead. The channel and the roster are read
       * by the header too, so they are named for 다시 불러오기; the transcript has a seam of its own
       * inside (`ConversationView`), and this one catches what is left — the chat underneath it, the
       * room's turn-taking, the composer.
       */}
      <SectionBoundary
        className="flex-1"
        queryKeys={[channelKeys.detail(channelId), agentKeys.list()]}
        section="conversation"
      >
        <ChannelBody
          channel={channel.data}
          isPending={channel.isPending}
          hasError={Boolean(channel.error)}
          isGone={channel.error instanceof ChannelGoneError}
        />
      </SectionBoundary>
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
  isGone,
}: {
  channel: AgentChannel | undefined;
  isPending: boolean;
  hasError: boolean;
  /** The server answered that this conversation does not exist, rather than failing to answer. */
  isGone: boolean;
}) {
  if (isPending) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {t("Loading channel…")}
      </p>
    );
  }
  /*
   * A CONVERSATION THAT IS NOT THERE, most often a room from before 2026-09-24 — several Bots in
   * one conversation. Rooms were removed with the decision that a person has one Bot
   * (docs/laf/deployment-model.md, "봇은 하나다"), and migration 0047 deleted them with everything
   * said in them, so its address now answers 404. That is not a failure to load, and saying so
   * would send somebody pressing 다시 불러오기 at something that will never come back: this says
   * what happened and where their Bot is instead.
   */
  if (isGone) {
    return (
      <div className="flex flex-col items-start gap-4 p-8">
        <p className="text-muted-foreground text-sm">
          {t(
            "This conversation is no longer here. Conversations with several Bots were removed, along with everything said in them.",
          )}
        </p>
        <Link className={buttonVariants({ variant: "secondary" })} to="/">
          {t("Go to your Bot")}
        </Link>
      </div>
    );
  }
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {t("Could not load this channel.")}
      </p>
    );
  }

  const defaultAgentId = channel.agentIds[0];
  if (!defaultAgentId) {
    return (
      <p className="p-8 text-muted-foreground text-sm">
        {t("This conversation has no Bot in it.")}
      </p>
    );
  }

  return (
    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={defaultAgentId}
    />
  );
}
