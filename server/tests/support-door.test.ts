import { describe, expect, test } from "bun:test";
import type {
  AnswerRatingFacts,
  NotificationRecord,
} from "../src/notifications/outbox";
import { answerRatingAlertBody } from "../src/support/answer-ratings";
import {
  createSupportWebhookAdapter,
  SUPPORT_DOOR,
  supportAlertBody,
} from "../src/support/feedback";

/**
 * The door a person's message leaves by, and the shape it leaves in.
 *
 * The receiver is the fleet's alert webhook — the same address `laf watch` posts its transitions
 * to — so the body has to be the shape that channel already reads: `text` for Slack and Telegram,
 * `content` for Discord, and a structured object for anything that parses. And the door has to
 * be for support rows ONLY: an operator's channel that got "a Bot is waiting on you" for every
 * approval on every deployment would be muted inside a week.
 */

const FACTS = {
  feedbackId: "feedback-1",
  text: "리뷰 요약이 어제부터 안 됩니다",
  route: "/channel/abc",
  failureCode: "laf:turn_rate_limited",
};

const RECORD: NotificationRecord = {
  id: "notification-1",
  kind: "support.feedback",
  botId: "",
  userId: "person-1",
  support: FACTS,
  createdAt: "2026-09-06T09:00:00.000Z",
  deliveredVia: [],
};

describe("the body", () => {
  test("is the fleet alert's shape: text, the same text as content, and the facts beside", () => {
    const body = supportAlertBody(
      FACTS,
      "https://kim.agent.laf-co.com",
      "2026-09-06T09:00:00.000Z",
    );

    expect(body.content).toBe(body.text);
    expect(body.text).toBe(
      [
        "[LAF] 문의·의견 · https://kim.agent.laf-co.com",
        "리뷰 요약이 어제부터 안 됩니다",
        "화면: /channel/abc · 마지막 실패: laf:turn_rate_limited",
      ].join("\n"),
    );
    expect(body.feedback).toEqual({
      id: "feedback-1",
      origin: "https://kim.agent.laf-co.com",
      text: "리뷰 요약이 어제부터 안 됩니다",
      route: "/channel/abc",
      failureCode: "laf:turn_rate_limited",
      diagnostics: null,
      at: "2026-09-06T09:00:00.000Z",
    });
  });

  test("says how much diagnostic detail the row holds, as counts, and where the rest is", () => {
    const stored = {
      feedbackId: "feedback-2",
      text: "봇이 답을 안 해요",
      diagnostics: { events: 12, failures: 5, failureCodes: 2, checksDown: 1 },
    };
    // A row read back is JSON: whatever else came to be stored beside the counts must not cross.
    (stored.diagnostics as Record<string, unknown>).events_detail = [
      { event: "run_failed", bot: "bot-owner-1" },
    ];
    const body = supportAlertBody(
      stored,
      "https://kim.agent.laf-co.com",
      "2026-09-06T09:00:00.000Z",
    );

    expect(body.text).toBe(
      [
        "[LAF] 문의·의견 · https://kim.agent.laf-co.com",
        "봇이 답을 안 해요",
        "진단 정보: 기록 12개 · 최근 실패 5번(2종) · 멈춘 검사 1개 — 전체는 VM의 laf_feedback feedback-2",
      ].join("\n"),
    );
    expect(body.feedback.diagnostics).toEqual({
      events: 12,
      failures: 5,
      failureCodes: 2,
      checksDown: 1,
    });
    expect(JSON.stringify(body)).not.toContain("bot-owner-1");
    expect(JSON.stringify(body)).not.toContain("run_failed");
  });

  test("says nothing about the screen when nothing was attached", () => {
    const body = supportAlertBody(
      { feedbackId: "f", text: "고맙습니다" },
      "https://kim.agent.laf-co.com",
      "2026-09-06T09:00:00.000Z",
    );
    expect(body.text).toBe(
      "[LAF] 문의·의견 · https://kim.agent.laf-co.com\n고맙습니다",
    );
    expect(body.feedback.route).toBeNull();
    expect(body.feedback.failureCode).toBeNull();
  });
});

describe("the door", () => {
  test("takes support rows and nothing else", () => {
    const door = createSupportWebhookAdapter({
      webhookUrl: "http://127.0.0.1:1/hook",
      origin: "x",
    });
    expect(door.name).toBe(SUPPORT_DOOR);
    expect(door.accepts?.("support.feedback")).toBe(true);
    expect(door.accepts?.("support.answer_rating")).toBe(true);
    for (const kind of [
      "approval.requested",
      "approval.expired",
      "run.needs_you",
      "run.finished",
      "run.failed",
    ] as const) {
      expect(door.accepts?.(kind)).toBe(false);
    }
  });

  test("posts the body and reports delivery on a 2xx", async () => {
    const received: Array<{ headers: string | null; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({
          headers: request.headers.get("content-type"),
          body: await request.json(),
        });
        return new Response("ok");
      },
    });
    try {
      const door = createSupportWebhookAdapter({
        webhookUrl: `http://127.0.0.1:${server.port}/hook`,
        origin: "https://kim.agent.laf-co.com",
        now: () => new Date("2026-09-06T09:00:00Z"),
      });
      expect(await door.deliver(RECORD)).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]?.headers).toBe("application/json");
      expect(received[0]?.body).toEqual(
        supportAlertBody(
          FACTS,
          "https://kim.agent.laf-co.com",
          "2026-09-06T09:00:00.000Z",
        ),
      );
    } finally {
      server.stop(true);
    }
  });

  test("a receiver that refused it is a message not taken", async () => {
    // Unlike the buzz webhook: Slack's 404 on a dead hook is exactly "nobody was told".
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("no_service", { status: 404 }),
    });
    try {
      const door = createSupportWebhookAdapter({
        webhookUrl: `http://127.0.0.1:${server.port}/hook`,
        origin: "x",
      });
      expect(await door.deliver(RECORD)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a dead address does not throw, and does not claim delivery", async () => {
    const door = createSupportWebhookAdapter({
      webhookUrl: "http://127.0.0.1:1/hook",
      origin: "x",
    });
    expect(await door.deliver(RECORD)).toBe(false);
  });

  test("a row with no facts on it is not posted", async () => {
    const door = createSupportWebhookAdapter({
      webhookUrl: "http://127.0.0.1:1/hook",
      origin: "x",
      fetchImpl: Object.assign(
        async () => {
          throw new Error("must not be called");
        },
        { preconnect: () => {} },
      ) as unknown as typeof fetch,
    });
    expect(await door.deliver({ ...RECORD, support: undefined })).toBe(false);
  });
});

/**
 * 아쉬워요 with a note, as the operator's channel receives it.
 *
 * The same three-part shape as a 문의·의견 message, so the channel that already reads those reads
 * this too. What it carries is the Bot, the reason, what the person wrote and the ids to find the
 * rest by — and never the answer: the facts it is built from have nowhere to hold one, and a row
 * read back with more on it than the facts is built field by field so the extra goes nowhere.
 */
describe("a rating the operator is told about", () => {
  const RATING: AnswerRatingFacts = {
    ratingId: "rating-1",
    channelId: "channel-1",
    messageId: "message-1",
    agentId: "bot-1",
    botName: "초롱",
    reason: "wrong-facts",
    note: "매출 숫자가 어제 것 같아요",
  };
  const ORIGIN = "https://kim.agent.laf-co.com";
  const AT = "2026-09-18T09:00:00.000Z";

  test("is the fleet alert's shape: the Bot, the reason, the note and the ids", () => {
    const body = answerRatingAlertBody(RATING, ORIGIN, AT);

    expect(body.content).toBe(body.text);
    expect(body.text).toBe(
      [
        "[LAF] 답변이 아쉬워요 · https://kim.agent.laf-co.com",
        "봇: 초롱 · 이유: 사실과 달라요",
        "매출 숫자가 어제 것 같아요",
        "평가 rating-1 · 대화 channel-1 · 메시지 message-1 (답변 내용은 싣지 않음)",
      ].join("\n"),
    );
    expect(body.rating).toEqual({
      id: "rating-1",
      origin: ORIGIN,
      rating: "down",
      reason: "wrong-facts",
      note: "매출 숫자가 어제 것 같아요",
      bot: { id: "bot-1", name: "초롱" },
      channelId: "channel-1",
      messageId: "message-1",
      at: AT,
    });
  });

  test("says so when no reason was chosen", () => {
    const body = answerRatingAlertBody({ ...RATING, reason: null }, ORIGIN, AT);
    expect(body.text.split("\n")[1]).toBe("봇: 초롱 · 이유: 고르지 않음");
    expect(body.rating.reason).toBeNull();
  });

  test("a row read back with more on it than its facts sends the facts alone", () => {
    const stored = {
      ...RATING,
      content: "오늘 매출은 1,234,000원입니다",
    } as AnswerRatingFacts;
    expect(
      JSON.stringify(answerRatingAlertBody(stored, ORIGIN, AT)),
    ).not.toContain("1,234,000");
  });

  test("goes out through the same door as a 문의·의견 message", async () => {
    const received: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push(await request.json());
        return new Response("ok");
      },
    });
    try {
      const door = createSupportWebhookAdapter({
        webhookUrl: `http://127.0.0.1:${server.port}/hook`,
        origin: ORIGIN,
        now: () => new Date(AT),
      });
      const record: NotificationRecord = {
        id: "notification-2",
        kind: "support.answer_rating",
        botId: "bot-1",
        userId: "person-1",
        channelId: "channel-1",
        rating: RATING,
        createdAt: AT,
        deliveredVia: [],
      };
      expect(await door.deliver(record)).toBe(true);
      expect(received).toEqual([answerRatingAlertBody(RATING, ORIGIN, AT)]);
      // And a rating row with its facts missing is not posted at all.
      expect(await door.deliver({ ...record, rating: undefined })).toBe(false);
      expect(received).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});
