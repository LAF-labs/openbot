import { describe, expect, test } from "bun:test";
import { type ConsentStore, LEGAL_VERSION } from "../src/account/consent";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * The two facts `/api/me` carries about consent, and the one call that changes them.
 *
 * The server sends the version somebody agreed to beside the version that is current, and no
 * verdict: the app decides that anything other than the current one — including nothing — means
 * asking again, because the app is what draws the screen that asks. And a deployment with nothing
 * recording consent says nothing at all, so a screen is never stood in front of people demanding
 * an agreement the server could not keep.
 */

const config = loadConfig(testEnvironment());

const signedIn = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "member", email: "member@laf.test", name: "Member" },
    }),
  },
};
const roles = { rolesForUser: async () => ["user" as const] };

function consentStore(version: string | null) {
  const recorded: string[] = [];
  const store: ConsentStore = {
    read: async () => ({
      version,
      at: version ? new Date("2026-09-06T01:02:03Z") : null,
    }),
    record: async (userId) => void recorded.push(userId),
  };
  return { store, recorded };
}

/**
 * `createApp` takes its collaborators by position, and consent is deep in the list. A tuple typed
 * from the function itself keeps the compiler on the shape; the index is the one thing it cannot
 * check, and a wrong one shows up here as a 503 from the route, which is loud enough.
 */
function surface(store?: ConsentStore) {
  const args: Parameters<typeof createApp> = [config, signedIn, roles];
  args[40] = store;
  return createApp(...args);
}

describe("what /api/me says about consent", () => {
  test("nothing, when nothing records it", async () => {
    const response = await surface().request("http://laf.local/api/me");

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("consent");
  });

  test("the version agreed to, beside the version that is current", async () => {
    const { store } = consentStore("2026-01-01");

    const body = await (
      await surface(store).request("http://laf.local/api/me")
    ).json();

    expect(body.consent).toEqual({
      version: "2026-01-01",
      at: "2026-09-06T01:02:03.000Z",
      current: LEGAL_VERSION,
    });
  });

  test("null for somebody who has agreed to nothing yet", async () => {
    const { store } = consentStore(null);

    const body = await (
      await surface(store).request("http://laf.local/api/me")
    ).json();

    expect(body.consent).toEqual({
      version: null,
      at: null,
      current: LEGAL_VERSION,
    });
  });
});

describe("POST /api/me/consent", () => {
  test("records the signed-in person and answers 204", async () => {
    const { store, recorded } = consentStore(null);

    const response = await surface(store).request(
      "http://laf.local/api/me/consent",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
    expect(recorded).toEqual(["member"]);
  });

  test("says so when the deployment cannot record one", async () => {
    // A code, not a sentence: the surface owns the words.
    const response = await surface().request(
      "http://laf.local/api/me/consent",
      {
        method: "POST",
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "laf:consent_not_recorded",
    });
  });

  test("needs a session", async () => {
    const noSession = {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => null },
    };
    const args: Parameters<typeof createApp> = [config, noSession, roles];
    args[40] = consentStore(null).store;

    const response = await createApp(...args).request(
      "http://laf.local/api/me/consent",
      { method: "POST" },
    );

    expect(response.status).toBe(401);
  });
});
