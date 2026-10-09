import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createLoginRoutes } from "../src/logins/routes";
import { LoginRefused, type SavedLogin } from "../src/logins/store";

/**
 * 로그인 보관함's DOORS, WITHOUT A DATABASE (`logins/routes.ts`).
 *
 * What the doors themselves decide: whose row is asked for, what of a body reaches the vault, and
 * that nothing they answer is kept by anything between the server and the window. What the vault
 * does with it is held against the real table (`saved-logins.integration.test.ts`).
 */
const SAVED: SavedLogin = {
  id: "login_1",
  label: "네이버",
  site: null,
  origins: ["https://nid.naver.com"],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  lastUsedAt: null,
};

function doors() {
  const calls: unknown[][] = [];
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "person-1",
      role: "user",
    } as AppVariables["actor"]);
    await next();
  };
  const routes = createLoginRoutes(
    {
      list: async (...call) => {
        calls.push(["list", ...call]);
        return [SAVED];
      },
      save: async (...call) => {
        calls.push(["save", ...call]);
        return SAVED;
      },
      replace: async (...call) => {
        calls.push(["replace", ...call]);
        return call[1] === SAVED.id ? SAVED : null;
      },
      remove: async (...call) => {
        calls.push(["remove", ...call]);
        return call[1] === SAVED.id;
      },
    },
    requireUser,
  );
  const send = (method: string, path: string, body?: unknown) =>
    routes.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { calls, send };
}

describe("the saved logins' doors", () => {
  test("ask the vault for the signed-in person's rows, by their id and nobody's a body names", async () => {
    const { calls, send } = doors();
    await send("GET", "/");
    await send("POST", "/", { label: "네이버", userId: "somebody-else" });
    await send("PATCH", "/login_1", {
      label: "네이버",
      userId: "somebody-else",
    });
    await send("DELETE", "/login_1");
    expect(calls.map((call) => [call[0], call[1]])).toEqual([
      ["list", "person-1"],
      ["save", "person-1"],
      ["replace", "person-1"],
      ["remove", "person-1"],
    ]);
  });

  test("hand the vault the five things a login is made of, and nothing else a body carries", async () => {
    const { calls, send } = doors();
    const stray = {
      id: "login_of-my-choosing",
      userId: "somebody-else",
      wrappedKey: "lv1.AAAA.AAAA",
      sealedPassword: "lv1.AAAA.AAAA",
      kekId: "0000000000000000",
      lastUsedAt: "2020-01-01T00:00:00.000Z",
    };
    const login = {
      label: "네이버",
      site: "naver-smartstore",
      origins: ["nid.naver.com"],
      username: "sajang",
      password: "hunter2",
    };
    await send("POST", "/", { ...login, ...stray });
    expect(calls[0]).toEqual(["save", "person-1", login]);

    // A change carries what was sent and only that: a field left out is not sent as "undefined",
    // which the vault would read as a value to refuse.
    await send("PATCH", "/login_1", { password: "new", ...stray });
    expect(calls[1]).toEqual([
      "replace",
      "person-1",
      "login_1",
      { password: "new" },
    ]);
    await send("PATCH", "/login_1", { label: "가게" });
    expect(calls[2]).toEqual([
      "replace",
      "person-1",
      "login_1",
      { label: "가게" },
    ]);
  });

  test("answer with what the row is called and where it may go, kept by nothing on the way", async () => {
    const { send } = doors();
    for (const [method, path, body, status] of [
      ["GET", "/", undefined, 200],
      ["POST", "/", { label: "네이버" }, 201],
      ["PATCH", "/login_1", { label: "네이버" }, 200],
      ["PATCH", "/login_nobodys", { label: "네이버" }, 404],
      ["DELETE", "/login_1", undefined, 204],
      ["DELETE", "/login_nobodys", undefined, 404],
    ] as const) {
      const response = await send(method, path, body);
      expect([method, path, response.status]).toEqual([method, path, status]);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const { send: again } = doors();
    expect(await (await again("DELETE", "/login_nobodys")).json()).toEqual({
      error: "laf:login_not_found",
      code: "laf:login_not_found",
    });
  });

  test("say a refusal as the fact and the field, and take a body that is not an object for an empty one", async () => {
    const calls: unknown[] = [];
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "person-1",
        role: "user",
      } as AppVariables["actor"]);
      await next();
    };
    const routes = createLoginRoutes(
      {
        list: async () => [],
        save: async (_user, written) => {
          calls.push(written);
          throw written.label === "가득"
            ? new LoginRefused("laf:logins_full")
            : new LoginRefused("laf:login_origin_refused", "origins");
        },
        replace: async () => {
          throw new LoginRefused("laf:login_value_too_long", "password");
        },
        remove: async () => false,
      },
      requireUser,
    );
    const post = (body: string) =>
      routes.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    const refused = await post(JSON.stringify({ label: "네이버" }));
    expect([refused.status, await refused.json()]).toEqual([
      400,
      {
        error: "laf:login_origin_refused",
        code: "laf:login_origin_refused",
        field: "origins",
      },
    ]);
    // Full is not a mistake in what was written.
    const full = await post(JSON.stringify({ label: "가득" }));
    expect([full.status, await full.json()]).toEqual([
      409,
      { error: "laf:logins_full", code: "laf:logins_full" },
    ]);
    const changed = await routes.request("/login_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x" }),
    });
    expect([changed.status, await changed.json()]).toEqual([
      400,
      {
        error: "laf:login_value_too_long",
        code: "laf:login_value_too_long",
        field: "password",
      },
    ]);

    // A list, a string, or bytes that are not JSON: a login made of nothing, for the vault to
    // refuse the way it refuses any — never a list's own properties read as a login's.
    calls.length = 0;
    for (const body of ['["label"]', '"label"', "{not json", ""]) {
      await post(body);
    }
    expect(calls).toEqual(
      Array.from({ length: 4 }, () => ({
        label: undefined,
        site: undefined,
        origins: undefined,
        username: undefined,
        password: undefined,
      })),
    );
  });
});
