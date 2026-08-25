import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  sessions,
  userRoles,
  users,
  verifications,
} from "../db/schema";
import { createSignInAllowlist } from "./allowlist";
import { roleForEmail } from "./roles";

export function createAuth(config: DeploymentConfig, database: Database) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("Google authentication is not configured.");
  }

  const allowlist = createSignInAllowlist({
    allowedEmails: authConfig.allowedEmails,
    initialAdminEmails: authConfig.initialAdminEmails,
  });
  // Refused before anything is written, with a message the sign-in screen can show. The OAuth
  // dance has already happened by the time this runs; what is being refused is an account here.
  const refuse = () => {
    throw new APIError("FORBIDDEN", {
      message: "This deployment belongs to someone else.",
    });
  };

  return betterAuth({
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: authConfig.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: "pg",
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    socialProviders: {
      google: authConfig.google,
    },
    databaseHooks: {
      user: {
        create: {
          // The lock on the first visit: an unlisted email never becomes an account.
          before: async (user) => {
            if (!allowlist.admits(user.email)) refuse();
            return { data: user };
          },
          after: async (user) => {
            await database
              .insert(userRoles)
              .values({
                userId: user.id,
                role: roleForEmail(user.email, authConfig.initialAdminEmails),
              })
              .onConflictDoNothing();
          },
        },
      },
      session: {
        create: {
          /*
           * The lock on every later visit. An account that predates the list — or one struck from
           * it — stops getting sessions, which is what "removed" has to mean for the removal to be
           * worth anything. Sessions already issued live until they expire; this decides new ones.
           */
          before: async (session) => {
            if (!allowlist.enforced) return { data: session };
            const [account] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);
            if (!account || !allowlist.admits(account.email)) refuse();
            return { data: session };
          },
        },
      },
    },
  });
}
