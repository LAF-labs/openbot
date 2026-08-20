import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export async function signInWithGoogle(next = "/") {
  const result = await authClient.signIn.social({
    provider: "google" as never,
    // Resolved against our own origin by the caller; this only joins it to the host.
    callbackURL: new URL(next, window.location.origin).toString(),
  });

  if (result.error) {
    throw new Error(result.error.message ?? "Could not start Google sign-in.");
  }
}
