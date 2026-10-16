import {
  HUB_CHUNK_CHARS,
  HUB_CHUNK_OVERLAP,
} from "../../../shared/hub/protocol";

/** Where chunk `ordinal` starts in its file's text, in characters. */
export const chunkStart = (ordinal: number): number =>
  ordinal * (HUB_CHUNK_CHARS - HUB_CHUNK_OVERLAP);

/**
 * A file's text cut for search: `HUB_CHUNK_CHARS` characters a piece, each starting
 * `HUB_CHUNK_CHARS - HUB_CHUNK_OVERLAP` after the last, so a sentence cut by one edge is whole in
 * the next piece. Counted in code points, as Postgres counts `char_length` and `substr`, so a hit's
 * `from` is where `/text?from=` reads.
 */
export function chunkText(text: string): string[] {
  const chars = [...text];
  if (chars.length === 0) return [];
  const step = HUB_CHUNK_CHARS - HUB_CHUNK_OVERLAP;
  const pieces: string[] = [];
  for (let start = 0; ; start += step) {
    pieces.push(chars.slice(start, start + HUB_CHUNK_CHARS).join(""));
    if (start + HUB_CHUNK_CHARS >= chars.length) break;
  }
  return pieces;
}
