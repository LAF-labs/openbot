import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { loadConfig } from "../src/config";
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

describe("the connect flow's view of this deployment", () => {
  test("is absent without a public URL, so no consent is started that could never come back", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
      KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    });
    expect(
      connectConfigFor({ config, database, sharedClient }),
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
    const connect = connectConfigFor({ config, database, sharedClient });
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

    const open = connectConfigFor({
      config: loadConfig(testEnvironment()),
      database,
      sharedClient,
    });
    // No allow-list is an open door, the same as sign-in.
    expect(await open?.personHasAccess(staff.id)).toBe(true);
    // A person whose row is gone has left, whatever the list says.
    expect(await open?.personHasAccess(`gone-${randomUUID()}`)).toBe(false);

    const locked = connectConfigFor({
      config: loadConfig(
        testEnvironment({ SIGN_IN_ALLOWED_EMAILS: owner.email }),
      ),
      database,
      sharedClient,
    });
    expect(await locked?.personHasAccess(owner.id)).toBe(true);
    expect(await locked?.personHasAccess(staff.id)).toBe(false);
  });
});
