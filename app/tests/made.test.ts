import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  cardsOn,
  MADE_CARD_SHELF,
  MADE_SHELVES,
  MARKDOWN_TABLE,
  madeCardTitle,
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
  shelvesDrawn,
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

  /*
   * 파일, since phase 8 (2026-10-02): what is listed is a file the Bot HANDED OVER with a file card,
   * not everything in its folder — the folder also holds what nobody was ever shown.
   */
  test("a file the Bot handed over is on the 파일 shelf, called what the file is called", () => {
    expect(shelfOf("showFile")).toBe("file");
    expect(cardsOn("file")).toEqual(["showFile"]);
    // The file's name, without the folders it sits in; a card has no title of its own.
    expect(madeCardTitle("showFile", { path: "보고서/9월 정산.csv" })).toBe(
      "9월 정산.csv",
    );
    expect(madeCardTitle("showFile", { path: "요약.md", title: "무시" })).toBe(
      "요약.md",
    );
    expect(madeCardTitle("showFile", {})).toBeNull();
    // Every other card is still called what the Bot called it, and never by a path it carried.
    expect(madeCardTitle("showNotice", { title: " 추석 휴무 안내 " })).toBe(
      "추석 휴무 안내",
    );
    expect(madeCardTitle("showNotice", { path: "x.csv" })).toBeNull();
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

  test("the + stems leave room to say what", () => {
    for (const starter of MADE_STARTERS) {
      expect(ko[starter.draft]?.endsWith(": ")).toBe(true);
    }
    expect(ko["Make this into a table: "]).toBe("표로 만들어 줘: ");
  });

  /*
   * The page's own rule, kept when the shelf arrived: no 파일 filter before there is a file to show
   * under it. Until phase 8 this test said 파일 was not a shelf at all.
   */
  test("파일 is a filter only once the Bot has handed over a file, and then it is the last one", () => {
    expect(ko[SHELF_LABELS.file]).toBe("파일");
    expect(shelvesDrawn(false)).toEqual(["all", "table", "checklist", "text"]);
    expect(shelvesDrawn(true)).toEqual([
      "all",
      "table",
      "checklist",
      "text",
      "file",
    ]);
    expect(ko[KIND_LABELS.showFile as string]).toBe("파일");
  });
});
