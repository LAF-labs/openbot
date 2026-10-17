import { describe, expect, test } from "bun:test";
import {
  type DocMarkdownBlock,
  docToMarkdown,
  markdownToBlocks,
} from "../../shared/hub/doc-markdown";
import { blockHash, cleanContent } from "../src/docs/blocks";

/** Drawn with markers and read back: the same blocks, ids and hashes. */
function roundTrip(blocks: DocMarkdownBlock[]) {
  const marked = blocks.map((block, index) => ({
    ...block,
    id: `b_${String(index).padStart(10, "0")}`,
    hash: blockHash(block),
  }));
  const markdown = docToMarkdown(marked);
  return { markdown, read: markdownToBlocks(markdown), marked };
}

const EVERY_KIND: [string, DocMarkdownBlock][] = [
  [
    "paragraph",
    {
      kind: "paragraph",
      text: "오늘 회의는 3시에 시작해요.\n둘째 줄도 있어요.",
      attrs: {},
    },
  ],
  ["heading1", { kind: "heading1", text: "4분기 계획", attrs: {} }],
  ["heading2", { kind: "heading2", text: "매출 목표", attrs: {} }],
  ["heading3", { kind: "heading3", text: "세부 항목", attrs: {} }],
  ["list", { kind: "list", text: "거래처에 견적 보내기", attrs: {} }],
  [
    "ordered list, indented",
    { kind: "list", text: "두 번째 단계", attrs: { ordered: true, indent: 2 } },
  ],
  ["check, open", { kind: "check", text: "세금계산서 발행", attrs: {} }],
  [
    "check, done, indented",
    { kind: "check", text: "입금 확인", attrs: { checked: true, indent: 1 } },
  ],
  ["quote", { kind: "quote", text: "손님이 먼저다.\n\n— 사장님", attrs: {} }],
  [
    "code",
    {
      kind: "code",
      text: "const 합계 = a + b;\n```\nnested fence",
      attrs: { lang: "ts" },
    },
  ],
  ["divider", { kind: "divider", text: "", attrs: {} }],
  [
    "table",
    {
      kind: "table",
      text: "",
      attrs: {
        rows: [
          ["품목", "수량"],
          ["사과 | 배", "3"],
          ["", "역슬래시 \\ 하나"],
        ],
      },
    },
  ],
  [
    "file",
    {
      kind: "file",
      text: "견적서 [최종].pdf",
      attrs: { fileId: "f_123e4567-e89b-12d3-a456-426614174000" },
    },
  ],
  [
    "task-link",
    { kind: "task-link", text: "11월 정산", attrs: { taskId: "t_abc" } },
  ],
];

describe("markdown with markers", () => {
  test.each(EVERY_KIND)("%s comes back as it went", (_name, block) => {
    const { read, marked } = roundTrip([block]);
    expect(read).toEqual([
      { ...block, id: marked[0]?.id ?? "", hash: marked[0]?.hash ?? "" },
    ]);
  });

  test("every kind in one document comes back in order", () => {
    const blocks = EVERY_KIND.map(([, block]) => block);
    const { read, markdown } = roundTrip(blocks);
    expect(
      read.map(({ kind, text, attrs }) => ({ kind, text, attrs })),
    ).toEqual(blocks);
    expect(markdown).toContain("| 사과 \\| 배 | 3 |");
    expect(markdown).toContain("````ts");
  });

  test.each([
    ["a heading's mark", "# 제목처럼 보이는 문단"],
    ["a list's mark", "- 목록처럼 보이는 문단"],
    ["a number and a dot", "1. 번호처럼 보이는 문단"],
    ["a quote's mark", "> 인용처럼 보이는 문단"],
    ["a table's bar", "| 표처럼 | 보이는 |"],
    ["a fence", "```"],
    ["a divider", "---"],
    ["a link to a file", "[견적](hub://file/f_1)"],
    ["a backslash", "\\ 역슬래시로 시작"],
    ["spaces before a list mark", "  - 들여쓴 목록처럼"],
    ["a marker", "<!-- b_0000000000 0123456789abcdef -->"],
  ])("a paragraph that starts with %s stays a paragraph", (_name, text) => {
    const block: DocMarkdownBlock = { kind: "paragraph", text, attrs: {} };
    const { read } = roundTrip([block]);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject(block);
  });

  test("a list item that starts with a box stays a list item", () => {
    const block: DocMarkdownBlock = {
      kind: "list",
      text: "[ ] 상자",
      attrs: {},
    };
    expect(roundTrip([block]).read[0]).toMatchObject(block);
  });

  test("a line inside a paragraph or code that reads as a marker does not cut the block", () => {
    const paragraph: DocMarkdownBlock = {
      kind: "paragraph",
      text: "위\n<!-- b_aaaaaaaaaa -->\n아래",
      attrs: {},
    };
    const code: DocMarkdownBlock = {
      kind: "code",
      text: "<!-- b_bbbbbbbbbb 0123456789abcdef -->",
      attrs: {},
    };
    const { read } = roundTrip([paragraph, code]);
    expect(read.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "paragraph", text: paragraph.text },
      { kind: "code", text: code.text },
    ]);
  });

  test("a paragraph whose later line looks like a list stays one block between markers", () => {
    const block: DocMarkdownBlock = {
      kind: "paragraph",
      text: "준비물\n- 노트북\n- 충전기",
      attrs: {},
    };
    expect(roundTrip([block]).read).toEqual([expect.objectContaining(block)]);
  });

  test("the marker carries the id and the hash", () => {
    const markdown = docToMarkdown([
      {
        id: "b_abcdefghij",
        hash: "0123456789abcdef",
        kind: "paragraph",
        text: "안녕",
        attrs: {},
      },
    ]);
    expect(markdown).toBe("<!-- b_abcdefghij 0123456789abcdef -->\n안녕");
  });
});

describe("markdown without markers", () => {
  test("is read the way a markdown reader reads it", () => {
    const read = markdownToBlocks(
      [
        "# 주간 보고",
        "",
        "이번 주에 한 일.",
        "두 줄짜리 문단.",
        "",
        "- 견적 보내기",
        "- [x] 입금 확인",
        "1. 첫째",
        "",
        "> 인용",
        "",
        "```",
        "code",
        "```",
        "",
        "| 이름 | 금액 |",
        "|---|---|",
        "| 김 | 1,000 |",
        "",
        "---",
      ].join("\n"),
    );
    expect(
      read.map(({ kind, text, attrs, id }) => ({ kind, text, attrs, id })),
    ).toEqual([
      { kind: "heading1", text: "주간 보고", attrs: {}, id: null },
      {
        kind: "paragraph",
        text: "이번 주에 한 일.\n두 줄짜리 문단.",
        attrs: {},
        id: null,
      },
      { kind: "list", text: "견적 보내기", attrs: {}, id: null },
      { kind: "check", text: "입금 확인", attrs: { checked: true }, id: null },
      { kind: "list", text: "첫째", attrs: { ordered: true }, id: null },
      { kind: "quote", text: "인용", attrs: {}, id: null },
      { kind: "code", text: "code", attrs: {}, id: null },
      {
        kind: "table",
        text: "",
        attrs: {
          rows: [
            ["이름", "금액"],
            ["김", "1,000"],
          ],
        },
        id: null,
      },
      { kind: "divider", text: "", attrs: {}, id: null },
    ]);
  });
});

describe("block content", () => {
  test("a saved block's hash does not change when nothing in it did", () => {
    const first = cleanContent({
      kind: "check",
      text: "입금",
      attrs: { checked: false, indent: 0 },
    });
    const again = cleanContent({ kind: "check", text: "입금", attrs: {} });
    if ("invalid" in first || "invalid" in again) throw new Error("refused");
    expect(blockHash(first)).toBe(blockHash(again));
    const ticked = cleanContent({
      kind: "check",
      text: "입금",
      attrs: { checked: true },
    });
    if ("invalid" in ticked) throw new Error("refused");
    expect(blockHash(ticked)).not.toBe(blockHash(first));
  });

  test.each([
    ["an unknown kind", { kind: "video", text: "", attrs: {} }, "kind"],
    [
      "a newline in a heading",
      { kind: "heading1", text: "a\nb", attrs: {} },
      "text",
    ],
    [
      "an attribute the kind does not take",
      { kind: "paragraph", text: "a", attrs: { checked: true } },
      "attrs",
    ],
    [
      "a file block with no file",
      { kind: "file", text: "a", attrs: {} },
      "attrs",
    ],
    [
      "a table cell with a newline",
      { kind: "table", text: "", attrs: { rows: [["a\nb"]] } },
      "attrs",
    ],
    ["text in a divider", { kind: "divider", text: "x", attrs: {} }, "text"],
    [
      "an indent of four",
      { kind: "list", text: "a", attrs: { indent: 4 } },
      "attrs",
    ],
  ])("refuses %s", (_name, input, field) => {
    expect(cleanContent(input)).toEqual({ invalid: field });
  });

  test("a table's rows are made as wide as the widest and its cells trimmed", () => {
    expect(
      cleanContent({
        kind: "table",
        text: "",
        attrs: { rows: [["a", " b "], ["c"]] },
      }),
    ).toEqual({
      kind: "table",
      text: "",
      attrs: {
        rows: [
          ["a", "b"],
          ["c", ""],
        ],
      },
    });
  });
});
