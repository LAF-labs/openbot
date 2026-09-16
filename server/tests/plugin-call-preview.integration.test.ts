import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  type CallPreview,
  createApprovalRegistry,
  presentable,
} from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  pluginGrants,
} from "../src/db/schema";
import { solapiSettings } from "../src/plugins/alimtalk/solapi";
import { createAlimtalkTools } from "../src/plugins/alimtalk/tools";
import { createPartnerConnections } from "../src/plugins/partner-connections";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  createPluginStore,
  PluginNeedsApprovalError,
  PluginRefusedError,
} from "../src/plugins/store";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";

/**
 * THE QUESTION FOR AN OUTWARD SEND SAYS WHAT WILL BE SENT.
 *
 * Measured 2026-09-16 (audit R4-01): a real `store.callTool` on `google-calendar/create_event` threw
 * a question whose subject was `{ server, name, guard }` and nothing else, and the card drew "구글
 * 캘린더의 ‘create_event’ 도구를 쓰려 합니다." The fingerprint bound the person's yes to one exact set of
 * arguments — an invitation to one exact address — that the person had not been shown. The same
 * for a mail, a review reply, an order status and an 알림톡.
 *
 * Against the public store, the real catalogue rows and the real 알림톡 transport, with the vendor
 * injected so that nothing here can reach one: the recorded list of what a call "went out with" is
 * the assertion that a question came before it. The trail is read too, because the preview is the
 * one part of a question that must never be written down — a recipient and a message body are the
 * person's and their customer's, and an audit row is forever.
 *
 * And the decision the owner made on 2026-09-16, pinned at the end: 이 도구 항상 허용 does what the
 * button says, for these tools as for every other. The card now shows the send it is being pressed
 * on; the allowance still covers the ones after it.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_preview_${suite}`;
const actorId = `user_preview_${suite}`;

const REFS = {
  mail: "gmail/send_message",
  event: "google-calendar/create_event",
  reply: "google-business-profile/reply_to_review",
  order: "cafe24/update_order_status",
  alimtalk: "kakao-alimtalk/alimtalk_send",
} as const;

/** The catalogue rows the five tools live on. A Cafe24 row needs a mall to point at. */
const SERVERS: { key: string; instanceName?: string }[] = [
  { key: "gmail" },
  { key: "google-calendar" },
  { key: "google-business-profile" },
  { key: "cafe24", instanceName: `preview${suite}` },
  { key: "kakao-alimtalk" },
];

/** What each call would have gone out with. Empty until somebody has said yes. */
const wentOut: { toolName: string; args: Record<string, unknown> }[] = [];

let policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const approvals = createApprovalRegistry();
const standing = createStandingApprovalStore();
const auditStore = createAuditStore(database);

const store = createPluginStore({
  database,
  auditStore,
  credentials: credentialVaultStub({ readSecret: async () => null }),
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  approvals,
  standing,
  // The real 알림톡 transport, so its own checks and its own preview are the ones under test. Its
  // 솔라피 is a closed port; the injected vendor below means nothing is ever posted to it anyway.
  partnerTransports: {
    "kakao-alimtalk": createAlimtalkTools(
      createPartnerConnections({ database, auditStore }),
      solapiSettings({
        LAF_ALIMTALK_API_KEY: "TESTKEY01:TESTSECRET02",
        LAF_ALIMTALK_BASE_URL: "http://127.0.0.1:9",
      }),
    ),
  },
  callVendor: async (_connection, toolName, args) => {
    wentOut.push({ toolName, args });
    return { text: "sent", isError: false };
  },
});

/** The rows this file made, and so the rows that are this file's to remove. */
const addedServers: string[] = [];

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();
  for (const server of SERVERS) {
    const [existing] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, server.key))
      .limit(1);
    // A row another file left is used as it stands: re-adding it could repoint somebody's mall.
    if (existing) continue;
    await store.ensureCatalogueServer({ ...server, by: "admin@laf.local" });
    addedServers.push(server.key);
  }
  for (const ref of Object.values(REFS)) {
    await store.grant("mcp", ref, botId, "admin@laf.local");
  }
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  if (addedServers.length > 0) {
    // Tool rows go with their server.
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, addedServers));
  }
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

async function call(
  ref: string,
  args: Record<string, unknown>,
  approvalId?: string,
) {
  return store
    .callTool({
      ref,
      args,
      botId,
      actorId,
      ...(approvalId ? { approvalId } : {}),
    })
    .catch((error: unknown) => error);
}

/** The question a call raised, or a failure naming what came back instead. */
function questionFrom(outcome: unknown): PluginNeedsApprovalError {
  if (outcome instanceof PluginNeedsApprovalError) return outcome;
  throw new Error(`expected a question, got ${String(outcome)}`);
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

const MAIL = {
  to: "friend@example.com",
  subject: "9월 정산 안내",
  body: "안녕하세요.\n9월 정산서를 보내 드립니다.",
};

const RESERVATION = {
  to: "010-1111-2222",
  template: "laf_reservation",
  variables: {
    상호: "미소상회",
    고객명: "김손님",
    일시: "9월 20일 12시",
    인원: "2",
  },
};

describe("a Gmail recipient that carries a header", () => {
  test("is refused before anybody is asked, and the trail says why", async () => {
    policy = { deny: [], ask: [], allow: ["true"] };
    const outcome = await call(REFS.mail, {
      ...MAIL,
      to: "friend@example.com\r\nBcc: attacker@evil.example",
    });

    expect(outcome).toBeInstanceOf(PluginRefusedError);
    expect((outcome as PluginRefusedError).code).toBe(
      "laf:mail_recipient_invalid",
    );
    // No question: a person's attention is not spent on a mail that can never be sent.
    expect(await approvals.pending(botId)).toEqual([]);
    const rejected = await trailFor(REFS.mail, "mcp.call_rejected");
    expect(rejected.map((row) => row.refusal)).toContain(
      "laf:mail_recipient_invalid",
    );
    // The refusal row names the problem, never the value: the injected address is not in it.
    expect(JSON.stringify(rejected)).not.toContain("attacker@evil.example");
    expect(wentOut).toEqual([]);
  });
});

describe("the question for an outward send", () => {
  test("a mail names who it goes to, the subject and the text", async () => {
    const asked = questionFrom(await call(REFS.mail, MAIL));
    const expected: CallPreview = [
      { field: "recipients", values: ["friend@example.com"] },
      { field: "subject", values: ["9월 정산 안내"] },
      { field: "text", values: ["안녕하세요.\n9월 정산서를 보내 드립니다."] },
    ];

    expect(asked.subject).toMatchObject({
      tool: { server: "gmail", name: "send_message", guard: "external" },
      reason: "guard_floor",
    });
    expect(asked.preview).toEqual(expected);
    // The question held in the registry is the same record the surface is handed.
    const pending = (await approvals.pending(botId)).find(
      (question) => question.id === asked.approvalId,
    );
    expect(pending?.preview).toEqual(expected);
    expect(pending ? presentable(pending).preview : null).toEqual(expected);
    expect(wentOut).toEqual([]);
  });

  test("the trail records that a person was asked, and never what the mail said", async () => {
    const rows = await trailFor(REFS.mail, "approval.requested");
    expect(rows.length).toBeGreaterThan(0);
    const written = JSON.stringify(rows);
    // What was asked about is there, in facts…
    expect(written).toContain("send_message");
    // …and nothing the person was shown about the mail itself.
    expect(written).not.toContain("friend@example.com");
    expect(written).not.toContain("9월 정산 안내");
    expect(written).not.toContain("정산서를 보내 드립니다");
    expect(rows.every((row) => !("preview" in row))).toBe(true);
  });

  test("an invitation names its title, its time and its guests", async () => {
    const asked = questionFrom(
      await call(REFS.event, {
        summary: "상견례",
        start: "2026-09-20T12:00:00+09:00",
        end: "2026-09-20T14:00:00+09:00",
        attendees: ["stranger@evil.example"],
      }),
    );
    expect(asked.preview).toEqual([
      { field: "title", values: ["상견례"] },
      { field: "starts", values: ["2026-09-20T12:00:00+09:00"] },
      { field: "ends", values: ["2026-09-20T14:00:00+09:00"] },
      { field: "attendees", values: ["stranger@evil.example"] },
    ]);
  });

  test("a review reply names the review and what will be published", async () => {
    const asked = questionFrom(
      await call(REFS.reply, {
        review: "accounts/1/locations/2/reviews/abc",
        comment: "방문해 주셔서 감사합니다!",
      }),
    );
    expect(asked.preview).toEqual([
      { field: "review", values: ["accounts/1/locations/2/reviews/abc"] },
      { field: "text", values: ["방문해 주셔서 감사합니다!"] },
    ]);
  });

  test("an order status change names the order and the new status", async () => {
    const asked = questionFrom(
      await call(REFS.order, { orderId: "20260916-0000012", status: "N30" }),
    );
    expect(asked.preview).toEqual([
      { field: "order", values: ["20260916-0000012"] },
      { field: "status", values: ["N30"] },
    ]);
  });

  test("an 알림톡 names the number it will ring and the message the customer will read", async () => {
    const asked = questionFrom(await call(REFS.alimtalk, RESERVATION));
    expect(asked.preview).toEqual([
      // The number as it will be dialled, not as the model spelled it.
      { field: "recipients", values: ["01011112222"] },
      { field: "template", values: ["laf_reservation"] },
      {
        field: "text",
        values: [
          "[미소상회]\n예약이 확정되었습니다.\n\n예약자: 김손님\n일시: 9월 20일 12시\n인원: 2\n\n변경이나 취소는 매장으로 연락해 주세요.",
        ],
      },
    ]);
  });

  test("a written rule that asks about the send asks with the same preview", async () => {
    // Not the floor this time: the deployment's own `ask` list. The person is asked the same
    // question, so they are shown the same thing.
    policy = { deny: [], ask: ["true"], allow: ["true"] };
    const asked = questionFrom(await call(REFS.mail, MAIL));
    policy = { deny: [], ask: [], allow: ["true"] };

    expect(asked.subject.reason).toBe("policy_ask");
    expect(asked.preview?.[0]).toEqual({
      field: "recipients",
      values: ["friend@example.com"],
    });
  });
});

describe("the pause reply the chat surface reads", () => {
  test("carries the preview beside the question, as facts", async () => {
    // The real routes over the real store, as one signed-in person: the body the browser's
    // `pauseFrom` reads is the only way the preview reaches a chat card.
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: actorId,
        email: `${actorId}@laf.test`,
        role: "user",
      });
      await next();
    };
    const app = new Hono().route(
      "/api/plugins",
      createPluginRoutes(store, requireUser),
    );

    const response = await app.request("http://t/api/plugins/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: REFS.reply,
        args: {
          review: "accounts/1/locations/2/reviews/xyz",
          comment: "다음에 또 오세요.",
        },
        agentId: botId,
      }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.awaitingApproval).toBe(true);
    expect(body.preview).toEqual([
      { field: "review", values: ["accounts/1/locations/2/reviews/xyz"] },
      { field: "text", values: ["다음에 또 오세요."] },
    ]);
    // Facts only: nothing on the reply is a sentence the server wrote for a person.
    expect(body.code).toBe("laf:awaiting_approval");
    expect(wentOut).toEqual([]);
  });
});

describe("a yes is still for the exact call", () => {
  test("presented for another number, it opens a new question naming that number", async () => {
    const first = questionFrom(await call(REFS.alimtalk, RESERVATION));
    const answered = await approvals.answer(
      first.approvalId,
      botId,
      actorId,
      true,
    );
    expect(answered.ok).toBe(true);

    const elsewhere = questionFrom(
      await call(
        REFS.alimtalk,
        { ...RESERVATION, to: "010-9999-8888" },
        first.approvalId,
      ),
    );
    expect(elsewhere.approvalId).not.toBe(first.approvalId);
    expect(elsewhere.preview?.[0]).toEqual({
      field: "recipients",
      values: ["01099998888"],
    });
    expect(wentOut).toEqual([]);

    // The same yes, presented for the call it was given for, sends exactly that call.
    const sent = await call(REFS.alimtalk, RESERVATION, first.approvalId);
    expect(sent).toEqual({ text: "sent", isError: false });
    expect(wentOut).toEqual([{ toolName: "alimtalk_send", args: RESERVATION }]);
  });

  test("항상 허용 does what the button says: later sends of that tool go without a question", async () => {
    wentOut.length = 0;
    const asked = questionFrom(await call(REFS.alimtalk, RESERVATION));
    expect(asked.scope).toEqual({ kind: "tool", value: REFS.alimtalk });

    // What the answering route does for "always" (`computer/approval-routes.ts`).
    const allowance = await standing.grant({
      botId,
      rule: asked.rule,
      scope: asked.scope ?? { kind: "tool", value: REFS.alimtalk },
      subject: asked.subject,
      grantedBy: actorId,
      tier: "always",
    });
    try {
      const later = { ...RESERVATION, to: "010-3333-4444" };
      const outcome = await call(REFS.alimtalk, later);
      // Owner decision, 2026-09-16: the allowance stands for the tool, not for one message.
      expect(outcome).toEqual({ text: "sent", isError: false });
      expect(wentOut).toEqual([{ toolName: "alimtalk_send", args: later }]);
      const pendingAboutLater = (await approvals.pending(botId)).filter(
        (question) =>
          JSON.stringify(question.preview ?? []).includes("01033334444"),
      );
      expect(pendingAboutLater).toEqual([]);
    } finally {
      await standing.revoke(allowance.id, actorId);
    }
  });
});
