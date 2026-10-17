import type { ReactNode } from "react";

/**
 * The one-line markdown a block shows when nobody is writing in it: **굵게**, *기울임* (or _기울임_),
 * `코드` and [링크](https://…). Our own few lines rather than a markdown library (no new dependency,
 * hub design §11), and only these four: a block is one line of a team document, not a page.
 *
 * NOTHING HERE IS HTML. Every piece becomes a React node, so a colleague's `<script>` in a block is
 * the characters `<script>` on screen. A link is drawn only for `http:`, `https:` and `mailto:` — a
 * `javascript:` address is the text it was written as.
 */
export type InlinePiece =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const SAFE_HREF = /^(https?:\/\/|mailto:)[^\s]+$/i;

/** The pieces of one block's text, in order. Unclosed marks are plain text. */
export function inlinePieces(source: string): InlinePiece[] {
  const pieces: InlinePiece[] = [];
  let plain = "";
  const flush = () => {
    if (plain) pieces.push({ kind: "text", text: plain });
    plain = "";
  };
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === "`") {
      const end = source.indexOf("`", at + 1);
      if (end > at + 1) {
        flush();
        pieces.push({ kind: "code", text: source.slice(at + 1, end) });
        at = end + 1;
        continue;
      }
    }
    if (char === "*" && source[at + 1] === "*") {
      const end = source.indexOf("**", at + 2);
      if (end > at + 2) {
        flush();
        pieces.push({ kind: "bold", text: source.slice(at + 2, end) });
        at = end + 2;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      const end = source.indexOf(char, at + 1);
      // `2*3*4` and snake_case stay as written: the mark has to touch a word on its inside.
      if (
        end > at + 1 &&
        source[at + 1] !== " " &&
        source[end - 1] !== " " &&
        (char === "*" || !/\w/.test(source[at - 1] ?? ""))
      ) {
        flush();
        pieces.push({ kind: "italic", text: source.slice(at + 1, end) });
        at = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const close = source.indexOf("](", at + 1);
      const end = close === -1 ? -1 : source.indexOf(")", close + 2);
      if (close > at + 1 && end > close + 2) {
        const href = source.slice(close + 2, end);
        if (SAFE_HREF.test(href)) {
          flush();
          pieces.push({
            kind: "link",
            text: source.slice(at + 1, close),
            href,
          });
          at = end + 1;
          continue;
        }
      }
    }
    plain += char;
    at += 1;
  }
  flush();
  return pieces;
}

export function InlineMarkdown({ text }: { text: string }): ReactNode {
  return inlinePieces(text).map((piece, index) => {
    const key = `${index}:${piece.kind}`;
    switch (piece.kind) {
      case "bold":
        return (
          <strong className="font-semibold" key={key}>
            {piece.text}
          </strong>
        );
      case "italic":
        return (
          <em className="italic" key={key}>
            {piece.text}
          </em>
        );
      case "code":
        return (
          <code
            className="rounded bg-muted px-1 py-0.5 font-mono"
            key={key}
          >
            {piece.text}
          </code>
        );
      case "link":
        return (
          <a
            className="text-link underline underline-offset-2"
            href={piece.href}
            key={key}
            // A click on a link opens it; it does not start writing in the block.
            onClick={(event) => event.stopPropagation()}
            rel="noopener noreferrer"
            target="_blank"
          >
            {piece.text}
          </a>
        );
      default:
        return <span key={key}>{piece.text}</span>;
    }
  });
}
