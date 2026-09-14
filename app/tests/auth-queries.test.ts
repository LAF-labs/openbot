import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { loadCurrentUser } from "../src/lib/auth/load-current-user";
import {
  authKeys,
  currentUserQueryOptions,
  FORBIDDEN,
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
 *         sign-in screen explains it. Unless it is the FRONT DOOR's 503, which carries
 *         `laf:api_unreachable` and means there is no API behind it at all.
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

/**
 * THE FRONT DOOR'S 503 IS AN OUTAGE, NOT A DEPLOYMENT WITHOUT SIGN-IN.
 *
 * `app/Caddyfile` used to answer an `/api/*` with no API behind it as an empty 502, which the test
 * above reads as unreachable. It answers 503 with a code now, so a watcher learns why — and read by
 * status alone, that 503 would send somebody who is signed in to the sign-in screen for the length
 * of every restart. The body is the one the Caddyfile itself writes, read out of it.
 */
test("reads the front door's 503 for a missing API as unreachable, and only that 503", async () => {
  const caddyfile = readFileSync(
    join(import.meta.dir, "..", "Caddyfile"),
    "utf8",
  );
  const frontDoorBody = /respond `(\{"code":"laf:[a-z_]+"\})` 503/.exec(
    caddyfile,
  )?.[1];
  expect(frontDoorBody).toBe('{"code":"laf:api_unreachable"}');

  const original = globalThis.fetch;
  const run = currentUserQueryOptions().queryFn as () => Promise<unknown>;
  const answering = (body: string) =>
    stubFetch(async () => new Response(body, { status: 503 }));
  try {
    globalThis.fetch = answering(frontDoorBody as string);
    expect(await run()).toBe(UNREACHABLE);

    // The API's own 503s: no code, another code, or a body that is not JSON at all.
    for (const body of [
      JSON.stringify({ error: "Authentication is not configured." }),
      JSON.stringify({ error: "laf:consent_not_recorded" }),
      "Service Unavailable",
    ]) {
      globalThis.fetch = answering(body);
      expect(await run()).toBeNull();
    }
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * 403 IS AN ANSWER, NOT AN OUTAGE.
 *
 * `guards.ts` answers it for a session that is good and a person the deployment no longer admits —
 * somebody removed as a member after they signed in. Measured 2026-09-10: it landed on the
 * "cannot reach the server, this usually clears on its own" screen. The server had reached them
 * perfectly well, and nothing was going to clear.
 */
test("keeps a refusal apart from an outage, and sends it to its own screen", async () => {
  const original = globalThis.fetch;
  const run = currentUserQueryOptions().queryFn as () => Promise<unknown>;
  try {
    globalThis.fetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ error: "no role" }), { status: 403 }),
    );
    expect(await run()).toBe(FORBIDDEN);

    const client = new QueryClient();
    const thrown = await loadCurrentUser(client).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to?: string } }).options.to).toBe(
      "/no-access",
    );
  } finally {
    globalThis.fetch = original;
  }
});

/** Screens never see it: they only render once a route decided there is somebody to show them to. */
test("hides the unreachable and refused answers from screens", () => {
  const select = currentUserQueryOptions().select as (
    result: unknown,
  ) => unknown;
  expect(select(UNREACHABLE)).toBeNull();
  expect(select(FORBIDDEN)).toBeNull();
  expect(select(null)).toBeNull();
  const person = { id: "u1", email: "a@b.c", role: "user", onboarded: true };
  expect(select(person)).toBe(person);
});
