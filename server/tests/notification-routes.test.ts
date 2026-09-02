import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ApprovalMetrics } from "../src/notifications/approval-metrics";
import type {
  NotificationOutbox,
  NotificationRecord,
} from "../src/notifications/outbox";
import { createNotificationRoutes } from "../src/notifications/routes";
import { A_CLICK } from "./support/subjects";

/**
 * The in-app door and the metric, as a browser reaches them.
 *
 * What only the handlers can get wrong: whose rows a read returns, whether the metric is the
 * owner's alone, and what a page is told about a row that is not there. The list itself is tested
 * against a real Postgres in `notification-outbox.integration.test.ts`.
 */

const OWNER = {
  id: "owner-user",
  email: "owner@laf.test",
  role: "user",
} as const;
const ADMIN = {
  id: "admin-user",
  email: "admin@laf.test",
  role: "admin",
} as const;

const ROW: NotificationRecord = {
  id: "notification-1",
  kind: "approval.requested",
  botId: "bot-1",
  userId: OWNER.id,
  approvalId: "approval-1",
  subject: A_CLICK,
  createdAt: "2026-09-03T13:00:00.000Z",
  deliveredVia: ["socket"],
};

const METRICS: ApprovalMetrics = {
  days: 30,
  timeZone: "Asia/Seoul",
  count: 4,
  medianSeconds: 41,
  p90Seconds: 300,
  nightMedianSeconds: 3600,
  unanswered: 1,
};

function surface(
  actor: typeof OWNER | typeof ADMIN,
  options: { metrics?: boolean } = {},
) {
  const asked: Array<{ userId: string; since?: string }> = [];
  const marked: Array<{ userId: string; id: string }> = [];
  const windows: number[] = [];
  const outbox: NotificationOutbox = {
    enqueue: async () => null,
    list: async (userId, listOptions) => {
      asked.push({
        userId,
        ...(listOptions?.since ? { since: listOptions.since } : {}),
      });
      return userId === OWNER.id ? [ROW] : [];
    },
    markSeen: async (userId, id) => {
      marked.push({ userId, id });
      return id === ROW.id && userId === OWNER.id;
    },
    markSeenForApproval: async () => 0,
  };
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/api",
    createNotificationRoutes(
      requireUser,
      outbox,
      options.metrics === false
        ? undefined
        : async (days) => {
            windows.push(days);
            return { ...METRICS, days };
          },
    ),
  );
  return { app, asked, marked, windows };
}

describe("the in-app door", () => {
  test("hands over the rows of whoever is asking, from the session", async () => {
    const { app, asked } = surface(OWNER);

    const response = await app.request("/api/me/notifications");
    const body = (await response.json()) as {
      notifications: NotificationRecord[];
    };

    expect(response.status).toBe(200);
    expect(body.notifications.map((one) => one.id)).toEqual(["notification-1"]);
    // The person is taken from the session, never from the URL: there is no way to ask for
    // somebody else's list, because there is nowhere to say whose list you want.
    expect(asked).toEqual([{ userId: OWNER.id }]);
    // The facts travel; the sentence is the surface's.
    expect(body.notifications[0]?.subject?.intent).toBe("activate");
  });

  test("carries the client's bookmark through", async () => {
    const { app, asked } = surface(OWNER);
    await app.request("/api/me/notifications?since=2026-09-03T12:00:00.000Z");
    expect(asked[0]?.since).toBe("2026-09-03T12:00:00.000Z");
  });

  test("marking one seen is 204, and a row that is not theirs is the same 404 as one that is gone", async () => {
    const { app, marked } = surface(OWNER);

    expect(
      (
        await app.request("/api/me/notifications/notification-1/seen", {
          method: "POST",
        })
      ).status,
    ).toBe(204);

    const missing = await app.request(
      "/api/me/notifications/somebody-elses/seen",
      {
        method: "POST",
      },
    );
    expect(missing.status).toBe(404);
    // A fact code, not a sentence: the surface owns the words.
    expect(((await missing.json()) as { error: string }).error).toBe(
      "laf:notification_not_found",
    );
    expect(marked.map((one) => one.userId)).toEqual([OWNER.id, OWNER.id]);
  });
});

describe("the approvals metric", () => {
  test("is the owner's alone", async () => {
    const asOwner = surface(OWNER);
    expect(
      (await asOwner.app.request("/api/admin/metrics/approvals")).status,
    ).toBe(403);
    expect(asOwner.windows).toEqual([]);

    const asAdmin = surface(ADMIN);
    const response = await asAdmin.app.request("/api/admin/metrics/approvals");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...METRICS, days: 30 });
  });

  test("answers in the window it was asked for, within a bound", async () => {
    const { app, windows } = surface(ADMIN);
    await app.request("/api/admin/metrics/approvals?days=7");
    await app.request("/api/admin/metrics/approvals?days=nonsense");
    await app.request("/api/admin/metrics/approvals?days=100000");
    expect(windows).toEqual([7, 30, 365]);
  });

  test("a deployment that cannot compute it says so rather than reporting zeroes", async () => {
    const { app } = surface(ADMIN, { metrics: false });
    const response = await app.request("/api/admin/metrics/approvals");
    // Zeroes would be indistinguishable from a month in which nobody was ever asked anything, and
    // those two want opposite reactions.
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe(
      "laf:metrics_unavailable",
    );
  });
});

describe("a question nobody answered", () => {
  test("the registry says so once, and never for one that was answered", async () => {
    let clock = 1_000_000;
    const expired: string[] = [];
    const registry = createApprovalRegistry({
      now: () => clock,
      ttlMs: 60_000,
      onExpire: (approval) => expired.push(approval.id),
    });

    const ignored = await registry.request({
      botId: "bot-1",
      actor: "person-1",
      rule: "r",
      subject: A_CLICK,
      fingerprint: "f1",
      target: { type: "computer", id: "c" },
    });
    const answered = await registry.request({
      botId: "bot-1",
      actor: "person-1",
      rule: "r",
      subject: A_CLICK,
      fingerprint: "f2",
      target: { type: "computer", id: "c" },
    });
    await registry.answer(answered.id, "bot-1", "person-1", true);

    clock += 61_000;
    // Any read sweeps; this is the read the surface makes every second while a Bot is stopped.
    await registry.pending("bot-1");
    await registry.pending("bot-1");

    // Once, not once per read — and only for the question nobody decided. An answered question
    // expiring unspent is not "nobody was reached", which is the one thing this row would say.
    expect(expired).toEqual([ignored.id]);
  });

  test("a hook that throws cannot take a read of the registry down with it", async () => {
    let clock = 1_000_000;
    const registry = createApprovalRegistry({
      now: () => clock,
      ttlMs: 60_000,
      onExpire: () => {
        throw new Error("the outbox is having a bad minute");
      },
    });
    await registry.request({
      botId: "bot-1",
      actor: "person-1",
      rule: "r",
      subject: A_CLICK,
      fingerprint: "f1",
      target: { type: "computer", id: "c" },
    });

    clock += 61_000;
    expect(await registry.pending("bot-1")).toEqual([]);
  });
});
