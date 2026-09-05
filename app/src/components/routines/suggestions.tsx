import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import { routineKeys } from "@/lib/routines/queries";
import {
  type RoutineSuggestion,
  routineSuggestionsQueryOptions,
  SUGGESTION_WHY,
  suggestionFactsLine,
  suggestionKeys,
  suggestionRequest,
} from "@/lib/routines/suggestions";

/**
 * 이런 루틴은 어떠세요 — the cards above the routines list.
 *
 * QUIET BY CONSTRUCTION. The section draws nothing when there is nothing to offer, and the server
 * never offers more than five; a card pressed 다음에 does not come back. What is on the screen is a
 * suggestion in the plain sense — something a person can take with one press or decline with one —
 * and never a routine already made on their behalf.
 *
 * ONE PRESS, ONE ROUTINE. 만들기 goes through the same create path the form does, on the Bot the
 * card names; with one Bot there is nothing to name and the picker is not drawn. The card is then
 * gone from here and the routine is in the list below, and a status line says so — a card that
 * vanishes on a press with nothing said reads as a card that failed.
 */

type Bot = { id: string; name: string };

const SuggestionCard = ({
  suggestion,
  bots,
  isRosterPending,
  onMade,
}: {
  suggestion: RoutineSuggestion;
  bots: Bot[];
  /** The roster has not answered yet, so which Bot a press would land on is not yet known. */
  isRosterPending: boolean;
  onMade: (name: string) => void;
}) => {
  const queryClient = useQueryClient();
  const botFieldId = useId();
  const [agentId, setAgentId] = useState("");
  const chosen = agentId || bots[0]?.id || "";

  const accept = useMutation({
    mutationFn: async () =>
      suggestionRequest(`/api/routines/suggestions/${suggestion.key}/accept`, {
        method: "POST",
        body: JSON.stringify(chosen ? { agentId: chosen } : {}),
      }),
    onSuccess: () => {
      onMade(suggestion.name);
      void queryClient.invalidateQueries({ queryKey: routineKeys.all });
      void queryClient.invalidateQueries({ queryKey: suggestionKeys.all });
    },
  });

  /*
   * 다음에 TAKES THE CARD AWAY ON THE PRESS. It is the one verb here whose whole effect is
   * "this is gone", and a card that stays for the round trip after being declined looks like a
   * press that missed — the same reason the routine row's switch moves before the server answers.
   * Put back on failure, which is the only honest way to show a decline that did not take.
   */
  const dismiss = useMutation({
    mutationFn: async () =>
      suggestionRequest(`/api/routines/suggestions/${suggestion.key}/dismiss`, {
        method: "POST",
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: suggestionKeys.all });
      const previous = queryClient.getQueryData<RoutineSuggestion[]>(
        suggestionKeys.all,
      );
      queryClient.setQueryData<RoutineSuggestion[]>(
        suggestionKeys.all,
        (cards) => cards?.filter((card) => card.key !== suggestion.key),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(suggestionKeys.all, context.previous);
      }
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: suggestionKeys.all }),
  });

  const why = SUGGESTION_WHY[suggestion.key];
  const problem = accept.error?.message ?? dismiss.error?.message;

  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <span className="font-medium text-sm">{suggestion.name}</span>
        {/* A key this surface has no sentence for draws no sentence: the facts line still says
            what it runs on and when, which is the part that cannot be wrong. */}
        {why ? <p className="text-muted-foreground text-sm">{t(why)}</p> : null}
        <p className="text-muted-foreground/80 text-xs">
          {suggestionFactsLine(suggestion)}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {bots.length > 1 ? (
          <Select
            onValueChange={(value) => setAgentId(value ?? "")}
            value={chosen}
          >
            <SelectTrigger
              aria-label={t("Which Bot")}
              className="w-40"
              id={botFieldId}
            >
              {/* Explicit children: the bare fallback renders the raw `agent_<uuid>`. */}
              <SelectValue>
                {bots.find((bot) => bot.id === chosen)?.name ?? t("Which Bot")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {bots.map((bot) => (
                <SelectItem key={bot.id} value={bot.id}>
                  {bot.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          disabled={accept.isPending || isRosterPending}
          onClick={() => accept.mutate()}
          size="sm"
          type="button"
        >
          {accept.isPending ? t("Making…") : t("Make")}
        </Button>
        <Button
          disabled={dismiss.isPending || accept.isPending}
          onClick={() => dismiss.mutate()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Not now")}
        </Button>
      </div>
      {problem ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </li>
  );
};

export const RoutineSuggestions = () => {
  const suggestions = useQuery(routineSuggestionsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const headingId = useId();
  /** The routine just made from a card, named in a status line until the next press. */
  const [made, setMade] = useState<string | null>(null);

  if (suggestions.isPending) {
    return (
      <section aria-busy="true" className="mb-8">
        <Skeleton className="h-[116px] rounded-xl" />
      </section>
    );
  }
  if (suggestions.isError) {
    return (
      <section className="mb-8 flex flex-wrap items-center gap-2">
        <p className="text-destructive text-sm" role="alert">
          {t("The suggestions could not be loaded.")}
        </p>
        <Button
          onClick={() => void suggestions.refetch()}
          size="sm"
          variant="ghost"
        >
          {t("Try again")}
        </Button>
      </section>
    );
  }

  const cards = suggestions.data;
  const bots: Bot[] = (agents.data ?? []).map((bot) => ({
    id: bot.id,
    name: bot.name,
  }));

  // Nothing to offer and nothing just made: the list below is the whole page, as it was.
  if (cards.length === 0 && !made) return null;

  return (
    <section
      aria-labelledby={cards.length > 0 ? headingId : undefined}
      className="mb-8"
    >
      {cards.length > 0 ? (
        <>
          <h2 className="font-medium text-sm" id={headingId}>
            {t("Routines you might want")}
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            {t(
              "Made from what you have connected. Nothing is created until you press Make.",
            )}
          </p>
        </>
      ) : null}
      {made ? (
        <p className="mt-2 text-muted-foreground text-xs" role="status">
          {t("{name}{josa} in the list below now.", {
            josa: josa(made, "이/가"),
            name: made,
          })}
        </p>
      ) : null}
      {cards.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {cards.map((suggestion) => (
            <SuggestionCard
              bots={bots}
              isRosterPending={agents.isPending}
              key={suggestion.key}
              onMade={setMade}
              suggestion={suggestion}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
};
