/**
 * 통합검색: WHAT A PERSON ASKS FOR AND WHAT COMES BACK (record §3, piece 4-3, 2026-10-10).
 *
 * One reading of the words a person typed, for the server that searches with them and the screen
 * that marks them in what came back: split on spaces, every one of them must be in the message.
 * "가을 메뉴" finds a message holding both, in any order — a person remembers two words of what
 * was said more often than the phrase.
 */

/** Fewer characters than this find too much to be an answer; one Korean word is two. */
export const SEARCH_QUERY_MIN = 2;
export const SEARCH_QUERY_MAX = 100;
/** More words than this are not a search any more, and each is another pass over the index. */
export const SEARCH_TERMS_MAX = 5;

export type SearchHit = {
  channelId: string;
  /** `main` or `project` (`channels.kind`): which of the person's conversations it was said in. */
  kind: string;
  /** The conversation's stored name: a project's is the person's own; a main one's is the Bot's. */
  channelName: string;
  /** The transcript row to go to (`data-message-id`). */
  messageId: string;
  role: "user" | "assistant";
  /** ISO-8601: when it was said, or when its row was written where the message carries no stamp. */
  at: string;
  /** The words around the first place one of the terms was found, on one line. */
  snippet: string;
};

export type SearchPage = {
  hits: SearchHit[];
  /** Pass back as `cursor` for the hits before these; null when there are none. */
  next: string | null;
};

/**
 * The words to look for, or null where what was typed is not a search: too short, too long.
 * NFC, because a message is stored as it was typed and a decomposed 한 is three other characters.
 */
export function searchTerms(typed: unknown): string[] | null {
  if (typeof typed !== "string") return null;
  const query = typed.normalize("NFC").trim();
  if (query.length < SEARCH_QUERY_MIN || query.length > SEARCH_QUERY_MAX) {
    return null;
  }
  const terms = [...new Set(query.split(/\s+/u))];
  return terms.length > 0 && terms.length <= SEARCH_TERMS_MAX ? terms : null;
}

/** A stretch of a snippet: where it starts, and whether it is one of the words asked for. */
export type SearchRun = { at: number; text: string; isMatch: boolean };

/**
 * A snippet cut where the terms are: `[text, isMatch]` runs, in order, for the screen to mark.
 * Folded the way the search folds (case), and by the characters themselves — never a pattern, so a
 * term that is `(` or `.*` marks only itself.
 */
export function markTerms(
  snippet: string,
  terms: readonly string[],
): SearchRun[] {
  const folded = snippet.toLowerCase();
  const wanted = terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0);
  const runs: SearchRun[] = [];
  let at = 0;
  // Folding can change a string's length (İ); marking then would cut in the wrong place.
  if (folded.length !== snippet.length || wanted.length === 0) {
    return snippet ? [{ at: 0, isMatch: false, text: snippet }] : [];
  }
  while (at < snippet.length) {
    let next = -1;
    let length = 0;
    for (const term of wanted) {
      const found = folded.indexOf(term, at);
      if (found === -1) continue;
      if (
        next === -1 ||
        found < next ||
        (found === next && term.length > length)
      ) {
        next = found;
        length = term.length;
      }
    }
    if (next === -1) break;
    if (next > at) {
      runs.push({ at, isMatch: false, text: snippet.slice(at, next) });
    }
    runs.push({
      at: next,
      isMatch: true,
      text: snippet.slice(next, next + length),
    });
    at = next + length;
  }
  if (at < snippet.length) {
    runs.push({ at, isMatch: false, text: snippet.slice(at) });
  }
  return runs;
}
