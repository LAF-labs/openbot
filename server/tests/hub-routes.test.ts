import { describe, expect, test } from "bun:test";
import { type MiddlewareHandler, Hono } from "hono";
import type { HubMe } from "../../shared/hub/protocol";
import type { AppVariables } from "../src/auth/guards";
import type { HubAnswer, HubHttp } from "../src/hub/http";
import type { HubLink, HubStatus } from "../src/hub/link";
import { createHubRoutes } from "../src/hub/routes";

/**
 * `/api/hub/*`: the app's two doors to the hub, behind the session. What is checked is what the
 * browser is handed — facts, never the hub's address, the pass, or the private address `/me` gives
 * a VM — and that a hub's 401 never reaches the browser as one.
 */

const PASS = "f".repeat(64);
const HUB_URL = "https://acme.hub.example";

const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "u1", email: "u1@laf.test", role: "user" });
  await next();
};

const signedOut: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
) =>
  context.json(
    { error: "laf:unauthenticated", code: "laf:unauthenticated" },
    401,
  );

const connected: HubStatus = {
  state: "connected",
  code: null,
  workspace: { name: "라프상사" },
  member: { role: "member", name: "김" },
  since: "2026-10-16T00:00:00.000Z",
};

function surface(
  options: {
    answer?: HubAnswer<HubMe>;
    status?: HubStatus;
    configured?: boolean;
    guard?: MiddlewareHandler<{ Variables: AppVariables }>;
  } = {},
) {
  const refusals: string[] = [];
  const asked: string[] = [];
  const http: HubHttp = {
    request: async (request) => {
      asked.push(request.path);
      return (options.answer ?? {
        ok: false,
        status: null,
        code: "x",
      }) as never;
    },
    socket: () => ({
      url: `${HUB_URL}/hub/v1/events`,
      headers: { authorization: `Bearer ${PASS}` },
    }),
  };
  const link: HubLink = {
    start() {},
    stop() {},
    status: () => options.status ?? connected,
    me: () => null,
    passRefused: (reason) => refusals.push(reason),
  };
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/api/hub",
    createHubRoutes(
      options.configured === false ? undefined : { http, link },
      options.guard ?? signedIn,
    ),
  );
  return { app, refusals, asked };
}

describe("/api/hub", () => {
  test("a VM with no hub says so, and has no /me to ask", async () => {
    const { app } = surface({ configured: false });
    expect(await (await app.request("/api/hub/status")).json()).toEqual({
      configured: false,
    });
    const me = await app.request("/api/hub/me");
    expect(me.status).toBe(404);
    expect(await me.json()).toEqual({
      ok: false,
      code: "laf:hub_not_configured",
    });
  });

  test("the status is the line's facts, and nothing that could reach the hub", async () => {
    const { app } = surface();
    const response = await app.request("/api/hub/status");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ configured: true, ...connected });
    expect(text).not.toContain(PASS);
    expect(text).not.toContain("acme.hub.example");
  });

  test("/me hands back who and which company, without the private address", async () => {
    const { app } = surface({
      answer: {
        ok: true,
        status: 200,
        body: {
          ok: true,
          member: { id: "m_1", role: "admin", name: "김" },
          workspace: { id: "w_1", name: "라프상사" },
          protocol: 1,
          privateIp: "10.20.0.5",
          seq: 9,
        },
      },
    });
    const response = await app.request("/api/hub/me");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      member: { id: "m_1", role: "admin", name: "김" },
      workspace: { id: "w_1", name: "라프상사" },
    });
    expect(text).not.toContain("10.20.0.5");
  });

  test("a refused pass is a 502 with the fact, never a 401, and the line is told", async () => {
    const { app, refusals } = surface({
      answer: { ok: false, status: 401, code: "laf:hub_pass_refused" },
    });
    const response = await app.request("/api/hub/me");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_pass_refused",
    });
    expect(refusals).toEqual(["api_me"]);
  });

  test("a line already refused is not asked again by the route", async () => {
    const { app, asked } = surface({
      status: { ...connected, state: "refused", code: "laf:hub_pass_refused" },
    });
    const response = await app.request("/api/hub/me");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_pass_refused",
    });
    expect(asked).toEqual([]);
  });

  test("both doors are behind the session", async () => {
    const { app } = surface({ guard: signedOut });
    expect((await app.request("/api/hub/status")).status).toBe(401);
    expect((await app.request("/api/hub/me")).status).toBe(401);
  });
});
