import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRegistry } from "../src/computer/approvals";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { withheldMarksIn } from "../../shared/tools/withheld";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";

/**
 * A MAIL'S ONE-TIME CODE, THROUGH THE REAL CALL PATH: out of what the model reads, onto the owner's
 * screen, and nowhere else — not in the trail, not for another person, not for a routine.
 *
 * The vendor is injected — a mail server an administrator added by URL, answering with a synthetic
 * mail, which is also the case the catalogue cannot name: it is recognised as a mailbox by its own
 * words. The store, the policy, the audit trail and the reveal route are the real ones; Gmail's own
 * entry is named in the catalogue (`mailReadingTools`), which `mail-secrets.test.ts` holds.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_mail_${suite}`;
const actorId = `user_mail_${suite}`;
const SERVER = `mailbox_${suite}`;
const REF = `${SERVER}/read_mail`;
const CODE = "482913";
const RESET =
  "https://accounts.example.test/reset-password?token=Zx9Qm2Lp7Rt4Vw8Ys1Nb5Kc3";

const MAIL = `제목: [셀러센터] 인증번호 안내
보낸사람: noreply@seller.example.test

로그인 인증번호는 ${CODE} 입니다. 3분 안에 입력해 주세요.
비밀번호를 잊으셨다면 비밀번호 재설정: ${RESET}
주문번호 2026092648213 의 배송이 시작되었습니다.`;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: credentialVaultStub({ readSecret: async () => null }),
  encryptionKey: "x".repeat(44),
  policy: () => ({ deny: [], ask: [], allow: ["true"] }),
  approvals: createApprovalRegistry(),
  standing: createStandingApprovalStore(),
  callVendor: async () => ({ text: MAIL, isError: false }),
});

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();
  await database.insert(mcpServers).values({
    id: SERVER,
    title: "Shop mailbox (IMAP bridge)",
    vendor: "mail.test.invalid",
    url: "https://mail.test.invalid/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values({
    serverId: SERVER,
    name: "read_mail",
    description: "Read one mail from the shop's inbox.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string" } },
      required: ["messageId"],
    },
    annotations: { readOnlyHint: true },
  });
  await store.grant("mcp", REF, botId, "admin@laf.local");
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database
    .delete(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "mcp_tool"),
        eq(auditEvents.targetId, REF),
        inArray(auditEvents.eventType, ["mcp.call_allowed", "mcp.call_failed"]),
      ),
    )
    .catch(() => undefined);
  // Tool rows go with their server.
  await database.delete(mcpServers).where(eq(mcpServers.id, SERVER));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

function routesAs(person: string) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: person,
      email: `${person}@laf.test`,
      role: "user",
    });
    context.set("mayDriveBot", async (id) => id === botId);
    await next();
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(store, requireUser),
  );
}

describe("a mail read while the owner watches", () => {
  test("the model reads marks, the owner reads the code, the trail reads neither", async () => {
    const app = routesAs(actorId);
    const response = await app.request("http://t/api/plugins/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: REF,
        args: { messageId: "m1" },
        agentId: botId,
      }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { text: string };
    expect(result.text).not.toContain(CODE);
    expect(result.text).not.toContain("Zx9Qm2Lp7Rt4Vw8Ys1Nb5Kc3");
    // What the owner's mail is for is still there.
    expect(result.text).toContain("2026092648213");

    const marks = withheldMarksIn(result.text);
    expect(marks.map((mark) => mark.kind).sort()).toEqual([
      "code",
      "reset_link",
    ]);
    const code = marks.find((mark) => mark.kind === "code");
    const shown = await app.request(
      `http://t/api/plugins/for/${botId}/withheld/${code?.id}`,
    );
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(((await shown.json()) as { value: string }).value).toBe(CODE);

    // Somebody else holding the same id gets the one answer that says nothing.
    const other = await routesAs(`someone_${suite}`).request(
      `http://t/api/plugins/for/${botId}/withheld/${code?.id}`,
    );
    expect(other.status).toBe(404);

    const trail = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "mcp_tool"),
          eq(auditEvents.targetId, REF),
        ),
      );
    const mine = trail.filter(
      (row) => (row.payload as { bot?: string }).bot === botId,
    );
    expect(mine.length).toBeGreaterThan(0);
    const said = JSON.stringify(mine);
    expect(said).not.toContain(CODE);
    expect(said).toContain('"withheld"');
  });
});

describe("a mail read by a routine", () => {
  test("keeps the code nowhere: the mark has no reference", async () => {
    const result = await store.callTool({
      ref: REF,
      args: { messageId: "m1" },
      botId,
      actorId,
    });
    expect(result.text).not.toContain(CODE);
    expect(withheldMarksIn(result.text).every((mark) => mark.id === null)).toBe(
      true,
    );
  });
});
