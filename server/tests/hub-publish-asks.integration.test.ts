import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  hubOutbox,
  mcpServers,
  pluginGrants,
} from "../src/db/schema";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import { createHubOutbox } from "../src/hub/outbox";
import { createHubToolTransport } from "../src/hub/tools";
import {
  createPluginStore,
  PluginNeedsApprovalError,
  PluginRefusedError,
} from "../src/plugins/store";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";

/**
 * PUBLISHING TO THE COMPANY ASKS THE PERSON FIRST.
 *
 * Found in review, 2026-10-18: 라피's `mcp__hub__write` publishes a team skill every colleague's Bot
 * loads and a line an admin may confirm into every colleague's prompt, and nothing asked the
 * person — the catalogue entry had no floor, and the shipped policy asks only about the browser
 * and about repeats. "Joining a company publishes only what the person picks" rested on a prompt.
 *
 * Against the public store, the real catalogue entry, the real hub transport and a real outbox in
 * Postgres; only the hub at the far end is a recording. What the recording received and which
 * outbox rows exist are the assertions: a question before anything went is an empty recording and
 * no row, not a hope.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_publish_${suite}`;
const actorId = `user_publish_${suite}`;
const REF = "hub/write";

/** What reached the hub. Empty until somebody has said yes. */
const sent: HubRequest[] = [];
const took: HubAnswer<unknown> = { ok: true, status: 201, body: { ok: true } };
const http: HubHttp = {
  async request(request) {
    sent.push(request);
    return took as never;
  },
  socket: () => ({ url: "ws://unused", headers: {} }),
};
const outbox = createHubOutbox({ database, http, sleep: async () => {} });
const hubTools = createHubToolTransport({
  http,
  outbox,
  database,
  // Never resolves: a write's answer comes from the sweep having finished, not from a timer.
  sleep: () => new Promise<void>(() => {}),
});

let policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const SHIPPED_ALLOW: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const approvals = createApprovalRegistry();
const standing = createStandingApprovalStore();

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: credentialVaultStub({ readSecret: async () => null }),
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  approvals,
  standing,
  deploymentKeyTransports: { "laf-hub": hubTools },
});

/** Whether this file made the hub's row, and so whether it is this file's to remove. */
let addedHubServer = false;

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();
  const [existing] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, "hub"))
    .limit(1);
  if (!existing) {
    // What boot does on a VM with a pass (`deployment-key-runtime.ts`): the row, then its tools.
    await store.ensureCatalogueServer({ key: "hub", by: "admin@laf.local" });
    await store.refreshTools("hub");
    addedHubServer = true;
  }
  await store.grant("mcp", REF, botId, "admin@laf.local");
});

afterAll(async () => {
  await database
    .delete(hubOutbox)
    .where(sql`${hubOutbox.body}::text like ${`%${suite}%`}`);
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  if (addedHubServer) {
    // Tool rows go with their server.
    await database.delete(mcpServers).where(eq(mcpServers.id, "hub"));
  }
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

async function call(args: Record<string, unknown>, approvalId?: string) {
  return store
    .callTool({
      ref: REF,
      args,
      botId,
      actorId,
      ...(approvalId ? { approvalId } : {}),
    })
    .catch((error: unknown) => error);
}

function questionFrom(outcome: unknown): PluginNeedsApprovalError {
  if (outcome instanceof PluginNeedsApprovalError) return outcome;
  throw new Error(`expected a question, got ${String(outcome)}`);
}

const refusalCode = (outcome: unknown) =>
  outcome instanceof PluginRefusedError
    ? outcome.code
    : `not refused: ${String(outcome)}`;

/** The outbox rows carrying `marker`: what this deployment has committed to send. */
async function rowsCarrying(marker: string) {
  return database
    .select({ id: hubOutbox.id, deliveredAt: hubOutbox.deliveredAt })
    .from(hubOutbox)
    .where(sql`${hubOutbox.body}::text like ${`%${marker}%`}`);
}

/** Requests the hub received carrying `marker`. */
const sentCarrying = (marker: string) =>
  sent.filter((request) => JSON.stringify(request.body).includes(marker));

/** A write of each kind, unique to one test so no answer or No crosses to another. */
function writeOf(kind: "skill" | "propose_memory" | "post", marker: string) {
  switch (kind) {
    case "skill":
      return {
        kind,
        id: `quote-${marker}`,
        title: `견적서 쓰는 법 ${marker}`,
        summary: `거래처 견적서를 쓰는 순서 ${marker}`,
        instructions: `견적서를 쓸 때는 거래처 이름부터 적는다. ${marker}`,
      };
    case "propose_memory":
      return {
        kind,
        content: `우리 팀의 주간 회의는 월요일 오전이다 ${marker}`,
        evidence: "주간 회의는 월요일 오전에 해요",
      };
    case "post":
      return { kind, room: "r_1", text: `내일 회의는 10시예요. ${marker}` };
  }
}

const marked = () => `m${randomUUID().slice(0, 8)}${suite}`;

describe("publishing to the company, by default", () => {
  test.each(["skill", "propose_memory"] as const)(
    "a %s asks the person, says what goes up, and nothing leaves until they answer",
    async (kind) => {
      policy = SHIPPED_ALLOW;
      const marker = marked();
      const asked = questionFrom(await call(writeOf(kind, marker)));

      expect(asked.subject).toEqual({
        kind: "tool",
        intent: "call_tool",
        tool: { server: "hub", name: "write", guard: "company" },
        reason: "guard_floor",
      });
      expect(asked.rule).toBe("laf:company");
      // What goes to the company leads the card: its kind, then what it is called and says.
      expect(asked.preview?.[0]).toEqual({ field: "share", values: [kind] });
      expect(JSON.stringify(asked.preview)).toContain(marker);
      expect(sentCarrying(marker)).toEqual([]);
      expect(await rowsCarrying(marker)).toEqual([]);
    },
  );

  test("a skill's card names it and says its first words; a secret-shaped line is left off", async () => {
    policy = SHIPPED_ALLOW;
    const marker = marked();
    const plain = questionFrom(await call(writeOf("skill", marker)));
    expect(plain.preview).toEqual([
      { field: "share", values: ["skill"] },
      { field: "subject", values: [`견적서 쓰는 법 ${marker}`] },
      { field: "text", values: [`거래처 견적서를 쓰는 순서 ${marker}`] },
    ]);

    const secret = questionFrom(
      await call({
        kind: "skill",
        id: `login-${marker}`,
        title: `가게 관리자 화면 ${marker}`,
        instructions: `관리자 비밀번호는 shop1234! 로 들어간다. ${marker}`,
      }),
    );
    expect(secret.preview).toEqual([
      { field: "share", values: ["skill"] },
      { field: "subject", values: [`가게 관리자 화면 ${marker}`] },
    ]);
    expect(JSON.stringify(secret.preview)).not.toContain("shop1234");
  });

  test("the trail says a person was asked, and never what would have gone up", async () => {
    policy = SHIPPED_ALLOW;
    const marker = marked();
    questionFrom(await call(writeOf("skill", marker)));
    const rows = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, REF),
          eq(auditEvents.eventType, "approval.requested"),
        ),
      );
    const ours = rows.filter(
      (row) => (row.payload as { bot?: string }).bot === botId,
    );
    expect(ours.length).toBeGreaterThan(0);
    expect(JSON.stringify(ours)).toContain("company");
    expect(JSON.stringify(ours)).not.toContain(marker);
  });
});

describe("the person's answer", () => {
  test("a yes publishes it once, and the same yes does not publish it again", async () => {
    policy = SHIPPED_ALLOW;
    const marker = marked();
    const write = writeOf("skill", marker);
    const asked = questionFrom(await call(write));
    expect(
      (await approvals.answer(asked.approvalId, botId, actorId, true)).ok,
    ).toBe(true);

    const done = await call(write, asked.approvalId);
    expect(JSON.parse((done as { text: string }).text)).toEqual({
      source: "회사",
      kind: "skill",
      sent: true,
    });
    expect(sentCarrying(marker)).toHaveLength(1);
    expect(sentCarrying(marker)[0]?.path).toBe(`/skills/quote-${marker}`);
    const rows = await rowsCarrying(marker);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deliveredAt).not.toBeNull();

    // Spent: presented again it opens a fresh question, and nothing more goes up.
    questionFrom(await call(write, asked.approvalId));
    expect(sentCarrying(marker)).toHaveLength(1);
    expect(await rowsCarrying(marker)).toHaveLength(1);
  });

  test("a no publishes nothing, leaves no outbox row, and the same write is refused after it", async () => {
    policy = SHIPPED_ALLOW;
    const marker = marked();
    const write = writeOf("propose_memory", marker);
    const asked = questionFrom(await call(write));
    expect(
      (await approvals.answer(asked.approvalId, botId, actorId, false)).ok,
    ).toBe(true);

    expect(refusalCode(await call(write, asked.approvalId))).toBe(
      "laf:declined_recently",
    );
    expect(refusalCode(await call(write))).toBe("laf:declined_recently");
    expect(sentCarrying(marker)).toEqual([]);
    expect(await rowsCarrying(marker)).toEqual([]);
  });
});

describe("the boundary around it", () => {
  test("a deny rule refuses a publish without asking; without the rule the same write asks", async () => {
    const marker = marked();
    const write = writeOf("skill", marker);
    policy = { deny: ['mcp.server == "hub"'], ask: [], allow: ["true"] };
    const refused = await call(write);
    policy = SHIPPED_ALLOW;

    expect(refusalCode(refused)).toBe("laf:policy_denied");
    const open = await approvals.pending(botId);
    expect(JSON.stringify(open)).not.toContain(marker);
    expect(sentCarrying(marker)).toEqual([]);
    expect(await rowsCarrying(marker)).toEqual([]);

    // The deny is what refused it: the same write, with the rule gone, is put to the person.
    questionFrom(await call(write));
  });

  test("an allowance the person granted lets a publish go unasked, and is not honoured with allowances off", async () => {
    policy = SHIPPED_ALLOW;
    const first = marked();
    const asked = questionFrom(await call(writeOf("skill", first)));
    expect(asked.scope).toEqual({ kind: "tool", value: REF });

    // What the answering route does for 이 도구 항상 허용 (`computer/approval-routes.ts`).
    const allowance = await standing.grant({
      botId,
      rule: asked.rule,
      scope: asked.scope ?? { kind: "tool", value: REF },
      subject: asked.subject,
      grantedBy: actorId,
      tier: "always",
    });
    try {
      const later = marked();
      const done = await call(writeOf("propose_memory", later));
      expect(JSON.parse((done as { text: string }).text).sent).toBe(true);
      expect(sentCarrying(later)).toHaveLength(1);

      // A deployment that has turned allowances off asks every time, the allowance standing or not.
      policy = { ...SHIPPED_ALLOW, settleWithoutAsking: "off" };
      const watched = marked();
      const again = questionFrom(await call(writeOf("skill", watched)));
      expect(again.scope).toBeUndefined();
      expect(sentCarrying(watched)).toEqual([]);
      expect(await rowsCarrying(watched)).toEqual([]);
    } finally {
      policy = SHIPPED_ALLOW;
      await standing.revoke(allowance.id, actorId);
    }
  });

  test("a room message the person asked for goes as before, while a skill under the same rules asks", async () => {
    policy = SHIPPED_ALLOW;
    const marker = marked();
    const posted = await call(writeOf("post", marker));
    expect(JSON.parse((posted as { text: string }).text)).toEqual({
      source: "회사",
      kind: "post",
      sent: true,
    });
    expect(sentCarrying(marker)).toHaveLength(1);
    expect(sentCarrying(marker)[0]?.path).toBe("/rooms/r_1/messages");

    const skill = marked();
    questionFrom(await call(writeOf("skill", skill)));
    expect(sentCarrying(skill)).toEqual([]);
  });
});
