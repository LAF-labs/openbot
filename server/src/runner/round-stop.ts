/**
 * Where a round of browser steps stops.
 *
 * A model may ask for several steps in one reply — three fields and the 검색 under them — and the
 * turn loop carries them out in the order they were asked for (`turn-loop.ts`). Each step was
 * written against the page as it stood before ANY of them ran. So once one of them did not go
 * through, or changed what is on the screen, the steps after it are aimed at a page that is no
 * longer the one they were written for, and they are not tried.
 *
 * The hole this closes was on the routine path: a field held for an approval nobody was there to
 * give came back `laf:nobody_answered`, and the loop went on to press 검색 over the empty field.
 * Chat had the same shape after a person's no.
 *
 * Only the steps that ACT on the page are stopped. A snapshot, a read, the workspace's files and
 * every tool that is not the browser's still run: a snapshot after the stop is the Bot's one look
 * at where the page landed, and none of them changes what is on it.
 */
import type { LoopOutcome } from "./turn-loop";

/** The browser tools that change the page or what the next step lands on. */
export const ACTING_COMPUTER_TOOLS: ReadonlySet<string> = new Set([
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_upload_file",
  "computer_navigate",
  "computer_switch_tab",
  "computer_request_help",
  "computer_request_secret",
]);

/**
 * Steps that end the round whatever they answer. A new address and another tab are another page; a
 * person who took the wheel or typed into a field has changed it in ways the Bot did not see.
 */
const ALWAYS_ENDS: ReadonlySet<string> = new Set([
  "computer_navigate",
  "computer_switch_tab",
  "computer_request_help",
  "computer_request_secret",
]);

/**
 * Whether the rest of the round's acting steps are void after this one.
 *
 * `page` is the computer's report that the step moved the page — a link followed, a form sent, a
 * tab opened (`agent-computer/src/actions.ts`, `pageArrivedAt`) — and arrives as a top-level key on
 * both paths, spread from the reply. An alert is a note: the page did something the Bot did not
 * ask for, and the browser may have pressed 취소 on it.
 */
export function roundEndsAfter(name: string, outcome: LoopOutcome): boolean {
  if (!ACTING_COMPUTER_TOOLS.has(name)) return false;
  if (ALWAYS_ENDS.has(name)) return true;
  // Every acting tool answers an envelope; a sentence is nothing this rule can read.
  if (typeof outcome === "string") return false;
  if (!outcome.ok) return true;
  if (typeof outcome.page === "object" && outcome.page !== null) return true;
  const codes = outcome.noteCodes;
  return Array.isArray(codes) && codes.includes("laf:dialog");
}
