import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  mcpServers,
  mcpUserCredentials,
  users,
} from "../src/db/schema";
import {
  challengeFor,
  readConnectState,
  redirectUriFor,
} from "../src/plugins/oauth";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  CatalogueEntryUnknownError,
  createPluginStore,
  type OAuthClient,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * `POST /servers/:id/connect`: the gesture that sends somebody to a vendor to consent.
 *
 * Notion has no administrator step — nobody pastes a client id, so the first person to press Connect
 * is the one who makes this deployment introduce itself (RFC 7591). What that handler produces is a
 * single URL, and almost everything worth asserting about this flow is inside it: which client is
 * asking, where the vendor is told to answer, what proof the code will have to carry, and a sealed
 * state that only the callback can open.
 *
 * So the assertions here read the state back rather than checking that one is present. A connect that
 * mints a state the callback cannot open is a flow that fails AFTER the vendor already said yes, and
 * from the outside it looks exactly like a working one.
 *
 * The vendor is never reached: registration is injected. Everything else is the real store on the
 * real database, because the state has to name a person the callback would accept and `/connections`
 * has to be reading actual rows.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const suite = randomUUID().slice(0, 8);
const personId = `user_connect_${suite}`;
const strangerId = `user_connect_stranger_${suite}`;
const everybody = [personId, strangerId];

/** A catalogue key, because a vendor the catalogue does not name is refused before any of this. */
const serverId = "notion";
/** The vault key a server's OAuth client is held under. The product's, not this file's. */
const clientKeyId = `oauth-client-${serverId}`;

const PUBLIC_URL = "https://laf.example";
const APP_URL = "https://app.example";
const CALLBACK = `${PUBLIC_URL}/api/plugins/oauth/callback`;

/** What the injected registration hands back, so a test can say which client the URL is asking as. */
const REGISTERED: OAuthClient = { clientId: "dyn-connect", clientSecret: "" };

const policy: ActionPolicy = { deny: [], allow: ["true"] };

/** Every self-registration this deployment attempted, so "once, not twice" is assertable. */
const registrations: { registrationUrl: string; redirectUri: string }[] = [];

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  approvals: createApprovalRegistry(),
  // The value the handler is configured with, so what gets registered is what the callback presents.
  redirectUri: redirectUriFor(PUBLIC_URL),
  registerClient: async (input) => {
    registrations.push(input);
    return REGISTERED;
  },
  // Neither is on any path this file drives. Loud rather than absent, so one that started to reach
  // the network shows up as a failure instead of going quietly out of the building.
  callVendor: async () => {
    throw new Error("this suite never calls a vendor tool");
  },
  exchangeRefreshToken: async () => {
    throw new Error("this suite never spends a refresh token");
  },
});

/**
 * The routes as one signed-in person, driven directly.
 *
 * Driven here rather than through the running app because the shipped development default treats
 * every request as one local administrator, so a check that depends on WHOSE session it is
 * short-circuits on a laptop and would stay hidden until a real identity provider is wired up.
 */
function routesAs(
  actor: { id: string; email: string; role: "admin" | "user" },
  options: { connected?: boolean; store?: unknown } = {},
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor as never);
    await next();
  };
  const routes = createPluginRoutes(
    (options.store ?? store) as never,
    requireUser,
    options.connected === false
      ? undefined
      : {
          publicUrl: PUBLIC_URL,
          appUrl: APP_URL,
          encryptionKey: ENCRYPTION_KEY,
          // Only the callback asks this. Every test here stops at the authorization URL.
          personHasAccess: async () => true,
        },
  );
  return new Hono().route("/api/plugins", routes);
}

const asPerson = (options?: { connected?: boolean; store?: unknown }) =>
  routesAs(
    { id: personId, email: `${personId}@laf.test`, role: "user" },
    options,
  );

const connect = (hono: Hono, id = serverId, query = ""): Promise<Response> =>
  hono.request(`http://t/api/plugins/servers/${id}/connect${query}`, {
    method: "POST",
  });

/** The consent URL a successful connect answered with, parsed. */
async function authorizationUrl(response: Response): Promise<URL> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { authorizationUrl: string };
  return new URL(body.authorizationUrl);
}

/** What the sealed state on a consent URL actually says, read with this deployment's own key. */
const stateOn = (url: URL) =>
  readConnectState(url.searchParams.get("state") ?? "", ENCRYPTION_KEY);

/**
 * Leave the deployment holding no client, which is the ordinary state of a connector nobody has used.
 *
 * Both halves: the pointer on the server row, and the live vault row under the shared key. Either one
 * left behind would have `oauthClientFor` answer before the registration path is ever reached.
 */
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

/** Whether this deployment already had the connector, so the cleanup knows what is ours to remove. */
let serverWasAlreadyConfigured = false;
/** The client pointer as it stood before the suite. Restored regardless of what happened. */
let clientBefore: string | null = null;
/**
 * Every `mcp_oauth_client` row for this vendor as the suite found it, with its revocation state.
 *
 * This file registers a client under a vault key the PRODUCT chooses, which rotates — and thereby
 * revokes — whatever an administrator had registered. So the rows are remembered and put back, and
 * only the row carrying this suite's own client id is deleted: "everything that was not here at the
 * start" would take a client the running app registered while the suite was going, which is not
 * hypothetical on a database shared with the app.
 */
let clientRowsBefore: { id: string; revokedAt: Date | null }[] = [];

beforeAll(async () => {
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
  // on the way in. What is under test is the handler, not the listing.
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
});

afterAll(async () => {
  // The pointer first: `mcp_servers.credential_id` is `restrict`, and the delete below removes a row
  // this column may still be addressing.
  await database
    .update(mcpServers)
    .set({ credentialId: clientBefore })
    .where(eq(mcpServers.id, serverId));

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
    .where(
      and(
        eq(credentials.kind, "mcp_oauth_client"),
        eq(credentials.provider, serverId),
        eq(credentials.keyId, clientKeyId),
        sql`${credentials.metadata} ->> 'clientId' = ${REGISTERED.clientId}`,
      ),
    );
  /*
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

  if (!serverWasAlreadyConfigured) {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
  await database.delete(users).where(inArray(users.id, everybody));
});

/* ── what the handler refuses ────────────────────────────────────────────────────────────────── */

describe("a connect this deployment cannot complete", () => {
  test("a deployment with no public URL says so rather than minting a broken URL", async () => {
    // The redirect URI has to match what the vendor was registered with character for character, and
    // there is nothing honest to send without a public URL. Refused here, which is also what makes
    // the registration below safe: the URI it registers is guaranteed to exist.
    const response = await connect(asPerson({ connected: false }));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("BETTER_AUTH_URL");
    expect(registrations).toEqual([]);
  });

  test("a server the catalogue does not name is not connected as a person", async () => {
    const response = await connect(asPerson(), `not-a-vendor-${suite}`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      `not-a-vendor-${suite} is not connected as an individual person.`,
    );
    // Refused on the entry, before anything is asked of the store or the vendor.
    expect(registrations).toEqual([]);
  });

  /**
   * A catalogue vendor nobody has added to this deployment.
   *
   * The entry is real, so the handler gets past every check it makes about the vendor and then asks
   * the store for a client — which cannot answer, because there is no server row to hold one. That is
   * an administrator's missing step and the person pressing Connect can do nothing about it, so it is
   * a 409 they can be told about rather than an unhandled `CatalogueEntryUnknownError` and a 500.
   *
   * Driven through a store that raises it rather than by removing the server row: the row is live
   * configuration on a shared database, and what is under test here is the handler's mapping.
   */
  test("a vendor this deployment has not added is a 409, not a 500", async () => {
    const hono = asPerson({
      store: {
        ...store,
        oauthClientFor: async () => null,
        ensureOAuthClient: async (id: string) => {
          throw new CatalogueEntryUnknownError(id);
        },
      },
    });

    const response = await connect(hono);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Notion has not been added to this deployment yet. An administrator has to add it first.",
    );
  });

  test("a vendor that refuses this deployment's registration answers 502, naming it", async () => {
    const hono = asPerson({
      store: {
        ...store,
        oauthClientFor: async () => null,
        ensureOAuthClient: async () => null,
      },
    });

    const response = await connect(hono);

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Notion refused this deployment's registration. Try again, and check the vendor's status if it persists.",
    );
  });
});

/* ── the consent URL ─────────────────────────────────────────────────────────────────────────── */

describe("the first person to connect", () => {
  test("makes the deployment introduce itself, and gets a URL the callback can finish", async () => {
    await forgetClient();
    registrations.length = 0;

    const url = await authorizationUrl(await connect(asPerson()));

    // Registered once, at the address the entry pins, with the redirect URI this deployment is
    // configured for — the same value the callback will present at redemption.
    expect(registrations).toEqual([
      {
        registrationUrl: "https://mcp.notion.com/register",
        redirectUri: CALLBACK,
      },
    ]);

    // The vendor's own consent screen, from the entry rather than from anything on the request.
    expect(url.host).toBe("mcp.notion.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe(REGISTERED.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    /*
     * Notion has no scope strings: access is per page, chosen on the consent screen itself. An empty
     * `scope=` is not "no scope" — it is a malformed request to some vendors — so the key is absent.
     */
    expect(url.searchParams.has("scope")).toBe(false);

    /*
     * THE STATE, READ BACK RATHER THAN COUNTED.
     *
     * The callback has no session: who is connecting comes from here and nowhere else. A connect that
     * sealed a state the callback cannot open, or one naming the wrong person, fails after the vendor
     * has already said yes — and from the outside looks exactly like a working flow.
     */
    const state = await stateOn(url);
    expect(state?.userId).toBe(personId);
    expect(state?.serverId).toBe(serverId);
    // Absent from the request, so it is the screen every flow used to end on.
    expect(state?.returnTo).toBe("settings");

    // And the proof matches: the challenge the vendor is shown is the S256 of the verifier that only
    // this deployment can read out of the state.
    expect(challengeFor(state?.verifier ?? "")).toBe(
      url.searchParams.get("code_challenge"),
    );
    // Which is the point of sealing rather than signing: the verifier travels on the same URL as the
    // code will, and every log that URL passes through would otherwise hold enough to redeem it.
    expect(url.toString()).not.toContain(state?.verifier ?? "no verifier");

    // The client is kept, so the callback redeems against the one the consent screen actually named.
    expect(await store.oauthClientFor(serverId)).toEqual(REGISTERED);
  });

  /**
   * THE SECOND PERSON, moments later.
   *
   * Registering again is not merely wasteful: the loser's consent screen names a client the vault no
   * longer holds, so that person consents and their callback then redeems against the client that
   * replaced it. Whoever asks second is handed the client the deployment already has.
   */
  test("does not make it introduce itself a second time", async () => {
    registrations.length = 0;

    const url = await authorizationUrl(
      await connect(
        routesAs({
          id: strangerId,
          email: `${strangerId}@laf.test`,
          role: "user",
        }),
      ),
    );

    expect(registrations).toEqual([]);
    expect(url.searchParams.get("client_id")).toBe(REGISTERED.clientId);
    // Their own state, naming them — never the person who happened to register the client.
    expect((await stateOn(url))?.userId).toBe(strangerId);
  });

  test("two people connecting get different verifiers", async () => {
    // A verifier is single-use and the only thing binding a code to the request that started it.
    // Reusing one across people would mean either of them could redeem the other's code.
    const first = await stateOn(
      await authorizationUrl(await connect(asPerson())),
    );
    const second = await stateOn(
      await authorizationUrl(await connect(asPerson())),
    );

    expect(first?.verifier).not.toBe(second?.verifier);
    expect((first?.verifier ?? "").length).toBeGreaterThanOrEqual(43);
  });
});

describe("the screen somebody started on", () => {
  test("rides in the sealed state, so they are put back where they left", async () => {
    // The round trip this removes: an administrator who connected from the Plugins page used to be
    // put down on their personal settings page, mid-task, elsewhere in the app.
    const url = await authorizationUrl(
      await connect(asPerson(), serverId, "?returnTo=admin"),
    );

    expect((await stateOn(url))?.returnTo).toBe("admin");
  });

  /*
   * THE OPEN REDIRECT THIS CANNOT BECOME. A destination carried through an OAuth flow is the classic
   * shape of one: the callback arrives with a fresh consent behind it, so anything it will redirect
   * to is somewhere an attacker can send a person from a link that looked legitimate.
   *
   * Narrowed on the way IN, at the handler, rather than trusted and checked later — so a value naming
   * another origin is not carried into the sealed state at all, and the callback never has to decide
   * anything about it.
   */
  test("anywhere else is not carried, and never reaches the vendor either", async () => {
    for (const hostile of [
      "https://evil.test",
      "//evil.test",
      "/admin/plugins/../../evil",
      "ADMIN",
    ]) {
      const url = await authorizationUrl(
        await connect(
          asPerson(),
          serverId,
          `?returnTo=${encodeURIComponent(hostile)}`,
        ),
      );

      expect((await stateOn(url))?.returnTo).toBe("settings");
      expect(url.toString()).not.toContain("evil.test");
    }
  });
});

/* ── what somebody has connected ─────────────────────────────────────────────────────────────── */

describe("the list of accounts a person has connected", () => {
  test("is theirs alone, and names the address an administrator has to register", async () => {
    await store.recordConnection({
      serverId,
      userId: personId,
      refreshToken: `rt-${personId}`,
      scope: "read",
    });
    await store.recordConnection({
      serverId,
      userId: strangerId,
      refreshToken: `rt-${strangerId}`,
      scope: "read",
    });

    const response = await asPerson().request(
      "http://t/api/plugins/connections",
    );
    const body = (await response.json()) as {
      connections: { serverId: string; scope: string; connectedAt: string }[];
      redirectUri: string | null;
    };

    expect(response.status).toBe(200);
    // One person's connections are not another person's business, and this endpoint is the only
    // thing standing between the two: it reads from the session, never from the request.
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.serverId).toBe(serverId);
    expect(body.connections[0]?.scope).toBe("read");
    expect(body.connections[0]?.connectedAt).not.toBe("");
    // Shown to an administrator so they can register a client at the vendor with the exact value this
    // deployment will send. A character out and the vendor refuses, with a message that does not name us.
    expect(body.redirectUri).toBe(CALLBACK);
  });

  test("says there is no address to register when the deployment has no public URL", async () => {
    const response = await asPerson({ connected: false }).request(
      "http://t/api/plugins/connections",
    );
    const body = (await response.json()) as { redirectUri: string | null };

    // Null rather than a guess: a deployment with no public URL cannot complete a consent flow at
    // all, and offering a plausible-looking URI would send an administrator to register a dead one.
    expect(body.redirectUri).toBeNull();
  });
});
