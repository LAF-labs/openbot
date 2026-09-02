import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { MCP_REDIRECT_REFUSED } from "../src/plugins/mcp";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";
import { realMcpModule } from "./support/mcp-module";

/**
 * A custom MCP server that answers 302, and the credential that does not go with it.
 *
 * THE HOLE THIS CLOSES. A custom server is an address an administrator typed. It is checked when it
 * is added and never again, and no check on a URL can see where that server will later point a
 * redirect. The MCP transport was built with no `redirect` option, so fetch's default applied and it
 * FOLLOWED one — carrying the Authorization header to whatever the answer named:
 * `http://localhost:4100` is the Bot's own computer, and every RFC1918 address on the deployment's
 * network is reachable from the same process. Every token endpoint in this fork already said
 * `redirect: "manual"`; the one path a MODEL can cause to be walked had been left on the default.
 *
 * Driven against two real local servers rather than a stub, because the property is about what the
 * HTTP client does and a stub of the client cannot have that property. The first answers 302 and
 * points at the second; the second counts what it is asked. Nothing reaching the second is the
 * assertion, and the credential going out to the first is what makes it worth asserting.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const suite = randomUUID().slice(0, 8);
const botId = `agent_redirect_${suite}`;
const serverId = `redirecttest-${suite}`;
const toolName = "search_things";
const ref = `${serverId}/${toolName}`;
const TOKEN = `deployment-token-${suite}`;

/** Everything the destination of the redirect was asked, which must stay empty. */
const arrivedAtTheTarget: { path: string; authorization: string | null }[] = [];
/** Everything the server we agreed to talk to was asked, so the credential can be seen leaving. */
const arrivedAtTheServer: { path: string; authorization: string | null }[] = [];

/**
 * Where a followed redirect would land, standing in for the Bot's computer on `localhost:4100`.
 *
 * It answers a perfectly good MCP-shaped 200, deliberately: if anything here ever starts following
 * redirects again, the call would SUCCEED against this server rather than fail, which is the failure
 * mode worth catching. A target that refused would let a broken build stay green.
 */
const target = Bun.serve({
  port: 0,
  fetch: async (request) => {
    arrivedAtTheTarget.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
    });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "followed" }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
});

/** The address the deployment actually agreed to talk to. It answers by pointing somewhere else. */
const vendor = Bun.serve({
  port: 0,
  fetch: async (request) => {
    arrivedAtTheServer.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"),
    });
    return new Response(null, {
      status: 302,
      headers: { location: `http://127.0.0.1:${target.port}/mcp` },
    });
  },
});

const policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  approvals: createApprovalRegistry(),
  // No `callVendor`: the real transport is the thing under test.
});

let credentialId = "";

beforeAll(async () => {
  /*
   * The real transport, whatever another suite left in the registry.
   *
   * `plugin-consent` stubs `../src/plugins/mcp` process-wide, and bun evaluates every test file
   * before running any test, so without this the subject of this file — what the HTTP client does
   * with a 302 — would be asserted against a stub of the HTTP client, in whichever order the files
   * happen to be listed. See `support/mcp-module.ts`.
   */
  mock.module("../src/plugins/mcp", () => realMcpModule);

  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();

  const [credential] = await database
    .insert(credentialRows)
    .values({
      kind: "mcp",
      provider: serverId,
      keyId: `token-${suite}`,
      encryptedValue: await encryptSecret(ENCRYPTION_KEY, TOKEN),
      metadata: {},
    })
    .returning({ id: credentialRows.id });
  credentialId = credential?.id ?? "";

  /*
   * Written directly rather than through `addCustomServer`, which refuses a loopback address on the
   * way in — correctly, and beside the point. What is under test is a server at an address that
   * PASSED that check and then answered with a redirect, which no check on a URL can anticipate.
   */
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Redirecting server",
      vendor: "127.0.0.1",
      url: `http://127.0.0.1:${vendor.port}/mcp`,
      provenance: "custom",
      credentialId,
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: toolName,
      description: "Search things.",
      // Declared read-only, so the LAF contract's guard floor does not stop the call with a question
      // before it ever reaches the network.
      annotations: { readOnlyHint: true },
    })
    .onConflictDoNothing();
  await database
    .insert(pluginGrants)
    .values({ kind: "mcp", ref, agentId: botId, grantedBy: "admin@laf.test" })
    .onConflictDoNothing();
});

afterAll(async () => {
  vendor.stop(true);
  target.stop(true);
  await database.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agents).where(eq(agents.id, botId));
  if (credentialId) {
    await database
      .delete(credentialRows)
      .where(eq(credentialRows.id, credentialId));
  }
});

describe("a server that answers a call with a redirect", () => {
  test("is refused, and nothing is sent to where it pointed", async () => {
    arrivedAtTheTarget.length = 0;
    arrivedAtTheServer.length = 0;

    const thrown = await store
      .callTool({ ref, args: {}, botId, actorId: "someone@laf.test" })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    // The fact code, so the surface names the boundary from a code rather than from our sentence —
    // the same shape the contract's guard floors use.
    expect((thrown as PluginRefusedError).rule).toBe(MCP_REDIRECT_REFUSED);

    // The credential really was going out, so this is a disclosure that was actually prevented
    // rather than a request that had nothing on it.
    expect(arrivedAtTheServer.length).toBeGreaterThan(0);
    expect(arrivedAtTheServer[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    // And the destination of the redirect heard nothing at all.
    expect(arrivedAtTheTarget).toEqual([]);
  });

  test("the trail records it as this deployment's refusal, with the code", async () => {
    const rows = await database
      .select({
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "mcp_tool"),
          eq(auditEvents.targetId, ref),
        ),
      );

    const refused = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { refusal?: string }).refusal === MCP_REDIRECT_REFUSED,
    );
    expect(refused).toHaveLength(1);
    // The status is kept as well as the code: 302 and 307 are different mistakes for the operator
    // whose server this is, and the row is where they find out which.
    expect(
      (refused[0]?.payload as { status?: number } | undefined)?.status,
    ).toBe(302);
    /*
     * Filed as a refusal and NOT as a vendor failure. "Allowed and then failed" and "we would not do
     * that" are different events, and a reader counting outages should not be counting these.
     */
    expect(
      rows.some(
        (row) =>
          row.eventType === "mcp.call_failed" &&
          (row.payload as { failure?: string }).failure?.includes("302"),
      ),
    ).toBe(false);
  });

  test("a tool listing is refused the same way, and lands in lastError", async () => {
    arrivedAtTheTarget.length = 0;

    const listed = await store.refreshTools(serverId, "admin@laf.test");
    expect(listed.tools).toBe(0);

    const [row] = await database
      .select({ lastError: mcpServers.lastError })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    expect(row?.lastError).toContain("redirect");
    expect(arrivedAtTheTarget).toEqual([]);
  });
});
