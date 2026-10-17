import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createHubHttp } from "../src/hub/http";
import type { HubLink, HubStatus } from "../src/hub/link";
import { createHubTaskRoutes } from "../src/hub/routes-ui-tasks";

/**
 * 회사 → 업무판's doors (`hub/routes-ui-tasks.ts`), against a fake hub on a real port through the
 * real hub client: what reaches the hub (the pass, `x-laf-origin: person`, `as: "member"` and no run
 * id whatever the body says, only the fields the board sends, a key on every write) and what comes
 * back (the hub's answer, its `laf:task_stale` with its 409, never a 401).
 */

const PASS = "d".repeat(64);
const TASK = "t_0b6f3c4e-1d2a-4f5b-9c8d-7e6f5a4b3c2d";

type Seen = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

let hubServer: ReturnType<typeof Bun.serve>;
let hubUrl = "";
const seen: Seen[] = [];
const script = new Map<string, () => Response>();

beforeAll(() => {
  hubServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      const body = await request.text();
      seen.push({
        method: request.method,
        path,
        headers: Object.fromEntries(request.headers),
        body,
      });
      const scripted = script.get(`${request.method} ${path}`);
      if (scripted) return scripted();
      return Response.json({ ok: true });
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
  since: "2026-10-17T00:00:00.000Z",
};

const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "u1", email: "u1@laf.test", role: "user" });
  await next();
};

function surface(options: { configured?: boolean; status?: HubStatus } = {}) {
  seen.length = 0;
  script.clear();
  const refusals: string[] = [];
  const http = createHubHttp({
    url: hubUrl,
    vmKey: PASS,
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
  app.route(
    "/api/hub",
    createHubTaskRoutes(
      options.configured === false ? undefined : { http, link },
      signedIn,
    ),
  );
  return { app, refusals };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("/api/hub/tasks — 업무판's doors", () => {
  test.each([
    ["GET", "/api/hub/tasks"],
    ["GET", `/api/hub/tasks/${TASK}`],
    ["POST", "/api/hub/tasks"],
    ["PATCH", `/api/hub/tasks/${TASK}`],
  ])(
    "%s %s with no company is a 404 that says so, and asks nothing",
    async (method, path) => {
      const { app } = surface({ configured: false });
      const response = await app.request(path, {
        method,
        ...(method === "GET" ? {} : json({ title: "x", version: 1 })),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        ok: false,
        code: "laf:hub_not_configured",
      });
      expect(seen).toEqual([]);
    },
  );

  test("the board is read once, with the pass, as the person, and only the named query fields go on", async () => {
    const { app } = surface();
    script.set("GET /hub/v1/tasks?stage=doing&limit=200", () =>
      Response.json({ ok: true, tasks: [{ id: TASK }], next: null }),
    );
    const response = await app.request(
      "/api/hub/tasks?stage=doing&limit=200&visibility=company",
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      tasks: [{ id: TASK }],
      next: null,
    });
    expect(text).not.toContain(PASS);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${PASS}`);
    expect(seen[0]?.headers["x-laf-origin"]).toBe("person");
  });

  test.each([
    ["/api/hub/tasks?stage=finished", "stage"],
    ["/api/hub/tasks?cursor=1%20or%201", "cursor"],
    ["/api/hub/tasks?limit=-1", "limit"],
  ])("%s is refused unsent", async (path, field) => {
    const { app } = surface();
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:request_invalid",
      field,
    });
    expect(seen).toEqual([]);
  });

  test("an id that climbs out of its path never reaches the hub", async () => {
    const { app } = surface();
    const response = await app.request("/api/hub/tasks/..%2Fmembers");
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("a new task goes as the person, with the board's key and only the board's fields", async () => {
    const { app } = surface();
    const response = await app.request("/api/hub/tasks", {
      method: "POST",
      ...json(
        {
          title: "3월 매출 정리",
          visibility: "company",
          assignee: "bot:m_a",
          as: "bot",
          runId: "run_1",
          checkout: { runId: "run_1" },
        },
        { "idempotency-key": "press-0001" },
      ),
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.path).toBe("/hub/v1/tasks");
    expect(seen[0]?.headers["idempotency-key"]).toBe("press-0001");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      title: "3월 매출 정리",
      visibility: "company",
      assignee: "bot:m_a",
      as: "member",
    });
  });

  test.each([
    [{ title: "x", assignee: "admin:m_a" }, "assignee"],
    [{ title: "x", stage: "finished" }, "stage"],
    [{ title: "x", visibility: "everyone" }, "visibility"],
    [{ title: "x", members: ["../m"] }, "members"],
    [{ title: 3 }, "title"],
  ])(
    "a new task with a bad field is refused unsent (%j)",
    async (body, field) => {
      const { app } = surface();
      const response = await app.request("/api/hub/tasks", {
        method: "POST",
        ...json(body),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { field: string }).field).toBe(field);
      expect(seen).toEqual([]);
    },
  );

  test("a move carries the version the board read, and goes as the person", async () => {
    const { app } = surface();
    const response = await app.request(`/api/hub/tasks/${TASK}`, {
      method: "PATCH",
      ...json(
        { version: 4, stage: "doing", rank: 12.5, as: "bot", runId: "r" },
        { "idempotency-key": "move-0001" },
      ),
    });
    expect(response.status).toBe(200);
    expect(seen[0]?.method).toBe("PATCH");
    expect(seen[0]?.path).toBe(`/hub/v1/tasks/${TASK}`);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      version: 4,
      stage: "doing",
      rank: 12.5,
      as: "member",
    });
  });

  test("a move with no version is refused unsent", async () => {
    const { app } = surface();
    const response = await app.request(`/api/hub/tasks/${TASK}`, {
      method: "PATCH",
      ...json({ stage: "done" }),
    });
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("a stale move keeps the hub's 409 and its code, so the board reads again", async () => {
    const { app } = surface();
    script.set(`PATCH /hub/v1/tasks/${TASK}`, () =>
      Response.json(
        { ok: false, code: "laf:task_stale", version: 6 },
        { status: 409 },
      ),
    );
    const response = await app.request(`/api/hub/tasks/${TASK}`, {
      method: "PATCH",
      ...json({ version: 5, stage: "review" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:task_stale",
    });
  });

  test("a refused pass is a 502 with its fact, never a 401, and the line is told", async () => {
    const { app, refusals } = surface();
    script.set(`GET /hub/v1/tasks/${TASK}`, () =>
      Response.json({ ok: false }, { status: 401 }),
    );
    const response = await app.request(`/api/hub/tasks/${TASK}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_pass_refused",
    });
    expect(refusals).toEqual(["api_ui"]);
  });

  test("a note goes as the person's, its text only", async () => {
    const { app } = surface();
    const response = await app.request(`/api/hub/tasks/${TASK}/notes`, {
      method: "POST",
      ...json({ text: "거래처에 전화했어요", as: "bot", runId: "r" }),
    });
    expect(response.status).toBe(200);
    expect(seen[0]?.path).toBe(`/hub/v1/tasks/${TASK}/notes`);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      text: "거래처에 전화했어요",
      as: "member",
    });
    expect(seen[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
