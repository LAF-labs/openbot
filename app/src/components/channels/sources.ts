import { DEFERRED_TOOL_PREFIX, WEATHER_TOOL_NAME } from "@shared/tools/bridge";
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

/** At most this many, newest reading last. An answer quoting twenty pages is not a thing to list. */
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
    if (item.kind === "tool" && item.toolCall.function.name === WEB_SEARCH) {
      for (const source of searchResultsOf(item.result)) {
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

/**
 * DATA THAT HAS TO SAY WHERE IT CAME FROM, ON THE SCREEN IT IS SHOWN ON.
 *
 * 기상청's weather data, and anything said from it, has had to carry a source line since 2026-09-18
 * (기상법 as amended; the API hub's notice of 2026-09-14, "기상기후데이터 사용 시 출처표시 안내", and
 * the guide attached to it: `출처: 기상청`, readable where the person sees the data — a link or a
 * button alone does not count). The Bot's weather answer read "서울은 지금 17.7도" with nothing under
 * it, and the step line that names 기상청 can sit behind a later step.
 *
 * By the call's own name, to the English key the surface has words for. `t(variable)` is invisible
 * to the coverage test, so `answer-sources.test.ts` walks this table.
 */
export const CREDITED: Readonly<Record<string, string>> = {
  [WEATHER_TOOL_NAME]: "Korea Meteorological Administration",
};

/** Whether a credited call came back with data: the tool's own object, not a sentence about why not. */
function gaveData(result: string | undefined): boolean {
  if (!result) return false;
  try {
    const parsed: unknown = JSON.parse(result);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { source?: unknown }).source === "string"
    );
  } catch {
    return false;
  }
}

/**
 * WHO EACH ANSWER HAS TO NAME, TAKEN FROM THE CALLS OF ITS TURN, NEVER FROM THE MODEL.
 *
 * Every sentence the Bot says after such a call, until the person speaks again, carries the credit:
 * nothing says which of them the weather is in, and a line too many under a turn is a smaller
 * wrong than weather said with none. The model is asked to write the line too (the tool's
 * description says so) — that is for places with no transcript; here it is drawn whatever was
 * written.
 *
 * NOT UNDER A SENTENCE STILL BEING WRITTEN. The model ends its answer with the line, and the screen
 * leaves its own out where the answer's words carry it (`CreditLine`) — so a line drawn under a
 * growing answer stood for the seconds the model took to reach its own, and then went. `writing` is
 * the turn still running, and the row being written is the last one. A sentence with anything
 * after it is finished and gets its line at once, however long the rest of the turn takes: the
 * pages wait for the whole turn, and this must not.
 */
export function creditsByAnswer(
  items: readonly TranscriptItem[],
  writing: boolean,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let owed: string[] = [];
  /*
   * WHAT IS OWED IS OWED UNTIL IT HAS BEEN SAID. The person's next message ended it, on the
   * reading that a message begins a turn and what follows answers it. But a turn can be started
   * while another is still running — a card's button does it (`channel-chat.tsx`) — and then that
   * message lands between the first turn's weather and the first turn's answer: the answer said
   * from the data came after a message that had wiped the debt (Codex on pull request 50). The rows
   * carry no turn to go by, so a message ends only a debt some sentence has already carried. The
   * cost is the other way round: a turn that fetched the weather and said nothing leaves the line
   * to the next answer, which is one line too many.
   */
  let isSaid = true;
  for (const [index, item] of items.entries()) {
    if (item.kind === "text" && item.role === "user") {
      if (isSaid) owed = [];
      continue;
    }
    if (item.kind === "tool") {
      const name = CREDITED[item.toolCall.function.name];
      if (name && gaveData(item.result)) {
        if (!owed.includes(name)) owed = [...owed, name];
        isSaid = false;
      }
      continue;
    }
    if (item.kind === "browse") {
      /*
       * What the Bot said between two steps of a browsing task is drawn INSIDE the task's card
       * (`withBrowsingTasks`), not as a row of its own — "비가 온다니 우산 파는 곳을 찾아볼게요",
       * said from the weather and then folded into the card it led to, had no line (Codex on pull
       * request 50). The card is named, and the line is drawn under it.
       */
      if (owed.length > 0 && item.notes.length > 0) {
        found.set(item.id, owed);
        isSaid = true;
      }
      continue;
    }
    if (item.kind === "text" && item.role === "assistant" && owed.length > 0) {
      if (writing && index === items.length - 1) continue;
      found.set(item.id, owed);
      isSaid = true;
    }
  }
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
