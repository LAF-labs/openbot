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
 * ONE ACCOUNT PER DEPLOYMENT, AT THE DOOR — through better-auth's real callback.
 *
 * The boot refusal (`one-account-config.test.ts`) keeps a production deployment's list to one
 * address. This is the other half, and it holds in every environment: no sign-in makes a SECOND
 * person who can act here. Measured before the change: a list naming two addresses admitted both,
 * and an unset list admitted anybody the provider authenticated — and since every Bot shares one
 * browser profile (`bc5bf3e`), that second account's Bots browsed inside the first person's logins.
 *
 * What is refused, and what is not:
 *
 *   - a second address, when the deployment already has an account it still admits — refused with
 *     `laf:deployment_has_account`, and no row is written;
 *   - any new address, with the door open (a laptop), while an account is already here — the same;
 *   - NOT the admitted person, when the only other row is a leftover the list no longer admits: a
 *     leftover acts on nothing, so it must not keep the deployment's own person out;
 *   - NOT the same person signing in again.
 *
 * The test database is shared by every suite, so every address here is this run's own, and the
 * open-door case plants an account of its own rather than assuming one is there.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:55432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const run = randomUUID().slice(0, 8);
const address = (label: string) => `one-account-${label}-${run}@laf.test`;
const FIRST = address("first");
const SECOND = address("second");
const OWNER = address("owner");
const LEFTOVER = address("leftover");
const ALREADY_HERE = address("already-here");
const STRANGER = address("stranger");
const OUTSIDER = address("outsider");
const ADDRESSES = [
  FIRST,
  SECOND,
  OWNER,
  LEFTOVER,
  ALREADY_HERE,
  STRANGER,
  OUTSIDER,
];

const CLIENT_ID = "one-account.agent.test";
const ORIGIN = "http://127.0.0.1:3998";

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

/** A deployment of this server's sign-in, reading the list it is given; unset is an open door. */
function deploymentWith(allowed?: string) {
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
      ...(allowed ? { SIGN_IN_ALLOWED_EMAILS: allowed } : {}),
    }),
    database,
  );
}

type Auth = ReturnType<typeof deploymentWith>;

async function signIn(auth: Auth, email: string) {
  const started = await startSignIn(auth, ORIGIN, email);
  const callback = await finishSignIn(auth, started);
  return {
    status: callback.status,
    refusal: refusalIn(callback, ORIGIN),
    location: callback.headers.get("location"),
    hasSession: started.jar.has("better-auth.session_token"),
  };
}

const accountFor = async (email: string) =>
  (
    await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
  )[0];

/**
 * A `users` row put there directly, the way a leftover from before the rule exists.
 *
 * Verified, as a provider-made account is: better-auth links a new sign-in to an existing address
 * only when both sides are verified, and an unverified row is refused as `account_not_linked`
 * before any hook of this deployment's is asked.
 */
async function plantAccount(email: string) {
  const id = `one-account-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email, name: email, emailVerified: true });
  await database.insert(userRoles).values({ userId: id, role: "user" });
  return id;
}

describe("a deployment that already has its person", () => {
  test("refuses a second address on the list, and writes nothing for it", async () => {
    const auth = deploymentWith(`${FIRST},${SECOND}`);

    const first = await signIn(auth, FIRST);
    expect(first).toMatchObject({
      status: 302,
      refusal: null,
      location: `${ORIGIN}/`,
      hasSession: true,
    });
    expect(await accountFor(FIRST)).toBeDefined();

    const second = await signIn(auth, SECOND);
    // The fact, for the sign-in screen to say in Korean — never a session.
    expect(second.status).toBe(302);
    expect(second.refusal).toBe("laf:deployment_has_account");
    expect(second.hasSession).toBe(false);
    expect(await accountFor(SECOND)).toBeUndefined();
  });

  test("still lets that person back in", async () => {
    // The account the test above made. Signing in again is not a second person.
    const auth = deploymentWith(`${FIRST},${SECOND}`);
    const again = await signIn(auth, FIRST);
    expect(again).toMatchObject({ refusal: null, hasSession: true });
  });

  test("with the door open, an account already here refuses anybody new", async () => {
    // A laptop: no list. Whatever else the shared test database holds, this run makes sure there is
    // at least one account, so the refusal below cannot depend on another suite's leftovers.
    await plantAccount(ALREADY_HERE);
    const auth = deploymentWith();

    const stranger = await signIn(auth, STRANGER);
    expect(stranger.refusal).toBe("laf:deployment_has_account");
    expect(stranger.hasSession).toBe(false);
    expect(await accountFor(STRANGER)).toBeUndefined();
  });

  test("an address the list never named is told that, not that the place is taken", async () => {
    const auth = deploymentWith(FIRST);
    const outsider = await signIn(auth, OUTSIDER);
    expect(outsider.refusal).toBe("laf:sign_in_not_admitted");
    expect(await accountFor(OUTSIDER)).toBeUndefined();
  });
});

describe("a leftover account the list no longer admits", () => {
  test("does not keep the deployment's own person from signing in the first time", async () => {
    // Somebody who was on this VM before the rule — a `laf member` address since removed. The row is
    // still there; it acts on nothing, and it must not stand in the owner's way.
    await plantAccount(LEFTOVER);
    const auth = deploymentWith(OWNER);

    const owner = await signIn(auth, OWNER);
    expect(owner).toMatchObject({
      status: 302,
      refusal: null,
      location: `${ORIGIN}/`,
      hasSession: true,
    });
    const made = await accountFor(OWNER);
    expect(made).toBeDefined();
    // And the owner is a person here, with a role, as any first sign-in makes one.
    const roles = await database
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, made?.id as string));
    expect(roles).toHaveLength(1);

    // The leftover is still refused, and still there: nothing here deletes an account.
    const leftover = await signIn(auth, LEFTOVER);
    expect(leftover.refusal).toBe("laf:sign_in_not_admitted");
    expect(leftover.hasSession).toBe(false);
    expect(await accountFor(LEFTOVER)).toBeDefined();
  });
});
