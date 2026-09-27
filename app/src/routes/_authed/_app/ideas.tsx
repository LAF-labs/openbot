import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { IdeaCard } from "@/components/ideas/idea-card";
import { LiveRegion } from "@/components/layout/live-region";
import { PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { Skeleton } from "@/components/ui/skeleton";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import {
  dismissIdea,
  type IdeasAnswer,
  ideaKeys,
  ideasQueryOptions,
} from "@/lib/ideas/queries";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";

/**
 * 아이디어 — THINGS THE BOT CAN DO FOR YOU (muse-shape plan §3.3, phase 5, 2026-09-27).
 *
 * A page of cards, each a sentence the person could have typed: what the Bot will do, what comes
 * out, and why it is near the top. Pressing one opens the conversation with the sentence in the
 * composer and sends NOTHING — most of them want a date, a product or a time first, and the person
 * finishes the sentence. A card that waits on a connection goes to 연결 instead.
 *
 * THE SAME CARDS FOR EVERYONE (`shared/ideas/catalogue.ts`), in this person's order. A 사장님 and a
 * 학생 scroll the same page; only what is at the top differs.
 *
 * TWO COLUMNS WHERE THERE IS ROOM (`xl`, 1280 and up), one on a phone and in the PC app's narrowest
 * window, where two columns of Korean sentences wrapped every title.
 */
export const Route = createFileRoute("/_authed/_app/ideas")({
  component: IdeasPage,
});

function IdeasPage() {
  const queryClient = useQueryClient();
  const ideas = useQuery(ideasQueryOptions());
  const reading = useReading(ideas, {
    isEmpty: (answer) => answer.ideas.length === 0,
  });
  const settled = settledOf(reading);
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  const conversation = bot ? conversationOf(bot.id, channels.data) : undefined;
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * 다음에. Taken off the page at once — the press is the person's decision, and a card that stays
   * until the server agrees reads as the press not having worked — and put back if it failed.
   */
  const handleDismiss = async (key: string) => {
    setProblem(null);
    const before = queryClient.getQueryData<IdeasAnswer>(ideaKeys.all);
    queryClient.setQueryData<IdeasAnswer>(ideaKeys.all, (current) =>
      current
        ? {
            ...current,
            ideas: current.ideas.filter((idea) => idea.key !== key),
          }
        : current,
    );
    await dismissIdea(key).catch((caught: unknown) => {
      queryClient.setQueryData(ideaKeys.all, before);
      setProblem(
        caught instanceof Error
          ? caught.message
          : t("That did not go through. Try again."),
      );
    });
  };

  return (
    <PageShell
      description={t(
        "Things I can do for you. Press one and its sentence goes into the conversation's box — nothing is sent until you send it, so change it first if you like.",
      )}
      title={t("Ideas")}
      width="wide"
    >
      <ReadNotice
        className="mb-3"
        line={readLineOf(reading, {
          failed: t("The ideas could not be loaded."),
          notHere: t("There are no ideas on this deployment."),
        })}
        onRetry={() => void ideas.refetch()}
      />
      <LiveRegion as="p" className="mb-3 text-destructive text-sm" tone="alert">
        {problem}
      </LiveRegion>
      {reading.state === "loading" ? (
        <div className="grid gap-3 xl:grid-cols-2">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      ) : null}
      {reading.state === "empty" ? (
        <p className="text-muted-foreground text-sm">
          {t(
            "Nothing left here — you have put every idea away. Ask for anything in the conversation.",
          )}
        </p>
      ) : null}
      {settled && settled.data.ideas.length > 0 ? (
        <ul className="grid gap-3 xl:grid-cols-2" data-ideas>
          {settled.data.ideas.map((card) => (
            <li className="contents" key={card.key}>
              <IdeaCard
                agentId={bot?.id}
                card={card}
                channelId={conversation?.id}
                onDismiss={() => void handleDismiss(card.key)}
                persona={settled.data.persona}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </PageShell>
  );
}
