import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  createComputerGateway,
} from "../src/computer/gateway";
import {
  createHighRiskCheck,
  type HighRiskCheck,
} from "../src/computer/high-risk";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { A_CLICK } from "./support/subjects";

/**
 * THE HIGH-RISK CHECK THROUGH THE GATEWAY: what it sees, what it asks, and what it writes down.
 *
 * `high-risk.test.ts` holds the verdicts; this holds the wiring — that a card number typed on a page
 * is remembered by kind and never by value, that the press which would send it is asked about even
 * with the site allowed for good, and that the trail says who decided and why without the number
 * in it anywhere.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 3,
  url: "https://shop.example.com/checkout",
  title: "Checkout",
  truncated: false,
  elements: [
    { ref: "e1", role: "textbox", name: "번호", type: "text" },
    { ref: "e2", role: "textbox", name: "검색어", type: "search" },
    { ref: "e8", role: "button", name: "시작하기" },
    { ref: "e9", role: "button", name: "무료 체험 시작 (결제 아님)" },
  ],
};

const CARD = "4111 1111 1111 1111";
const ACTOR = { id: "owner-1", threadId: "thread-1" };
const OPEN: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

function build(check: HighRiskCheck, policy: ActionPolicy = OPEN) {
  const calls: string[] = [];
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = { insert: async (row) => void rows.push(row) };
  const acted = (action: string) => {
    calls.push(action);
    return { action, url: SNAPSHOT.url, elapsedMs: 1 } as never;
  };
  const client = {
    snapshot: async () => SNAPSHOT,
    click: async () => acted("click"),
    type: async () => acted("type"),
    key: async () => acted("key"),
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  const standing = createStandingApprovalStore();
  const approvals = createApprovalRegistry();
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => policy,
    approvals,
    standing,
    highRisk: { check, taskText: async () => "무료 체험 신청해 줘" },
  });
  return { gateway, calls, rows, standing, approvals };
}

describe("a high-risk submission through the gateway", () => {
  test("a card number typed, then the press that sends it, is asked about with the site allowed for good", async () => {
    const { gateway, calls, rows, standing } = build(
      createHighRiskCheck({ asker: null }),
    );
    await gateway.snapshot("c1");
    await standing.grant({
      botId: "bot-1",
      rule: "",
      scope: { kind: "host", value: "shop.example.com" },
      subject: A_CLICK,
      grantedBy: "owner-1",
    });

    const typing = await gateway
      .type("c1", "bot-1", ACTOR, { ref: "e1", snapshotId: 3, text: CARD })
      .catch((caught: unknown) => caught);
    // Typing a card number is itself a leaving the check stops for, so it asks there already.
    expect(typing).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual([]);

    const typedQuestion = rows.find(
      (row) => row.eventType === "approval.requested",
    );
    expect(typedQuestion).toBeDefined();

    const pressed = await gateway
      .click("c1", "bot-1", ACTOR, { ref: "e9", snapshotId: 3 })
      .catch((caught: unknown) => caught);
    expect(pressed).toBeInstanceOf(ActionNeedsApprovalError);
    // Nothing wider is offered: an allowance from this card would be one the check walks past.
    expect((pressed as ActionNeedsApprovalError).scope).toBeUndefined();
    expect((pressed as ActionNeedsApprovalError).threadId).toBeUndefined();
    expect((pressed as ActionNeedsApprovalError).subject).toMatchObject({
      reason: "high_risk",
    });

    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain("4111");
    expect(serialised).toContain('"judge":"rules"');
  });

  test("a presented yes carries the typing out, and the ledger keeps its kind for the press", async () => {
    const { gateway, calls, approvals } = build(
      createHighRiskCheck({ asker: null }),
    );
    await gateway.snapshot("c1");
    const asked = (await gateway
      .type("c1", "bot-1", ACTOR, { ref: "e1", snapshotId: 3, text: CARD })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, "bot-1", "owner-1", true);
    await gateway.type(
      "c1",
      "bot-1",
      ACTOR,
      { ref: "e1", snapshotId: 3, text: CARD },
      undefined,
      asked.approvalId,
    );
    expect(calls).toEqual(["type"]);

    // The press that would send it is its own question — the person said yes to typing it. The
    // button says nothing about money; what was typed on the page is what asks.
    const pressed = await gateway
      .click("c1", "bot-1", ACTOR, { ref: "e8", snapshotId: 3 })
      .catch((caught: unknown) => caught);
    expect(pressed).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual(["type"]);
  });

  test("a search with Enter goes straight through, and the check costs nothing", async () => {
    let judged = 0;
    const check = createHighRiskCheck({
      asker: {
        ask: async () => {
          judged += 1;
          throw new Error("jev: not expected");
        },
      },
    });
    const { gateway, calls, rows } = build(check);
    await gateway.snapshot("c1");
    await gateway.type("c1", "bot-1", ACTOR, {
      ref: "e2",
      snapshotId: 3,
      text: "서울 날씨",
      submit: true,
    });
    expect(calls).toEqual(["type"]);
    expect(judged).toBe(0);
    expect(rows.at(-1)?.eventType).toBe("computer.action_allowed");
  });

  test("a deny stays a deny, and the check is never consulted about it", async () => {
    let consulted = 0;
    const { gateway, calls } = build(
      async () => {
        consulted += 1;
        return { escalate: true, kinds: ["payment"], signals: ["x"] };
      },
      { deny: ['contains(element.name, "결제")'], ask: [], allow: ["true"] },
    );
    await gateway.snapshot("c1");
    await expect(
      gateway.click("c1", "bot-1", ACTOR, { ref: "e9", snapshotId: 3 }),
    ).rejects.toThrow();
    expect(consulted).toBe(0);
    expect(calls).toEqual([]);
  });
});
