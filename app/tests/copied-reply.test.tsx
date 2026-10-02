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
import { copiedHtml, copiedWords } from "../src/lib/channels/copied-reply";
import { copyRich } from "../src/lib/clipboard";
import { mount, unmountAll } from "./support/mount";

/**
 * WHAT 복사 PUTS ON THE CLIPBOARD.
 *
 * Pressed on the running app, 2026-10-02: 복사 under an answer with a table wrote the Bot's raw
 * markdown — pipes, the `| --- |` rule, `**` around bold words — which is what then landed in
 * 카카오톡 or a document. The clipboard is never read here: what the page writes is caught on its way.
 *
 * EVERY CASE IS DRAWN BY THE REAL RENDERER FIRST. The words are read off the bubble, so what a test
 * holds this to is "what was drawn", for the constructs a second reading of markdown got wrong:
 * the first two versions took the marks off with a pass of their own, and two rounds of review
 * found seven places where it disagreed with the renderer.
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
afterEach(async () => {
  await unmountAll();
  delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
});

/** The answer, drawn in a transcript by the renderer the app uses, and the bubble it is in. */
async function drawn(markdown: string) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ChatTranscript } = await import(
    "../src/components/channels/chat-transcript"
  );
  const messages: Message[] = [
    { id: "u-1", role: "user", content: "물어본 것" },
    { id: "a-1", role: "assistant", content: markdown },
  ];
  const view = await mount(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTranscript busy={false} messages={messages} />
    </QueryClientProvider>,
  );
  await view.settle(120);
  const body = [
    ...view.host.querySelectorAll('[data-slot="bubble-content"]'),
  ].at(-1);
  if (!body) throw new Error("no reply drawn");
  return { view, body };
}

const words = async (markdown: string) =>
  copiedWords((await drawn(markdown)).body);

describe("the words, read off what was drawn", () => {
  test("carry no mark, and keep the shape: a heading, paragraphs, a link with its address", async () => {
    const copied = await words(
      [
        "## 이번 주 **가격 비교**",
        "",
        "세 곳을 *비교*했어요. 자세한 내용은 [공지](https://example.com/notice)를 보세요.",
        "",
        "> 가격은 ~~어제~~ 오늘 기준이에요.",
        "",
        "---",
        "",
        "끝이에요.",
      ].join("\n"),
    );
    expect(copied).toBe(
      [
        "이번 주 가격 비교",
        "",
        "세 곳을 비교했어요. 자세한 내용은 공지 (https://example.com/notice)를 보세요.",
        "",
        "가격은 어제 오늘 기준이에요.",
        "",
        "끝이에요.",
      ].join("\n"),
    );
  });

  test("a table is its cells with a tab between, which a spreadsheet takes into cells", async () => {
    expect(
      await words(
        "| 가게 | 가격 |\n| --- | ---: |\n| **가** | 1,200원 |\n| 나 | 1,350원 |",
      ),
    ).toBe("가게\t가격\n가\t1,200원\n나\t1,350원");
  });

  test("lists keep their markers and their indent, and a checklist its boxes", async () => {
    expect(
      await words(
        [
          "- 하나",
          "  - 둘",
          "",
          "3. 셋째",
          "4. 넷째",
          "",
          "- [x] 가격 확인",
          "- [ ] 주문하기",
        ].join("\n"),
      ),
    ).toBe(
      [
        "- 하나",
        "  - 둘",
        "",
        "3. 셋째",
        "4. 넷째",
        "",
        "☑ 가격 확인",
        "☐ 주문하기",
      ].join("\n"),
    );
  });

  test("an item with more than a line keeps it under its first", async () => {
    expect(await words("1. 하나\n\n   이어지는 문단\n\n2. 둘")).toBe(
      "1. 하나\n   이어지는 문단\n2. 둘",
    );
  });

  test("code is copied as it was written, line by line, without its fence or its label", async () => {
    expect(await words("```python\ndef f():\n    return 1\n```")).toBe(
      "def f():\n    return 1",
    );
  });

  test("an image is its description, and a line break is a line break", async () => {
    expect(await words("![가게 사진](https://a.example/p.png)")).toBe(
      "가게 사진",
    );
    expect(await words("첫 줄  \n둘째 줄")).toBe("첫 줄\n둘째 줄");
  });

  /*
   * The seven a pass over the markdown got wrong, found by review over two rounds. Each is drawn by
   * the renderer here, so the words follow whatever it decides a mark is.
   */
  test("a table whose rule has one hyphen a cell, and a row without its closing pipe", async () => {
    expect(await words("| A | B |\n| - | - |\n| x | y |")).toBe("A\tB\nx\ty");
    expect(
      await words(
        "| 요일 | 운동 |\n| --- | --- |\n| 월 | 달리기 |\n| 수 | 수영 30분",
      ),
    ).toBe("요일\t운동\n월\t달리기\n수\t수영 30분");
  });

  test("a fence inside a longer fence is code, and so is what follows it", async () => {
    expect(await words("````\na\n```\nc **d**\n````\n\n끝 **굵게**")).toBe(
      "a\n```\nc **d**\n\n끝 굵게",
    );
  });

  test("punctuation the answer escaped is shown, and a star with space round it is a star", async () => {
    expect(await words("Use \\*\\* literally")).toBe("Use ** literally");
    // Two of them, so the renderer's own completing of an unfinished answer leaves them be: it
    // closes an odd `**` by adding one, on screen too, which is its to fix and not copied away.
    expect(await words("거듭제곱은 2 ** 3 이고 4 ** 5 예요")).toBe(
      "거듭제곱은 2 ** 3 이고 4 ** 5 예요",
    );
    expect(await words("파일은 file_name_v2.csv 예요")).toBe(
      "파일은 file_name_v2.csv 예요",
    );
  });

  test("what is inside a code span is code: its stars and underscores stay", async () => {
    expect(await words("식은 `2 ** 3` 이고 이름은 `user_name_id` 예요.")).toBe(
      "식은 2 ** 3 이고 이름은 user_name_id 예요.",
    );
  });

  test("an indented block of code keeps its lines and their indent to each other", async () => {
    expect(
      await words("이렇게요:\n\n    if (ready) {\n      run();\n    }"),
    ).toBe("이렇게요:\n\nif (ready) {\n  run();\n}");
  });

  test("a heading underlined instead of marked, and an entity, read as they are drawn", async () => {
    expect(await words("이번 주 요약\n===\n\nA &amp; B &lt;3")).toBe(
      "이번 주 요약\n\nA & B <3",
    );
  });

  test("the renderer's own controls are not the answer", async () => {
    const copied = await words("| A |\n| - |\n| x |\n\n```\ncode\n```");
    expect(copied).toBe("A\nx\n\ncode");
    expect(copied).not.toMatch(/Copy|Download|fullscreen/);
  });
});

describe("the answer as drawn", () => {
  test("keeps the table and the emphasis, and drops our controls and our styling", async () => {
    const { body } = await drawn(
      "| 가게 | 가격 |\n| --- | --- |\n| **가** | 1,200원 |\n\n자세한 내용은 [공지](https://example.com/notice).",
    );
    const html = copiedHtml(body) ?? "";
    expect(html).toContain("<table>");
    expect(html).toContain("<th>가게</th>");
    // The renderer draws bold as a styled span; it leaves here as bold.
    expect(html).toContain("<td><strong>가</strong></td>");
    expect(html).toContain('<a href="https://example.com/notice">공지</a>');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<svg");
    expect(html).not.toMatch(/class=|style=|data-|target=|rel=|title=|node=/);
  });

  test("code keeps its lines", async () => {
    const { body } = await drawn("```\na\n  b\n```");
    const html = copiedHtml(body) ?? "";
    const holder = document.createElement("div");
    holder.innerHTML = html;
    expect(holder.querySelector("pre")?.textContent).toBe("a\n  b");
  });

  test("the bubble itself is left as it was", async () => {
    const { body } = await drawn("**굵게** 와 표\n\n| A |\n| - |\n| x |");
    const before = body.innerHTML;
    copiedHtml(body);
    copiedWords(body);
    expect(body.innerHTML).toBe(before);
  });

  test("nothing drawn is nothing to hand over", () => {
    expect(copiedHtml(null)).toBeNull();
    expect(copiedHtml(undefined)).toBeNull();
    expect(copiedHtml(document.createElement("div"))).toBeNull();
    expect(copiedWords(document.createElement("div"))).toBe("");
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
  test("writes the words without their marks and the table as a table", async () => {
    const written = clipboard({ rich: true });
    const { view, body } = await drawn(
      "세 곳을 **비교**했어요.\n\n| 가게 | 가격 |\n| --- | --- |\n| 가 | 1,200원 |",
    );
    const button = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy this reply"]',
    );
    if (!button) throw new Error("no copy button under the reply");
    await view.press(button);
    await view.settle(50);

    expect(written).toHaveLength(1);
    const item = written[0];
    if (item?.kind !== "item") throw new Error("not written as one item");
    expect(item.types["text/plain"]).toBe(
      "세 곳을 비교했어요.\n\n가게\t가격\n가\t1,200원",
    );
    expect(item.types["text/plain"]).toBe(copiedWords(body));
    const html = item.types["text/html"] ?? "";
    expect(html).toContain("<table>");
    expect(html).toContain("<strong>비교</strong>");
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/class=/);
  });
});
