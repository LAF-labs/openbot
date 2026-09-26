/**
 * The Bot acting on a page: a click, typing, a key, a scroll — and a file handed to a file input.
 *
 * In the intended deployment path, the server gateway decides whether an action may run and records
 * the audit row before calling this process, and it sends the role and name it judged the ref to be
 * (label-hold.ts). This process has no policy engine and no audit trail of its own.
 */
import type { Page } from "playwright";
import type { BotRoute } from "./computer";
import { actionFailure } from "./failures";
import { holdToLabel } from "./label-hold";
import { log } from "./log";
import { onElement, resolveRef, STALE_REFS, StaleSnapshotError } from "./refs";
import { bodyOf, fact, invalid, json, RequestInvalidError } from "./respond";
import { arrivalNote } from "./page-arrival";
import { readSettledPageText, titleOf } from "./page-text";
import { type BotSession, note, withNotes } from "./sessions";
import { digestOf, keepOwn } from "./typed-values";

export type ActionBody = {
  ref?: unknown;
  snapshotId?: unknown;
  text?: unknown;
  key?: unknown;
  deltaY?: unknown;
  submit?: unknown;
  /** What the server judged the ref to be — role and name — and so what it must still be. See label-hold.ts. */
  element?: unknown;
};

export const ACTIONS = new Set(["/click", "/type", "/key", "/scroll"]);

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

/** How much longer a clicked link that has not gone anywhere is given to open its tab. */
const LINK_TAB_WAIT_MS = 1_000;

/**
 * Listen for a tab before the thing that might open one, and stop listening after it.
 *
 * Registered BEFORE the action, because a popup that arrives while the click is still resolving
 * would be missed by a listener set up afterwards. The returned function is what the action awaits:
 * it ends at the event or at the grace period, whichever comes first, so a click that opens nothing
 * costs the grace and no more.
 */
function watchForTab(
  target: Page,
  actionTimeoutMs: number,
): () => Promise<void> {
  const appeared = target
    .context()
    // The listener has to outlive the action itself; the race below is what bounds the waiting.
    .waitForEvent("page", { timeout: actionTimeoutMs + POPUP_GRACE_MS })
    .then(() => undefined)
    .catch(() => undefined);
  return () =>
    Promise.race([
      appeared,
      new Promise<void>((resolve) => setTimeout(resolve, POPUP_GRACE_MS)),
    ]);
}

/**
 * A key or a scroll with no ref lands on whatever page the Bot is on — so it is held to the page the
 * server judged it against, which is the generation it carries.
 *
 * WITHOUT THIS THE BOUNDARY JUDGED ONE PAGE AND THE KEY LANDED ON ANOTHER. Measured 2026-09-26 on
 * the real computer: a page's script opened a tab 1.5 s after the Bot's snapshot, the tab became the
 * Bot's, and the next `/key Enter` pressed the new page's autofocused 송금하기 — while the gateway,
 * whose snapshot still said the page before, judged it there and let the money-host rule pass and
 * wrote the old page into the audit row. A ref cannot do this: `resolveRef` refuses one from another
 * generation. A ref-less key had nothing to refuse with.
 *
 * Absent — an older server — is held to nothing, as it always was.
 */
function assertSameGeneration(
  session: BotSession,
  target: Page,
  expected: number | undefined,
): void {
  if (expected !== undefined && expected !== session.snapshotId) {
    throw new StaleSnapshotError(STALE_REFS, {
      url: target.url(),
      generation: session.snapshotId,
    });
  }
}

/**
 * Carry out one action on the page.
 *
 * Every action that addresses an element goes through `resolveRef`, so the staleness check
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
  actionTimeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Passed to every Playwright call below. It does not disable the timeout, which still applies.
  const acting = { timeout: actionTimeoutMs, ...(signal ? { signal } : {}) };
  const expected =
    typeof body.snapshotId === "number" ? body.snapshotId : undefined;
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;

  if (action === "/click") {
    if (!ref) throw new RequestInvalidError("ref");
    const control = await resolveRef(session, target, ref, expected);
    await holdToLabel(control, body.element);
    const opening = watchForTab(target, actionTimeoutMs);
    await onElement(() => control.click(acting));
    await opening();
    return { action: "click", ref, url: target.url() };
  }

  if (action === "/type") {
    if (!ref) throw new RequestInvalidError("ref");
    const text = body.text;
    if (typeof text !== "string") throw new RequestInvalidError("text");
    const field = await resolveRef(session, target, ref, expected);
    await holdToLabel(field, body.element);
    // The Bot's own words, never blanked from an address it sends them in (`typed-values.ts`).
    keepOwn(session, digestOf(text));
    // `fill` rather than keystrokes: it clears the field first, which is what "put this value in
    // this box" means. Typing into a field a previous attempt half-filled otherwise appends, and the
    // form ends up with "AlicAlice" in it. Its failure is the element's, and says nothing else:
    // Playwright's own message for it carries `fill("…")` with the text in it.
    await onElement(() => field.fill(text, acting));
    if (body.submit === true) {
      await onElement(() => field.press("Enter", acting));
    }
    // The text itself is deliberately NOT returned. It is echoed nowhere: this response is read by
    // the model and logged by the server, and a value typed into a form is exactly where a password
    // or a card number lives. The caller already knows what it sent.
    return {
      action: "type",
      ref,
      characters: text.length,
      submitted: body.submit === true,
      url: target.url(),
    };
  }

  if (action === "/key") {
    const key = body.key;
    if (typeof key !== "string" || !key) throw new RequestInvalidError("key");
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
      const control = await resolveRef(session, target, ref, expected);
      await holdToLabel(control, body.element);
      const opening = watchForTab(target, actionTimeoutMs);
      await onElement(() => control.press(key, acting));
      await opening();
    } else {
      assertSameGeneration(session, target, expected);
      const opening = watchForTab(target, actionTimeoutMs);
      await target.keyboard.press(key);
      await opening();
    }
    return { action: "key", key, ref, url: target.url() };
  }

  // Scroll. A plain wheel event on the page, which is what moves a long form, rather than scrolling a
  // specific element into view: the Bot asked to see further down, not to hunt for one control.
  assertSameGeneration(session, target, expected);
  const deltaY = typeof body.deltaY === "number" ? body.deltaY : 600;
  await target.mouse.wheel(0, deltaY);
  return { action: "scroll", deltaY, url: target.url() };
}

/**
 * THE PAGE AN ACTION LANDED ON, IN THE SAME ANSWER.
 *
 * A click that opened an article answered `{action, ref, url}`, and the Bot's next request was
 * always `computer_read` for the text: one more model round trip, with the whole conversation in
 * front of it, on every link followed (measured 2026-09-25 on the blog task: click → snapshot →
 * read → answer). Browser Use and Playwright MCP both hand the page's state back with the action;
 * this hands back what `/navigate` does — title and text — and only when the action went somewhere:
 * another address, or the tab a `target=_blank` link opened. A click that ticked a box costs nothing
 * more.
 *
 * Never a reason for the action to fail: the action happened, and a page that cannot be read yet
 * says so the way `/read` does, or says nothing.
 */
async function pageArrivedAt(
  session: BotSession,
  target: Page,
  before: string,
  opened: Page | undefined,
): Promise<Record<string, unknown> | undefined> {
  try {
    /*
     * THE TAB THE ACTION OPENED, NOT THE ONE THE BOT IS HANDED NEXT. Adoption (`profiles.ts`) asks
     * the browser for the new tab's opener first, so it lands a moment after the click returns;
     * reading "the Bot's page" here read the old tab, measured on the blog search's
     * `target=_blank` results. The opener is asked here too: a tab another Bot's click opened in the
     * same instant is not this one's.
     */
    const tab =
      opened && (await opened.opener().catch(() => null)) === target
        ? opened
        : undefined;
    const now = tab ?? target;
    if (now === target && now.url() === before) return undefined;
    const extract = await readSettledPageText(now);
    if (extract.arriving) {
      note(session, arrivalNote(extract.arriving));
      return { page: { url: now.url(), title: "", text: "" } };
    }
    return {
      page: {
        url: now.url(),
        title: await titleOf(now),
        text: extract.text,
        ...(extract.truncated ? { truncated: true } : {}),
        ...(extract.reader ? { reader: true } : {}),
      },
    };
  } catch {
    return undefined;
  }
}

/** `POST /click`, `/type`, `/key`, `/scroll`. */
export const act: BotRoute = async (
  { request, url, botId, session },
  { config, profiles },
) => {
  const body = await bodyOf<ActionBody>(request);
  if (!body) return invalid("body");

  const startedAt = Date.now();
  try {
    session.control.assertBotMayAct();
    const target = await profiles.page(botId);
    const before = target.url();
    let opened: Page | undefined;
    let tabOpened = () => {};
    const tab = new Promise<void>((resolve) => {
      tabOpened = resolve;
    });
    const onOpened = (page: Page) => {
      opened ??= page;
      tabOpened();
    };
    target.context().on("page", onOpened);
    let arrived: Record<string, unknown> | undefined;
    let detail: Record<string, unknown>;
    try {
      detail = await performAction(
        session,
        target,
        url.pathname,
        body,
        config.actionTimeoutMs,
        // The caller going away is the stop signal: the surface aborts its request, the server
        // aborts the one it made to this computer, and Bun aborts this one in turn.
        request.signal,
      );
      /*
       * A LINK THAT WENT NOWHERE YET MAY STILL OPEN A TAB. `watchForTab` gives a tab 150 ms, which
       * the fixture needs 30 of; on a loaded machine Naver's blog result took longer, and the click
       * answered as if nothing had opened while the tab arrived a moment later (measured 2026-09-25).
       * Only a link is waited for, and only this long: a button that changes the page in place
       * never pays it.
       */
      if (
        !opened &&
        target.url() === before &&
        (body.element as { role?: unknown } | undefined)?.role === "link"
      ) {
        await Promise.race([
          tab,
          new Promise((resolve) => setTimeout(resolve, LINK_TAB_WAIT_MS)),
        ]);
      }
      if (url.pathname !== "/scroll") {
        arrived = await pageArrivedAt(session, target, before, opened);
      }
    } finally {
      target.context().off("page", onOpened);
    }
    return json(
      withNotes(session, {
        ...detail,
        ...(arrived ?? {}),
        /*
         * Which generation the page this answer describes is. The server keeps it beside the address
         * it believes the Bot is on, and holds its next ref-less key to it (`assertSameGeneration`):
         * the address alone cannot say that a tab opened or a document was replaced under it.
         */
        generation: session.snapshotId,
        elapsedMs: Date.now() - startedAt,
      }),
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
      log.info("action_stopped", {
        action: url.pathname,
        ref: typeof body.ref === "string" ? body.ref : undefined,
        elapsedMs: Date.now() - startedAt,
      });
      // 499, the convention for a client that closed the request: this is not the computer
      // failing, and a 502 here would be counted as one.
      return fact("laf:stopped", { stopped: true });
    }
    return actionFailure(error);
  }
};

/**
 * `POST /upload`: hand a file from the workspace to a page.
 *
 * The one direction the workspace could not go. A Bot can save a 정산 내역 and could not attach
 * it to anything; a shop's product photo could be written and never uploaded. `setInputFiles`
 * needs a real path, so the file is resolved through the same confinement every other file call
 * uses — a Bot may only ever hand over something inside its own workspace.
 */
export const upload: BotRoute = async (
  { request, botId, session },
  { config, profiles, workspace },
) => {
  const body = await bodyOf<{
    ref?: unknown;
    snapshotId?: unknown;
    path?: unknown;
    element?: unknown;
  }>(request);
  if (typeof body?.ref !== "string" || !body.ref) return invalid("ref");
  if (typeof body?.path !== "string" || !body.path.trim()) {
    return invalid("path");
  }
  try {
    session.control.assertBotMayAct();
    const full = await workspace.resolvePath(body.path.trim(), false);
    const target = await profiles.page(botId);
    const field = await resolveRef(
      session,
      target,
      body.ref,
      typeof body.snapshotId === "number" ? body.snapshotId : undefined,
    );
    await holdToLabel(field, body.element);
    await onElement(() =>
      field.setInputFiles(full, { timeout: config.actionTimeoutMs }),
    );
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
    return actionFailure(error);
  }
};
