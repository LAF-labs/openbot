import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { Skeleton } from "@/components/ui/skeleton";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { readLineOf } from "@/lib/read-line";
import { settledOf } from "@/lib/reading";

/** `.catch({})` so a malformed `?agent=` is dropped rather than throwing out of the router. */
const agentsSearchSchema = z
  .object({
    agent: z.string().optional(),
  })
  .catch({});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  component: BotProfileScreen,
});

/**
 * THE BOT'S PROFILE, AS A PAGE (2026-09-24).
 *
 * This was 봇: a gallery of the person's Bots, "내 봇 3/5", a button to make another, and a pane
 * that slid out with one Bot's profile. A person has one Bot now, so the page is that Bot's
 * profile — its face and its name, changed here whenever they like, and the settings that are
 * about how it works rather than what it is. `?agent=` picks another only on an account from
 * before the cap came down to one; the sidebar's switcher is how such a person gets there.
 */
function BotProfileScreen() {
  const { agent } = Route.useSearch();
  const mine = useMyBots();
  const { data: channels } = useQuery(channelListQueryOptions());
  const { reading } = mine;
  const settled = settledOf(reading);

  // A claim made only on an answer — this one, or the last one when refreshing it failed.
  if (settled?.state === "empty") return <Navigate replace to="/welcome" />;

  const bot = settled
    ? (settled.data.find((candidate) => candidate.id === agent) ??
      primaryBot(settled.data, channels))
    : undefined;

  return (
    <PageShell title={t("Bot profile")}>
      <div className="flex w-full max-w-md flex-col gap-3">
        {/*
         * Only while there is no Bot to show. Once one is picked, the profile below reads it on its
         * own and says its own line; the list failing to refresh changes nothing it draws.
         */}
        <ReadNotice
          line={
            settled
              ? null
              : readLineOf(reading, {
                  failed: t("Your Bot could not be loaded."),
                  notHere: t("Bots are not offered here."),
                })
          }
          onRetry={() => mine.refetch()}
        />
        {reading.state === "loading" ? (
          <Skeleton aria-hidden className="h-64 w-full rounded-2xl" />
        ) : null}
        {bot ? (
          // Keyed on the Bot: the pane's own state is about one Bot and must not carry to the next.
          <AgentProfile agentId={bot.id} className="p-0" key={bot.id} />
        ) : null}
      </div>
    </PageShell>
  );
}
