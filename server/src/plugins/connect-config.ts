import { eq } from "drizzle-orm";
import type { DeploymentAdmission } from "../auth/admission";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { ConnectConfig } from "./routes";
import type { SharedClientLookup } from "./shared-clients";

/**
 * What the OAuth connect flow needs from this deployment: where vendors send people back, and
 * whether the person a consent was started for still has access when the callback lands.
 *
 * Absent when the deployment has no public URL. The routes then answer that this deployment cannot
 * complete a consent flow, which is the honest degraded behaviour: registering a redirect URI that
 * resolves to nothing would leave behind a client that can never finish.
 */
export function connectConfigFor(input: {
  config: Pick<DeploymentConfig, "auth" | "keyEncryptionKey" | "connectors">;
  database: Database;
  sharedClient: SharedClientLookup;
  /**
   * Who the deployment still lets act (`auth/admission.ts`), the one reading of the sign-in list
   * every unattended path asks. The callback is one: it carries no session, and until 2026-10-11
   * this module read the list on its own — `SIGN_IN_ALLOWED_EMAILS` alone, as written, compared
   * to the stored address by `includes`. Two ways that disagreed with the door: an address the
   * line spells with a capital never matched the lowercase row (the owner's own consent refused),
   * and a production list naming the owner only on `INITIAL_ADMIN_EMAILS` read as no list at all
   * (anybody's consent accepted).
   */
  admission: Pick<DeploymentAdmission, "admitsPerson">;
}): ConnectConfig | undefined {
  const { auth, connectors } = input.config;
  /*
   * Where vendors send people back after a consent, derived from the one public URL every real
   * deployment already declares. No new fleet configuration: BETTER_AUTH_URL is required wherever
   * sign-in works, and sign-in is required wherever plugins are reachable.
   */
  if (!auth?.baseUrl) return undefined;
  return {
    publicUrl: auth.baseUrl,
    appUrl: auth.trustedOrigins[0],
    encryptionKey: input.config.keyEncryptionKey,
    /*
     * "Still has access" is two facts: the row is still there — a person who left by their own
     * hand inside the state's ten minutes must not get a fresh token written for them, whatever
     * the list says (with the door open, the list says yes to any id) — and the deployment still
     * admits them, asked of the same admission the routines and the outbox ask.
     */
    personHasAccess: async (userId: string) => {
      const [person] = await input.database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!person) return false;
      return input.admission.admitsPerson(userId);
    },
    sharedClient: input.sharedClient,
    /*
     * The fleet's relay, when this deployment is on one. Absent on a laptop, and then every
     * vendor is told this deployment's own callback — which is what a client registered against
     * `http://localhost:3001` expects and the only thing that can work there.
     */
    ...(connectors.relay
      ? {
          relay: {
            url: connectors.relay.url,
            slug: connectors.relay.slug,
          },
        }
      : {}),
  };
}
