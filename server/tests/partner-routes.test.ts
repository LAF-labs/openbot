import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  lafAlimtalkTemplates,
  lafPartnerConnections,
  users,
} from "../src/db/schema";
import { createAlimtalkAdapter } from "../src/notifications/alimtalk";
import { createPartnerRoutes } from "../src/plugins/partner-routes";
import { createPartnerRuntime } from "../src/plugins/partners";
import type { PluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * THE CARD IS ONLY DRAWN WHERE THE PRESS COULD WORK, and the other half: what a press does.
 *
 * A control that saves and does nothing is worse than no control. For these two connectors that
 * means a fleet VM with no `LAF_ALIMTALK_API_KEY` must list no 알림톡 — not a card whose button
 * would 503, and certainly not one that reports a connection nothing can act on. The listing is
 * driven from what the process actually assembled, so this pins the assembly and the route together.
 *
 * The other half is the grant. A registration alone reaches NO Bot: the tools live behind a server
 * row and a `plugin_grants` row per Bot, and until 2026-09 nothing made either. So the connect route
 * ensures the row, refreshes the tools and grants each one to every Bot the person owns — and that
 * is asserted here on the calls the route actually makes, because it is exactly the kind of wiring
 * that typechecks perfectly while reaching nothing.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const testPrefix = `partner-routes-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdBotIds: string[] = [];

const auditRows: AuditEventInput[] = [];
const auditStore: AuditStore = {
  insert: async (event) => {
    auditRows.push(event);
  },
};

afterAll(async () => {
  await database.$client.close();
});

afterEach(async () => {
  auditRows.length = 0;
  for (const botId of createdBotIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, botId));
    await database.delete(agents).where(eq(agents.id, botId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database
      .delete(lafAlimtalkTemplates)
      .where(eq(lafAlimtalkTemplates.userId, userId));
    await database
      .delete(lafPartnerConnections)
      .where(eq(lafPartnerConnections.userId, userId));
    await database.delete(users).where(eq(users.id, userId));
  }
});

/** A Bot of this person's, so a grant has somewhere to land. */
async function createBot(userId: string, hidden = false): Promise<string> {
  const botId = `${testPrefix}-bot-${randomUUID()}`;
  await database.insert(agents).values({
    id: botId,
    name: "테스트 봇",
    type: "remote_ag_ui",
    configuration: { endpoint: "https://bot.example.test/ag-ui" },
  });
  await database.insert(agentProfiles).values({
    agentId: botId,
    ownerUserId: userId,
    title: "Test",
    roleDescription: "For a grant to land on.",
    avatarSeed: "seed",
    visibility: "private",
  });
  createdBotIds.push(botId);
  // `hidden` is a PREFERENCE row and deliberately not created: a Bot tidied off the home screen is
  // still a Bot of theirs, which is why `botsOwnedBy` reads the profiles rather than `list()`.
  void hidden;
  return botId;
}

async function createUser(): Promise<string> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Partner Routes Test User",
    emailVerified: true,
  });
  createdUserIds.push(id);
  return id;
}

/** The person the routes act as, without a session: the guard is not what is under test here. */
function actingAs(
  userId: string,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.test`,
      role: "user",
    });
    await next();
  };
}

/** What the plugin store was asked to do, which is the only part of it these routes touch. */
type StoreCalls = {
  ensured: string[];
  refreshed: string[];
  granted: { ref: string; botId: string }[];
  revoked: { ref: string; botId: string }[];
  removed: string[];
};

function fakeStore(calls: StoreCalls): PluginStore {
  return {
    ensureCatalogueServer: async ({ key }: { key: string }) => {
      calls.ensured.push(key);
      return { url: "", added: true };
    },
    refreshTools: async (serverId: string) => {
      calls.refreshed.push(serverId);
      return { tools: 0 };
    },
    grant: async (_kind: string, ref: string, botId: string) => {
      calls.granted.push({ ref, botId });
    },
    revoke: async (_kind: string, ref: string, botId: string) => {
      calls.revoked.push({ ref, botId });
    },
    removeServer: async (serverId: string) => {
      calls.removed.push(serverId);
    },
  } as unknown as PluginStore;
}

function appFor(
  userId: string,
  environment: Record<string, string | undefined>,
  calls: StoreCalls = {
    ensured: [],
    refreshed: [],
    granted: [],
    revoked: [],
    removed: [],
  },
) {
  const partners = createPartnerRuntime({
    context: { database, auditStore },
    database,
    environment,
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/partners",
    createPartnerRoutes(fakeStore(calls), partners, actingAs(userId)),
  );
  return { app, partners, calls };
}

describe("what a deployment offers", () => {
  test("a VM with no keys lists nothing at all", async () => {
    const userId = await createUser();
    const { app, partners } = appFor(userId, {});

    const answered = await app.request("/api/partners");
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ partners: [] });
    // And nothing is assembled behind it either: no transport for the store, so the catalogue
    // entries are unreachable rather than falling back to MCP and posting JSON-RPC at 솔라피.
    expect(partners.configured).toEqual([]);
    expect(partners.transports).toEqual({});
  });

  test("the key configured lists the one card there is", async () => {
    const userId = await createUser();
    const { app } = appFor(userId, { LAF_ALIMTALK_API_KEY: "key:secret" });

    const listed = (await (await app.request("/api/partners")).json()) as {
      partners: { id: string; title: string; status: { connected: boolean } }[];
    };
    expect(listed.partners.map((card) => card.id)).toEqual(["kakao-alimtalk"]);
    expect(listed.partners[0]?.title).toBe("카카오 알림톡");
    expect(listed.partners[0]?.status.connected).toBe(false);
  });

  test("pressing a connector this VM has no key for is a 503, not a 500", async () => {
    const userId = await createUser();
    const { app } = appFor(userId, {});

    const answered = await app.request("/api/partners/kakao-alimtalk/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ searchId: "@가게", phone: "01012345678" }),
    });
    // Nothing the person types fixes it and there is nobody here to send them to. The surface owns
    // the sentence; the server sends the fact.
    expect(answered.status).toBe(503);
    expect(await answered.json()).toEqual({
      code: "laf:kakao-alimtalk_not_configured",
    });
  });

  test("a path segment that is not a provider is refused rather than cast", async () => {
    const userId = await createUser();
    const { app } = appFor(userId, { LAF_ALIMTALK_API_KEY: "key:secret" });

    const answered = await app.request("/api/partners/nonsense/disconnect", {
      method: "POST",
    });
    expect(answered.status).toBe(400);
    expect(await answered.json()).toEqual({ code: "laf:partner_unknown" });
  });

  test("a bad field is a 400 with a fact, and never a sentence", async () => {
    const userId = await createUser();
    const { app } = appFor(userId, { LAF_ALIMTALK_API_KEY: "key:secret" });

    const answered = await app.request("/api/partners/kakao-alimtalk/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ searchId: "@가게" }),
    });
    expect(answered.status).toBe(400);
    // A code, not prose: the surface writes the Korean and the server never crosses into it.
    expect(await answered.json()).toEqual({
      code: "laf:alimtalk_phone_missing",
    });
  });
});

describe("the AlimTalk door", () => {
  test("sends the owner's own template to the number they proved they hold", async () => {
    const userId = await createUser();
    /** A fake 솔라피 that only has to accept a send. */
    const vendor = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        sent.push((await request.json()) as Record<string, unknown>);
        return Response.json({ statusCode: "2000", messageId: "msg-9" });
      },
    });
    const sent: Record<string, unknown>[] = [];
    const environment = {
      LAF_ALIMTALK_API_KEY: "key:secret",
      LAF_ALIMTALK_BASE_URL: `http://127.0.0.1:${vendor.port}`,
    };

    try {
      const partners = createPartnerRuntime({
        context: { database, auditStore },
        database,
        environment,
      }).connections;
      await partners.save({
        provider: "kakao-alimtalk",
        userId,
        account: "KA01PF-fake",
        details: { searchId: "@미소상회", managerPhone: "01055554444" },
        label: "channel:@미소상회",
      });
      await partners.recordTemplate({
        userId,
        code: "laf_approval",
        templateId: "tpl-approval",
        status: "approved",
        reason: "",
      });

      const door = createAlimtalkAdapter({ partners, environment });
      const delivered = await door.deliver({
        id: "notification-1",
        kind: "approval.requested",
        botId: "bot-1",
        userId,
        subject: {
          kind: "tool",
          intent: "call_tool",
          tool: { server: "cafe24", name: "update_order_status" },
          reason: "guard_floor",
        },
        createdAt: new Date("2026-09-04T05:00:00.000Z").toISOString(),
        deliveredVia: [],
      });

      expect(delivered).toBe(true);
      const options = (
        (sent[0] as { message: Record<string, unknown> }).message as {
          kakaoOptions: Record<string, unknown>;
        }
      ).kakaoOptions;
      expect(options.templateId).toBe("tpl-approval");
      expect(options.pfId).toBe("KA01PF-fake");
      // The variables are the approved template's own two, and nothing else. What the Bot was
      // actually about to do — the host, the path, the control's name — stays in the app.
      expect(options.variables).toEqual({
        "#{내용}": "연결된 서비스 사용",
        "#{시각}": "2026. 9. 4. 오후 2:00",
      });
    } finally {
      vendor.stop(true);
    }
  });

  test("stays queued, without claiming delivery, while the template is still 심사 중", async () => {
    const userId = await createUser();
    const environment = {
      LAF_ALIMTALK_API_KEY: "key:secret",
      // Deliberately unroutable: nothing may reach it, and a door that tried would time out here.
      LAF_ALIMTALK_BASE_URL: "http://127.0.0.1:1",
    };
    const partners = createPartnerRuntime({
      context: { database, auditStore },
      database,
      environment,
    }).connections;
    await partners.save({
      provider: "kakao-alimtalk",
      userId,
      account: "KA01PF-fake",
      details: { searchId: "@미소상회", managerPhone: "01055554444" },
      label: "channel:@미소상회",
    });
    await partners.recordTemplate({
      userId,
      code: "laf_approval",
      templateId: "tpl-approval",
      status: "pending",
      reason: "",
    });

    const said: string[] = [];
    const door = createAlimtalkAdapter({
      partners,
      environment,
      log: (message) => said.push(message),
    });
    const delivered = await door.deliver({
      id: "notification-2",
      kind: "approval.requested",
      botId: "bot-1",
      userId,
      createdAt: new Date().toISOString(),
      deliveredVia: [],
    });

    // The one thing this table exists to answer is whether a person was actually reached. A door
    // that returned true here would put "alimtalk" in `delivered_via` for a message 카카오 would
    // have refused.
    expect(delivered).toBe(false);
    expect(said[0]).toContain("laf_approval");
  });
});

describe("a connect reaches the Bots", () => {
  test("disconnecting takes the server row, and with it every grant on its tools", async () => {
    const userId = await createUser();
    const calls: StoreCalls = {
      ensured: [],
      refreshed: [],
      granted: [],
      revoked: [],
      removed: [],
    };
    const botId = await createBot(userId);
    const { app, partners } = appFor(
      userId,
      { LAF_ALIMTALK_API_KEY: "key:secret" },
      calls,
    );
    await partners.connections.save({
      provider: "kakao-alimtalk",
      userId,
      account: "KA01PF-fake",
      details: { searchId: "@미소상회" },
      label: "channel:registered",
    });

    const answered = await app.request(
      "/api/partners/kakao-alimtalk/disconnect",
      { method: "POST" },
    );
    expect(await answered.json()).toEqual({ disconnected: true });
    /*
     * A Bot that kept a tool it can no longer use would offer 알림톡 보내기 in its own tool list and
     * refuse every call — a capability that exists to say no. Removing the server row takes the
     * tool rows with it.
     */
    expect(calls.removed).toEqual(["kakao-alimtalk"]);
    /*
     * AND THE GRANTS, WHICH THE SERVER ROW DOES NOT TAKE. `plugin_grants.ref` is plain text with no
     * key behind it — measured by pressing 연결 해제 against a live deployment and reading the
     * table, which still held both rows. Left there they draw on the admin page as a discrepancy
     * somebody should look into, and nothing is discrepant: the person pressed the button.
     */
    for (const tool of partners.toolsOf("kakao-alimtalk")) {
      expect(calls.revoked).toContainEqual({
        ref: `kakao-alimtalk/${tool.name}`,
        botId,
      });
    }
  });

  test("disconnecting something that was never connected removes no server row", async () => {
    const userId = await createUser();
    const calls: StoreCalls = {
      ensured: [],
      refreshed: [],
      granted: [],
      revoked: [],
      removed: [],
    };
    const { app } = appFor(
      userId,
      { LAF_ALIMTALK_API_KEY: "key:secret" },
      calls,
    );

    const answered = await app.request(
      "/api/partners/kakao-alimtalk/disconnect",
      { method: "POST" },
    );
    expect(await answered.json()).toEqual({ disconnected: false });
    expect(calls.removed).toEqual([]);
  });

  test("connecting a channel offers its tools to every Bot the person owns", async () => {
    const userId = await createUser();
    const first = await createBot(userId);
    const second = await createBot(userId);
    /** A fake 솔라피 that accepts the code and every template. */
    const vendor = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/kakao/v1/channels") {
          return Response.json({
            channelId: "KA01PF-fake",
            searchId: "@미소상회",
          });
        }
        if (url.pathname === "/kakao/v1/templates") {
          return Response.json({ templateId: "tpl-1", status: "PENDING" });
        }
        return Response.json({ ok: true });
      },
    });
    const calls: StoreCalls = {
      ensured: [],
      refreshed: [],
      granted: [],
      revoked: [],
      removed: [],
    };

    try {
      const { app, partners } = appFor(
        userId,
        {
          LAF_ALIMTALK_API_KEY: "key:secret",
          LAF_ALIMTALK_BASE_URL: `http://127.0.0.1:${vendor.port}`,
        },
        calls,
      );

      const answered = await app.request(
        "/api/partners/kakao-alimtalk/connect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            searchId: "@미소상회",
            phone: "01055554444",
            code: "778899",
          }),
        },
      );
      expect(answered.status).toBe(200);

      /*
       * THE PART THAT REACHES A BOT. A registration alone reaches nothing: the tools live behind a
       * server row and one `plugin_grants` row per Bot per tool. This is the wiring that typechecks
       * perfectly while doing nothing, so it is asserted on the calls rather than inferred.
       */
      expect(calls.ensured).toEqual(["kakao-alimtalk"]);
      expect(calls.refreshed).toEqual(["kakao-alimtalk"]);
      const tools = partners.toolsOf("kakao-alimtalk").map((tool) => tool.name);
      for (const botId of [first, second]) {
        for (const tool of tools) {
          expect(calls.granted).toContainEqual({
            ref: `kakao-alimtalk/${tool}`,
            botId,
          });
        }
      }
    } finally {
      vendor.stop(true);
    }
  });
});
