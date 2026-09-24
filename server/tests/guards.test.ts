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
      error: "laf:unauthenticated",
      code: "laf:unauthenticated",
    });
  });

  test("denies a signed-in user from an administrator route", async () => {
    const app = createApp(config, authenticatedAs("member"), {
      rolesForUser: async () => ["user"],
    });

    const response = await app.request("http://laf.local/api/admin/status");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "laf:admin_required",
      code: "laf:admin_required",
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
      error: "laf:no_access",
      code: "laf:no_access",
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
      error: "laf:no_access",
      code: "laf:no_access",
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
      // No seat count: a person has one Bot since 2026-09-24, and nothing on the surface counts.
      deployment: { effort: true, autoReview: true },
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

/*
 * A SESSION WHOSE PERSON IS NO LONGER LET IN.
 *
 * The admission is a stub here, so each branch of the guard can be seen to fall on its own; the real
 * list, the real rows and the real cookies are `session-revocation.integration.test.ts`.
 */
describe("a session whose person the deployment no longer admits", () => {
  function admission(input: { admits: boolean; revokedCookie?: boolean }) {
    const revoked: string[] = [];
    return {
      revoked,
      admission: {
        admits: () => input.admits,
        revoke: async (userId: string) => {
          revoked.push(userId);
          return 1;
        },
        wasRevoked: () => input.revokedCookie ?? false,
      },
    };
  }

  const appWith = (
    auth: Parameters<typeof createApp>[1],
    roles: Parameters<typeof createApp>[2],
    sessions: ReturnType<typeof admission>["admission"],
  ) => {
    const args: Parameters<typeof createApp> = [config, auth, roles];
    args[41] = sessions;
    return createApp(...args);
  };

  test("is revoked and refused with its own code, before any role is read — an administrator's too", async () => {
    const { admission: struckOff, revoked } = admission({ admits: false });
    let rolesRead = 0;
    const app = appWith(
      authenticatedAs("struck-off"),
      {
        rolesForUser: async () => {
          rolesRead += 1;
          return ["admin"];
        },
      },
      struckOff,
    );

    const response = await app.request("http://laf.local/api/admin/status");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "laf:session_revoked",
      code: "laf:session_revoked",
    });
    expect(revoked).toEqual(["struck-off"]);
    expect(rolesRead).toBe(0);
  });

  test("a cookie whose session was already taken away is told so, not that nobody is signed in", async () => {
    const { admission: gone, revoked } = admission({
      admits: true,
      revokedCookie: true,
    });
    const app = appWith(noSessionAuth, { rolesForUser: async () => [] }, gone);

    const response = await app.request("http://laf.local/api/me");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "laf:session_revoked",
      code: "laf:session_revoked",
    });
    expect(revoked).toEqual([]);
  });

  test("a person still admitted is untouched", async () => {
    const { admission: admitted, revoked } = admission({ admits: true });
    const app = appWith(
      authenticatedAs("member"),
      { rolesForUser: async () => ["user"] },
      admitted,
    );

    const response = await app.request("http://laf.local/api/me");

    expect(response.status).toBe(200);
    expect(revoked).toEqual([]);
  });
});
