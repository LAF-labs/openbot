import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const config = loadConfig({
  ...testEnvironment(),
});

const noSessionAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => null,
  },
};

function authenticatedAs(
  userId: string,
  email = "member@laf.test",
  name = "LAF Member",
  image = "https://example.test/member.png",
) {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({ user: { id: userId, email, name, image } }),
    },
  };
}

describe("server authorization", () => {
  test("returns 401 when a protected route has no session", async () => {
    const app = createApp(config, noSessionAuth, {
      rolesForUser: async () => [],
    });

    const response = await app.request("http://laf.local/api/me");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
    });
  });

  test("denies a signed-in user from an administrator route", async () => {
    const app = createApp(config, authenticatedAs("member"), {
      rolesForUser: async () => ["user"],
    });

    const response = await app.request("http://laf.local/api/admin/status");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access required.",
    });
  });

  /*
   * A SESSION WITHOUT A ROLE IS NOT A USER.
   *
   * Measured 2026-09-10 (audit A6, mutation M9): the branch that refuses a person with a session
   * and no `user_roles` row was turned into "then they are a user", and every suite importing the
   * guard stayed green — the only `rolesForUser: async () => []` in this file was paired with no
   * session, so the branch was never reached. Today a role is written by the sign-up hook and
   * removed by account deletion, so nobody arrives here; the day "take this member of staff's
   * access away" ships, this branch is the boundary, and it has to be one that a test can see fall.
   */
  test("refuses a session that holds no role, on an ordinary route", async () => {
    const app = createApp(config, authenticatedAs("member"), {
      rolesForUser: async () => [],
    });

    const response = await app.request("http://laf.local/api/me");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Authorization required.",
    });
  });

  test("refuses a session that holds no role before the administrator guard is reached", async () => {
    const app = createApp(config, authenticatedAs("member"), {
      rolesForUser: async () => [],
    });

    const response = await app.request("http://laf.local/api/admin/status");

    // The session guard's answer, not the administrator guard's: there is no actor to ask about.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Authorization required.",
    });
  });

  test("returns the authenticated user actor", async () => {
    const app = createApp(config, authenticatedAs("member"), {
      rolesForUser: async () => ["user"],
    });

    const response = await app.request("http://laf.local/api/me");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "member",
        email: "member@laf.test",
        name: "LAF Member",
        image: "https://example.test/member.png",
        role: "user",
        // True when nothing tracks onboarding, so a deployment without the store never traps
        // anybody in a flow whose end it cannot record.
        onboarded: true,
      },
      // What this deployment can do, beside who is asking. True when nothing says otherwise, so an
      // app talking to a server that has not been told reads it the same way the package defaults —
      // and each of these decides whether a control is drawn at all, so a wrong answer here is a
      // control that saves and reaches nothing.
      // `seats` is the third: how many Bots this person's computer holds, so the roster can say
      // "내 봇 3/5" rather than leaving somebody to meet the cap by being refused by it.
      deployment: { effort: true, autoReview: true, seats: 5 },
    });
  });

  test("allows an administrator to reach an administrator route", async () => {
    const app = createApp(config, authenticatedAs("admin"), {
      rolesForUser: async () => ["admin"],
    });

    const response = await app.request("http://laf.local/api/admin/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
