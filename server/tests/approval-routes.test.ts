import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRoutes } from "../src/computer/approval-routes";
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createApprovalWaiter } from "../src/rooms/wait-for-approval";
import { A_CLICK } from "./support/subjects";

/**
 * The surface a person answers on, exercised as the browser reaches it.
 *
 * Tested through the routes rather than through the registry alone, because the two things that go
 * wrong here are things only the handler can get wrong: which Bot an answer is recorded against, and
 * what the reply carries back out of the process. Neither is visible from the registry's own tests,
 * and both are the sort of thing a sibling handler quietly diverges on.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "input", name: "Customer name:", type: "text" },
    { ref: "e9", role: "button", name: "Submit order" },
  ],
};

const ASKING: ActionPolicy = {
  deny: [],
  ask: ['contains(element.name, "submit")'],
  allow: ["true"],
};

/** The person whose turn raised the question. Not the person who answers it. */
const DRIVER = { id: "dev-local-user" };

/** Answering is the owner's: in this build that means an administrator. */
const MANAGER = {
  id: "manager-user",
  email: "manager@laf.test",
  role: "admin",
} as const;

const BYSTANDER = {
  id: "bystander-user",
  email: "bystander@laf.test",
  role: "user",
} as const;

function fakeClient() {
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
  return { client, calls };
}

/**
 * One audit store and one registry behind both halves, which is the arrangement being tested.
 *
 * The question is raised by the gateway and answered on the routes, minutes apart and by different
 * people, and the only thing joining the two rows is the approval id. A test that gave each half its
 * own store could not see whether they agree.
 */
async function surface() {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const approvals: ApprovalRegistry = createApprovalRegistry();
  // One store behind the gateway and the routes, which is the arrangement being tested: the button
  // is pressed on one and the next action is decided on the other.
  const standing = createStandingApprovalStore();
  const { client, calls } = fakeClient();
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
    context.set("actor", MANAGER);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createApprovalRoutes(approvals, auditStore, requireUser, standing),
  );

  /** A click that meets the ask rule, and the question it leaves open. */
  const ask = async (botId: string) =>
    (await gateway
      .click(botId, botId, DRIVER, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

  return { app, approvals, standing, gateway, ask, rows, calls };
}

const answer =
  (app: Hono<{ Variables: AppVariables }>) =>
  async (
    botId: string,
    approvalId: string,
    granted: boolean,
    body: Record<string, unknown> = {},
  ) =>
    app.request(`/${botId}/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granted, ...body }),
    });

describe("answering a question", () => {
  test("somebody who is not the owner cannot spend an approval", async () => {
    const rowsSink: AuditEventInput[] = [];
    const approvals = createApprovalRegistry();
    const asBystander: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", BYSTANDER);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createApprovalRoutes(
        approvals,
        { insert: async (event) => void rowsSink.push(event) },
        asBystander,
      ),
    );
    const pending = await approvals.request({
      botId: "bot-1",
      actor: DRIVER.id,
      rule: "r",
      subject: A_CLICK,
      fingerprint: "f",
      target: { type: "computer", id: "bot-1" },
    });
    const response = await app.request(`/bot-1/${pending.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granted: true }),
    });
    expect(response.status).toBe(403);
  });

  test("records the answer under the person who gave it and lets the action run", async () => {
    const { app, ask, rows, gateway, calls } = await surface();
    const asked = await ask("bot-1");

    const response = await answer(app)("bot-1", asked.approvalId, true);
    expect(response.status).toBe(200);

    await gateway.click(
      "bot-1",
      "bot-1",
      DRIVER,
      { ref: "e9", snapshotId: 7 },
      undefined,
      asked.approvalId,
    );

    expect(calls).toEqual(["click"]);
    // Three rows for one action, and each answers a different question: it was asked, somebody said
    // yes, it happened.
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval.requested",
      "approval.granted",
      "computer.action_allowed",
    ]);
    // The answer is credited to whoever answered, not to whoever was driving the Bot, which is the
    // one thing an approval trail must never get wrong.
    expect(rows[0]?.payload.actor).toBe("dev-local-user");
    expect(rows[1]?.payload.actor).toBe("manager-user");
    expect(rows[1]?.actorUserId).toBe("manager-user");
    expect(rows[1]?.payload.asked).toBe("dev-local-user");
    const decision = rows[2]?.payload.decision as { approvedBy?: string };
    expect(decision.approvedBy).toBe("manager-user");
  });

  test("files the answer against the Bot the question was about, not the address it arrived at", async () => {
    // The Bot in the path is whatever the caller typed. Taking it from the request would put a grant
    // in the trail under one Bot and the action it paid for under another, joined by an id that
    // appears on both and reconciles neither.
    const { app, ask, rows } = await surface();
    const asked = await ask("bot-1");

    const wrongBot = await answer(app)("bot-2", asked.approvalId, true);
    expect(wrongBot.status).toBe(409);
    expect(rows.map((row) => row.eventType)).toEqual(["approval.requested"]);

    expect((await answer(app)("bot-1", asked.approvalId, true)).status).toBe(
      200,
    );
    expect(rows[1]?.targetId).toBe("bot-1");
    expect(rows[1]?.payload.bot).toBe("bot-1");
  });

  test("never sends the binding out of the process", async () => {
    // The fingerprint is what ties an approval to one action, and it is compared here. Nothing on
    // the surface can do anything with it, and a handler that returned it would be quietly undoing
    // the invariant its sibling four lines up is careful to keep.
    const { app, ask } = await surface();
    const asked = await ask("bot-1");

    const listed = await (await app.request("/bot-1")).json();
    const answered = await (
      await answer(app)("bot-1", asked.approvalId, true)
    ).json();

    for (const record of [
      ...(listed as { approvals: Record<string, unknown>[] }).approvals,
      answered as Record<string, unknown>,
    ]) {
      expect(record.fingerprint).toBeUndefined();
      expect(record.actor).toBeUndefined();
      expect(record.target).toBeUndefined();
      // What DOES cross is the subject, because the surface has to draw the question — as facts,
      // in the shape `app/src/lib/approvals.ts` writes a Korean sentence from.
      expect(record.subject).toEqual(A_CLICK);
    }
  });

  test("a question nobody is waiting on any more is a conflict, not a fault", async () => {
    const { app, ask } = await surface();
    const asked = await ask("bot-1");

    expect((await answer(app)("bot-1", asked.approvalId, false)).status).toBe(
      200,
    );
    // Answered once, and not answerable again: otherwise a second tab can quietly overturn a
    // decision the trail has already recorded as made.
    expect((await answer(app)("bot-1", asked.approvalId, true)).status).toBe(
      409,
    );
    expect((await answer(app)("bot-1", "not-a-real-id", true)).status).toBe(
      409,
    );
  });

  test("refuses to read a missing answer as either one", async () => {
    const { app, ask, rows } = await surface();
    const asked = await ask("bot-1");

    const response = await app.request(`/bot-1/${asked.approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(rows).toHaveLength(1);
  });

  test("shows one Bot's open questions and not another's", async () => {
    const { app, ask } = await surface();
    const asked = await ask("bot-1");

    const mine = (await (await app.request("/bot-1")).json()) as {
      approvals: { id: string; rule: string }[];
    };
    expect(mine.approvals).toHaveLength(1);
    expect(mine.approvals[0]?.id).toBe(asked.approvalId);
    expect(mine.approvals[0]?.rule).toBe('contains(element.name, "submit")');

    const theirs = (await (await app.request("/bot-2")).json()) as {
      approvals: unknown[];
    };
    expect(theirs.approvals).toEqual([]);
  });

  test("a No answered on the surface stops the action from being asked again", async () => {
    const { app, ask, rows, gateway, calls } = await surface();
    const asked = await ask("bot-1");

    await answer(app)("bot-1", asked.approvalId, false);
    // Presenting the spent No does not open a second question: it is refused, and the row says why.
    await expect(
      gateway.click(
        "bot-1",
        "bot-1",
        DRIVER,
        { ref: "e9", snapshotId: 7 },
        undefined,
        asked.approvalId,
      ),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval.requested",
      "approval.denied",
      "computer.action_refused",
    ]);
    expect(
      (rows.at(-1)?.payload.decision as { code?: string } | undefined)?.code,
    ).toBe("laf:declined_recently");
  });

  test("an answer is spendable only on the action it was given for", async () => {
    const { app, ask, approvals } = await surface();
    const asked = await ask("bot-1");
    await answer(app)("bot-1", asked.approvalId, true);

    const elsewhere = await approvals.consume(
      asked.approvalId,
      fingerprintOf({
        botId: "bot-1",
        toolName: "computer_click",
        ref: "e1",
        pageUrl: SNAPSHOT.url,
      }),
    );
    expect(elsewhere.ok).toBe(false);
  });
});

/**
 * "And stop asking me about this."
 *
 * The interesting failures here are all about the gap between what a person was shown and what the
 * press actually did: a scope taken from the request instead of the record, a widening that never
 * takes effect, one that cannot be taken back, and a trail that reports it as an ordinary answered
 * question. Each has its own test, because each fails silently in a different direction.
 */
describe("answering with always", () => {
  test("stops the same question being asked again", async () => {
    const { app, ask, gateway, calls } = await surface();
    const asked = await ask("bot-1");
    expect(
      await answer(app)("bot-1", asked.approvalId, true, { always: true }),
    ).toHaveProperty("status", 200);

    // A fresh action, presenting nothing. Without the allowance this raises a second question; the
    // approval it was answered with is bound to one action and cannot be spent on this one.
    await gateway.click("bot-1", "bot-1", DRIVER, { ref: "e9", snapshotId: 7 });
    expect(calls).toEqual(["click"]);
  });

  test("covers what the question said it would and no more", async () => {
    const { app, ask, standing } = await surface();
    const asked = await ask("bot-1");
    await answer(app)("bot-1", asked.approvalId, true, { always: true });

    // The site the click was on, which is what the card's button was allowed to say. Not the ref,
    // which belongs to one snapshot, and not everything.
    const [granted] = await standing.list("bot-1");
    expect(granted?.scopeKind).toBe("host");
    expect(granted?.scopeValue).toBe("example.com");
    expect(granted?.rule).toBe('contains(element.name, "submit")');
    expect(granted?.grantedBy).toBe(MANAGER.id);
    // The facts they were reading, kept so the list can say it back to them later. This asserted
    // `question` against `question` until the sentence became a subject (migration 0026) — two
    // fields that no longer exist on either side, so it was `undefined` matching `undefined` and
    // the row could have been stored with no subject at all without this noticing.
    expect(granted?.subject).toEqual(asked.subject);
  });

  test("the body cannot name its own scope", async () => {
    const { app, ask, standing } = await surface();
    const asked = await ask("bot-1");
    // A page that could widen its own grant would make the button a lie: shown one site, granted
    // every tool. The scope comes off the approval the server raised, so this is simply ignored.
    await answer(app)("bot-1", asked.approvalId, true, {
      always: true,
      scope: { kind: "tool", value: "computer_click" },
    });

    const [granted] = await standing.list("bot-1");
    expect(granted?.scopeKind).toBe("host");
    expect(granted?.scopeValue).toBe("example.com");
  });

  test("a denial never grants anything, whatever the body says", async () => {
    const { app, ask, standing } = await surface();
    const asked = await ask("bot-1");
    // There is no "always deny": a thing that should never happen belongs in the boundary, not
    // buried in an allowance table. Sending both must not produce a grant.
    await answer(app)("bot-1", asked.approvalId, false, { always: true });
    expect(await standing.list("bot-1")).toEqual([]);
  });

  test("plain yes leaves nothing standing", async () => {
    const { app, ask, standing } = await surface();
    const asked = await ask("bot-1");
    await answer(app)("bot-1", asked.approvalId, true);
    expect(await standing.list("bot-1")).toEqual([]);
  });

  test("the trail records the widening as its own act", async () => {
    const { app, ask, rows } = await surface();
    const asked = await ask("bot-1");
    await answer(app)("bot-1", asked.approvalId, true, { always: true });

    // Two rows, not one with a flag: the answer, and the edit to the boundary that followed it. A
    // reader counting grants must not have to know that some of them authorised everything after.
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval.requested",
      "approval.granted",
      "approval.standing_granted",
    ]);
    const widening = rows[2]?.payload as Record<string, unknown>;
    expect(widening.scope).toBe("host=example.com");
    expect(widening.bot).toBe("bot-1");
    expect(widening.actor).toBe(MANAGER.id);
    // Joined to the question it came from, so the trail reads in order rather than as two facts.
    expect(widening.approval).toBe(asked.approvalId);
  });
});

describe("taking an allowance back", () => {
  test("lists what stands and withdraws it", async () => {
    const { app, ask, gateway, calls } = await surface();
    const asked = await ask("bot-1");
    await answer(app)("bot-1", asked.approvalId, true, { always: true });

    const listed = (await (await app.request("/standing")).json()) as {
      standing: Array<{ id: string; scopeValue: string }>;
    };
    expect(listed.standing).toHaveLength(1);
    expect(listed.standing[0]?.scopeValue).toBe("example.com");

    const removed = await app.request(`/standing/${listed.standing[0]?.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    // And the boundary is back: the next action asks again rather than going through.
    const again = await gateway
      .click("bot-1", "bot-1", DRIVER, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);
    expect(again).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
  });

  test("withdrawing twice is a conflict rather than a second withdrawal", async () => {
    const { app, ask, standing } = await surface();
    const asked = await ask("bot-1");
    await answer(app)("bot-1", asked.approvalId, true, { always: true });
    const [granted] = await standing.list("bot-1");

    expect(
      (await app.request(`/standing/${granted?.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(
      (await app.request(`/standing/${granted?.id}`, { method: "DELETE" }))
        .status,
    ).toBe(409);
  });

  test("the trail records the withdrawal too", async () => {
    const { app, ask, standing, rows } = await surface();
    const asked = await ask("bot-1");
    await answer(app)("bot-1", asked.approvalId, true, { always: true });
    const [granted] = await standing.list("bot-1");
    await app.request(`/standing/${granted?.id}`, { method: "DELETE" });

    const last = rows.at(-1);
    expect(last?.eventType).toBe("approval.standing_revoked");
    expect(last?.payload.scope).toBe("host=example.com");
  });

  test("neither list nor withdrawal is open to somebody who is not the owner", async () => {
    // The same rule answering has. This list is where a boundary has been stood down, so reading it
    // is reading which parts of the policy are not in force.
    const approvals = createApprovalRegistry();
    const standing = createStandingApprovalStore();
    const asBystander: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", BYSTANDER);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createApprovalRoutes(
        approvals,
        { insert: async () => {} },
        asBystander,
        standing,
      ),
    );
    const granted = await standing.grant({
      botId: "bot-1",
      rule: "r",
      scope: { kind: "host", value: "example.com" },
      subject: A_CLICK,
      grantedBy: MANAGER.id,
    });

    expect((await app.request("/standing")).status).toBe(403);
    expect(
      (await app.request(`/standing/${granted.id}`, { method: "DELETE" }))
        .status,
    ).toBe(403);
    // And nothing was withdrawn on the way to being refused.
    expect(await standing.list("bot-1")).toHaveLength(1);
  });

  test("a Bot called standing is a Bot, not the allowance list", async () => {
    // Hono matches in registration order, so `/standing` has to be registered before `/:botId`.
    // Registered the other way round this returns that Bot's open questions under the key
    // `approvals`, and nothing anywhere looks wrong.
    const { app } = await surface();
    const body = (await (await app.request("/standing")).json()) as Record<
      string,
      unknown
    >;
    expect(body).toHaveProperty("standing");
    expect(body).not.toHaveProperty("approvals");
  });
});

/**
 * The whole path, end to end, on the seam this wave changed.
 *
 * A governed click raises the question, a room turn holds for it, a person answers on the route, and
 * the held turn resumes. Nothing polls anything: the registry, the gateway, the routes and the
 * waiter are one process, which is the deployment (docs/laf/deployment-model.md). Before this, the
 * same journey ran a DELETE and a SELECT against `computer_approvals` every second for up to two
 * minutes and resumed up to a second after the button was pressed. The clock never moves in these
 * two tests, so a waiter that polled could not pass either of them.
 */
describe("a room turn held on a question, and let go by an answer", () => {
  /** Settled or not, decided without letting a timer run. */
  const settled = async <T>(promise: Promise<T>) =>
    await Promise.race([
      promise.then(() => true),
      Promise.resolve().then(() => false),
    ]);

  test("resumes on the answer, and the grant then spends on the very action", async () => {
    const { app, approvals, ask, gateway, calls, rows } = await surface();
    const wait = createApprovalWaiter(approvals);
    const asked = await ask("bot-1");
    expect(calls).toEqual([]);

    const held = wait("bot-1", asked.approvalId);
    expect(await settled(held)).toBe(false);

    expect((await answer(app)("bot-1", asked.approvalId, true)).status).toBe(
      200,
    );
    expect(await held).toBe("granted");

    // And the turn does what it was holding to do, with the id it was holding.
    await gateway.click(
      "bot-1",
      "bot-1",
      DRIVER,
      { ref: "e9", snapshotId: 7 },
      undefined,
      asked.approvalId,
    );
    expect(calls).toEqual(["click"]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval.requested",
      "approval.granted",
      "computer.action_allowed",
    ]);
  });

  test("resumes on a refusal too, and the click never happens", async () => {
    const { app, approvals, ask, calls } = await surface();
    const wait = createApprovalWaiter(approvals);
    const asked = await ask("bot-1");

    const held = wait("bot-1", asked.approvalId);
    expect((await answer(app)("bot-1", asked.approvalId, false)).status).toBe(
      200,
    );
    expect(await held).toBe("denied");
    expect(calls).toEqual([]);
  });
});

/*
 * THE MIDDLE ANSWER ON THE SURFACE. The card's third button sends `tier: "thread"`, and what that
 * binds to is read off the question the server raised — the thread the click came from — never off
 * the body. A question raised from outside any conversation cannot be answered that way at all.
 */
describe("answering with for this conversation", () => {
  const THREAD = "thread-42";
  /** The same driver, in a conversation. */
  const IN_CHAT = { ...DRIVER, threadId: THREAD };

  const askFrom = async (
    gateway: Awaited<ReturnType<typeof surface>>["gateway"],
    actor: typeof DRIVER | typeof IN_CHAT,
  ) =>
    (await gateway
      .click("bot-1", "bot-1", actor, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

  test("the question says a conversation is on offer only when it came from one", async () => {
    const { gateway, approvals } = await surface();
    const fromChat = await askFrom(gateway, IN_CHAT);
    expect(fromChat.threadId).toBe(THREAD);
    // And the list a surface polls says the same, since a card may be drawn from either.
    const listed = await approvals.pending("bot-1");
    expect(listed.map((one) => one.threadId)).toEqual([THREAD]);

    const fromNowhere = await askFrom(gateway, DRIVER);
    expect(fromNowhere.threadId).toBeUndefined();
  });

  test("grants an allowance bound to that conversation, and the trail says so", async () => {
    const { app, gateway, standing, rows, calls } = await surface();
    const asked = await askFrom(gateway, IN_CHAT);
    expect(
      (await answer(app)("bot-1", asked.approvalId, true, { tier: "thread" }))
        .status,
    ).toBe(200);

    const [granted] = await standing.list("bot-1");
    expect(granted?.tier).toBe("thread");
    expect(granted?.threadId).toBe(THREAD);
    expect(granted?.scopeKind).toBe("host");
    expect(granted?.scopeValue).toBe("example.com");
    expect(granted?.expiresAt).toBeDefined();

    const widening = rows.at(-1)?.payload as Record<string, unknown>;
    expect(rows.at(-1)?.eventType).toBe("approval.standing_granted");
    expect(widening.tier).toBe("thread");
    expect(widening.thread).toBe(THREAD);
    expect(widening.expiresAt).toBe(granted?.expiresAt);
    expect(widening.approval).toBe(asked.approvalId);

    // The next click in the same conversation goes through on it, and the action's own row names
    // the kind of allowance that answered.
    await gateway.click("bot-1", "bot-1", IN_CHAT, {
      ref: "e9",
      snapshotId: 7,
    });
    expect(calls).toEqual(["click"]);
    const action = rows.at(-1)?.payload as {
      decision: Record<string, unknown>;
    };
    expect(rows.at(-1)?.eventType).toBe("computer.action_allowed");
    expect(action.decision.allowance).toBe(granted?.id);
    expect(action.decision.allowanceTier).toBe("thread");

    // And the same click from a different conversation is asked again.
    const elsewhere = await askFrom(gateway, {
      ...DRIVER,
      threadId: "thread-43",
    });
    expect(elsewhere).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual(["click"]);
  });

  test("a question raised from nowhere cannot be answered for a conversation", async () => {
    const { app, gateway, standing } = await surface();
    const asked = await askFrom(gateway, DRIVER);
    // The card did not offer the button; a body that asks anyway gets its once and no allowance —
    // not a standing one it never asked for.
    expect(
      (await answer(app)("bot-1", asked.approvalId, true, { tier: "thread" }))
        .status,
    ).toBe(200);
    expect(await standing.list("bot-1")).toEqual([]);
  });

  test("the body cannot name the conversation", async () => {
    const { app, gateway, standing } = await surface();
    const asked = await askFrom(gateway, IN_CHAT);
    await answer(app)("bot-1", asked.approvalId, true, {
      tier: "thread",
      threadId: "somebody-elses-thread",
    });
    const [granted] = await standing.list("bot-1");
    expect(granted?.threadId).toBe(THREAD);
  });

  test("a denial grants nothing for the conversation either", async () => {
    const { app, gateway, standing } = await surface();
    const asked = await askFrom(gateway, IN_CHAT);
    await answer(app)("bot-1", asked.approvalId, false, { tier: "thread" });
    expect(await standing.list("bot-1")).toEqual([]);
  });

  test("is listed with its clock and can be taken back like the standing kind", async () => {
    const { app, gateway, standing, rows } = await surface();
    const asked = await askFrom(gateway, IN_CHAT);
    await answer(app)("bot-1", asked.approvalId, true, { tier: "thread" });

    const listed = await app.request("/standing");
    const body = (await listed.json()) as {
      standing: {
        id: string;
        tier: string;
        threadId?: string;
        expiresAt?: string;
      }[];
    };
    expect(body.standing).toHaveLength(1);
    expect(body.standing[0]?.tier).toBe("thread");
    expect(body.standing[0]?.threadId).toBe(THREAD);
    expect(body.standing[0]?.expiresAt).toBeDefined();

    const withdrawn = await app.request(`/standing/${body.standing[0]?.id}`, {
      method: "DELETE",
    });
    expect(withdrawn.status).toBe(200);
    expect(await standing.list("bot-1")).toEqual([]);
    const revoked = rows.at(-1)?.payload as Record<string, unknown>;
    expect(rows.at(-1)?.eventType).toBe("approval.standing_revoked");
    expect(revoked.tier).toBe("thread");
    expect(revoked.thread).toBe(THREAD);
  });
});

/**
 * The Bot in these two addresses is the id an audit row is written against and the key a question
 * is looked up under. Nothing here joins it to a path, unlike the computer's own routes — but an id
 * this deployment could never have minted has no business doing either. One shape, both hops.
 */
describe("the Bot an approval address names", () => {
  test("a path where a Bot should be is refused on both routes", async () => {
    const { app, rows } = await surface();
    const before = rows.length;

    const listed = await app.request("/..%2F..%2Fetc");
    expect(listed.status).toBe(400);
    expect(await listed.json()).toEqual({
      error: "laf:bot_id_invalid",
      code: "laf:bot_id_invalid",
    });

    const answered = await answer(app)("..%2F..%2Fetc", "approval-1", true);
    expect(answered.status).toBe(400);
    expect(await answered.json()).toEqual({
      error: "laf:bot_id_invalid",
      code: "laf:bot_id_invalid",
    });

    // Refused before anything was looked up or written about it.
    expect(rows).toHaveLength(before);
  });
});
