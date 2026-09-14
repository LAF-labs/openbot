import { describe, expect, test } from "bun:test";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import { createRequestActors } from "../src/auth/request-actor";
import type { UserRole } from "../src/auth/roles";

/**
 * Who is asking, for the two doors `requireUser` never sees — the CopilotKit runtime's agent factory
 * and the live-screen upgrade. It was three functions at the top of `main.ts`; the rules are the same
 * rules, and now something other than a booted process can check them.
 */

type Auth = Parameters<typeof createRequestActors>[0]["auth"];

const request = new Request("http://laf.test/api/copilotkit/threads");

const signedIn = (user: {
  id: string;
  email?: string | null;
  name?: string | null;
}) =>
  ({
    api: { getSession: async () => ({ user }) },
  }) as unknown as Auth;

const noSession = { api: { getSession: async () => null } } as unknown as Auth;

const actorsWith = (auth: Auth, roles: UserRole[], devNoAuth = false) =>
  createRequestActors({
    devNoAuth,
    auth,
    roles: { rolesForUser: async () => roles },
  });

describe("who is asking", () => {
  test("with LAF_DEV_NO_AUTH, everybody is the local administrator, and no session is read", async () => {
    const actors = actorsWith(undefined, [], true);
    expect(await actors.resolve(request)).toEqual({
      id: DEV_ACTOR.id,
      name: DEV_ACTOR.email,
      role: DEV_ACTOR.role,
    });
  });

  test("a signed-in person with a role is resolved, an administrator as one", async () => {
    const person = signedIn({ id: "u1", email: "u1@laf.test", name: "사장님" });
    expect(await actorsWith(person, ["user"]).resolve(request)).toEqual({
      id: "u1",
      name: "사장님",
      role: "user",
    });
    expect(
      (await actorsWith(person, ["user", "admin"]).resolve(request)).role,
    ).toBe("admin");
  });

  test("a name falls back to the address, and then to the id", async () => {
    expect(
      (
        await actorsWith(
          signedIn({ id: "u2", email: "u2@laf.test", name: null }),
          ["user"],
        ).resolve(request)
      ).name,
    ).toBe("u2@laf.test");
    expect(
      (
        await actorsWith(signedIn({ id: "u3", email: null, name: null }), [
          "user",
        ]).resolve(request)
      ).name,
    ).toBe("u3");
  });

  test("nobody signed in, no sign-in at all, and a person with no role are refused", async () => {
    for (const actors of [
      actorsWith(noSession, ["user"]),
      actorsWith(undefined, ["user"]),
      actorsWith(signedIn({ id: "stranger" }), []),
    ]) {
      await expect(actors.resolve(request)).rejects.toThrow("CopilotKit run");
      // The doors that decide whose data is served refuse rather than guess.
      expect(await actors.resolveOrNull(request)).toBeNull();
      // The runtime's factory gets somebody who owns nothing and is not an administrator.
      expect(await actors.identify(request)).toEqual({ id: "", role: "user" });
    }
  });

  test("a person the sign-in list no longer admits is refused at both doors, and their sessions revoked", async () => {
    const revoked: string[] = [];
    const actors = createRequestActors({
      devNoAuth: false,
      auth: signedIn({ id: "u5", email: "struck-off@laf.test", name: "직원" }),
      roles: { rolesForUser: async () => ["user"] },
      admission: {
        admits: (email) => email !== "struck-off@laf.test",
        revoke: async (userId) => {
          revoked.push(userId);
          return 1;
        },
      },
    });
    await expect(actors.resolve(request)).rejects.toThrow("CopilotKit run");
    // The live-screen upgrade's door: refused rather than guessed, and revoked all the same.
    expect(await actors.resolveOrNull(request)).toBeNull();
    expect(revoked).toEqual(["u5", "u5"]);
  });

  test("the runtime's projection carries the id and the role, and nothing else", async () => {
    expect(
      await actorsWith(signedIn({ id: "u4", name: "직원" }), ["user"]).identify(
        request,
      ),
    ).toEqual({ id: "u4", role: "user" });
  });
});
