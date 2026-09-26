import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRoutes } from "../src/computer/approval-routes";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";

/**
 * "이 일 동안" AND "오늘 하루" ON THE SURFACE: the card sends a width, and what that grants is read
 * off the question, never off the body — the same rule the conversation width follows.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [{ ref: "e9", role: "button", name: "Submit order" }],
};
const ASKING: ActionPolicy = {
  deny: [],
  ask: ['contains(element.name, "submit")'],
  allow: ["true"],
};
const OWNER = { id: "owner-1", email: "owner@laf.test", role: "user" } as const;
const THREAD = "thread-7";

async function surface() {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = { insert: async (row) => void rows.push(row) };
  const tasks = new Map<string, string>([[THREAD, "message-1"]]);
  const standing = createStandingApprovalStore({
    currentTask: async (threadId) => tasks.get(threadId),
  });
  const approvals = createApprovalRegistry();
  const calls: string[] = [];
  const client = {
    snapshot: async () => SNAPSHOT,
    click: async () => {
      calls.push("click");
      return { action: "click", url: SNAPSHOT.url, elapsedMs: 1 } as never;
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => ASKING,
    approvals,
    standing,
  });
  await gateway.snapshot("bot-1");
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", OWNER);
    context.set("mayDriveBot", async (botId) => botId === "bot-1");
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createApprovalRoutes(approvals, auditStore, requireUser, standing),
  );
  const click = (threadId?: string) =>
    gateway
      .click(
        "bot-1",
        "bot-1",
        { id: OWNER.id, ...(threadId ? { threadId } : {}) },
        { ref: "e9", snapshotId: 7 },
      )
      .catch((caught: unknown) => caught);
  const answer = (id: string, body: Record<string, unknown>) =>
    app.request(`/bot-1/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granted: true, ...body }),
    });
  return { app, standing, rows, calls, tasks, click, answer };
}

describe("answering for this task", () => {
  test("the question carries its task, the answer binds to it, and the next task asks again", async () => {
    const { standing, rows, calls, tasks, click, answer } = await surface();
    const asked = (await click(THREAD)) as ActionNeedsApprovalError;
    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(asked.taskId).toBe("message-1");

    // The body cannot name a task of its own.
    expect(
      (await answer(asked.approvalId, { tier: "task", taskId: "other" }))
        .status,
    ).toBe(200);
    const [granted] = await standing.list("bot-1");
    expect(granted).toMatchObject({
      tier: "task",
      threadId: THREAD,
      taskId: "message-1",
    });
    const widening = rows.at(-1);
    expect(widening?.eventType).toBe("approval.standing_granted");
    expect(widening?.payload).toMatchObject({
      tier: "task",
      task: "message-1",
    });

    await click(THREAD);
    expect(calls).toEqual(["click"]);

    tasks.set(THREAD, "message-2");
    expect(await click(THREAD)).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual(["click"]);
  });

  test("a question from outside a conversation cannot be answered for a task", async () => {
    const { standing, click, answer } = await surface();
    const asked = (await click()) as ActionNeedsApprovalError;
    expect(asked.taskId).toBeUndefined();
    await answer(asked.approvalId, { tier: "task" });
    expect(await standing.list("bot-1")).toEqual([]);
  });
});

describe("answering for today", () => {
  test("grants a day-long allowance with its expiry, from a routine's question too", async () => {
    const { standing, calls, click, answer } = await surface();
    const asked = (await click()) as ActionNeedsApprovalError;
    expect((await answer(asked.approvalId, { tier: "day" })).status).toBe(200);
    const [granted] = await standing.list("bot-1");
    expect(granted?.tier).toBe("day");
    expect(granted?.expiresAt).toBeDefined();
    await click();
    await click(THREAD);
    expect(calls).toEqual(["click", "click"]);
  });

  test("a width this build does not know is this once, and grants nothing", async () => {
    const { standing, click, answer } = await surface();
    const asked = (await click(THREAD)) as ActionNeedsApprovalError;
    await answer(asked.approvalId, { tier: "forever-and-a-day" });
    expect(await standing.list("bot-1")).toEqual([]);
  });
});
