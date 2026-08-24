import { expect, test } from "bun:test";
import { authKeys, currentUserQueryOptions } from "../src/lib/auth/queries";

test("uses a stable key for the current authenticated user", () => {
  expect(authKeys.currentUser()).toEqual(["auth", "current-user"]);
  expect(currentUserQueryOptions().queryKey).toEqual(["auth", "current-user"]);
});

/**
 * A deployment that cannot sign anybody in has to reach the screen that says so.
 *
 * 401 means "not signed in". 503 means "sign-in is not configured", which is the state every
 * deployment is in before its OAuth client exists — and the answer the surface needs is the same
 * one: show the sign-in screen, which already explains that no providers are configured. Throwing
 * instead sent the router's beforeLoad into an unhandled rejection and rendered nothing at all.
 */
test("reads an unconfigured deployment the same as a signed-out one", async () => {
  const original = globalThis.fetch;
  const run = currentUserQueryOptions().queryFn as () => Promise<unknown>;

  try {
    for (const status of [401, 503]) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: "no" }), {
          status,
        })) as typeof fetch;
      expect(await run()).toBeNull();
    }

    // A server that is actually broken is still an error. Swallowing every failure would show a
    // sign-in screen to somebody whose session is fine and whose deployment is on fire.
    globalThis.fetch = (async () =>
      new Response("{}", { status: 500 })) as typeof fetch;
    expect(run()).rejects.toThrow(/500/);
  } finally {
    globalThis.fetch = original;
  }
});
