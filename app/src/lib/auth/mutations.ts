import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { forgetKeptThreads } from "@/lib/turns/kept-threads";
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
      // A conversation kept for somebody coming back is not kept for whoever signs in next.
      forgetKeptThreads();
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}
