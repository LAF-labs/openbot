import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { NewBotButton } from "@/components/agents/new-bot-button";
import { RosterStrip } from "@/components/agents/roster-strip";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { t } from "@/lib/i18n";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

export const Route = createFileRoute("/_authed/_app/")({
  component: RouteComponent,
});

/**
 * The greeting knows what time it is, and nothing else.
 *
 * Local hours, because "good morning" at somebody's 3pm is worse than no greeting: the whole point
 * of the line is that the product noticed.
 */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return t("Working late?");
  if (hour < 12) return t("Good morning");
  if (hour < 18) return t("Good afternoon");
  return t("Good evening");
}

/**
 * Home leads with the team.
 *
 * The Bots are the product, so the first screen is their faces, not a form. Picking a face aims
 * the composer; `@` in the text still overrides, exactly as it does everywhere else, and the line
 * under the composer says out loud where the message will land — a message that silently reaches
 * somebody you did not choose is the kind of surprise that costs trust the first time it happens.
 */
function RouteComponent() {
  const {
    data: agents,
    isPending,
    isError,
    refetch,
  } = useQuery(agentListQueryOptions());
  const roster = agents ?? [];
  const { start, pending } = useStartChannel();
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = roster.find((agent) => agent.id === selectedId) ?? roster[0];
  const skillCommands = useSkillCommands(selected?.id ?? "");

  return (
    <div className="mt-8 flex w-full flex-1 flex-col items-center justify-center p-4">
      <div className="flex flex-col items-center">
        <h1 className="text-center font-semibold text-[26px] tracking-tight">
          {greeting()}
        </h1>
        <p className="mt-1 text-center text-[13px] text-muted-foreground">
          {t("What should the team take off your hands?")}
        </p>
      </div>

      {/*
       * THE ROW HOLDS ITS PLACE WHILE THE TEAM LOADS. Rendering nothing until the roster arrives
       * dropped the composer up the screen and then shoved it back down, on the one screen a person
       * sees every time they open the app.
       */}
      {isPending ? (
        <div
          className="mt-7 flex max-w-2xl flex-wrap items-start justify-center gap-1"
          aria-hidden
        >
          {[0, 1, 2, 3].map((slot) => (
            <div
              key={slot}
              className="flex w-[76px] flex-col items-center gap-1.5 p-2"
            >
              <Skeleton className="size-12 rounded-full" />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      ) : null}

      {isError ? (
        <div className="mt-7 flex flex-col items-center gap-2">
          <p className="text-[13px] text-destructive" role="alert">
            {t("Your team could not be loaded.")}
          </p>
          <Button onClick={() => void refetch()} size="sm" variant="outline">
            {t("Try again")}
          </Button>
        </div>
      ) : null}

      {roster.length > 0 ? (
        <div className="mt-7">
          <RosterStrip
            onSelect={setSelectedId}
            roster={roster}
            selectedId={selected?.id}
          />
        </div>
      ) : null}

      {/*
       * A DEAD END OTHERWISE. With no Bots the row did not render, so neither did the "new agent"
       * tile inside it, and the composer below is disabled with nothing to aim at: the first screen
       * of an empty account was a box that would not take a message and no way onward.
       */}
      {!isPending && !isError && roster.length === 0 ? (
        <div className="mt-7 flex flex-col items-center gap-3">
          {/* One face where a roster would be, so the empty screen still has somebody on it. */}
          <BotAvatar className="opacity-80" seed="s:blob.blue" size={48} />
          <p className="text-center text-[13px] text-muted-foreground">
            {t("No Bots on your team yet.")}
          </p>
          <NewBotButton size="sm" variant="outline" />
        </div>
      ) : null}

      <div className="mt-6 flex w-full flex-col items-center">
        <Composer
          agents={toAgentOptions(agents)}
          className="w-full max-w-2xl"
          /*
           * THE SAME PILL AS IN A CONVERSATION.
           *
           * This was the tall variant: a box that opened at four lines and held ninety pixels of
           * empty space under a one-line placeholder, on the screen a person sees every time they
           * open the app. One composer, one shape — the box you start a conversation in should not
           * be a different object from the box you continue it in.
           */
          compact
          // The chosen Bot's real granted skills, the way a channel does it. Home used to inherit
          // the placeholder list, so `/` here offered a command no Bot had.
          commands={skillCommands}
          disabled={!selected}
          onSubmit={async (draft) => {
            // A channel is pinned to one coworker for the life of its thread.
            const agentId = draft.agentId ?? selected?.id;
            if (!agentId) return;

            setError(null);
            try {
              await start([agentId], draft.text);
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : t("Could not start the conversation."),
              );
              throw caught;
            }
          }}
          pending={pending}
        />
        {selected ? (
          <p className="mt-2 w-full max-w-2xl text-center text-muted-foreground text-xs">
            {t("Goes to {name}.", { name: selected.name })}{" "}
            {t("Type @ to reach somebody else.")}
          </p>
        ) : null}
        {error ? (
          <p
            className="mt-2 w-full max-w-2xl text-destructive text-sm"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
