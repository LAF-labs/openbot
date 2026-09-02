import { describe, expect, test } from "bun:test";
import { createApprovalRegistry } from "../src/computer/approvals";
import { withApprovalNotifications } from "../src/notifications/notify";

const ask = (registry: ReturnType<typeof createApprovalRegistry>) =>
  registry.request({
    botId: "bot-1",
    actor: "driver",
    rule: "r",
    question: "결제를 진행할까요?",
    fingerprint: "f",
    target: { type: "mcp_tool", id: "s/t" },
  });

describe("approval notifications", () => {
  test("a question opening sends one frame, and the registry still works", async () => {
    const frames: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        frames.push(await request.json());
        return new Response("ok");
      },
    });
    try {
      const registry = withApprovalNotifications(createApprovalRegistry(), {
        webhookUrl: `http://127.0.0.1:${server.port}/hook`,
      });
      const pending = await ask(registry);
      expect(
        (await registry.pending("bot-1")).map((entry) => entry.id),
      ).toContain(pending.id);
      // Fire-and-forget: give the frame one beat to arrive.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(frames).toHaveLength(1);
      const frame = frames[0] as Record<string, unknown>;
      expect(frame.kind).toBe("approval.requested");
      expect(frame.approvalId).toBe(pending.id);
      expect(String(frame.headline)).toContain("기다립니다");
    } finally {
      server.stop(true);
    }
  });

  test("a dead webhook never fails the question", async () => {
    const registry = withApprovalNotifications(createApprovalRegistry(), {
      webhookUrl: "http://127.0.0.1:1/hook",
    });
    const pending = await ask(registry);
    expect(pending.id).toBeTruthy();
    expect(await registry.pending("bot-1")).toHaveLength(1);
  });

  test("no webhook configured is a log line, not a crash", async () => {
    const registry = withApprovalNotifications(createApprovalRegistry(), {});
    expect((await ask(registry)).id).toBeTruthy();
  });
});
