import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AccountDeletion } from "../src/account/deletion";
import type { AccountExport } from "../src/account/export";
import { retentionDays } from "../src/account/retention";
import { createAccountRoutes } from "../src/account/routes";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";

/**
 * The three routes, as the browser reaches them.
 *
 * The thing only the handler can get wrong is who is allowed to press what: an administrator
 * deleting their own account through the list of people, and a confirmation that passes on the
 * wrong string. Neither is visible from the deletion module's own tests, because by the time it is
 * called the decision has already been made.
 */

const OWNER = {
  id: "owner-user",
  email: "Owner@Laf.Test",
  role: "user",
} as const;

const ADMIN = {
  id: "admin-user",
  email: "admin@laf.test",
  role: "admin",
} as const;

function surface(actor: typeof OWNER | typeof ADMIN) {
  const rows: AuditEventInput[] = [];
  const deleted: Array<{ userId: string; by: string }> = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const exporter: AccountExport = {
    stream: (userId) =>
      new Response(JSON.stringify({ accountId: userId }))
        .body as ReadableStream<Uint8Array>,
  };
  const deletion: AccountDeletion = {
    delete: async ({ userId, by }) => {
      deleted.push({ userId, by });
      return {
        deleted: userId !== "already-gone",
        pseudonym: "deleted-abc",
        counts: { user: 1 },
        computers: { reset: [], failed: [], configured: false },
      };
    },
  };
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/api",
    createAccountRoutes({ exporter, deletion, auditStore }, requireUser),
  );
  return { app, rows, deleted };
}

describe("the export route", () => {
  test("hands back an attachment and records that it was asked for", async () => {
    const { app, rows } = surface(OWNER);
    const response = await app.request("/api/me/export");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="laf-export-',
    );
    // Nothing between here and the browser gets to keep a copy of somebody's whole account.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await response.text())).toEqual({
      accountId: OWNER.id,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("account.exported");
    expect(rows[0]?.actorUserId).toBe(OWNER.id);
  });
});

describe("leaving", () => {
  test("refuses with a code when nothing was typed, and names what it expects", async () => {
    const { app, deleted } = surface(OWNER);
    const response = await app.request("/api/me/delete", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("laf:account_confirmation_required");
    expect(body.expects).toBe(OWNER.email);
    expect(deleted).toEqual([]);
  });

  test("refuses the wrong address", async () => {
    const { app, deleted } = surface(OWNER);
    const response = await app.request("/api/me/delete", {
      method: "POST",
      body: JSON.stringify({ confirm: "somebody.else@laf.test" }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe(
      "laf:account_confirmation_mismatch",
    );
    expect(deleted).toEqual([]);
  });

  test("accepts the address whatever case it was typed in", async () => {
    // The address on the account is `Owner@Laf.Test`. Nobody types that, and refusing them their
    // own account over a capital letter would be a boundary that is only strict about the wrong
    // thing.
    const { app, deleted } = surface(OWNER);
    const response = await app.request("/api/me/delete", {
      method: "POST",
      body: JSON.stringify({ confirm: "  owner@laf.test " }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deleted: true,
      counts: { user: 1 },
    });
    expect(deleted).toEqual([{ userId: OWNER.id, by: OWNER.id }]);
  });
});

describe("an administrator removing somebody", () => {
  test("refuses a non-administrator", async () => {
    const { app, deleted } = surface(OWNER);
    const response = await app.request("/api/admin/users/someone/delete", {
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(deleted).toEqual([]);
  });

  test("refuses to delete the administrator's own account", async () => {
    const { app, deleted } = surface(ADMIN);
    const response = await app.request(`/api/admin/users/${ADMIN.id}/delete`, {
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("laf:account_self_via_admin");
    expect(deleted).toEqual([]);
  });

  test("removes somebody else, with no phrase to type", async () => {
    const { app, deleted } = surface(ADMIN);
    const response = await app.request("/api/admin/users/someone/delete", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(deleted).toEqual([{ userId: "someone", by: ADMIN.id }]);
  });

  test("answers 404 for an account that is already gone", async () => {
    const { app } = surface(ADMIN);
    const response = await app.request("/api/admin/users/already-gone/delete", {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("laf:account_not_found");
  });
});

describe("how long the trail is kept", () => {
  test("365 unless the deployment says otherwise", () => {
    expect(retentionDays({})).toBe(365);
    expect(retentionDays({ AUDIT_RETENTION_DAYS: "" })).toBe(365);
    expect(retentionDays({ AUDIT_RETENTION_DAYS: "90" })).toBe(90);
  });

  test("zero is a real setting, and means keep everything", () => {
    expect(retentionDays({ AUDIT_RETENTION_DAYS: "0" })).toBe(0);
  });

  test("refuses to start on anything that is not whole days", () => {
    // The same stance AGENT_STALL_TIMEOUT_MS takes: an operator who typed `1y` must not get a
    // running deployment quietly pruning on the built-in number.
    expect(() => retentionDays({ AUDIT_RETENTION_DAYS: "1y" })).toThrow(
      "whole number of days",
    );
    expect(() => retentionDays({ AUDIT_RETENTION_DAYS: "-1" })).toThrow(
      "whole number of days",
    );
    expect(() => retentionDays({ AUDIT_RETENTION_DAYS: "30.5" })).toThrow(
      "whole number of days",
    );
  });
});
