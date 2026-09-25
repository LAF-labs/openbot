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

/** At most this many, newest reading last. An answer quoting twenty pages is not a thing to list. */
const MOST = 8;

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
 */
export function sourcesByAnswer(
  items: readonly TranscriptItem[],
): Map<string, Source[]> {
  const found = new Map<string, Source[]>();
  let read: Source[] = [];
  let answerId: string | null = null;
  const close = () => {
    if (answerId && read.length > 0) found.set(answerId, read.slice(-MOST));
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
    if (item.kind === "text" && item.role === "assistant" && read.length > 0) {
      answerId = item.id;
    }
  }
  close();
  return found;
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
