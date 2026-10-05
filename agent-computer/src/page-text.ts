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
import { log } from "./log";
import { originOf } from "./navigation-guard";
import { type Arrival, arrivalOf, fromDocument } from "./page-arrival";
import { typedIntoBlind } from "./person-typing";
import {
  compactText,
  type FrameRead,
  type Hush,
  PLAIN_TEXT_SCRIPT,
  parseFrameRead,
  plainTextScript,
  readerScript,
  thrownInPage,
} from "./reader";
import { quietOn, typingsOn } from "./secret-fields";
import type { BotSession } from "./sessions";
import { within } from "./within";
import { cutAtCodeUnits } from "../../shared/sound-text";

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

/**
 * How long the page's content must stop changing to count as arrived.
 *
 * NETWORK IDLE NEVER COMES ON THE PAGES THIS PRODUCT READS MOST. Measured 2026-09-25 in the image:
 * Naver's search, weather and news section pages did not reach it in ten seconds (log beacons), so
 * every `/navigate` there paid the whole three-second cap. The content had stopped changing long
 * before — 1.2 to 1.6 s after `load` — and what was on the page then was what was on it three
 * seconds later (Naver search 11,827 characters both times, news section 12,787, smartstore's
 * rendered shell 1,403). The earlier of the two ends the wait, so a page that does go idle is read
 * as soon as it does.
 */
const DOM_QUIET_MS = 500;

/**
 * Resolves once nothing in the document has changed for `quietMs`, or at `capMs`. Runs in the page;
 * the observer is gone when it resolves.
 */
function quietInPage([quietMs, capMs]: [number, number]): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer = setTimeout(done, quietMs);
    const cap = setTimeout(done, capMs);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    function done() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve();
    }
  });
}

/** Let a page finish arriving. Never throws: every wait here is an optimisation, not a requirement. */
export async function settle(target: Page): Promise<void> {
  await target
    .waitForLoadState("load", { timeout: LOAD_CAP_MS })
    .catch(() => undefined);
  const idle = target
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_CAP_MS })
    .catch(() => undefined);
  /*
   * A document that goes away while it is watched is no answer: the network's wait stands then.
   * The two numbers are written into the source rather than passed: Playwright carries an argument
   * into the page with the page's own `Map`, and on a page that replaces it, as 고용24 does, the
   * array throws `refs.set is not a function` (`reader.ts`). The wait then falls to the network's,
   * which cost 고용24 nothing — it goes idle in 0.6 s — and a page that polls the whole cap.
   */
  const quiet = target
    .evaluate(
      `(${quietInPage.toString()})([${DOM_QUIET_MS}, ${NETWORK_IDLE_CAP_MS}])`,
    )
    .catch(() => idle);
  await Promise.race([idle, quiet]);
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

/** A frame's text, and whether it had to be read without the reader. */
type FrameText = FrameRead & { plain?: true };

/**
 * The fact for a read the page's own scripts kept the reader from: the text is its visible text,
 * read plainly, or nothing at all.
 */
export const PAGE_TEXT_PLAIN: NoteCode = "laf:page_text_plain";

/**
 * What one frame's rendered text is: its article when it has one, all of it otherwise (`reader.ts`).
 *
 * A PAGE CAN BREAK THE READER, AND IS THEN READ PLAINLY. 고용24 replaced the global `Map`, and the
 * reader's answer arrived as `undefined` — read as `main.read.text`, which threw, and `/navigate`
 * failed on a page a person sees in full. The reader answers with a string now, which that page
 * leaves alone; this is for the next page that breaks something else.
 *
 * TWO THINGS ARE THE PAGE'S DOING, AND NOTHING ELSE IS: the reader's script gave no answer it gives,
 * or the page's own JavaScript threw inside it — which the script catches in the page and says
 * (`thrownInPage`). An `evaluate` that rejects is neither: a renderer that crashed, a tab that
 * closed, a protocol error, a page that left for another. Those go up as they always did — to
 * `laf:browser_failed`, or to a second read of the page it went to (`readSettledPageText`) — and
 * are never answered as a page whose scripts kept it from being read.
 *
 * `hush` is what the text is made without (`reader.ts`), on the plain read too: a page that breaks
 * the reader is not read with a person's typing put back in.
 */
async function frameText(
  frame: Frame,
  whole: boolean,
  hush: Hush | undefined,
): Promise<FrameText> {
  const answer = await frame.evaluate(readerScript(whole, hush));
  const read = parseFrameRead(answer);
  if (read) return read;
  const thrown = thrownInPage(answer);
  /*
   * One line, so a page the reader cannot read is found in the log and not only by the Bot. Where,
   * as an origin, and what kind of error, by a name from our own list: the address past the origin
   * and an error's message can both carry what was on the page, and this is the process that holds
   * somebody's logins.
   */
  log.warn("reader_fell_back", {
    origin: originOf(frame.url()),
    frame: frame.parentFrame() ? "inner" : "main",
    reason: thrown ? "threw" : "no_answer",
    ...(thrown ? { error: thrown } : {}),
  });
  /*
   * Even this can fail on a page that takes `innerText` itself, and that is still an answer: empty,
   * with the fact that says it could not be read, which the Bot hears instead of a 502 over a page a
   * person can see.
   */
  const plain = parseFrameRead(
    await frame.evaluate(hush ? plainTextScript(hush) : PLAIN_TEXT_SCRIPT),
  );
  return { text: plain?.text ?? "", reader: false, plain: true };
}

export type PageText = {
  text: string;
  truncated: boolean;
  /**
   * The text is the page's article, not all of it (`reader.ts`). Said, because what Reader View
   * leaves out — a price box beside the story, a button's caption — is sometimes the answer, and a
   * Bot that knows the page was abridged can read it whole.
   */
  reader?: true;
  /**
   * The page's own scripts kept the reader from running, so the text is what the page shows, read
   * plainly — or empty, when even that did not answer, which is not the same as an empty page.
   * Carried to the model as {@link PAGE_TEXT_PLAIN} by the route that read it.
   */
  plain?: true;
  /** `from` was asked for and is nowhere on the page, so the text starts at the top as usual. */
  fromMissing?: true;
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

/** Every frame's text, the main frame's first: one making of what {@link readablePageText} hands on. */
async function framesText(
  target: Page,
  deadline: number,
  whole: boolean,
  hush: Hush | undefined,
): Promise<{
  main: FrameText;
  others: { frame: Frame; url: string }[];
  texts: (FrameText | undefined)[];
}> {
  // Its failure kept apart from its silence: a page that moved is read again, one that is silent is not.
  const main = await fromDocument(
    target,
    deadline - Date.now(),
    frameText(target.mainFrame(), whole, hush).then(
      (read) => ({ read }),
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
    others.map(({ frame }) => within(wait, frameText(frame, whole, hush))),
  );
  return { main: main.read, others, texts };
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
  whole: boolean,
  from: string | undefined,
  session: BotSession | undefined,
): Promise<PageText> {
  /*
   * WHAT A PERSON TYPED INTO THIS TAB IS NOT READ OUT OF IT. The reader is told to leave marked
   * nodes out whenever one of this tab's documents is one a person typed into (`quietOn`) —
   * whether or not such a node is in the document at the moment it is asked, since the reader
   * finds the marked nodes itself, in the same question that makes the text, and one put back a
   * moment later is then left out too. A tab nobody typed on is read exactly as before. One mark
   * for every frame — a frame with no marked node in it finds none. No token: a read marks nothing
   * near, so it cannot disturb a look of the same tab that is under way.
   */
  const typedInto = (inSession: BotSession) =>
    quietOn(
      inSession,
      target,
      typedIntoBlind(inSession, target),
      deadline - Date.now(),
    );
  let typings = session ? typingsOn(session, target) : 0;
  const told = session ? await typedInto(session) : undefined;
  let made = await framesText(
    target,
    deadline,
    whole,
    told?.present ? { mark: told.mark, every: told.every } : undefined,
  );
  /*
   * AND A PERSON MAY BEGIN TYPING WHILE THE TEXT IS BEING MADE: a read is not refused while they
   * hold the wheel. Asked once, before the main frame, a tab nobody had typed on was read with
   * nothing left out — its frames one after another, a paste into a region of one of them landing
   * in between.
   *
   * WHAT SAYS SO IS A COUNT THAT ONLY GROWS, NOT THE RECORD OF WHERE. For one commit the record was
   * asked again after the text, and the record forgets: the frame they typed in had closed by
   * then, or the tab typed into blind had moved to its next document, the record said nothing,
   * and the text made with their typing in it was handed on. The count of their typings on this
   * tab is written before a key is sent and never taken back (`typingsOn`), so one that has not
   * moved since before the page was asked means no text made here holds a key of theirs; one that
   * has means THIS TEXT IS NOT HANDED ON, whatever the record says now. It is made again with the
   * reader told to look — which it does frame by frame, in the question that reads each — until
   * one making goes by with the count still, or the read's time is spent and it fails as a
   * silent document does. A person begins typing somewhere NEW a few times a minute at most:
   * that is what the count counts, not their keys.
   *
   * Left, and said in docs/laf/browser-limits.md: the masked card, which marks its field after
   * the value has landed (`control-routes.ts`).
   */
  while (session && typingsOn(session, target) !== typings) {
    if (Date.now() >= deadline) throw new DocumentSilentError();
    typings = typingsOn(session, target);
    const now = await typedInto(session);
    made = await framesText(target, deadline, whole, {
      mark: now.mark,
      every: now.every,
    });
  }
  const { main, others, texts } = made;

  const pieces = [main.text];
  let reader = main.reader;
  /*
   * The page's own read only. An advertiser's frame that broke the reader is read plainly and merged
   * like any other frame — a frame is read whole unless it is an article anyway — and saying the
   * page could not be read because one of forty ad frames could not is a fact about nothing the
   * Bot asked for. A frame that could not be read even plainly is what it always was: opaque.
   */
  const plain = main.plain === true;
  const frames: NonNullable<PageText["frames"]> = [];
  others.forEach(({ url }, index) => {
    const read = texts[index];
    if (read === undefined || (read.plain && !read.text.trim())) {
      frames.push({ url, chars: 0, code: "laf:frame_opaque" });
      return;
    }
    const trimmed = compactText(read.text);
    if (!trimmed) return;
    reader ||= read.reader;
    pieces.push(trimmed);
    frames.push({ url, chars: trimmed.length });
  });

  const all = pieces.map(compactText).filter(Boolean).join("\n\n");
  /*
   * WHAT THE CAP LEFT OUT WAS OUT OF REACH. Scrolling does not change a page's text, and reading
   * again read the same first 6,000 characters: measured on Naver's search for a product, where the
   * advertisers' prices fill the top and the price comparison starts past the cap, the Bot scrolled,
   * snapshotted and clicked for three steps and still answered with two products of three. `from`
   * starts the extract at the words it names — a heading the Bot saw in the part it did get.
   */
  const at = from ? all.indexOf(from) : -1;
  const collapsed = at > 0 ? all.slice(at) : all;
  return {
    text: cutAtCodeUnits(collapsed, TEXT_EXTRACT_LIMIT),
    truncated: collapsed.length > TEXT_EXTRACT_LIMIT,
    ...(from && at < 0 ? { fromMissing: true as const } : {}),
    ...(reader ? { reader: true as const } : {}),
    ...(plain ? { plain: true as const } : {}),
    ...(frames.length ? { frames } : {}),
  };
}

/**
 * The same, once the page has stopped moving, and once more if it moved while being read — or, when
 * the page's document does not answer because the next one is on its way, nothing but that fact.
 *
 * `session` is whose read it is. Every route that hands a page's text to a Bot passes it: it is
 * how the text is made without what a person typed into the page (`readablePageText`).
 */
export async function readSettledPageText(
  target: Page,
  options: {
    settleFirst?: boolean;
    whole?: boolean;
    from?: string;
    session?: BotSession;
  } = {},
): Promise<PageText> {
  const deadline = Date.now() + READ_DEADLINE_MS;
  if (options.settleFirst) await settle(target);
  else if (!(await settleIfLoading(target))) {
    const arrival = arrivalOf(target);
    if (arrival) return stillArriving(arrival);
  }
  const attempt = async (): Promise<PageText> => {
    try {
      return await readablePageText(
        target,
        deadline,
        options.whole === true,
        options.from,
        options.session,
      );
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
