import { createAuthClient } from "better-auth/react";
import { genericOAuthClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
});

export type SignInProvider = "google" | "kakao" | "naver";

export async function signInWithProvider(
  provider: SignInProvider,
  next = "/",
  /**
   * Through the fleet's broker (`laf`) rather than a directly registered
   * OAuth app. The pressed button still decides which provider the person
   * meets: it rides along and becomes the broker's provider_hint.
   */
  viaBroker = false,
) {
  // Resolved against our own origin by the caller; this only joins it to the host.
  const callbackURL = new URL(next, window.location.origin).toString();
  const result = viaBroker
    ? await authClient.signIn.oauth2({
        providerId: "laf",
        callbackURL,
        additionalData: { provider },
      })
    : await authClient.signIn.social({
        provider: provider as never,
        callbackURL,
      });

  if (result.error) {
    throw new Error(result.error.message ?? "Could not start sign-in.");
  }
}
