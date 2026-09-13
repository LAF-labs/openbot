/**
 * The tokens a sign-in leaves behind, sealed at rest.
 *
 * better-auth writes the provider's access, refresh and id tokens into `accounts` on every sign-in,
 * and this deployment never spends them: nothing outside `auth/` reads the three columns (the
 * export skips the table for that reason, `account/export.ts`). They were still there in the clear
 * — measured 2026-09-10, `ya29.…` in a `pg_dump` beside the session tokens (A5 §5, A8 S1) — in the
 * one database every other secret is AES-GCM in, and a dump of it sits in object storage for thirty
 * days. A backup is the wrong place to find out the tokens were readable.
 *
 * WHY NOT better-auth's OWN `encryptOAuthTokens`. It exists, and its key is `BETTER_AUTH_SECRET` —
 * the cookie-signing secret. One key for two jobs is one rotation that breaks both, and the fleet
 * plants one secret per job. So the envelope is this deployment's, under `LAF_TOKEN_ENCRYPTION_KEY`
 * (config.ts), applied where better-auth lets a deployment stand in front of every account write:
 * `databaseHooks.account.{create,update}.before`, which every account write in better-auth 1.6
 * goes through (`createWithHooks` / `updateWithHooks` in its internal adapter — read, not assumed).
 * Its own `get-access-token` route hands back the sealed form, which is not a token; nothing here
 * calls it. The day a provider token is spent, it is opened here — `openToken` — and nowhere else.
 *
 * THE ENVELOPE. `laf1:<iv>:<ciphertext+tag>`, base64url, AES-256-GCM with a 12-byte IV: the same
 * primitive as the credential vault (`credentials.ts`), under a different key. The prefix is what
 * tells a sealed row from a bare token, which is what lets the boot pass below run on every start
 * and touch only what it has not sealed yet.
 *
 * ROTATING THE KEY leaves every stored token sealed under the old one and unopenable. Nothing spends
 * them, and the next sign-in writes fresh ones under the new key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { accounts } from "../db/schema";
import { log } from "../log";

const ENVELOPE_PREFIX = "laf1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The three columns better-auth fills from a provider's token response. */
const TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;
type TokenField = (typeof TOKEN_FIELDS)[number];

function keyBytes(key: string): Buffer {
  const bytes = Buffer.from(key, "hex");
  if (bytes.byteLength !== 32) {
    throw new Error("The token encryption key is not 32 bytes.");
  }
  return bytes;
}

/** Whether a stored value is already in the envelope, so a pass over the table is idempotent. */
export function isSealedToken(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}:`);
}

export function sealToken(key: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const sealed = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${ENVELOPE_PREFIX}:${iv.toString("base64url")}:${sealed.toString("base64url")}`;
}

export function openToken(key: string, sealed: string): string {
  const [prefix, iv, body, extra] = sealed.split(":");
  if (prefix !== ENVELOPE_PREFIX || !iv || !body || extra !== undefined) {
    throw new Error("Not a sealed token.");
  }
  const bytes = Buffer.from(body, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBytes(key),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(bytes.subarray(bytes.byteLength - TAG_BYTES));
  return Buffer.concat([
    decipher.update(bytes.subarray(0, bytes.byteLength - TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * The token fields of an account write that are still bare, sealed. Empty when there is nothing.
 *
 * Only strings not already in the envelope: better-auth updates an account on every sign-in with
 * whatever the provider answered, and a value sealed a moment ago must not be sealed twice.
 */
export function sealTokenFields(
  key: string,
  account: Record<string, unknown>,
): Partial<Record<TokenField, string>> {
  const sealed: Partial<Record<TokenField, string>> = {};
  for (const field of TOKEN_FIELDS) {
    const value = account[field];
    if (typeof value === "string" && value && !isSealedToken(value)) {
      sealed[field] = sealToken(key, value);
    }
  }
  return sealed;
}

/**
 * better-auth's `databaseHooks.account`, sealing every token before it is written.
 *
 * Returning nothing leaves the write alone; returning `{ data }` merges into it. Both `create` and
 * `update`: a first sign-in links an account and every later one updates it.
 */
export function tokenSealingHooks(key: string) {
  const before = async (account: Record<string, unknown>) => {
    const data = sealTokenFields(key, account);
    return Object.keys(data).length > 0 ? { data } : undefined;
  };
  return { create: { before }, update: { before } };
}

/**
 * Seal every bare token already in the table. Run at boot, before anybody can sign in.
 *
 * The migration for the rows that predate the envelope, and it lives here rather than in
 * `drizzle/` because a SQL migration has no key: the key is in this process's environment, and this
 * process is the only thing that can read the rows and write them back sealed. Idempotent by the
 * prefix — a second start finds nothing bare and writes nothing — for the price of one read of a
 * table holding a row per person per provider.
 */
export async function sealStoredTokens(
  database: Database,
  key: string,
): Promise<{ sealed: number }> {
  const rows = await database
    .select({
      id: accounts.id,
      accessToken: accounts.accessToken,
      refreshToken: accounts.refreshToken,
      idToken: accounts.idToken,
    })
    .from(accounts);
  let sealed = 0;
  for (const row of rows) {
    const data = sealTokenFields(key, row);
    if (Object.keys(data).length === 0) continue;
    await database.update(accounts).set(data).where(eq(accounts.id, row.id));
    sealed += 1;
  }
  if (sealed > 0) log.info("oauth_tokens_sealed", { rows: sealed });
  return { sealed };
}
