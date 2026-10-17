import { describe, expect, test } from "bun:test";
import {
  type AskSubject,
  createApprovalRegistry,
  fingerprintOf,
  tierGiven,
} from "../src/computer/approvals";
import { topicOf } from "../src/computer/ask-topic";
import type { ActionPolicy, PolicyDecision } from "../src/computer/policy";
import { type SettleDeps, settle } from "../src/computer/settle";
import {
  allowanceFor,
  BOARD_TASK_ALLOWANCE_TTL_MS,
  createStandingApprovalStore,
  type StandingApprovalStore,
} from "../src/computer/standing-approvals";
import { A_CLICK } from "./support/subjects";

/**
 * "이 일감에서는 해도 돼": an allowance for one company board task and one topic, judged where every
 * allowance is judged (`settle.ts`). It answers the run of that task for that kind of action there,
 * and nothing else — not another task, not another kind of action on the same site, not a person
 * chatting in the task's own conversation, not a routine — and never a `deny`, and not at all where
 * the deployment switched allowances off.
 */

const BOT = "bot-1";
const OWNER = "owner-1";
const RULE = 'contains(element.name, "submit")';
const TASK = "task:t_board_1";
const SIBLING = "task:t_board_2";
const ASKED: PolicyDecision = {
  allowed: false,
  matched: RULE,
  source: "ask",
  forward: false,
};
const DENIED: PolicyDecision = {
  allowed: false,
  matched: RULE,
  source: "deny",
  forward: false,
  code: "laf:policy_denied",
};
const PERMISSIVE: ActionPolicy = { deny: [], ask: [RULE], allow: ["true"] };
const PRINT = fingerprintOf({
  botId: BOT,
  toolName: "computer_click",
  ref: "e9",
  pageUrl: "https://example.com/order",
});
const SCOPE = allowanceFor({ tool: "computer_click", host: "example.com" });
/** The same site and the same scope, another kind of action: typing rather than pressing. */
const A_TYPE: AskSubject = { ...A_CLICK, intent: "type" };

function deps(
  standing: StandingApprovalStore,
  policy: ActionPolicy = PERMISSIVE,
): SettleDeps {
  return {
    policy: () => policy,
    approvals: createApprovalRegistry(),
    standing,
  };
}

function input(extra: Partial<Parameters<typeof settle>[0]> = {}) {
  return {
    botId: BOT,
    actorId: OWNER,
    subject: A_CLICK,
    action: "computer_click",
    fingerprint: PRINT,
    allowance: SCOPE,
    rule: RULE,
    target: { type: "computer", id: "default" },
    policyVerdict: ASKED,
    ...extra,
  } satisfies Parameters<typeof settle>[0];
}

/** The person's yes for TASK, on the topic its stop was about — as `task-asks.ts` grants it. */
async function allowedForTask(at = 1_000_000) {
  const store = createStandingApprovalStore({ now: () => at });
  const granted = await store.grant({
    botId: BOT,
    rule: RULE,
    scope: SCOPE,
    subject: A_CLICK,
    grantedBy: OWNER,
    tier: "board_task",
    threadId: TASK,
    taskId: topicOf(A_CLICK),
  });
  return { store, granted };
}

describe("an allowance for one board task", () => {
  test("lets the next run of that task past the same kind of action there, under the person's name", async () => {
    const { store, granted } = await allowedForTask();
    const settled = await settle(
      input({ boardTaskThreadId: TASK }),
      deps(store),
    );
    expect(settled.outcome).toBe("allowed");
    if (settled.outcome !== "allowed") return;
    expect(settled.approvedBy).toBe(OWNER);
    expect(settled.allowance?.id).toBe(granted.id);
    expect(granted.tier).toBe("board_task");
    expect(granted.expiresAt).toBe(
      new Date(1_000_000 + BOARD_TASK_ALLOWANCE_TTL_MS).toISOString(),
    );
  });

  test("a sibling task meeting the same topic is still asked", async () => {
    const { store } = await allowedForTask();
    const settled = await settle(
      input({ boardTaskThreadId: SIBLING }),
      deps(store),
    );
    expect(settled.outcome).toBe("asked");
  });

  test("the same task meeting another kind of action on the same site is still asked", async () => {
    const { store } = await allowedForTask();
    expect(topicOf(A_TYPE)).not.toBe(topicOf(A_CLICK));
    const settled = await settle(
      input({ boardTaskThreadId: TASK, subject: A_TYPE }),
      deps(store),
    );
    expect(settled.outcome).toBe("asked");
  });

  test("a person chatting in the task's own conversation is not the task's run, and is asked", async () => {
    const { store } = await allowedForTask();
    const settled = await settle(input({ threadId: TASK }), deps(store));
    expect(settled.outcome).toBe("asked");
  });

  test("a routine, raised from nowhere in particular, is asked", async () => {
    const { store } = await allowedForTask();
    expect((await settle(input(), deps(store))).outcome).toBe("asked");
  });

  test("a deny rule still refuses, the allowance notwithstanding", async () => {
    const { store } = await allowedForTask();
    const settled = await settle(
      input({ boardTaskThreadId: TASK, policyVerdict: DENIED }),
      deps(store),
    );
    expect(settled).toEqual({ outcome: "refused", code: "laf:policy_denied" });
  });

  test("with allowances switched off for the deployment, it answers for nothing", async () => {
    const { store } = await allowedForTask();
    const settled = await settle(
      input({ boardTaskThreadId: TASK }),
      deps(store, { ...PERMISSIVE, settleWithoutAsking: "off" }),
    );
    expect(settled.outcome).toBe("asked");
  });

  test("after its week it answers for nothing", async () => {
    let now = 1_000_000;
    const store = createStandingApprovalStore({ now: () => now });
    await store.grant({
      botId: BOT,
      rule: RULE,
      scope: SCOPE,
      subject: A_CLICK,
      grantedBy: OWNER,
      tier: "board_task",
      threadId: TASK,
      taskId: topicOf(A_CLICK),
    });
    now += BOARD_TASK_ALLOWANCE_TTL_MS - 1;
    const before = await settle(
      input({ boardTaskThreadId: TASK }),
      deps(store),
    );
    expect(before.outcome).toBe("allowed");
    now += 2;
    const after = await settle(input({ boardTaskThreadId: TASK }), deps(store));
    expect(after.outcome).toBe("asked");
  });

  test("a card's answer can never be the board task's width", async () => {
    const approvals = createApprovalRegistry();
    const asked = await settle(input({ threadId: TASK }), {
      ...deps(createStandingApprovalStore()),
      approvals,
    });
    if (asked.outcome !== "asked") throw new Error("expected a question");
    expect(tierGiven(asked.approval, "thread")).toBe("thread");
    expect(tierGiven(asked.approval, "board_task")).toBeUndefined();
  });
});
