import { describe, expect, test } from "bun:test";
import { plainTextOf, previewOf } from "../src/channels/preview";

describe("the roster preview of a markdown answer", () => {
  test("loses the marks and keeps the words", () => {
    expect(
      previewOf(
        "✅ 완료했습니다.\n\n**보고:**\n- **총 열람 횟수:** 20번\n- 제목: `Example Domain`\n\n> 결론\n\n## 제목\n1. 하나\n[링크](https://x)",
      ),
    ).toBe(
      "✅ 완료했습니다. 보고: 총 열람 횟수: 20번 제목: Example Domain 결론 제목 하나 링크",
    );
  });

  test("leaves arithmetic and lone asterisks alone", () => {
    expect(plainTextOf("2 * 3 = 6 and a_b_c")).toBe("2 * 3 = 6 and a_b_c");
  });

  test("caps at two hundred code points with an ellipsis", () => {
    const long = "가".repeat(300);
    const preview = previewOf(long);
    expect(Array.from(preview)).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });
});
