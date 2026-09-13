import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  isSealedToken,
  openToken,
  sealStoredTokens,
  sealToken,
  sealTokenFields,
  tokenSealingHooks,
} from "../src/auth/token-encryption";
import { TEST_TOKEN_ENCRYPTION_KEY } from "../src/config";
import { createDatabase } from "../src/db/client";
import { accounts, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The tokens a sign-in stores never sit in the table in the clear.
 *
 * The envelope, the hooks better-auth calls, and the pass at boot that seals the rows written before
 * any of this existed — that last one against the real table, because a migration that runs in code
 * is a migration a test has to run. The sign-in itself, end to end against a stub provider, is
 * `laf-oidc.integration.test.ts`.
 */

const KEY = "a1".repeat(32);
const OTHER_KEY = "b2".repeat(32);

describe("the envelope", () => {
  test("round-trips, and two seals of one token never look alike", () => {
    const token = "ya29.a0AfH6SMB-canary-access-token";
    const once = sealToken(KEY, token);
    const twice = sealToken(KEY, token);
    expect(once).not.toBe(twice);
    expect(once).not.toContain("ya29");
    expect(isSealedToken(once)).toBe(true);
    expect(openToken(KEY, once)).toBe(token);
    expect(openToken(KEY, twice)).toBe(token);
  });

  test("a wrong key, a tampered seal, or a token that was never sealed is refused, not misread", () => {
    const sealed = sealToken(KEY, "secret");
    expect(() => openToken(OTHER_KEY, sealed)).toThrow();
    const [prefix, iv, body] = sealed.split(":");
    const flipped = `${body?.startsWith("A") ? "B" : "A"}${body?.slice(1)}`;
    expect(() => openToken(KEY, `${prefix}:${iv}:${flipped}`)).toThrow();
    expect(() => openToken(KEY, "ya29.bare")).toThrow("Not a sealed token");
    expect(isSealedToken("ya29.bare")).toBe(false);
  });

  test("seals the three token fields of an account write, and nothing else", () => {
    const sealed = sealTokenFields(KEY, {
      accountId: "google:123",
      accessToken: "at",
      refreshToken: "rt",
      idToken: "eyJ.id.token",
      scope: "openid email",
      password: null,
    });
    expect(Object.keys(sealed).sort()).toEqual([
      "accessToken",
      "idToken",
      "refreshToken",
    ]);
    expect(openToken(KEY, sealed.accessToken as string)).toBe("at");
    // A value already in the envelope — an update passing back what a create sealed — stays.
    expect(sealTokenFields(KEY, { accessToken: sealed.accessToken })).toEqual(
      {},
    );
    // Nothing to seal is nothing to write.
    expect(sealTokenFields(KEY, { accessToken: null, scope: "x" })).toEqual({});
  });

  test("the hooks better-auth calls return a merge, or nothing", async () => {
    const hooks = tokenSealingHooks(KEY);
    const created = await hooks.create.before({ accessToken: "at" });
    expect(openToken(KEY, created?.data.accessToken as string)).toBe("at");
    expect(await hooks.update.before({ scope: "openid" })).toBeUndefined();
  });
});

describe("the rows written before the envelope existed", () => {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot";
  const database = createDatabase(databaseUrl, TEST_POOL);
  const run = randomUUID().slice(0, 8);
  const userId = `seal-user-${run}`;
  const bare = `seal-bare-${run}`;
  const already = `seal-sealed-${run}`;
  const empty = `seal-empty-${run}`;
  const RAW_ACCESS = `ya29.bare-access-${run}`;
  const RAW_REFRESH = `1//refresh-${run}`;
  const ours = [bare, already, empty];

  afterAll(async () => {
    await database.delete(accounts).where(inArray(accounts.id, ours));
    await database.delete(users).where(eq(users.id, userId));
  });

  test("are sealed in place at boot, once, and a sealed row is left alone", async () => {
    await database.insert(users).values({
      id: userId,
      email: `${userId}@laf.test`,
      name: "사장님",
      emailVerified: true,
    });
    const sealedBefore = sealToken(TEST_TOKEN_ENCRYPTION_KEY, "kept-as-is");
    await database.insert(accounts).values([
      {
        id: bare,
        accountId: `google:${bare}`,
        providerId: "google",
        userId,
        accessToken: RAW_ACCESS,
        refreshToken: RAW_REFRESH,
        idToken: null,
      },
      {
        id: already,
        accountId: `kakao:${already}`,
        providerId: "kakao",
        userId,
        accessToken: sealedBefore,
      },
      { id: empty, accountId: `naver:${empty}`, providerId: "naver", userId },
    ]);

    // The key the rest of the run uses, so a row another file left in this database is sealed the
    // way that file would read it. Counted as at least one — the database is shared.
    const first = await sealStoredTokens(database, TEST_TOKEN_ENCRYPTION_KEY);
    expect(first.sealed).toBeGreaterThanOrEqual(1);

    // THE DUMP: the rows as the database holds them, as text, the way `pg_dump` writes them.
    const dumped = await database.execute(
      sql`select a::text as line from accounts a where a.id in (${sql.join(
        ours.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    const text = JSON.stringify(dumped);
    expect(text).not.toContain(RAW_ACCESS);
    expect(text).not.toContain(RAW_REFRESH);

    const rows = await database
      .select()
      .from(accounts)
      .where(inArray(accounts.id, ours));
    const sealed = rows.find((row) => row.id === bare);
    expect(
      openToken(TEST_TOKEN_ENCRYPTION_KEY, sealed?.accessToken as string),
    ).toBe(RAW_ACCESS);
    expect(
      openToken(TEST_TOKEN_ENCRYPTION_KEY, sealed?.refreshToken as string),
    ).toBe(RAW_REFRESH);
    expect(sealed?.idToken).toBeNull();
    // Untouched: the one sealed earlier keeps its exact bytes, the empty one stays empty.
    expect(rows.find((row) => row.id === already)?.accessToken).toBe(
      sealedBefore,
    );
    expect(rows.find((row) => row.id === empty)?.accessToken).toBeNull();

    // The second start finds nothing bare, ours or anybody's.
    expect(await sealStoredTokens(database, TEST_TOKEN_ENCRYPTION_KEY)).toEqual(
      { sealed: 0 },
    );
  });
});
