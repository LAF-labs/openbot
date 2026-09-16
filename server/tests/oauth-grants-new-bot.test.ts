import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { lookupBotOwner } from "../src/auth/guards";
import { createApprovalRegistry } from "../src/computer/approvals";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A Bot made AFTER an account was connected at a vendor can use it.
 *
 * MEASURED 2026-09-10 (audit A9, F1), on the real API: connect Google Sheets, watch the overview
 * say `connected`, `POST /api/agents`, `GET /api/plugins/for/<new Bot>` → `{"tools":[]}`. The
 * partner connectors had this exact defect measured and fixed on 2026-09-06
 * (`partner-grants-new-bot.test.ts`); the OAuth connectors had the connect half and not the create
 * half. One VM per person means somebody makes a Bot a day, and from the second one on the card
 * said 연결됨 while the Bot said "지금 연결된 서비스는 없다".
 *
 * THROUGH `createApp`, NOT A HAND-WIRED HOOK, for the reason the partner test gives: the fix is a
 * few lines in `app.ts` composing the create route's `onCreated` with the store, which is exactly
 * the kind of wiring that typechecks perfectly while reaching nothing. The connect is the store's
 * own path (`recordConnection` then `offerToolsTo`, which is what the OAuth callback does once the
 * vendor has said yes), the create is `/api/agents`, and what is read afterwards is `/for/:id`.
 *
 * AND NOTHING REACHES GOOGLE. The Sheets transport's tool list is this repository's own code, the
 * exchange is injected, and the server row names a `.invalid` host.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const serverId = "google-sheets";
const SHEETS_REFS = [
  "google-sheets/append_sheet_row",
  "google-sheets/list_sheet_tabs",
  "google-sheets/read_sheet_values",
  "google-sheets/update_sheet_values",
];

const testPrefix = `oauth-grants-new-bot-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdBotIds: string[] = [];
/** Whether the Sheets server row is this file's to remove, with the tool rows under it. */
let serverRowWasOurs = false;

const auditRows: AuditEventInput[] = [];
const auditStore: AuditStore = {
  insert: async (event) => {
    auditRows.push(event);
  },
};

/** Who the app thinks is asking. Set per request by the helpers below; null is signed out. */
let session: { user: { id: string; email: string } } | null = null;

beforeAll(async () => {
  const [existing] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .limit(1);
  serverRowWasOurs = existing === undefined;
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Google Sheets",
      vendor: "Google",
      url: "https://sheets.test.invalid/mcp",
      provenance: "first-party",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (serverRowWasOurs) {
    await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
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
  const gone = createdUserIds.splice(0);
  if (gone.length > 0) {
    await database
      .delete(mcpUserCredentials)
      .where(inArray(mcpUserCredentials.userId, gone));
    await database
      .delete(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_token"),
          inArray(credentials.keyId, gone),
        ),
      );
    await database.delete(users).where(inArray(users.id, gone));
  }
});

async function createUser(): Promise<string> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "New Bot OAuth Grants Test User",
    emailVerified: true,
  });
  createdUserIds.push(id);
  return id;
}

/** The deployment as `index.ts` assembles it, minus everything a connect and a create never touch. */
function deployment() {
  const store = createPluginStore({
    database,
    auditStore,
    credentials: createCredentialStore(database),
    encryptionKey: ENCRYPTION_KEY,
    policy: () => ({ deny: [], ask: [], allow: [] }),
    approvals: createApprovalRegistry(),
    // Nothing here calls a tool. Loud rather than absent, so a path that started to would show.
    callVendor: async () => {
      throw new Error("this suite never calls a vendor tool");
    },
    exchangeRefreshToken: async () => {
      throw new Error("this suite never exchanges a token");
    },
    registerClient: async () => null,
  });
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => session },
    },
    {
      rolesForUser: async () => ["user"],
      // Whose Bot is whose, from the real tables: `GET /api/plugins/for/:id` is behind the
      // ownership guard, and a repository without this lookup admits nobody to any Bot.
      botOwner: (botId) => lookupBotOwner(database, botId),
    },
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
    // 17: the plugin store, which mounts `/api/plugins` and is what the create hook offers from.
    store,
  );
  return { app, store };
}

type App = ReturnType<typeof createApp>;

const signIn = (userId: string) => {
  session = { user: { id: userId, email: `${userId}@example.test` } };
};

/**
 * What the OAuth callback does once the vendor has said yes: the credential, then the tools on
 * every Bot the person owns at that moment (`routes.ts`, after `redeemAuthorizationCode`).
 */
async function connectSheets(store: PluginStore, userId: string) {
  await store.recordConnection({
    serverId,
    userId,
    refreshToken: `rt-${userId}`,
    scope: "https://www.googleapis.com/auth/spreadsheets",
  });
  await store.offerToolsTo(serverId, userId, userId);
}

/** A Bot made the way a person makes one: `POST /api/agents`, which is where the hook runs. */
async function createBotThrough(app: App, userId: string): Promise<string> {
  signIn(userId);
  const answered = await app.request("http://laf.test/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "시트 담당",
      title: "Sheets",
      roleDescription: "Reads and appends the shop's order sheet.",
    }),
  });
  expect(answered.status).toBe(201);
  const { agent } = (await answered.json()) as { agent: { id: string } };
  createdBotIds.push(agent.id);
  return agent.id;
}

/** What the Bot holds, read the way its runtime reads it: `GET /api/plugins/for/:id`. */
async function heldThrough(app: App, userId: string, botId: string) {
  signIn(userId);
  const answered = await app.request(
    `http://laf.test/api/plugins/for/${encodeURIComponent(botId)}`,
  );
  expect(answered.status).toBe(200);
  const { tools } = (await answered.json()) as { tools: { ref: string }[] };
  return tools.map((tool) => tool.ref).sort();
}

describe("what a Bot made after the connect is handed", () => {
  test("a Bot made after Google Sheets was connected holds the same tools as one made before", async () => {
    const { app, store } = deployment();
    const userId = await createUser();
    const before = await createBotThrough(app, userId);
    await connectSheets(store, userId);
    const after = await createBotThrough(app, userId);

    expect(await heldThrough(app, userId, before)).toEqual(SHEETS_REFS);
    expect(await heldThrough(app, userId, after)).toEqual(SHEETS_REFS);

    // And the trail names the second Bot once per tool, by the deployment: nobody pressed
    // anything for it, and a row saying a person did would be a row saying something false.
    const granted = auditRows.filter(
      (row) =>
        row.payload.change === "plugin_granted" && row.payload.bot === after,
    );
    expect(granted.map((row) => row.payload.ref).sort()).toEqual(SHEETS_REFS);
    expect(new Set(granted.map((row) => row.payload.actor))).toEqual(
      new Set(["deployment"]),
    );
  });

  test("offering a Bot what it already holds writes nothing", async () => {
    const { app, store } = deployment();
    const userId = await createUser();
    await connectSheets(store, userId);
    const botId = await createBotThrough(app, userId);
    const trailBefore = auditRows.length;

    // The boot-and-reconnect case: the same offer again must not rewrite rows of trail.
    await store.offerConnectionsTo(botId, userId, "deployment");
    // And a reconnect reaching the Bots that exist must not either.
    await store.offerToolsTo(serverId, userId, userId);

    expect(auditRows.length).toBe(trailBefore);
    expect(await heldThrough(app, userId, botId)).toEqual(SHEETS_REFS);
  });

  test("a Bot made by somebody who connected nothing is handed nothing", async () => {
    const { app, store } = deployment();
    const connected = await createUser();
    const other = await createUser();
    // Somebody ELSE's connection exists on this deployment. What is pinned is that the grant
    // follows the owner's own consent and nobody else's.
    await connectSheets(store, connected);
    const botId = await createBotThrough(app, other);

    expect(await heldThrough(app, other, botId)).toEqual([]);
  });
});
