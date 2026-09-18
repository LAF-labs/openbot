import { useState } from "react";
import { t } from "@/lib/i18n";

/**
 * ONE PRESS OF A DIALOG'S PRIMARY BUTTON: WHETHER IT STILL APPLIES, THE ACTION, AND WHAT IT CAME TO.
 *
 * `docs/laf/dialogs.md` is the list every dialog keeps; this is the part of it that is not drawing.
 * Kept out of the components on purpose: a `try` with a conditional inside it is one of the things
 * the React Compiler leaves uncompiled, and here there is no component to leave.
 *
 * THE RE-CHECK COMES FIRST, AT THE PRESS. A delete confirmed against a Bot that another window
 * deleted a minute ago is a request the server will refuse, and the refusal reads as the product
 * failing. `recheck` answers, now, whether the action still applies: a sentence saying why it does
 * not, or `null` to go ahead. Only when it has no reason to stop is `act` called.
 *
 * A FAILURE IS A SENTENCE, IN THE PERSON'S LANGUAGE. Every request helper in this app throws an
 * `Error` whose message is already `t()`'d, so that is used as it is. What is not ours is not
 * shown: a `fetch` that nothing answered rejects with the browser's own English ("Failed to
 * fetch", "Load failed", "NetworkError when attempting to fetch resource."), and a bug throws the
 * engine's — neither belongs in a dialog.
 */

export type PressOutcome =
  | { kind: "done" }
  /** It no longer applies, and nothing was sent. */
  | { kind: "moot"; sentence: string }
  | { kind: "failed"; sentence: string };

export async function pressOnce({
  act,
  recheck,
}: {
  act: () => unknown;
  recheck?: (() => Promise<string | null>) | undefined;
}): Promise<PressOutcome> {
  try {
    const moot = recheck ? await recheck() : null;
    if (moot) return { kind: "moot", sentence: moot };
    await act();
    return { kind: "done" };
  } catch (error) {
    return { kind: "failed", sentence: failureSentence(error) };
  }
}

/**
 * A form dialog's press, held: whether it is running, and what the last one failed with.
 *
 * `run` resolves `true` when the action is done, so the dialog closes then and only then; on a
 * failure it keeps what was typed, because nothing here touches the fields, and `failure` is the
 * sentence for the dialog's alert line. The caller refuses a second press while `isRunning`.
 */
export function usePress() {
  const [isRunning, setIsRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (act: () => unknown): Promise<boolean> => {
    setFailure(null);
    setIsRunning(true);
    const outcome = await pressOnce({ act });
    setIsRunning(false);
    if (outcome.kind === "done") return true;
    setFailure(outcome.sentence);
    return false;
  };
  const forget = () => setFailure(null);
  return { failure, forget, isRunning, run };
}

/** The browser's words for a request nothing answered, the three spellings `turn-failure.ts` lists. */
const UNANSWERED = /failed to fetch|load failed|networkerror|network error/i;

/** The engine's own errors: their messages are about code, in English, and never ours to show. */
const ENGINE_ERRORS = [
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
];

/** What went wrong, as a sentence a dialog can put in front of somebody. */
export function failureSentence(error: unknown): string {
  if (error instanceof Error && UNANSWERED.test(error.message)) {
    return t("The server could not be reached. Please try again in a moment.");
  }
  const isOurs =
    error instanceof Error &&
    !(typeof DOMException !== "undefined" && error instanceof DOMException) &&
    !ENGINE_ERRORS.some((kind) => error instanceof kind);
  if (isOurs && error.message.trim()) return error.message;
  return t("That did not go through. Try again.");
}
