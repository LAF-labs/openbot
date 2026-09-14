/**
 * What a failed call is answered with, by what failed rather than by what it said.
 *
 * Every refusal here has a status that tells the caller what to do next — 409 look again or wait,
 * 403 never, 400 send something different, 502 the browser did not manage it — and a code that says
 * which. See `fact` in respond.ts for why the code is all there is.
 */
import { ControlError, HUMAN_HAS_CONTROL } from "./control";
import { LabelChangedError } from "./label-hold";
import {
  ELEMENT_NOT_ACTIONABLE,
  ElementActionError,
  STALE_REFS,
  StaleSnapshotError,
} from "./refs";
import { browserFailed, fact, invalid, RequestInvalidError } from "./respond";
import { WorkspaceFileError, WorkspacePathError } from "./workspace";

/**
 * A file request that failed. A path outside the workspace is the caller asking for something it may
 * never have, so 403: retrying it unchanged will never work, and it is not a fault. A missing file or
 * an oversized write is a 400, because a different request would succeed. Collapsing both into 500
 * would tell the Bot the computer is broken and invite it to try the same thing again.
 */
export function fileFailure(error: unknown): Response {
  if (error instanceof WorkspacePathError) return fact(error.code, 403);
  if (error instanceof WorkspaceFileError) {
    return fact(error.code, 400, error.facts);
  }
  return fact("laf:file_failed", 500);
}

/** An action on the page that did not happen, whatever stopped it. */
export function actionFailure(error: unknown): Response {
  if (error instanceof RequestInvalidError) return invalid(error.field);
  // A stale ref is the caller's mistake and is fixable by taking a new snapshot, so it is a 409
  // rather than a 502: the computer is fine and retrying the same call unchanged will not help.
  if (error instanceof StaleSnapshotError) {
    return fact(STALE_REFS, 409, { stale: true });
  }
  // Same status, because the instruction is the same — take a new snapshot — but its own code:
  // the control is still there under another name, and the Bot must look before it acts on it.
  if (error instanceof LabelChangedError) {
    return fact("laf:label_changed", 409, { stale: true });
  }
  // 409 as well, and for the same reason: nothing is broken, the caller simply has to wait.
  if (error instanceof ControlError) {
    return fact(HUMAN_HAS_CONTROL, 409, { humanHasControl: true });
  }
  if (
    error instanceof WorkspacePathError ||
    error instanceof WorkspaceFileError
  ) {
    return fileFailure(error);
  }
  if (error instanceof ElementActionError) {
    return fact(ELEMENT_NOT_ACTIONABLE, 409, { stale: true });
  }
  return browserFailed(error);
}
