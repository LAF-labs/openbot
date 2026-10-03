import {
  type Category,
  categoryOrder,
  effectivePersona,
} from "@shared/persona";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  COMPOSE_SCREEN_KEY,
  offerSend,
} from "@/components/channels/composer/prefill";
import { Badge } from "@/components/gallery/frame";
import { CategorySheet } from "@/components/goals/category-sheet";
import { GoalDetail } from "@/components/goals/goal-detail";
import { CATEGORY_ICONS, GoalRow } from "@/components/goals/goal-parts";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { focusRing } from "@/components/ui/focus";
import { Skeleton } from "@/components/ui/skeleton";
import { conversationOf, primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  categoryName,
  goalStartSentence,
  goalsQueryOptions,
} from "@/lib/goals/queries";
import { t } from "@/lib/i18n";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { cn } from "@/lib/utils";

/**
 * 목표 — A GOAL REFINED IN THE CONVERSATION, TRACKED HERE (muse-shape plan §3.4, phase 9).
 *
 * THE SEVEN KINDS OF LIFE, THE SAME FOR EVERYONE (§2.4), in the order this person reads them: the
 * persona puts two first and marks them 추천, and hides none. Pressing one opens a sheet that says
 * what happens next, and its one button sends "{분류} 목표를 같이 세워 줘" as the person's message in
 * the one conversation — where the Bot asks a few things, shows the goal on a card, and saves it
 * only when the person presses 예 (`laf:goal_needs_yes`, in code).
 *
 * THEN THE GOALS: active first, each with its three-word momentum (잘 가고 있어요 · 조금 밀렸어요 ·
 * 늦어지고 있어요) and what it watches; a goal opens its timeline. Finished and stopped goals under
 * them.
 *
 * THE TITLE STANDS ALONE, AND BEFORE ANY GOAL THE PAGE SAYS ONE LINE (2026-10-04, the owner: too
 * many characters on the screen). It opened on a sentence about what happens when a kind is
 * pressed — which the sheet that press opens says, where it is needed — and before any goal it
 * drew a sample goal, Muse's empty state (teardown §4): a made-up title, three badges and two
 * sentences, 60 of the page's 129 characters, about a goal the person does not have.
 */
export const Route = createFileRoute("/_authed/_app/goals")({
  validateSearch: (search: Record<string, unknown>): { goal?: string } =>
    typeof search.goal === "string" ? { goal: search.goal } : {},
  component: GoalsPage,
});

function GoalsPage() {
  const { goal: selected } = Route.useSearch();
  const navigate = useNavigate();
  const goals = useQuery(goalsQueryOptions());
  const reading = useReading(goals);
  const settled = settledOf(reading);
  const { data: user } = useQuery(currentUserQueryOptions());
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels.data) : undefined;
  const conversation = bot ? conversationOf(bot.id, channels.data) : undefined;
  const [sheet, setSheet] = useState<Category | null>(null);

  const persona = user ? effectivePersona(user.persona, user.shop) : null;
  const order = categoryOrder(persona);
  // The two the persona leads with. Unknown leads with nothing, so nothing is marked.
  const recommended = persona ? order.slice(0, 2) : [];

  const all = settled?.data.goals ?? [];
  const active = all.filter((goal) => goal.status === "active");
  const finished = all.filter((goal) => goal.status !== "active");

  const select = (id: string | undefined) =>
    void navigate({ search: id ? { goal: id } : {}, to: "/goals" });

  /**
   * [대화에서 시작]: the sentence goes as the person's message, offered in memory to the composer of
   * the one conversation (`offerSend`) — never through the address, which any link could carry.
   */
  const handleStart = (category: Category) => {
    setSheet(null);
    const sentence = goalStartSentence(category);
    if (conversation) {
      offerSend(conversation.id, sentence);
      void navigate({
        params: { channelId: conversation.id },
        to: "/channel/$channelId",
      });
      return;
    }
    offerSend(COMPOSE_SCREEN_KEY, sentence);
    void navigate({
      search: bot ? { agent: bot.id } : {},
      to: "/channel/new",
    });
  };

  return (
    <PageShell title={t("Goals")} width="wide">
      <ul
        aria-label={t("Kinds of goal")}
        className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4"
        data-goal-categories
      >
        {order.map((category) => {
          const Icon = CATEGORY_ICONS[category];
          const isRecommended = recommended.includes(category);
          return (
            <li className="contents" key={category}>
              <button
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent",
                  focusRing,
                )}
                data-category={category}
                onClick={() => setSheet(category)}
                type="button"
              >
                <Icon
                  aria-hidden="true"
                  className="size-4.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">
                  {categoryName(category)}
                </span>
                {isRecommended ? (
                  <span data-recommended>
                    <Badge tone="positive">{t("Suggested")}</Badge>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <ReadNotice
        className="mt-6"
        line={readLineOf(reading, {
          failed: t("Goals could not be loaded."),
          notHere: t("This deployment does not keep goals."),
        })}
        onRetry={() => void goals.refetch()}
      />

      {reading.state === "loading" ? (
        <div className="mt-6 flex flex-col gap-2">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : null}

      {/* What will be here, in a line. The seven kinds above are the press that makes one. */}
      {settled && all.length === 0 ? (
        <p className="mt-6 text-muted-foreground text-sm" data-goals-empty>
          {t("Goals you set in the conversation are kept here.")}
        </p>
      ) : null}

      {active.length > 0 || selected ? (
        <PageSection className="mt-8" title={t("In progress")}>
          <div className="grid gap-4 xl:grid-cols-2">
            <ul className="flex flex-col gap-2" data-goals-active>
              {active.map((goal) => (
                <li key={goal.id}>
                  <GoalRow
                    goal={goal}
                    isSelected={goal.id === selected}
                    onSelect={() =>
                      select(goal.id === selected ? undefined : goal.id)
                    }
                  />
                </li>
              ))}
            </ul>
            {selected ? (
              <GoalDetail
                agentId={bot?.id}
                channelId={conversation?.id}
                goalId={selected}
                key={selected}
                onRemoved={() => select(undefined)}
              />
            ) : null}
          </div>
        </PageSection>
      ) : null}

      {finished.length > 0 ? (
        <PageSection className="mt-8" title={t("Finished and stopped")}>
          <ul className="flex flex-col gap-2" data-goals-finished>
            {finished.map((goal) => (
              <li key={goal.id}>
                <GoalRow
                  goal={goal}
                  isSelected={goal.id === selected}
                  onSelect={() =>
                    select(goal.id === selected ? undefined : goal.id)
                  }
                />
              </li>
            ))}
          </ul>
        </PageSection>
      ) : null}

      <CategorySheet
        category={sheet}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        onStart={handleStart}
      />
    </PageShell>
  );
}
