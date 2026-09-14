import { eq } from "drizzle-orm";
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
     * This fork has no removal ledger, so "still has access" is what sign-in itself would answer:
     * the user row exists, and the address is still on the allow-list when one is configured.
     */
    personHasAccess: async (userId: string) => {
      const [person] = await input.database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!person) return false;
      const allowed = auth.allowedEmails ?? [];
      return allowed.length === 0 || allowed.includes(person.email);
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
