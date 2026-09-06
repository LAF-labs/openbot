import type { QueryClient } from "@tanstack/react-query";
import { authKeys } from "./queries";

/**
 * Agree to the terms and the privacy policy as they stand today, and let the guards know.
 *
 * One function for the two screens that ask — the first screen of the first run, and the screen
 * that asks again when the text has changed — so there is one place the stamp is written from and
 * one place the cache is brought up to date.
 *
 * REFETCH, `type: "all"`, for the same reason `welcome.tsx` learned it: nothing on either screen
 * observes the current user, so an invalidation would mark the entry stale and leave it, and
 * `_authed`'s guard would read the old answer and send the person straight back to the screen
 * they just pressed the button on. `first-run.test.ts` pins that shape.
 */
export async function agreeToLegal(queryClient: QueryClient): Promise<void> {
  const response = await fetch("/api/me/consent", {
    credentials: "include",
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Could not record the agreement (${response.status})`);
  }
  await queryClient.refetchQueries({
    queryKey: authKeys.currentUser(),
    type: "all",
  });
}
