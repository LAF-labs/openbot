import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createConsentStore, LEGAL_VERSION } from "../src/account/consent";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The consent stamp: one version at one moment, per person.
 *
 * Two things a stamp must never do, each pinned here. It must not MOVE when somebody agrees to the
 * same text again — 다음 pressed twice, the welcome screen reloaded — because the moment they agreed
 * is the fact a dispute would turn on. And it must not STAY when the text has changed and they
 * agree to the new one, because then the record would say they agreed to a text they never saw.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createConsentStore(database);
const made: string[] = [];

async function person(): Promise<string> {
  const id = randomUUID();
  made.push(id);
  await database.insert(users).values({
    id,
    email: `${id}@laf.test`,
    name: "Somebody",
    emailVerified: true,
  });
  return id;
}

const stamp = async (id: string) => {
  const [row] = await database
    .select({ version: users.consentVersion, at: users.consentedAt })
    .from(users)
    .where(eq(users.id, id));
  return row;
};

afterEach(async () => {
  if (made.length > 0) {
    await database.delete(users).where(inArray(users.id, made.splice(0)));
  }
});

afterAll(async () => {
  await database.$client.end();
});

describe("the consent stamp", () => {
  test("somebody who has not agreed has agreed to nothing", async () => {
    const id = await person();
    expect(await store.read(id)).toEqual({ version: null, at: null });
  });

  test("somebody who does not exist has agreed to nothing, and it does not throw", async () => {
    expect(await store.read(randomUUID())).toEqual({ version: null, at: null });
  });

  test("records the current version, now", async () => {
    const id = await person();
    const before = Date.now();

    await store.record(id);

    const agreed = await store.read(id);
    expect(agreed.version).toBe(LEGAL_VERSION);
    expect(agreed.at).toBeInstanceOf(Date);
    expect(agreed.at?.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });

  test("agreeing to the same text again does not move the moment", async () => {
    const id = await person();
    await store.record(id);
    const first = await stamp(id);

    await store.record(id);
    const second = await stamp(id);

    expect(second?.at?.toISOString()).toBe(first?.at?.toISOString());
  });

  test("agreeing to a NEW text replaces the old stamp", async () => {
    const id = await person();
    // What the row looks like after the text changed under somebody who agreed to the old one.
    const then = new Date("2026-01-01T00:00:00Z");
    await database
      .update(users)
      .set({ consentVersion: "2026-01-01", consentedAt: then })
      .where(eq(users.id, id));

    await store.record(id);

    const agreed = await store.read(id);
    expect(agreed.version).toBe(LEGAL_VERSION);
    expect(agreed.at?.getTime()).toBeGreaterThan(then.getTime());
  });

  test("stamps the one person, not the deployment", async () => {
    // The `and(...)`-not-`&&` mistake, pinned from the other side: a second person's row is
    // untouched by the first person agreeing.
    const one = await person();
    const other = await person();

    await store.record(one);

    expect((await store.read(other)).version).toBeNull();
  });
});
