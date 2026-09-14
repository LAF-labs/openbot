/**
 * An element, by the ref a snapshot gave it — or a refusal that says to take another snapshot.
 *
 * `aria-ref=` is a first-party Playwright selector engine, and it is the same one its MCP server
 * uses. The generation check here is the caller-facing half; see `BotSession.snapshotId` for why
 * both exist.
 */
import type { Locator, Page } from "playwright";
import { fromDocument } from "./page-arrival";
import type { BotSession } from "./sessions";

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
export const STALE_REFS = "laf:stale_refs";

export class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

/**
 * The element a ref resolved to would not take the action: hidden, covered, disabled, not something
 * text or a file can go into, or gone while Playwright waited for it.
 *
 * Its own class so the answer is decided by WHERE the failure happened rather than by reading
 * Playwright's message, which is the call log (see `fact` in respond.ts for what that log carries).
 * 409, because the instruction is the one a stale ref gets: look again before acting. It is also
 * where the server has always put these — it matched `waiting for locator` in the call log and
 * answered 409 — so a code in place of the log changes the words the Bot reads, not its next move.
 */
export const ELEMENT_NOT_ACTIONABLE = "laf:element_not_actionable";

export class ElementActionError extends Error {
  constructor(cause: unknown) {
    super(ELEMENT_NOT_ACTIONABLE, { cause });
    this.name = "ElementActionError";
  }
}

/** Do one thing to an element, and let its failure say it was the element. */
export async function onElement<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new ElementActionError(error);
  }
}

/**
 * Resolve a ref to a locator, refusing anything from a superseded snapshot.
 *
 * Every action that addresses an element goes through here, so the staleness check cannot be
 * forgotten at a call site.
 */
export function locateRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
): Locator {
  if (
    expectedSnapshotId !== undefined &&
    expectedSnapshotId !== session.snapshotId
  ) {
    throw new StaleSnapshotError(STALE_REFS);
  }
  return target.locator(`aria-ref=${ref}`);
}

/**
 * How long a page is given to say whether a ref names anything.
 *
 * `count()` answers in milliseconds on a page that answers at all. On a tab whose next document is on
 * its way it does not answer until that document arrives (`page-arrival.ts`), and it has no timeout:
 * measured 2026-09-14 in the image built from dbc1c67, `/click` and `/type` one second into a
 * `/navigate` to `/hang` answered 502 at 29.1 s, when the navigation gave the page up.
 */
export const REF_WAIT_MS = 2_000;

/** What `count` answers, its failure kept apart from its silence. Undefined is no answer in `ms`. */
export async function countOn(
  target: Page,
  locator: Locator,
  ms: number = REF_WAIT_MS,
): Promise<number | undefined> {
  const counted = await fromDocument(
    target,
    ms,
    locator.count().then(
      (count) => ({ count }),
      (error: unknown) => ({ error }),
    ),
  );
  if (counted && "error" in counted) throw counted.error;
  return counted?.count;
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
 * milliseconds instead of holding the action open for the full timeout. A page that does not answer
 * the question at all is refused the same way: whatever it is doing — leaving for its next document,
 * most often — the ref cannot be shown to name anything on it, and the snapshot the Bot takes next
 * says what the page is doing.
 */
export async function resolveRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
): Promise<Locator> {
  const locator = locateRef(session, target, ref, expectedSnapshotId);
  if (!(await countOn(target, locator))) {
    throw new StaleSnapshotError(STALE_REFS);
  }
  return locator;
}
