import { describe, expect, test } from "bun:test";
import { channelName } from "../src/channels/conversations";
import { plainTextOf, previewOf } from "../src/channels/preview";

describe("the roster preview of a markdown answer", () => {
  test("a long body costs the same as a short one", () => {
    /*
     * The marks come off a WINDOW, not the whole text. Stripping runs regexes with a lazy inner
     * match, so on a line of ` _aaaa…` every mark start opens a scan to end-of-line for a closer
     * that never comes: measured before the window, 21 KB took 29 ms and 85 KB took 275 ms, and
     * the route accepted a megabyte. One request held the whole process.
     */
    const nasty = ` _${"a".repeat(20)}`.repeat(20_000);
    const started = performance.now();
    previewOf(nasty);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("loses the marks and keeps the words", () => {
    expect(
      previewOf(
        "✅ 완료했습니다.\n\n**보고:**\n- **총 열람 횟수:** 20번\n- 제목: `Example Domain`\n\n> 결론\n\n## 제목\n1. 하나\n[링크](https://x)",
      ),
    ).toBe(
      "✅ 완료했습니다. 보고: 총 열람 횟수: 20번 제목: Example Domain 결론 제목 하나 링크",
    );
  });

  test("leaves arithmetic and identifiers alone", () => {
    expect(plainTextOf("2 * 3 = 6 and a_b_c")).toBe("2 * 3 = 6 and a_b_c");
  });

  test("strips emphasis that closes straight into a Korean particle", () => {
    expect(plainTextOf("저는 **일상 비서**이며, _일상 업무_를 돕습니다.")).toBe(
      "저는 일상 비서이며, _일상 업무_를 돕습니다.",
    );
    expect(plainTextOf("~~취소~~된 건")).toBe("취소된 건");
  });

  test("a cut never ends the line on half a flag, a family or a skin tone", () => {
    // Each of these is one character to a person and several code points. Cut by code points, the
    // line ended on `🇰` — a letter in a box — where the flag had been. (Upstream OpenBot #455.)
    for (const mark of ["🇰🇷", "👨‍👩‍👧", "👍🏽"]) {
      const preview = previewOf(`${"가".repeat(198)}${mark} 끝`);
      expect(preview).toBe(`${"가".repeat(198)}…`);
      expect(Array.from(preview).length).toBeLessThanOrEqual(200);
    }
    // One that fits is kept whole.
    expect(previewOf(`${"가".repeat(190)}🇰🇷`)).toBe(`${"가".repeat(190)}🇰🇷`);
  });

  test("caps at two hundred code points with an ellipsis", () => {
    const long = "가".repeat(300);
    const preview = previewOf(long);
    expect(Array.from(preview)).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("a conversation's name on a roster row", () => {
  test("is cut between characters as they are seen, and left alone when it fits", () => {
    expect(channelName(["새벽"])).toBe("새벽");
    const name = channelName([`${"가".repeat(118)}🇰🇷`, "뒤"]);
    expect(name).toBe(`${"가".repeat(118)}…`);
    expect(Array.from(name).length).toBeLessThanOrEqual(120);
  });
});
