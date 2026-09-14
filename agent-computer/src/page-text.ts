/**
 * The page as a person reads it: waited for, then read as text, iframes included.
 *
 * `/navigate` hands this back for the page it opened and `/read` for the page as it is now, because
 * opening a page is not the only way to change what is on the screen: the Bot presses "Submit
 * order", the page becomes a confirmation, and "I clicked the button" is not an answer to what the
 * confirmation said.
 */
import type { Frame, Page } from "playwright";

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
 * Settle only a page that is still arriving.
 *
 * Reading and snapshotting happen far more often than navigating, usually on a page that has been
 * sitting there for a minute — and a portal with a polling advertisement never reaches network idle
 * at all, so waiting unconditionally would put three seconds on every one of those calls. The page
 * that IS still loading is the one that matters here: the tab a `target=_blank` link just opened is
 * `about:blank` for the first fraction of a second, and a snapshot of it lists nothing.
 */
export async function settleIfLoading(target: Page): Promise<void> {
  const ready = await target
    .evaluate(() => document.readyState)
    .catch(() => "complete");
  if (ready !== "complete") await settle(target);
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

/** What one frame's rendered text is. */
async function frameText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.body?.innerText ?? "");
}

export type PageText = {
  text: string;
  truncated: boolean;
  /** The iframes that contributed, and the ones that would not. */
  frames?: { url: string; chars: number; code?: string }[];
};

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
 * that will not answer is reported as `laf:frame_opaque` rather than left out silently, because
 * "there was nothing there" and "there was something and I could not read it" lead a Bot to opposite
 * next moves.
 */
async function readablePageText(target: Page): Promise<PageText> {
  const pieces = [await frameText(target.mainFrame())];
  const frames: NonNullable<PageText["frames"]> = [];

  for (const frame of target.frames()) {
    if (frame === target.mainFrame()) continue;
    const url = frame.url();
    if (!url || url === "about:blank") continue;
    try {
      const text = (await frameText(frame)).trim();
      if (!text) continue;
      pieces.push(text);
      frames.push({ url, chars: text.length });
    } catch {
      frames.push({ url, chars: 0, code: "laf:frame_opaque" });
    }
  }

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

/** The same, once the page has stopped moving, and once more if it moved while being read. */
export async function readSettledPageText(
  target: Page,
  options: { settleFirst?: boolean } = {},
): Promise<PageText> {
  if (options.settleFirst) await settle(target);
  else await settleIfLoading(target);
  try {
    return await readablePageText(target);
  } catch (error) {
    if (!isNavigatingAway(error)) throw error;
    await settle(target);
    return readablePageText(target);
  }
}
