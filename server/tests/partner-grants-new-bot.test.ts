import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  lafAlimtalkTemplates,
  lafPartnerConnections,
  mcpServers,
  pluginGrants,
  users,
} from "../src/db/schema";
import { createPartnerRuntime } from "../src/plugins/partners";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A Bot made AFTER the channel was connected can send from it.
 *
 * MEASURED 2026-09-06: connecting 알림톡 granted `alimtalk_send` and `alimtalk_templates` to the Bots
 * the person owned at that moment, and to no other. A Bot made the next day held nothing while the
 * card still said 연결됨 — a capability the screen promised and the new Bot did not have — until the
 * person reconnected a channel that had never been disconnected.
 *
 * THROUGH `createApp`, NOT A HAND-WIRED HOOK. The fix is a few lines in `app.ts` composing the
 * create route's `onCreated` with the partner runtime, which is exactly the kind of wiring that
 * typechecks perfectly while reaching nothing; a test that built the hook itself would be green
 * with `app.ts` unchanged. So the connect goes through `/api/partners`, the create through
 * `/api/agents`, and what is read afterwards is the grant table.
 *
 * AND THE VENDOR IS NEVER 솔라피. A fake on 127.0.0.1 accepts the code and every template.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const testPrefix = `partner-grants-new-bot-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdBotIds: string[] = [];
/**
 * Whether the 알림톡 server row is this file's to remove.
 *
 * The connect route makes it by its catalogue key, which is the same row for everybody, so it is
 * removed only if it was absent when this file started: a cleanup scoped to what the test created
 * rather than to a name.
 */
let serverRowWasOurs = false;

const REFS = [
  "kakao-alimtalk/alimtalk_send",
  "kakao-alimtalk/alimtalk_templates",
];

const auditRows: AuditEventInput[] = [];
const auditStore: AuditStore = {
  insert: async (event) => {
    auditRows.push(event);
  },
};

let vendor: ReturnType<typeof Bun.serve>;
let baseUrl = "";
/** Who the app thinks is asking. Set per request by the helpers below; null is signed out. */
let session: { user: { id: string; email: string } } | null = null;

beforeAll(async () => {
  vendor = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/kakao/v1/channels") {
        return Response.json({
          channelId: "KA01PF-not-a-real-sender-key",
          searchId: "@미소상회",
        });
      }
      if (url.pathname === "/kakao/v1/templates") {
        return Response.json({ templateId: "tpl-1", status: "PENDING" });
      }
      return Response.json({ ok: true });
    },
  });
  baseUrl = `http://127.0.0.1:${vendor.port}`;

  const [existing] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, "kakao-alimtalk"))
    .limit(1);
  serverRowWasOurs = existing === undefined;
});

afterAll(async () => {
  vendor.stop(true);
  if (serverRowWasOurs) {
    // The tool rows cascade with it.
    await database
      .delete(mcpServers)
      .where(eq(mcpServers.id, "kakao-alimtalk"));
  }
  await database.$client.close();
});

afterEach(async () => {
  auditRows.length = 0;
  session = null;
  for (const botId of createdBotIds.splice(0)) {
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
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

async function createUser(): Promise<string> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "New Bot Grants Test User",
    emailVerified: true,
  });
  createdUserIds.push(id);
  return id;
}

/** The deployment as `index.ts` assembles it, minus everything a connect and a create never touch. */
function deployment() {
  const partners = createPartnerRuntime({
    context: { database, auditStore },
    database,
    environment: {
      LAF_ALIMTALK_API_KEY: "TESTKEY01:TESTSECRET02",
      LAF_ALIMTALK_BASE_URL: baseUrl,
    },
  });
  const store = createPluginStore({
    database,
    auditStore,
    credentials: credentialVaultStub({}),
    encryptionKey: "x".repeat(44),
    policy: () => ({ deny: [], ask: [], allow: [] }),
    approvals: createApprovalRegistry(),
    // Nothing here calls a tool. Loud rather than absent, so a path that started to would show.
    callVendor: async () => {
      throw new Error("this suite never calls a vendor tool");
    },
    partnerTransports: partners.transports,
  });
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => session },
    },
    { rolesForUser: async () => ["user"] },
    // Positions 4-11: auditReader, credentialService, packageStatusReader, onboarding,
    // copilotHandler, computerClient, computerGateway, computerPolicy.
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // 12: the Bots, real, so a create reserves a seat and writes a profile the grant can name.
    createAgentProfileStore(database, new URL("http://agent-bot.test/ag-ui")),
    // 13-16: channelStore, channelEvents, auditStore, componentStore.
    undefined,
    undefined,
    undefined,
    undefined,
    // 17: the plugin store, which mounts `/api/plugins` and, with the runtime below, `/api/partners`.
    store,
    // 18-37: everything between the plugin store and the partner runtime, none of it on this path.
    // A miscount lands a store in a slot of another type and fails to typecheck, which is the check.
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // 38: the partner runtime.
    partners,
  );
  return { app, store, partners };
}

type App = ReturnType<typeof createApp>;

const jsonRequest = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const signIn = (userId: string) => {
  session = { user: { id: userId, email: `${userId}@example.test` } };
};

/** The two-step connect's second step, through the real route, with the real store behind it. */
async function connectThrough(app: App, userId: string): Promise<void> {
  signIn(userId);
  const answered = await app.request(
    "http://laf.test/api/partners/kakao-alimtalk/connect",
    jsonRequest({
      searchId: "@미소상회",
      phone: "01055554444",
      code: "778899",
    }),
  );
  expect(answered.status).toBe(200);
}

/** A Bot made the way a person makes one: `POST /api/agents`, which is where the hook runs. */
async function createBotThrough(app: App, userId: string): Promise<string> {
  signIn(userId);
  const answered = await app.request(
    "http://laf.test/api/agents",
    jsonRequest({
      name: "알림 담당",
      title: "Notifications",
      roleDescription: "Sends the shop's own template messages.",
      visibility: "private",
    }),
  );
  expect(answered.status).toBe(201);
  const { agent } = (await answered.json()) as { agent: { id: string } };
  createdBotIds.push(agent.id);
  return agent.id;
}

/**
 * What the Bot holds, read the way its runtime reads it: a grant counts only against a tool row that
 * exists, so this is also the proof that the connect wrote the tool rows the grant names.
 */
async function heldBy(store: PluginStore, botId: string): Promise<string[]> {
  const { tools } = await store.listForAgent(botId);
  return tools.map((tool) => tool.ref).sort();
}

const grantRowsFor = (botId: string) =>
  database
    .select({ ref: pluginGrants.ref, grantedBy: pluginGrants.grantedBy })
    .from(pluginGrants)
    .where(eq(pluginGrants.agentId, botId));

describe("what a Bot made after the connect is handed", () => {
  test("a Bot made after the channel was connected holds the same tools as one made before", async () => {
    const { app, store } = deployment();
    const userId = await createUser();
    const before = await createBotThrough(app, userId);
    await connectThrough(app, userId);
    const after = await createBotThrough(app, userId);

    expect(await heldBy(store, before)).toEqual(REFS);
    expect(await heldBy(store, after)).toEqual(REFS);

    // And the trail names the second Bot once per tool, by the deployment: nobody pressed
    // anything for it, and a row saying a person did would be a row saying something false.
    const granted = auditRows.filter(
      (row) =>
        row.payload.change === "plugin_granted" && row.payload.bot === after,
    );
    expect(granted.map((row) => row.payload.ref).sort()).toEqual(REFS);
    expect(granted.map((row) => row.payload.actor)).toEqual([
      "deployment",
      "deployment",
    ]);
  });

  test("offering a Bot what it already holds writes nothing", async () => {
    const { app, store, partners } = deployment();
    const userId = await createUser();
    await connectThrough(app, userId);
    const botId = await createBotThrough(app, userId);
    const trailBefore = auditRows.length;

    // The boot-and-reconnect case: the same offer again must not rewrite rows of trail.
    await partners.offerTo(store, botId, userId, "deployment");

    expect(auditRows.length).toBe(trailBefore);
    expect(await heldBy(store, botId)).toEqual(REFS);
  });

  test("a Bot made by somebody who never connected is handed nothing", async () => {
    const { app, store } = deployment();
    const connected = await createUser();
    const other = await createUser();
    // Somebody ELSE's registration exists on this deployment, and the key is configured. What is
    // pinned is that the grant follows the owner's own registration and neither of those.
    await connectThrough(app, connected);
    const botId = await createBotThrough(app, other);

    expect(await heldBy(store, botId)).toEqual([]);
    expect(await grantRowsFor(botId)).toEqual([]);
  });
});
