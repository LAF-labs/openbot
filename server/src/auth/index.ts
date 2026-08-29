import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
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
    throw new Error("Authentication is not configured.");
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
    // Only the configured ones: better-auth mounts a callback route per entry, and a mounted
    // provider with empty credentials is a sign-in that fails at the redirect, not at startup.
    socialProviders: {
      ...(authConfig.providers.google
        ? { google: authConfig.providers.google }
        : {}),
      ...(authConfig.providers.kakao
        ? { kakao: authConfig.providers.kakao }
        : {}),
      ...(authConfig.providers.naver
        ? { naver: authConfig.providers.naver }
        : {}),
    },
    /*
     * The fleet's broker, as ONE generic OIDC client. The three branded
     * buttons stay: each sign-in carries its pick in additionalData, the
     * authorize URL gains provider_hint, and the broker (which allows that
     * extra param) walks the person straight to the provider they pressed —
     * the broker's own picker is only the no-hint fallback. Public client on
     * purpose: PKCE is the proof and the broker's registry holds no secrets.
     */
    plugins: authConfig.lafOidc
      ? [
          genericOAuth({
            config: [
              {
                providerId: "laf",
                discoveryUrl: `${authConfig.lafOidc.issuer}/.well-known/openid-configuration`,
                clientId: authConfig.lafOidc.clientId,
                pkce: true,
                scopes: ["openid", "email", "profile"],
                // better-auth refuses an account with no name (measured:
                // name_is_missing). The broker sends the social profile's
                // name; if a claim set ever arrives without one, the email
                // stands in rather than the sign-in falling over.
                mapProfileToUser: (profile) => ({
                  name:
                    typeof profile.name === "string" && profile.name
                      ? profile.name
                      : (profile.email as string),
                }),
                authorizationUrlParams: (ctx) => {
                  const wanted = (
                    ctx.body as
                      | { additionalData?: { provider?: unknown } }
                      | undefined
                  )?.additionalData?.provider;
                  const params: Record<string, string> = {};
                  if (
                    wanted === "kakao" ||
                    wanted === "naver" ||
                    wanted === "google"
                  ) {
                    params.provider_hint = wanted;
                  }
                  return params;
                },
              },
            ],
          }),
        ]
      : [],
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
