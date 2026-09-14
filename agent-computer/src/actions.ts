/**
 * The Bot acting on a page: a click, typing, a key, a scroll — and a file handed to a file input.
 *
 * In the intended deployment path, the server gateway decides whether an action may run and records
 * the audit row before calling this process, and it sends the role and name it judged the ref to be
 * (label-hold.ts). This process has no policy engine and no audit trail of its own.
 */
import type { Page } from "playwright";
import type { BotRoute } from "./computer";
import { ControlError } from "./control";
import { fileStatus } from "./file-routes";
import { holdToLabel, LabelChangedError } from "./label-hold";
import { log } from "./log";
import { resolveRef, STALE_REFS, StaleSnapshotError } from "./refs";
import { bodyOf, describe, json } from "./respond";
import { type BotSession, withNotes } from "./sessions";
import { WorkspaceFileError, WorkspacePathError } from "./workspace";

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
    if (!ref) throw new Error("A click needs the ref of an element to click.");
    const control = await resolveRef(session, target, ref, expected);
    await holdToLabel(control, body.element);
    const opening = watchForTab(target, actionTimeoutMs);
    await control.click(acting);
    await opening();
    return { action: "click", ref, url: target.url() };
  }

  if (action === "/type") {
    if (!ref) throw new Error("Typing needs the ref of a field to type into.");
    if (typeof body.text !== "string") {
      throw new Error("Typing needs the text to enter.");
    }
    const field = await resolveRef(session, target, ref, expected);
    await holdToLabel(field, body.element);
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
      const control = await resolveRef(session, target, ref, expected);
      await holdToLabel(control, body.element);
      const opening = watchForTab(target, actionTimeoutMs);
      await control.press(body.key, acting);
      await opening();
    } else {
      const opening = watchForTab(target, actionTimeoutMs);
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

/** `POST /click`, `/type`, `/key`, `/scroll`. */
export const act: BotRoute = async (
  { request, url, botId, session },
  { config, profiles },
) => {
  const body = await bodyOf<ActionBody>(request);
  if (!body) {
    return json({ error: "An action needs a JSON body." }, 400);
  }

  const startedAt = Date.now();
  try {
    session.control.assertBotMayAct();
    const target = await profiles.page(botId);
    const detail = await performAction(
      session,
      target,
      url.pathname,
      body,
      config.actionTimeoutMs,
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
      log.info("action_stopped", {
        action: url.pathname,
        ref: typeof body.ref === "string" ? body.ref : undefined,
        elapsedMs: Date.now() - startedAt,
      });
      // 499, the convention for a client that closed the request: this is not the computer
      // failing, and a 502 here would be counted as one.
      return json({ error: "Stopped.", stopped: true }, 499);
    }
    // A stale ref is the caller's mistake and is fixable by taking a new snapshot, so it is a 409
    // rather than a 502: the computer is fine and retrying the same call unchanged will not help.
    if (error instanceof StaleSnapshotError) {
      return json({ error: error.message, stale: true }, 409);
    }
    // Same status, because the instruction is the same — take a new snapshot — but its own code:
    // the control is still there under another name, and the Bot must look before it acts on it.
    if (error instanceof LabelChangedError) {
      return json(
        {
          error: "laf:label_changed",
          code: "laf:label_changed",
          stale: true,
        },
        409,
      );
    }
    // 409 as well, and for the same reason: nothing is broken, the caller simply has to wait.
    if (error instanceof ControlError) {
      return json({ error: error.message, humanHasControl: true }, 409);
    }
    return json({ error: describe(error, "The action failed.") }, 502);
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
  if (typeof body?.ref !== "string" || !body.ref) {
    return json({ error: "The ref of a file input is required." }, 400);
  }
  if (typeof body?.path !== "string" || !body.path.trim()) {
    return json({ error: "A file path is required." }, 400);
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
    await field.setInputFiles(full, { timeout: config.actionTimeoutMs });
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
    // Same status, because the instruction is the same — take a new snapshot — but its own code:
    // the control is still there under another name, and the Bot must look before it acts on it.
    if (error instanceof LabelChangedError) {
      return json(
        {
          error: "laf:label_changed",
          code: "laf:label_changed",
          stale: true,
        },
        409,
      );
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
};
