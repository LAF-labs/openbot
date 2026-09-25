import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { z } from "zod";
import { PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { Notebook } from "@/components/notebook/notebook";
import { Skeleton } from "@/components/ui/skeleton";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { readLineOf } from "@/lib/read-line";
import { settledOf } from "@/lib/reading";

/** `.catch({})` so a malformed `?agent=` is dropped rather than throwing out of the router. */
const notebookSearchSchema = z
  .object({
    agent: z.string().optional(),
  })
  .catch({});

export const Route = createFileRoute("/_authed/_app/notebook")({
  validateSearch: notebookSearchSchema,
  component: NotebookScreen,
});

/**
 * 수첩, AS A PAGE (one-bot direction #2). The Bot's, so it follows the profile's choice of Bot:
 * the one Bot, or `?agent=` on an account from before the cap came down to one.
 */
function NotebookScreen() {
  const { agent } = Route.useSearch();
  const mine = useMyBots();
  const { data: channels } = useQuery(channelListQueryOptions());
  const settled = settledOf(mine.reading);

  if (settled?.state === "empty") return <Navigate replace to="/welcome" />;

  const bot = settled
    ? (settled.data.find((candidate) => candidate.id === agent) ??
      primaryBot(settled.data, channels))
    : undefined;

  return (
    <PageShell
      description={t(
        "What your Bot knows about the shop and about you. Fix anything that is wrong here, and your Bot knows from your next message.",
      )}
      title={t("Notebook")}
    >
      <ReadNotice
        line={
          settled
            ? null
            : readLineOf(mine.reading, {
                failed: t("Your Bot could not be loaded."),
                notHere: t("Bots are not offered here."),
              })
        }
        onRetry={() => mine.refetch()}
      />
      {mine.reading.state === "loading" ? (
        <Skeleton aria-hidden className="mt-6 h-64 w-full rounded-lg" />
      ) : null}
      {bot ? <Notebook agentId={bot.id} key={bot.id} /> : null}
    </PageShell>
  );
}
