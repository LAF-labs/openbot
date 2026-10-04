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
import {
  copiedHtml,
  copiedWords,
  NOT_THE_ANSWER,
  READ_ELEMENTS,
} from "../src/lib/channels/copied-reply";
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

/** Every element HTML has, to find out which of them the renderer lets an answer draw. */
const EVERY_HTML_ELEMENT =
  "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em embed fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strike strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track tt u ul var video wbr".split(
    " ",
  );

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
  /*
   * DRAWN WHOLE BY THE TIME `mount` HAS SETTLED. Measured 2026-10-04 over every answer in this file
   * and in `markdown-tilde.test.tsx`: the bubble read the same once `mount` had rendered and settled
   * as it did 120 ms later, where this used to wait. What still moves after that is the row's
   * arrival motion — opacity and a few pixels, outside the bubble.
   */
  const view = await mount(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTranscript busy={false} messages={messages} />
    </QueryClientProvider>,
  );
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
        // The one mark that stays: without it the sentence says the price is yesterday's too.
        "가격은 ~~어제~~ 오늘 기준이에요.",
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

  // Review, fifth round: a list may start at nought, and nought is a number.
  test("a list is numbered from where it is drawn from, nought included", async () => {
    expect(await words("0. 영\n1. 일")).toBe("0. 영\n1. 일");
    expect(await words("7. 일곱\n8. 여덟")).toBe("7. 일곱\n8. 여덟");
  });

  test("an item with more than a line keeps it under its first", async () => {
    expect(await words("1. 하나\n\n   이어지는 문단\n\n2. 둘")).toBe(
      "1. 하나\n   이어지는 문단\n2. 둘",
    );
  });

  /*
   * Drawn and copied, 2026-10-02. An item was read as one run of words, tidied the way words are:
   * the code under a numbered step lost its indentation and the table under one came out as `가나12`.
   */
  test("what a numbered step holds hangs under it as it is: code with its indentation, a table with its cells", async () => {
    expect(
      await words(
        [
          "1. 설정 파일을 만들어요:",
          "",
          "   ```python",
          "   def f(x):",
          "       if x:",
          "           return 1",
          "",
          "       return 0",
          "   ```",
          "",
          "   그리고 저장해요.",
          "",
          "2. 표도 있어요:",
          "",
          "   | 가 | 나 |",
          "   | --- | --- |",
          "   | 1 | 2 |",
          "",
          "3. 인용:",
          "",
          "   > 인용문",
          "",
          "   - 안쪽 하나",
          "     - 더 안쪽",
        ].join("\n"),
      ),
    ).toBe(
      [
        "1. 설정 파일을 만들어요:",
        "   def f(x):",
        "       if x:",
        "           return 1",
        "",
        "       return 0",
        "   그리고 저장해요.",
        "2. 표도 있어요:",
        "   가\t나",
        "   1\t2",
        "3. 인용:",
        "   인용문",
        "   - 안쪽 하나",
        "     - 더 안쪽",
      ].join("\n"),
    );
  });

  test("a footnote is its number in brackets and its line, without the renderer's heading or its arrow back", async () => {
    expect(
      await words(
        "가격은 올랐어요.[^1] 그리고 내렸어요.[^둘]\n\n[^1]: 통계청 자료.\n[^둘]: 한국은행 자료.",
      ),
    ).toBe(
      "가격은 올랐어요.[1] 그리고 내렸어요.[2]\n\n1. 통계청 자료.\n2. 한국은행 자료.",
    );
  });

  test("what the answer wrote as HTML reads as it is drawn: a power, a folded part", async () => {
    expect(
      await words(
        "물은 H<sub>2</sub>O 이고 넓이는 x<sup>2</sup>.\n\n<details><summary>더 보기</summary>숨은 내용</details>",
      ),
    ).toBe("물은 H2O 이고 넓이는 x^2.\n\n더 보기\n\n숨은 내용");
  });

  test("code is copied as it was written, line by line, without its fence or its label", async () => {
    expect(await words("```python\ndef f():\n    return 1\n```")).toBe(
      "def f():\n    return 1",
    );
  });

  test("an empty line of code is one empty line, and space at either end of a line stays", async () => {
    expect(await words("```text\n  앞 공백\n\n\n\t탭\n끝 공백  \n```")).toBe(
      "  앞 공백\n\n\n\t탭\n끝 공백  ",
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

  /*
   * Review, fourth round. The renderer links an address that is written out, and tidies it as it
   * does — a slash on the end, `http://` in front of `www.`, `mailto:` in front of a mail address —
   * so words and address compared as written were never the same, and each was copied twice.
   */
  test("an address that is written out is copied once", async () => {
    expect(
      await words(
        [
          "꺾쇠 안: <https://example.com>",
          "",
          "그대로 쓴 주소: https://example.com/a?b=1 그리고 www.example.org 입니다.",
          "",
          "메일은 <user@example.com> 또는 help@example.com 으로.",
          "",
          "[example.com](https://example.com) 과 [https://example.com/y](https://example.com/y)",
        ].join("\n"),
      ),
    ).toBe(
      [
        "꺾쇠 안: https://example.com",
        "그대로 쓴 주소: https://example.com/a?b=1 그리고 www.example.org 입니다.",
        "메일은 user@example.com 또는 help@example.com 으로.",
        "example.com 과 https://example.com/y",
      ].join("\n\n"),
    );
  });

  test("a mail address or a number behind a word is written the way somebody would type it", async () => {
    expect(
      await words(
        "[문의](mailto:help@example.com?subject=hello)는 메일로, [가게 전화](tel:010-1234-5678)는 전화로, [다른 곳](https://example.org/x)은 주소로.",
      ),
    ).toBe(
      "문의 (help@example.com)는 메일로, 가게 전화 (010-1234-5678)는 전화로, 다른 곳 (https://example.org/x)은 주소로.",
    );
  });

  /*
   * Review, sixth round — four more, and the end of waiting for them one at a time. What an answer
   * can draw is a list with an end: the renderer lets through the elements below and no others
   * (the last test of this group draws every HTML element to find out). Each is read on purpose.
   */
  test("the space inside a link's words is still between the words", async () => {
    expect(await words("앞[ 가운데 ](https://e.test/x)뒤")).toBe(
      "앞 가운데 (https://e.test/x) 뒤",
    );
  });

  test("a box somebody typed is a letter, and its item keeps its bullet", async () => {
    expect(
      await words("- ☑ 글자로 쓴 상자\n- [x] 진짜 상자\n- [ ] 빈 상자"),
    ).toBe("- ☑ 글자로 쓴 상자\n☑ 진짜 상자\n☐ 빈 상자");
  });

  test("a list of terms keeps each term on its line and its meaning under it", async () => {
    expect(
      await words(
        "<dl><dt>용어</dt><dd>뜻</dd><dt>둘째</dt><dd>둘째 뜻</dd></dl>",
      ),
    ).toBe("용어\n  뜻\n둘째\n  둘째 뜻");
  });

  test("an item that says its own number is that number, and the next one follows it", async () => {
    expect(
      await words('<ol start="3"><li value="8">여덟</li><li>아홉</li></ol>'),
    ).toBe("8. 여덟\n9. 아홉");
  });

  test("a quotation has its marks, and a reading stands beside what it reads", async () => {
    expect(
      await words(
        "그는 <q>좋아요</q>라고 했고, <ruby>漢字<rt>한자</rt></ruby>로 썼어요.",
      ),
    ).toBe("그는 “좋아요”라고 했고, 漢字(한자)로 썼어요.");
  });

  test("a cell that spans leaves its columns and its rows in place", async () => {
    expect(
      await words(
        [
          "<table>",
          '<tr><th colspan="2">가격</th><th>비고</th></tr>',
          '<tr><td rowspan="2">가</td><td>1</td><td>x</td></tr>',
          "<tr><td>2</td><td>y</td></tr>",
          "</table>",
        ].join(""),
      ),
    ).toBe("가격\t\t비고\n가\t1\tx\n\t2\ty");
  });

  test("what is struck out keeps its tildes: without them it reads as what the answer says", async () => {
    expect(await words("~~10,000원~~ 8,000원이에요.")).toBe(
      "~~10,000원~~ 8,000원이에요.",
    );
  });

  test("a cell that holds a list, and a term or an item standing by itself, keep their lines", async () => {
    expect(
      await words(
        "<table><tr><td><ul><li>가</li><li>나</li></ul></td><td>둘</td></tr></table>",
      ),
    ).toBe("- 가 - 나\t둘");
    expect(await words("<dt>용어</dt><dd>뜻</dd>\n\n<li>혼자</li>")).toBe(
      "용어\n\n뜻\n\n혼자",
    );
  });

  test("a link with no words is not on the screen, and not in the copy", async () => {
    expect(await words("앞 [](https://e.test/x) 뒤")).toBe("앞 뒤");
  });

  test("every element the renderer lets an answer draw is one that is read on purpose", async () => {
    const { Streamdown } = await import("streamdown");
    const { markdownPlugins } = await import("../src/lib/markdown-plugins");
    const { markdownComponents } = await import("../src/lib/markdown");
    const drawnElements = new Set<string>();
    // Each in the place it can stand: on its own, in a paragraph, in a list, in a table.
    const places = (tag: string) => [
      `<${tag}>x</${tag}>`,
      `<p>앞 <${tag}>x</${tag}> 뒤</p>`,
      `<ul><${tag}>x</${tag}></ul>`,
      `<table><${tag}><tr><${tag}>x</${tag}></tr></${tag}></table>`,
      `<table><tr><${tag}>x</${tag}></tr></table>`,
      `<a href="https://e.test/">x</a><img src="https://e.test/i.png" alt="x">`,
    ];
    for (const tag of EVERY_HTML_ELEMENT) {
      /*
       * Read the moment the render's `act` returns, with no wait after it. Measured 2026-10-04 for
       * each of these 119 tags: the host's whole HTML was the same then as after the 35 ms this
       * used to wait, and as after 235 ms — and the walk took 0.5 s instead of 6.
       */
      const view = await mount();
      await view.render(
        <div data-drawn="">
          <Streamdown components={markdownComponents} plugins={markdownPlugins}>
            {places(tag).join("\n\n")}
          </Streamdown>
        </div>,
      );
      for (const element of view.host.querySelectorAll("[data-drawn] *")) {
        // The renderer's own controls are taken off before anything is read.
        if (element.closest(NOT_THE_ANSWER)) continue;
        drawnElements.add(element.tagName.toLowerCase());
      }
      await unmountAll();
    }
    const unread = [...drawnElements].filter((tag) => !READ_ELEMENTS.has(tag));
    expect(unread.sort()).toEqual([]);
    // And the walk did draw things: an empty set would pass the line above for the wrong reason.
    expect(drawnElements.size).toBeGreaterThan(30);
  }, 120_000);

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

  test("a footnote keeps its number, and loses the link to a place that is not coming with it", async () => {
    const { body } = await drawn("가격은 올랐어요.[^1]\n\n[^1]: 통계청 자료.");
    const html = copiedHtml(body) ?? "";
    expect(html).toContain("<sup><a>1</a></sup>");
    expect(html).toContain("통계청 자료.");
    expect(html).not.toContain("↩");
    expect(html).not.toContain("Footnotes");
    expect(html).not.toContain('href="#');
  });

  test("code keeps its lines", async () => {
    const { body } = await drawn("```\na\n\n  b\n```");
    const html = copiedHtml(body) ?? "";
    const holder = document.createElement("div");
    holder.innerHTML = html;
    expect(holder.querySelector("pre")?.textContent).toBe("a\n\n  b");
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
