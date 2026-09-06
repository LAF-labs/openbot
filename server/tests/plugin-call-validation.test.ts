import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { createAlimtalkTools } from "../src/plugins/alimtalk/tools";
import { createPartnerConnections } from "../src/plugins/partner-connections";
import {
  createPluginStore,
  PluginNeedsApprovalError,
  PluginRefusedError,
} from "../src/plugins/store";
import type { VendorTransport } from "../src/plugins/transport";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";

/**
 * THE ARGUMENTS ARE LOOKED AT BEFORE THE PERSON IS.
 *
 * Measured on 2026-09-06 against the real stack: `alimtalk_send` is `external`, so a person
 * answers for every call, and it arrived with the wrong blank names. The person approved; the
 * tool refused `laf:alimtalk_variables_missing`; the model retried; the person approved again;
 * refused again. Two approvals spent on a send that could never have gone out, because the first
 * look at the arguments came after the yes.
 *
 * Three claims, each against the public store and the real 알림톡 transport, with a 솔라피 that is
 * a socket on 127.0.0.1 so that nothing here can reach the vendor: a call the connector can tell
 * will fail is refused with the connector's own fact and opens no question; a call that fits
 * reaches the person, so the check swallows nothing; and the advertised schema alone — a
 * `required` field absent, an `enum` value that is not one of them — refuses before any approval
 * on a server with no connector code at all.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_validate_${suite}`;
const actorId = `user_validate_${suite}`;

const ALIMTALK = "kakao-alimtalk";
const SEND_REF = `${ALIMTALK}/alimtalk_send`;

const customId = `validtest-${suite}`;
const TICKET = "create_ticket";
const TICKET_REF = `${customId}/${TICKET}`;

/** Paths the fake vendor was asked for. Expected to stay empty of sends for the whole file. */
const seen: string[] = [];
const vendor = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    seen.push(new URL(request.url).pathname);
    return Response.json({ errorMessage: "nothing here should be reached" });
  },
});

/** How many times the call path handed a call to the transport. Expected to stay at zero. */
let transportCalls = 0;
const alimtalk = createAlimtalkTools(
  createPartnerConnections({
    database,
    auditStore: createAuditStore(database),
  }),
  {
    LAF_ALIMTALK_API_KEY: "TESTKEY01:TESTSECRET02",
    LAF_ALIMTALK_BASE_URL: `http://127.0.0.1:${vendor.port}`,
  },
);
const transport: VendorTransport = {
  ...alimtalk,
  callTool: async (connection, toolName, args) => {
    transportCalls += 1;
    return alimtalk.callTool(connection, toolName, args);
  },
};

/** Swapped per test, the way a deployment's saved policy is read fresh on every call. */
let policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const approvals = createApprovalRegistry();

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: credentialVaultStub({ readSecret: async () => null }),
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  approvals,
  partnerTransports: { [ALIMTALK]: transport },
});

/** Whether this file made the 알림톡 server row, and so whether it is this file's to remove. */
let addedAlimtalkServer = false;

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();

  // The real path a connect takes: the catalogue row, and the tool rows read off this transport.
  const ensured = await store.ensureCatalogueServer({
    key: ALIMTALK,
    by: "admin@laf.local",
  });
  addedAlimtalkServer = ensured.added;
  await store.grant("mcp", SEND_REF, botId, "admin@laf.local");

  await database.insert(mcpServers).values({
    id: customId,
    title: "Argument validation test server",
    vendor: "mcp.test.invalid",
    url: "https://mcp.test.invalid/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values({
    serverId: customId,
    name: TICKET,
    description: "Open a ticket.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["low", "high"] },
      },
      required: ["title"],
    },
    // Read-only under the contract, so no floor of its own: the `ask` rule below is the only
    // thing that could open a question, which is what makes "no question" an assertion.
    annotations: { readOnlyHint: true },
  });
  await store.grant("mcp", TICKET_REF, botId, "admin@laf.local");
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  // Tool rows go with their server.
  await database.delete(mcpServers).where(eq(mcpServers.id, customId));
  if (addedAlimtalkServer) {
    await database.delete(mcpServers).where(eq(mcpServers.id, ALIMTALK));
  }
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
  vendor.stop(true);
});

async function call(ref: string, args: Record<string, unknown>) {
  return store
    .callTool({ ref, args, botId, actorId })
    .catch((error: unknown) => error);
}

/** This Bot's rows of one kind about one tool. Filtered by Bot, since the ref is shared. */
async function trailFor(ref: string, eventType: string) {
  const rows = await database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "mcp_tool"),
        eq(auditEvents.targetId, ref),
        eq(auditEvents.eventType, eventType),
      ),
    );
  return rows
    .map((row) => row.payload as Record<string, unknown>)
    .filter((payload) => payload.bot === botId);
}

/** The questions open for this Bot about one tool. */
async function questionsAbout(toolName: string) {
  return (await approvals.pending(botId)).filter((question) =>
    JSON.stringify(question.subject).includes(toolName),
  );
}

const COMPLETE = {
  to: "010-1111-2222",
  template: "laf_reservation",
  variables: { 상호: "미소상회", 고객명: "김손님", 일시: "3시", 인원: "2" },
};

describe("a partner tool's own checks run before the question", () => {
  test("a send missing a blank is refused with the connector's fact, and nobody is asked", async () => {
    policy = { deny: [], ask: [], allow: ["true"] };

    const thrown = await call(SEND_REF, {
      ...COMPLETE,
      variables: { 상호: "미소상회", 고객명: "김손님" },
    });

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as PluginRefusedError).code).toBe(
      "laf:alimtalk_variables_missing",
    );
    // No question opened, none recorded: the person's attention was not spent.
    expect(await questionsAbout("alimtalk_send")).toHaveLength(0);
    expect(await trailFor(SEND_REF, "approval.requested")).toHaveLength(0);
    // And it is in the trail as the refusal it is.
    const rejected = await trailFor(SEND_REF, "mcp.call_rejected");
    expect(
      rejected.some((row) => row.refusal === "laf:alimtalk_variables_missing"),
    ).toBe(true);
    // The transport was never handed the call, and the vendor never saw a send.
    expect(transportCalls).toBe(0);
    expect(seen).not.toContain("/messages/v4/send");
  });

  test("a number that is not a phone number is refused the same way", async () => {
    const thrown = await call(SEND_REF, { ...COMPLETE, to: "12" });

    expect((thrown as PluginRefusedError).code).toBe(
      "laf:alimtalk_recipient_invalid",
    );
    expect(await questionsAbout("alimtalk_send")).toHaveLength(0);
    expect(transportCalls).toBe(0);
  });

  test("a template the schema does not list is the schema's refusal, ahead of the connector's", async () => {
    const thrown = await call(SEND_REF, { ...COMPLETE, template: "laf_nope" });

    // The `enum` on `template` catches it before the connector is consulted at all.
    expect((thrown as PluginRefusedError).code).toBe(
      "laf:tool_arguments_invalid",
    );
    const rejected = await trailFor(SEND_REF, "mcp.call_rejected");
    expect(
      rejected.some(
        (row) =>
          row.refusal === "laf:tool_arguments_invalid" &&
          row.argument === "template",
      ),
    ).toBe(true);
    expect(await questionsAbout("alimtalk_send")).toHaveLength(0);
  });

  test("with every blank filled, the same call reaches the person", async () => {
    const thrown = await call(SEND_REF, COMPLETE);

    // The floor under an external tool: a question, not a refusal. This is what proves the check
    // above swallows nothing — the only difference between this call and the first is the blanks.
    expect(thrown).toBeInstanceOf(PluginNeedsApprovalError);
    const asked = thrown as PluginNeedsApprovalError;
    expect(asked.subject).toMatchObject({
      kind: "tool",
      tool: { server: ALIMTALK, name: "alimtalk_send", guard: "external" },
      reason: "guard_floor",
    });
    const open = await questionsAbout("alimtalk_send");
    expect(open.map((question) => question.id)).toContain(asked.approvalId);
    // Still nothing sent: the person has not answered.
    expect(transportCalls).toBe(0);
    expect(seen).not.toContain("/messages/v4/send");
  });
});

describe("the advertised schema refuses before any approval", () => {
  test("a missing required argument is refused, and the trail names the argument", async () => {
    // Every call asks. Had validation not run first, this would have opened a question.
    policy = { deny: [], ask: ["true"], allow: ["true"] };

    const thrown = await call(TICKET_REF, { priority: "high" });

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as PluginRefusedError).code).toBe(
      "laf:tool_arguments_invalid",
    );
    const rejected = await trailFor(TICKET_REF, "mcp.call_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      refusal: "laf:tool_arguments_invalid",
      argument: "title",
      tool: TICKET,
    });
    expect(await trailFor(TICKET_REF, "approval.requested")).toHaveLength(0);
    expect(await questionsAbout(TICKET)).toHaveLength(0);
  });

  test("a value outside the enum is refused the same way", async () => {
    const thrown = await call(TICKET_REF, {
      title: "Printer jammed",
      priority: "urgent",
    });

    expect((thrown as PluginRefusedError).code).toBe(
      "laf:tool_arguments_invalid",
    );
    const rejected = await trailFor(TICKET_REF, "mcp.call_rejected");
    expect(rejected.some((row) => row.argument === "priority")).toBe(true);
    expect(await questionsAbout(TICKET)).toHaveLength(0);
  });

  test("a call that fits the schema is asked about, not swallowed", async () => {
    const thrown = await call(TICKET_REF, {
      title: "Printer jammed",
      priority: "high",
    });

    expect(thrown).toBeInstanceOf(PluginNeedsApprovalError);
    expect((thrown as PluginNeedsApprovalError).rule).toBe("true");
    expect(await questionsAbout(TICKET)).toHaveLength(1);
  });

  test("the fact has Korean beside it, so a Bot never reads the bare code", () => {
    // A code missing from the table is handed to the model as itself, which is exactly what
    // happened to every connector code until 2026-09 (see the table's own note).
    const sentence = toolResultText("laf:tool_arguments_invalid");
    expect(sentence).not.toBe("laf:tool_arguments_invalid");
    // It sends the model back to the tool's definition and names no value to fill in.
    expect(sentence).toContain("지어내지");
  });
});
