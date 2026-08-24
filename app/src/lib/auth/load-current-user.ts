import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import {
  type CurrentUser,
  currentUserQueryOptions,
  UNREACHABLE,
} from "./queries";

/**
 * THE ONE DOOR EVERY ROUTE GOES THROUGH, AND WHAT HAPPENS WHEN IT WILL NOT OPEN.
 *
 * Both `/_authed` and `/sign` ask who is signed in before they render, so this single request
 * decides whether the app draws anything at all. Measured: when it rejects, nothing renders. Not
 * the router's `errorComponent`, not the root's, not a stack trace — a blank white page with no
 * text on it and no console error. `notFoundComponent` works on the same build, so the machinery
 * is fine; this router version simply does not route a `beforeLoad` rejection to an error screen.
 *
 * That state is not exotic. It is every `docker compose up -d`, every deploy, every network blip:
 * the API is unreachable for a few seconds and the person is looking at nothing, with no way to
 * tell whether the app is broken, their connection is, or it is still loading.
 *
 * So the rejection is turned into a navigation, which the router does honour. The shell has had
 * this screen since it was written — an app whose whole UI lives on a server has exactly one
 * failure it must explain on its own, and this is the browser's copy of it.
 */
export async function loadCurrentUser(
  queryClient: QueryClient,
): Promise<CurrentUser | null> {
  const result = await queryClient.ensureQueryData(currentUserQueryOptions());
  if (result === UNREACHABLE) {
    throw redirect({ to: "/unreachable" });
  }
  return result;
}
