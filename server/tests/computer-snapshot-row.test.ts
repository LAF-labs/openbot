import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerClient } from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createPolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import type { SnapshotResult } from "../src/computer/schema";

/**
 * A LOOK AT THE SCREEN THAT COULD NOT SEE ALL OF IT, AND THE ONE ROW IT LEAVES.
 *
 * laf-control's `insights` counts where Bots get stuck by site, and a frame the snapshot could not
 * see into — a payment or 본인인증 window, usually — was the one signal it could not count: the
 * container knew and the trail did not. The row is `computer.action_allowed` with `action:
 * computer_snapshot` and `opaqueFrames`, written only for a look that met one, naming the site by its
 * origin and nothing past it.
 */

const PAGE = "https://shop.example/orders/1042?token=ONE-TIME-7781#pay";

const snapshotWith = (opaqueFrames: number | undefined): SnapshotResult => ({
  snapshotId: 3,
  url: PAGE,
  title: "주문",
  truncated: false,
  elements: [{ ref: "e1", role: "button", name: "결제하기" }],
  ...(opaqueFrames === undefined ? {} : { opaqueFrames }),
});

function gatewaySeeing(
  result: SnapshotResult,
  audit: AuditStore | null = null,
) {
  const rows: AuditEventInput[] = [];
  const client = {
    snapshot: async () => result,
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  const gateway = createComputerGateway({
    client,
    auditStore: audit ?? { insert: async (event) => void rows.push(event) },
    policy: () => ({ deny: [], ask: [], allow: ["true"] }),
  });
  return { gateway, rows, client };
}

const OWNER = { id: "owner-user", userId: "owner-user" };

describe("a snapshot's row", () => {
  test("a look that could not see into two frames leaves one row, with the count and the site's origin", async () => {
    const { gateway, rows } = gatewaySeeing(snapshotWith(2));

    await gateway.snapshot("bot-1", { botId: "bot-1", actor: OWNER });

    expect(rows).toEqual([
      {
        eventType: "computer.action_allowed",
        targetType: "computer",
        targetId: "bot-1",
        actorUserId: "owner-user",
        payload: {
          action: "computer_snapshot",
          bot: "bot-1",
          actor: "owner-user",
          page: "https://shop.example",
          opaqueFrames: 2,
        },
      },
    ]);
    // The host and nothing past it: not the order's path, and never the token in its query.
    const written = JSON.stringify(rows);
    expect(written).not.toContain("/orders");
    expect(written).not.toContain("ONE-TIME-7781");
    // No decision block, because nothing decided a look.
    expect(rows[0]?.payload).not.toHaveProperty("decision");
  });

  test("an ordinary look leaves nothing, and neither does a computer that does not count", async () => {
    for (const opaqueFrames of [0, undefined]) {
      const { gateway, rows } = gatewaySeeing(snapshotWith(opaqueFrames));
      await gateway.snapshot("bot-1", { botId: "bot-1", actor: OWNER });
      expect({ opaqueFrames, rows }).toEqual({ opaqueFrames, rows: [] });
    }
  });

  test("a look with nobody named leaves nothing", async () => {
    const { gateway, rows } = gatewaySeeing(snapshotWith(1));
    await gateway.snapshot("bot-1");
    expect(rows).toEqual([]);
  });

  test("a page that is not a web address names no site", async () => {
    const { gateway, rows } = gatewaySeeing({
      ...snapshotWith(1),
      url: "about:blank",
    });
    await gateway.snapshot("bot-1", { botId: "bot-1", actor: OWNER });
    expect(rows[0]?.payload.page).toBe("");
  });

  test("a trail that cannot be reached costs the row, never the look", async () => {
    const { gateway } = gatewaySeeing(snapshotWith(3), {
      insert: async () => {
        throw new Error("the audit store is unreachable");
      },
    });
    const seen = await gateway.snapshot("bot-1", {
      botId: "bot-1",
      actor: OWNER,
    });
    expect(seen.elements.map((element) => element.name)).toEqual(["결제하기"]);
    expect(seen.opaqueFrames).toBe(3);
  });

  test("the local development actor is named in the payload and kept out of the user column", async () => {
    const { gateway, rows } = gatewaySeeing(snapshotWith(1));
    await gateway.snapshot("bot-1", {
      botId: "bot-1",
      actor: { id: "dev-local-user" },
    });
    expect(rows[0]?.actorUserId).toBeUndefined();
    expect(rows[0]?.payload.actor).toBe("dev-local-user");
  });
});

describe("the snapshot route", () => {
  const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

  test("names who looked, so a Bot's look through the surface leaves its row", async () => {
    const { gateway, rows, client } = gatewaySeeing(snapshotWith(1));
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "owner-user",
        email: "owner@laf.test",
        role: "user",
      });
      context.set("mayDriveBot", async () => true);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createComputerRoutes(
        client,
        gateway,
        createPolicyStore(PERMISSIVE),
        requireUser,
      ),
    );

    const response = await app.request("/bot-1/snapshot", { method: "POST" });

    expect(response.status).toBe(200);
    expect((await response.json()).opaqueFrames).toBe(1);
    expect(rows.map((row) => [row.eventType, row.payload])).toEqual([
      [
        "computer.action_allowed",
        {
          action: "computer_snapshot",
          bot: "bot-1",
          actor: "owner-user",
          page: "https://shop.example",
          opaqueFrames: 1,
        },
      ],
    ]);
    expect(rows[0]?.actorUserId).toBe("owner-user");
  });
});
