import { createFileRoute } from "@tanstack/react-router";
import { BotDay } from "@/components/app-sidebar/bot-day";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyBots } from "@/lib/agents/my-bots";
import { t } from "@/lib/i18n";

/**
 * 소식 — FOR NOW, 오늘 AS A PAGE OF ITS OWN (muse-shape plan §3.2, phase 3, 2026-09-27).
 *
 * The phone's second tab. On the PC app 오늘 sits in the sidebar, which a phone does not have; this
 * is the same component (`bot-day.tsx`) with the room a page gives it — what waits on the person,
 * what the Bot did today, what comes next. The posts the plan puts under it arrive with the table
 * that holds them (phase 7), and not before: this page promises nothing it does not draw.
 */
export const Route = createFileRoute("/_authed/_app/feed")({
  component: FeedPage,
});

function FeedPage() {
  const mine = useMyBots();
  const bots = mine.bots ?? [];
  const isSeveral = bots.length > 1;

  return (
    <PageShell
      description={t(
        "What your Bot did today, what is waiting on you, and what it does next.",
      )}
      title={t("Updates")}
    >
      {mine.bots === undefined && !mine.isError ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : null}
      {bots.map((bot) => (
        <PageSection key={bot.id} title={isSeveral ? bot.name : t("Today")}>
          <div className="rounded-xl border border-border">
            <BotDay
              botId={bot.id}
              empty={
                <p className="px-4 py-6 text-muted-foreground text-sm">
                  {t(
                    "Nothing yet today. What you hand over in the conversation shows up here.",
                  )}
                </p>
              }
              placement="drawer"
            />
          </div>
        </PageSection>
      ))}
    </PageShell>
  );
}
