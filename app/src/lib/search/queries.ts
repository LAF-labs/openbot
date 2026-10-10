import { type SearchHit, type SearchPage, searchTerms } from "@shared/search";
import { infiniteQueryOptions, keepPreviousData } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";
import { RequestRefusedError, requestOrRefusal } from "@/lib/refusals";

/**
 * 통합검색 on the wire, and what the box holds (record §3, piece 4-3, 2026-10-10).
 *
 * The server answers facts (`server/src/search/conversations.ts`): which conversation, which
 * message, when, and the words around the match. The sentences are this side's, through `t()` —
 * the table below is walked by `app/tests/search.test.tsx`, because `t(variable)` is invisible to
 * the dictionary's own coverage test.
 *
 * WHAT WAS TYPED IS KEPT HERE, NOT IN THE ADDRESS. A search is content — a name, an amount — and
 * an address is what a reload hands to every log between the window and the server; the request
 * itself is a POST for the same reason. So the words live in this module for as long as the
 * window does: a person who opens a hit and comes back finds the list they left.
 */

export const searchKeys = {
  all: ["search"] as const,
  of: (terms: readonly string[]) => ["search", ...terms] as const,
};

/**
 * A page out of whatever arrived, or null where it is not one: every hit names its conversation
 * and its message and carries its words.
 *
 * READ ONCE, HERE, AND AN ANSWER THAT IS NO PAGE IS A FAILURE. The screen used to read each page
 * leniently, so a 200 with nothing in it — a proxy's page, a body cut short — drew "No message has
 * those words", which is a statement about the person's conversations and was not true
 * (review, 2026-10-10).
 */
export function searchPageOf(body: unknown): SearchPage | null {
  const page = body as { hits?: unknown; next?: unknown } | null;
  if (!Array.isArray(page?.hits)) return null;
  const isHit = (hit: unknown): hit is SearchHit =>
    hit !== null &&
    typeof hit === "object" &&
    typeof (hit as SearchHit).channelId === "string" &&
    typeof (hit as SearchHit).messageId === "string" &&
    typeof (hit as SearchHit).snippet === "string";
  if (!page.hits.every(isHit)) return null;
  return {
    hits: page.hits,
    next: typeof page.next === "string" ? page.next : null,
  };
}

/*
 * No table of refusals: the door's three codes are none of them the person's to fix, and the
 * screen says its one sentence for any failure (`routes/_authed/_app/search.tsx`). The code still
 * travels on the error, for "this deployment cannot search".
 */
async function searchRequest(
  terms: readonly string[],
  cursor: string | null,
  signal: AbortSignal,
): Promise<SearchPage> {
  const page = searchPageOf(
    await requestOrRefusal("/api/search", {
      body: JSON.stringify({
        q: terms.join(" "),
        ...(cursor ? { cursor } : {}),
      }),
      method: "POST",
      signal,
    }),
  );
  if (!page) {
    throw new RequestRefusedError(
      t("That did not go through. Try again."),
      200,
      null,
    );
  }
  return page;
}

/** The hits for what was typed. Asked only once it is a search (`searchTerms`). */
export function searchQueryOptions(typed: string) {
  const terms = searchTerms(typed) ?? [];
  return infiniteQueryOptions({
    enabled: terms.length > 0,
    getNextPageParam: (last: SearchPage) => last.next,
    initialPageParam: null as string | null,
    // The list a person is reading stays while the next word's answer is on its way.
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) => searchRequest(terms, pageParam, signal),
    queryKey: searchKeys.of(terms),
    // A conversation grows while the window is open: a search made again is read again.
    staleTime: 5_000,
  });
}

let typed = "";
const watchers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

export function setSearchTyped(next: string): void {
  if (next === typed) return;
  typed = next;
  for (const watcher of watchers) watcher();
}

/** What the search box holds, for as long as the window is open. */
export function useSearchTyped(): string {
  return useSyncExternalStore(
    subscribe,
    () => typed,
    () => typed,
  );
}
