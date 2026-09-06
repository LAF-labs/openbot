import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type {
  EnqueueInput,
  NotificationOutbox,
  NotificationRecord,
} from "../src/notifications/outbox";
import {
  FEEDBACK_MAX_LENGTH,
  type FeedbackInput,
  type FeedbackStore,
} from "../src/support/feedback";
import { createSupportRoutes } from "../src/support/routes";

/**
 * `POST /api/support/feedback`, as the browser reaches it.
 *
 * Two things only the route can get wrong. What it KEEPS from the body — the box promises "this
 * screen's address and the last failure code", and a route that copied the body into the row would
 * keep whatever a client sent under any key, screenshot included. And what it SAYS back: 보냈습니다
 * on the surface is a reading of these three facts, so the facts have to be there.
 */

const PERSON = {
  id: "owner-user",
  email: "owner@laf.test",
  role: "user",
} as const;

function surface(options: { outbox?: boolean; told?: string[] } = {}) {
  const rows: AuditEventInput[] = [];
  const kept: FeedbackInput[] = [];
  const written: EnqueueInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const feedback: FeedbackStore = {
    record: async (input) => {
      kept.push(input);
      return { id: "feedback-1", createdAt: new Date("2026-09-06T09:00:00Z") };
    },
  };
  const outbox: NotificationOutbox = {
    enqueue: async (input) => {
      written.push(input);
      return {
        id: "notification-1",
        kind: input.kind,
        botId: input.botId,
        userId: input.userId,
        ...(input.support ? { support: input.support } : {}),
        createdAt: "2026-09-06T09:00:00.000Z",
        deliveredVia: options.told ?? [],
      } satisfies NotificationRecord;
    },
    list: async () => [],
    markSeen: async () => true,
    markSeenForApproval: async () => 0,
  };
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", PERSON);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/api/support",
    createSupportRoutes(
      {
        feedback,
        auditStore,
        ...(options.outbox === false ? {} : { outbox }),
      },
      requireUser,
    ),
  );
  return { app, rows, kept, written };
}

const post = (app: Hono<{ Variables: AppVariables }>, body: unknown) =>
  app.request("/api/support/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("what the route keeps", () => {
  test("the words, and nothing about the screen unless the box was ticked", async () => {
    const { app, kept } = surface();
    const response = await post(app, {
      text: "  리뷰 요약이 어제부터 안 됩니다  ",
    });

    expect(response.status).toBe(201);
    expect(kept).toEqual([
      { userId: PERSON.id, text: "리뷰 요약이 어제부터 안 됩니다" },
    ]);
  });

  test("the screen's path and the last failure code, when it was", async () => {
    const { app, kept, written } = surface();
    await post(app, {
      text: "여기서 멈춥니다",
      screen: {
        route: "/channel/abc-123?tab=screen#bottom",
        failureCode: "laf:turn_rate_limited",
      },
    });

    // The path alone: a query string is where a client would put something it should not.
    expect(kept[0]?.route).toBe("/channel/abc-123");
    expect(kept[0]?.failureCode).toBe("laf:turn_rate_limited");
    expect(written[0]?.support).toEqual({
      feedbackId: "feedback-1",
      text: "여기서 멈춥니다",
      route: "/channel/abc-123",
      failureCode: "laf:turn_rate_limited",
    });
  });

  test("a screenshot, a transcript or a Bot's answer sent under any key goes nowhere", async () => {
    const { app, kept, written, rows } = surface();
    const secret = "the-thing-that-must-not-be-kept";
    await post(app, {
      text: "안 됩니다",
      screenshot: `data:image/png;base64,${secret}`,
      messages: [{ role: "assistant", content: secret }],
      screen: {
        route: "/channel/abc",
        failureCode: "laf:turn_failed",
        transcript: secret,
        html: secret,
      },
    });

    const everything = JSON.stringify({ kept, written, rows });
    expect(everything).not.toContain(secret);
    expect(kept[0]).toEqual({
      userId: PERSON.id,
      text: "안 됩니다",
      route: "/channel/abc",
      failureCode: "laf:turn_failed",
    });
  });

  test("a route that is not a path, and a failure code that is not a code, are dropped", async () => {
    const { app, kept } = surface();
    await post(app, {
      text: "x",
      screen: {
        route: "https://evil.example/steal?session=abc",
        failureCode:
          "Unable to connect. Is the computer able to access the url?",
      },
    });

    expect(kept[0]).toEqual({ userId: PERSON.id, text: "x" });
  });
});

describe("what the route refuses", () => {
  test("nothing written, with a code", async () => {
    const { app, kept } = surface();
    const response = await post(app, { text: "   " });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "laf:feedback_empty" });
    expect(kept).toEqual([]);
  });

  test("more than the limit, naming the limit", async () => {
    const { app, kept } = surface();
    const response = await post(app, {
      text: "가".repeat(FEEDBACK_MAX_LENGTH + 1),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "laf:feedback_too_long",
      limit: FEEDBACK_MAX_LENGTH,
    });
    expect(kept).toEqual([]);
  });

  test("a body that is not JSON, as an empty message", async () => {
    const { app } = surface();
    const response = await app.request("/api/support/feedback", {
      method: "POST",
      body: "not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("what the route says back", () => {
  test("the row, when it was received, and which doors told the operator", async () => {
    const { app, written, rows } = surface({ told: ["support-webhook"] });
    const response = await post(app, { text: "잘 쓰고 있습니다" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: "feedback-1",
      receivedAt: "2026-09-06T09:00:00.000Z",
      told: ["support-webhook"],
    });
    // The outbox row is the telling: the support kind, this person, nobody's Bot.
    expect(written).toHaveLength(1);
    expect(written[0]?.kind).toBe("support.feedback");
    expect(written[0]?.userId).toBe(PERSON.id);
    expect(written[0]?.botId).toBe("");
    // The trail says a message went and how far, never what it said.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("support.feedback_sent");
    expect(rows[0]?.targetId).toBe("feedback-1");
    expect(rows[0]?.actorUserId).toBe(PERSON.id);
    expect(rows[0]?.payload).toEqual({
      length: "잘 쓰고 있습니다".length,
      withScreen: false,
      told: ["support-webhook"],
    });
    expect(JSON.stringify(rows)).not.toContain("잘 쓰고 있습니다");
  });

  test("told nobody, honestly, when no door took it", async () => {
    const { app } = surface({ told: [] });
    const body = await (await post(app, { text: "안녕하세요" })).json();
    expect(body.told).toEqual([]);
  });

  test("still received on a deployment with no outbox at all", async () => {
    const { app, kept, rows } = surface({ outbox: false });
    const response = await post(app, { text: "안녕하세요" });

    expect(response.status).toBe(201);
    expect((await response.json()).told).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(rows[0]?.payload.told).toEqual([]);
  });
});
