/**
 * An element, by the ref a snapshot gave it — or a refusal that says to take another snapshot.
 *
 * `aria-ref=` is a first-party Playwright selector engine, and it is the same one its MCP server
 * uses. The generation check here is the caller-facing half; see `BotSession.snapshotId` for why
 * both exist.
 */
import type { Locator, Page } from "playwright";
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
export async function resolveRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
): Promise<Locator> {
  const locator = locateRef(session, target, ref, expectedSnapshotId);
  if ((await locator.count()) === 0) {
    throw new StaleSnapshotError(STALE_REFS);
  }
  return locator;
}
