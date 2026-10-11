import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { accounts, sessions, userRoles, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import {
  finishSignIn,
  type OidcStub,
  refusalIn,
  startOidcStub,
  startSignIn,
} from "./support/oidc-stub";

/**
 * SIGN-IN ADMITS AN ADDRESS ONLY WHEN THE PROVIDER SAYS IT IS VERIFIED — through better-auth's real
 * callback, like `one-account-sign-in.integration.test.ts`.
 *
 * The one-account rule hands the seat to the one address the list names, and an address is only
 * ever proved by a provider vouching for it. So an arrival the provider does not vouch for makes no
 * account (`laf:sign_in_email_unverified`, nothing written), a row from before the rule that nobody
 * has proved gets no session, and a verified arrival to the same address — before, after, or to that
 * very row — is the person the seat is for.
 *
 * The test database is shared by every suite, so every address here is this run's own.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:55432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const run = randomUUID().slice(0, 8);
const address = (label: string) => `sign-in-verified-${label}-${run}@laf.test`;
const OWNER = address("owner");
const EARLIER = address("earlier");
const ADDRESSES = [OWNER, EARLIER];

const CLIENT_ID = "sign-in-verified.agent.test";
const ORIGIN = "http://127.0.0.1:3997";

let stub: OidcStub;

beforeAll(async () => {
  stub = await startOidcStub(CLIENT_ID);
});

afterAll(async () => {
  stub?.close();
  const doomed = await database
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, ADDRESSES));
  const ids = doomed.map((row) => row.id);
  if (ids.length > 0) {
    await database.delete(sessions).where(inArray(sessions.userId, ids));
    await database.delete(accounts).where(inArray(accounts.userId, ids));
    await database.delete(userRoles).where(inArray(userRoles.userId, ids));
    await database.delete(users).where(inArray(users.id, ids));
  }
  await database.$client.close();
});

/** A deployment of this server's sign-in whose list names `allowed`. */
function deploymentWith(allowed: string) {
  return createAuth(
    loadConfig({
      DATABASE_URL: databaseUrl,
      KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
      BETTER_AUTH_URL: ORIGIN,
      AUTH_PROVIDERS: "laf",
      LAF_OIDC_ISSUER: stub.issuer,
      LAF_OIDC_CLIENT_ID: CLIENT_ID,
      MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
      SIGN_IN_ALLOWED_EMAILS: allowed,
    }),
    database,
  );
}

type Auth = ReturnType<typeof deploymentWith>;

async function signIn(auth: Auth, email: string, verified = true) {
  const started = await startSignIn(auth, ORIGIN, email, { verified });
  const callback = await finishSignIn(auth, started);
  return {
    status: callback.status,
    refusal: refusalIn(callback, ORIGIN),
    hasSession: started.jar.has("better-auth.session_token"),
  };
}

const rowFor = async (email: string) =>
  (
    await database
      .select({ id: users.id, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, email))
  )[0];

describe("an address the provider does not vouch for", () => {
  test("makes no account on its first arrival, and is told why", async () => {
    const auth = deploymentWith(OWNER);
    const arrival = await signIn(auth, OWNER, false);
    expect(arrival.status).toBe(302);
    expect(arrival.refusal).toBe("laf:sign_in_email_unverified");
    expect(arrival.hasSession).toBe(false);
    expect(await rowFor(OWNER)).toBeUndefined();
  });

  test("a verified arrival afterwards takes the seat, and keeps it", async () => {
    const auth = deploymentWith(OWNER);
    const owner = await signIn(auth, OWNER);
    expect(owner).toMatchObject({
      status: 302,
      refusal: null,
      hasSession: true,
    });
    expect(await rowFor(OWNER)).toMatchObject({ emailVerified: true });

    // The same person back, still vouched for: unaffected.
    const again = await signIn(auth, OWNER);
    expect(again).toMatchObject({ refusal: null, hasSession: true });
  });
});

describe("a row from before the rule that nobody has proved", () => {
  /**
   * Planted as a sign-in before 2026-10-11 left it: the row unverified, and its provider link in
   * `accounts`, so better-auth finds the link and asks for a session rather than refusing to link.
   */
  beforeAll(async () => {
    const id = `sign-in-verified-${randomUUID()}`;
    await database
      .insert(users)
      .values({ id, email: EARLIER, name: EARLIER, emailVerified: false });
    await database.insert(userRoles).values({ userId: id, role: "user" });
    await database.insert(accounts).values({
      id: `sign-in-verified-account-${randomUUID()}`,
      userId: id,
      providerId: "laf",
      accountId: `stub:${EARLIER}`,
    });
  });

  test("gets no session while its provider still does not vouch for it", async () => {
    const auth = deploymentWith(EARLIER);
    const arrival = await signIn(auth, EARLIER, false);
    expect(arrival.refusal).toBe("laf:sign_in_email_unverified");
    expect(arrival.hasSession).toBe(false);
    expect(await rowFor(EARLIER)).toMatchObject({ emailVerified: false });
  });

  test("is let in once the address is vouched for — the row is proved first", async () => {
    const auth = deploymentWith(EARLIER);
    const arrival = await signIn(auth, EARLIER);
    expect(arrival).toMatchObject({ refusal: null, hasSession: true });
    expect(await rowFor(EARLIER)).toMatchObject({ emailVerified: true });
  });
});
