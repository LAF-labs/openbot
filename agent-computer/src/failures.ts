/**
 * What a failed call is answered with, by what failed rather than by what it said.
 *
 * Every refusal here has a status that tells the caller what to do next — 409 look again,
 * 403 never, 400 send something different, 502 the browser did not manage it — and a code that says
 * which. The status belongs to the code (codes.ts); see `fact` in respond.ts for why the code is all
 * there is.
 */
import { LabelChangedError } from "./label-hold";
import { LoginOriginError } from "./origin-hold";
import {
  ELEMENT_NOT_ACTIONABLE,
  ElementActionError,
  STALE_REFS,
  StaleSnapshotError,
} from "./refs";
import {
  browserFailed,
  fact,
  invalid,
  RequestInvalidError,
  saysRendererDied,
} from "./respond";
import { log } from "./log";
import { WorkspaceFileError, WorkspacePathError } from "./workspace";

/**
 * A file request that failed. A path outside the workspace is the caller asking for something it may
 * never have, so 403: retrying it unchanged will never work, and it is not a fault. A missing file or
 * an oversized write is a 400, because a different request would succeed. Collapsing both into 500
 * would tell the Bot the computer is broken and invite it to try the same thing again.
 */
export function fileFailure(error: unknown): Response {
  if (error instanceof WorkspacePathError) return fact(error.code);
  if (error instanceof WorkspaceFileError) {
    return fact(error.code, error.facts);
  }
  /*
   * WHAT NOBODY FORESAW IS SAID ONCE, HERE, BY ITS KIND. Until 2026-10-06 this line answered and
   * wrote nothing, so a failure that was really a bug read, to whoever looked, as a disk having a
   * bad moment — a request body that could not be iterated hid behind it for an afternoon (the
   * independent read). The errno and the error's class, and nothing else: a filesystem error's
   * message is the path it failed on, and a file's name is a person's.
   */
  const errno =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code)
      ? error.code
      : null;
  log.warn("file_failed", {
    ...(errno ? { errno } : {}),
    failure:
      error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name)
        ? error.name
        : typeof error,
  });
  return fact("laf:file_failed");
}

/** An action on the page that did not happen, whatever stopped it. */
export function actionFailure(error: unknown): Response {
  if (error instanceof RequestInvalidError) return invalid(error.field);
  // A stale ref is the caller's mistake and is fixable by taking a new snapshot, so it is a 409
  // rather than a 502: the computer is fine and retrying the same call unchanged will not help.
  if (error instanceof StaleSnapshotError) {
    return fact(STALE_REFS, { stale: true });
  }
  // Same status, because the instruction is the same — take a new snapshot — but its own code:
  // the control is still there under another name, and the Bot must look before it acts on it.
  if (error instanceof LabelChangedError) {
    return fact("laf:label_changed", { stale: true });
  }
  // Not stale, and no new look mends it: the box is where it is, and that is not where the login
  // was saved for.
  if (error instanceof LoginOriginError) {
    return fact("laf:login_origin_mismatch");
  }
  if (
    error instanceof WorkspacePathError ||
    error instanceof WorkspaceFileError
  ) {
    return fileFailure(error);
  }
  if (error instanceof ElementActionError) {
    // The element did not refuse: its tab's renderer died under the action. The browser's failure,
    // said as one, and kept for the door to let go of the tab by (`answeredADeadTab`).
    // Its cause, not itself: this error's own message is the code for an element that refused.
    if (saysRendererDied(error.cause)) return browserFailed(error.cause);
    return fact(ELEMENT_NOT_ACTIONABLE, { stale: true });
  }
  return browserFailed(error);
}
