import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createAllowanceRoutes } from "../src/computer/allowance-routes";
import type { ActionPolicy } from "../src/computer/policy";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { A_CLICK } from "./support/subjects";

/**
 * The owner's list of what their Bot no longer asks about, on the profile (ux-review-0.5.4 §1.7).
 *
 * Driven through the routes and against the same store the gateway consults, because the two
 * things that matter are only visible there: that a revoke here is the revoke the boundary reads
 * (the next `find` comes back empty), and that it is scoped to the owner's own Bot.
 */

/** The owner, with the role that opens no administrator's door. */
const OWNER = {
  id: "owner-user",
  email: "owner@laf.test",
  role: "user",
} as const;

function mount(policy?: ActionPolicy) {
  const standing = createStandingApprovalStore();
  const audit: AuditEventInput[] = [];
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
    createAllowanceRoutes(
      standing,
      { insert: async (event) => void audit.push(event) },
      requireUser,
      policy ? () => policy : undefined,
    ),
  );
  const grant = (botId: string, host: string) =>
    standing.grant({
      botId,
      rule: "true",
      scope: { kind: "host", value: host },
      subject: { ...A_CLICK, host },
      grantedBy: OWNER.id,
    });
  return { app, standing, audit, grant };
}

describe("what the owner has allowed", () => {
  test("lists this Bot's standing allowances, and says they are in force", async () => {
    const { app, grant } = mount();
    await grant("bot-1", "toss.im");
    await grant("bot-2", "elsewhere.example");
    const response = await app.request("/bot-1/allowances");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      allowances: Array<{ scopeValue: string }>;
      inForce: boolean;
    };
    expect(body.allowances.map((row) => row.scopeValue)).toEqual(["toss.im"]);
    expect(body.inForce).toBe(true);
  });

  test("says when the deployment has switched standing allowances off", async () => {
    const { app } = mount({
      deny: [],
      ask: [],
      allow: ["true"],
      settleWithoutAsking: "off",
    });
    const body = (await (await app.request("/bot-1/allowances")).json()) as {
      inForce: boolean;
    };
    expect(body.inForce).toBe(false);
  });

  test("a revoke is the boundary's revoke, recorded under who pressed it", async () => {
    const { app, standing, audit, grant } = mount();
    const granted = await grant("bot-1", "toss.im");
    const response = await app.request(`/bot-1/allowances/${granted.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    // The store the gateway reads no longer finds it: the next press is asked about again.
    expect(await standing.find("bot-1", "true", "host=toss.im")).toBeNull();
    expect(await standing.list("bot-1")).toEqual([]);
    const row = audit.find(
      (event) => event.eventType === "approval.standing_revoked",
    );
    expect(row?.actorUserId).toBe(OWNER.id);
    expect(row?.payload).toMatchObject({
      allowance: granted.id,
      revokedBy: OWNER.id,
      via: "profile",
    });
    // Twice is "already taken back", not a second record.
    const again = await app.request(`/bot-1/allowances/${granted.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(409);
    expect(audit).toHaveLength(1);
  });

  test("cannot reach another Bot's allowance by naming its id under your own", async () => {
    const { app, standing, audit, grant } = mount();
    const theirs = await grant("bot-2", "elsewhere.example");
    const response = await app.request(`/bot-1/allowances/${theirs.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(409);
    expect((await standing.list("bot-2")).map((row) => row.id)).toEqual([
      theirs.id,
    ]);
    expect(audit).toEqual([]);
  });

  test("a Bot that is not yours is not here", async () => {
    const { app } = mount();
    expect((await app.request("/bot-2/allowances")).status).toBe(404);
  });
});
