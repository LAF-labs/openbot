/**
 * The consent pin, end to end against a real database.
 *
 * Three claims, each the contract's own sentence: registration is the consent
 * (first sync lands approved); a definition that changes afterwards loses the
 * consent (paused, refused, re-approvable); and a declaration is believed —
 * read-only runs unasked, everything guarded stops for a person.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { McpTool } from "../src/plugins/mcp";

let toolsOnServer: McpTool[] = [];

mock.module("../src/plugins/mcp", () => ({
  listTools: async () => toolsOnServer,
  callTool: async () => ({ text: "ok", isError: false, truncated: false }),
  McpServerError: class McpServerError extends Error {},
}));

import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import { createDatabase } from "../src/db/client";
import {
  agents,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import {
  createPluginStore,
  PluginNeedsApprovalError,
  PluginRefusedError,
} from "../src/plugins/store";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const readOnly: McpTool = {
  name: "orders.list",
  description: "List orders",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
};
const payout: McpTool = {
  name: "payout.send",
  description: "Send a payout",
  inputSchema: { type: "object" },
  annotations: { "x-laf/effect": "money" },
};

describeDb("plugin definition consent", () => {
  const database = createDatabase(databaseUrl ?? "");
  const serverId = `laf-test-${randomUUID().slice(0, 8)}`;
  const actorId = `user-${randomUUID().slice(0, 8)}`;
  const botId = `bot-${randomUUID().slice(0, 8)}`;
  const store = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: { read: async () => null },
    encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    policy: () => ({ deny: [], ask: [], allow: ["true"] }),
    approvals: createApprovalRegistry(),
  });

  beforeAll(async () => {
    await database.insert(users).values({
      id: actorId,
      name: "Consent Tester",
      email: `${actorId}@test.local`,
      emailVerified: false,
    });
    await database.insert(agents).values({
      id: botId,
      name: "Consent Bot",
      type: "built_in",
      configuration: { systemPrompt: "" },
    });
    await database.insert(mcpServers).values({
      id: serverId,
      title: "Consent Test Server",
      vendor: "test.local",
      url: "https://mcp.test.local/mcp",
      provenance: "custom",
    });
    for (const tool of [readOnly, payout]) {
      await database.insert(pluginGrants).values({
        kind: "mcp",
        ref: `${serverId}/${tool.name}`,
        agentId: botId,
        grantedBy: actorId,
      });
    }
  });

  afterAll(async () => {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database.delete(agents).where(eq(agents.id, botId));
    await database.delete(users).where(eq(users.id, actorId));
  });

  test("registration is the consent: the first sync lands approved", async () => {
    toolsOnServer = [readOnly, payout];
    const result = await store.refreshTools(serverId);
    expect(result.tools).toBe(2);
    expect(result.paused ?? 0).toBe(0);
    const rows = await database
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.serverId, serverId));
    expect(rows.every((row) => row.needsReview === false)).toBe(true);
    expect(rows.every((row) => typeof row.definitionHash === "string")).toBe(
      true,
    );
    const stored = rows.find((row) => row.name === readOnly.name);
    expect(stored?.annotations).toEqual({ readOnlyHint: true });
  });

  test("a believed read-only declaration runs without asking anybody", async () => {
    const result = await store.callTool({
      ref: `${serverId}/${readOnly.name}`,
      args: {},
      botId,
      actorId,
    });
    expect(result.isError).toBe(false);
  });

  test("a money declaration stops for a person even though policy allows", async () => {
    await expect(
      store.callTool({
        ref: `${serverId}/${payout.name}`,
        args: { amount: 10 },
        botId,
        actorId,
      }),
    ).rejects.toBeInstanceOf(PluginNeedsApprovalError);
  });

  test("a changed definition loses the consent and is refused until reviewed", async () => {
    toolsOnServer = [
      { ...readOnly, annotations: { readOnlyHint: false } },
      payout,
    ];
    const result = await store.refreshTools(serverId);
    expect(result.paused).toBe(1);

    await expect(
      store.callTool({
        ref: `${serverId}/${readOnly.name}`,
        args: {},
        botId,
        actorId,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const approved = await store.approveToolDefinition(
      serverId,
      readOnly.name,
      actorId,
    );
    expect(approved).toBe(true);

    // Approved as it now is: a declared, non-destructive write. That class has
    // no floor — the written policy decides, and this one allows — so approval
    // restores operation rather than opening a permanent toll gate.
    const restored = await store.callTool({
      ref: `${serverId}/${readOnly.name}`,
      args: {},
      botId,
      actorId,
    });
    expect(restored.isError).toBe(false);
  });

  test("a tool that appears after registration waits for review", async () => {
    toolsOnServer = [
      { ...readOnly, annotations: { readOnlyHint: false } },
      payout,
      {
        name: "orders.export",
        description: "Export",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
    ];
    const result = await store.refreshTools(serverId);
    expect(result.paused).toBe(1);
    const [row] = await database
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.serverId, serverId))
      .then((rows) => rows.filter((r) => r.name === "orders.export"));
    expect(row?.needsReview).toBe(true);
    expect(row?.reviewReason).toBe("appeared after registration");
  });
});
