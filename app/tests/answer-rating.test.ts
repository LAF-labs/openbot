import { describe, expect, test } from "bun:test";
import {
  toVisibleChatItems,
  unsettledFrom,
} from "../src/components/channels/chat-messages";
import { ko } from "../src/lib/i18n-ko";
import {
  ANSWER_NOTE_MAX_LENGTH,
  ANSWER_RATING_REASONS,
  RATING_REFUSALS,
  RatingRefusedError,
  rateAnswer,
  ratingBody,
  readAnswerRatings,
} from "../src/lib/support/answer-ratings";
import { stubFetch } from "./support/fetch";

/**
 * 좋아요·아쉬워요's half of the promise: what leaves the browser, and what the screen reads back.
 *
 * What leaves is three keys at most — which way, a reason key, and what the person wrote — and
 * never the answer: the function that builds the body is not handed the answer to begin with, and
 * the body is serialised here to show there is nothing else in it. What comes back is the server's
 * record of the rating, and a refusal is a code this table says in Korean.
 */

const SERVER = new URL(
  "../../server/src/support/answer-ratings.ts",
  import.meta.url,
);

describe("what leaves the browser", () => {
  test("좋아요 is the rating and nothing else", () => {
    expect(ratingBody({ rating: "up", reason: null, note: "" })).toEqual({
      rating: "up",
    });
  });

  test("아쉬워요 carries the reason and the words, trimmed, and only those", () => {
    const body = ratingBody({
      rating: "down",
      reason: "wrong-facts",
      note: "  어제 매출이에요 \n",
    });
    expect(body).toEqual({
      rating: "down",
      reason: "wrong-facts",
      note: "어제 매출이에요",
    });
    expect(Object.keys(JSON.parse(JSON.stringify(body))).sort()).toEqual([
      "note",
      "rating",
      "reason",
    ]);
  });

  test("an empty note and no reason are left out rather than sent as nothing", () => {
    expect(ratingBody({ rating: "down", reason: null, note: "   " })).toEqual({
      rating: "down",
    });
  });

  test("is put against the answer it is about, and read back as the server kept it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const receipt = await rateAnswer(
      "channel 1",
      "msg/2",
      { rating: "down", reason: "too-slow", note: "오래 걸렸어요" },
      stubFetch(async (url, init) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        return new Response(
          JSON.stringify({
            id: "rating-1",
            messageId: "msg/2",
            rating: "down",
            reason: "too-slow",
            note: "오래 걸렸어요",
            updatedAt: "2026-09-18T09:00:00.000Z",
            told: ["support-webhook"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/support/ratings/channel%201/msg%2F2");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      rating: "down",
      reason: "too-slow",
      note: "오래 걸렸어요",
    });
    expect(receipt).toEqual({
      rating: "down",
      reason: "too-slow",
      note: "오래 걸렸어요",
      updatedAt: "2026-09-18T09:00:00.000Z",
      told: ["support-webhook"],
    });
  });

  test("a refusal is thrown as its code and this screen's sentence", async () => {
    const refused = (code: string, extra: object = {}) =>
      rateAnswer(
        "c",
        "m",
        { rating: "down", reason: null, note: "x" },
        stubFetch(
          async () =>
            new Response(JSON.stringify({ error: code, code, ...extra }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
        ),
      ).catch((error: unknown) => error);

    const tooLong = await refused("laf:rating_note_too_long", {
      limit: ANSWER_NOTE_MAX_LENGTH,
    });
    expect(tooLong).toBeInstanceOf(RatingRefusedError);
    expect((tooLong as RatingRefusedError).code).toBe(
      "laf:rating_note_too_long",
    );
    expect((tooLong as Error).message).toBe(
      "That is over 500 characters. Shorten it a little.",
    );

    // A code this screen has no words for still says something a person can act on.
    const unknown = await refused("laf:something_new");
    expect((unknown as Error).message).toBe("That did not save. Try again.");
  });
});

describe("what the screen reads back", () => {
  test("this conversation's ratings, by the answer they are about", async () => {
    const ratings = await readAnswerRatings(
      "channel-1",
      stubFetch(
        async () =>
          new Response(
            JSON.stringify({
              ratings: [
                {
                  messageId: "m-1",
                  rating: "up",
                  reason: null,
                  note: null,
                  updatedAt: "2026-09-18T09:00:00.000Z",
                },
                {
                  messageId: "m-2",
                  rating: "down",
                  reason: "not-as-asked",
                  note: "다른 걸 물어봤어요",
                  updatedAt: "2026-09-18T09:01:00.000Z",
                },
                // Nothing the screen could draw: dropped rather than drawn wrong.
                { messageId: "m-3", rating: "meh" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    expect(ratings).toEqual({
      "m-1": {
        rating: "up",
        reason: null,
        note: null,
        updatedAt: "2026-09-18T09:00:00.000Z",
      },
      "m-2": {
        rating: "down",
        reason: "not-as-asked",
        note: "다른 걸 물어봤어요",
        updatedAt: "2026-09-18T09:01:00.000Z",
      },
    });
  });

  test("a conversation the server cannot rate in is an error, so no control is drawn", async () => {
    await expect(
      readAnswerRatings(
        "channel-1",
        stubFetch(
          async () =>
            new Response(JSON.stringify({ code: "laf:not_found" }), {
              status: 404,
            }),
        ),
      ),
    ).rejects.toThrow();
  });
});

/**
 * Only a FINISHED answer can be rated. While a turn runs, everything after the person's last message
 * is still being written — a reply half-streamed, a second reply after a tool line — and a 좋아요 on
 * a sentence that is still growing is a rating of something nobody has read yet. Once the turn is
 * over, every answer in the conversation carries the controls, the newest included.
 */
describe("which answers carry the controls", () => {
  const items = toVisibleChatItems([
    { id: "q1", role: "user", content: "어제 매출은?" },
    { id: "a1", role: "assistant", content: "어제 매출은 98만 원이에요." },
    { id: "q2", role: "user", content: "오늘은?" },
    { id: "a2", role: "assistant", content: "오늘 매출은 1" },
  ]);
  const settled = (busy: boolean) =>
    items
      .filter(
        (item, index) =>
          item.kind === "text" &&
          item.role === "assistant" &&
          index < unsettledFrom(items, busy),
      )
      .map((item) => item.id);

  test("while a turn runs, the answers before the person's last message and none after it", () => {
    expect(settled(true)).toEqual(["a1"]);
  });

  test("once it is over, every answer", () => {
    expect(settled(false)).toEqual(["a1", "a2"]);
  });

  test("a turn running with nothing the person said yet leaves nothing to rate", () => {
    expect(
      unsettledFrom(
        toVisibleChatItems([
          { id: "a0", role: "assistant", content: "안녕하세요" },
        ]),
        true,
      ),
    ).toBe(0);
  });
});

describe("the words", () => {
  test("every refusal in the table has Korean", () => {
    const missing = Object.values(RATING_REFUSALS).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every code the rating route can refuse with", async () => {
    // Read out of the server's source rather than copied, so a code added there fails here until
    // somebody decides what it says in Korean.
    const source = await Bun.file(SERVER).text();
    // The refusals are the exported constants; a thrown internal error is the server's 500, not one.
    const codes = [
      ...source.matchAll(/export const [A-Z_]+ = "(laf:[a-z_]+)"/g),
    ].map((match) => match[1] as string);
    expect(codes.length).toBeGreaterThan(3);
    expect(codes.filter((code) => !(code in RATING_REFUSALS))).toEqual([]);
  });

  test("the reasons offered are the reasons the server takes", async () => {
    const source = await Bun.file(SERVER).text();
    const declared = source.match(/ANSWER_RATING_REASONS = \[([^\]]*)\]/)?.[1];
    expect(declared).toBeDefined();
    expect(
      [...(declared ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    ).toEqual([...ANSWER_RATING_REASONS]);
  });

  test("the note limit is the server's", async () => {
    const source = await Bun.file(SERVER).text();
    expect(source).toContain(
      `ANSWER_NOTE_MAX_LENGTH = ${ANSWER_NOTE_MAX_LENGTH};`,
    );
  });
});
