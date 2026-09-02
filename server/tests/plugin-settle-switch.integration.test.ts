import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import {
  createPluginStore,
  PluginNeedsApprovalError,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * THE ONE SWITCH, ON THE PATH THAT IS NOT THE BROWSER.
 *
 * `settleWithoutAsking: "off"` is the deployment saying every action of this kind gets a pair of
 * human eyes: no standing allowance may answer for a person, and no question goes out carrying a
 * scope, because there is nothing left to grant. CLAUDE.md makes it one switch on purpose — a
 * boundary with two ways to be stood down is a boundary somebody will stand down by accident.
 *
 * The computer's gateway has been tested against it since it existed. The MCP path had not: its
 * neighbouring test in `plugin-store.integration.test.ts` asks about a tool call and never sets the
 * switch, so a copy of `askBecause` that read only the standing store would have passed everything.
 * That is not a hypothetical shape — the two paths reached the same decision through two different
 * functions until they were joined, and this test is what stops them drifting apart again.
 *
 * A SEPARATE FILE, and against the public `PluginStore` alone, so it survives the store being split
 * across files: nothing here imports an internal.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_settle_${suite}`;
const serverId = `settletest-${suite}`;
const toolName = "search_things";
const ref = `${serverId}/${toolName}`;
const RULE = `mcp.server == "${serverId}"`;

/** Swapped per test, the way a deployment's saved policy is read fresh on every call. */
let policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

const approvals = createApprovalRegistry();
const standing = createStandingApprovalStore();

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null } as never,
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  approvals,
  standing,
  // Injected to fail rather than left to the network: what is under test is whether the call gets
  // past the boundary, and an attempt that then fails proves that as well as one that succeeds.
  callVendor: async () => {
    throw new Error("the test vendor is unreachable");
  },
});

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Settle switch test server",
      vendor: "mcp.test.invalid",
      url: "https://mcp.test.invalid/mcp",
      provenance: "custom",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: toolName,
      description: "Search things.",
      // Read-only under the LAF contract, so no guard floor of its own gets in the way and the rule
      // being tested is the only thing deciding.
      annotations: { readOnlyHint: true },
    })
    .onConflictDoNothing();
  await store.grant("mcp", ref, botId, "admin@laf.local");
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

/** The allowance a person granted the last time they were asked about this tool. */
async function grantStanding() {
  return standing.grant({
    botId,
    rule: RULE,
    scope: { kind: "tool", value: ref },
    // Facts, not a sentence. `question` has not been a field since migration 0026; it was dropped
    // on the way into the row, so this fixture granted an allowance with no subject on it.
    subject: {
      kind: "tool",
      intent: "call_tool",
      tool: { server: serverId, name: toolName },
      reason: "policy_ask",
    },
    grantedBy: "owner@laf.local",
  });
}

async function callAndCatch() {
  return store
    .callTool({
      ref,
      args: { query: "open bugs" },
      botId,
      actorId: "someone@laf.local",
    })
    .catch((error: unknown) => error);
}

async function questionsAsked() {
  const rows = await database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "mcp_tool"),
        eq(auditEvents.targetId, ref),
        eq(auditEvents.eventType, "approval.requested"),
      ),
    );
  return rows.map((row) => row.payload as { approval?: string });
}

describe("a standing allowance on a tool call", () => {
  test("answers for the person while the switch is where it ships", async () => {
    // The control. Without it, the test below passes on a deployment where allowances never worked.
    policy = { deny: [], ask: [RULE], allow: ["true"] };
    const granted = await grantStanding();

    const thrown = await callAndCatch();

    expect(thrown).not.toBeInstanceOf(PluginNeedsApprovalError);
    // It got past the boundary and died at the vendor, which is the injected failure.
    expect((thrown as Error).message).toContain("vendor is unreachable");
    expect(granted.grantedBy).toBe("owner@laf.local");
  });

  test("is ignored with settleWithoutAsking off, and the call asks instead", async () => {
    policy = {
      deny: [],
      ask: [RULE],
      allow: ["true"],
      settleWithoutAsking: "off",
    };
    // The same allowance is still standing and has not been revoked — the switch is the only thing
    // that changed between this test and the one above.
    const granted = await grantStanding();
    expect(await standing.find(botId, RULE, `tool=${ref}`)).toMatchObject({
      id: granted.id,
    });

    const before = (await questionsAsked()).length;
    const thrown = await callAndCatch();

    expect(thrown).toBeInstanceOf(PluginNeedsApprovalError);
    const asked = thrown as PluginNeedsApprovalError;
    expect(asked.rule).toBe(RULE);
    /*
     * AND THE QUESTION CARRIES NO SCOPE.
     *
     * A card offering "always allow" on a deployment that has switched allowances off would be a
     * control that saves and does nothing — the worst kind, because the person believes they have
     * answered for good and are asked again the next minute.
     */
    expect(asked.scope).toBeUndefined();
    // A real question was opened and recorded, not merely an error thrown.
    const after = await questionsAsked();
    expect(after.length).toBe(before + 1);
    expect(after.some((row) => row.approval === asked.approvalId)).toBe(true);
  });

  test("a question raised with the switch on does carry one", async () => {
    /*
     * The other half of the assertion above, and the reason it is not vacuous: with the switch where
     * it ships, an unanswered question arrives with the scope an "always allow" button would grant.
     * A rule of its own, so nothing is standing against it.
     */
    const other = `mcp.tool == "${toolName}"`;
    policy = { deny: [], ask: [other], allow: ["true"] };

    const thrown = await callAndCatch();

    expect(thrown).toBeInstanceOf(PluginNeedsApprovalError);
    expect((thrown as PluginNeedsApprovalError).scope).toEqual({
      kind: "tool",
      value: ref,
    });
  });

  test("and the switch back on lets the same allowance answer again", async () => {
    // The allowance was never revoked, so this is the switch and nothing else: a test that left the
    // policy off would have proved only that a revoked allowance does not answer.
    policy = { deny: [], ask: [RULE], allow: ["true"] };

    const thrown = await callAndCatch();

    expect(thrown).not.toBeInstanceOf(PluginNeedsApprovalError);
    expect((thrown as Error).message).toContain("vendor is unreachable");
  });
});
