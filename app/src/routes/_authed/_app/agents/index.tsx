import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";

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

  if (mine.isError) {
    return (
      <PageShell title={t("Bot profile")}>
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive text-sm" role="alert">
            {t("Your Bot could not be loaded.")}
          </p>
          <Button onClick={() => mine.refetch()} size="sm" variant="outline">
            {t("Try again")}
          </Button>
        </div>
      </PageShell>
    );
  }
  if (!mine.bots) {
    return (
      <PageShell title={t("Bot profile")}>
        <Skeleton aria-hidden className="h-64 w-full max-w-md rounded-2xl" />
      </PageShell>
    );
  }

  const bot =
    mine.bots.find((candidate) => candidate.id === agent) ??
    primaryBot(mine.bots, channels);
  if (!bot) return <Navigate replace to="/welcome" />;

  return (
    <PageShell title={t("Bot profile")}>
      <div className="w-full max-w-md">
        {/* Keyed on the Bot: the pane's own state is about one Bot and must not carry to the next. */}
        <AgentProfile agentId={bot.id} className="p-0" key={bot.id} />
      </div>
    </PageShell>
  );
}
