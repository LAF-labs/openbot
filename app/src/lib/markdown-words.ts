import type { StreamdownTranslations } from "streamdown";
import { t } from "@/lib/i18n";

/**
 * THE WORDS THE MARKDOWN RENDERER DRAWS BY ITSELF, IN THE PERSON'S LANGUAGE.
 *
 * Streamdown puts controls of its own on what it renders — two on every table, one on every code
 * block — and their words are its, not ours: an answer with a table in it drew "Copy table" and
 * "Download table" on hover, and "Markdown / CSV / TSV" under them (pressed on the running app,
 * 2026-10-02). `i18n-coverage.test.ts` cannot see a library's strings, so "Korean on every
 * actionable string" held everywhere except on the Bot's own answers.
 *
 * English keys for `t()`, one per word, like every other string here. They are read through a
 * variable, so `markdown-words.test.ts` walks this table for the Korean. The type is the
 * renderer's own list of words: one it gains in an upgrade is a type error here rather than a new
 * English label nobody noticed.
 *
 * TYPE-ONLY IMPORT. The renderer is a megabyte that the build keeps out of the first load
 * (`lib/markdown.tsx`); this file is imported by whatever draws it and must not bring it along.
 */
export const MARKDOWN_WORDS: Readonly<
  Record<keyof StreamdownTranslations, string>
> = {
  close: "Close",
  copied: "Copied",
  copyCode: "Copy code",
  copyLink: "Copy link",
  copyTable: "Copy table",
  copyTableAsCsv: "Copy table as CSV",
  copyTableAsMarkdown: "Copy table as Markdown",
  copyTableAsTsv: "Copy table to paste into a spreadsheet",
  downloadDiagram: "Download diagram",
  downloadDiagramAsMmd: "Download diagram as MMD",
  downloadDiagramAsPng: "Download diagram as PNG",
  downloadDiagramAsSvg: "Download diagram as SVG",
  downloadFile: "Download file",
  downloadImage: "Download image",
  downloadTable: "Download table",
  downloadTableAsCsv: "Download table as a CSV file",
  downloadTableAsMarkdown: "Download table as a Markdown file",
  exitFullscreen: "Exit fullscreen",
  externalLinkWarning: "You're about to visit an external website.",
  imageNotAvailable: "Image not available",
  mermaidFormatMmd: "MMD",
  mermaidFormatPng: "PNG",
  mermaidFormatSvg: "SVG",
  openExternalLink: "Open external link?",
  openLink: "Open link",
  tableFormatCsv: "CSV",
  tableFormatMarkdown: "Markdown",
  // Tab-separated is what a spreadsheet takes into its cells; nobody outside software calls it TSV.
  tableFormatTsv: "For a spreadsheet",
  viewFullscreen: "View fullscreen",
};

/**
 * Built once. The renderer is memoised per message, and a new object on every render would have
 * every answer in the history parse its markdown again. The language is fixed for the page's life —
 * changing it reloads (`lib/i18n.ts`).
 */
export const markdownWords = Object.fromEntries(
  Object.entries(MARKDOWN_WORDS).map(([word, source]) => [word, t(source)]),
) as unknown as StreamdownTranslations;
