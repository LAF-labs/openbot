import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { ReadNotice } from "@/components/layout/read-states";
import { savingFailure } from "@/components/routines/saving-failure";
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
import type { ReadLine } from "@/lib/read-line";
import { hasFailedOutright, settledOf, useReading } from "@/lib/reading";
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
 *
 * A CARD IS ITS NAME AND ONE LINE (2026-10-04, the owner: too many characters, and words where an
 * icon would do). Under the heading stood a sentence — where the cards came from, and that nothing
 * is made before 만들기 is pressed — and on each card a sentence on why it is worth having over a
 * line of facts. The heading stands alone; the line is the facts, because that is what 만들기 will
 * make: what it runs on, and when. Why it is worth having is the card's tooltip. 다음에 is the ×
 * this app draws to put a thing away, named.
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
  // Said as a reason, never as the browser's "Failed to fetch" (UI/UX audit 0.5.3, item 15).
  const failed = accept.error ?? dismiss.error;
  const problem = failed ? savingFailure(failed) : null;

  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card p-3 pl-4"
      data-suggestion={suggestion.key}
    >
      {/* A key this surface has no sentence for has no tooltip: the facts line still says what
          it runs on and when, which is the part that cannot be wrong. */}
      <div
        className="flex min-w-40 flex-1 flex-col gap-0.5"
        title={why ? t(why) : undefined}
      >
        <span className="font-medium text-sm">{suggestion.name}</span>
        <p className="text-muted-foreground text-xs">
          {suggestionFactsLine(suggestion)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
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
          aria-label={t("Not now")}
          className="text-muted-foreground"
          data-suggestion-dismiss
          disabled={dismiss.isPending || accept.isPending}
          onClick={() => dismiss.mutate()}
          size="icon-sm"
          title={t("Not now")}
          type="button"
          variant="ghost"
        >
          <IconX aria-hidden="true" />
        </Button>
      </div>
      {problem ? (
        <p className="basis-full text-destructive text-xs" role="alert">
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
  const reading = useReading(suggestions);
  const cards = settledOf(reading)?.data ?? [];
  const bots: Bot[] = (agents.data ?? []).map((bot) => ({
    id: bot.id,
    name: bot.name,
  }));
  /*
   * A PLACE WITH NO SUGGESTIONS IS A PAGE WITH NO CARDS, NOT A FAILURE. The route is mounted only
   * where the connections and the roster are (`server/src/app.ts`), and where it is not, the read
   * met `laf:not_found` — which drew "could not be loaded" and 다시 시도 above the routines, a press
   * that could only ever fail again. An offer this place cannot make is simply not made, and cards
   * kept over a refresh that failed need no line either: each card's press says if it has gone.
   */
  const line: ReadLine = hasFailedOutright(reading)
    ? {
        kind: "failed",
        message: t("The suggestions could not be loaded."),
        isRetrying: false,
      }
    : null;

  // The notice first and always, so its line is heard when it is said; the rest as the read allows.
  return (
    <>
      <ReadNotice
        className="mb-8 py-0"
        line={line}
        onRetry={() => void suggestions.refetch()}
      />
      {reading.state === "loading" ? (
        <section aria-busy="true" className="mb-8">
          <Skeleton className="h-[116px] rounded-xl" />
        </section>
      ) : null}
      {/* Nothing to offer and nothing just made: the list below is the whole page, as it was. */}
      {cards.length > 0 || made ? (
        <section
          aria-labelledby={cards.length > 0 ? headingId : undefined}
          className="mb-8"
        >
          {/*
           * THE HEADING STANDS ALONE. The sentence under it said where the cards came from — and
           * once told a person who had connected nothing that it had read their connections
           * (first-hour walk, 2026-09-27) — and that nothing is made before 만들기 is pressed, which
           * is what a button called 만들기 says. A card that runs on a connection names it.
           */}
          {cards.length > 0 ? (
            <h2 className="font-medium text-sm" id={headingId}>
              {t("Routines you might want")}
            </h2>
          ) : null}
          {/* Mounted with the cards, so what a press made is heard when it is said. */}
          <LiveRegion as="p" className="mt-2 text-muted-foreground text-xs">
            {made
              ? t("{name}{josa} in the list below now.", {
                  josa: josa(made, "이/가"),
                  name: made,
                })
              : null}
          </LiveRegion>
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
      ) : null}
    </>
  );
};
