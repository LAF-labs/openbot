import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import {
  createCredentialStore,
  decryptSecret,
  encryptSecret,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  credentials,
  mcpServers,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import {
  type AccessToken,
  createPluginStore,
  INVALID_CLIENT,
  type OAuthClient,
  PluginRefusedError,
  TokenRefusedError,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * Whose credential a call to a `user-oauth` server goes out with, and what the deployment does when
 * the vendor stops recognising it.
 *
 * Every test here is a refusal, a selection or a rotation, and they matter for one reason: this is
 * the mechanism that makes two people asking the same question get the answers their OWN accounts can
 * see. The failure that must not exist is a call falling back to somebody else's grant, or to the
 * deployment's, when the asker has none. That failure is silent by nature — it returns a plausible
 * answer assembled from documents the asker cannot open — so it is asserted directly rather than
 * inferred from a happy path working.
 *
 * NOTHING HERE REACHES A VENDOR. The token exchange, the client registration and the tool call are
 * all injected, and the two places that hold a hardcoded `fetch` — disconnect's revocation — are
 * driven through a controlled one. That is not only speed: another suite in this repository installs
 * a process-wide `mock.module` on the MCP client, so "it failed at the network" is true alone and
 * false in a full run. Whose credential was about to be spent is the property under test, and it has
 * to be observable without anybody being reachable.
 *
 * THIS SUITE BORROWS LIVE CONFIGURATION. The per-person machinery keys off `catalogueEntry(serverId)`,
 * so a made-up server id exercises none of it and the fixture has to be a real catalogue key. On a
 * database somebody uses that means a real connector row and a real OAuth client, so everything this
 * file touches at that key is snapshotted in `beforeAll` and put back in `afterAll` — including the
 * revocation state of a client an administrator registered, which registering over would otherwise
 * retire for good.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const suite = randomUUID().slice(0, 8);

/** A catalogue key, because `user-oauth` behaviour exists only for an entry that declares it. */
const serverId = "notion";
/** The vault key a server's OAuth client is held under. Not suite-scoped — the product decides it. */
const clientKeyId = `oauth-client-${serverId}`;

/**
 * A server of this suite's own, for the one act that deletes a row.
 *
 * `removeServer` retires every person's grant for a server and then deletes it, and doing that to a
 * real catalogue key would take an administrator's connector and its whole advertised tool list with
 * it. None of what it does is catalogue-specific — the grants are found in the vault by
 * `provider` — so a custom row proves the same thing and belongs to us.
 */
const removableId = `plugtest-remove-${suite}`;

const botId = `agent_oauth_bot_${suite}`;
/** One person per concern, so no test depends on what the one before it left behind. */
const asker = `user_oauth_asker_${suite}`;
const other = `user_oauth_other_${suite}`;
const rejoiner = `user_oauth_rejoiner_${suite}`;
const leaver = `user_oauth_leaver_${suite}`;
const retiree = `user_oauth_retiree_${suite}`;
const everybody = [asker, other, rejoiner, leaver, retiree];

const toolName = "notion-search";
const ref = `${serverId}/${toolName}`;

/** Where the vendor would send people back. Needed before a dynamic client can be registered. */
const REDIRECT_URI = "https://laf.example/api/plugins/oauth/callback";
/** The address Notion's entry pins for self-registration, asserted rather than assumed. */
const REGISTRATION_URL = "https://mcp.notion.com/register";

const policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

/* ── the seams ───────────────────────────────────────────────────────────────────────────────── */

/** Every refresh token presented at the vendor's token endpoint, with the client it was presented as. */
const exchanged: { refreshToken: string; client: OAuthClient }[] = [];
/** What the token endpoint does next. Reset before each group that cares. */
let exchange: (input: {
  tokenUrl: string;
  client: OAuthClient;
  refreshToken: string;
}) => Promise<AccessToken> = async ({ refreshToken }) => ({
  accessToken: accessFrom(refreshToken),
});

/** Every self-registration this deployment attempted. */
const registrations: { registrationUrl: string; redirectUri: string }[] = [];
let register: (input: {
  registrationUrl: string;
  redirectUri: string;
}) => Promise<OAuthClient | null> = async () => null;

/**
 * Every client id this suite ever put in the vault, so the cleanup can name its own rows.
 *
 * The vault key for a server's OAuth client is the product's (`oauth-client-<server>`), not this
 * file's, so "delete what is under this key" would take a client an administrator registered — and
 * "delete what was not here at the start" would take one the running app registered WHILE the suite
 * was going, which is not hypothetical on a database shared with the app. The client id is recorded
 * in each row's metadata precisely so a reader can name a client without decrypting anything.
 */
const clientIdsWeMinted = new Set<string>();

/** Every token that was about to leave for the vendor's MCP endpoint. */
const sent: (string | undefined)[] = [];

/** So a test can tell which refresh token produced the access token that was sent. */
const accessFrom = (refreshToken: string) => `access(${refreshToken})`;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  approvals: createApprovalRegistry(),
  redirectUri: REDIRECT_URI,
  callVendor: async (connection) => {
    sent.push(connection.token);
    return { text: "[no vendor is reached in these tests]", isError: false };
  },
  exchangeRefreshToken: async (input) => {
    exchanged.push({ refreshToken: input.refreshToken, client: input.client });
    return await exchange(input);
  },
  registerClient: async (input) => {
    registrations.push(input);
    const client = await register(input);
    if (client) clientIdsWeMinted.add(client.clientId);
    return client;
  },
});

/* ── reading what was written ────────────────────────────────────────────────────────────────── */

/** The live vault row for one person's grant on this server, with its secret readable. */
async function liveGrant(userId: string, provider = serverId) {
  const [row] = await database
    .select({ id: credentials.id, encryptedValue: credentials.encryptedValue })
    .from(credentials)
    .where(
      and(
        eq(credentials.kind, "mcp_user_token"),
        eq(credentials.provider, provider),
        eq(credentials.keyId, userId),
        isNull(credentials.revokedAt),
      ),
    );
  if (!row) return null;
  return {
    id: row.id,
    refreshToken: await decryptSecret(ENCRYPTION_KEY, row.encryptedValue),
  };
}

/** What the join row says, which is the pointer a call follows. */
async function joinRow(userId: string, server = serverId) {
  const [row] = await database
    .select({
      credentialId: mcpUserCredentials.credentialId,
      scope: mcpUserCredentials.scope,
    })
    .from(mcpUserCredentials)
    .where(
      and(
        eq(mcpUserCredentials.serverId, server),
        eq(mcpUserCredentials.userId, userId),
      ),
    );
  return row ?? null;
}

const revokedAtOf = async (credentialId: string) => {
  const [row] = await database
    .select({ revokedAt: credentials.revokedAt })
    .from(credentials)
    .where(eq(credentials.id, credentialId));
  return row?.revokedAt ?? null;
};

/** The trail rows of one kind naming one actor, oldest first. */
async function trail(eventType: string, actor: string) {
  const rows = await database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, eventType),
        sql`${auditEvents.payload} ->> 'actor' = ${actor}`,
      ),
    )
    .orderBy(asc(auditEvents.createdAt));
  return rows.map((row) => row.payload as Record<string, unknown>);
}

/** What `mcp_servers` says this deployment's client is right now. */
const serverClientId = async (server = serverId) => {
  const [row] = await database
    .select({ credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, server));
  return row?.credentialId ?? null;
};

/**
 * A vendor's endpoint that answers however this test wants, for the length of one call.
 *
 * Only disconnect needs it: revocation is a bare `fetch` at the catalogue's pinned revoke URL with no
 * seam of its own, and letting it out would send a real deployment's traffic to Notion from a test.
 */
async function withVendor<T>(
  reply: () => Response,
  run: (asked: { url: string; form: URLSearchParams }[]) => Promise<T>,
): Promise<T> {
  const asked: { url: string; form: URLSearchParams }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    asked.push({
      url: String(url),
      form: new URLSearchParams(String(init?.body ?? "")),
    });
    return reply();
  }) as unknown as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ── fixtures ────────────────────────────────────────────────────────────────────────────────── */

/** The deployment's client, as an administrator's paste would leave it. */
const CLIENT: OAuthClient = {
  clientId: "client-id",
  clientSecret: "client-secret",
};

/**
 * Give the deployment a client for this server, whatever it had a moment ago.
 *
 * Through the store's own `registerOAuthClient` rather than by writing rows, because that is the
 * product path an administrator takes and it keeps the vault key, the pointer and the trail row
 * agreeing without this file having to know how.
 */
async function registerDeploymentClient(client: OAuthClient = CLIENT) {
  clientIdsWeMinted.add(client.clientId);
  await store.registerOAuthClient({
    serverId,
    client,
    by: `admin-${suite}@laf.test`,
  });
  const id = await serverClientId();
  if (!id) throw new Error("the fixture client was not stored");
  return id;
}

/**
 * Age the deployment's client past the re-registration backoff.
 *
 * `refuseAndReplaceEvictedClient` leaves a client younger than five minutes alone, because a vendor
 * that is simply down answers every exchange `invalid_client` and each call would otherwise mint a
 * client of its own. A client this suite created seconds ago is inside that window, so the recovery
 * can only be exercised by making the row as old as a real one would be.
 */
async function ageClient(credentialId: string, minutes: number) {
  await database
    .update(credentials)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(credentials.id, credentialId));
}

/** Whether this deployment already had the connector, so the cleanup knows what is ours to remove. */
let serverWasAlreadyConfigured = false;
/** The client pointer as it stood before the suite. Restored regardless of what happened. */
let clientBefore: string | null = null;
/**
 * Every `mcp_oauth_client` row for this vendor as the suite found it, with its revocation state.
 *
 * Registering a client ROTATES whatever live one the key holds — which on a database somebody uses is
 * an administrator's own, and rotating it revokes it for good. So the rows are remembered, ours are
 * deleted afterwards, and theirs are put back to the revocation state they were in.
 */
let clientRowsBefore: { id: string; revokedAt: Date | null }[] = [];

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();

  for (const id of everybody) {
    await database
      .insert(users)
      .values({ id, email: `${id}@laf.test`, name: id, emailVerified: false })
      .onConflictDoNothing();
  }

  const [existing] = await database
    .select({ credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  serverWasAlreadyConfigured = existing !== undefined;
  clientBefore = existing?.credentialId ?? null;
  clientRowsBefore = await database
    .select({ id: credentials.id, revokedAt: credentials.revokedAt })
    .from(credentials)
    .where(
      and(
        eq(credentials.kind, "mcp_oauth_client"),
        eq(credentials.provider, serverId),
      ),
    );

  // Written directly rather than through `addServer`, which lists the vendor's tools over the network
  // on the way in. What is under test is which credential gets chosen, not the listing.
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Notion",
      vendor: "Notion",
      url: "https://mcp.notion.com/mcp",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpServers)
    .values({
      id: removableId,
      title: "Removable test server",
      vendor: "mcp.test.invalid",
      url: "https://mcp.test.invalid/mcp",
      provenance: "custom",
    })
    .onConflictDoNothing();

  // The Bot holds the tool throughout. Everything here is about the person, not the grant.
  await database
    .insert(pluginGrants)
    .values({ kind: "mcp", ref, agentId: botId })
    .onConflictDoNothing();
});

afterAll(async () => {
  /*
   * The pointer first, because `mcp_servers.credential_id` is `restrict`: the deletes below remove
   * rows this column may still be addressing, and the foreign key exists to refuse exactly that.
   */
  await database
    .update(mcpServers)
    .set({ credentialId: clientBefore })
    .where(eq(mcpServers.id, serverId));
  await database
    .update(mcpServers)
    .set({ credentialId: null })
    .where(eq(mcpServers.id, removableId));

  // This suite's own people only, never every row for this vendor: a deployment somebody uses has
  // real connections under this key.
  await database
    .delete(mcpUserCredentials)
    .where(inArray(mcpUserCredentials.userId, everybody));
  await database
    .delete(credentials)
    .where(
      and(
        eq(credentials.kind, "mcp_user_token"),
        inArray(credentials.keyId, everybody),
      ),
    );
  await database
    .delete(credentials)
    .where(eq(credentials.provider, removableId));

  // Every client row this suite minted under the shared key, named by the client id in its metadata
  // — never "everything under this key" and never "everything that was not here at the start".
  if (clientIdsWeMinted.size > 0) {
    await database
      .delete(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_oauth_client"),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, clientKeyId),
          inArray(sql`${credentials.metadata} ->> 'clientId'`, [
            ...clientIdsWeMinted,
          ]),
        ),
      );
  }
  /*
   * And the revocation state of the rows that were already here, which registering over retires.
   *
   * Tolerant of a refusal, because `credentials_active_key_idx` holds one live row per key: if the
   * app registered a client of its own while this suite ran, un-revoking the older one is both
   * impossible and wrong, and the newer one is the client the deployment should keep.
   */
  for (const row of clientRowsBefore) {
    await database
      .update(credentials)
      .set({ revokedAt: row.revokedAt })
      .where(eq(credentials.id, row.id))
      .catch(() => {});
  }

  await database
    .delete(pluginGrants)
    .where(and(eq(pluginGrants.ref, ref), eq(pluginGrants.agentId, botId)));
  await database.delete(mcpServers).where(eq(mcpServers.id, removableId));
  if (!serverWasAlreadyConfigured) {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(inArray(users.id, everybody));
});

/* ── connecting ──────────────────────────────────────────────────────────────────────────────── */

describe("recording that somebody connected", () => {
  test("puts the grant in the vault under their own key, and points a row at it", async () => {
    await store.recordConnection({
      serverId,
      userId: rejoiner,
      refreshToken: "rt-rejoiner-1",
      scope: "read",
    });

    const grant = await liveGrant(rejoiner);
    // Keyed by person, so the vault can still answer "whose is this" once the join row is gone.
    expect(grant?.refreshToken).toBe("rt-rejoiner-1");
    expect(await joinRow(rejoiner)).toEqual({
      credentialId: grant?.id ?? "",
      scope: "read",
    });

    const rows = await trail("mcp.account_connected", rejoiner);
    expect(rows.at(-1)).toMatchObject({
      server: serverId,
      // What the vendor granted, so a later refusal for want of a scope can be explained.
      scope: "read",
      reconnected: false,
    });
  });

  test("reconnecting replaces the grant rather than adding a second one", async () => {
    const before = await liveGrant(rejoiner);

    await store.recordConnection({
      serverId,
      userId: rejoiner,
      refreshToken: "rt-rejoiner-2",
      scope: "read update",
    });

    const after = await liveGrant(rejoiner);
    expect(after?.refreshToken).toBe("rt-rejoiner-2");
    // A different row, and the one it replaced is retired: what they held before is still a live
    // grant at the vendor, and revoking is how it stops being one. Left behind, somebody would have
    // two valid grants and could only ever see one of them to withdraw it.
    expect(after?.id).not.toBe(before?.id);
    expect(await revokedAtOf(before?.id ?? "")).not.toBeNull();

    // The pointer moved with it, so nothing reads the retired one.
    expect(await joinRow(rejoiner)).toEqual({
      credentialId: after?.id ?? "",
      scope: "read update",
    });
    // One row for the pair, not two. "Which credential serves this person" has exactly one answer.
    expect(await store.connectionsFor(rejoiner)).toHaveLength(1);

    const rows = await trail("mcp.account_connected", rejoiner);
    // The one fact the caller cannot recover afterwards, so the trail is where it has to be said.
    expect(rows.at(-1)).toMatchObject({
      reconnected: true,
      scope: "read update",
    });
  });

  test("the trail never carries the refresh token itself", async () => {
    const rows = await trail("mcp.account_connected", rejoiner);
    expect(JSON.stringify(rows)).not.toContain("rt-rejoiner-2");
  });
});

/* ── whose token goes out ────────────────────────────────────────────────────────────────────── */

describe("a person who has not connected", () => {
  test("is refused, and told to connect rather than told it broke", async () => {
    await registerDeploymentClient();
    sent.length = 0;
    exchanged.length = 0;

    const thrown = await store
      .callTool({ ref, args: {}, botId, actorId: other })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    // A refusal, not an error. Nothing is wrong: they simply have not granted access yet, and the
    // code says which fact that is. The English beside it is a placeholder until the surface writes
    // this in Korean, so the code is what is pinned here and not the sentence.
    expect((thrown as PluginRefusedError).code).toBe("laf:not_connected");
    /*
     * THE FALLBACK THAT MUST NOT EXIST. A deployment credential is registered above and is right
     * there to be spent. Answering from it would return a confident answer assembled from documents
     * this person cannot open, which looks exactly like a correct answer.
     */
    expect(sent).toEqual([]);
    expect(exchanged).toEqual([]);
  });

  test("a run attributed to nobody cannot borrow a connected person's access", async () => {
    await registerDeploymentClient();
    await store.recordConnection({
      serverId,
      userId: asker,
      refreshToken: "rt-asker-1",
      scope: "read",
    });
    sent.length = 0;
    exchanged.length = 0;

    // The anonymous actor is the empty string, and an empty string must never match a row. Refused
    // before the query rather than trusted to miss it.
    const thrown = await store
      .callTool({ ref, args: {}, botId, actorId: "" })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as Error).message).toContain("not attributed to anybody");
    expect(sent).toEqual([]);
    expect(exchanged).toEqual([]);
  });
});

describe("a person who has connected", () => {
  test("goes out on their own grant, spent as this deployment's client", async () => {
    await registerDeploymentClient();
    await store.recordConnection({
      serverId,
      userId: asker,
      refreshToken: "rt-asker-1",
      scope: "read",
    });
    await store.recordConnection({
      serverId,
      userId: other,
      refreshToken: "rt-other-1",
      scope: "read",
    });
    exchange = async ({ refreshToken }) => ({
      accessToken: accessFrom(refreshToken),
    });

    sent.length = 0;
    exchanged.length = 0;
    await store.callTool({ ref, args: {}, botId, actorId: asker });

    // Their refresh token, presented as the deployment's client — which is the whole shape of the
    // grant: the client identifies us, the token identifies them.
    expect(exchanged).toEqual([{ refreshToken: "rt-asker-1", client: CLIENT }]);
    // And what left the building is the short-lived token minted from it.
    expect(sent).toEqual([accessFrom("rt-asker-1")]);
    // Never the refresh token: it is long-lived and reauthorises indefinitely, and a regression here
    // would be invisible in behaviour.
    expect(sent).not.toContain("rt-asker-1");

    sent.length = 0;
    exchanged.length = 0;
    await store.callTool({ ref, args: {}, botId, actorId: other });
    expect(exchanged.map((call) => call.refreshToken)).toEqual(["rt-other-1"]);
    expect(sent).toEqual([accessFrom("rt-other-1")]);
  });

  test("is refused once their grant is withdrawn, and told to connect again", async () => {
    await registerDeploymentClient();
    await store.recordConnection({
      serverId,
      userId: asker,
      refreshToken: "rt-asker-1",
      scope: "read",
    });
    const grant = await liveGrant(asker);
    await database
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(eq(credentials.id, grant?.id ?? ""));
    sent.length = 0;
    exchanged.length = 0;

    /*
     * A refusal rather than a thrown vault error. The vault already refuses a revoked secret, but by
     * throwing — which reaches the person as "that tool could not be called", indistinguishable from
     * the vendor being down. A withdrawn grant is not a fault, and the sentence should say so.
     */
    const thrown = await store
      .callTool({ ref, args: {}, botId, actorId: asker })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as Error).message).toContain("withdrawn");
    expect(sent).toEqual([]);
    expect(exchanged).toEqual([]);
  });

  test("is told plainly when the deployment holds no client at all", async () => {
    await store.recordConnection({
      serverId,
      userId: asker,
      refreshToken: "rt-asker-1",
      scope: "read",
    });
    await database
      .update(mcpServers)
      .set({ credentialId: null })
      .where(eq(mcpServers.id, serverId));
    sent.length = 0;
    exchanged.length = 0;

    // Notion registers its own clients, so the instruction names what will actually fix it — connect
    // again — rather than sending them to an administrator with no step to take.
    const thrown = await store
      .callTool({ ref, args: {}, botId, actorId: asker })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as Error).message).toContain("no OAuth client");
    expect((thrown as Error).message).toContain(
      "Connect Notion again in Settings",
    );
    expect(exchanged).toEqual([]);
  });
});

/* ── the vendor rotating the grant ───────────────────────────────────────────────────────────── */

describe("a vendor that rotates the refresh token", () => {
  test("carries the connection over in place, and presents the new one next time", async () => {
    await registerDeploymentClient();
    await store.recordConnection({
      serverId,
      userId: asker,
      refreshToken: "initial",
      scope: "read",
    });
    const before = await liveGrant(asker);
    const consentsBefore = (await trail("mcp.account_connected", asker)).length;
    exchange = async ({ refreshToken }) => ({
      accessToken: accessFrom(refreshToken),
      refreshToken: "next-1",
    });
    exchanged.length = 0;

    await store.callTool({ ref, args: {}, botId, actorId: asker });

    const after = await liveGrant(asker);
    // The token the vendor just issued is the only one that still works, so failing to persist it
    // would strand the connection on the next call.
    expect(after?.refreshToken).toBe("next-1");
    /*
     * IN PLACE, not a swap. A rotating vendor issues a new token on every exchange, so minting and
     * revoking a row per tool call would be a row per call forever on the hottest path there is — and
     * the revocation would have nothing to withdraw, since the token just spent died at the vendor
     * the moment it answered.
     */
    expect(after?.id).toBe(before?.id);
    expect(await joinRow(asker)).toMatchObject({
      credentialId: before?.id ?? "",
    });

    // And no row is added for it: rotation is the vendor's plumbing, not a person's act, and a trail
    // recording it as one reads as a re-consent nobody performed. Counted across the call rather than
    // asserted absolutely, because this person really has connected several times above.
    expect(await trail("mcp.account_connected", asker)).toHaveLength(
      consentsBefore,
    );

    exchange = async ({ refreshToken }) => ({
      accessToken: accessFrom(refreshToken),
      refreshToken: "next-2",
    });
    exchanged.length = 0;
    await store.callTool({ ref, args: {}, botId, actorId: asker });
    // Read fresh from the vault on the second call, rather than from anything held in memory.
    expect(exchanged.map((call) => call.refreshToken)).toEqual(["next-1"]);
  });

  test("a vendor that echoes the token back rotates nothing", async () => {
    await registerDeploymentClient();
    await store.recordConnection({
      serverId,
      userId: asker,
      refreshToken: "same-1",
      scope: "read",
    });
    const before = await liveGrant(asker);
    // Writing this would be inventing a rotation, at the cost of re-encrypting every connection on
    // every call.
    exchange = async ({ refreshToken }) => ({
      accessToken: accessFrom(refreshToken),
      refreshToken,
    });

    await store.callTool({ ref, args: {}, botId, actorId: asker });

    const after = await liveGrant(asker);
    expect(after?.id).toBe(before?.id);
    expect(after?.refreshToken).toBe("same-1");
  });

  /**
   * TWO CALLS AT ONCE ON ONE CONNECTION, against a vendor that behaves like a real rotating one.
   *
   * This is the failure that cannot be found by reading. A rotating vendor kills the token it was
   * shown, so two callers that both read the stored token and both present it do not merely race: the
   * second presentation looks to the vendor like a stolen token being replayed, and refresh-token
   * reuse detection answers that by revoking the whole family. The connection is bricked and nobody
   * did anything wrong.
   *
   * So the stub REFUSES a token it has already seen, which is what makes this test able to fail. Both
   * calls have to succeed, and the endpoint has to have been shown the two tokens in order.
   */
  test("two calls at once are serialised, so neither replays a spent token", async () => {
    await registerDeploymentClient();
    await store.recordConnection({
      serverId,
      userId: asker,
      refreshToken: "initial",
      scope: "read",
    });

    const spent = new Set<string>();
    const seen: string[] = [];
    let issued = 0;
    exchange = async ({ refreshToken }) => {
      if (spent.has(refreshToken)) {
        throw new Error(`the vendor was shown a spent token: ${refreshToken}`);
      }
      spent.add(refreshToken);
      seen.push(refreshToken);
      issued += 1;
      return {
        accessToken: accessFrom(refreshToken),
        refreshToken: `next-${issued}`,
      };
    };
    sent.length = 0;

    const results = await Promise.all([
      store.callTool({ ref, args: {}, botId, actorId: asker }),
      store.callTool({ ref, args: {}, botId, actorId: asker }),
    ]);

    expect(results.map((result) => result.isError)).toEqual([false, false]);
    // In order, and the second is the token the first one's rotation wrote — read inside the critical
    // section rather than carried in from before the queue.
    expect(seen).toEqual(["initial", "next-1"]);
    expect((await liveGrant(asker))?.refreshToken).toBe("next-2");
    expect(sent.sort()).toEqual(
      [accessFrom("initial"), accessFrom("next-1")].sort(),
    );
  });
});

/* ── the vendor disowning the client ─────────────────────────────────────────────────────────── */

describe("a vendor that no longer recognises this deployment's client", () => {
  test("registers again, refuses the call, and says which of those happened", async () => {
    const evicted = await registerDeploymentClient();
    // Older than the backoff window, which is what a client in this situation really is.
    await ageClient(evicted, 10);
    await store.recordConnection({
      serverId,
      userId: asker,
      refreshToken: "rt-asker-1",
      scope: "read",
    });
    exchange = async () => {
      throw new TokenRefusedError(
        "The vendor would not renew this access (401). (invalid_client)",
        INVALID_CLIENT,
      );
    };
    register = async () => ({ clientId: "dyn-fresh", clientSecret: "" });
    registrations.length = 0;
    sent.length = 0;

    const thrown = await store
      .callTool({ ref, args: {}, botId, actorId: asker })
      .catch((error: unknown) => error);

    /*
     * REGISTERING AGAIN DOES NOT MAKE THIS CALL POSSIBLE. A refresh token is bound to the client it
     * was issued to (RFC 6749 §6, §10.4), so a conforming vendor refuses a retry under the new one —
     * and the only vendor it could work against is one whose acceptance would itself be the
     * vulnerability. So the grant is never carried across and the person is told the thing that helps.
     */
    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as Error).message).toBe(
      "Notion no longer recognises this deployment's OAuth client, so this cannot be called. The deployment has registered itself again — connect Notion again in Settings.",
    );
    expect(sent).toEqual([]);

    // Once, at the address the catalogue pins, with the redirect URI the deployment is configured for.
    expect(registrations).toEqual([
      { registrationUrl: REGISTRATION_URL, redirectUri: REDIRECT_URI },
    ]);

    // The deployment now holds the new client, and the evicted one is retired rather than orphaned.
    const now = await serverClientId();
    expect(now).not.toBe(evicted);
    expect(await revokedAtOf(evicted)).not.toBeNull();

    const rows = await trail("mcp.oauth_client_registered", "deployment");
    expect(rows.at(-1)).toMatchObject({
      server: serverId,
      // The id, never the secret: it is what a reader checks against the vendor's console.
      clientId: "dyn-fresh",
      replaced: true,
    });
  });

  /**
   * THE AMPLIFICATION THE BACKOFF EXISTS TO STOP.
   *
   * This runs for any non-administrator's tool call and it REPLACES the client every other connection
   * in the deployment is bound to. A vendor that is simply down answers every exchange
   * `invalid_client`, so without the window each call in turn would rotate the deployment-wide
   * client — every one of them being the first refusal IT has seen.
   */
  test("a second refusal moments later is reported rather than answered with another client", async () => {
    // The client from the test above is seconds old, which is exactly the state this guards.
    registrations.length = 0;

    const thrown = await store
      .callTool({ ref, args: {}, botId, actorId: asker })
      .catch((error: unknown) => error);

    // The vendor's own refusal, unedited — which is the honest answer when there is nothing to do.
    expect(thrown).toBeInstanceOf(TokenRefusedError);
    expect((thrown as TokenRefusedError).code).toBe(INVALID_CLIENT);
    expect(registrations).toEqual([]);
  });

  test("a refusal that is not about the client is never a reason to re-register", async () => {
    const client = await registerDeploymentClient();
    await ageClient(client, 10);
    exchange = async () => {
      throw new TokenRefusedError(
        "The vendor would not renew this access (400). (invalid_grant)",
        "invalid_grant",
      );
    };
    registrations.length = 0;

    const thrown = await store
      .callTool({ ref, args: {}, botId, actorId: asker })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TokenRefusedError);
    expect((thrown as TokenRefusedError).code).toBe("invalid_grant");
    // The client is not the problem, so replacing it would break every other connection for nothing.
    expect(registrations).toEqual([]);
    expect(await serverClientId()).toBe(client);
  });
});

/* ── obtaining a client in the first place ───────────────────────────────────────────────────── */

describe("introducing this deployment to a vendor that issues its own clients", () => {
  /** Leave the deployment holding no client at all, which is the ordinary state of a new connector. */
  async function forgetClient() {
    await database
      .update(mcpServers)
      .set({ credentialId: null })
      .where(eq(mcpServers.id, serverId));
    await database
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(credentials.kind, "mcp_oauth_client"),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, clientKeyId),
          isNull(credentials.revokedAt),
        ),
      );
  }

  test("registers one on first connect and keeps it", async () => {
    await forgetClient();
    register = async () => ({ clientId: "dyn-first", clientSecret: "" });
    registrations.length = 0;

    const client = await store.ensureOAuthClient(serverId, "person@laf.test");

    expect(client).toEqual({ clientId: "dyn-first", clientSecret: "" });
    expect(registrations).toEqual([
      { registrationUrl: REGISTRATION_URL, redirectUri: REDIRECT_URI },
    ]);
    // Kept, so the callback can redeem against the same client the consent screen named.
    expect(await store.oauthClientFor(serverId)).toEqual({
      clientId: "dyn-first",
      clientSecret: "",
    });
    expect(await serverClientId()).not.toBeNull();

    const rows = await trail("mcp.oauth_client_registered", "person@laf.test");
    expect(rows.at(-1)).toMatchObject({ clientId: "dyn-first" });
  });

  test("a vendor that refuses leaves the deployment holding nothing", async () => {
    await forgetClient();
    register = async () => null;
    registrations.length = 0;

    expect(
      await store.ensureOAuthClient(serverId, "person@laf.test"),
    ).toBeNull();
    expect(registrations).toHaveLength(1);
    // Nothing half-written: a stored client that the vendor never issued could never complete a
    // consent flow, and would look configured on every screen.
    expect(await store.oauthClientFor(serverId)).toBeNull();
  });

  /**
   * TWO PEOPLE PRESSING CONNECT AT ONCE, which is the ordinary first hour of a connector.
   *
   * Registering twice is not merely wasteful: the loser's consent screen names a client the vault no
   * longer holds, so that person consents and their callback then redeems the code against the client
   * that replaced it — a connect that fails AFTER the vendor already said yes. The advisory lock, and
   * asking "do we hold one" again inside it, is what makes the second caller find the first's client.
   */
  test("two people connecting at once get one client between them", async () => {
    await forgetClient();
    let issued = 0;
    register = async () => {
      issued += 1;
      // A sleep, so the two callers really do overlap rather than finishing in turn by accident.
      await Bun.sleep(25);
      return { clientId: `dyn-race-${issued}`, clientSecret: "" };
    };
    registrations.length = 0;

    const [first, second] = await Promise.all([
      store.ensureOAuthClient(serverId, "one@laf.test"),
      store.ensureOAuthClient(serverId, "two@laf.test"),
    ]);

    expect(registrations).toHaveLength(1);
    expect(first?.clientId).toBe("dyn-race-1");
    // The same client, so both consent screens name something the callback can redeem against.
    expect(second?.clientId).toBe(first?.clientId);
    expect((await store.oauthClientFor(serverId))?.clientId).toBe("dyn-race-1");

    // And only one live row for the key, which is what the vault's own index insists on anyway.
    const live = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_oauth_client"),
          eq(credentials.provider, serverId),
          eq(credentials.keyId, clientKeyId),
          isNull(credentials.revokedAt),
        ),
      );
    expect(live).toHaveLength(1);
  });

  test("a client already held is handed back without asking the vendor again", async () => {
    await registerDeploymentClient({ clientId: "held-1", clientSecret: "s" });
    registrations.length = 0;

    expect(await store.ensureOAuthClient(serverId, "person@laf.test")).toEqual({
      clientId: "held-1",
      clientSecret: "s",
    });
    expect(registrations).toEqual([]);
  });
});

/* ── disconnecting ───────────────────────────────────────────────────────────────────────────── */

describe("one person disconnecting their own account", () => {
  test("retires the grant here even when the vendor will not answer", async () => {
    await registerDeploymentClient();
    await store.recordConnection({
      serverId,
      userId: leaver,
      refreshToken: "rt-leaver-1",
      scope: "read",
    });
    const grant = await liveGrant(leaver);

    const asked = await withVendor(
      () => new Response("no", { status: 503 }),
      async (asked) => {
        expect(
          await store.disconnectAccount({ serverId, userId: leaver }),
        ).toEqual({ disconnected: true });
        return asked;
      },
    );

    // Told to the vendor at the address its own entry pins, with the client, because RFC 7009 lets a
    // vendor demand client authentication and a public client's id alone satisfies the ones that do.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe("https://mcp.notion.com/token");
    expect(asked[0]?.form.get("token_type_hint")).toBe("refresh_token");
    expect(asked[0]?.form.get("client_id")).toBe(CLIENT.clientId);

    // A vendor that will not answer must not hold somebody's disconnect hostage: the local half still
    // happens, and the trail says which half did.
    expect(await revokedAtOf(grant?.id ?? "")).not.toBeNull();
    expect(await joinRow(leaver)).toBeNull();
    expect(await store.connectionsFor(leaver)).toEqual([]);

    const rows = await trail("mcp.account_disconnected", leaver);
    expect(rows.at(-1)).toMatchObject({
      server: serverId,
      owner: leaver,
      reason: "person_disconnected",
      vendorRevoked: false,
    });
  });

  test("disconnecting something they never connected is quiet, not an error", async () => {
    const before = (await trail("mcp.account_disconnected", leaver)).length;

    const asked = await withVendor(
      () => new Response("ok", { status: 200 }),
      async (asked) => {
        expect(
          await store.disconnectAccount({ serverId, userId: leaver }),
        ).toEqual({ disconnected: false });
        return asked;
      },
    );

    // Nothing to tell the vendor about, and nothing to record: there was no grant.
    expect(asked).toEqual([]);
    expect(await trail("mcp.account_disconnected", leaver)).toHaveLength(
      before,
    );
  });
});

/* ── offboarding ─────────────────────────────────────────────────────────────────────────────── */

/*
 * "We removed their access" has to be true of the thing that matters, which is the refresh token
 * sitting in this deployment's vault. For a per-person connector it is the first thing a customer
 * asks about, and the session is only the half they cannot use.
 */
describe("retiring every credential one person owns", () => {
  const liveTokensFor = async (userId: string) =>
    (
      await database
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.kind, "mcp_user_token"),
            eq(credentials.keyId, userId),
            isNull(credentials.revokedAt),
          ),
        )
    ).length;

  /**
   * THE ORPHAN. `mcp_user_credentials.user_id` cascades, so deleting a user row takes the join row
   * with it and leaves the credential behind: unrevoked, referenced by nothing, reachable from no
   * screen. Looking the owner up in the VAULT by `key_id` rather than through the join table is what
   * makes it reachable at all, so that is asserted rather than assumed.
   */
  test("finds a grant whose join row the cascade already took", async () => {
    await registerDeploymentClient();
    await store.recordConnection({
      serverId,
      userId: retiree,
      refreshToken: "rt-retiree-1",
      scope: "read",
    });
    const grant = await liveGrant(retiree);
    // Exactly what the cascade leaves behind.
    await database
      .delete(mcpUserCredentials)
      .where(eq(mcpUserCredentials.userId, retiree));

    const { retired } = await store.retireConnectionsFor(
      retiree,
      `admin-${suite}@laf.test`,
    );

    expect(retired).toBe(1);
    expect(await revokedAtOf(grant?.id ?? "")).not.toBeNull();
    expect(await liveTokensFor(retiree)).toBe(0);

    const rows = await trail(
      "mcp.account_disconnected",
      `admin-${suite}@laf.test`,
    );
    expect(rows.at(-1)).toMatchObject({
      server: serverId,
      owner: retiree,
      // Not "they disconnected": an administrator removed them, and an auditor asking what happened
      // to their access should see which of the three this was.
      reason: "person_removed",
      // Said plainly rather than implied: the grant at the vendor outlives this.
      vendorRevoked: false,
    });
  });

  test("retiring twice is quiet, and nobody owns nothing", async () => {
    await store.recordConnection({
      serverId,
      userId: retiree,
      refreshToken: "rt-retiree-2",
      scope: "read",
    });

    expect(
      (await store.retireConnectionsFor(retiree, "admin@laf.test")).retired,
    ).toBe(1);
    // Already revoked is something an administrator can legitimately do twice.
    expect(
      (await store.retireConnectionsFor(retiree, "admin@laf.test")).retired,
    ).toBe(0);
    // The anonymous actor owns nothing, and must not match rows by being empty.
    expect(
      (await store.retireConnectionsFor("", "admin@laf.test")).retired,
    ).toBe(0);
    expect(await store.connectionsFor(retiree)).toEqual([]);
  });
});

/* ── removing the connector ──────────────────────────────────────────────────────────────────── */

describe("an administrator removing a whole connector", () => {
  test("retires the deployment's credential and every person's grant on it", async () => {
    /*
     * A server of this suite's own. `removeServer` deletes the row and cascades the advertised tool
     * list with it, so doing this to a catalogue key would take an administrator's connector — and
     * nothing it does is catalogue-specific: the grants are found in the vault by `provider`.
     */
    const [deploymentCredential] = await database
      .insert(credentials)
      .values({
        kind: "mcp",
        provider: removableId,
        keyId: `token-${suite}`,
        metadata: {},
        encryptedValue: await encryptSecret(ENCRYPTION_KEY, "server-token"),
      })
      .returning({ id: credentials.id });
    await database
      .update(mcpServers)
      .set({ credentialId: deploymentCredential?.id })
      .where(eq(mcpServers.id, removableId));

    const held: string[] = [];
    for (const [userId, token] of [
      [asker, "rt-asker-removable"],
      [other, "rt-other-removable"],
    ] as const) {
      const [credential] = await database
        .insert(credentials)
        .values({
          kind: "mcp_user_token",
          provider: removableId,
          keyId: userId,
          metadata: {},
          encryptedValue: await encryptSecret(ENCRYPTION_KEY, token),
        })
        .returning({ id: credentials.id });
      if (!credential) throw new Error("the fixture grant was not stored");
      held.push(credential.id);
      await database.insert(mcpUserCredentials).values({
        serverId: removableId,
        userId,
        credentialId: credential.id,
        scope: "read",
      });
    }

    await store.removeServer(removableId, `admin-${suite}@laf.test`);

    // The deployment's own token first, which is what the server row pointed at.
    expect(await revokedAtOf(deploymentCredential?.id ?? "")).not.toBeNull();
    // And everybody's, whether or not their join row was still there to find them by.
    for (const id of held) {
      expect(await revokedAtOf(id)).not.toBeNull();
    }
    expect(await serverClientId(removableId)).toBeNull();
    expect(await joinRow(asker, removableId)).toBeNull();

    const rows = await trail(
      "mcp.account_disconnected",
      `admin-${suite}@laf.test`,
    );
    const removals = rows.filter((row) => row.server === removableId);
    expect(removals).toHaveLength(2);
    for (const row of removals) {
      // Neither "they disconnected" nor "they were removed": the connector went, and the person did
      // nothing at all.
      expect(row.reason).toBe("mcp_server_removed");
      expect(row.vendorRevoked).toBe(false);
    }
    // Whose each one was, read from `key_id` because the join row has been cascaded away by now.
    expect(removals.map((row) => row.owner).sort()).toEqual(
      [asker, other].sort(),
    );

    const [gone] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, removableId));
    expect(gone).toBeUndefined();
  });
});
