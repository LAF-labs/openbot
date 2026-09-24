import { toolResultText } from "./prompt/tool-results.ko";

/**
 * A tool result too long to carry whole, cut ONCE — where it is produced — and kept whole on the
 * Bot's own computer.
 *
 * CUT AT CREATION, NEVER AGAIN (agent-harness-design row 8, Claude Code's rule: old history is
 * never rewritten; a large output is cut when it is produced). The server used to file every result
 * over 1,500 characters and show the model a preview "from the next run on", and agent-bot cut
 * every result older than the newest four to 500 characters — so each step of a browsing task
 * rewrote a result the provider had cached one step earlier. Measured on 2026-09-25: a ten-step
 * browsing question read 54–59% of its prompt from cache after its first request. Now the cut is a
 * pure function of the result: the same text is shown the same way on the first run and every run
 * after, and the conversation behind it stays a prefix the provider already holds.
 *
 * THE BOUND IS WHAT ONE STEP NEEDS WHOLE. A page's readable text is at most 6,000 characters
 * (`agent-computer`) and a snapshot of 200 elements about 20,000; the model is working from exactly
 * those, so they pass. What is over is a file read (up to 64,000), and for that the head the model
 * sees is the bound itself, with the whole on file. Context pressure from many whole results is
 * relieved at compaction, which starts an epoch (`server/src/context/compaction.ts`).
 *
 * In `shared/` because the words are the model's: the server writes the line, the eval reads it.
 */

/** Longer than this, a result is cut when it is first seen. */
export const TOOL_RESULT_CUT = 20_000;

/** Where the whole of a cut result lands, relative to the Bot's workspace. */
export const RESULTS_DIRECTORY = ".results";

/**
 * The workspace path for one tool call's whole result.
 *
 * The id is the provider's, so only path-safe characters reach the name; anything else — a slash,
 * a dot, a space — becomes an underscore, and the computer's own confinement stays the boundary.
 */
export function spillPath(toolCallId: string): string {
  const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return `${RESULTS_DIRECTORY}/${safe || "result"}.txt`;
}

/** The line that closes a cut result and names the file. The model reads it, so its words are the table's. */
export function spillLine(path: string, total: number): string {
  return toolResultText("laf:tool_result_spilled")
    .replace("{chars}", TOOL_RESULT_CUT.toLocaleString("en-US"))
    .replace("{total}", total.toLocaleString("en-US"))
    .replace("{path}", path);
}

/** A cut result as the model sees it — on every request, from the first: the head, and where the whole is. */
export function previewOf(text: string, path: string): string {
  return `${text.slice(0, TOOL_RESULT_CUT)}\n${spillLine(path, text.length)}`;
}
