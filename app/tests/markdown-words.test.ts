import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultTranslations } from "streamdown";
import { ko } from "../src/lib/i18n-ko";
import { MARKDOWN_WORDS } from "../src/lib/markdown-words";

/**
 * THE MARKDOWN RENDERER'S OWN CONTROLS SPEAK KOREAN.
 *
 * Pressed on the running app, 2026-10-02: an answer with a table in it drew two icon buttons whose
 * only names were "Copy table" and "Download table", with "Markdown / CSV / TSV" under them — the
 * library's defaults. `i18n-coverage.test.ts` reads this app's source for literal `t("…")` and
 * cannot see a library's words, nor a table read through a variable; this walks both.
 */

const SRC = join(import.meta.dir, "../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the words the renderer draws by itself", () => {
  test("every one of them has Korean — the table is read through t(variable)", () => {
    const missing = Object.values(MARKDOWN_WORDS).filter(
      (source) => !(source in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every word this version of the renderer has, and no other", () => {
    // The type says so at build time; this says so when the installed version is not the typed one.
    expect(Object.keys(MARKDOWN_WORDS).sort()).toEqual(
      Object.keys(defaultTranslations).sort(),
    );
  });

  test("what a person reads on a table is not the library's English", () => {
    expect(ko[MARKDOWN_WORDS.copyTable]).toBe("표 복사");
    expect(ko[MARKDOWN_WORDS.downloadTable]).toBe("표 내려받기");
    expect(ko[MARKDOWN_WORDS.copyCode]).toBe("코드 복사");
    // Tab-separated is what a spreadsheet takes into its cells; it is named for that, not as TSV.
    expect(ko[MARKDOWN_WORDS.tableFormatTsv]).toBe("엑셀에 붙여 넣기");
    for (const word of [
      "copyTable",
      "copyTableAsCsv",
      "copyTableAsMarkdown",
      "copyTableAsTsv",
      "downloadTable",
      "downloadTableAsCsv",
      "downloadTableAsMarkdown",
      "copyCode",
      "downloadFile",
    ] as const) {
      expect(ko[MARKDOWN_WORDS[word]]).toMatch(/[가-힣]/);
    }
  });

  test("every place that draws the renderer hands it these words", async () => {
    const drawing: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const source = await Bun.file(path).text();
      const drawn = source.match(/<Streamdown\b/g)?.length ?? 0;
      if (drawn === 0) continue;
      drawing.push(path.slice(SRC.length + 1));
      const handed =
        source.match(/translations=\{markdownWords\}/g)?.length ?? 0;
      expect({ path, handed }).toEqual({ path, handed: drawn });
    }
    // The transcript, tool results, the help page and the legal pages. A fifth is welcome here.
    expect(drawing.length).toBeGreaterThanOrEqual(4);
  });
});
