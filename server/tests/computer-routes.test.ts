import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerClient } from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import { createPolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import type { HumanInput, SnapshotResult } from "../src/computer/schema";

/**
 * The computer's routes, exercised as the browser reaches them.
 *
 * Nothing did, until this file. Everything under `computer/` was tested at the gateway, which is
 * where the decisions are — and the three things fixed here are all things only a route can get
 * wrong: who may press the most destructive button in the product, whether a request body can
 * choose which handler it lands in, and whether a change to the boundary itself leaves a trail.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [{ ref: "e9", role: "button", name: "Submit order" }],
};

const ADMIN = {
  id: "manager-user",
  email: "manager@laf.test",
  role: "admin",
} as const;

const STAFF = {
  id: "staff-user",
  email: "staff@laf.test",
  role: "user",
} as const;

function fakeClient() {
  const calls: string[] = [];
  /** What `humanInput` was actually handed, which is the whole question in one of these tests. */
  const human: HumanInput[] = [];
  const client = {
    snapshot: async () => SNAPSHOT,
    resetComputer: async () => {
      calls.push("resetComputer");
      return { botId: "bot-1", state: "stopped" as const } as never;
    },
    stopComputer: async () => {
      calls.push("stopComputer");
      return { wasRunning: true } as never;
    },
    humanInput: async (input: HumanInput) => {
      human.push(input);
      return { action: "human_click", characters: 0 } as never;
    },
    supplySecret: async () => {
      calls.push("supplySecret");
      return { characters: 7 } as never;
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  return { client, calls, human };
}

function surface(actor: typeof ADMIN | typeof STAFF) {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const { client, calls, human } = fakeClient();
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => ({ deny: [], ask: [], allow: ["true"] }),
  });
  const policyStore = createPolicyStore({ deny: [], ask: [], allow: ["true"] });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createComputerRoutes(
      client,
      gateway,
      policyStore,
      requireUser,
      undefined,
      undefined,
      auditStore,
    ),
  );
  return { app, calls, human, rows, policyStore };
}

describe("wiping a computer", () => {
  /*
   * THE MOST DESTRUCTIVE BUTTON IN THE PRODUCT sat behind the same guard as reading a screenshot.
   * It deletes every login on the one browser all of this account's Bots share, and there is no
   * undo — the person who has to be able to press it is the one who decides what the deployment
   * does, not everyone who can watch a Bot work.
   */
  test("is refused to somebody who is not an administrator", async () => {
    const { app, calls } = surface(STAFF);

    const response = await app.request("/bot-1/computers/reset", {
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("is allowed to an administrator, and recorded", async () => {
    const { app, calls, rows } = surface(ADMIN);

    const response = await app.request("/bot-1/computers/reset", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["resetComputer"]);
    expect(rows.map((row) => row.eventType)).toEqual(["computer.reset"]);
  });

  test("stopping stays open to anybody who can drive the Bot", async () => {
    // Stopping costs somebody the page they were on. It is the recovery path for a Bot that has got
    // stuck, and locking it behind an administrator would leave the person watching it unable to
    // stop it.
    const { app, calls } = surface(STAFF);
    expect(
      (await app.request("/bot-1/computers/stop", { method: "POST" })).status,
    ).toBe(200);
    expect(calls).toEqual(["stopComputer"]);
  });
});

describe("a person's own mouse and keyboard", () => {
  test("cannot be rerouted into the secret path by the request body", async () => {
    /*
     * The body used to be spread AFTER the validated `kind`, so `{"kind":"secret"}` overwrote the
     * one the route had just checked: a person's ordinary input became a secret being supplied, on
     * a path this route does not audit and whose whole design is that there is exactly one door
     * into it. `kind` goes last now, and the URL decides.
     */
    const { app, human, calls } = surface(ADMIN);

    const response = await app.request("/bot-1/human/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "secret", text: "hunter2", x: 1, y: 2 }),
    });

    expect(response.status).toBe(200);
    expect(human).toHaveLength(1);
    expect(human[0]?.kind).toBe("click");
    // And nothing went down the secret path, which is the thing that must have exactly one door.
    expect(calls).not.toContain("supplySecret");
  });

  test("still refuses a kind the URL does not name", async () => {
    const { app, human } = surface(ADMIN);
    const response = await app.request("/bot-1/human/secretly", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1, y: 2 }),
    });
    expect(response.status).toBe(400);
    expect(human).toEqual([]);
  });
});

describe("changing the boundary", () => {
  const POLICY = {
    deny: [],
    ask: ['intent == "activate"'],
    allow: ["true"],
    settleWithoutAsking: "off" as const,
  };

  test("is refused to somebody who is not an administrator", async () => {
    const { app, policyStore } = surface(STAFF);

    const response = await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(POLICY),
    });

    expect(response.status).toBe(403);
    // And the guard ran before the handler did: nothing was saved on the way to being refused.
    expect(policyStore.get().ask).toEqual([]);
  });

  test("reading it is refused too", async () => {
    const { app } = surface(STAFF);
    expect((await app.request("/policy")).status).toBe(403);
  });

  test("records who changed it and why, and what the switch is now", async () => {
    /*
     * `settleWithoutAsking` is the one control that decides whether anybody sees an action at all.
     * The table holds what is in force and who saved it last, which answers "what are the rules"
     * and never "what was the argument for loosening them" — so the reason goes in the trail, where
     * the next save cannot overwrite it.
     */
    const { app, rows } = surface(ADMIN);

    const response = await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...POLICY,
        reason: "정산 기간이라 사람이 직접 본다",
      }),
    });

    expect(response.status).toBe(200);
    const row = rows.find((one) => one.eventType === "computer.policy_changed");
    expect(row?.payload).toMatchObject({
      actor: "manager@laf.test",
      reason: "정산 기간이라 사람이 직접 본다",
      settleWithoutAsking: "off",
      settleWithoutAskingWas: "allowed",
      ask: 1,
    });
  });

  test("does not claim the switch moved when only a rule changed", async () => {
    // A row for every rule edit saying the switch is on would bury the few rows where somebody
    // actually moved it, which are the ones an investigator is looking for.
    const { app, rows } = surface(ADMIN);

    await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deny: ["submit"], ask: [], allow: ["true"] }),
    });

    const row = rows.find((one) => one.eventType === "computer.policy_changed");
    expect(row?.payload).not.toHaveProperty("settleWithoutAskingWas");
  });

  test("does not keep the reason in the policy it enforces", async () => {
    // The reason is a fact about the change, not a rule. A policy that carried it would put it in
    // front of the evaluator and on every read of the Boundaries page.
    const { app, policyStore } = surface(ADMIN);

    await app.request("/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...POLICY, reason: "왜냐하면" }),
    });

    expect(policyStore.get()).not.toHaveProperty("reason");
    expect(policyStore.get().settleWithoutAsking).toBe("off");
  });
});
