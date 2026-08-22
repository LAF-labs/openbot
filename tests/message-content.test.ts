import { describe, expect, test } from "bun:test";
import { textOf } from "../shared/message-content";

describe("what a message says when its content is not a string", () => {
  test("a plain string is itself", () => {
    expect(textOf("open the invoices page")).toBe("open the invoices page");
  });

  test("nothing is an empty string, not the word undefined", () => {
    expect(textOf(undefined)).toBe("");
    expect(textOf(null)).toBe("");
  });

  test("parts become their text, joined — never [object Object]", () => {
    expect(
      textOf([
        { type: "text", text: "이 사진 좀 봐줘" },
        { type: "text", text: "왼쪽 아래 숫자" },
      ]),
    ).toBe("이 사진 좀 봐줘\n왼쪽 아래 숫자");
    // The bug this exists for, spelled out, so nobody re-introduces the one-liner.
    expect(String([{ type: "text", text: "이 사진 좀 봐줘" }])).toBe(
      "[object Object]",
    );
  });

  test("every non-text part is named by its kind, so the question is not left empty", () => {
    expect(
      textOf([
        { type: "audio", source: { type: "url", value: "https://x/a.m4a" } },
        { type: "text", text: "이거 받아 적어줘" },
      ]),
    ).toBe("[audio]\n이거 받아 적어줘");
  });

  test("an image is named rather than dropped, so the question is not left empty", () => {
    expect(
      textOf([
        {
          type: "image",
          source: { type: "data", value: "iVBOR", mimeType: "image/png" },
        },
        { type: "text", text: "여기 뭐라고 쓰여 있어?" },
      ]),
    ).toBe("[image]\n여기 뭐라고 쓰여 있어?");
  });
});
