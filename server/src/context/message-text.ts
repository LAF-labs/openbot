/**
 * A stored message's words, for the two readers that turn a conversation into a summary: the
 * compaction (`compaction.ts`) and the day's close (`day-close.ts`). It was written out in both,
 * character for character.
 *
 * NOT `textOf` in `shared/message-content.ts`, and not by oversight. That one is for what a person
 * or a model is shown: its input is typed, it NAMES a part that is not text (`[image]`) and it
 * joins the parts with a newline. This one reads rows as the thread store kept them — `unknown`,
 * in whatever shape the run that wrote them had — and wants only what was said: every part that
 * carries a `text` counts, a part that carries none says nothing, and the parts run together.
 *
 * AND NOT THE THREE THAT LOOK LIKE IT (`agents/memory-curation.ts`, `context/conversations.ts`,
 * `runner/run-ledger.ts`): those take a part only when its `type` is `"text"`. A part of another
 * type that carries a `text` is words here and nothing there, so folding them in would change what
 * one side or the other reads.
 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}
