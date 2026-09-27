/**
 * WHAT A SCREEN READER IS HANDED WHEN A REPLY ARRIVES: THE WORDS, NOT THE MARKDOWN THAT DREW THEM.
 *
 * The transcript announces a finished reply ("답장: …") from the raw text the Bot wrote, and on the
 * first-hour walk (2026-09-27) that announcement read its `**` aloud, along with the pipes and dashes
 * of a table. A bubble draws those marks as bold and as a grid; a voice has nothing to draw them
 * with, so they go, and what they held stays.
 *
 * Deliberately a line-by-line pass rather than a parser: the announcement is the first 240
 * characters of one reply, read once, and the renderer that draws the bubble is a lazy chunk the
 * transcript does not wait for.
 */

/** A table's separator row: `|---|:--:|`. It says where a line is, and nothing to hear. */
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function spokenLine(line: string): string | null {
  if (TABLE_RULE.test(line)) return null;
  // A code fence's own line opens or closes a block; the code inside it is still said.
  if (/^\s*(?:```|~~~)/.test(line)) return null;
  let text = line
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "");
  if (/^\s*\|.*\|\s*$/.test(text)) {
    // A table row, cell by cell: "칭찬 리뷰, 감사합니다, 짧게".
    text = text
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", ");
  }
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(
      /(^|[^\p{L}\p{N}])[*_](?=\S)(.+?)(?<=\S)[*_](?![\p{L}\p{N}])/gu,
      "$1$2",
    )
    .trim();
}

/** The reply as it is heard: marks gone, blank lines gone, one line per line that says something. */
export function spokenText(text: string): string {
  return text
    .split("\n")
    .map(spokenLine)
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
