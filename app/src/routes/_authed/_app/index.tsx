import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Mascot } from "@/components/agents/mascot";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { t } from "@/lib/i18n";

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
        <div className="mt-7 flex items-start gap-1" aria-hidden>
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
        <div className="mt-7 flex items-start gap-1">
          {roster.map((agent) => {
            const chosen = agent.id === selected?.id;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelectedId(agent.id)}
                aria-pressed={chosen}
                className="group flex w-[76px] flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent"
              >
                <span
                  className={
                    "inline-flex size-12 overflow-hidden rounded-full ring-offset-2 ring-offset-background transition-all duration-150 group-hover:scale-105" +
                    (chosen ? " ring-2 ring-primary" : " ring-0")
                  }
                >
                  <Mascot
                    className="size-full object-cover"
                    seed={agent.avatarSeed}
                    size={48}
                  />
                </span>
                <span
                  className={
                    "max-w-full truncate text-[11px] leading-tight" +
                    (chosen ? " font-medium" : " text-muted-foreground")
                  }
                >
                  {agent.name}
                </span>
              </button>
            );
          })}
          <Link
            to="/agents"
            className="group flex w-[76px] flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent"
          >
            <span className="inline-flex size-12 items-center justify-center rounded-full border border-border border-dashed text-[20px] text-muted-foreground transition-transform duration-150 group-hover:scale-105">
              +
            </span>
            <span className="max-w-full truncate text-[11px] text-muted-foreground leading-tight">
              {t("New agent")}
            </span>
          </Link>
        </div>
      ) : null}

      {/*
       * A DEAD END OTHERWISE. With no Bots the row did not render, so neither did the "new agent"
       * tile inside it, and the composer below is disabled with nothing to aim at: the first screen
       * of an empty account was a box that would not take a message and no way onward.
       */}
      {!isPending && !isError && roster.length === 0 ? (
        <div className="mt-7 flex flex-col items-center gap-3">
          <span className="inline-flex size-12 overflow-hidden rounded-full opacity-80">
            {/* The axolotl again: the one that has not grown up yet. */}
            <Mascot className="size-full object-cover" seed="r4c5" size={48} />
          </span>
          <p className="text-center text-[13px] text-muted-foreground">
            {t("No Bots on your team yet.")}
          </p>
          <Button
            render={(props) => <Link to="/agents" {...props} />}
            size="sm"
            variant="outline"
          >
            {t("New agent")}
          </Button>
        </div>
      ) : null}

      <div className="mt-6 flex w-full flex-col items-center">
        <Composer
          agents={toAgentOptions(agents)}
          className="w-full max-w-2xl"
          disabled={!selected}
          onSubmit={async (draft) => {
            // A channel is pinned to one coworker for the life of its thread.
            const agentId = draft.agentId ?? selected?.id;
            if (!agentId) return;

            setError(null);
            try {
              await start(agentId, draft.text);
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Could not start the conversation.",
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
