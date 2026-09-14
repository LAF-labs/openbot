import { initializeDevActorUser } from "../auth/dev-actor";
import type { SessionRevocation } from "../auth/session-revocation";
import { sealStoredTokens } from "../auth/token-encryption";
import type { Database } from "../db/client";
import {
  type LoadedTenantPackage,
  recordTenantPackage,
} from "../tenant-package";

/**
 * What a boot settles in the database before the port opens, so nobody can ask anything of a
 * deployment that is still half the last version.
 *
 * Awaited, in this order, and each is safe to run on every boot: a row that is already right is left
 * as it is. The runs the last process died on are settled earlier, by `LafPostgresRunner.create`,
 * because the runner cannot be built without adjudicating them; the policy an administrator saved is
 * read back beside the policy store it belongs to.
 */
export async function reconcileBeforeServing(input: {
  database: Database;
  devNoAuth: boolean;
  tenantPackage: LoadedTenantPackage;
  tokenEncryptionKey: string;
  /** Absent on a deployment without sign-in, which has no list to end anybody's sessions by. */
  sessions?: Pick<SessionRevocation, "sweep">;
}): Promise<void> {
  // The local administrator's row, when LAF_DEV_NO_AUTH admits everybody as them. See dev-actor.ts.
  await initializeDevActorUser(input.database, input.devNoAuth);
  // Which package this deployment booted on, for `/api/admin/package`. See tenant-package.ts.
  await recordTenantPackage(input.database, input.tenantPackage);
  // The rows that predate the envelope, sealed before anybody can sign in. See auth/token-encryption.ts.
  await sealStoredTokens(input.database, input.tokenEncryptionKey);
  // The sessions of anybody the sign-in list no longer admits, ended before anybody can use one:
  // `laf member remove` arrives as this boot. See auth/session-revocation.ts.
  await input.sessions?.sweep();
}
