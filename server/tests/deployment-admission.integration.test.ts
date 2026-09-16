import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuth } from "../src/auth";
import {
  createDeploymentAdmission,
  type DeploymentAdmission,
} from "../src/auth/admission";
import { createSignInAllowlist } from "../src/auth/allowlist";
import { DEV_ACTOR, initializeDevActorUser } from "../src/auth/dev-actor";
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
 * WHO THIS DEPLOYMENT STILL LETS ACT — the one question every path asks, signed in or not.
 *
 * `auth/admission.ts` answers it three ways, and each has a caller that must not be able to answer
 * it differently: by address (the sign-in list), by person (a routine, a notification — nobody is
 * signed in to those), and "does this deployment already belong to somebody else" (a new account).
 * Then the race: two first sign-ins at once. Each looks, finds nobody, and writes — and without the
 * settle that follows the write, the deployment ends up with two people who can act on it.
 *
 * Every address is this run's own: the test database is shared, and a rule about "any other
 * account" is exactly the kind a neighbouring suite's rows would make pass for the wrong reason.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:55432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const run = randomUUID().slice(0, 8);
const address = (label: string) => `admission-${label}-${run}@laf.test`;
const planted: string[] = [];

async function plant(email: string): Promise<string> {
  const id = `admission-${randomUUID()}`;
  await database.insert(users).values({ id, email, name: email });
  planted.push(id);
  return id;
}

let stub: OidcStub;
const CLIENT_ID = "admission.agent.test";
const ORIGIN = "http://127.0.0.1:3997";
const RACERS = [address("racer-a"), address("racer-b")];

beforeAll(async () => {
  stub = await startOidcStub(CLIENT_ID);
});

afterAll(async () => {
  stub?.close();
  const made = await database
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, RACERS));
  const ids = [...planted, ...made.map((row) => row.id)];
  if (ids.length > 0) {
    await database.delete(sessions).where(inArray(sessions.userId, ids));
    await database.delete(accounts).where(inArray(accounts.userId, ids));
    await database.delete(userRoles).where(inArray(userRoles.userId, ids));
    await database.delete(users).where(inArray(users.id, ids));
  }
  await database.$client.close();
});

const listed = (...addresses: string[]) =>
  createDeploymentAdmission({
    database,
    allowlist: createSignInAllowlist({
      allowedEmails: addresses,
      initialAdminEmails: [],
    }),
  });

const openDoor = (devNoAuth = false) =>
  createDeploymentAdmission({
    database,
    allowlist: createSignInAllowlist({
      allowedEmails: [],
      initialAdminEmails: [],
    }),
    devNoAuth,
  });

describe("a person, known only by id", () => {
  test("is admitted while the list names their address, and not once it does not", async () => {
    const owner = address("owner");
    const ownerId = await plant(owner);
    const leftoverId = await plant(address("leftover"));
    const admission = listed(owner.toUpperCase());

    expect(await admission.admitsPerson(ownerId)).toBe(true);
    expect(await admission.admitsPerson(leftoverId)).toBe(false);
    // Nobody by that id at all is nobody to act for.
    expect(await admission.admitsPerson(`admission-nobody-${run}`)).toBe(false);
  });

  test("with the door open, everybody is — the laptop's behaviour, kept", async () => {
    const someoneId = await plant(address("someone"));
    expect(await openDoor().admitsPerson(someoneId)).toBe(true);
  });

  test("the local fixture acts only where the local fixture is switched on", async () => {
    const admission = createDeploymentAdmission({
      database,
      allowlist: createSignInAllowlist({
        allowedEmails: [address("owner")],
        initialAdminEmails: [],
      }),
      devNoAuth: true,
    });
    expect(await admission.admitsPerson(DEV_ACTOR.id)).toBe(true);
    expect(await listed(address("owner")).admitsPerson(DEV_ACTOR.id)).toBe(
      false,
    );
  });
});

describe("whether this deployment already belongs to somebody else", () => {
  test("an account the list still admits does; a leftover does not", async () => {
    const holder = address("holder");
    await plant(holder);
    const newcomer = address("newcomer");
    const leftover = address("left-behind");
    await plant(leftover);

    expect(
      await listed(holder, newcomer).heldBySomebodyElse({ email: newcomer }),
    ).toBe(true);
    // Only the leftover is there, as far as this list is concerned.
    expect(await listed(newcomer).heldBySomebodyElse({ email: newcomer })).toBe(
      false,
    );
    // The holder is not somebody else to themselves, however the address is spelled.
    expect(
      await listed(holder, newcomer).heldBySomebodyElse({
        email: ` ${holder.toUpperCase()} `,
      }),
    ).toBe(false);
  });

  test("with the door open, any account here does", async () => {
    // This run plants one, so the answer cannot rest on another suite's rows being there.
    await plant(address("anyone"));
    expect(
      await openDoor().heldBySomebodyElse({ email: address("brand-new") }),
    ).toBe(true);
  });

  test("the local fixture is nobody, even on a list that names its address", async () => {
    /*
     * `dev-local-user` is a row `LAF_DEV_NO_AUTH` writes so threads have somebody to belong to; it is
     * not a person, and a laptop that ran with the flag once must still let its developer sign in for
     * real. Inside a transaction that is rolled back, because the row is shared by every suite.
     */
    const newcomer = address("after-the-fixture");
    const rollback = new Error("rollback: the fixture row is shared");
    await expect(
      database.transaction(async (transaction) => {
        await initializeDevActorUser(transaction, true);
        const admission = createDeploymentAdmission({
          database: transaction,
          allowlist: createSignInAllowlist({
            allowedEmails: [DEV_ACTOR.email, newcomer],
            initialAdminEmails: [],
          }),
        });
        expect(await admission.heldBySomebodyElse({ email: newcomer })).toBe(
          false,
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});

describe("two first sign-ins at once", () => {
  test("settled after the write: exactly one of two freshly written accounts is kept", async () => {
    // The state both racers leave when each looked before the other wrote: two rows, both admitted.
    const [a, b] = [address("settle-a"), address("settle-b")];
    const idA = await plant(a);
    const idB = await plant(b);
    const admission = listed(a, b);

    const kept = await Promise.all([
      admission.keepArrival({ id: idA, email: a }),
      admission.keepArrival({ id: idB, email: b }),
    ]);

    expect(kept.filter(Boolean)).toHaveLength(1);
    const left = await database
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [idA, idB]));
    expect(left).toHaveLength(1);
    expect(left[0]?.id).toBe(kept[0] ? idA : idB);
  });

  test("a leftover beside the new account is no reason to undo it", async () => {
    await plant(address("old-leftover"));
    const fresh = address("fresh");
    const id = await plant(fresh);
    expect(await listed(fresh).keepArrival({ id, email: fresh })).toBe(true);
    expect(
      await database.select().from(users).where(eq(users.id, id)),
    ).toHaveLength(1);
  });

  test("through the real callback: one account, and the other person is told why", async () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
      BETTER_AUTH_URL: ORIGIN,
      AUTH_PROVIDERS: "laf",
      LAF_OIDC_ISSUER: stub.issuer,
      LAF_OIDC_CLIENT_ID: CLIENT_ID,
      MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
      SIGN_IN_ALLOWED_EMAILS: RACERS.join(","),
    });
    if (!config.auth) throw new Error("the fixture has sign-in");
    const real = createDeploymentAdmission({
      database,
      allowlist: createSignInAllowlist(config.auth),
    });

    /*
     * THE RACE, MADE CERTAIN. Each sign-in's first look is held until both have looked, so each finds
     * the deployment empty and goes on to write — the interleaving two browsers pressing at the same
     * moment can produce, rather than the one the event loop happens to pick. The hold is bounded, so
     * a build where the look is never asked fails on the count below instead of hanging.
     */
    let looked = 0;
    let bothLooked: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      bothLooked = resolve;
    });
    const held: DeploymentAdmission = {
      ...real,
      heldBySomebodyElse: async (person) => {
        const answer = await real.heldBySomebodyElse(person);
        looked += 1;
        if (looked === 2) bothLooked();
        await Promise.race([gate, Bun.sleep(5_000)]);
        return answer;
      },
    };
    const auth = createAuth(config, database, undefined, held);

    const started = await Promise.all(
      RACERS.map((email) => startSignIn(auth, ORIGIN, email)),
    );
    const callbacks = await Promise.all(
      started.map((one) => finishSignIn(auth, one)),
    );

    expect(looked).toBe(2);
    const refusals = callbacks.map((callback) => refusalIn(callback, ORIGIN));
    expect(refusals.filter((code) => code === null)).toHaveLength(1);
    expect(
      refusals.filter((code) => code === "laf:deployment_has_account"),
    ).toHaveLength(1);
    const withSession = started.filter((one) =>
      one.jar.has("better-auth.session_token"),
    );
    expect(withSession).toHaveLength(1);

    const rows = await database
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.email, RACERS));
    expect(rows).toHaveLength(1);
    // The one kept is the one that got in, with its provider link; the other left nothing behind.
    const winner = RACERS[refusals.indexOf(null)];
    expect(rows[0]?.email).toBe(winner as string);
    const links = await database
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        inArray(
          accounts.userId,
          rows.map((row) => row.id),
        ),
      );
    expect(links).toHaveLength(1);
  });
});
