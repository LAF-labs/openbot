import { describe, expect, test } from "bun:test";
import type { NotificationRecord } from "../src/notifications/outbox";
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
      at: "2026-09-06T09:00:00.000Z",
    });
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
