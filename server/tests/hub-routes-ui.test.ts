import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type MiddlewareHandler, Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createHubHttp } from "../src/hub/http";
import type { HubLink, HubStatus } from "../src/hub/link";
import { createHubUiRoutes } from "../src/hub/routes-ui";
import { createSecurityMiddleware } from "../src/middleware/security";

/**
 * The 회사 screen's doors (`hub/routes-ui.ts`), against a fake hub on a real port through the real
 * hub client: what reaches the hub (the pass, `x-laf-origin: person`, a key on every write, only
 * the fields the screen sends, ids that cannot leave their path) and what reaches the browser (the
 * hub's answer or its fact, never the hub's address, the pass, or a 401 that would read as this
 * person's session ending).
 */

const PASS = "c".repeat(64);
const ROOM = "r_0b6f3c4e-1d2a-4f5b-9c8d-7e6f5a4b3c2d";

type Seen = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  bytes: Uint8Array;
};

let hubServer: ReturnType<typeof Bun.serve>;
let hubUrl = "";
const seen: Seen[] = [];
/** What the fake hub answers next, by `METHOD path`; a 200 `{ ok: true }` when unscripted. */
const script = new Map<string, () => Response>();

beforeAll(() => {
  hubServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      const bytes = new Uint8Array(await request.arrayBuffer());
      const body = new TextDecoder().decode(bytes);
      seen.push({
        method: request.method,
        path,
        headers: Object.fromEntries(request.headers),
        body,
        bytes,
      });
      const scripted = script.get(`${request.method} ${path}`);
      if (scripted) return scripted();
      return Response.json({ ok: true, echoed: body.length });
    },
  });
  hubUrl = `http://localhost:${hubServer.port}`;
});
afterAll(() => {
  void hubServer.stop(true);
});

const connected: HubStatus = {
  state: "connected",
  code: null,
  workspace: { name: "라프상사" },
  member: { role: "member", name: "김" },
  since: "2026-10-16T00:00:00.000Z",
};

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

function surface(
  options: {
    configured?: boolean;
    status?: HubStatus;
    guard?: MiddlewareHandler<{ Variables: AppVariables }>;
  } = {},
) {
  seen.length = 0;
  script.clear();
  const refusals: string[] = [];
  const http = createHubHttp({
    url: hubUrl,
    vmKey: PASS,
    // Never slept: a read is asked once, and a write's retries are not what these tests are about.
    sleep: async () => {},
  });
  const link: HubLink = {
    start() {},
    stop() {},
    status: () => options.status ?? connected,
    me: () => null,
    passRefused: (reason) => refusals.push(reason),
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", createSecurityMiddleware());
  app.route(
    "/api/hub",
    createHubUiRoutes(
      options.configured === false ? undefined : { http, link },
      options.guard ?? signedIn,
    ),
  );
  return { app, refusals };
}

describe("/api/hub — the 회사 screen's doors", () => {
  test.each([
    ["GET", "/api/hub/members"],
    ["GET", "/api/hub/rooms"],
    ["GET", `/api/hub/rooms/${ROOM}/messages`],
    ["GET", "/api/hub/files"],
    ["GET", "/api/hub/skills"],
    ["GET", "/api/hub/memory/proposals"],
    ["POST", "/api/hub/memory/mem_1/confirm"],
  ])(
    "%s %s on a VM with no company is a 404 that says so, and asks nothing",
    async (method, path) => {
      const { app } = surface({ configured: false });
      const response = await app.request(path, { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        ok: false,
        code: "laf:hub_not_configured",
      });
      expect(seen).toEqual([]);
    },
  );

  test("a read is asked with the pass, as the person, and handed back without the hub's address or pass", async () => {
    const { app } = surface();
    script.set("GET /hub/v1/rooms", () =>
      Response.json({ ok: true, rooms: [{ id: ROOM, name: "매장 운영" }] }),
    );
    const response = await app.request("/api/hub/rooms");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      rooms: [{ id: ROOM, name: "매장 운영" }],
    });
    expect(text).not.toContain(PASS);
    expect(text).not.toContain(String(hubServer.port));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${PASS}`);
    expect(seen[0]?.headers["x-laf-origin"]).toBe("person");
  });

  test("a read the hub fails is asked once, and is a 502 with the fact", async () => {
    const { app } = surface();
    script.set("GET /hub/v1/files", () =>
      Response.json({ ok: false }, { status: 503 }),
    );
    const response = await app.request("/api/hub/files");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_unreachable",
    });
    expect(seen).toHaveLength(1);
  });

  test("a refused pass is a 502 with its fact, never a 401, and the line is told", async () => {
    const { app, refusals } = surface();
    script.set("GET /hub/v1/members", () =>
      Response.json({ ok: false }, { status: 401 }),
    );
    const response = await app.request("/api/hub/members");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_pass_refused",
    });
    expect(refusals).toEqual(["api_ui"]);
  });

  test("a refusal the hub named keeps its status and its code", async () => {
    const { app } = surface();
    script.set("POST /hub/v1/memory/mem_1/confirm", () =>
      Response.json({ ok: false, code: "laf:hub_forbidden" }, { status: 403 }),
    );
    const response = await app.request("/api/hub/memory/mem_1/confirm", {
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_forbidden",
    });
  });

  test("a line whose pass was already refused is not asked again", async () => {
    const { app } = surface({
      status: { ...connected, state: "refused", code: "laf:hub_pass_refused" },
    });
    const response = await app.request("/api/hub/rooms");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_pass_refused",
    });
    expect(seen).toEqual([]);
  });

  test("a message goes as the person, with the browser's key, and only the text and mentions", async () => {
    const { app } = surface();
    const response = await app.request(`/api/hub/rooms/${ROOM}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "press-0001-abcd",
      },
      // `as: "bot"` is what only a 라피's run may say; `runId` is a run's. Neither is the screen's.
      body: JSON.stringify({
        text: "오늘 마감했어요",
        mentions: ["lafi"],
        as: "bot",
        runId: "run_x",
      }),
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const [post] = seen;
    expect(post?.method).toBe("POST");
    expect(post?.path).toBe(`/hub/v1/rooms/${ROOM}/messages`);
    expect(post?.headers["idempotency-key"]).toBe("press-0001-abcd");
    expect(post?.headers["x-laf-origin"]).toBe("person");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      text: "오늘 마감했어요",
      mentions: ["lafi"],
      as: "member",
    });
  });

  test("a write with no key gets one made for it; a key in another shape is refused unsent", async () => {
    const { app } = surface();
    await app.request("/api/hub/memory/mem_1/retire", { method: "POST" });
    expect(seen[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    seen.length = 0;
    const refused = await app.request("/api/hub/memory/mem_1/retire", {
      method: "POST",
      headers: { "idempotency-key": "short" },
    });
    expect(refused.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test.each([
    [
      "an id that climbs out of its path",
      "/api/hub/rooms/..%2Fmembers/messages",
    ],
    [
      "a cursor that is not a number",
      `/api/hub/rooms/${ROOM}/messages?since=1%20or%201`,
    ],
    ["a slug that is no skill's", "/api/hub/skills/..%2F..%2Fmembers"],
  ])("%s is refused here and never reaches the hub", async (_, path) => {
    const { app } = surface();
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "laf:request_invalid",
    );
    expect(seen).toEqual([]);
  });

  test("only the query fields a room's page takes are passed on, spelled again", async () => {
    const { app } = surface();
    await app.request(
      `/api/hub/rooms/${ROOM}/messages?limit=100&before=40&as=bot`,
    );
    expect(seen[0]?.path).toBe(
      `/hub/v1/rooms/${ROOM}/messages?before=40&limit=100`,
    );
  });

  test("a team file comes back saved, never drawn by this origin", async () => {
    const { app } = surface();
    script.set(
      "GET /hub/v1/files/f_1/content",
      () =>
        new Response("<script>alert(1)</script>", {
          headers: {
            "content-type": "text/html",
            "content-disposition": "attachment; filename*=UTF-8''a.html",
          },
        }),
    );
    const response = await app.request("/api/hub/files/f_1/content");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''a.html",
    );
    expect(await response.text()).toBe("<script>alert(1)</script>");
  });

  test("a file from the person's computer reaches the hub byte for byte, past the server's megabyte", async () => {
    const { app } = surface();
    script.set("PUT /hub/v1/files", () =>
      Response.json({ ok: true, id: "f_9", version: 1, sha256: "x" }),
    );
    // Two megabytes: over the body every other door takes, under the team file's.
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(0x41);
    const form = new FormData();
    form.append("meta", JSON.stringify({ name: "매출.csv", folder: "/" }));
    form.append("blob", new File([bytes], "매출.csv", { type: "text/csv" }));
    const request = new Request("http://localhost/api/hub/files", {
      method: "PUT",
      headers: { "idempotency-key": "upload-0001-abcd" },
      body: form,
    });
    const sent = await request.clone().arrayBuffer();
    const withLength = new Request(request, {
      headers: {
        "idempotency-key": "upload-0001-abcd",
        "content-type": request.headers.get("content-type") ?? "",
        "content-length": String(sent.byteLength),
      },
      body: sent,
    });
    const response = await app.request(withLength);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      id: "f_9",
      version: 1,
      sha256: "x",
    });
    const [put] = seen;
    expect(put?.headers["idempotency-key"]).toBe("upload-0001-abcd");
    expect(put?.headers["content-type"]).toBe(
      request.headers.get("content-type") ?? "",
    );
    expect(Buffer.from(put?.bytes ?? []).equals(Buffer.from(sent))).toBe(true);
  });

  test("an upload the hub has no room for says so, as the hub said it", async () => {
    const { app } = surface();
    script.set("PUT /hub/v1/files", () =>
      Response.json({ ok: false, code: "laf:hub_full" }, { status: 507 }),
    );
    const response = await app.request("/api/hub/files", {
      method: "PUT",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": "4",
      },
      body: "--x-",
    });
    expect(response.status).toBe(507);
    expect(await response.json()).toEqual({ ok: false, code: "laf:hub_full" });
  });

  test("every door is behind the session", async () => {
    const { app } = surface({ guard: signedOut });
    for (const [method, path] of [
      ["GET", "/api/hub/members"],
      ["POST", `/api/hub/rooms/${ROOM}/messages`],
      ["PUT", "/api/hub/files"],
      ["GET", "/api/hub/files/f_1/content"],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(401);
    }
    expect(seen).toEqual([]);
  });
});
