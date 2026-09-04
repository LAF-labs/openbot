import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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
import { readConnectState, sealConnectState } from "../src/plugins/oauth";
import { createPluginRoutes } from "../src/plugins/routes";
import { lookupOver } from "../src/plugins/shared-clients";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";
import { stubFetch } from "./support/fetch";

/**
 * One press of 연결 on a deployment that is part of the fleet, end to end.
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING. A vendor compares the `redirect_uri` on the token exchange
 * against the one the authorization request carried, and refuses the exchange when they differ. The
 * relay makes those two legs come from different code paths — the consent is built in the connect
 * handler and the exchange in the callback — so "the same value both times" stops being obvious and
 * becomes a property somebody has to assert. It is also invisible from every surface: the person
 * consents, comes back, and is told the connection did not finish.
 *
 * The other half is the state. A relayed consent carries `<slug>.<sealed>`, and the slug is there
 * for the relay and for nothing else. Everything that decides anything is inside the sealed half —
 * so the assertions read the state back with this deployment's key rather than checking one is
 * present, and the tampering case is what says the outer label buys an attacker nothing.
 *
 * Google Sheets and Cafe24 rather than Notion, because those are the two shapes the fleet
 * introduced: an application shared by every VM, and a vendor whose every customer has their own
 * hostname AND their own token endpoint on it. The vendor is never really reached — the token
 * endpoint is a stub — because a suite that fabricated a Google grant would be asserting against a
 * reply Google does not give.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const suite = randomUUID().slice(0, 8);
const personId = `user_relay_${suite}`;

const PUBLIC_URL = "https://sunny.agent.laf-co.com";
const APP_URL = "https://sunny.agent.laf-co.com";
const OWN_CALLBACK = `${PUBLIC_URL}/api/plugins/oauth/callback`;
const RELAY = {
  url: "https://auth.agent.laf-co.com/oauth/relay",
  slug: "sunny",
};
const FAILED = `${APP_URL}/settings/connected-accounts?connected=failed`;

/** The fleet's two applications, as this suite's deployment holds them. */
const GOOGLE = {
  clientId: "fleet-google-id",
  clientSecret: "fleet-google-secret",
};
const CAFE24 = {
  clientId: "fleet-cafe24-id",
  clientSecret: "fleet-cafe24-secret",
};
const bothClients = lookupOver({ google: GOOGLE, cafe24: CAFE24 });
const googleOnly = lookupOver({ google: GOOGLE });

/** A real mall id: a DNS label, and the thing on the shop's own address bar. */
const MALL = "sunnymart";

const policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  approvals: createApprovalRegistry(),
  sharedClient: bothClients,
  // Neither is on any path this file drives. Loud rather than absent, so one that started to reach
  // the network shows up as a failure instead of going quietly out of the building.
  callVendor: async () => {
    throw new Error("this suite never calls a vendor tool");
  },
  registerClient: async () => {
    throw new Error("a shared-client entry must never self-register");
  },
  exchangeRefreshToken: async () => {
    throw new Error("this suite never spends a refresh token");
  },
});

/**
 * The routes as one signed-in person, with the fleet configuration a test wants.
 *
 * Driven directly rather than through the running app because the shipped development default
 * treats every request as one local administrator, so a check that depends on WHOSE session it is
 * would short-circuit on a laptop.
 */
function appWith(
  options: { relay?: boolean; sharedClient?: typeof bothClients } = {},
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: personId,
      email: `${personId}@laf.test`,
      role: "user",
    } as never);
    await next();
  };
  const routes = createPluginRoutes(store as never, requireUser, {
    publicUrl: PUBLIC_URL,
    appUrl: APP_URL,
    encryptionKey: ENCRYPTION_KEY,
    personHasAccess: async () => true,
    sharedClient: options.sharedClient ?? bothClients,
    ...(options.relay === false ? {} : { relay: RELAY }),
  });
  return new Hono().route("/api/plugins", routes);
}

const connect = async (
  hono: Hono,
  serverId: string,
  body?: Record<string, unknown>,
): Promise<Response> =>
  await hono.request(`http://t/api/plugins/servers/${serverId}/connect`, {
    method: "POST",
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });

/** The consent URL a successful connect answered with, parsed. */
async function consentUrl(response: Response): Promise<URL> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { authorizationUrl: string };
  return new URL(body.authorizationUrl);
}

/** What the sealed half of a state says, read with this deployment's own key. */
const stateOn = (url: URL) => {
  const raw = url.searchParams.get("state") ?? "";
  const marker = raw.indexOf(".");
  return readConnectState(
    marker === -1 ? raw : raw.slice(marker + 1),
    ENCRYPTION_KEY,
  );
};

type VendorRequest = {
  url: string;
  form: URLSearchParams;
  auth: string | null;
};

/**
 * A token endpoint that answers however this test wants, for the length of one call.
 *
 * `globalThis.fetch` rather than a seam on the store, because the callback redeems through
 * `redeemAuthorizationCode` — a module function with no injection point of its own. Restored in a
 * `finally`, since a leaked global would silently answer every later file in the run.
 */
async function withVendor<T>(
  reply: () => Response,
  run: (asked: VendorRequest[]) => Promise<T>,
): Promise<T> {
  const asked: VendorRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url, init) => {
    const headers = new Headers(init?.headers);
    asked.push({
      url: String(url),
      form: new URLSearchParams(String(init?.body ?? "")),
      auth: headers.get("authorization"),
    });
    return reply();
  });
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** What a vendor hands back when it accepts the exchange. */
const aGrant = () =>
  new Response(
    JSON.stringify({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/spreadsheets",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const callback = (hono: Hono, query: Record<string, string>) =>
  hono.request(
    `http://t/api/plugins/oauth/callback?${new URLSearchParams(query)}`,
  );

/** Which servers this suite created, so the cleanup takes back exactly those. */
const OURS = ["google-sheets", "cafe24"];
let serversBefore: string[] = [];

beforeAll(async () => {
  await database
    .insert(users)
    .values({
      id: personId,
      email: `${personId}@laf.test`,
      name: personId,
      emailVerified: false,
    })
    .onConflictDoNothing();

  // What was already configured, so a connector this deployment genuinely had is left standing.
  serversBefore = (
    await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(inArray(mcpServers.id, OURS))
  ).map((row) => row.id);
});

afterAll(async () => {
  await database
    .delete(mcpUserCredentials)
    .where(eq(mcpUserCredentials.userId, personId));
  await database
    .delete(credentials)
    .where(
      and(
        eq(credentials.kind, "mcp_user_token"),
        eq(credentials.keyId, personId),
      ),
    );
  const created = OURS.filter((id) => !serversBefore.includes(id));
  if (created.length > 0) {
    await database.delete(mcpServers).where(inArray(mcpServers.id, created));
  }
  await database.delete(users).where(eq(users.id, personId));
});

/* ── which address the vendor is told to answer at ───────────────────────────────────────────── */

describe("where a relayed vendor sends somebody back", () => {
  test("the consent names the relay, under the shared APPLICATION's name", async () => {
    const url = await consentUrl(await connect(appWith(), "google-sheets"));

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    // `/google`, not `/google-sheets`: five Google connectors consent under one application, which
    // has one registered redirect URI between them.
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://auth.agent.laf-co.com/oauth/relay/google",
    );
    // The fleet's client, not one from the vault — nothing was ever stored for this entry.
    expect(url.searchParams.get("client_id")).toBe(GOOGLE.clientId);
  });

  test("the state carries this customer's name in front of a seal only we can open", async () => {
    const url = await consentUrl(await connect(appWith(), "google-sheets"));

    const raw = url.searchParams.get("state") ?? "";
    expect(raw.startsWith("sunny.")).toBe(true);
    const opened = await stateOn(url);
    expect(opened).not.toBeNull();
    expect(opened?.userId).toBe(personId);
    expect(opened?.serverId).toBe("google-sheets");
    expect(opened?.verifier.length).toBeGreaterThan(20);
  });

  test("a deployment with no relay is told its own callback and sends a bare state", async () => {
    // Which is what a laptop needs: a client registered against `http://localhost:3001` is refused
    // any other address, and a state with a label in front of it names a relay that does not exist.
    const url = await consentUrl(
      await connect(appWith({ relay: false }), "google-sheets"),
    );

    expect(url.searchParams.get("redirect_uri")).toBe(OWN_CALLBACK);
    expect(url.searchParams.get("state")?.includes(".")).toBe(false);
  });
});

/* ── the exchange, which is where a mismatched redirect URI actually lands ────────────────────── */

describe("redeeming the code", () => {
  test("the exchange carries the SAME relay address the consent went out with", async () => {
    const url = await consentUrl(await connect(appWith(), "google-sheets"));
    const state = url.searchParams.get("state") ?? "";

    const asked = await withVendor(aGrant, async (asked) => {
      const response = await callback(appWith(), { code: "abc", state });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).not.toBe(FAILED);
      return asked;
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(asked[0]?.form.get("redirect_uri")).toBe(
      "https://auth.agent.laf-co.com/oauth/relay/google",
    );
    expect(asked[0]?.form.get("client_id")).toBe(GOOGLE.clientId);
    expect(asked[0]?.form.get("client_secret")).toBe(GOOGLE.clientSecret);
    expect(asked[0]?.form.get("code")).toBe("abc");
  });

  test("without a relay the exchange carries the deployment's own callback", async () => {
    const hono = appWith({ relay: false });
    const url = await consentUrl(await connect(hono, "google-sheets"));

    const asked = await withVendor(aGrant, async (asked) => {
      await callback(hono, {
        code: "abc",
        state: url.searchParams.get("state") ?? "",
      });
      return asked;
    });

    expect(asked[0]?.form.get("redirect_uri")).toBe(OWN_CALLBACK);
  });

  test("a state the relay forwarded verbatim is accepted too", async () => {
    // The relay is expected to strip its own label, and one that does not is still a working relay.
    const url = await consentUrl(await connect(appWith(), "google-sheets"));
    const sealed = (url.searchParams.get("state") ?? "").split(".")[1] ?? "";

    await withVendor(aGrant, async (asked) => {
      const response = await callback(appWith(), {
        code: "abc",
        state: sealed,
      });
      expect(response.headers.get("location")).not.toBe(FAILED);
      expect(asked).toHaveLength(1);
    });
  });

  test("a tampered seal is refused, however good the label in front of it looks", async () => {
    const url = await consentUrl(await connect(appWith(), "google-sheets"));
    const sealed = (url.searchParams.get("state") ?? "").split(".")[1] ?? "";
    // One byte of the ciphertext. The label is untouched and still names a real customer, which is
    // the point: it is not a credential and it vouches for nothing.
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;

    await withVendor(aGrant, async (asked) => {
      const response = await callback(appWith(), {
        code: "abc",
        state: `sunny.${flipped}`,
      });
      expect(response.headers.get("location")).toBe(FAILED);
      // Refused before the vendor was asked anything: a code is never redeemed on a state we
      // could not open.
      expect(asked).toHaveLength(0);
    });
  });

  test("a state is spent once, so a replayed callback writes nothing", async () => {
    const url = await consentUrl(await connect(appWith(), "google-sheets"));
    const state = url.searchParams.get("state") ?? "";

    await withVendor(aGrant, async (asked) => {
      await callback(appWith(), { code: "abc", state });
      const replayed = await callback(appWith(), { code: "abc", state });
      expect(replayed.headers.get("location")).toBe(FAILED);
      // The second attempt reached no vendor at all.
      expect(asked).toHaveLength(1);
    });
  });

  test("a label swapped for another customer's changes nothing about who this is", async () => {
    // The relay reads the label; this deployment never does. A consent that arrives with somebody
    // else's name on the front still belongs to whoever the seal says.
    const url = await consentUrl(await connect(appWith(), "google-sheets"));
    const sealed = (url.searchParams.get("state") ?? "").split(".")[1] ?? "";

    await withVendor(aGrant, async () => {
      const response = await callback(appWith(), {
        code: "abc",
        state: `someone-else.${sealed}`,
      });
      expect(response.headers.get("location")).not.toBe(FAILED);
    });

    const [held] = await database
      .select({ userId: mcpUserCredentials.userId })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.userId, personId),
          eq(mcpUserCredentials.serverId, "google-sheets"),
        ),
      );
    expect(held?.userId).toBe(personId);
  });
});

/* ── a vendor whose every customer has their own hostname ────────────────────────────────────── */

describe("Cafe24, which needs the shop's own name", () => {
  test("a connect with no mall id says so rather than guessing", async () => {
    const response = await connect(appWith(), "cafe24");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("laf:instance_name_required");
  });

  test("a mall id that is not a DNS label is refused before anything is stored", async () => {
    for (const bad of [
      "sunny.evil.example",
      "sunny/../evil",
      "a",
      "sunny_mart",
      "-sunny",
    ]) {
      const response = await connect(appWith(), "cafe24", {
        instanceName: bad,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("laf:instance_name_refused");
    }

    const [row] = await database
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, "cafe24"));
    // Nothing was written by any of those, which is the half a status code cannot say. Either no
    // row at all, or the one a later test in this file made — never a host from the list above.
    expect(row?.url ?? "").not.toContain("evil");
  });

  test("the consent and the row are both built from the mall the person named", async () => {
    const url = await consentUrl(
      await connect(appWith(), "cafe24", { instanceName: MALL.toUpperCase() }),
    );

    // Lower-cased, because a hostname is and because a person typing their shop's name will
    // capitalise it about half the time.
    expect(url.origin + url.pathname).toBe(
      `https://${MALL}.cafe24api.com/api/v2/oauth/authorize`,
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://auth.agent.laf-co.com/oauth/relay/cafe24",
    );
    expect(url.searchParams.get("client_id")).toBe(CAFE24.clientId);

    const [row] = await database
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, "cafe24"));
    expect(row?.url).toBe(`https://${MALL}.cafe24api.com/api/v2/admin`);
  });

  test("the token endpoint is the mall's, and the client goes in the header", async () => {
    const hono = appWith();
    const url = await consentUrl(
      await connect(hono, "cafe24", { instanceName: MALL }),
    );

    const asked = await withVendor(aGrant, async (asked) => {
      await callback(hono, {
        code: "abc",
        state: url.searchParams.get("state") ?? "",
      });
      return asked;
    });

    expect(asked[0]?.url).toBe(
      `https://${MALL}.cafe24api.com/api/v2/oauth/token`,
    );
    // Cafe24 authenticates the client on the Authorization header and refuses the body form.
    expect(asked[0]?.auth).toBe(
      `Basic ${Buffer.from(`${CAFE24.clientId}:${CAFE24.clientSecret}`).toString("base64")}`,
    );
    // Both halves moved together: an id in the body beside a Basic header is the same client
    // stated twice, and a strict vendor may refuse the whole request over it.
    expect(asked[0]?.form.get("client_id")).toBeNull();
    expect(asked[0]?.form.get("client_secret")).toBeNull();
    expect(asked[0]?.form.get("redirect_uri")).toBe(
      "https://auth.agent.laf-co.com/oauth/relay/cafe24",
    );
  });
});

/* ── what the 연결 screen is told exists ─────────────────────────────────────────────────────── */

describe("the entries a person is offered", () => {
  test("an entry whose application this deployment holds is listed, one that it does not is not", async () => {
    const response = await appWith({ sharedClient: googleOnly }).request(
      "http://t/api/plugins/connections",
    );
    const body = (await response.json()) as {
      available: {
        id: string;
        title: string;
        summary: string;
        docsUrl: string;
        needsInstanceHost: boolean;
      }[];
    };
    const ids = body.available.map((entry) => entry.id);

    // The vendor's own brand name travels, because it is theirs in every language and the surface
    // has nowhere else to get it. The English summary travels as a FALLBACK — the Korean is in
    // `app/src/lib/plugins/catalogue-copy.ts` — so an entry added here shows an English line on a
    // Korean screen until somebody writes the words, which is the visible failure rather than a
    // blank one.
    const sheets = body.available.find((entry) => entry.id === "google-sheets");
    expect(sheets?.title).toBe("Google Sheets");
    expect(sheets?.summary).toBeTruthy();
    expect(sheets?.docsUrl).toContain("https://");

    expect(ids).toContain("google-sheets");
    expect(ids).toContain("gmail");
    // No CAFE24_CLIENT_ID on this deployment. Drawn anyway, the button would open a consent screen
    // ending in `invalid_client`, which reads to the person as their own account being at fault.
    expect(ids).not.toContain("cafe24");
  });

  test("only the per-instance vendor asks for a name, and it remembers the one it has", async () => {
    // Written by the Cafe24 test above; asserted here so the field is read back from a real row.
    await store.ensureCatalogueServer({
      key: "cafe24",
      instanceName: MALL,
      by: "test",
    });

    const response = await appWith().request(
      "http://t/api/plugins/connections",
    );
    const body = (await response.json()) as {
      available: {
        id: string;
        needsInstanceHost: boolean;
        instanceName: string | null;
      }[];
    };
    const cafe24 = body.available.find((entry) => entry.id === "cafe24");
    const sheets = body.available.find((entry) => entry.id === "google-sheets");

    expect(cafe24?.needsInstanceHost).toBe(true);
    // So somebody reconnecting is not asked to remember their own mall id.
    expect(cafe24?.instanceName).toBe(MALL);
    expect(sheets?.needsInstanceHost).toBe(false);
    expect(sheets?.instanceName).toBeNull();
  });

  test("a connector this deployment was not configured for refuses the press as well as hiding", async () => {
    // Hiding alone is a surface decision, and the surface is not the boundary: the handler refuses
    // the same entry on its own.
    const response = await connect(
      appWith({ sharedClient: googleOnly }),
      "cafe24",
      { instanceName: MALL },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("laf:connector_not_configured");
  });
});

/* ── the seal is still the only thing that decides ───────────────────────────────────────────── */

describe("a state this deployment did not mint", () => {
  test("one sealed with another key is refused", async () => {
    const other = await sealConnectState(
      { userId: personId, serverId: "google-sheets", verifier: "x".repeat(43) },
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    );

    await withVendor(aGrant, async (asked) => {
      const response = await callback(appWith(), {
        code: "abc",
        state: `sunny.${other}`,
      });
      expect(response.headers.get("location")).toBe(FAILED);
      expect(asked).toHaveLength(0);
    });
  });
});
