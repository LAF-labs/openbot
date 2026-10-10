import { type SearchPage, searchTerms } from "@shared/search";
import { infiniteQueryOptions, keepPreviousData } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";
import { own } from "@/lib/own";
import { RequestRefusedError } from "@/lib/refusals";

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

/** The refusals the door answers with, as the codes it sends. One sentence: none is the person's to fix. */
export const SEARCH_REFUSALS: Readonly<Record<string, string>> = {
  "laf:search_unavailable": "The conversations could not be searched.",
  "laf:search_query_invalid": "The conversations could not be searched.",
  "laf:search_cursor_invalid": "The conversations could not be searched.",
};

async function searchRequest(
  terms: readonly string[],
  cursor: string | null,
  signal: AbortSignal,
): Promise<SearchPage> {
  const response = await fetch("/api/search", {
    body: JSON.stringify({ q: terms.join(" "), ...(cursor ? { cursor } : {}) }),
    credentials: "include",
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : "";
    const known = own(SEARCH_REFUSALS, code);
    throw new RequestRefusedError(
      known ? t(known) : t("The conversations could not be searched."),
      response.status,
      code || null,
    );
  }
  return body as unknown as SearchPage;
}

/** The hits for what was typed. Asked only once it is a search (`searchTerms`). */
export function searchQueryOptions(typed: string) {
  const terms = searchTerms(typed) ?? [];
  return infiniteQueryOptions({
    enabled: terms.length > 0,
    // Of whatever arrived: an answer that is no page has no next one (`lib/feed/queries.ts` says why).
    getNextPageParam: (last: SearchPage | null | undefined) =>
      last?.next ?? null,
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
