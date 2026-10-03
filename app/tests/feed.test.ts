import { describe, expect, test } from "bun:test";
import { attachmentPartsOf } from "@shared/attachments";
import {
  FEED_QUOTE_MIME,
  feedQuotePart,
  feedQuotesOf,
  isFeedQuotePart,
  quotedPostId,
} from "@shared/feed";
import { PERSONAS } from "@shared/persona";
import { toVisibleChatItems } from "../src/components/channels/chat-messages";
import {
  FEED_REFUSALS,
  FEED_SKILL,
  FEED_TOPICS,
  feedInstruction,
  feedTopics,
} from "../src/lib/feed/queries";
import { ko } from "../src/lib/i18n-ko";
import { ROUTINE_REFUSALS } from "../src/lib/routines/queries";

/**
 * 소식'S TABLES, WALKED, AND THE QUOTE'S SHAPE (muse-shape plan §3.2, phase 7).
 *
 * The persona's default topics and the refusals are read through `t(variable)`, which
 * `i18n-coverage.test.ts` cannot see. And a post quoted into the conversation (이야기하기) travels as
 * a reference no file reader takes for a file, and is drawn from the message it rode in.
 */

const POST_ID = "feed_0f8c1c62-4bd6-4d2c-9a5b-1b7a3e0a9c11";

describe("소식's words", () => {
  test("every persona's default topics, every refusal, in Korean", () => {
    const keys = [
      ...Object.values(FEED_TOPICS).flat(),
      ...Object.values(FEED_REFUSALS),
      ROUTINE_REFUSALS["laf:routine_feed_exists"] ?? "",
    ];
    expect(keys.filter((key) => !ko[key])).toEqual([]);
  });

  test("every persona has topics, none the same list as the owner's but the unanswered and 기타", () => {
    for (const persona of PERSONAS) {
      expect(FEED_TOPICS[persona].length).toBeGreaterThanOrEqual(2);
    }
    expect(FEED_TOPICS.unknown).toEqual(FEED_TOPICS.other);
    expect(FEED_TOPICS.student).not.toEqual(FEED_TOPICS.owner);
  });

  test("a shop's own kind is named in the owner's first topic, and only the owner's", () => {
    expect(feedTopics("owner", "food")[0]).toBe(
      "News about my line of business (Restaurant or café)",
    );
    expect(feedTopics("student", "food")[0]).toBe("Exam and certificate dates");
    expect(feedTopics(null, null)).toEqual(FEED_TOPICS.unknown);
  });

  test("the instruction names the skill and puts one topic on each line, which the page reads back", () => {
    const text = feedInstruction(["업종 뉴스", "경제 뉴스"]);
    const [first, ...rest] = text.split("\n");
    expect(first).toContain(FEED_SKILL);
    expect(rest).toEqual(["- 업종 뉴스", "- 경제 뉴스"]);
    expect(
      ko[
        "Post today's updates the way the {skill} skill says, on these topics:"
      ],
    ).toContain("{skill}");
  });
});

describe("이야기하기: a post by its id", () => {
  test("the part is a reference no file reader takes, and names its post", () => {
    const part = feedQuotePart({ id: POST_ID, title: "배민 수수료" });
    expect(part).toEqual({
      type: "binary",
      mimeType: FEED_QUOTE_MIME,
      id: `feed:${POST_ID}`,
      filename: "배민 수수료",
    });
    expect(isFeedQuotePart(part)).toBe(true);
    expect(quotedPostId(part)).toBe(POST_ID);
    expect(attachmentPartsOf([part])).toEqual([]);
    // Only this shape: a bare id, another type, or a file is not a quote.
    expect(isFeedQuotePart({ ...part, id: POST_ID })).toBe(false);
    expect(isFeedQuotePart({ ...part, mimeType: "application/pdf" })).toBe(
      false,
    );
  });

  test("the message it rode in draws it above the words", () => {
    const part = feedQuotePart({ id: POST_ID, title: "배민 수수료" });
    const [item] = toVisibleChatItems([
      {
        id: "u-1",
        role: "user",
        content: [part, { type: "text", text: "우리 가게도 해당돼?" }],
      },
    ] as never);
    expect(item).toMatchObject({
      kind: "text",
      text: "우리 가게도 해당돼?",
      quotes: [part],
    });
    expect(feedQuotesOf("plain words")).toEqual([]);
  });
});
