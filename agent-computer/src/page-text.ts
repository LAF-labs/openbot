/**
 * The page as a person reads it: waited for, then read as text, iframes included.
 *
 * `/navigate` hands this back for the page it opened and `/read` for the page as it is now, because
 * opening a page is not the only way to change what is on the screen: the Bot presses "Submit
 * order", the page becomes a confirmation, and "I clicked the button" is not an answer to what the
 * confirmation said.
 */
import type { Frame, Page } from "playwright";
import type { NoteCode } from "./codes";
import { type Arrival, arrivalOf, fromDocument } from "./page-arrival";
import { within } from "./within";

/**
 * How much page text a navigation hands back.
 *
 * Bounded because a page can be megabytes and the text goes into a model's context, where a single
 * unbounded page can push the rest of the conversation out. Generous enough that the visible part of
 * an ordinary page arrives whole, which is what the answer is usually made of.
 */
const TEXT_EXTRACT_LIMIT = 6000;

/**
 * How long a page is given to go quiet before it is read.
 *
 * `domcontentloaded` was where this used to read, and on an SPA shell — 스마트스토어, 홈택스 — that is
 * the skeleton: measured against smartstore.naver.com, the extract was zero characters and the
 * snapshot zero elements, on a page a person sees a login form on. Capped rather than waited out,
 * because a portal with a polling advertisement never reaches network idle at all and the Bot would
 * sit there for the full navigation timeout instead of reading what is plainly on the screen.
 */
const NETWORK_IDLE_CAP_MS = 3_000;

/** And a moment for the load event, which most pages reach long before the network does. */
const LOAD_CAP_MS = 1_000;

/** How long a page is given to say whether it has finished loading. A page with a document answers in milliseconds. */
const READY_STATE_WAIT_MS = 1_000;

/**
 * HOW LONG A READ MAY TAKE, WHATEVER THE PAGE IS DOING.
 *
 * There was no bound: the text was asked of the document with `evaluate`, which has no timeout, and
 * a tab whose next document is on its way answers nothing until it arrives (`page-arrival.ts`).
 * Measured 2026-09-14 in the image built from dbc1c67, a `/read` one second into a `/navigate` to the
 * fixture's `/hang`: 502 `laf:browser_failed` at 29.1 s, which is when `/navigate` gave the page up
 * and closed the tab under it. The same as `SNAPSHOT_DEADLINE_MS` in snapshot.ts, a third of the
 * server client's, and every wait below fits in it: settling (up to 4 s, twice when the page moves
 * while it is read), the page's own text and each frame's ({@link FRAME_TEXT_WAIT_MS}, all at once).
 */
export const READ_DEADLINE_MS = 15_000;

/** How long a frame other than the page's own is given to say what it holds. They are asked all at once. */
const FRAME_TEXT_WAIT_MS = 3_000;

/** How long a title is waited for. A document answers in milliseconds, and a list of tabs waits for every one. */
const TITLE_WAIT_MS = 1_000;

/** Let a page finish arriving. Never throws: every wait here is an optimisation, not a requirement. */
export async function settle(target: Page): Promise<void> {
  await target
    .waitForLoadState("load", { timeout: LOAD_CAP_MS })
    .catch(() => undefined);
  await target
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_CAP_MS })
    .catch(() => undefined);
}

/**
 * Settle only a page that is still arriving, and say whether the document answered at all.
 *
 * Reading and snapshotting happen far more often than navigating, usually on a page that has been
 * sitting there for a minute — and a portal with a polling advertisement never reaches network idle
 * at all, so waiting unconditionally would put three seconds on every one of those calls. The page
 * that IS still loading is the one that matters here: the tab a `target=_blank` link just opened is
 * `about:blank` for the first fraction of a second, and a snapshot of it lists nothing.
 *
 * The question is bounded, and a failure counts as finished — a page that went somewhere while being
 * asked is read as the page it went to. No answer is `false`: with a document known to be on its way
 * the caller answers with that (`arrivalOf`) rather than settling a page that is not there yet; without
 * one, it settles as it always did and reads what answers in its deadline.
 */
export async function settleIfLoading(target: Page): Promise<boolean> {
  const ready = await fromDocument(
    target,
    READY_STATE_WAIT_MS,
    target.evaluate(() => document.readyState).catch(() => "complete"),
  );
  if (ready === "complete") return true;
  if (ready === undefined && arrivalOf(target)) return false;
  await settle(target);
  return ready !== undefined;
}

/**
 * The document's own title, or nothing.
 *
 * NOT `page.title()`, which answers at once while a document is on its way — with Playwright's own
 * `Loading ` and the whole address the tab is going to. That is not the page's title, and it carries
 * whatever the address carries: measured 2026-09-14 in the image built from dbc1c67, a person typed a
 * secret into the fixture's `/to-hang` box, Enter sent its GET form to `/hang`, and `/tabs/switch`
 * answered in 10 ms with the tab titled `Loading http://…/hang?pin=` and the secret. Asked of the document
 * instead, which either answers with its title or does not answer; a tab whose next document is known
 * to be on its way is not asked, and has none.
 */
export async function titleOf(page: Page): Promise<string> {
  if (arrivalOf(page)) return "";
  const title = await within(
    TITLE_WAIT_MS,
    page.evaluate(() => document.title),
  );
  return typeof title === "string" ? title : "";
}

/**
 * A page moving under us while we read it.
 *
 * The SPA shells redirect on first load — hometax.go.kr answered `/navigate` with a 502 and the
 * words "Execution context was destroyed" before this existed, which a Bot reads as a broken
 * computer rather than as a page that had just gone somewhere else.
 */
function isNavigatingAway(error: unknown): boolean {
  return /Execution context was destroyed|frame was detached|Target closed|Navigation to/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * The page's document did not answer by the read's deadline, and no document is known to be on its
 * way — a page that is busy rather than one that is leaving. The browser did not do what it was asked.
 */
class DocumentSilentError extends Error {
  constructor() {
    super("laf:browser_failed");
    this.name = "DocumentSilentError";
  }
}

/** What one frame's rendered text is. */
async function frameText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.body?.innerText ?? "");
}

export type PageText = {
  text: string;
  truncated: boolean;
  /** The iframes that contributed, and the ones that would not. */
  frames?: { url: string; chars: number; code?: NoteCode }[];
  /**
   * The tab's document is on its way, so nothing here is read from a page: `text` is empty, and the
   * caller says so with `laf:page_loading` (`arrivalNote`).
   */
  arriving?: Arrival;
};

/** Nothing read, because nothing is there to read yet. */
function stillArriving(arrival: Arrival): PageText {
  return { text: "", truncated: false, arriving: arrival };
}

/**
 * The page as text, the way a reader sees it.
 *
 * THE LIVE BODY, NOT A COPY OF IT. This used to clone `<body>`, strip script and style nodes and
 * read `innerText` off the clone — and `innerText` on a node that is not in the document is defined
 * to be `textContent`: no line breaks, and every hidden thing included. Measured on ceo.baemin.com
 * before the change: 331 characters, zero newlines, the whole of it a mega-menu that is not on the
 * screen. Read live, the same page yields the text a person sees, in the shape they see it, and the
 * script and style bodies drop out on their own because they are not rendered.
 *
 * iframes are merged in. A Korean site puts its real content in one more often than not — 홈택스's
 * body, a payment window, a 본인인증 panel — and `evaluate` only ever sees the main frame. A frame
 * that will not answer in time is reported as `laf:frame_opaque` rather than left out silently,
 * because "there was nothing there" and "there was something and I could not read it" lead a Bot to
 * opposite next moves.
 */
async function readablePageText(
  target: Page,
  deadline: number,
): Promise<PageText> {
  // Its failure kept apart from its silence: a page that moved is read again, one that is silent is not.
  const main = await fromDocument(
    target,
    deadline - Date.now(),
    frameText(target.mainFrame()).then(
      (text) => ({ text }),
      (error: unknown) => ({ error }),
    ),
  );
  if (!main) throw new DocumentSilentError();
  if ("error" in main) throw main.error;

  const others = target
    .frames()
    .filter((frame) => frame !== target.mainFrame())
    .map((frame) => ({ frame, url: frame.url() }))
    .filter(({ url }) => url && url !== "about:blank");
  const wait = Math.min(FRAME_TEXT_WAIT_MS, deadline - Date.now());
  const texts = await Promise.all(
    others.map(({ frame }) => within(wait, frameText(frame))),
  );

  const pieces = [main.text];
  const frames: NonNullable<PageText["frames"]> = [];
  others.forEach(({ url }, index) => {
    const text = texts[index];
    if (text === undefined) {
      frames.push({ url, chars: 0, code: "laf:frame_opaque" });
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    pieces.push(trimmed);
    frames.push({ url, chars: trimmed.length });
  });

  const collapsed = pieces
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    text: collapsed.slice(0, TEXT_EXTRACT_LIMIT),
    truncated: collapsed.length > TEXT_EXTRACT_LIMIT,
    ...(frames.length ? { frames } : {}),
  };
}

/**
 * The same, once the page has stopped moving, and once more if it moved while being read — or, when
 * the page's document does not answer because the next one is on its way, nothing but that fact.
 */
export async function readSettledPageText(
  target: Page,
  options: { settleFirst?: boolean } = {},
): Promise<PageText> {
  const deadline = Date.now() + READ_DEADLINE_MS;
  if (options.settleFirst) await settle(target);
  else if (!(await settleIfLoading(target))) {
    const arrival = arrivalOf(target);
    if (arrival) return stillArriving(arrival);
  }
  const attempt = async (): Promise<PageText> => {
    try {
      return await readablePageText(target, deadline);
    } catch (error) {
      const arrival =
        error instanceof DocumentSilentError ? arrivalOf(target) : undefined;
      if (arrival) return stillArriving(arrival);
      throw error;
    }
  };
  try {
    return await attempt();
  } catch (error) {
    if (!isNavigatingAway(error)) throw error;
    await settle(target);
    return attempt();
  }
}
