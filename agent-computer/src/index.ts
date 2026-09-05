import { serve } from "bun";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Frame, Page } from "playwright";
import { parseAriaSnapshot, type SnapshotElement } from "./aria-snapshot";
import {
  BOT_ID_INVALID,
  isBotId,
  isOpenPath,
  matchesToken,
  offeredToken,
} from "./authorisation";
import {
  type Control,
  ControlError,
  ControlRequestError,
  type ControlState,
  createControl,
  NO_SECRET_PENDING,
  restoredControl,
  TAKE_CONTROL_FIRST,
} from "./control";
import {
  createProfiles,
  TabError,
  type TabSummary,
  VIEWPORT,
} from "./profiles";
import {
  type InputMessage,
  type Screencast,
  startScreencast,
} from "./screencast";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspacePathError,
} from "./workspace";

/**
 * The Bot's computer: one long-lived browser, reachable over HTTP.
 *
 * Acting on a page lives in this process because only this process holds the browser. In the
 * intended deployment path, the server gateway decides whether an action may run and records the
 * audit row before calling this process. This process has no policy engine and no audit trail of its
 * own; its direct-port boundary is the computer token.
 *
 * `/files/read` and `/files/write` reach the durable workspace volume, confined to
 * it by workspace.ts. Reading and writing are the two operations a Bot needs to keep notes between
 * turns.
 *
 * Elements are addressed by reference, not by pixel. `/snapshot` stamps every interactive element
 * with a ref and hands back a compact list; `/click` and `/type` take one of those refs. That is the
 * accessibility-tree-first driver this is built on, and it is why filling in a form needs no
 * vision model at all: the Bot reads a list of fields rather than squinting at a picture and guessing
 * coordinates. Pixels remain the eventual fallback for canvas-style pages that expose no elements.
 *
 * One browser stays open so state survives between
 * turns: a session it signed into an hour ago is still signed in now. Launching per request would
 * make every task start from a cold, logged-out browser, which is the behaviour we are specifically
 * trying not to have.
 *
 * It authenticates its caller: every request must present the secret below, and the process refuses
 * to start without one. That is a lock on the door rather than a reason to put the door somewhere
 * public. It still belongs on the deployment network, behind the server that decides who is asking.
 */

/**
 * The secret every caller must present.
 *
 * This process drives a browser that holds real logins. Policy, audit, actor identity and SPIFFE
 * identity live in the server and are not on the direct computer port.
 *
 * Refusing to start without a token makes missing authentication a deployment failure, never an open
 * computer.
 */
const COMPUTER_TOKEN = process.env.COMPUTER_TOKEN?.trim();
if (!COMPUTER_TOKEN) {
  console.error(
    "COMPUTER_TOKEN is not set. This process drives a browser holding real logins and will not start without the secret its caller must present.",
  );
  process.exit(1);
}

const PORT = Number.parseInt(process.env.PORT ?? "4100", 10);
const NAVIGATION_TIMEOUT_MS = Number.parseInt(
  process.env.NAVIGATION_TIMEOUT_MS ?? "30000",
  10,
);

/**
 * How long one action waits for its element.
 *
 * Much shorter than a navigation. Playwright waits for a control to become clickable, which is the
 * behaviour we want, but a ref that no longer resolves would otherwise hang for the full navigation
 * timeout before saying so, and the person is sitting watching a screen that is not changing.
 */
const ACTION_TIMEOUT_MS = Number.parseInt(
  process.env.ACTION_TIMEOUT_MS ?? "10000",
  10,
);

/**
 * How much page text a navigation hands back.
 *
 * Bounded because a page can be megabytes and the text goes into a model's context, where a single
 * unbounded page can push the rest of the conversation out. Generous enough that the visible part of
 * an ordinary page arrives whole, which is what the answer is usually made of.
 */
const TEXT_EXTRACT_LIMIT = 6000;

/**
 * Which snapshot the caller's refs came from.
 *
 * Kept as a caller-facing guard even though Playwright enforces the real thing underneath. The
 * published tool contract says an action carries the `snapshotId` it got, and a mismatch is answered
 * with "take a new snapshot", which is a clearer message for a model than an element that merely fails
 * to resolve. Playwright's `aria-ref` engine is the runtime enforcement: it resolves a ref only against
 * the most recent snapshot, only while the element is still connected to the document, and it mints a
 * new ref if an element's role or accessible name changed, so a recycled node cannot inherit an old one.
 */
/**
 * Something the browser noticed that nothing asked it about.
 *
 * A CODE AND ITS FACTS, NEVER A SENTENCE. An alert that says 로그인이 필요합니다 is the answer to why
 * a click did nothing, and Playwright dismisses it before any tool call returns — so the fact has to
 * travel out of band, on the next result, or the Bot reports "I clicked it" about a page that never
 * moved. The Korean the model reads for each code is in `shared/prompt/tool-results.ko.ts`, for the
 * same reason `laf:human_has_control` lives there: this container ships facts and knows no locale.
 */
export type ComputerNote = { code: string } & Record<string, unknown>;

/**
 * How many of them one result carries.
 *
 * A page that opens an alert in a loop would otherwise fill a model's context with the same
 * sentence. The newest are kept: the last dialog is the one the Bot is standing in front of.
 */
const MAX_NOTES = 8;

/** Per-Bot browser-control state. Profiles are isolated, but this process is not a security boundary. */
type BotSession = {
  control: Control;
  /** This Bot's snapshot generation. See the note above on staleness. */
  snapshotId: number;
  /** Facts waiting to ride out on the next tool result. Drained when they do. */
  notes: ComputerNote[];
  /** The one live screen viewer for this Bot, if a person is watching. */
  viewer?: {
    socket: unknown;
    cast: Screencast;
    /** Stops the loop that keeps the cast pointed at whatever page the Bot is actually on. */
    follow?: ReturnType<typeof setInterval>;
  };
};

const sessions = new Map<string, BotSession>();

function sessionFor(botId: string): BotSession {
  const existing = sessions.get(botId);
  if (existing) return existing;
  /*
   * WHO HAD THE WHEEL BEFORE THIS PROCESS STARTED.
   *
   * A restart in the middle of a takeover used to hand the browser back to the Bot in silence: the
   * person was still looking at a bank's login form, and the Bot was free to click on it. Control is
   * written to the profile directory on every change, and read back here, so a restart cannot quietly
   * promote a Bot. See `restoredControl` for what survives and what does not.
   */
  const restored = restoredControl(readControlFile(botId));
  const created: BotSession = {
    control: createControl(undefined, {
      ...(restored.state ? { initial: restored.state } : {}),
      onChange: (state) => writeControlFile(botId, state),
    }),
    snapshotId: 0,
    notes: restored.secretLost ? [{ code: "laf:secret_request_lost" }] : [],
  };
  sessions.set(botId, created);
  return created;
}

/** Put a fact in front of the Bot on its next call. */
function note(session: BotSession, entry: ComputerNote): void {
  session.notes.push(entry);
  if (session.notes.length > MAX_NOTES) {
    session.notes.splice(0, session.notes.length - MAX_NOTES);
  }
}

/** Everything waiting, handed over once. A fact delivered twice reads as it having happened twice. */
function drainNotes(session: BotSession): ComputerNote[] {
  return session.notes.splice(0, session.notes.length);
}

/** One response, with whatever the browser noticed since the last one attached to it. */
function withNotes(
  session: BotSession,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const notes = drainNotes(session);
  return notes.length ? { ...body, notes } : body;
}

/** Where a Bot's control state is kept between lives of this process. */
function controlFileFor(botId: string): string {
  return join(profiles.directoryFor(botId), "control.json");
}

function readControlFile(botId: string): unknown {
  try {
    return JSON.parse(readFileSync(controlFileFor(botId), "utf8"));
  } catch {
    // No file is the ordinary case: a Bot that has never been driven. An unreadable one is treated
    // the same way, because the fail-safe below only ever makes control stickier, never looser.
    return null;
  }
}

/**
 * Written on every change, synchronously.
 *
 * Synchronous because the case this exists for is the process ending: an async write scheduled a
 * millisecond before SIGKILL is a write that never happened, and the state it was carrying is
 * exactly the one somebody is relying on.
 */
function writeControlFile(botId: string, state: ControlState): void {
  try {
    const path = controlFileFor(botId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "control-state-not-saved",
        bot: botId,
        error: String(error),
      }),
    );
  }
}

/**
 * Which Bot is asking. Null when nobody said.
 *
 * REFUSED RATHER THAN GUESSED. This used to fall back to a fixed `"shared"` computer so the
 * container stayed demonstrable on its own, and the server had a `"default"` of its own at the other
 * end — two spellings of the blank page belonging to nobody that CLAUDE.md warns about. A caller
 * that does not name a Bot is a bug in the caller, and it is told so.
 */
function botIdOf(request: Request, fallback?: string | null): string | null {
  return (
    request.headers.get("x-openbot-bot-id")?.trim() || fallback?.trim() || null
  );
}

/**
 * The Bot's durable files.
 *
 * Rooted at WORKSPACE_DIR, which the image creates and docker-compose mounts as a volume, so what a
 * Bot saves outlives the container. Built once at boot: the root is fixed, and resolving it per request
 * would only add a syscall to every call. Everything about why confinement is harder than it looks
 * lives in workspace.ts.
 */
const workspace = createWorkspace(process.env.WORKSPACE_DIR ?? "/workspace");

/**
 * Who has the wheel, as a state machine in its own module.
 *
 * The state machine lives in `control.ts` so it can be tested without importing Playwright.
 */

/**
 * The Bot's browser and the profile that outlives it. See profiles.ts.
 *
 * `chromium.launch()` gives a fresh anonymous profile every time. Persistent profiles live on a
 * mounted volume so sign-in state survives the container.
 */
const profiles = createProfiles(process.env.PROFILES_DIR ?? "/profiles", {
  onPage: (botId, page) => watchPage(botId, page),
});

async function currentPage(botId: string): Promise<Page> {
  return profiles.page(botId);
}

/**
 * Everything a page can tell us that no tool call would ever return.
 *
 * Attached the moment a page exists, including a page a site opened by itself, because both of the
 * things below happen without anybody asking: a dialog blocks the page until it is answered, and a
 * download starts and finishes while the Bot is still waiting for a click to return.
 */
function watchPage(botId: string, page: Page): void {
  const session = sessionFor(botId);
  /*
   * A different document means every ref from the last snapshot names something nobody is looking
   * at. The generation is bumped for a new tab for the same reason `/navigate` bumps it.
   */
  session.snapshotId += 1;

  page.on("dialog", (dialog) => {
    const kind = dialog.type();
    /*
     * ALERT IS ACCEPTED, CONFIRM AND PROMPT ARE DISMISSED.
     *
     * An alert has one button and answering it is not a decision. A confirm is a decision — 정말
     * 삭제하시겠습니까? — and this process is not where a Bot gets to make one: the boundary in front
     * of it never saw the question, so there is nothing for it to have decided. Dismissed, reported,
     * and the person handles it by taking the wheel. `beforeunload` is accepted because the Bot
     * asked to leave the page and that is the answer to its own question.
     */
    const accepting = kind === "alert" || kind === "beforeunload";
    void (accepting ? dialog.accept() : dialog.dismiss()).catch(
      () => undefined,
    );
    note(session, {
      code: "laf:dialog",
      kind,
      // The page's own words. Not a value anybody typed, and it is usually the whole reason the last
      // action did nothing.
      message: dialog.message(),
      accepted: accepting,
    });
  });

  page.on("download", (download) => {
    void (async () => {
      try {
        const saved = await workspace.saveDownload(
          download.suggestedFilename(),
          (to) => download.saveAs(to),
        );
        note(session, {
          code: "laf:downloaded",
          path: saved.path,
          bytes: saved.bytes,
        });
      } catch (error) {
        await download.cancel().catch(() => undefined);
        note(session, {
          code:
            error instanceof WorkspaceFileError
              ? "laf:download_too_large"
              : "laf:download_failed",
        });
        console.error(
          JSON.stringify({
            type: "download-not-saved",
            bot: botId,
            error: String(error),
          }),
        );
      }
    })();
  });
}

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
async function settle(target: Page): Promise<void> {
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
async function settleIfLoading(target: Page): Promise<void> {
  const ready = await target
    .evaluate(() => document.readyState)
    .catch(() => "complete");
  if (ready !== "complete") await settle(target);
}

/**
 * How long an action waits to see whether it opened a tab.
 *
 * Measured on the fixture: the context's `page` event arrives 30-32 ms after the click resolves,
 * five times out of five. The bound is several times that and it is paid in full only by a click
 * that opens nothing — which is the trade being made, because the alternative is that a Bot clicks
 * 주문 상세 보기 on 네이버, the page opens in a tab this process has not adopted yet, and the snapshot
 * it takes next describes the page it was already on. It then reports on the wrong screen entirely.
 */
const POPUP_GRACE_MS = 150;

/**
 * Listen for a tab before the thing that might open one, and stop listening after it.
 *
 * Registered BEFORE the action, because a popup that arrives while the click is still resolving
 * would be missed by a listener set up afterwards. The returned function is what the action awaits:
 * it ends at the event or at the grace period, whichever comes first, so a click that opens nothing
 * costs the grace and no more.
 */
function watchForTab(target: Page): () => Promise<void> {
  const appeared = target
    .context()
    // The listener has to outlive the action itself; the race below is what bounds the waiting.
    .waitForEvent("page", { timeout: ACTION_TIMEOUT_MS + POPUP_GRACE_MS })
    .then(() => undefined)
    .catch(() => undefined);
  return () =>
    Promise.race([
      appeared,
      new Promise<void>((resolve) => setTimeout(resolve, POPUP_GRACE_MS)),
    ]);
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

type PageText = {
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
async function readSettledPageText(
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

/**
 * Describe everything on the page a Bot can act on.
 *
 * Uses Playwright's AI snapshot rather than stamping attributes into the DOM. `ariaSnapshot` keeps
 * refs outside the page, survives framework re-renders, resolves accessible names, reports current
 * values and checked state, filters to actionable elements and descends into iframes.
 */
async function snapshotPage(
  session: BotSession,
  botId: string,
  target: Page,
): Promise<{
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
  tabs: TabSummary[];
}> {
  session.snapshotId += 1;
  // A tab that opened a moment ago is still `about:blank`, and an aria snapshot of that is an empty
  // list — which reads as "there is nothing on this page you can act on".
  await settleIfLoading(target);
  const yaml = await target.ariaSnapshot({ mode: "ai" });
  return {
    snapshotId: session.snapshotId,
    url: target.url(),
    title: await target.title(),
    ...parseAriaSnapshot(yaml, await passwordLabels(target)),
    /*
     * The other tabs, listed with the elements rather than behind a tool of their own.
     * A Bot that has to ask whether a second tab exists will not ask, and the tab a click just
     * opened is usually where the answer is. `computer_switch_tab` takes the index from here.
     */
    tabs: await profiles.tabs(botId),
  };
}

/**
 * What the page's password boxes are called, so the snapshot can mark them.
 *
 * THE ACCESSIBLE TREE DOES NOT SAY. Playwright reports `<input type="password">` as a `textbox`, the
 * same as a name field, and the boundary's whole rule about secrets is that a Bot must not type into
 * one. So the type is read from the DOM in one call — `evaluateAll` on the whole set, not a
 * round trip per element — and joined to the tree by the label, which is the only thing both sides
 * have. See `parseAriaSnapshot` for what that join can and cannot do.
 *
 * The name is computed the way a screen reader would resolve the common cases, in the order
 * Playwright itself prefers: an explicit label, then the wrapping one, then aria-label, then the
 * placeholder. Anything cleverer would drift from Playwright's own computation and stop matching,
 * which fails silently — so the field's own label is a second signal in the rule itself.
 *
 * Never throws. A page that is navigating under us costs the marking, not the snapshot.
 */
async function passwordLabels(target: Page): Promise<string[]> {
  try {
    return await target
      .locator('input[type="password"]')
      .evaluateAll((nodes: Element[]) =>
        nodes.map((node: Element) => {
          const input = node as HTMLInputElement;
          const labelled = input.labels?.[0]?.textContent ?? "";
          return (
            labelled ||
            input.getAttribute("aria-label") ||
            input.getAttribute("placeholder") ||
            input.getAttribute("title") ||
            ""
          );
        }),
      );
  } catch {
    return [];
  }
}

/**
 * Resolve a ref to a locator, refusing anything from a superseded snapshot.
 *
 * `aria-ref=` is a first-party Playwright selector engine, and it is the same one its MCP server uses.
 * The generation check here is the caller-facing half; see the note on `snapshotId` for why both exist.
 */
function locateRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
) {
  if (
    expectedSnapshotId !== undefined &&
    expectedSnapshotId !== session.snapshotId
  ) {
    throw new StaleSnapshotError(STALE_REFS);
  }
  return target.locator(`aria-ref=${ref}`);
}

/**
 * The element, or a refusal that says what to do about it.
 *
 * A generation check is not an existence check. A ref from
 * the current snapshot that names nothing on the page, because a model invented it or because the
 * page moved on without a new snapshot being taken, passes `locateRef` and then simply waits. The
 * action times out, and the caller gets a generic failure carrying Playwright's internal call log
 * instead of the actionable answer: take a fresh snapshot.
 *
 * `count()` resolves immediately rather than waiting, so a ref that names nothing is refused in
 * milliseconds instead of holding the action open for the full timeout.
 */
async function resolveRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
) {
  const locator = locateRef(session, target, ref, expectedSnapshotId);
  if ((await locator.count()) === 0) {
    throw new StaleSnapshotError(STALE_REFS);
  }
  return locator;
}

/**
 * A FACT CODE, NOT A SENTENCE.
 *
 * Both of these were English paragraphs addressed to a model, from a container that has never heard
 * of a locale — the same thing `laf:human_has_control` used to be. The Korean the Bot reads lives in
 * `shared/prompt/tool-results.ko.ts` under this code, and it says the one thing that helps: take
 * another snapshot and use the refs from it. The ref and the two generation numbers went with the
 * prose deliberately; neither is something the model can act on, and both are in the request it
 * just sent.
 */
const STALE_REFS = "laf:stale_refs";

class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One live viewer at a time per Bot, so a reconnect replaces rather than stacks, and two people
 * watching two different Bots do not fight over one cast.
 *
 * A second cast on the same page would have Chrome encoding every frame twice and both sockets acking
 * independently, which stalls both. One person drives; one cast.
 */
async function stopViewer(session: BotSession): Promise<void> {
  const current = session.viewer;
  session.viewer = undefined;
  if (current?.follow) clearInterval(current.follow);
  await current?.cast.stop();
}

/** How often the cast checks that it is still showing the page the Bot is on. */
const FOLLOW_INTERVAL_MS = 1_000;

/** What a live-screen socket carries: the Bot whose screen it is showing. */
type StreamData = { botId: string };

serve<StreamData>({
  port: PORT,
  idleTimeout: 120,
  /**
   * The live screen, pushed by Chrome rather than polled.
   *
   * Upgraded here rather than served as HTTP because the whole point is that frames arrive when the
   * page changes and input goes back over the same connection. See screencast.ts for why polling was
   * not good enough once a person had to type into this.
   */
  websocket: {
    async open(ws) {
      const session = sessionFor(ws.data.botId);
      try {
        await stopViewer(session);

        const send = (frame: unknown) => {
          // A closed socket starts a fresh cast on the next connection.
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            void stopViewer(session);
          }
        };

        /*
         * The cast follows the Bot's current page. Re-checking also handles a page being closed
         * underneath us without a listener per page.
         */
        let casting: Page | undefined;
        const attach = async () => {
          const target = await currentPage(ws.data.botId);
          if (target === casting) return;
          const previous = session.viewer;
          const cast = await startScreencast(target, send);
          casting = target;
          session.viewer = { socket: ws, cast, follow: previous?.follow };
          // The old cast stops after the replacement is running, so the screen does not go blank.
          await previous?.cast.stop().catch(() => undefined);
        };

        await attach();
        const follow = setInterval(() => {
          void attach().catch(() => undefined);
        }, FOLLOW_INTERVAL_MS);
        if (session.viewer) session.viewer.follow = follow;
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "The screen could not be started."),
          }),
        );
        ws.close();
      }
    },

    async message(ws, raw) {
      const session = sessionFor(ws.data.botId);
      if (!session.viewer) return;
      let message: InputMessage;
      try {
        message = JSON.parse(String(raw)) as InputMessage;
      } catch {
        return;
      }
      // A person's input is accepted only while they hold the wheel. The socket being open is not permission:
      // without this check, anything that could reach this port could drive the browser while a Bot
      // was working, which is the one thing the control state exists to prevent.
      //
      // Refuse with an error so the surface can explain why input is ignored.
      if (!session.control.humanMayDrive()) {
        ws.send(JSON.stringify({ type: "error", error: TAKE_CONTROL_FIRST }));
        return;
      }
      try {
        await session.viewer.cast.send(message);
      } catch (error) {
        // Reported rather than swallowed. A dispatch that fails means the person's input did nothing,
        // and they must not be left believing it landed.
        console.error(
          JSON.stringify({
            type: "screencast-input-error",
            message: message.type,
            error: String(error),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "That input could not be applied."),
          }),
        );
      }
    },

    async close(ws) {
      await stopViewer(sessionFor(ws.data.botId));
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);

    /*
     * Nothing below this line happens for an untrusted caller.
     *
     * `/health` is the single exception: it names no Bot, touches no browser and reports nothing but
     * whether this process is up, and a container orchestrator has to be able to ask that without
     * holding a secret.
     *
     * The websocket upgrade is checked here too. A browser cannot set headers on an upgrade, so the
     * stream carries the token as a query
     * parameter the same way it already carries the Bot.
     */
    if (
      !isOpenPath(url.pathname) &&
      !matchesToken(COMPUTER_TOKEN, offeredToken(request.headers, url))
    ) {
      // Says nothing about what is here. A refusal that describes the endpoint it is protecting is a
      // directory listing for whoever is knocking.
      return json({ error: "Not authorised." }, 401);
    }

    if (url.pathname === "/health") {
      // The header is optional here and nowhere else: an orchestrator probing this container has no
      // Bot to name. Where one IS named, the answer is about that Bot's browser, as it always was.
      // Named, and a name. An orchestrator probing this container has no Bot to name, so the header
      // stays optional here — but a health check is not a way to ask about `../..` either, and an
      // unnameable Bot is simply not reported on rather than refused.
      const asked = botIdOf(request);
      const [profile] = isBotId(asked) ? profiles.summary([asked]) : [];
      return json({
        status: "ok",
        // `browser` kept as it was: it is in the published contract and start.sh reads it.
        browser: profile?.running ?? false,
        ...(profile ? { profile } : {}),
        /*
         * NO `identity` FIELD. It reported what the local SPIRE agent said this computer was, and
         * SPIRE went with the per-Bot container plane in 2026-08. Nothing has set
         * `SPIFFE_ENDPOINT_SOCKET` since, so the field was `null` in every deployment this
         * repository can produce, and nothing read it. A health field that is always null is a
         * claim the deployment cannot back.
         */
      });
    }

    /**
     * The computers this process holds. The shape is a list because the admin surface is a
     * list, and because a Bot that has a profile has a computer whether or not a browser is running
     * for it this second.
     *
     * Names no Bot, by definition: it is the question "which are there".
     */
    if (url.pathname === "/computers" && request.method === "GET") {
      return json({ computers: profiles.summary(await profiles.known()) });
    }

    /*
     * The socket carries the Bot in the query because it cannot do it in a header. Every other call
     * here names its Bot in `x-openbot-bot-id`, but a websocket client sends no custom headers on
     * the upgrade, so the stream, and only the stream, also accepts the Bot as a query parameter.
     * The header still wins where there is one, and neither is still a refusal.
     */
    const botId = botIdOf(
      request,
      url.pathname === "/stream" ? url.searchParams.get("bot") : null,
    );
    if (!botId) {
      /*
       * A CALLER THAT DOES NOT NAME A BOT GETS NOTHING.
       *
       * The fallback that used to be here put every unnamed call on one fixed profile: a browser
       * with somebody else's cookies, or a blank page belonging to nobody, and either way an answer
       * that looks like it worked. The code is a fact for the server's logs; nobody reading it is a
       * person, because the surface never makes this call without the header.
       */
      return json(
        { code: "laf:bot_header_missing", error: "laf:bot_header_missing" },
        400,
      );
    }
    /*
     * AND IT HAS TO BE A NAME, NOT A PATH.
     *
     * Refused here, before `sessionFor` — which is the first thing that turns the id into a
     * directory, because restoring the control state reads `<profiles>/<botId>/control.json` and
     * writing it back creates the directory. `../../tmp/x` got that far and wrote the file, as
     * root. Checked again on this side rather than trusted from the server: see `isBotId`.
     */
    if (!isBotId(botId)) {
      return json({ code: BOT_ID_INVALID, error: BOT_ID_INVALID }, 400);
    }
    // Resolved once per request. Everything below that touches a browser, a takeover or a snapshot
    // goes through this Bot's session, so there is no path where one Bot's call reaches another's.
    const session = sessionFor(botId);

    if (url.pathname === "/stream") {
      if (server.upgrade(request, { data: { botId } }))
        return undefined as unknown as Response;
      return json({ error: "Expected a WebSocket upgrade." }, 400);
    }

    /*
     * `/live` stays absent. A page served by this process can only be opened by putting the secret in
     * a URL, where it lands in history and logs. The React app is the guarded way to watch a Bot.
     */

    // Who has the wheel. Polled by the surface alongside the screen, so the person sees the Bot ask
    // for help without having to reload anything.
    if (url.pathname === "/control" && request.method === "GET") {
      return json(session.control.get());
    }

    // The Bot asking for help. It does not take control: it says it is stuck and why, and a person
    // decides. A Bot that could hand itself to a human could also hand a human a page they never
    // asked to see.
    if (url.pathname === "/control/request" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        reason?: unknown;
      } | null;
      return json(session.control.requestHelp(body?.reason));
    }

    // The Bot asking for one value it must not be told. It has already focused the field.
    if (url.pathname === "/control/secret" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        label?: unknown;
        ref?: unknown;
        snapshotId?: unknown;
      } | null;
      try {
        return json(session.control.requestSecret(body ?? {}));
      } catch (error) {
        if (error instanceof ControlRequestError) {
          return json({ error: error.message }, 400);
        }
        throw error;
      }
    }

    /**
     * A person supplying that value.
     *
     * Scoped by the pending request rather than by a control handover: it is usable only while the Bot
     * has actually asked for a secret, and the request is cleared the moment it is answered, so this
     * cannot be used as a general back door to type into the page.
     *
     * The value is typed and forgotten. Not stored on `control`, not returned in the response, not
     * logged. The response says how many characters arrived, which is enough for the surface to
     * confirm something was sent and useless to anybody reading it later.
     *
     * It types and does not submit. Committing a form is a separate action through the gateway and
     * audit trail; secret entry only places the value in the named field.
     */
    if (url.pathname === "/human/secret" && request.method === "POST") {
      const pending = session.control.pendingSecret();
      if (!pending) {
        return json({ error: NO_SECRET_PENDING }, 409);
      }
      const body = (await request.json().catch(() => null)) as {
        text?: unknown;
      } | null;
      if (typeof body?.text !== "string" || !body.text) {
        return json({ error: "A value is required." }, 400);
      }
      try {
        const target = await currentPage(botId);
        // Focus the field the Bot named, and let this throw if it cannot be found. A secret must not
        // be reported as delivered unless a field receives it.
        //
        // No generation check here: a Bot may take another snapshot after asking for a secret, while
        // the ref remains protected by Playwright's `aria-ref` rules.
        //
        // `aria-ref` resolves a ref only against the most recent snapshot, only while the element is
        // still connected, and mints a
        // new ref when an element's role or accessible name changes, so a recycled node cannot
        // inherit an old one. If the ref resolves, it is the field the Bot meant. If it does not,
        // nothing is typed, which is the outcome the generation check existed to guarantee.
        const field = locateRef(session, target, pending.ref, undefined);
        await field.click({ timeout: ACTION_TIMEOUT_MS });
        await field.fill(body.text, { timeout: ACTION_TIMEOUT_MS });
        const characters = body.text.length;
        // Cleared only after it actually landed, so a failure leaves the request open and the person
        // can try again rather than being told to start over.
        session.control.secretSupplied();
        return json({ supplied: true, characters, url: target.url() });
      } catch (error) {
        if (error instanceof StaleSnapshotError) {
          return json({ error: error.message, stale: true }, 409);
        }
        // The field is gone, which is unretryable, so the request is closed rather than left open.
        // Keeping it open is right for a mistyped value and wrong here: the person would retype their
        // password into the same dead ref for ever. Clearing it also unblocks the Bot, which can see
        // on its next turn that nothing is pending and ask again against a fresh snapshot.
        session.control.secretSupplied();
        return json(
          {
            error: describe(
              error,
              "That value could not be entered: the field is no longer on the page. Ask the assistant to request it again.",
            ),
          },
          502,
        );
      }
    }

    if (url.pathname === "/control/take" && request.method === "POST") {
      return json(session.control.take());
    }

    if (url.pathname === "/control/release" && request.method === "POST") {
      // `reason` is dropped on release: it described the thing the person was asked to do, and once
      // they have done it, leaving it set would have the surface still showing the old request.
      return json(session.control.release());
    }

    // A person's input, by pixel. The Bot addresses elements by reference because it reads a list; a
    // person addresses them by pointing, because they are looking at a picture. Different problem,
    // different endpoint, and only usable while they hold the wheel.
    if (HUMAN_INPUT.has(url.pathname) && request.method === "POST") {
      if (!session.control.humanMayDrive()) {
        return json({ error: TAKE_CONTROL_FIRST }, 409);
      }
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      try {
        const target = await currentPage(botId);
        return json(await performHumanInput(target, url.pathname, body ?? {}));
      } catch (error) {
        return json({ error: describe(error, "That did not work.") }, 502);
      }
    }

    /**
     * Stop the browser, keep what it knows.
     *
     * Closed gracefully so Chromium flushes its profile, and deliberately
     * not restarted here: the next request starts it again, which is the same path as a first ever
     * start, so there is no second way for a browser to come into existence.
     */
    if (url.pathname === "/computers/stop" && request.method === "POST") {
      const wasRunning = await profiles.stop(botId);
      // The wheel goes back to the Bot because the controlled browser no longer exists.
      session.control.release();
      return json({ stopped: true, wasRunning });
    }

    /**
     * Forget everything and start over.
     *
     * Signs the computer out of everything by deleting the profile. Irreversible, which is why it is
     * its own endpoint rather than a flag on the one above: a person clicking "stop" must not be able
     * to discard a login by mistyping a parameter.
     */
    if (url.pathname === "/computers/reset" && request.method === "POST") {
      await profiles.reset(botId);
      // Reset releases control because any previous browser session and pending secret request are gone.
      session.control.release();
      return json({ reset: true, botId });
    }

    if (url.pathname === "/navigate" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        url?: unknown;
      } | null;
      if (typeof body?.url !== "string") {
        return json({ error: "A url is required." }, 400);
      }

      const startedAt = Date.now();
      try {
        session.control.assertBotMayAct();
        const target = await currentPage(botId);
        await target.goto(body.url, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        // A new document wipes every stamp, so every ref handed out before now is meaningless.
        // Bumping the generation makes an action carrying one fail with "take a new snapshot" rather
        // than fall through to a selector that matches nothing and read as a missing element.
        session.snapshotId += 1;
        const extract = await readSettledPageText(target, {
          settleFirst: true,
        });
        return json(
          withNotes(session, {
            url: target.url(),
            title: await target.title().catch(() => ""),
            text: extract.text,
            truncated: extract.truncated,
            ...(extract.frames ? { frames: extract.frames } : {}),
            elapsedMs: Date.now() - startedAt,
          }),
        );
      } catch (error) {
        // A person holding the wheel is not a failed navigation; the Bot should wait.
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        // The page is the Bot's working surface, so a failed navigation is reported rather than
        // thrown: the transcript needs to say what happened, and the browser stays usable.
        return json(
          {
            error:
              error instanceof Error ? error.message : "Navigation failed.",
          },
          502,
        );
      }
    }

    if (url.pathname === "/screenshot" && request.method === "GET") {
      try {
        const target = await currentPage(botId);
        const buffer = await target.screenshot({ type: "png" });
        const size = target.viewportSize() ?? { width: 1280, height: 800 };
        return json({
          base64: buffer.toString("base64"),
          width: size.width,
          height: size.height,
          capturedAt: new Date().toISOString(),
          // Which page this is a picture of. A browser that has not been sent anywhere sits on
          // `about:blank`, and a screenshot of that is a valid, entirely white PNG, indistinguishable
          // from a real page to anything looking only at the bytes. The transcript needs to tell
          // those apart to avoid presenting a blank browser as though it were a loaded page.
          url: target.url(),
        });
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "Screenshot failed.",
          },
          502,
        );
      }
    }

    // The Bot's files. Confined to the workspace by workspace.ts. Nothing here decides whether a Bot
    // MAY touch a path: the gateway in front of this process does that.
    if (url.pathname === "/files/read" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
      } | null;
      try {
        return json(await workspace.read(String(body?.path ?? "")));
      } catch (error) {
        return json(
          { error: describe(error, "The file could not be read.") },
          fileStatus(error),
        );
      }
    }

    if (url.pathname === "/files/list" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
      } | null;
      try {
        return json(
          await workspace.list(
            typeof body?.path === "string" ? body.path : undefined,
          ),
        );
      } catch (error) {
        return json(
          { error: describe(error, "The folder could not be listed.") },
          fileStatus(error),
        );
      }
    }

    if (url.pathname === "/files/write" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        path?: unknown;
        contents?: unknown;
        append?: unknown;
      } | null;
      if (typeof body?.contents !== "string") {
        return json({ error: "The contents to write are required." }, 400);
      }
      try {
        return json(
          await workspace.write(String(body?.path ?? ""), body.contents, {
            append: body.append === true,
          }),
        );
      } catch (error) {
        return json(
          { error: describe(error, "The file could not be written.") },
          fileStatus(error),
        );
      }
    }

    // The current page as text, without navigating anywhere.
    //
    // Reading must be available after actions too. Returning page text only from `/navigate` would be enough if
    // opening a page were the only way to change what is on screen. It is not: the Bot presses
    // "Submit order", the page becomes a confirmation, and it has no way to find out what the
    // confirmation said. "I clicked the button" is not an answer to what happened.
    if (url.pathname === "/read" && request.method === "GET") {
      try {
        const target = await currentPage(botId);
        const extract = await readSettledPageText(target);
        return json(
          withNotes(session, {
            url: target.url(),
            title: await target.title().catch(() => ""),
            text: extract.text,
            truncated: extract.truncated,
            ...(extract.frames ? { frames: extract.frames } : {}),
          }),
        );
      } catch (error) {
        return json(
          { error: describe(error, "Reading the page failed.") },
          502,
        );
      }
    }

    // The list of things on the page a Bot can act on. POST rather than GET because it mutates the
    // page, stamping every element it describes, and a GET that changes the document is a lie that
    // caches and prefetchers eventually punish.
    /**
     * What is at one point on the page, in the words a person would use for it.
     *
     * FOR TEACHING, and only for that. When somebody drives this browser to show a Bot how a task
     * is done, what arrives over the socket is `click at (412, 338)` — a fact about one render of
     * one page at one window size, worth nothing the next time. This turns it into "the 주문 확인
     * button", which is what the demonstration is actually about.
     *
     * ITS OWN ENDPOINT rather than geometry added to the snapshot. A snapshot goes out on every
     * governed action a Bot takes, so a bounding box per element would make every one of those
     * payloads larger, forever, to serve a feature that runs while a person is teaching. This is
     * called on clicks during a demonstration and at no other time.
     *
     * Climbs to the nearest thing a person would name. The element under the cursor is as often as
     * not a `<span>` inside the button that was actually pressed, and "clicked a span" describes
     * nothing.
     */
    if (url.pathname === "/describe-point" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        x?: unknown;
        y?: unknown;
      } | null;
      if (typeof body?.x !== "number" || typeof body?.y !== "number") {
        return json({ error: "A point needs x and y." }, 400);
      }
      try {
        const target = await currentPage(botId);
        const found = await target.evaluate(
          ({ x, y }: { x: number; y: number }) => {
            const NAMED = new Set([
              "a",
              "button",
              "input",
              "select",
              "textarea",
              "label",
              "summary",
              "option",
            ]);
            const NAMED_ROLES = new Set([
              "button",
              "link",
              "checkbox",
              "radio",
              "menuitem",
              "tab",
              "option",
              "switch",
            ]);
            const under = document.elementFromPoint(x, y);
            if (!under) return null;
            /*
             * Climb to the nearest thing a person would name, and KEEP WHAT WAS UNDER THE CURSOR IF
             * THERE IS NONE. The first version returned nothing in that case, walking to `<html>`
             * and past it, so a click on a heading or a paragraph — most of a page — was recorded
             * as unnameable. Measured against a real page: ten points across the content, ten nulls.
             *
             * Five steps is enough to escape the usual span-inside-a-span-inside-a-button and few
             * enough that a click on the page background is not attributed to the whole document.
             */
            let node: Element | null = under;
            let named: Element | null = null;
            for (let step = 0; node && step < 5; step += 1) {
              const role = node.getAttribute("role") ?? "";
              const tag = node.tagName.toLowerCase();
              if (NAMED.has(tag) || NAMED_ROLES.has(role)) {
                named = node;
                break;
              }
              node = node.parentElement;
            }
            /*
             * The page is not a thing that was pressed. Falling back to whatever was under the
             * cursor is right for a heading or a paragraph and wrong for `<html>` and `<body>`,
             * whose text is the whole document — measured, a press on the background came back
             * named with the entire page. A press on nothing nameable is a real thing that happens,
             * and saying so is what lets the step be written as one.
             */
            const backdrop = under.tagName.toLowerCase();
            if (!named && (backdrop === "html" || backdrop === "body")) {
              return null;
            }
            const element = (named ?? under) as HTMLElement;
            /*
             * THE LABEL, NEVER THE TEXT ON THE PAGE.
             *
             * This is read while a person is demonstrating a task in their own browser, and what it
             * returns is written into the recording that a model is later asked to write up. It used
             * to fall back to eighty characters of the element's own `innerText`, which is whatever
             * the page happened to be showing at that point: a one-time code, an account number, a
             * balance. The recorder is built so that nothing anybody typed is ever kept
             * (`demonstration.ts`), and this was the same secret arriving by the other door — read
             * off the screen instead of off the keyboard.
             *
             * A label is an author's name for a control and does not carry somebody's data. Where
             * there is none, the press is recorded as a press with no name, which the recorder
             * already handles and which a person reading the draft can correct.
             */
            const label =
              element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              element.getAttribute("placeholder") ??
              element.getAttribute("alt") ??
              "";
            return {
              role:
                element.getAttribute("role") ?? element.tagName.toLowerCase(),
              name: label.replace(/\s+/g, " ").trim(),
            };
          },
          { x: body.x, y: body.y },
        );
        // Null rather than an invented name. A click on nothing nameable is a real thing that
        // happens — a canvas, a PDF, the page background — and saying so lets the step be written
        // as "clicked somewhere on this page" instead of as a confident lie.
        return json({ element: found?.name ? found : null });
      } catch (error) {
        return json({ error: describe(error, "Nothing could be read.") }, 502);
      }
    }

    if (url.pathname === "/snapshot" && request.method === "POST") {
      try {
        return json(
          withNotes(
            session,
            await snapshotPage(session, botId, await currentPage(botId)),
          ),
        );
      } catch (error) {
        return json({ error: describe(error, "Snapshot failed.") }, 502);
      }
    }

    /**
     * Move the Bot to another tab.
     *
     * Read-only as far as any website is concerned — nothing on any page changes because somebody
     * looked at a different one — which is why the gateway governs it as `read`. What it does change
     * is which page the next action lands on, so the refs from the last snapshot are retired with it.
     */
    if (url.pathname === "/tabs/switch" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        index?: unknown;
      } | null;
      if (typeof body?.index !== "number" || !Number.isInteger(body.index)) {
        return json({ error: "A tab index is required." }, 400);
      }
      try {
        // Started if it is not running, so a switch is never answered with "there are no tabs" on a
        // computer that simply has not been woken up yet.
        await currentPage(botId);
        const tabs = await profiles.switchTab(botId, body.index);
        session.snapshotId += 1;
        const target = await currentPage(botId);
        return json(
          withNotes(session, {
            action: "switch_tab",
            index: body.index,
            tabs,
            url: target.url(),
          }),
        );
      } catch (error) {
        if (error instanceof TabError) {
          return json({ error: error.message, code: error.message }, 400);
        }
        return json({ error: describe(error, "The tab did not change.") }, 502);
      }
    }

    /**
     * Hand a file from the workspace to a page.
     *
     * The one direction the workspace could not go. A Bot can save a 정산 내역 and could not attach
     * it to anything; a shop's product photo could be written and never uploaded. `setInputFiles`
     * needs a real path, so the file is resolved through the same confinement every other file call
     * uses — a Bot may only ever hand over something inside its own workspace.
     */
    if (url.pathname === "/upload" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        ref?: unknown;
        snapshotId?: unknown;
        path?: unknown;
      } | null;
      if (typeof body?.ref !== "string" || !body.ref) {
        return json({ error: "The ref of a file input is required." }, 400);
      }
      if (typeof body?.path !== "string" || !body.path.trim()) {
        return json({ error: "A file path is required." }, 400);
      }
      try {
        session.control.assertBotMayAct();
        const full = await workspace.resolvePath(body.path.trim(), false);
        const target = await currentPage(botId);
        const field = await resolveRef(
          session,
          target,
          body.ref,
          typeof body.snapshotId === "number" ? body.snapshotId : undefined,
        );
        await field.setInputFiles(full, { timeout: ACTION_TIMEOUT_MS });
        return json(
          withNotes(session, {
            action: "upload_file",
            ref: body.ref,
            // The path the Bot named, never the resolved one: the absolute path is inside a
            // container and means nothing to anybody reading the transcript.
            path: body.path.trim(),
            url: target.url(),
          }),
        );
      } catch (error) {
        if (error instanceof StaleSnapshotError) {
          return json({ error: error.message, stale: true }, 409);
        }
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        if (
          error instanceof WorkspacePathError ||
          error instanceof WorkspaceFileError
        ) {
          return json(
            { error: describe(error, "That file could not be used.") },
            fileStatus(error),
          );
        }
        return json(
          { error: describe(error, "The file could not be attached.") },
          502,
        );
      }
    }

    if (ACTIONS.has(url.pathname) && request.method === "POST") {
      const body = (await request
        .json()
        .catch(() => null)) as ActionBody | null;
      if (!body) {
        return json({ error: "An action needs a JSON body." }, 400);
      }

      const startedAt = Date.now();
      try {
        session.control.assertBotMayAct();
        const target = await currentPage(botId);
        const detail = await performAction(
          session,
          target,
          url.pathname,
          body,
          // The caller going away is the stop signal: the surface aborts its request, the server
          // aborts the one it made to this computer, and Bun aborts this one in turn.
          request.signal,
        );
        return json(
          withNotes(session, { ...detail, elapsedMs: Date.now() - startedAt }),
        );
      } catch (error) {
        /*
         * Stopped, not failed. The signal is checked rather than the error text: Playwright words an
         * abort differently per call, and the caller's own request going away is the fact that
         * matters either way.
         *
         * Logged because the response is not observed after the caller aborts. The log distinguishes
         * "stopped in time" from "ran to completion after cancellation".
         */
        if (request.signal.aborted) {
          console.info(
            JSON.stringify({
              type: "action-stopped",
              action: url.pathname,
              ref: typeof body.ref === "string" ? body.ref : undefined,
              elapsedMs: Date.now() - startedAt,
            }),
          );
          // 499, the convention for a client that closed the request: this is not the computer
          // failing, and a 502 here would be counted as one.
          return json({ error: "Stopped.", stopped: true }, 499);
        }
        // A stale ref is the caller's mistake and is fixable by taking a new snapshot, so it is a 409
        // rather than a 502: the computer is fine and retrying the same call unchanged will not help.
        if (error instanceof StaleSnapshotError) {
          return json({ error: error.message, stale: true }, 409);
        }
        // 409 as well, and for the same reason: nothing is broken, the caller simply has to wait.
        if (error instanceof ControlError) {
          return json({ error: error.message, humanHasControl: true }, 409);
        }
        return json({ error: describe(error, "The action failed.") }, 502);
      }
    }

    return json({ error: "Not found." }, 404);
  },
});

type ActionBody = {
  ref?: unknown;
  snapshotId?: unknown;
  text?: unknown;
  key?: unknown;
  deltaY?: unknown;
  submit?: unknown;
};

const ACTIONS = new Set(["/click", "/type", "/key", "/scroll"]);

const HUMAN_INPUT = new Set([
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
]);

/**
 * Carry out one thing a person did with their mouse or keyboard.
 *
 * Coordinates are viewport pixels, which the surface works out from the screenshot it is displaying:
 * it knows the image's natural size and the size it drew it at, so it can scale a click back. Doing
 * that conversion in the browser rather than here keeps this endpoint bound to page coordinates
 * rather than window coordinates.
 *
 * Nothing a person types here reaches the model. It goes from their keyboard to this browser and
 * stops. That is what makes a password or a one-time code safe to enter during a takeover: not a
 * filter that strips it out afterwards, but a path the model is not on. The same reason the value is
 * never returned and never logged below.
 */
async function performHumanInput(
  target: Page,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("A click needs an x and a y inside the page.");
    }
    // Clamped rather than rejected. A click a pixel outside the viewport is a rounding artefact of
    // scaling the screenshot, not a mistake worth refusing.
    return {
      x: Math.min(Math.max(x, 0), VIEWPORT.width - 1),
      y: Math.min(Math.max(y, 0), VIEWPORT.height - 1),
    };
  };

  if (action === "/human/click") {
    const { x, y } = at();
    await target.mouse.click(x, y);
    return { action: "human_click", url: target.url() };
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") {
      throw new Error("Typing needs text.");
    }
    // `insertText` rather than per-key typing: a person pasting a one-time code should not have it
    // arrive one character at a time into a field that reformats as you go.
    await target.keyboard.insertText(body.text);
    // Length only, never the value. See the note above about the model not being on this path.
    return {
      action: "human_type",
      characters: body.text.length,
      url: target.url(),
    };
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name.");
    }
    await target.keyboard.press(body.key);
    return { action: "human_key", key: body.key, url: target.url() };
  }

  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 400;
  await target.mouse.wheel(0, deltaY);
  return { action: "human_scroll", deltaY, url: target.url() };
}

/**
 * Carry out one action on the page.
 *
 * Every action that addresses an element goes through {@link locateRef}, so the staleness check
 * cannot be forgotten at a call site. `/key` and `/scroll` may omit a ref and act on the page itself,
 * which is how a Bot presses Enter to submit or scrolls to bring more of a long form into view.
 *
 * Stop has to reach the browser. `signal` is the caller's request going away, the person pressed
 * Stop, and the abort travels from the surface, through the server, to here. Without passing it on,
 * pressing Stop ended the run in the transcript while the click it was meant to prevent carried on
 * landing on a live page. Stop must reach the browser before a high-impact click lands.
 */
async function performAction(
  session: BotSession,
  target: Page,
  action: string,
  body: ActionBody,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Passed to every Playwright call below. It does not disable the timeout, which still applies.
  const acting = { timeout: ACTION_TIMEOUT_MS, ...(signal ? { signal } : {}) };
  const expected =
    typeof body.snapshotId === "number" ? body.snapshotId : undefined;
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;

  if (action === "/click") {
    if (!ref) throw new Error("A click needs the ref of an element to click.");
    const opening = watchForTab(target);
    await (await resolveRef(session, target, ref, expected)).click(acting);
    await opening();
    return { action: "click", ref, url: target.url() };
  }

  if (action === "/type") {
    if (!ref) throw new Error("Typing needs the ref of a field to type into.");
    if (typeof body.text !== "string") {
      throw new Error("Typing needs the text to enter.");
    }
    const field = await resolveRef(session, target, ref, expected);
    // `fill` rather than keystrokes: it clears the field first, which is what "put this value in
    // this box" means. Typing into a field a previous attempt half-filled otherwise appends, and the
    // form ends up with "AlicAlice" in it.
    await field.fill(body.text, acting);
    if (body.submit === true) {
      await field.press("Enter", acting);
    }
    // The text itself is deliberately NOT returned. It is echoed nowhere: this response is read by
    // the model and logged by the server, and a value typed into a form is exactly where a password
    // or a card number lives. The caller already knows what it sent.
    return {
      action: "type",
      ref,
      characters: body.text.length,
      submitted: body.submit === true,
      url: target.url(),
    };
  }

  if (action === "/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name, such as Enter or Tab.");
    }
    if (ref) {
      /*
       * A REF WITHOUT ITS SNAPSHOT IS STALE BY DEFINITION.
       *
       * `expected` is undefined when the caller sent a ref and no `snapshotId`, and undefined is how
       * `locateRef` says "no generation to check" — so this one call skipped the check every other
       * action gets. The tool contract says the id is required alongside a ref, and the answer to a
       * call that omits it is the same as the answer to an old one: take a new snapshot.
       */
      if (expected === undefined) throw new StaleSnapshotError(STALE_REFS);
      const opening = watchForTab(target);
      await (await resolveRef(session, target, ref, expected)).press(
        body.key,
        acting,
      );
      await opening();
    } else {
      const opening = watchForTab(target);
      await target.keyboard.press(body.key);
      await opening();
    }
    return { action: "key", key: body.key, ref, url: target.url() };
  }

  // Scroll. A plain wheel event on the page, which is what moves a long form, rather than scrolling a
  // specific element into view: the Bot asked to see further down, not to hunt for one control.
  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 600;
  await target.mouse.wheel(0, deltaY);
  return { action: "scroll", deltaY, url: target.url() };
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Which status a file failure deserves.
 *
 * A path outside the workspace is the caller asking for something it may never have, so 403: retrying
 * it unchanged will never work, and it is not a fault. A missing file or an oversized write is a 400,
 * because a different request would succeed. Collapsing both into 500 would tell the Bot the computer
 * is broken and invite it to try the same thing again.
 */
function fileStatus(error: unknown): 400 | 403 | 500 {
  if (error instanceof WorkspacePathError) return 403;
  if (error instanceof WorkspaceFileError) return 400;
  return 500;
}

console.info(`agent-computer listening on http://localhost:${PORT}`);

/**
 * Hand the profile back before dying.
 *
 * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait, so this is the window in
 * which Chromium can flush its profile to the volume. This is the graceful-shutdown path for normal
 * container restarts.
 *
 * `stop_grace_period` in docker-compose.yml is what gives this time to run.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      console.info(`${signal}: closing the browser so its profile is flushed`);
      await profiles.closeAll();
      process.exit(0);
    })();
  });
}
