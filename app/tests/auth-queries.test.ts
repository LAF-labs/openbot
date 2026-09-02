import { expect, test } from "bun:test";
import {
  authKeys,
  currentUserQueryOptions,
  UNREACHABLE,
} from "../src/lib/auth/queries";
import { stubFetch } from "./support/fetch";

test("uses a stable key for the current authenticated user", () => {
  expect(authKeys.currentUser()).toEqual(["auth", "current-user"]);
  // Spread first: TanStack brands a query key with the types it carries, and the branded tuple is
  // not comparable to a plain array of the same strings.
  expect([...currentUserQueryOptions().queryKey]).toEqual([
    "auth",
    "current-user",
  ]);
});

/**
 * Three answers, and none of them may be a rejection.
 *
 * Every route in the app asks this question in `beforeLoad`, so what it does on failure decides
 * whether the app draws anything at all. Measured on a real build: a rejected `beforeLoad` reaches
 * no error screen — not the router's, not the root's — and converting the rejection to a redirect
 * inside `beforeLoad` loops, because the router restarts the load and the still-failed query
 * rejects again. /api/me was requested six times, aborted six times, and the page stayed white.
 *
 *   401 — signed out.
 *   503 — sign-in is not configured, which is where every deployment starts. Same answer: the
 *         sign-in screen explains it. This 503 is ours; a proxy with nothing behind it says 502.
 *   anything else, including no response at all — unreachable, which is not "signed out" and must
 *         not be shown as it.
 */
test("answers, rather than rejecting, however the request fails", async () => {
  const original = globalThis.fetch;
  const run = currentUserQueryOptions().queryFn as () => Promise<unknown>;

  try {
    for (const status of [401, 503]) {
      globalThis.fetch = stubFetch(
        async () =>
          new Response(JSON.stringify({ error: "no" }), {
            status,
          }),
      );
      expect(await run()).toBeNull();
    }

    for (const status of [500, 502, 504]) {
      globalThis.fetch = stubFetch(async () => new Response("{}", { status }));
      expect(await run()).toBe(UNREACHABLE);
    }

    // No response at all: offline, DNS, or a proxy that closed the connection.
    globalThis.fetch = stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await run()).toBe(UNREACHABLE);
  } finally {
    globalThis.fetch = original;
  }
});

/** Screens never see it: they only render once a route decided there is somebody to show them to. */
test("hides the unreachable answer from screens", () => {
  const select = currentUserQueryOptions().select as (
    result: unknown,
  ) => unknown;
  expect(select(UNREACHABLE)).toBeNull();
  expect(select(null)).toBeNull();
  const person = { id: "u1", email: "a@b.c", role: "user", onboarded: true };
  expect(select(person)).toBe(person);
});
