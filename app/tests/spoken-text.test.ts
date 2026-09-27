/**
 * WHAT A SCREEN READER HEARS WHEN A REPLY ARRIVES.
 *
 * Found on the first-hour walk (2026-09-27): the hidden "답장: …" announcement was the reply's raw
 * text, so a voice read `**` aloud before every bold word and every pipe of a table.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spokenText } from "../src/lib/channels/spoken-text";

describe("a reply, as it is heard", () => {
  test("bold, headings, lists and quotes lose their marks and keep their words", () => {
    expect(
      spokenText(
        "## 손님 리뷰 답글 요령\n\n**먼저 감사**부터 말해요.\n- 짧게 쓰기\n1. 이름 부르기\n> 사과는 한 번만",
      ),
    ).toBe(
      "손님 리뷰 답글 요령\n먼저 감사부터 말해요.\n짧게 쓰기\n이름 부르기\n사과는 한 번만",
    );
  });

  test("a table is read cell by cell, and its rule is not read at all", () => {
    expect(
      spokenText(
        "| 상황 | 예시 답글 |\n|---|:---:|\n| 칭찬 | **감사합니다** |",
      ),
    ).toBe("상황, 예시 답글\n칭찬, 감사합니다");
  });

  test("a link is its words, and code keeps its text without the fence", () => {
    expect(
      spokenText("[기업마당](https://www.bizinfo.go.kr) 참고\n```\nabc\n```"),
    ).toBe("기업마당 참고\nabc");
    expect(spokenText("`경로`와 _기울임_")).toBe("경로와 기울임");
  });

  test("an asterisk that is not emphasis stays", () => {
    expect(spokenText("3 * 4 = 12")).toBe("3 * 4 = 12");
    expect(spokenText("snake_case_name")).toBe("snake_case_name");
  });

  test("the transcript's announcement goes through it", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/components/channels/chat-transcript.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /t\("Reply: \{text\}", \{ text: spokenText\(last\.text\)/,
    );
  });
});
