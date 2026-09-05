import { toolResultText } from "./prompt/tool-results.ko";

/**
 * A long tool result, kept whole on the Bot's own computer and shown to the model as a preview.
 *
 * A page's readable text comes back up to 6,000 characters and the whole conversation is resent
 * on every run, so each long result is paid for again on every turn after the one that needed it.
 * The server files the whole of it under the Bot's workspace (`server/src/computer/spillover.ts`)
 * and, from the next run on, forwards the first {@link TOOL_RESULT_PREVIEW} characters and the
 * path — the model reads the rest with `computer_read_file` when it actually wants it. Hermes
 * Agent does the same at 1,500 characters; the figure is theirs.
 *
 * In `shared/` because two services read the same line: the server writes it, and `agent-bot`
 * has to recognise it when it trims older results, so the path survives the trim.
 */

/** How much of a filed result the model is still shown. */
export const TOOL_RESULT_PREVIEW = 1_500;

/** Where the whole of a filed result lands, relative to the Bot's workspace. */
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

/** The line that closes a preview and names the file. The model reads it, so its words are the table's. */
export function spillLine(path: string): string {
  return toolResultText("laf:tool_result_spilled")
    .replace("{chars}", TOOL_RESULT_PREVIEW.toLocaleString("en-US"))
    .replace("{path}", path);
}

/** A filed result as the model sees it: the head, and where the whole of it is. */
export function previewOf(text: string, path: string): string {
  return `${text.slice(0, TOOL_RESULT_PREVIEW)}\n${spillLine(path)}`;
}

/** The line as it appears at the end of a result, wherever the table's words around it may move. */
const SPILL_LINE_AT_END = new RegExp(
  `\\n?([^\\n]*computer_read_file\\("${RESULTS_DIRECTORY.replace(".", "\\.")}/[^"\\n]+"\\)[^\\n]*)$`,
);

/** The spill line at the end of a tool result, if it carries one — so a later trim can keep it. */
export function spillLineOf(text: string): string | null {
  return text.match(SPILL_LINE_AT_END)?.[1] ?? null;
}
