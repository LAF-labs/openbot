import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { copiedHtml, copiedText } from "../src/lib/channels/copied-reply";
import { copyRich } from "../src/lib/clipboard";
import { mount, unmountAll } from "./support/mount";

/**
 * WHAT 복사 PUTS ON THE CLIPBOARD.
 *
 * Pressed on the running app, 2026-10-02: 복사 under an answer with a table wrote the Bot's raw
 * markdown — pipes, the `| --- |` rule, `**` around bold words — which is what then landed in
 * 카카오톡 or a document. The clipboard is never read here: what the page writes is caught on its way.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ANSWER = [
  "## 이번 주 **가격 비교**",
  "",
  "세 곳을 비교했어요. 자세한 내용은 [공지](https://example.com/notice)를 보세요.",
  "",
  "| 가게 | 가격 |",
  "| --- | ---: |",
  "| **가** | 1,200원 |",
  "| 나 | 1,350원 |",
  "",
  "- 가장 싼 곳: *가*",
  "* 배송비는 `별도`",
  "- [x] 가격 확인",
  "- [ ] 주문하기",
  "",
  "> 가격은 오늘 기준이에요.",
  "",
  "---",
  "",
  "```",
  "합계 = **그대로** | 둡니다",
  "```",
].join("\n");

describe("the words", () => {
  const words = copiedText(ANSWER);

  test("carry no mark that drew the answer", () => {
    // Outside the code block, which is copied as written.
    const outsideCode = words.split("합계")[0] ?? "";
    expect(outsideCode).not.toMatch(/\*\*|__|`|^#{1,6} |^>/m);
    expect(outsideCode).not.toContain("|");
    expect(outsideCode).not.toContain("---");
  });

  test("keep the shape: a heading's line, paragraphs, list markers, a checklist's boxes", () => {
    expect(words.split("\n")[0]).toBe("이번 주 가격 비교");
    expect(words).toContain("\n\n세 곳을 비교했어요.");
    expect(words).toContain("- 가장 싼 곳: 가");
    expect(words).toContain("- 배송비는 별도");
    expect(words).toContain("☑ 가격 확인");
    expect(words).toContain("☐ 주문하기");
    expect(words).toContain("가격은 오늘 기준이에요.");
  });

  test("a table is its cells with a tab between, which a spreadsheet takes into cells", () => {
    expect(words).toContain("가게\t가격\n가\t1,200원\n나\t1,350원");
  });

  /*
   * Pressed on the running app with the first version: the last row of a real answer had no closing
   * pipe — the renderer drew it as a row all the same — and the copied words kept its pipes.
   */
  test("a table is found as the renderer finds it: a row without its closing pipe, or with no outer pipes at all", () => {
    expect(
      copiedText(
        "| 요일 | 운동 |\n| --- | --- |\n| 월 | 달리기 5km |\n| 수 | 수영 30분",
      ),
    ).toBe("요일\t운동\n월\t달리기 5km\n수\t수영 30분");
    expect(copiedText("요일 | 운동\n--- | ---\n월 | 달리기\n\n끝이에요.")).toBe(
      "요일\t운동\n월\t달리기\n\n끝이에요.",
    );
    // A pipe in ordinary prose is not a table, and one escaped inside a cell is a pipe.
    expect(copiedText("A | B 중에 고르세요")).toBe("A | B 중에 고르세요");
    expect(copiedText("| 식 |\n| --- |\n| a \\| b |")).toBe("식\na | b");
  });

  /*
   * Codex, on the pull request, three places where the words did not follow what the renderer
   * draws.
   */
  test("a table whose rule has one hyphen a cell is a table, and a rule of the wrong width is not", () => {
    expect(copiedText("| A | B |\n| - | - |\n| x | y |")).toBe("A\tB\nx\ty");
    expect(copiedText("| A | B |\n|:-|-:|\n| x | y |")).toBe("A\tB\nx\ty");
    // One cell of rule under two of header: the renderer draws text, and so the words are text.
    expect(copiedText("A | B\n-\nx | y")).toBe("A | B\n-\nx | y");
  });

  test("a code block closes on a fence like the one that opened it, and on no other", () => {
    const four = [
      "````",
      "a",
      "```",
      "c **d**",
      "```",
      "````",
      "끝 **굵게**",
    ].join("\n");
    // The inner fences are code: they stay, and nothing between them loses a mark.
    expect(copiedText(four)).toBe("a\n```\nc **d**\n```\n끝 굵게");
    const tildes = ["~~~", "x `y`", "```", "~~~", "z"].join("\n");
    expect(copiedText(tildes)).toBe("x `y`\n```\nz");
    // A fence still open at the end keeps what was written under it.
    expect(copiedText("```js\nconst a = `b`;")).toBe("const a = `b`;");
  });

  test("punctuation the answer escaped is shown, not taken for a mark", () => {
    expect(copiedText("Use \\*\\* literally")).toBe("Use ** literally");
    expect(copiedText("가격은 \\_정가\\_ 그대로, \\# 은 번호")).toBe(
      "가격은 _정가_ 그대로, # 은 번호",
    );
    expect(copiedText("\\[대괄호\\] 와 \\`백틱\\`")).toBe("[대괄호] 와 `백틱`");
    expect(copiedText("**굵게 \\* 별**")).toBe("굵게 * 별");
    // A backslash before a letter is a backslash.
    expect(copiedText("C:\\Users\\kim")).toBe("C:\\Users\\kim");
  });

  /*
   * Looked for after that review, by reading the pass against what the renderer draws rather than
   * waiting to be told: the same kind of gap, in the places a model's answer actually reaches.
   */
  test("what is inside a code span is code: its stars and underscores are not marks", () => {
    expect(
      copiedText("거듭제곱은 `2 ** 3` 이고 이름은 `user_name_id` 예요."),
    ).toBe("거듭제곱은 2 ** 3 이고 이름은 user_name_id 예요.");
    expect(copiedText("``a ` b``")).toBe("a ` b");
    expect(copiedText("| 식 | 뜻 |\n| - | - |\n| `a \\| b` | 또는 |")).toBe(
      "식\t뜻\na | b\t또는",
    );
  });

  test("a heading underlined instead of marked, and one that closes its own marks", () => {
    expect(copiedText("이번 주 요약\n===\n\n내용이에요.")).toBe(
      "이번 주 요약\n\n내용이에요.",
    );
    expect(copiedText("## 가격 비교 ##\n내용")).toBe("가격 비교\n내용");
    // A line of equals signs under nothing is a line of equals signs.
    expect(copiedText("===")).toBe("===");
  });

  test("an entity is the character it stands for, and a backslash at a line's end is a line break", () => {
    expect(
      copiedText(
        "A &amp; B &lt;3 &gt; C&nbsp;D &quot;따옴표&quot; &#39;작은&#39;",
      ),
    ).toBe("A & B <3 > C D \"따옴표\" '작은'");
    expect(copiedText("첫 줄\\\n둘째 줄")).toBe("첫 줄\n둘째 줄");
  });

  test("a link keeps its address, since a chat box cannot hold one behind a word", () => {
    expect(words).toContain("공지 (https://example.com/notice)를 보세요.");
    expect(copiedText("[https://a.example](https://a.example)")).toBe(
      "https://a.example",
    );
    expect(copiedText("<https://a.example/x>")).toBe("https://a.example/x");
    expect(copiedText("![가게 사진](https://a.example/p.png)")).toBe(
      "가게 사진",
    );
  });

  test("code is copied as it was written, without its fence", () => {
    expect(words.endsWith("합계 = **그대로** | 둡니다")).toBe(true);
    expect(words).not.toContain("```");
  });

  test("no run of blank lines, and none at either end", () => {
    expect(words).not.toMatch(/\n{3,}/);
    expect(words).toBe(words.trim());
    expect(copiedText("")).toBe("");
  });

  test("an underscore inside a word, and a star that is multiplication, are left alone", () => {
    expect(copiedText("file_name_v2.csv 와 3 * 4 = 12")).toBe(
      "file_name_v2.csv 와 3 * 4 = 12",
    );
  });

  test("a nested list keeps its indent", () => {
    expect(copiedText("- 하나\n  - 둘\n    1. 셋")).toBe(
      "- 하나\n  - 둘\n    1. 셋",
    );
  });
});

describe("the answer as drawn", () => {
  test("keeps the table and the emphasis, and drops our controls and our styling", () => {
    const body = document.createElement("div");
    body.innerHTML = `
      <div class="wrapper" data-streamdown="table-wrapper">
        <div class="controls"><button title="표 복사"><svg></svg></button></div>
        <table class="w-full" style="color: red"><thead><tr><th class="x">가게</th><th>가격</th></tr></thead>
        <tbody><tr><td colspan="1"><strong class="font-semibold">가</strong></td><td>1,200원</td></tr></tbody></table>
      </div>
      <p class="mt-2">자세한 내용은 <a class="underline" href="https://example.com/notice" target="_blank" rel="noreferrer">공지</a>.</p>`;
    const html = copiedHtml(body) ?? "";
    expect(html).toContain("<table>");
    expect(html).toContain("<th>가게</th>");
    expect(html).toContain('<td colspan="1"><strong>가</strong></td>');
    expect(html).toContain('<a href="https://example.com/notice">공지</a>');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<svg");
    expect(html).not.toMatch(/class=|style=|data-|target=|rel=|title=/);
  });

  test("the bubble itself is left as it was", () => {
    const body = document.createElement("div");
    body.innerHTML = '<p class="keep"><button>x</button>글</p>';
    copiedHtml(body);
    expect(body.innerHTML).toBe('<p class="keep"><button>x</button>글</p>');
  });

  test("nothing drawn is nothing to hand over", () => {
    expect(copiedHtml(null)).toBeNull();
    expect(copiedHtml(undefined)).toBeNull();
    expect(copiedHtml(document.createElement("div"))).toBeNull();
  });
});

/** What the page writes, caught on its way to the clipboard. */
type Written =
  | { kind: "item"; types: Record<string, string> }
  | { kind: "text"; text: string };

function clipboard(options: { rich: boolean; refuseRich?: boolean }) {
  const written: Written[] = [];
  class Item {
    readonly parts: Record<string, Blob>;
    constructor(parts: Record<string, Blob>) {
      this.parts = parts;
    }
  }
  const fake = {
    writeText: async (text: string) => {
      written.push({ kind: "text", text });
    },
    ...(options.rich
      ? {
          write: async (items: Item[]) => {
            if (options.refuseRich) throw new Error("NotAllowedError");
            for (const item of items) {
              const types: Record<string, string> = {};
              for (const [type, blob] of Object.entries(item.parts)) {
                types[type] = await blob.text();
              }
              written.push({ kind: "item", types });
            }
          },
        }
      : {}),
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: fake,
  });
  const globals = globalThis as { ClipboardItem?: unknown };
  if (options.rich) globals.ClipboardItem = Item;
  else delete globals.ClipboardItem;
  return written;
}

describe("how it reaches the clipboard", () => {
  afterEach(() => {
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  });

  test("as one item with both, where the clipboard takes one", async () => {
    const written = clipboard({ rich: true });
    expect(await copyRich({ text: "가\t1", html: "<table></table>" })).toBe(
      true,
    );
    expect(written).toEqual([
      {
        kind: "item",
        types: { "text/plain": "가\t1", "text/html": "<table></table>" },
      },
    ]);
  });

  test("as words alone where it does not, or refuses", async () => {
    const plainOnly = clipboard({ rich: false });
    expect(await copyRich({ text: "가", html: "<p>가</p>" })).toBe(true);
    expect(plainOnly).toEqual([{ kind: "text", text: "가" }]);

    const refusing = clipboard({ rich: true, refuseRich: true });
    expect(await copyRich({ text: "나", html: "<p>나</p>" })).toBe(true);
    expect(refusing).toEqual([{ kind: "text", text: "나" }]);
  });

  test("and words alone when there is nothing drawn to send with them", async () => {
    const written = clipboard({ rich: true });
    expect(await copyRich({ text: "다", html: null })).toBe(true);
    expect(written).toEqual([{ kind: "text", text: "다" }]);
  });
});

describe("the button under a reply", () => {
  afterEach(async () => {
    await unmountAll();
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  });

  test("writes the words without their marks and the table as a table", async () => {
    const written = clipboard({ rich: true });
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { ChatTranscript } = await import(
      "../src/components/channels/chat-transcript"
    );
    const messages: Message[] = [
      { id: "u-1", role: "user", content: "가격 비교해 줘" },
      { id: "a-1", role: "assistant", content: ANSWER },
    ];
    const view = await mount(
      <QueryClientProvider client={new QueryClient()}>
        <ChatTranscript busy={false} messages={messages} />
      </QueryClientProvider>,
    );
    // The renderer is a lazy chunk: wait for the table it draws.
    const deadline = Date.now() + 8_000;
    while (!view.host.querySelector("table") && Date.now() < deadline) {
      await view.settle(50);
    }
    expect(view.host.querySelector("table")).not.toBeNull();

    const button = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy this reply"]',
    );
    if (!button) throw new Error("no copy button under the reply");
    await view.press(button);
    await view.settle(50);

    expect(written).toHaveLength(1);
    const item = written[0];
    if (item?.kind !== "item") throw new Error("not written as one item");
    expect(item.types["text/plain"]).toBe(copiedText(ANSWER));
    expect(item.types["text/plain"]).toContain("가게\t가격");
    const html = item.types["text/html"] ?? "";
    expect(html).toContain("<table>");
    expect(html).toContain("가게");
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/class=/);
  });
});
