import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  cardsOn,
  MADE_CARD_SHELF,
  MADE_SHELVES,
  MARKDOWN_TABLE,
  markdownTableTitles,
  NOT_MADE,
  shelfOf,
} from "@shared/made";
import { ko } from "../src/lib/i18n-ko";
import {
  KIND_LABELS,
  MADE_REFUSALS,
  MADE_STARTERS,
  SHELF_LABELS,
  SHELF_ORDER,
} from "../src/lib/made/queries";

/**
 * 만든 것'S TABLES, WALKED (muse-shape plan §3.5, phase 6).
 *
 * The shelves, the kinds and the + button's stems are read through `t(variable)`, which
 * `i18n-coverage.test.ts` cannot see. And the one promise the table makes about the gallery: every
 * card is filed on purpose — as a thing the Bot made, on a shelf, or as not one.
 */

/** The gallery's card names, loaded as `owner-vocabulary.test.ts` loads them (no Vite glob here). */
const GALLERY_DIRECTORY = join(import.meta.dir, "../src/components/gallery");
const GALLERY_NAMES: string[] = [];
for (const entry of readdirSync(GALLERY_DIRECTORY)) {
  if (!entry.endsWith(".tsx")) continue;
  const module = (await import(join(GALLERY_DIRECTORY, entry))) as {
    GALLERY?: { name: string }[];
  };
  for (const component of module.GALLERY ?? []) {
    GALLERY_NAMES.push(component.name);
  }
}

describe("what counts as made", () => {
  test("every gallery card is filed: on a shelf, or named as not a thing the Bot made", () => {
    expect(GALLERY_NAMES.length).toBeGreaterThan(10);
    const unfiled = GALLERY_NAMES.filter(
      (name) => !(name in MADE_CARD_SHELF) && !NOT_MADE.includes(name),
    );
    expect(unfiled).toEqual([]);
    // And nothing is filed that the gallery does not have.
    for (const name of [...Object.keys(MADE_CARD_SHELF), ...NOT_MADE]) {
      expect(GALLERY_NAMES).toContain(name);
    }
  });

  test("a written table is a 표, and each shelf asks for its own cards", () => {
    expect(shelfOf(MARKDOWN_TABLE)).toBe("table");
    expect(shelfOf("askApproval")).toBeNull();
    expect(cardsOn("checklist")).toEqual(["showChecklist"]);
    expect(cardsOn("text")).toEqual(["showNotice"]);
    expect(cardsOn(null)).toHaveLength(Object.keys(MADE_CARD_SHELF).length);
  });
});

describe("a table's title, from what the Bot wrote over it", () => {
  test("a bold line or a heading names it", () => {
    expect(
      markdownTableTitles(
        "정리했어요.\n\n**메뉴 가격표**\n\n| 메뉴 | 가격 |\n|---|---|\n| 김치찌개 | 9,000원 |",
      ),
    ).toEqual(["메뉴 가격표"]);
    expect(
      markdownTableTitles(
        "## 주간 매출:\n| 요일 | 매출 |\n| :--- | ---: |\n| 월 | 1 |",
      ),
    ).toEqual(["주간 매출"]);
  });

  test("otherwise its header does, and a sentence above is not a title", () => {
    expect(
      markdownTableTitles(
        "지난주 것과 비교하면 이래요.\n\n| 품목 | 지난주 | 이번 주 |\n|---|---|---|\n| 참기름 | 1 | 2 |",
      ),
    ).toEqual(["품목 · 지난주 · 이번 주"]);
  });

  test("two tables are two things; a rule of dashes alone is not a table", () => {
    const text =
      "**A**\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n**B**\n| c | d |\n|---|---|\n| 3 | 4 |";
    expect(markdownTableTitles(text)).toEqual(["A", "B"]);
    expect(markdownTableTitles("위\n\n---\n\n아래")).toEqual([]);
  });

  test("a long title is clipped for the list", () => {
    const [title] = markdownTableTitles(
      `**${"가".repeat(120)}**\n| a | b |\n|---|---|`,
    );
    expect(title?.length).toBe(80);
    expect(title?.endsWith("…")).toBe(true);
  });
});

describe("the page's words, in Korean", () => {
  test("every shelf, every kind, every start and every refusal", () => {
    const keys = [
      ...SHELF_ORDER.map((shelf) => SHELF_LABELS[shelf]),
      ...Object.values(KIND_LABELS),
      ...MADE_STARTERS.flatMap((starter) => [starter.label, starter.draft]),
      ...Object.values(MADE_REFUSALS),
    ];
    expect(keys.filter((key) => !ko[key])).toEqual([]);
  });

  test("every shelf is drawn after 전체, and every made card has a kind", () => {
    expect(SHELF_ORDER).toEqual(["all", ...MADE_SHELVES]);
    for (const name of [...Object.keys(MADE_CARD_SHELF), MARKDOWN_TABLE]) {
      expect(KIND_LABELS[name]).toBeDefined();
    }
  });

  test("the + stems leave room to say what, and 파일 is not a shelf before phase 8", () => {
    for (const starter of MADE_STARTERS) {
      expect(ko[starter.draft]?.endsWith(": ")).toBe(true);
    }
    expect(ko["Make this into a table: "]).toBe("표로 만들어 줘: ");
    expect(Object.values(SHELF_LABELS)).not.toContain("Files");
  });
});
