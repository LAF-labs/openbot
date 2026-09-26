import { describe, expect, test } from "bun:test";
import {
  createApprovalRegistry,
  fingerprintOf,
  tierGiven,
} from "../src/computer/approvals";
import type { HighRiskVerdict } from "../src/computer/high-risk";
import type { ActionPolicy, PolicyDecision } from "../src/computer/policy";
import { type SettleDeps, settle } from "../src/computer/settle";
import {
  allowanceFor,
  createStandingApprovalStore,
  endOfDayIn,
  type StandingApprovalStore,
  TASK_ALLOWANCE_TTL_MS,
} from "../src/computer/standing-approvals";
import { A_CLICK } from "./support/subjects";

/**
 * "이 일 동안" AND "오늘 하루", AND THE HIGH-RISK CHECK THAT NO WIDTH GETS PAST.
 *
 * The two widths are enforced by the store, not by the card that offers them: a task allowance
 * answers only while the conversation is on the task it was granted in, and a day allowance only
 * until midnight where the person is. The check is the other direction — a submission that pays,
 * changes an account or hands somebody's details over is asked about whatever stands.
 */

const BOT = "bot-1";
const ACTOR = "dev-local-user";
const OWNER = "owner-1";
const RULE = 'contains(element.name, "submit")';
const THREAD = "thread-1";

const ASKED: PolicyDecision = {
  allowed: false,
  matched: RULE,
  source: "ask",
  forward: false,
};
const ALLOWED: PolicyDecision = {
  allowed: true,
  matched: "true",
  source: "allow",
  forward: true,
};
const DENIED: PolicyDecision = {
  allowed: false,
  matched: 'contains(element.name, "delete")',
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

/** A conversation whose task the test moves on by hand, as the person writing again would. */
function conversation(first = "message-1") {
  const tasks = new Map<string, string>([[THREAD, first]]);
  return {
    currentTask: async (threadId: string) => tasks.get(threadId),
    next: (id: string) => tasks.set(THREAD, id),
  };
}

function deps(
  standing: StandingApprovalStore,
  policy: ActionPolicy = PERMISSIVE,
): SettleDeps & { approvals: ReturnType<typeof createApprovalRegistry> } {
  return {
    policy: () => policy,
    approvals: createApprovalRegistry(),
    standing,
  };
}

function input(extra: Partial<Parameters<typeof settle>[0]> = {}) {
  return {
    botId: BOT,
    actorId: ACTOR,
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

const ESCALATE: HighRiskVerdict = {
  escalate: true,
  kinds: ["payment"],
  signals: ["paying_control"],
  judge: "rules",
};
const CLEAR_WITH_LOOK: HighRiskVerdict = {
  escalate: false,
  kinds: [],
  signals: ["typed_phone"],
  judge: "typesafe/jev-1.13-20260917 pay=0.01",
};

describe("for this task", () => {
  test("a question raised in a conversation carries its task, and the card can offer it", async () => {
    const talk = conversation();
    const shared = deps(
      createStandingApprovalStore({ currentTask: talk.currentTask }),
    );
    const settled = await settle(input({ threadId: THREAD }), shared);
    if (settled.outcome !== "asked") throw new Error("expected a question");
    expect(settled.approval.taskId).toBe("message-1");
    expect(tierGiven(settled.approval, "task")).toBe("task");
  });

  test("a store that cannot tell the task offers no task width", async () => {
    const shared = deps(createStandingApprovalStore());
    const settled = await settle(input({ threadId: THREAD }), shared);
    if (settled.outcome !== "asked") throw new Error("expected a question");
    expect(settled.approval.taskId).toBeUndefined();
    // Pressed anyway, it is this once and nothing wider.
    expect(tierGiven(settled.approval, "task")).toBeUndefined();
  });

  test("answers while the task is current, and not once the person writes again", async () => {
    const talk = conversation();
    const standing = createStandingApprovalStore({
      currentTask: talk.currentTask,
    });
    const granted = await standing.grant({
      botId: BOT,
      rule: RULE,
      scope: SCOPE,
      subject: A_CLICK,
      grantedBy: OWNER,
      tier: "task",
      threadId: THREAD,
      taskId: "message-1",
    });
    expect(granted.expiresAt).toBeDefined();

    const during = await settle(input({ threadId: THREAD }), deps(standing));
    expect(during).toMatchObject({
      outcome: "allowed",
      allowance: { id: granted.id, tier: "task" },
    });

    talk.next("message-2");
    const after = await settle(input({ threadId: THREAD }), deps(standing));
    expect(after.outcome).toBe("asked");
    // And the list stops showing it, because it no longer answers for anything.
    expect(await standing.list(BOT)).toEqual([]);
  });

  test("answers for nothing outside its conversation, and runs out on its clock", async () => {
    let now = Date.parse("2026-09-26T03:00:00Z");
    const talk = conversation();
    const standing = createStandingApprovalStore({
      now: () => now,
      currentTask: talk.currentTask,
    });
    await standing.grant({
      botId: BOT,
      rule: RULE,
      scope: SCOPE,
      subject: A_CLICK,
      grantedBy: OWNER,
      tier: "task",
      threadId: THREAD,
      taskId: "message-1",
    });
    expect(
      await standing.find(BOT, RULE, "host=example.com", {
        threadId: "another",
        taskId: "message-1",
      }),
    ).toBeNull();
    expect(await standing.find(BOT, RULE, "host=example.com")).toBeNull();

    now += TASK_ALLOWANCE_TTL_MS + 1;
    expect(
      await standing.find(BOT, RULE, "host=example.com", {
        threadId: THREAD,
        taskId: "message-1",
      }),
    ).toBeNull();
  });

  test("the conversation ending takes it back", async () => {
    const talk = conversation();
    const standing = createStandingApprovalStore({
      currentTask: talk.currentTask,
    });
    await standing.grant({
      botId: BOT,
      rule: RULE,
      scope: SCOPE,
      subject: A_CLICK,
      grantedBy: OWNER,
      tier: "task",
      threadId: THREAD,
      taskId: "message-1",
    });
    const ended = await standing.endThread(THREAD, OWNER);
    expect(ended.map((row) => row.tier)).toEqual(["task"]);
  });

  test("a grant with no task is refused rather than recorded", async () => {
    const standing = createStandingApprovalStore();
    await expect(
      standing.grant({
        botId: BOT,
        rule: RULE,
        scope: SCOPE,
        subject: A_CLICK,
        grantedBy: OWNER,
        tier: "task",
        threadId: THREAD,
      }),
    ).rejects.toThrow();
  });
});

describe("for today", () => {
  test("ends at midnight in the person's zone, not twenty-four hours on", () => {
    // 23:50 in Seoul is 14:50 UTC; the day ends ten minutes later, at 15:00 UTC.
    const lateInSeoul = Date.parse("2026-09-26T14:50:00Z");
    expect(new Date(endOfDayIn("Asia/Seoul", lateInSeoul)).toISOString()).toBe(
      "2026-09-26T15:00:00.000Z",
    );
    // Morning in Seoul is still the same Seoul day.
    const morning = Date.parse("2026-09-26T00:30:00Z");
    expect(new Date(endOfDayIn("Asia/Seoul", morning)).toISOString()).toBe(
      "2026-09-26T15:00:00.000Z",
    );
    expect(new Date(endOfDayIn("UTC", morning)).toISOString()).toBe(
      "2026-09-27T00:00:00.000Z",
    );
    // A zone that changes its clock that night still lands on its own midnight.
    const beforeFallBack = Date.parse("2026-10-31T20:00:00Z");
    expect(
      new Date(endOfDayIn("America/New_York", beforeFallBack)).toISOString(),
    ).toBe("2026-11-01T04:00:00.000Z");
  });

  test("answers everywhere, a routine included, until the day is over", async () => {
    let now = Date.parse("2026-09-26T05:00:00Z");
    const standing = createStandingApprovalStore({ now: () => now });
    const granted = await standing.grant({
      botId: BOT,
      rule: RULE,
      scope: SCOPE,
      subject: A_CLICK,
      grantedBy: OWNER,
      tier: "day",
    });
    expect(granted.expiresAt).toBe("2026-09-26T15:00:00.000Z");
    expect(granted.threadId).toBeUndefined();

    // A routine: no conversation at all.
    expect(await settle(input(), deps(standing))).toMatchObject({
      outcome: "allowed",
      allowance: { tier: "day" },
    });
    expect(
      await settle(input({ threadId: "any" }), deps(standing)),
    ).toMatchObject({ outcome: "allowed" });

    now = Date.parse("2026-09-26T15:00:01Z");
    expect((await settle(input(), deps(standing))).outcome).toBe("asked");
    expect(await standing.list(BOT)).toEqual([]);
  });

  test("offered wherever a scope is, with or without a conversation", async () => {
    const settled = await settle(input(), deps(createStandingApprovalStore()));
    if (settled.outcome !== "asked") throw new Error("expected a question");
    expect(tierGiven(settled.approval, "day")).toBe("day");
    expect(tierGiven(settled.approval, "thread")).toBeUndefined();
  });
});

describe("four widths side by side", () => {
  test("each keeps its own row, and the widest one is what answers", async () => {
    const talk = conversation();
    const standing = createStandingApprovalStore({
      currentTask: talk.currentTask,
    });
    const grant = (tier: "always" | "day" | "thread" | "task") =>
      standing.grant({
        botId: BOT,
        rule: RULE,
        scope: SCOPE,
        subject: A_CLICK,
        grantedBy: OWNER,
        tier,
        ...(tier === "thread" || tier === "task" ? { threadId: THREAD } : {}),
        ...(tier === "task" ? { taskId: "message-1" } : {}),
      });
    await grant("task");
    await grant("thread");
    await grant("day");
    expect((await standing.list(BOT)).map((row) => row.tier).sort()).toEqual([
      "day",
      "task",
      "thread",
    ]);
    const found = await standing.find(BOT, RULE, "host=example.com", {
      threadId: THREAD,
      taskId: "message-1",
    });
    expect(found?.tier).toBe("day");
    await grant("always");
    expect(
      (
        await standing.find(BOT, RULE, "host=example.com", {
          threadId: THREAD,
          taskId: "message-1",
        })
      )?.tier,
    ).toBe("always");
  });
});

describe("the high-risk check in settle", () => {
  test("turns an action the policy allowed into a question with nothing wider on offer", async () => {
    const shared = deps(createStandingApprovalStore());
    const settled = await settle(
      input({
        policyVerdict: ALLOWED,
        threadId: THREAD,
        highRisk: async () => ESCALATE,
      }),
      shared,
    );
    if (settled.outcome !== "asked") throw new Error("expected a question");
    expect(settled.approval.scope).toBeUndefined();
    expect(settled.approval.threadId).toBeUndefined();
    expect(settled.approval.subject).toMatchObject({
      reason: "high_risk",
      risk: ["payment"],
    });
    expect(settled.highRisk).toEqual(ESCALATE);
  });

  test("walks past a standing allowance and the owner's instruction alike", async () => {
    const standing = createStandingApprovalStore();
    await standing.grant({
      botId: BOT,
      rule: RULE,
      scope: SCOPE,
      subject: A_CLICK,
      grantedBy: OWNER,
    });
    const reviewed: unknown[] = [];
    const settled = await settle(input({ highRisk: async () => ESCALATE }), {
      ...deps(standing),
      autoReview: async (_bot, subject) => {
        reviewed.push(subject);
        return { allowed: true, reason: "covered" };
      },
    });
    expect(settled.outcome).toBe("asked");
    expect(reviewed).toEqual([]);
  });

  test("never asks about a deny, and is never even consulted there", async () => {
    let consulted = 0;
    const settled = await settle(
      input({
        policyVerdict: DENIED,
        highRisk: async () => {
          consulted += 1;
          return ESCALATE;
        },
      }),
      deps(createStandingApprovalStore()),
    );
    expect(settled).toEqual({ outcome: "refused", code: "laf:policy_denied" });
    expect(consulted).toBe(0);
  });

  test("a person's yes to this very action passes, with no second look", async () => {
    const shared = deps(createStandingApprovalStore());
    let consulted = 0;
    const highRisk = async () => {
      consulted += 1;
      return ESCALATE;
    };
    const first = await settle(
      input({ policyVerdict: ALLOWED, highRisk }),
      shared,
    );
    if (first.outcome !== "asked") throw new Error("expected a question");
    await shared.approvals.answer(first.approvalId, BOT, OWNER, true);

    const second = await settle(
      input({
        policyVerdict: ALLOWED,
        highRisk,
        presentedApprovalId: first.approvalId,
      }),
      shared,
    );
    expect(second).toEqual({ outcome: "allowed", approvedBy: OWNER });
    expect(consulted).toBe(1);
  });

  test("a No to it stands, like any other", async () => {
    const shared = deps(createStandingApprovalStore());
    const first = await settle(
      input({ policyVerdict: ALLOWED, highRisk: async () => ESCALATE }),
      shared,
    );
    if (first.outcome !== "asked") throw new Error("expected a question");
    await shared.approvals.answer(first.approvalId, BOT, OWNER, false);
    const again = await settle(
      input({ policyVerdict: ALLOWED, highRisk: async () => ESCALATE }),
      shared,
    );
    expect(again).toMatchObject({
      outcome: "refused",
      code: "laf:declined_recently",
    });
  });

  test("a clear verdict leaves the policy's yes alone, and says it looked", async () => {
    const settled = await settle(
      input({ policyVerdict: ALLOWED, highRisk: async () => CLEAR_WITH_LOOK }),
      deps(createStandingApprovalStore()),
    );
    expect(settled).toEqual({ outcome: "allowed", highRisk: CLEAR_WITH_LOOK });
  });

  test("with the switch off everything asks anyway; the check only says why", async () => {
    const settled = await settle(
      input({ threadId: THREAD, highRisk: async () => ESCALATE }),
      deps(createStandingApprovalStore(), {
        ...PERMISSIVE,
        settleWithoutAsking: "off",
      }),
    );
    if (settled.outcome !== "asked") throw new Error("expected a question");
    expect(settled.approval.scope).toBeUndefined();
    expect(settled.approval.subject.reason).toBe("high_risk");
  });
});
