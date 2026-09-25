/**
 * HOW A BROWSING TASK ENDED, DECIDED ONCE, FROM FACTS — READ BY THE CARD, 오늘 AND THE DRAWER.
 *
 * Measured on 2026-09-25 (UX review 0.5.4, item 2): the same card read 멈춤 in one load and 끝남 in
 * the next, a site that answered the Bot with "Access Denied" read 끝남, and a browser that was down
 * read 멈춤, the owner's own word for pressing Stop. Five words for "it ended" across the card, the
 * banner, 오늘 and the drawer — 끝남, 멈춤, 중단됨, 끝내지 못함, 거부함 — each decided by its own code.
 *
 * Three endings, and nothing else:
 *  - `done`: the last step worked, on a page the site actually served.
 *  - `stopped`: the task stopped midway — the owner pressed Stop, or the step never got an answer.
 *  - `failed`: the last step did not work, or the page it ended on was the site refusing the Bot.
 *    `code` says why, for the surface to put in words.
 *
 * WHY A RELOAD USED TO CHANGE THE WORD. A step with no answer read `stopped`. Before the next turn
 * the app gives every unanswered call a placeholder answer (`repair-history.ts`), which was plain
 * text, which read as nothing wrong — `done`. Both are the same fact now, `stopped`.
 *
 * Both sides read this file: the app with the transcript's own results, the server with the same
 * results out of `laf_thread_messages` (`server/src/agents/day.ts`). Pure, no imports.
 */

/** The answer the app gives a call that never got one. Written by `repair-history.ts`. */
export const UNANSWERED_RESULT =
  "This call produced no result: the surface was interrupted before it could answer. Do not assume it succeeded.";

/**
 * The calls that use the Bot's browser, and so make up a browsing task. The app's card and the
 * server's 오늘 must fold the same calls, so the list is here (`app/src/lib/computer/browsing.ts`).
 */
export const BROWSING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "computer_navigate",
  "computer_read",
  "computer_snapshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_switch_tab",
  "computer_upload_file",
]);

/** The page a navigate landed on was an HTTP error: the site served a refusal, not the page. */
export const SITE_REFUSED = "laf:site_refused";

/** A result, reduced to the facts an ending is decided from. */
export type ResultFacts = {
  ok?: boolean;
  stopped?: boolean;
  refused?: boolean;
  code?: string;
  /** Set by the computer on a navigate whose document answered 400 or worse. */
  httpStatus?: number;
  /** The placeholder answer of a call that never got one. */
  unanswered?: boolean;
};

export type TaskEnding =
  | { kind: "done" }
  | { kind: "stopped" }
  | { kind: "failed"; code: string | null };

/** One step: which tool, and its result's facts, or null while it has no result. */
export type EndingStep = { name: string; facts: ResultFacts | null };

/** A result string, as the transcript holds it, reduced to its facts. Null for no result. */
export function resultFactsOf(result: string | undefined): ResultFacts | null {
  if (result === undefined) return null;
  if (result === UNANSWERED_RESULT) return { unanswered: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // The runtime stringifies a thrown handler as "Error: <message>".
    return result.startsWith("Error:") ? { ok: false } : {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  return factsOfObject(parsed as Record<string, unknown>);
}

/** The facts of a parsed result, each kept only when it has the type it should. */
export function factsOfObject(value: Record<string, unknown>): ResultFacts {
  const facts: ResultFacts = {};
  if (typeof value.ok === "boolean") facts.ok = value.ok;
  if (value.stopped === true) facts.stopped = true;
  if (value.refused === true) facts.refused = true;
  if (typeof value.code === "string") facts.code = value.code;
  if (typeof value.httpStatus === "number") facts.httpStatus = value.httpStatus;
  return facts;
}

/**
 * How a task ended, from its steps in order. Called only for a task that is no longer running: a
 * running one is the caller's to say.
 *
 * The page the task ended on is the last navigate's: a refusal there stays the task's ending until
 * another navigate lands somewhere that served a page, whatever the Bot read on the refusal after.
 */
export function endingOfSteps(steps: readonly EndingStep[]): TaskEnding {
  const last = steps.at(-1);
  if (!last || last.facts === null) return { kind: "stopped" };
  const facts = last.facts;
  if (facts.unanswered === true || facts.stopped === true) {
    return { kind: "stopped" };
  }
  if (facts.ok === false || facts.refused === true) {
    return { kind: "failed", code: facts.code ?? null };
  }
  let isOnRefusal = false;
  for (const step of steps) {
    if (step.name !== "computer_navigate" || step.facts === null) continue;
    if (step.facts.ok === false) continue;
    isOnRefusal = (step.facts.httpStatus ?? 0) >= 400;
  }
  return isOnRefusal
    ? { kind: "failed", code: SITE_REFUSED }
    : { kind: "done" };
}
