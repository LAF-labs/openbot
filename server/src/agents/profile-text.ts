/**
 * What a Bot may write into its own profile, on its way to becoming part of every later prompt.
 *
 * `name`, `title` and `roleDescription` are rendered into the system message of every
 * conversation, room and routine the Bot ever runs (`shared/prompt/index.ts`) — the description as
 * a paragraph of its own, with nothing framing it, right under the line that says who the Bot is.
 * A page the Bot read can tell it to call `update_profile`, and the audit (A8, 2026-09-10) found
 * that write path took the text as sent: control characters, blank lines, a `system:` line. So a
 * page could write itself a section of every future prompt, and the owner would not see it unless
 * they opened the profile screen. The neighbouring `remember` refused instructions and said why;
 * the profile, which sits ABOVE the memories, refused nothing.
 *
 * ONE LINE, AND NOT A PROMPT. The prompt is sections separated by blank lines, and a line cannot
 * open one — so every control character, line break and run of blanks becomes a single space.
 * What is refused outright is the shape of a prompt (`looksLikePromptStructure`): a role or a
 * heading at the start of a line, a chat template's markers, a sentence that tells the assistant
 * its rules have changed. Not the shape of an order, which the memory filter also refuses — a job
 * description is an order by nature. A person's own edit form (`PATCH /:agentId`) is not on this
 * path and keeps what the person typed.
 */
import { looksLikePromptStructure } from "./memory-store";

/** Control characters, and the two line separators Unicode has besides them. */
const CONTROL = /[\p{Cc}\u2028\u2029]+/gu;

/** One line: control characters and whitespace runs are one space, and the ends are trimmed. */
export function flattenProfileText(text: string): string {
  return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/**
 * A field of a Bot's own profile write, as it may be kept. Anything that is not a string is
 * handed through for the validator to judge, the way it always was.
 *
 * Judged BEFORE it is flattened, because a line break is what makes `system:` a role marker rather
 * than a word in a sentence; kept AFTER, so nothing that was judged can open a section.
 */
export function profileTextOf(
  value: unknown,
):
  | { ok: true; value: unknown }
  | { ok: false; code: "laf:profile_looks_like_prompt" } {
  if (typeof value !== "string") return { ok: true, value };
  if (looksLikePromptStructure(value)) {
    return { ok: false, code: "laf:profile_looks_like_prompt" };
  }
  return { ok: true, value: flattenProfileText(value) };
}
