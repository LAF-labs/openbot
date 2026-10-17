import { describe, expect, test } from "bun:test";
import {
  type BlockKeyInput,
  blockKeyAction,
  kindFromMarkdownStart,
  menuMatches,
  slashQuery,
} from "../src/components/docs/block-keys";
import { inlinePieces } from "../src/components/docs/inline-markdown";

/**
 * The document editor's keys (`components/docs/block-keys.ts`), apart from any screen: what Enter,
 * Backspace, the arrows and Escape do in a block, and — first of all — that a key the Korean input
 * method owns is never one of them.
 */

const key = (overrides: Partial<BlockKeyInput>): BlockKeyInput => ({
  key: "a",
  shift: false,
  mod: false,
  alt: false,
  composing: false,
  value: "",
  selectionStart: 0,
  selectionEnd: 0,
  kind: "paragraph",
  ...overrides,
});

describe("Enter", () => {
  test("splits the block at the caret: this one keeps the head, a new one takes the tail", () => {
    expect(
      blockKeyAction(
        key({
          key: "Enter",
          value: "견적서 보내기",
          selectionStart: 3,
          selectionEnd: 3,
        }),
      ),
    ).toEqual({ type: "split", head: "견적서", tail: " 보내기" });
  });

  test("with a selection, the selected text goes", () => {
    expect(
      blockKeyAction(
        key({
          key: "Enter",
          value: "abcdef",
          selectionStart: 2,
          selectionEnd: 4,
        }),
      ),
    ).toEqual({ type: "split", head: "ab", tail: "ef" });
  });

  test("while Korean is being assembled, it finishes the syllable and nothing else", () => {
    expect(
      blockKeyAction(
        key({
          key: "Enter",
          composing: true,
          value: "한",
          selectionStart: 1,
          selectionEnd: 1,
        }),
      ),
    ).toEqual({ type: "none" });
  });

  test("Shift+Enter is a line inside the block", () => {
    expect(
      blockKeyAction(key({ key: "Enter", shift: true, value: "a" })),
    ).toEqual({
      type: "none",
    });
  });

  test("in code, Enter is a line and ⌘/Ctrl+Enter leaves for a new block", () => {
    expect(
      blockKeyAction(key({ key: "Enter", kind: "code", value: "x" })),
    ).toEqual({
      type: "none",
    });
    expect(
      blockKeyAction(
        key({ key: "Enter", kind: "code", mod: true, value: "x" }),
      ),
    ).toEqual({ type: "split", head: "x", tail: "" });
  });

  test("in an empty list item it ends the list instead of making another", () => {
    expect(
      blockKeyAction(key({ key: "Enter", kind: "list", value: "" })),
    ).toEqual({
      type: "to-paragraph",
    });
    expect(
      blockKeyAction(
        key({
          key: "Enter",
          kind: "list",
          value: "a",
          selectionStart: 1,
          selectionEnd: 1,
        }),
      ),
    ).toEqual({
      type: "split",
      head: "a",
      tail: "",
    });
  });
});

describe("Backspace at the start", () => {
  test("an empty block goes", () => {
    expect(blockKeyAction(key({ key: "Backspace", value: "" }))).toEqual({
      type: "remove",
    });
  });

  test("a block with text joins the one above", () => {
    expect(blockKeyAction(key({ key: "Backspace", value: "뒤" }))).toEqual({
      type: "merge-up",
    });
  });

  test("a heading, list or check first turns back into a paragraph", () => {
    for (const kind of ["heading1", "list", "check", "quote"] as const) {
      expect(
        blockKeyAction(key({ key: "Backspace", kind, value: "x" })),
      ).toEqual({
        type: "to-paragraph",
      });
    }
  });

  test("anywhere else, or with a selection, or mid-syllable, it is the textarea's", () => {
    expect(
      blockKeyAction(
        key({
          key: "Backspace",
          value: "ab",
          selectionStart: 1,
          selectionEnd: 1,
        }),
      ),
    ).toEqual({ type: "none" });
    expect(
      blockKeyAction(
        key({
          key: "Backspace",
          value: "ab",
          selectionStart: 0,
          selectionEnd: 2,
        }),
      ),
    ).toEqual({ type: "none" });
    expect(
      blockKeyAction(key({ key: "Backspace", value: "", composing: true })),
    ).toEqual({
      type: "none",
    });
  });
});

describe("arrows and Escape", () => {
  test("up leaves only from the first line, down only from the last", () => {
    const value = "첫 줄\n둘째 줄";
    expect(
      blockKeyAction(
        key({ key: "ArrowUp", value, selectionStart: 2, selectionEnd: 2 }),
      ),
    ).toEqual({
      type: "focus-prev",
    });
    expect(
      blockKeyAction(
        key({ key: "ArrowUp", value, selectionStart: 6, selectionEnd: 6 }),
      ),
    ).toEqual({
      type: "none",
    });
    expect(
      blockKeyAction(
        key({ key: "ArrowDown", value, selectionStart: 6, selectionEnd: 6 }),
      ),
    ).toEqual({
      type: "focus-next",
    });
    expect(
      blockKeyAction(
        key({ key: "ArrowDown", value, selectionStart: 2, selectionEnd: 2 }),
      ),
    ).toEqual({
      type: "none",
    });
  });

  test("Escape stops writing", () => {
    expect(blockKeyAction(key({ key: "Escape" }))).toEqual({ type: "leave" });
  });
});

describe("markdown starts and the / menu", () => {
  test.each([
    ["# 제목", "heading1", "제목"],
    ["## 소제목", "heading2", "소제목"],
    ["- 할 것", "list", "할 것"],
    ["[] 확인", "check", "확인"],
    ["> 인용", "quote", "인용"],
    ["---", "divider", ""],
  ] as const)("%s becomes a %s", (typed, kind, rest) => {
    expect(kindFromMarkdownStart(typed)).toEqual({ kind, rest });
  });

  test("a dash in a sentence is a dash", () => {
    expect(kindFromMarkdownStart("가격 - 만원")).toBeNull();
  });

  test("the menu narrows by its Korean label or an alias, and a space closes it", () => {
    const labels: Record<string, string> = { heading2: "제목 2", table: "표" };
    const label = (kind: string) => labels[kind] ?? kind;
    expect(slashQuery("/표")).toBe("표");
    expect(menuMatches("표", label)).toEqual(["table"]);
    expect(menuMatches("h2", label)).toEqual(["heading2"]);
    expect(slashQuery("/ 표시")).toBeNull();
    expect(slashQuery("표")).toBeNull();
  });
});

describe("a block's one-line markdown", () => {
  test("bold, italic, code and a link become pieces; nothing becomes HTML", () => {
    expect(
      inlinePieces(
        "**굵게** 그리고 *기울임* `코드` [링크](https://laf.example) <b>x</b>",
      ),
    ).toEqual([
      { kind: "bold", text: "굵게" },
      { kind: "text", text: " 그리고 " },
      { kind: "italic", text: "기울임" },
      { kind: "text", text: " " },
      { kind: "code", text: "코드" },
      { kind: "text", text: " " },
      { kind: "link", text: "링크", href: "https://laf.example" },
      { kind: "text", text: " <b>x</b>" },
    ]);
  });

  test("a javascript: address is not a link", () => {
    expect(inlinePieces("[눌러](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[눌러](javascript:alert(1))" },
    ]);
  });

  test("snake_case and 2*3 stay as written", () => {
    expect(inlinePieces("file_name_here 2 * 3 * 4")).toEqual([
      { kind: "text", text: "file_name_here 2 * 3 * 4" },
    ]);
  });
});
