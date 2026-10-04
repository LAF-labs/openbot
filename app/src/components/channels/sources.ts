import { DEFERRED_TOOL_PREFIX } from "@shared/tools/bridge";
import { siteNameOf } from "@/components/computer/task-title";
import { outcomeOf } from "@/lib/computer/browsing";
import type { TranscriptItem } from "./chat-messages";

/** A page the Bot read on the way to an answer. */
export type Source = { url: string; title: string; host: string };

/**
 * The calls that READ a page: what the Bot took words from. `computer_navigate` is one — it hands
 * back the page's text, and measured, a weather answer was written from that alone with no read
 * after it. A click or a keypress lands on a page too, but a page the Bot only passed through on
 * the way somewhere is not where an answer came from.
 */
const READING = new Set([
  "computer_navigate",
  "computer_read",
  "computer_snapshot",
]);

/**
 * The web search (`server/src/plugins/web-search-rest.ts`), by the name its call is made under.
 *
 * ITS RESULTS ARE WHAT THE BOT READ: a title, an address, a date and the passage that matched, with
 * no page opened behind them. An answer written from a search and nothing else used to have no
 * sources at all under it — the one kind of answer most in need of them.
 */
const WEB_SEARCH = `${DEFERRED_TOOL_PREFIX}web-search__search`;

/** At most this many sites. An answer quoting twenty pages is not a thing to list. */
const MOST = 8;

/** The pages a search handed back, as the tool wrote them. Anything else — a refusal, an error — is none. */
function searchResultsOf(result: string | undefined): Source[] {
  if (!result) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return [];
  }
  const rows = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const { url, title } = (row ?? {}) as { url?: unknown; title?: unknown };
    if (!isWebAddress(url)) return [];
    return [
      {
        url: url as string,
        title: typeof title === "string" ? title.trim() : "",
        host: hostOf(url as string),
      },
    ];
  });
}

/**
 * WHERE EACH ANSWER'S WORDS CAME FROM, TAKEN FROM WHAT THE BROWSER SAID, NEVER FROM THE MODEL.
 *
 * News and price answers came with no links at all — "직접 눌러 주셔야 해요" with nothing to press
 * (ux-review-0.5.4, item 10). A prompt rule asking the model to list its sources would cost every
 * turn and could invent a URL; the pages the Bot actually read are already in the turn, each result
 * carrying the address and title the browser reported. So they are read from there.
 *
 * Keyed on the answer: the LAST thing the Bot said in a turn that read at least one page, when that
 * came after the reading. A turn that read pages and then said nothing, or whose last word is still
 * a card's note, has no answer to hang them on and gets none. A failed read is not a source.
 *
 * NEAREST THE ANSWER FIRST, because the first is all an answer shows until "+n" is pressed
 * (`sources-row.tsx`): the page the Bot read last, then the ones before it; a search's results in
 * the order the search ranked them, behind any page opened since. They were kept in the order of
 * reading, which put first wherever the Bot began. Measured in the owner's own conversation,
 * 2026-10-04: asked for 성심당's opening hours, the Bot searched, opened the bakery's own page —
 * the search's first result — and answered "공식 홈페이지에서 확인했어요"; the list began with
 * placeview.co.kr and ended with the bakery. Asked for a share price on 토스증권, it began with a
 * page titled "페이지를 찾을 수 없습니다".
 *
 * ONE A SITE, BY THE NAME THE PILL SAYS (`siteNameOf`). A pill says the site and nothing else, so
 * two pages of one site are two pills nobody can tell apart — that share price's were 토스증권,
 * 토스증권, tradingkey.com, fintel.io, kr.investing.com, itooza.com, 토스증권. The page a site keeps
 * is its nearest the answer: of those three, the one titled "503,854원 +4.65% | 테슬라". By the
 * NAME and not the host: `search.naver.com` and `m.naver.com` are both 네이버 and one pill, and
 * 네이버 뉴스 is its own, as on a browsing task's title.
 */
export function sourcesByAnswer(
  items: readonly TranscriptItem[],
): Map<string, Source[]> {
  const found = new Map<string, Source[]>();
  // By how near the answer each is, the farthest first: a later reading is a nearer one.
  let read: Source[] = [];
  let answerId: string | null = null;
  const close = () => {
    if (answerId && read.length > 0) {
      found.set(answerId, nearestOfEachSite(read));
    }
    read = [];
    answerId = null;
  };
  for (const item of items) {
    if (item.kind === "text" && item.role === "user") {
      close();
      continue;
    }
    if (item.kind === "browse") {
      for (const step of item.steps) {
        if (!READING.has(step.name)) continue;
        const outcome = outcomeOf(step.result);
        if (outcome.ok === false || !isWebAddress(outcome.url)) continue;
        const url = outcome.url as string;
        read = read.filter((source) => source.url !== url);
        read.push({
          url,
          title: outcome.title?.trim() ?? "",
          host: hostOf(url),
        });
      }
      // Whatever the Bot said before this reading is not the answer to it.
      answerId = null;
      continue;
    }
    if (item.kind === "tool" && item.toolCall.function.name === WEB_SEARCH) {
      // Its first result last, which is nearest: that is the one the search ranked highest.
      for (const source of searchResultsOf(item.result).reverse()) {
        read = read.filter((seen) => seen.url !== source.url);
        read.push(source);
      }
      answerId = null;
      continue;
    }
    if (item.kind === "text" && item.role === "assistant" && read.length > 0) {
      answerId = item.id;
    }
  }
  close();
  return found;
}

/** One page a site, nearest the answer first, `MOST` at the most. `read` has the farthest first. */
function nearestOfEachSite(read: readonly Source[]): Source[] {
  const named = new Set<string>();
  const kept: Source[] = [];
  for (const source of [...read].reverse()) {
    const name = siteNameOf(source.host);
    if (named.has(name)) continue;
    named.add(name);
    kept.push(source);
    if (kept.length === MOST) break;
  }
  return kept;
}

function isWebAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
