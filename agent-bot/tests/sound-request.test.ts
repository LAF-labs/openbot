import { describe, expect, test } from "bun:test";
import { toProviderMessages } from "../src/transcript";

/**
 * NOTHING IN A REQUEST THE PROVIDER REFUSES TO READ.
 *
 * Measured 2026-10-02 against the fleet's model (meta/muse-spark-1.3-contributor through
 * OpenRouter): a request whose text ends in the first half of an emoji is answered HTTP 400,
 * "Invalid request: unexpected end of hex escape" — and since the text is history by then, so is
 * every request of that conversation after it. A cut made by length puts one there (a mail's body
 * at 4,000 characters, a connected service's answer at 20,000); so can a vendor's own JSON.
 * `toProviderMessages` is the last door every message passes.
 */

const HALF = "😀".charAt(0);

type Sent = { role: string; content: unknown };

const sent = (transcript: unknown[]) =>
  toProviderMessages(transcript as never) as unknown as Sent[];

/** Every string anywhere in what would be sent. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringsOf);
  }
  return [];
}

describe("a conversation with half a character somewhere in it", () => {
  test("goes to the provider with the mark for one, in whichever message it was", () => {
    const messages = sent([
      { id: "s", role: "system", content: `규칙 ${HALF}` },
      { id: "u", role: "user", content: `붙여 넣은 말 ${HALF}` },
      {
        id: "a",
        role: "assistant",
        content: `끊긴 답 ${HALF}`,
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "tool_call", arguments: "{}" },
          },
        ],
      },
      {
        id: "t",
        role: "tool",
        toolCallId: "call-1",
        content: `${"가".repeat(20)}${HALF}`,
      },
    ]);
    expect(messages.map((message) => message.content)).toEqual([
      "규칙 �",
      "붙여 넣은 말 �",
      "끊긴 답 �",
      `${"가".repeat(20)}�`,
    ]);
    for (const text of stringsOf(messages)) {
      expect(text.isWellFormed()).toBe(true);
    }
    // What the provider's parser choked on: an escape for half a pair, in the body as it is sent.
    expect(JSON.stringify(messages)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  test("a message with a picture keeps the picture and has its words mended", () => {
    const [message] = sent([
      {
        id: "u",
        role: "user",
        content: [
          { type: "text", text: `이 사진 ${HALF}` },
          {
            type: "image",
            source: {
              type: "data",
              value: "aGVsbG8=",
              mimeType: "image/png",
            },
          },
        ],
      },
    ]);
    const parts = message?.content as { type: string; text?: string }[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.find((part) => part.type === "text")?.text).toBe("이 사진 �");
    expect(parts.some((part) => part.type === "image_url")).toBe(true);
  });

  test("sound text is sent as the very string it was", () => {
    const words = "가게 😀 👨‍👩‍👧 오늘 매출";
    const [user, tool] = sent([
      { id: "u", role: "user", content: words },
      { id: "t", role: "tool", toolCallId: "call-9", content: words },
    ]);
    expect(user?.content).toBe(words);
    expect(tool?.content).toBe(words);
  });
});
