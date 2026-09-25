import { describe, expect, spyOn, test } from "bun:test";
import { createApprovalRegistry } from "../src/computer/approvals";
import { withApprovalNotifications } from "../src/notifications/notify";
import { A_CLICK } from "./support/subjects";

const ask = (registry: ReturnType<typeof createApprovalRegistry>) =>
  registry.request({
    botId: "bot-1",
    actor: "driver",
    rule: "r",
    subject: A_CLICK,
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
      expect(String(frame.headline)).toContain("사장님 승인을 기다려요");
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

  /*
   * It asserted only that the question had an id, which a registry that dropped the question and a
   * notifier that said nothing both still passed (measured 2026-09-25 by deleting the line). The
   * name promises two things, so both are checked: the question is waiting, and a line was written.
   */
  test("no webhook configured is a log line, not a crash", async () => {
    const lines: string[] = [];
    const info = spyOn(console, "info").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const registry = withApprovalNotifications(createApprovalRegistry(), {});
      const pending = await ask(registry);
      expect(
        (await registry.pending("bot-1")).map((entry) => entry.id),
      ).toEqual([pending.id]);
      expect(lines.some((line) => line.startsWith("[notify] "))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });
});
