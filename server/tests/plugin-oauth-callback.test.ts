import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  credentials,
  mcpServers,
  mcpUserCredentials,
  users,
} from "../src/db/schema";
import type { AppVariables } from "../src/auth/guards";
import type { MiddlewareHandler } from "hono";
import { challengeFor, sealConnectState } from "../src/plugins/oauth";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * `GET /oauth/callback`: the request the vendor sends somebody back on.
 *
 * It has no session by design — whose connection this is comes from the sealed state, not from
 * whatever cookie the browser happens to be carrying. That is what makes the state the only thing
 * standing between a consent screen and a live refresh token in this deployment's vault, and it is
 * why what the state says is checked against the deployment as it is when the callback LANDS rather
 * than as it was when the flow started ten minutes earlier.
 *
 * So this file is almost entirely about what must NOT be written. Driven against a real store on the
 * real database, because "nothing was written" is a claim about rows: a double recording that
 * `recordConnection` was not called proves only that the route did not call the double, while an
 * empty `mcp_user_credentials` and no `mcp.account_connected` prove the thing the customer cares
 * about. The fixture is complete enough that a write WOULD have landed — the server row, the person's
 * user row and a live OAuth client all exist — so the absence is a decision rather than a foreign key.
 *
 * The vendor is never really asked. One test drives the exchange, and it does so through a fetch that
 * refuses: pointing the suite at `https://mcp.notion.com/token` for real would be a test that depends
 * on somebody else's uptime and sends them traffic, and one that FABRICATES a Notion grant would be
 * asserting against a reply Notion does not give.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const suite = randomUUID().slice(0, 8);
const personId = `user_callback_${suite}`;
const removedId = `user_removed_${suite}`;

/**
 * A real catalogue key, because the per-person machinery keys off `catalogueEntry(serverId)` and a
 * made-up id is a server the callback refuses before any of this is exercised.
 *
 * Which means this suite borrows LIVE configuration on a database somebody uses. Everything it
 * touches is put back: the row is deleted only if this suite created it, and the client pointer is
 * restored to whatever it was regardless.
 */
const serverId = "notion";

const APP_URL = "https://app.example";
const PUBLIC_URL = "https://laf.example";
const FAILED = `${APP_URL}/settings/connected-accounts?connected=failed`;

const policy: ActionPolicy = { deny: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  approvals: createApprovalRegistry(),
  // Nothing here calls a tool or registers a client. Loud rather than absent, so a path that started
  // to reach either shows up as a failure instead of quietly going to the network.
  callVendor: async () => {
    throw new Error("this suite never calls a vendor tool");
  },
  registerClient: async () => {
    throw new Error("this suite never registers a client");
  },
});

/** Who the person in the state is, as far as the deployment is concerned. Recorded per request. */
const accessAsked: string[] = [];

function noSession(): MiddlewareHandler<{ Variables: AppVariables }> {
  // The callback is deliberately not behind `requireUser`, so what this stands in for is every OTHER
  // route on the same router. It sets no actor, which is what a request carrying no session has.
  return async (_context, next) => {
    await next();
  };
}

function appWith(input: {
  store?: unknown;
  personHasAccess?: (userId: string) => Promise<boolean>;
  /** Omitted entirely for the deployment that has no public URL to be sent back to. */
  connected?: boolean;
}) {
  const routes = createPluginRoutes(
    (input.store ?? store) as never,
    noSession(),
    input.connected === false
      ? undefined
      : {
          publicUrl: PUBLIC_URL,
          appUrl: APP_URL,
          encryptionKey: ENCRYPTION_KEY,
          personHasAccess: async (userId) => {
            accessAsked.push(userId);
            return (await input.personHasAccess?.(userId)) ?? true;
          },
        },
  );
  return new Hono().route("/api/plugins", routes);
}

/**
 * The real store, answering one read differently: the deployment holds a client.
 *
 * The client lives in the vault under a key the product chooses, so writing a fixture there would
 * ROTATE — and so revoke — whichever client an administrator had registered on a database somebody
 * uses. Overriding the read leaves every WRITE path the real one, which is what the assertions in
 * this file are about.
 */
const holdingAClient = () => ({
  ...store,
  oauthClientFor: async () => ({ clientId: "dyn-callback", clientSecret: "" }),
});

const callbackUrl = (query: Record<string, string>) =>
  `http://t/api/plugins/oauth/callback?${new URLSearchParams(query)}`;

const stateFor = (
  state: { userId: string; serverId: string; verifier: string },
  now?: number,
) => sealConnectState(state, ENCRYPTION_KEY, now);

/** Every request the controlled vendor received, so a test can say what was about to be sent. */
type VendorRequest = { url: string; form: URLSearchParams };

/**
 * A vendor that answers however this test wants, for the length of one call.
 *
 * `globalThis.fetch` rather than a stub on the store, because the callback reaches the vendor through
 * `redeemAuthorizationCode` — a module function with the token URL pinned by the catalogue, and no
 * seam of its own. Restored in a `finally`, since a leaked global would silently answer every later
 * file in the run.
 */
async function withVendor<T>(
  reply: () => Response | Promise<Response>,
  run: (asked: VendorRequest[]) => Promise<T>,
): Promise<T> {
  const asked: VendorRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    asked.push({
      url: String(url),
      form: new URLSearchParams(String(init?.body ?? "")),
    });
    return await reply();
  }) as unknown as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** What this person's connections and consent trail look like right now. */
async function written(userId: string) {
  const rows = await database
    .select({ credentialId: mcpUserCredentials.credentialId })
    .from(mcpUserCredentials)
    .where(eq(mcpUserCredentials.userId, userId));
  const trail = await database
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_connected"),
        sql`${auditEvents.payload} ->> 'actor' = ${userId}`,
      ),
    );
  return { connections: rows.length, connectedEvents: trail.length };
}

/** Whether this deployment already had the server row, so the cleanup knows what is its to remove. */
let serverWasAlreadyConfigured = false;

beforeAll(async () => {
  for (const id of [personId, removedId]) {
    await database
      .insert(users)
      .values({
        id,
        email: `${id}@laf.test`,
        name: id,
        emailVerified: false,
      })
      .onConflictDoNothing();
  }

  const [existing] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  serverWasAlreadyConfigured = existing !== undefined;

  /*
   * The server row, so a write that should not happen COULD have: `mcp_user_credentials` has foreign
   * keys to this row and to the person's, and without both, "nothing was written" would be the
   * database refusing rather than the callback deciding.
   *
   * Written directly rather than through `addServer`, which lists the vendor's tools over the network
   * on the way in. What is under test is the callback, not the listing.
   *
   * Nothing else about the connector is touched. The deployment's OAuth CLIENT lives under a vault
   * key the product chooses, so a fixture there would rotate — and thereby revoke — the one an
   * administrator registered; the two tests that need a client to exist answer that one read on a
   * copy of the store instead.
   */
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
  // This suite's two people only, never every row for this vendor: `serverId` is a real catalogue
  // key, so a deployment somebody uses has real connections under it.
  for (const id of [personId, removedId]) {
    await database
      .delete(mcpUserCredentials)
      .where(eq(mcpUserCredentials.userId, id));
    /*
     * And the grant in the vault, which one test in here now really does write. Scoped to this
     * suite's own people: `key_id` holds the user id for an `mcp_user_token`, so this cannot reach
     * a real person's Notion grant on a database somebody uses.
     */
    await database
      .delete(credentials)
      .where(
        and(eq(credentials.kind, "mcp_user_token"), eq(credentials.keyId, id)),
      );
    await database.delete(users).where(eq(users.id, id));
  }
  if (!serverWasAlreadyConfigured) {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
});

describe("a callback carrying nothing this deployment sealed", () => {
  test("no state at all is a failure, and nothing is written", async () => {
    accessAsked.length = 0;
    const response = await appWith({}).request(callbackUrl({ code: "c-1" }));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(FAILED);
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  test("garbage in the state parameter is the same failure", async () => {
    for (const nonsense of ["nonsense", "a.b", ""]) {
      const response = await appWith({}).request(
        callbackUrl({ code: "c-1", state: nonsense }),
      );
      expect(response.headers.get("location")).toBe(FAILED);
    }
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  test("a state altered on the way back is refused, and nothing is written", async () => {
    const sealed = await stateFor({
      userId: personId,
      serverId,
      verifier: "v-1",
    });
    const at = Math.floor(sealed.length / 2);
    const tampered = `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`;

    const response = await appWith({}).request(
      callbackUrl({ code: "c-1", state: tampered }),
    );

    expect(response.headers.get("location")).toBe(FAILED);
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  test("a state left in a tab too long is refused, and nothing is written", async () => {
    // Sealed as if the flow had started half an hour ago. The expiry rides inside the state, so this
    // is exactly the value a browser would still be holding.
    const stale = await stateFor(
      { userId: personId, serverId, verifier: "v-1" },
      Date.now() - 30 * 60_000,
    );

    const response = await appWith({}).request(
      callbackUrl({ code: "c-1", state: stale }),
    );

    expect(response.headers.get("location")).toBe(FAILED);
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  test("a state sealed by another deployment is refused", async () => {
    const elsewhere = await sealConnectState(
      { userId: personId, serverId, verifier: "v-1" },
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    );

    const response = await appWith({}).request(
      callbackUrl({ code: "c-1", state: elsewhere }),
    );

    expect(response.headers.get("location")).toBe(FAILED);
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  test("a good state with no code is a failure too", async () => {
    const state = await stateFor({
      userId: personId,
      serverId,
      verifier: "v-1",
    });

    const response = await appWith({}).request(callbackUrl({ state }));

    expect(response.headers.get("location")).toBe(FAILED);
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  /**
   * A state that cannot be read is refused BEFORE anybody is looked up.
   *
   * Order, not just outcome. `personHasAccess` reaches the identity provider on some deployments, so
   * a callback that asked it first would be an unauthenticated endpoint that anybody could use to
   * make this deployment look somebody up — and would answer at two observably different speeds
   * depending on whether the name it was handed exists.
   */
  test("does not ask whether anybody has access before the state opens", async () => {
    accessAsked.length = 0;
    const hono = appWith({});

    await hono.request(callbackUrl({ code: "c-1", state: "nonsense" }));
    await hono.request(callbackUrl({ code: "c-1" }));
    const state = await stateFor({
      userId: personId,
      serverId,
      verifier: "v-1",
    });
    await hono.request(callbackUrl({ state }));

    expect(accessAsked).toEqual([]);
  });
});

/*
 * OFFBOARDING MID-CONSENT. Removing somebody deny-lists their address, deletes their sessions and
 * retires the credentials they had already granted — and none of that reaches a consent already in
 * flight at the vendor, because a state is good for ten minutes and the callback has no session to
 * check. Completed, that consent writes a fresh, live refresh token belonging to somebody who no
 * longer has access, which nothing downstream would ever revoke because nothing knew it existed.
 */
describe("a consent that outlived the person's access", () => {
  test("writes nothing, and does not even ask the vendor", async () => {
    accessAsked.length = 0;
    const state = await stateFor({
      userId: removedId,
      serverId,
      verifier: "v-1",
    });

    const asked = await withVendor(
      () =>
        new Response(JSON.stringify({ refresh_token: "rt-1", scope: "read" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      async (asked) => {
        const response = await appWith({
          store: holdingAClient(),
          personHasAccess: async () => false,
        }).request(callbackUrl({ code: "c-1", state }));
        expect(response.headers.get("location")).toBe(FAILED);
        return asked;
      },
    );

    expect(accessAsked).toEqual([removedId]);
    // Refused before the code was redeemed, so the deployment never even holds the token it would
    // then have had to throw away. A willing vendor is used deliberately: only our own check refuses.
    expect(asked).toEqual([]);
    expect(await written(removedId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });
});

describe("a state this deployment sealed for something it will not do", () => {
  test("a server the catalogue does not name is refused", async () => {
    // Defence in depth: only this deployment can seal a state, so nothing can reach here today. What
    // it pins is that the server id is checked against the reviewed catalogue rather than trusted
    // because it arrived inside something authenticated.
    const state = await stateFor({
      userId: personId,
      serverId: `not-a-vendor-${suite}`,
      verifier: "v-1",
    });

    const response = await appWith({}).request(
      callbackUrl({ code: "c-1", state }),
    );

    expect(response.headers.get("location")).toBe(FAILED);
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  test("a deployment holding no OAuth client refuses rather than redeeming", async () => {
    // The person consented against a client this deployment can no longer produce, so there is
    // nothing to redeem the code with. Stated explicitly rather than left to the fixture, so the test
    // stays about the branch on a database that does hold one.
    const state = await stateFor({
      userId: personId,
      serverId,
      verifier: "v-1",
    });

    const asked = await withVendor(
      () => new Response("{}", { status: 200 }),
      async (asked) => {
        const response = await appWith({
          store: { ...store, oauthClientFor: async () => null },
        }).request(callbackUrl({ code: "c-1", state }));
        expect(response.headers.get("location")).toBe(FAILED);
        return asked;
      },
    );

    expect(asked).toEqual([]);
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  test("a deployment with no public URL cannot complete one at all", async () => {
    // No public URL means no redirect URI to present at redemption, so there is nothing honest to
    // send. Relative, because a deployment with no public URL is a single-origin one.
    const state = await stateFor({
      userId: personId,
      serverId,
      verifier: "v-1",
    });

    const response = await appWith({ connected: false }).request(
      callbackUrl({ code: "c-1", state }),
    );

    expect(response.headers.get("location")).toBe(
      "/settings/connected-accounts?connected=failed",
    );
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });
});

describe("a vendor that will not trade the code", () => {
  /**
   * The one test here that reaches the exchange, and it reaches a vendor that says no.
   *
   * Two things are asserted at once, and the second is why this is worth a socket at all: the refusal
   * ends as a redirect with nothing written, AND the request that was about to go out carries the
   * verifier from inside the sealed state. That is the property the seal has to keep — it is
   * unreadable, not lossy — and it is invisible from any assertion about the state itself.
   */
  test("is a failure with a notice, and the verifier survived the seal", async () => {
    const verifier = "verifier-that-came-back-1234567890abcdefghij";
    const state = await stateFor({ userId: personId, serverId, verifier });

    const asked = await withVendor(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      async (asked) => {
        const response = await appWith({ store: holdingAClient() }).request(
          callbackUrl({ code: "code-1", state }),
        );
        expect(response.headers.get("location")).toBe(FAILED);
        return asked;
      },
    );

    expect(asked).toHaveLength(1);
    // The token endpoint the catalogue pins, never one that arrived on the request.
    expect(asked[0]?.url).toBe("https://mcp.notion.com/token");
    expect(asked[0]?.form.get("code")).toBe("code-1");
    expect(asked[0]?.form.get("code_verifier")).toBe(verifier);
    // The challenge the vendor was shown at consent is the S256 of exactly this value.
    expect(challengeFor(asked[0]?.form.get("code_verifier") ?? "")).toBe(
      challengeFor(verifier),
    );
    // Built from configuration, so it matches what was registered character for character.
    expect(asked[0]?.form.get("redirect_uri")).toBe(
      `${PUBLIC_URL}/api/plugins/oauth/callback`,
    );
    // The state was never on the wire in a form that reader could have used.
    expect(state).not.toContain(verifier);

    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  test("a vendor that answers with no refresh token is the same failure", async () => {
    // The shape a vendor returns when it believes this person already consented. Storing the access
    // token instead would produce a connection that works for an hour and then cannot be renewed.
    const state = await stateFor({
      userId: personId,
      serverId,
      verifier: "v-1",
    });

    await withVendor(
      () =>
        new Response(JSON.stringify({ access_token: "at-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      async () => {
        const response = await appWith({ store: holdingAClient() }).request(
          callbackUrl({ code: "c-1", state }),
        );
        expect(response.headers.get("location")).toBe(FAILED);
      },
    );

    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });

  /**
   * A vendor that does not answer at all refuses the same way one that refuses does.
   *
   * This was a real gap the suite found before the fix existed: `redeemAuthorizationCode` returned
   * null for an HTTP refusal but let a transport failure THROW — a DNS failure, a connection
   * refused, or its own timeout firing — and nothing caught it, so a person who had ALREADY
   * consented at the vendor got a bare 500: no grant here, a live consent there that nothing
   * recorded, and no notice telling them to try again. The catch in `oauth.ts` is the fix, and
   * this test is what turns red if it is ever unwound.
   */
  test("a vendor that cannot be reached is a notice, not a 500", async () => {
    const state = await stateFor({
      userId: personId,
      serverId,
      verifier: "v-1",
    });

    const response = await withVendor(
      () => {
        throw new TypeError(
          "Unable to connect. Is the computer able to access the url?",
        );
      },
      async () =>
        await appWith({ store: holdingAClient() }).request(
          callbackUrl({ code: "c-1", state }),
        ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(FAILED);
    expect(await written(personId)).toEqual({
      connections: 0,
      connectedEvents: 0,
    });
  });
});

/**
 * The same callback URL, walked twice.
 *
 * The URL carrying the state and the code is held by every log, proxy and browser history it passes
 * through. Nothing here recorded that a state had been ANSWERED, so a replay was refused only if the
 * vendor happened to refuse the spent code — somebody else's implementation detail deciding whether
 * a second grant got attached to somebody's row.
 *
 * This is the one test in the file that lets a write land, deliberately: "the second one wrote
 * nothing" is only worth anything next to a first one that wrote something. Both people's vault rows
 * are cleaned up in `afterAll`.
 */
describe("a callback that arrives twice", () => {
  test("connects once, and the replay is refused with nothing written", async () => {
    const state = await stateFor({
      userId: personId,
      serverId,
      verifier: "verifier-for-the-replay-test-1234567890",
    });
    const url = callbackUrl({ code: "code-once", state });

    const grantingVendor = () =>
      new Response(
        JSON.stringify({ refresh_token: "rt-once", scope: "read" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    const asked = await withVendor(grantingVendor, async (asked) => {
      const first = await appWith({ store: holdingAClient() }).request(url);
      expect(first.headers.get("location")).toBe(
        `${APP_URL}/settings/connected-accounts?connected=${serverId}`,
      );
      expect(await written(personId)).toEqual({
        connections: 1,
        connectedEvents: 1,
      });

      // The identical request again, against a vendor that would happily hand out a second grant.
      // Only our own refusal stops it.
      const second = await appWith({ store: holdingAClient() }).request(url);
      expect(second.headers.get("location")).toBe(FAILED);
      return asked;
    });

    // One exchange, not two: the state was spent before the code was ever presented again.
    expect(asked).toHaveLength(1);
    expect(await written(personId)).toEqual({
      connections: 1,
      connectedEvents: 1,
    });
  });
});
