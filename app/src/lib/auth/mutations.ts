import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { forgetAllUnsent } from "@/components/channels/composer/outbox";
import { forgetKeptDrafts } from "@/lib/build-reload";
import { authKeys } from "./queries";

async function signOut() {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Could not sign out (${response.status})`);
  }
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => {
      forgetAllUnsent();
      forgetKeptDrafts();
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}
