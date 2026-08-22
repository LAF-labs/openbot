/**
 * The one line a roster row shows for the last thing said in a room.
 *
 * A Bot writes markdown, and a preview that shows its marks — `**보고:**`, `- `, `> ` — reads as a
 * glitch in a list whose every other row is plain. The marks come off here, once, on the way into
 * `channels.last_message`; the transcript keeps the markdown, the roster keeps the words.
 */

export const MAX_ACTIVITY_CODE_POINTS = 200;

/** What `**bold**`, `_italic_`, headings, bullets, quotes, code and links say without their marks. */
export function plainTextOf(markdown: string): string {
  return (
    markdown
      // Fenced blocks keep their code, lose their fences.
      .replace(/```[^\n]*\n?/g, "")
      .replace(/`([^`]*)`/g, "$1")
      // Images are nothing in one line; links are their text.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Line-leading structure: headings, bullets, numbered items, quotes.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*[-*+][ \t]+/gm, "")
      .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      // Emphasis: a run of marks that opens at a word's start and closes at its end. Not a mark
      // inside a word — `a_b_c` and `2 * 3` are what they look like.
      .replace(
        /(^|[\s(["'])(\*{1,3}|_{1,3}|~~)(\S(?:.*?\S)?)\2(?=[\s)\]"'.,:;!?]|$)/gm,
        "$1$3",
      )
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

export function previewOf(text: string): string {
  const flattened = plainTextOf(text).replace(CONTROL_CHARACTERS, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= MAX_ACTIVITY_CODE_POINTS) return collapsed;
  return `${codePoints.slice(0, MAX_ACTIVITY_CODE_POINTS - 1).join("")}…`;
}
