import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import {
  ROUTINE_REFUSALS,
  type Routine,
  scheduleLabel,
} from "@/lib/routines/queries";

/**
 * The suggestion cards on /routines: the read, the two verbs, and the words.
 *
 * WHAT A SUGGESTION IS. The server keeps a short catalogue of routines a shop's Bot can actually
 * run on the sites and accounts the person has connected (`server/src/routines/suggestion-catalog.ts`),
 * and offers at most five of them, consent-first: nothing exists until 만들기 is pressed, and
 * 다음에 is remembered. Hermes Agent's routine suggestions, for a Korean shop.
 *
 * WHICH WORDS ARE WHOSE. `name` and `instruction` arrive from the server and are drawn as they
 * are — they are the routine that would be made, verbatim, the way a saved routine's row draws its
 * own name. `title` on a connection is an English key the 연결 screen already translates. The one
 * sentence that is the card's own — why this is worth having — is this surface's, in
 * `SUGGESTION_WHY` below, keyed by the suggestion's key; `routine-suggestions.test.ts` walks the
 * server's catalogue so a key added there fails here until it has its sentence.
 */

export type SuggestionConnection = {
  kind: "site" | "account";
  id: string;
  /** An English key, handed to `t()`: a site's name or a vendor's title. */
  title: string;
};

export type RoutineSuggestion = {
  key: string;
  name: string;
  instruction: string;
  schedule: {
    kind: "daily";
    time: string;
    timeZone: string;
    days?: number[];
  };
  needs: SuggestionConnection[];
  /** The connections this person has that the routine would use. Empty only when none is needed. */
  via: SuggestionConnection[];
};

export const suggestionKeys = {
  all: ["routine-suggestions"] as const,
};

/**
 * Why each card is worth having, in one line. Keyed by the server catalogue's `key`.
 *
 * English keys, Korean in the dictionary — the presets' arrangement, and for the presets' reason:
 * `t()` on a variable is invisible to the coverage test, so this table has its own walk.
 */
export const SUGGESTION_WHY: Readonly<Record<string, string>> = {
  "morning-brief":
    "One look at yesterday's orders, enquiries and reviews before the day starts.",
  "review-watch":
    "A low star found the same morning, with a reply drafted and nothing sent.",
  "unanswered-enquiries":
    "Nobody waits two days for an answer you did not know they were waiting for.",
  "weekly-settlement":
    "Last week's sales by channel and what is landing this week, every Monday.",
  "stock-check": "What is about to run out, before a customer finds out first.",
  "booking-check": "Tomorrow's bookings in order, the evening before.",
  "delivery-delay":
    "Orders past their ship-by date, found before the penalty is.",
  "store-open-check":
    "Checks the shop shows as open before the dinner rush, every evening.",
  "ad-spend": "Where last week's ad money went, campaign by campaign.",
  "competitor-price":
    "Your best sellers against the lowest price on Naver Shopping, every Wednesday.",
  "tax-calendar":
    "Which filings fall in the next two weeks, so none of them is a surprise.",
};

/**
 * The refusals the suggestion routes can send, on top of the routine service's own.
 *
 * Accepting IS creating a routine, so every code in `ROUTINE_REFUSALS` can come back from it —
 * the cap, above all — and this table adds only what the cards themselves can provoke.
 */
export const SUGGESTION_REFUSALS: Readonly<Record<string, string>> = {
  "laf:routine_suggestion_not_offered":
    "That suggestion is no longer on offer.",
};

export async function suggestionRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...init,
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : "";
    const known = SUGGESTION_REFUSALS[code] ?? ROUTINE_REFUSALS[code];
    throw new Error(
      known
        ? t(known)
        : String(body?.error ?? t("That did not go through. Try again.")),
    );
  }
  return body;
}

export function routineSuggestionsQueryOptions() {
  return queryOptions({
    queryKey: suggestionKeys.all,
    // A card is decided by what is connected and what exists; both change on other screens.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async () =>
      ((await suggestionRequest("/api/routines/suggestions"))?.suggestions ??
        []) as RoutineSuggestion[],
  });
}

/**
 * The card's one line of facts: what it runs on, and when.
 *
 * The schedule is said by the same `scheduleLabel` a saved routine's row uses, so the card cannot
 * promise "매주 월요일 오전 8:00" in words the list would then write differently.
 */
export function suggestionFactsLine(suggestion: RoutineSuggestion): string {
  const when = scheduleLabel({
    agentId: "",
    dailyDays: suggestion.schedule.days ?? [],
    dailyLocal: suggestion.schedule.time,
    dailyTimeZone: suggestion.schedule.timeZone,
    enabled: true,
    id: "",
    instruction: "",
    intervalMinutes: null,
    name: "",
    scheduleKind: "daily",
  } as Routine);
  const on =
    suggestion.via.length > 0
      ? t("Using {connections}", {
          connections: suggestion.via.map((one) => t(one.title)).join(", "),
        })
      : t("Needs no connection");
  return `${on} · ${when}`;
}
