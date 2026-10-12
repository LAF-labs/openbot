import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDeploymentAdmission } from "../src/auth/admission";
import { createSignInAllowlist } from "../src/auth/allowlist";
import { type DeploymentConfig, loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { connectConfigFor } from "../src/plugins/connect-config";
import { lookupOver } from "../src/plugins/shared-clients";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * What the OAuth connect flow is told about this deployment, as `main.ts` assembled it inline until
 * 2026-09-14: where vendors send people back, and whether the person a consent was started for still
 * has access when the callback lands — which, with no removal ledger, is what sign-in itself would
 * answer.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const made: string[] = [];

afterAll(async () => {
  if (made.length > 0) {
    await database.delete(users).where(inArray(users.id, made));
  }
  await database.$client.close();
});

async function person() {
  const id = `connect-config-${randomUUID()}`;
  const email = `${id}@laf.test`;
  await database.insert(users).values({ id, email, name: "connect config" });
  made.push(id);
  return { id, email };
}

const sharedClient = lookupOver({});

/** The deployment's one reading of its sign-in list, built as `main.ts` builds it. */
function admissionOf(config: DeploymentConfig) {
  return createDeploymentAdmission({
    database,
    ...(config.auth ? { allowlist: createSignInAllowlist(config.auth) } : {}),
  });
}

/** The connect flow's view of a deployment loaded from this environment. */
function connectFor(environment: Record<string, string | undefined>) {
  const config = loadConfig(environment);
  return connectConfigFor({
    config,
    database,
    sharedClient,
    admission: admissionOf(config),
  });
}

describe("the connect flow's view of this deployment", () => {
  test("is absent without a public URL, so no consent is started that could never come back", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
      KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    });
    expect(
      connectConfigFor({
        config,
        database,
        sharedClient,
        admission: admissionOf(config),
      }),
    ).toBeUndefined();
  });

  test("names the public URL, the app, and the relay when there is one", () => {
    const config = loadConfig(
      testEnvironment({
        BETTER_AUTH_URL: "https://shop1.agent.laf-co.com",
        TRUSTED_ORIGINS: "https://shop1.agent.laf-co.com",
        PUBLIC_ORIGIN: "https://shop1.agent.laf-co.com",
        LAF_OAUTH_RELAY_URL: "https://auth.agent.laf-co.com/oauth/relay",
      }),
    );
    const connect = connectConfigFor({
      config,
      database,
      sharedClient,
      admission: admissionOf(config),
    });
    expect(connect?.publicUrl).toBe("https://shop1.agent.laf-co.com");
    expect(connect?.appUrl).toBe("https://shop1.agent.laf-co.com");
    expect(connect?.encryptionKey).toBe(config.keyEncryptionKey);
    expect(connect?.relay).toEqual({
      url: "https://auth.agent.laf-co.com/oauth/relay",
      slug: "shop1",
    });
    expect(connect?.sharedClient).toBe(sharedClient);
  });

  test("a person still has access while their row exists and the allow-list, if any, names them", async () => {
    const owner = await person();
    const staff = await person();

    const open = connectFor(testEnvironment());
    // No allow-list is an open door, the same as sign-in.
    expect(await open?.personHasAccess(staff.id)).toBe(true);
    // A person whose row is gone has left, whatever the list says.
    expect(await open?.personHasAccess(`gone-${randomUUID()}`)).toBe(false);

    const locked = connectFor(
      testEnvironment({ SIGN_IN_ALLOWED_EMAILS: owner.email }),
    );
    expect(await locked?.personHasAccess(owner.id)).toBe(true);
    expect(await locked?.personHasAccess(staff.id)).toBe(false);
  });

  /*
   * THE LIST IS READ ONCE, BY THE DOOR, AND THE CALLBACK ASKS THE DOOR. Until 2026-10-11 this module
   * compared `SIGN_IN_ALLOWED_EMAILS` as written against the stored address with `includes`, and
   * knew nothing of `INITIAL_ADMIN_EMAILS` or of production closing the door on it. Two readings of
   * one list, and they disagreed both ways.
   */
  test("the address is matched as the door matches it, however the line spells it", async () => {
    const owner = await person();
    const locked = connectFor(
      // The line written with capitals and a space; better-auth stores the address in lower case.
      testEnvironment({
        SIGN_IN_ALLOWED_EMAILS: ` ${owner.email.toUpperCase()}`,
      }),
    );
    expect(await locked?.personHasAccess(owner.id)).toBe(true);
  });

  test("a closed door that names the owner only as the administrator admits nobody else", async () => {
    const owner = await person();
    const leftover = await person();
    // How a production deployment may be written: one address, on the administrator line alone.
    // `config.ts` closes the door on it there (`allowlistEnforced`); the fixture closes it by hand.
    const config = loadConfig(
      testEnvironment({ INITIAL_ADMIN_EMAILS: owner.email }),
    );
    if (!config.auth) throw new Error("the fixture configures sign-in");
    const admission = createDeploymentAdmission({
      database,
      allowlist: createSignInAllowlist({
        ...config.auth,
        allowlistEnforced: true,
      }),
    });
    const connect = connectConfigFor({
      config,
      database,
      sharedClient,
      admission,
    });
    expect(await connect?.personHasAccess(owner.id)).toBe(true);
    expect(await connect?.personHasAccess(leftover.id)).toBe(false);
  });
});
