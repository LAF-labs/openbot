/**
 * 인용해 답하기 under a Bot's answer: what it puts in the composer.
 *
 * Measured at 375 wide with touch: the button put "> 아침 브리핑" in the box with the caret on the
 * line under it. This holds the text; the press and the box are the browser's.
 */
import { describe, expect, test } from "bun:test";
import { quotedReply } from "../src/lib/channels/quote";
import { ko } from "../src/lib/i18n-ko";

describe("a quoted reply", () => {
  test("is the first line, as a quote, with a line to answer on", () => {
    expect(quotedReply("춘천은 오늘 구름많아요.\n내일은 맑아요.")).toBe(
      "> 춘천은 오늘 구름많아요.\n",
    );
  });

  test("without the marks the bubble drew", () => {
    expect(quotedReply("**9월 27일 (일) 아침 브리핑**\n\n오늘 날씨")).toBe(
      "> 9월 27일 (일) 아침 브리핑\n",
    );
    expect(quotedReply("\n## 손님 리뷰 답글 요령\n- 짧게")).toBe(
      "> 손님 리뷰 답글 요령\n",
    );
  });

  test("an answer with no words has nothing to quote, and the button has Korean", () => {
    expect(quotedReply("")).toBeNull();
    expect(quotedReply("\n  \n")).toBeNull();
    expect(ko["Quote in a reply"]).toBe("인용해 답하기");
  });
});
