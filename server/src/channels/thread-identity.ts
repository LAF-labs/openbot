import { createHash, randomBytes } from "node:crypto";

/**
 * Which deployment a conversation belongs to, carried by the thread's own id.
 *
 * A thread id is minted here and then travels — into a Bot's own process, into a routine's trigger,
 * into whatever a customer's agent writes it down in — and comes back later with nothing attached
 * saying where it came from. Two deployments of this product can hand the same Bot the same kind of
 * id, and a copy of production running beside production is exactly that case.
 *
 * So the id carries it: six bytes of a digest of the deployment's name lead the UUID and the rest is
 * random. That is enough to ask whether a thread is this deployment's without having seen it before,
 * which is what a deployment whose database is gone would need in order to take its own
 * conversations back and leave another deployment's alone.
 *
 * The name is the tenant package's id. It was once overridable by `DEPLOYMENT_ID`, for deployments
 * sharing one hosted Intelligence project; no deployment ever set it, that project does not exist,
 * and a knob that changes every thread id it touches is not one to leave lying about.
 *
 * Version 8 because RFC 9562 reserves that version for a layout the vendor decides. A version 4 UUID
 * asserts that every bit outside the version and variant is random, and these are not.
 *
 * The digest is not a secret and is not meant to be one. A thread id is already visible to anyone who
 * can list the project, and this says only that two threads came from the same deployment.
 */

/** Enough of the digest to separate deployments, and short enough to leave the id mostly random. */
const FINGERPRINT_BYTES = 6;

const UUID_V8 = 0x80;
const VARIANT_RFC = 0x80;

export type ThreadIdentity = {
  /** A thread id belonging to this deployment. */
  mint: () => string;
  /**
   * Whether this deployment minted the thread id.
   *
   * False for a thread minted before a deployment had a name, which is not the same as knowing it
   * belongs to somebody else. A caller offering to take conversations back has to treat the two
   * differently: one is certainly yours, the other is only possibly.
   */
  owns: (threadId: string) => boolean;
};

function fingerprintOf(deploymentId: string): Buffer {
  return createHash("sha256")
    .update(deploymentId)
    .digest()
    .subarray(0, FINGERPRINT_BYTES);
}

function format(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The 16 bytes a UUID string stands for, or null if it is not one. */
function bytesOf(threadId: string): Buffer | null {
  if (!UUID.test(threadId)) return null;
  return Buffer.from(threadId.replaceAll("-", ""), "hex");
}

export function createThreadIdentity(deploymentId: string): ThreadIdentity {
  const fingerprint = fingerprintOf(deploymentId);

  return {
    mint() {
      const bytes = randomBytes(16);
      fingerprint.copy(bytes, 0);
      // Version and variant are fixed by the format and sit outside the fingerprint's six bytes.
      bytes[6] = (bytes[6] & 0x0f) | UUID_V8;
      bytes[8] = (bytes[8] & 0x3f) | VARIANT_RFC;
      return format(bytes);
    },

    owns(threadId) {
      const bytes = bytesOf(threadId);
      if (!bytes) return false;
      if ((bytes[6] & 0xf0) !== UUID_V8) return false;
      return bytes.subarray(0, FINGERPRINT_BYTES).equals(fingerprint);
    },
  };
}
