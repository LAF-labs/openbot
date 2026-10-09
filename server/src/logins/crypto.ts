/**
 * HOW A SAVED LOGIN IS SEALED: a key of the row's own, wrapped under the deployment's.
 *
 * The record asks for an envelope (`docs/laf/redesign-2026-10.md` §6, 구현 메모): each row has a
 * data key, and the data key is wrapped by a key that is not in the database. The vault that was
 * already here (`credentials.ts`) seals every value directly under the deployment's key — one
 * layer, which is right for a handful of deployment secrets and wrong for what a person saves:
 * with a key per row, changing the deployment's key is re-wrapping one small value per row and
 * never touching a password, and what one row's key opens is one row.
 *
 * EVERY SEALED THING SAYS WHERE IT BELONGS. The row's id, its owner and which field it is are
 * bound into each seal (AES-GCM's additional data), so a sealed password copied onto another row —
 * or onto the same row's name column — does not open. Nobody but the database's owner could do
 * that; it costs one string to make it not matter.
 *
 * AES-256-GCM through WebCrypto, like the vault beside it. Not that vault's `{version:1}` JSON:
 * this is its own format and says so, so neither is ever mistaken for the other.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `lv1.<iv>.<ciphertext>`, both base64: a saved login's seal, version one. */
const PREFIX = "lv1";

/** What a seal is bound to: the row, its owner, and which of the row's sealed things it is. */
export type SealedFor = { id: string; userId: string };

/** A saved login as the database holds it: nothing in it is a value. */
export type SealedLogin = {
  wrappedKey: string;
  kekId: string;
  sealedUsername: string;
  sealedPassword: string;
};

/** A seal that did not open: the wrong key, the wrong row, or bytes that are not a seal. */
export class LoginSealError extends Error {
  constructor() {
    // Never the cause's own words: WebCrypto's are an "OperationError", and a parse error's could
    // quote what it was parsing.
    super("laf:login_seal_unreadable");
    this.name = "LoginSealError";
  }
}

async function aesKey(raw: BufferSource) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

const boundTo = (belongs: SealedFor, field: "key" | "username" | "password") =>
  encoder.encode(`${belongs.id}\u0000${belongs.userId}\u0000${field}`);

async function seal(
  key: CryptoKey,
  plaintext: BufferSource,
  additionalData: BufferSource,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  );
  return [
    PREFIX,
    Buffer.from(iv).toString("base64"),
    Buffer.from(ciphertext).toString("base64"),
  ].join(".");
}

async function open(
  key: CryptoKey,
  sealed: string,
  additionalData: BufferSource,
): Promise<ArrayBuffer> {
  const [prefix, iv, ciphertext, ...rest] = sealed.split(".");
  if (prefix !== PREFIX || !iv || !ciphertext || rest.length > 0) {
    throw new LoginSealError();
  }
  try {
    return await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(iv, "base64"), additionalData },
      key,
      Buffer.from(ciphertext, "base64"),
    );
  } catch {
    throw new LoginSealError();
  }
}

/**
 * Which deployment key wrapped a row: the first sixteen hex of its SHA-256. A fingerprint of 32
 * random bytes says nothing about them, and it is what lets a row wrapped under an old key be told
 * from one wrapped under the new.
 */
export async function kekIdOf(encodedKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Buffer.from(encodedKey, "base64"),
  );
  return Buffer.from(digest).toString("hex").slice(0, 16);
}

/** Seal a name and a password under a new key of the row's own, wrapped under the deployment's. */
export async function sealLogin(
  encodedKey: string,
  belongs: SealedFor,
  values: { username: string; password: string },
): Promise<SealedLogin> {
  const rowKey = crypto.getRandomValues(new Uint8Array(32));
  const [deployment, row] = await Promise.all([
    aesKey(Buffer.from(encodedKey, "base64")),
    aesKey(rowKey),
  ]);
  const [wrappedKey, kekId, sealedUsername, sealedPassword] = await Promise.all(
    [
      seal(deployment, rowKey, boundTo(belongs, "key")),
      kekIdOf(encodedKey),
      seal(row, encoder.encode(values.username), boundTo(belongs, "username")),
      seal(row, encoder.encode(values.password), boundTo(belongs, "password")),
    ],
  );
  return { wrappedKey, kekId, sealedUsername, sealedPassword };
}

/**
 * Open a saved login, for the one caller that puts it into a page. Throws {@link LoginSealError}
 * where it does not open as this row's, under this deployment's key.
 */
export async function openLogin(
  encodedKey: string,
  belongs: SealedFor,
  sealed: SealedLogin,
): Promise<{ username: string; password: string }> {
  const deployment = await aesKey(Buffer.from(encodedKey, "base64"));
  const row = await aesKey(
    await open(deployment, sealed.wrappedKey, boundTo(belongs, "key")),
  );
  const [username, password] = await Promise.all([
    open(row, sealed.sealedUsername, boundTo(belongs, "username")),
    open(row, sealed.sealedPassword, boundTo(belongs, "password")),
  ]);
  return {
    username: decoder.decode(username),
    password: decoder.decode(password),
  };
}
