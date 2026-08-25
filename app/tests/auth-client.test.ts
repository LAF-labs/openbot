import { expect, test } from "bun:test";
import { authClient, signInWithProvider } from "@/lib/auth/client";

test("starts a social sign-in flow through the Better Auth client", () => {
  expect(authClient.signIn.social).toBeFunction();
  expect(signInWithProvider).toBeFunction();
});
