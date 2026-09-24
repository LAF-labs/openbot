import type { Message } from "@ag-ui/core";
import { IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { FirstTaskChips } from "@/components/agents/first-task-chips";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { BotHeader } from "@/components/channels/bot-header";
import { ConversationView } from "@/components/channels/conversation-view";
import { PresenceDrawer } from "@/components/channels/presence-drawer";
import { seedMessage } from "@/components/channels/transcript-messages";
import { MobileNavButton } from "@/components/layout/mobile-nav-button";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isFirstConversation, pickFirstTasks } from "@/lib/agents/first-tasks";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { usePublishTurn } from "@/lib/agents/presence";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useStartChannel } from "@/lib/channels/start";
import { connectionsOverviewQueryOptions } from "@/lib/connections/queries";
import { CopilotProvider } from "@/lib/copilot/provider";
import { t } from "@/lib/i18n";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

/**
 * The Bot's conversation before its first message. The first send makes the channel.
 *
 * `?agent=` names the Bot, for an account from before 2026-09-24 that still has several; with one
 * Bot, and with no `?agent=` at all, it is that Bot. There used to be a "To:" row of chips and a
 * row of faces to build a room from here — rooms were removed with the decision that a person has
 * one Bot (docs/laf/deployment-model.md, "봇은 하나다").
 */
export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: ComposeScreen,
});

/** The transcript's tool renderer needs the CopilotKit context; see `$channelId.tsx` for why it is here. */
function ComposeScreen() {
  return (
    <CopilotProvider>
      <RouteComponent />
    </CopilotProvider>
  );
}

function RouteComponent() {
  const { agent } = Route.useSearch();
  const mine = useMyBots();
  const { data: channels } = useQuery(channelListQueryOptions());

  if (!mine.bots) {
    return (
      <div aria-hidden className="flex w-full flex-1 flex-col gap-3 p-6">
        <Skeleton className="h-6 w-40" />
      </div>
    );
  }
  // A stale or somebody else's `?agent=` is ignored: the list is this person's own.
  const bot =
    mine.bots.find((candidate) => candidate.id === agent) ??
    primaryBot(mine.bots, channels);
  if (!bot) return <Navigate replace to="/welcome" />;

  /*
   * A Bot that already has its conversation opens on it. The server would answer a send from here
   * with that same channel anyway, but the screen in between would have shown an empty transcript
   * for a conversation with history — which reads as the history being gone.
   */
  const existing = conversationOf(bot.id, channels);
  if (existing) {
    return (
      <Navigate
        params={{ channelId: existing.id }}
        replace
        to="/channel/$channelId"
      />
    );
  }

  return <FirstConversation botId={bot.id} key={bot.id} />;
}

function FirstConversation({ botId }: { botId: string }) {
  const mine = useMyBots();
  const bot = mine.bots?.find((candidate) => candidate.id === botId);
  const { start, pending } = useStartChannel();
  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);
  const skillCommands = useSkillCommands(botId);

  /*
   * WHAT THIS PERSON HAS CONNECTED, AND WHETHER THIS BOT HAS EVER BEEN SPOKEN TO, DECIDE THE CHIPS.
   * Nothing is drawn until both have answered: a chip for a site the Bot's browser is not signed
   * into is the first thing the product does for somebody and it fails, and a row of chips that
   * appears and is then replaced is a screen changing its mind in front of somebody.
   */
  const { data: overview } = useQuery(connectionsOverviewQueryOptions());
  const { data: channels } = useQuery(channelListQueryOptions());
  const { data: user } = useQuery(currentUserQueryOptions());
  const firstTasks =
    bot && overview && channels && isFirstConversation(channels, bot.id)
      ? pickFirstTasks(overview, { shop: user?.shop })
      : null;

  // The first message is on its way: the header says the Bot is thinking before the channel exists.
  usePublishTurn(botId, pending || sent !== null ? "thinking" : "idle");

  /**
   * One send for the composer and the chips alike. The chip is a sentence typed on the person's
   * behalf, so it goes out exactly as a typed one would: seeded into the transcript, then the
   * channel started, then the seed withdrawn if that failed.
   */
  const send = async (text: string) => {
    if (!text.trim()) return;
    setError(null);
    setSent(seedMessage(text, crypto.randomUUID()));
    try {
      await start([botId], text);
    } catch (caught) {
      // Preserve the unsent draft when channel creation fails.
      setSent(null);
      setError(
        caught instanceof Error
          ? caught.message
          : t("Could not start the conversation."),
      );
      throw caught;
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* The same header a conversation has, so the first message does not move anything. */}
      <BotHeader
        leading={<MobileNavButton className="-ml-1" />}
        actions={
          <Link
            aria-label={t("Bot profile")}
            className={buttonVariants({ size: "icon", variant: "ghost" })}
            search={{ agent: botId }}
            to="/agents"
          >
            <IconSettings className="size-4.5" />
          </Link>
        }
        agentId={botId}
        avatarSeed={bot?.avatarSeed}
        name={bot?.name}
        pill={(presence) => (
          <PresenceDrawer botId={botId} presence={presence} />
        )}
      />
      <ConversationView
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        emptyState={
          bot ? (
            /*
             * A WELCOME, NOT A FORM. The face at its largest in the app, on a soft wash of its own
             * colour, then its name and one line — and the first things to ask, to press. The wash
             * is static: the face already moves, and a glow that pulsed beside it would be the
             * screensaver the avatar engine was written to avoid.
             */
            <div className="pointer-events-auto flex w-full max-w-xl flex-col items-center gap-5 px-6 text-center">
              <div className="relative flex items-center justify-center">
                <span
                  aria-hidden="true"
                  className="absolute size-40 rounded-full bg-primary/10 blur-2xl"
                />
                <BotAvatar
                  className="relative"
                  seed={bot.avatarSeed}
                  size={96}
                  state="curious"
                />
              </div>
              <div className="flex flex-col items-center gap-1">
                <h2 className="font-semibold text-xl">{bot.name}</h2>
                <p className="text-muted-foreground text-sm">
                  {t("Tell {name} what you need.", { name: bot.name })}
                </p>
              </div>
              {/*
               * THE FIRST THING TO ASK, AS SOMETHING TO PRESS — for a Bot nobody has spoken to.
               * Keyed on the Bot: a routine made for one Bot must not show as made for the next.
               */}
              {firstTasks ? (
                <FirstTaskChips
                  agent={bot}
                  disabled={pending || sent !== null}
                  key={`first-tasks:${bot.id}`}
                  onAsk={(sentence) => {
                    // The failure is already on screen as the notice; nothing else to do with it.
                    void send(sentence).catch(() => undefined);
                  }}
                  tasks={firstTasks}
                />
              ) : null}
            </div>
          ) : null
        }
        disabled={!bot}
        messages={sent ? [sent] : []}
        notice={
          error ? (
            <p className="pb-2 text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null
        }
        onSubmit={(draft) => send(draft.text)}
        pending={pending}
      />
    </div>
  );
}
