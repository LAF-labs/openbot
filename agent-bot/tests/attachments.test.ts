import { describe, expect, test } from "bun:test";
import {
  type TranscriptMessage,
  toProviderMessages,
  userContentOf,
} from "../src/transcript";

/**
 * A person's message with a photo in it, as the provider is handed it.
 *
 * The server has already turned every attachment into text and a photo into an AG-UI `image` part
 * (`server/src/attachments/for-model.ts`). What is left here is the last step — OpenAI's `image_url`
 * — and the rule that a message without a picture is sent exactly as it always was.
 */

describe("a person's message, in the provider's shape", () => {
  test("words alone, and words in parts, are the same string they always were", () => {
    expect(userContentOf("안녕")).toBe("안녕");
    expect(
      userContentOf([
        { type: "text", text: "[첨부 표: 매출.xlsx · 9KB]" },
        { type: "text", text: "가장 많이 팔린 메뉴" },
      ]),
    ).toBe("[첨부 표: 매출.xlsx · 9KB]\n가장 많이 팔린 메뉴");
  });

  test("a photo goes as an image_url the model can see, in its place among the words", () => {
    const messages = toProviderMessages([
      {
        id: "m1",
        role: "user",
        content: [
          { type: "text", text: "[첨부 사진: 영수증.jpg · 47KB]" },
          {
            type: "image",
            source: { type: "data", value: "/9j/AAAA", mimeType: "image/jpeg" },
          },
          { type: "text", text: "이 영수증 합계 알려줘" },
        ],
      } as TranscriptMessage,
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "[첨부 사진: 영수증.jpg · 47KB]" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,/9j/AAAA" },
          },
          { type: "text", text: "이 영수증 합계 알려줘" },
        ],
      },
    ]);
  });

  test("a part nobody resolved is named, never stringified", () => {
    const content = userContentOf([
      {
        type: "image",
        source: { type: "data", value: "/9j/AAAA", mimeType: "image/jpeg" },
      },
      {
        type: "binary",
        mimeType: "application/pdf",
        id: "x",
        filename: "메뉴.pdf",
      },
    ] as Parameters<typeof userContentOf>[0]);
    expect(JSON.stringify(content)).not.toContain("[object Object]");
    expect(content).toContainEqual({ type: "text", text: "[binary]" });
  });
});
