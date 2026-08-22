import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createOnboardingStore } from "../src/auth/onboarding";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * Who gets stamped, and who does not.
 *
 * The first draft wrote `where(eq(users.id, userId) && isNull(users.onboardedAt))`, and JavaScript's
 * `&&` returns its SECOND operand — so the id condition vanished and one person finishing onboarding
 * would have marked every person in the deployment as finished. Nothing about that fails loudly:
 * everybody simply never sees the flow. Hence a test with two people in it.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createOnboardingStore(database);
const created: string[] = [];

async function person(): Promise<string> {
  const id = randomUUID();
  await database.insert(users).values({
    id,
    email: `${id}@onboarding.test`,
    emailVerified: true,
  });
  created.push(id);
  return id;
}

afterEach(async () => {
  const ids = created.splice(0);
  if (ids.length) await database.delete(users).where(inArray(users.id, ids));
});

afterAll(async () => {
  await database.$client.close();
});

describe("onboarding", () => {
  test("marks the person who finished, and nobody else", async () => {
    const finished = await person();
    const other = await person();

    expect(await store.isOnboarded(finished)).toBe(false);
    expect(await store.isOnboarded(other)).toBe(false);

    await store.markOnboarded(finished);

    expect(await store.isOnboarded(finished)).toBe(true);
    expect(await store.isOnboarded(other)).toBe(false);
  });

  test("does not move a stamp that is already there", async () => {
    const id = await person();
    await store.markOnboarded(id);
    const [first] = await database
      .select({ at: users.onboardedAt })
      .from(users)
      .where(eq(users.id, id));

    await store.markOnboarded(id);
    const [second] = await database
      .select({ at: users.onboardedAt })
      .from(users)
      .where(eq(users.id, id));

    expect(second?.at?.toISOString()).toBe(first?.at?.toISOString());
  });

  test("somebody who does not exist has not been onboarded", async () => {
    expect(await store.isOnboarded(randomUUID())).toBe(false);
  });
});
