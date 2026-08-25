import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export type SignInProvider = "google" | "kakao" | "naver";

export async function signInWithProvider(provider: SignInProvider, next = "/") {
  const result = await authClient.signIn.social({
    provider: provider as never,
    // Resolved against our own origin by the caller; this only joins it to the host.
    callbackURL: new URL(next, window.location.origin).toString(),
  });

  if (result.error) {
    throw new Error(result.error.message ?? "Could not start sign-in.");
  }
}
