import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createHubHttp } from "../src/hub/http";
import type { HubLink, HubStatus } from "../src/hub/link";
import { createHubUiDocRoutes, personOp } from "../src/hub/routes-ui-docs";
import { createSecurityMiddleware } from "../src/middleware/security";

/**
 * 회사 → 문서's doors (`hub/routes-ui-docs.ts`), against a fake hub on a real port through the real
 * hub client: a person's block changes reach the hub as the four ops and nothing else, each with
 * its `version` and never a hash; the hold's doors go to the block's path; the hub's 409s keep their
 * status and code, which the editor reopens on; and nothing goes out for a malformed op, an id that
 * would climb out of its path, or a person who is not signed in.
 */

const PASS = "d".repeat(64);
const DOC = "d_0b6f3c4e-1d2a-4f5b-9c8d-7e6f5a4b3c2d";
const BLOCK = "b_k3j4h5g6f7d8";

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
      seen.push({
        method: request.method,
        path,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      const scripted = script.get(`${request.method} ${path}`);
      return scripted ? scripted() : Response.json({ ok: true });
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

const signedOut: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
) => context.json({ code: "laf:unauthenticated" }, 401);

function surface(
  options: {
    configured?: boolean;
    guard?: MiddlewareHandler<{ Variables: AppVariables }>;
  } = {},
) {
  seen.length = 0;
  script.clear();
  const http = createHubHttp({
    url: hubUrl,
    vmKey: PASS,
    sleep: async () => {},
  });
  const link: HubLink = {
    start() {},
    stop() {},
    status: () => connected,
    me: () => null,
    passRefused: () => {},
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", createSecurityMiddleware());
  app.route(
    "/api/hub",
    createHubUiDocRoutes(
      options.configured === false ? undefined : { http, link },
      options.guard ?? signedIn,
    ),
  );
  return app;
}

const postJson = (body: unknown, key = "press-0001-abcd") => ({
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": key },
  body: JSON.stringify(body),
});

describe("/api/hub/docs — the document doors", () => {
  test.each([
    ["GET", "/api/hub/docs"],
    ["GET", `/api/hub/docs/${DOC}`],
    ["POST", `/api/hub/docs/${DOC}/blocks/${BLOCK}/lock`],
  ])(
    "%s %s on a VM with no company is a 404 that says so, and asks nothing",
    async (method, path) => {
      const app = surface({ configured: false });
      const response = await app.request(path, { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        ok: false,
        code: "laf:hub_not_configured",
      });
      expect(seen).toEqual([]);
    },
  );

  test("a document is read once, with the pass, as the person, and handed back as the hub said", async () => {
    const app = surface();
    const body = {
      ok: true,
      doc: { id: DOC, title: "3월 마감" },
      blocks: [{ id: BLOCK, kind: "paragraph", text: "안녕", version: 1 }],
      locks: [{ block: BLOCK, member: "m_2", name: "민수", until: "x" }],
    };
    script.set(`GET /hub/v1/docs/${DOC}`, () => Response.json(body));
    const response = await app.request(`/api/hub/docs/${DOC}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(body);
    expect(text).not.toContain(PASS);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${PASS}`);
    expect(seen[0]?.headers["x-laf-origin"]).toBe("person");
  });

  test("a block is read again by its own path", async () => {
    const app = surface();
    await app.request(`/api/hub/docs/${DOC}/blocks/${BLOCK}`);
    expect(seen.map((one) => `${one.method} ${one.path}`)).toEqual([
      `GET /hub/v1/docs/${DOC}/blocks/${BLOCK}`,
    ]);
  });

  test("a read the hub fails is asked once and is a 502 with the fact", async () => {
    const app = surface();
    script.set(`GET /hub/v1/docs/${DOC}`, () =>
      Response.json({ ok: false }, { status: 503 }),
    );
    const response = await app.request(`/api/hub/docs/${DOC}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_unreachable",
    });
    expect(seen).toHaveLength(1);
  });

  test("a batch goes with the browser's key, each op spelled again with only what it uses", async () => {
    const app = surface();
    const response = await app.request(
      `/api/hub/docs/${DOC}/blocks`,
      postJson({
        ops: [
          {
            op: "replace",
            id: BLOCK,
            version: 3,
            text: "고친 글",
            // A hash is 라피's check, not a person's; a field no op takes is nobody's.
            expectHash: "0123456789abcdef",
            whole: true,
          },
          {
            op: "insert_after",
            id: BLOCK,
            newId: "b_newblock0001",
            kind: "check",
            text: "",
            attrs: { checked: false },
          },
          { op: "delete", id: "b_gone000000", version: 2 },
          { op: "move", id: BLOCK, version: 4, after: null },
        ],
        title: "ignored",
      }),
    );
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const [post] = seen;
    expect(post?.path).toBe(`/hub/v1/docs/${DOC}/blocks`);
    expect(post?.headers["idempotency-key"]).toBe("press-0001-abcd");
    expect(post?.headers["x-laf-origin"]).toBe("person");
    expect(JSON.parse(post?.body ?? "")).toEqual({
      ops: [
        { op: "replace", id: BLOCK, version: 3, text: "고친 글" },
        {
          op: "insert_after",
          id: BLOCK,
          newId: "b_newblock0001",
          kind: "check",
          text: "",
          attrs: { checked: false },
        },
        { op: "delete", id: "b_gone000000", version: 2 },
        { op: "move", id: BLOCK, version: 4, after: null },
      ],
    });
  });

  test.each([
    [
      "an op that is not one of the four",
      { op: "replace_all", id: BLOCK, version: 1, text: "x" },
    ],
    ["a replace with no version", { op: "replace", id: BLOCK, text: "x" }],
    [
      "a replace that changes nothing",
      { op: "replace", id: BLOCK, version: 1 },
    ],
    [
      "a kind not in the list",
      { op: "insert_after", id: BLOCK, kind: "html", text: "x" },
    ],
    [
      "an id that leaves its path",
      { op: "delete", id: "../members", version: 1 },
    ],
    [
      "a new id in another shape",
      { op: "insert_after", id: null, newId: "X/Y", kind: "paragraph" },
    ],
    [
      "text past a block's bound",
      { op: "replace", id: BLOCK, version: 1, text: "가".repeat(20_001) },
    ],
  ])("%s refuses the batch unsent", async (_name, op) => {
    const app = surface();
    const response = await app.request(
      `/api/hub/docs/${DOC}/blocks`,
      postJson({ ops: [{ op: "delete", id: BLOCK, version: 1 }, op] }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "ops" });
    expect(seen).toEqual([]);
  });

  test.each([["laf:doc_block_changed"], ["laf:doc_block_busy"]])(
    "the hub's 409 %s keeps its status and code",
    async (code) => {
      const app = surface();
      script.set(`POST /hub/v1/docs/${DOC}/blocks`, () =>
        Response.json({ ok: false, code, op: 0, block: null }, { status: 409 }),
      );
      const response = await app.request(
        `/api/hub/docs/${DOC}/blocks`,
        postJson({
          ops: [{ op: "replace", id: BLOCK, version: 1, text: "x" }],
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, code });
    },
  );

  test("taking and letting go of a hold go to the block's own doors, asked once", async () => {
    const app = surface();
    script.set(`POST /hub/v1/docs/${DOC}/blocks/${BLOCK}/lock`, () =>
      Response.json({ ok: false }, { status: 503 }),
    );
    const lock = await app.request(
      `/api/hub/docs/${DOC}/blocks/${BLOCK}/lock`,
      {
        method: "POST",
      },
    );
    expect(lock.status).toBe(502);
    await app.request(`/api/hub/docs/${DOC}/blocks/${BLOCK}/unlock`, {
      method: "POST",
    });
    expect(seen.map((one) => `${one.method} ${one.path}`)).toEqual([
      `POST /hub/v1/docs/${DOC}/blocks/${BLOCK}/lock`,
      `POST /hub/v1/docs/${DOC}/blocks/${BLOCK}/unlock`,
    ]);
  });

  test("a new document takes only its title", async () => {
    const app = surface();
    await app.request(
      "/api/hub/docs",
      postJson({ title: "  회의록 ", markdown: "# x", visibility: "all" }),
    );
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ title: "회의록" });
    seen.length = 0;
    const refused = await app.request("/api/hub/docs", postJson({ title: 3 }));
    expect(refused.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("nobody signed in reaches no door", async () => {
    const app = surface({ guard: signedOut });
    for (const [method, path] of [
      ["GET", "/api/hub/docs"],
      ["GET", `/api/hub/docs/${DOC}`],
      ["POST", `/api/hub/docs/${DOC}/blocks`],
      ["POST", `/api/hub/docs/${DOC}/blocks/${BLOCK}/lock`],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(401);
    }
    expect(seen).toEqual([]);
  });
});

describe("personOp", () => {
  test("keeps a move to the top and refuses one with nowhere named", () => {
    expect(
      personOp({ op: "move", id: BLOCK, version: 1, after: null }),
    ).toEqual({
      op: "move",
      id: BLOCK,
      version: 1,
      after: null,
    });
    expect(personOp({ op: "move", id: BLOCK, version: 1 })).toBeNull();
  });
});
