import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import {
  MCP_RESPONSE_TOO_LARGE,
  MCP_TIMEOUT,
  type McpRefusedError,
} from "../src/plugins/mcp";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";
import { realMcpModule } from "./support/mcp-module";

/**
 * A custom MCP server that answers too much, or not at all, and what this process pays for it.
 *
 * THE HOLE THIS CLOSES. `MAX_RESULT_CHARS` capped what the model was shown and nothing capped what
 * the process held to get there: measured 2026-09-10 (audit A9, F5), one call answered with 50 MB
 * was read and parsed whole — RSS 121 MB to 395 MB — and trimmed to 20 KB afterwards. A server an
 * administrator added can push the API process off a 4.7 GB VM with a handful of concurrent calls.
 * And a server that never answered held the turn for sixty seconds and was then reported to a Bot
 * as "The vendor answered -32001."
 *
 * Driven against a real server through the real SDK client, because the property is about what the
 * HTTP client does with the bytes and a stub of the client cannot have that property. The server is
 * a SEPARATE PROCESS (`support/fake-mcp-server.ts`): measured first with an in-process `Bun.serve`,
 * the server handed every byte to the socket whatever the client did and the test process grew by
 * the whole answer with the cap in place — the answer was on the wrong side of the scale.
 *
 * The RSS assertion is the one that matters. A cap that refused after reading everything would
 * pass every other test here and change nothing. Measured with the server out of process, this
 * process grew +29 MB with the cap and +250 MB without it.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_limits_${suite}`;
const serverId = `limitstest-${suite}`;
const toolName = "dump";
const ref = `${serverId}/${toolName}`;

const MEGABYTE = 1024 * 1024;

/** The fake vendor, in a process of its own, found by the port it prints once it listens. */
let vendor: ReturnType<typeof Bun.spawn> | null = null;
let url = "";

async function spawnVendor(): Promise<string> {
  const child = Bun.spawn(
    ["bun", new URL("./support/fake-mcp-server.ts", import.meta.url).pathname],
    { stdout: "pipe", stderr: "inherit" },
  );
  vendor = child;
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let line = "";
  while (!line.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the fake MCP server exited before listening");
    line += decoder.decode(value);
  }
  const { port } = JSON.parse(line.trim()) as { port: number };
  return `http://127.0.0.1:${port}/mcp`;
}

const policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: credentialVaultStub({}),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => policy,
  approvals: createApprovalRegistry(),
  // No `callVendor`: the real transport is the thing under test.
});

/** Resident set size in megabytes, after a full collection so garbage is not counted as growth. */
const rssMb = (): number => {
  Bun.gc(true);
  return process.memoryUsage().rss / MEGABYTE;
};

beforeAll(async () => {
  // The real transport, whatever another suite left in the registry. See `support/mcp-module.ts`.
  mock.module("../src/plugins/mcp", () => realMcpModule);
  url = await spawnVendor();

  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();
  /*
   * Written directly rather than through `addCustomServer`, which refuses a loopback address on the
   * way in — correctly, and beside the point. No credential: a custom server may need none, and
   * what is under test is what comes BACK.
   */
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Server that answers too much",
      vendor: "127.0.0.1",
      url,
      provenance: "custom",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: toolName,
      description: "Answers according to `mode`.",
      inputSchema: { type: "object", properties: { mode: { type: "string" } } },
      // Declared read-only, so the contract's guard floor does not stop the call with a question.
      annotations: { readOnlyHint: true },
    })
    .onConflictDoNothing();
  await database
    .insert(pluginGrants)
    .values({ kind: "mcp", ref, agentId: botId, grantedBy: "admin@laf.test" })
    .onConflictDoNothing();
});

afterAll(async () => {
  vendor?.kill();
  await database.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agents).where(eq(agents.id, botId));
});

describe("a server that answers with fifty megabytes", () => {
  test("the transport works against this server at all", async () => {
    const result = await realMcpModule.callTool({ url }, toolName, {
      mode: "small",
    });
    expect(result).toMatchObject({ text: "small", isError: false });
  });

  test("is refused with the fact, through the whole call path, and the process does not grow by the answer", async () => {
    const before = rssMb();

    const thrown = await store
      .callTool({
        ref,
        args: { mode: "huge" },
        botId,
        actorId: "someone@laf.test",
      })
      .catch((error: unknown) => error);

    const after = rssMb();

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    // The code, in both fields the route sends: `rule` names the boundary on the surface, `code`
    // is what the model's Korean is looked up by.
    expect((thrown as PluginRefusedError).code).toBe(MCP_RESPONSE_TOO_LARGE);
    expect((thrown as PluginRefusedError).rule).toBe(MCP_RESPONSE_TOO_LARGE);

    /*
     * THE ASSERTION THAT MATTERS. Read whole and trimmed afterwards, this grew the process by the
     * size of the answer: +250 MB measured for 50 MB, the SDK parsing a string it then threw away.
     * Refused as the bytes cross the line, it grows by the cap plus what the runtime had already
     * pulled off a loopback socket before the abort landed: +29 MB measured. The bound is set
     * well under the answer, so a cap that only trimmed AFTER reading cannot pass it.
     */
    expect(after - before).toBeLessThan(50);
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
        (row.payload as { refusal?: string }).refusal ===
          MCP_RESPONSE_TOO_LARGE,
    );
    expect(refused).toHaveLength(1);
    // Filed as a refusal and NOT as a vendor failure: a reader counting outages should not be
    // counting an answer we declined to read.
    expect(rows.some((row) => row.eventType === "mcp.call_failed")).toBe(false);
  });
});

describe("a server that never answers", () => {
  test("is abandoned at the bound with its own fact, not reported as a status", async () => {
    const started = Date.now();

    const thrown = (await realMcpModule
      .callTool({ url }, toolName, { mode: "hang" }, { timeoutMs: 500 })
      .catch((error: unknown) => error)) as McpRefusedError;

    expect(thrown).toBeInstanceOf(realMcpModule.McpTimeoutError);
    expect(thrown.fact).toBe(MCP_TIMEOUT);
    // Not "The vendor answered -32001.": the JSON-RPC code is not an HTTP status, and the sentence
    // was an English misreading handed to a Bot and a person alike.
    expect(thrown.message).not.toContain("-32001");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
