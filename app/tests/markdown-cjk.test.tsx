import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { markdownPlugins } from "../src/lib/markdown-plugins";

/**
 * EMPHASIS THAT ENDS AGAINST A KOREAN PARTICLE IS STILL EMPHASIS.
 *
 * MEASURED 2026-09-25: the Bot wrote `기온은 **23.5°**예요` and the chat drew both pairs of asterisks.
 * CommonMark lets a `**` preceded by punctuation close only before whitespace or punctuation, and a
 * Korean particle is neither. And in the chat's streaming mode, `*기울임*이다` grew a stray `*` at the
 * end: Streamdown's closer of unfinished markers (remend 1.3.0) took the second `*` for an
 * intraword one and "closed" the first. remend 1.3.1 counts it; the root `overrides` pins that.
 *
 * Rendered through Streamdown with the plugins the app passes, in the chat's streaming mode and in
 * the static mode the help and legal pages use.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

function render(markdown: string, mode: "streaming" | "static"): string {
  return renderToStaticMarkup(
    <Streamdown mode={mode} plugins={markdownPlugins}>
      {markdown}
    </Streamdown>,
  ).replace(/ (class|data-[a-z-]+|type)="[^"]*"/g, "");
}

const CASES: [markdown: string, expected: string][] = [
  ["기온은 **23.5°**예요", "<p>기온은 <span>23.5°</span>예요</p>"],
  ["**중요**합니다", "<p><span>중요</span>합니다</p>"],
  ["*기울임*이다", "<p><em>기울임</em>이다</p>"],
  ["*23.5°*예요", "<p><em>23.5°</em>예요</p>"],
  ["~~23.5°~~였어요", "<p><del>23.5°</del>였어요</p>"],
  ["**「중요」**합니다", "<p><span>「중요」</span>합니다</p>"],
];

describe("Korean emphasis", () => {
  for (const mode of ["streaming", "static"] as const) {
    for (const [markdown, expected] of CASES) {
      test(`${mode}: ${markdown}`, () => {
        const html = render(markdown, mode);
        expect(html).toContain(expected);
        expect(html).not.toContain("*");
        expect(html).not.toContain("~");
      });
    }
  }

  test("the emphasis still fails without the plugins, so the cases above test them", () => {
    const html = renderToStaticMarkup(
      <Streamdown mode="static">{"기온은 **23.5°**예요"}</Streamdown>,
    );
    expect(html).toContain("**23.5°**");
  });
});

describe("a URL next to Korean", () => {
  test("a bare URL followed by a space and a particle links the URL alone", () => {
    const html = render(
      "자세한 건 https://example.com/a?b=1 에서 확인하세요",
      "streaming",
    );
    expect(html).toContain(
      ">https://example.com/a?b=1</button> 에서 확인하세요",
    );
  });

  test("a named link followed by a particle links the name alone", () => {
    const html = render(
      "[여기](https://example.com)에서 확인하세요",
      "streaming",
    );
    expect(html).toContain(">여기</button>에서 확인하세요");
  });

  test("bold around a named link closes before a particle", () => {
    const html = render(
      "**[안내](https://example.com)**를 보세요",
      "streaming",
    );
    expect(html).toContain("</span>를 보세요");
    expect(html).not.toContain("*");
  });
});

describe("every renderer of markdown takes the plugins", () => {
  for (const file of [
    "components/channels/chat-transcript.tsx",
    "components/help/help-page.tsx",
    "components/legal/legal-page.tsx",
    "lib/markdown.tsx",
  ]) {
    test(file, () => {
      const source = read(file);
      const opened = source.match(/<Streamdown\b/g)?.length ?? 0;
      const withPlugins =
        source.match(/<Streamdown\b[^>]*plugins=\{markdownPlugins\}/g)
          ?.length ?? 0;
      expect(opened).toBeGreaterThan(0);
      expect(withPlugins).toBe(opened);
    });
  }
});
