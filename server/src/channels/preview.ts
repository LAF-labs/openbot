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
      // Emphasis. Asterisks and tildes come off wherever they bracket a span — `**일상 비서**이며`
      // closes straight into a particle, so no boundary is asked for at either end. Underscores
      // are asked for one: `a_b_c` is an identifier, not two emphasised letters.
      .replace(/(\*{1,3}|~~)(\S(?:[^\n]*?\S)?)\1/g, "$2")
      .replace(
        /(^|[\s(["'])(_{1,3})(\S(?:[^\n]*?\S)?)\2(?=[\s)\]"'.,:;!?]|$)/gm,
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
