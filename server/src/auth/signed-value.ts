import { createHmac } from "node:crypto";
import { decryptSecret, encryptSecret } from "../credentials";

/**
 * A value this deployment can hand out and later recognise as its own.
 *
 * Used for statements that travel through something we do not control and come back: a run assertion
 * carried by a customer's own agent process, for instance. The alternative is a row per statement,
 * which buys nothing here because these are short-lived and single-purpose, and costs a write and a
 * read on a path that already has both.
 *
 * A SEALED value is authenticated and unreadable: nobody without the key learns anything from
 * holding it, and a tampered one does not open at all. There was once a SIGNED shape beside it —
 * authenticated but readable — for claims that are public anyway. Nothing ever needed one, and an
 * unused way to hand out readable statements is a way to hand out the wrong one by mistake, so it
 * is gone; git has it if a public claim ever turns up.
 */

/**
 * The key a value is sealed with.
 *
 * Derived like a signing key and under a distinguished prefix, so the same deployment secret gives
 * this use its own material: a sealing key is never a signing key, and neither is the key the
 * credential vault encrypts with. AES-256 wants 32 bytes and an HMAC-SHA256 digest is exactly that,
 * base64 because {@link encryptSecret} takes its key that way.
 */
function sealingKey(encryptionKey: string, label: string): string {
  return createHmac("sha256", encryptionKey)
    .update(`seal:${label}`)
    .digest("base64");
}

/**
 * A value nobody but this deployment can read, in one URL-safe string.
 *
 * AES-256-GCM, through the same helper the credential vault uses rather than a second crypto
 * implementation to keep right. GCM authenticates as well as encrypts, so a sealed value needs no
 * signature around it: a tampered one fails to decrypt rather than decrypting to something else.
 *
 * The label separates uses exactly as it does for a signature, but here it does so through the key —
 * a value sealed for one purpose is not merely rejected by another, it cannot be opened by it at all.
 *
 * base64url over the envelope, because this is for values that travel as a query parameter and the
 * envelope itself is JSON with base64 inside it. Sealing says nothing about freshness: a caller that
 * needs an expiry puts one INSIDE the value and checks it after opening.
 */
export async function seal(
  value: string,
  encryptionKey: string,
  label: string,
): Promise<string> {
  const envelope = await encryptSecret(sealingKey(encryptionKey, label), value);
  return Buffer.from(envelope, "utf8").toString("base64url");
}

/**
 * The value a sealed string carries, or nothing.
 *
 * One answer for every way of being unopenable — not base64url, not an envelope, sealed under
 * another label, sealed by somebody else, altered by a byte — because there is exactly one thing to
 * do with a value this deployment cannot read, and a caller that has to tell those apart is a caller
 * that can get one of them wrong.
 */
export async function unseal(
  sealed: string | undefined,
  encryptionKey: string,
  label: string,
): Promise<string | null> {
  if (!sealed) return null;
  try {
    return await decryptSecret(
      sealingKey(encryptionKey, label),
      Buffer.from(sealed, "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }
}
