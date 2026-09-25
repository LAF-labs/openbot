import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The front door's routing, read by the binary that will read it on a VM.
 *
 * `app/Caddyfile` hands `/api/*` to the API and everything else to the SPA, and for as long as that
 * was the whole list, `/health` asked from outside a VM was `index.html`: measured 2026-09-06 on a
 * customer VM, 200 and 1,790 bytes, and still 200 through a six-second API outage — the fleet
 * monitor read a dead API as alive. The route that fixes it is one block, and one block is easy to
 * lose in a rewrite, so this pins what the file MEANS rather than what it says: Caddy adapts the
 * file to its JSON form here, and the assertions walk the routes it actually produced.
 */

const root = join(import.meta.dir, "..");
const caddyfile = readFileSync(join(root, "app", "Caddyfile"), "utf8");
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");

/**
 * The port the `web` container's healthcheck asks on, read out of the healthcheck rather than
 * written down twice. It is a Caddyfile fact — the file has to serve that port — and the two live
 * in different files, so the assertions below carry it across.
 */
const healthcheckPort = /wget [^"]*http:\/\/localhost:(\d+)\/health/.exec(
  compose,
)?.[1];

/**
 * The image the web container is built from, so the parser here is the parser on the VM. Read
 * rather than pinned a second time: two copies of a version drift, and a test against last year's
 * Caddy proves nothing about this year's.
 */
const caddyImage = /^FROM (caddy:\S+)/m.exec(
  readFileSync(join(root, "app", "Dockerfile"), "utf8"),
)?.[1];

const dockerAvailable = (() => {
  try {
    return (
      Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" })
        .exitCode === 0
    );
  } catch {
    return false;
  }
})();

type Handler = {
  handler: string;
  routes?: Route[];
  upstreams?: { dial: string }[];
  status_code?: number | string;
  body?: string;
  response?: { set?: Record<string, string[]> };
};
type Matcher = {
  path?: string[];
  host?: string[];
  not?: Matcher[];
  expression?: string;
};
type Route = {
  match?: Matcher[];
  handle?: Handler[];
  group?: string;
};

/**
 * The app's routes, per address it is served on, keyed by the listener.
 *
 * There are two: the public one (PUBLIC_ORIGIN, `http://localhost` when it is unset here) and the
 * container's own, which exists so `docker compose ps` can ask the front door the question the
 * internet asks it. Both are addresses on ONE site block, so both must carry the same routes —
 * which is the point of the arrangement and is asserted rather than assumed.
 *
 * The file goes in over stdin rather than a bind mount. Docker Desktop shares only some of the
 * host's paths and a runner's docker-in-docker shares none, so a mount that works on one machine
 * fails on the next with a message about mounting a directory onto a file — measured here, from a
 * temp directory, before this was stdin.
 *
 * `errors` reads the same sites' `handle_errors` routes instead of their ordinary ones.
 */
function adaptedAppSites(
  kind: "routes" | "errors" = "routes",
  environment: Record<string, string> = {},
): Map<string, Route[]> {
  const run = Bun.spawnSync(
    [
      "docker",
      "run",
      "--rm",
      "--interactive",
      ...Object.entries(environment).flatMap(([name, value]) => [
        "--env",
        `${name}=${value}`,
      ]),
      caddyImage as string,
      "caddy",
      "adapt",
      "--validate",
      "--adapter",
      "caddyfile",
      "--config",
      "/dev/stdin",
    ],
    { stdin: new TextEncoder().encode(caddyfile) },
  );
  expect(run.stderr.toString()).not.toContain("Error");
  expect(run.exitCode).toBe(0);

  const config = JSON.parse(run.stdout.toString()) as {
    apps: {
      http: {
        servers: Record<
          string,
          { listen: string[]; routes: Route[]; errors?: { routes: Route[] } }
        >;
      };
    };
  };

  const sites = new Map<string, Route[]>();
  for (const server of Object.values(config.apps.http.servers)) {
    // PUBLIC_ORIGIN is unset here, so the app's host is the Caddyfile's own default, `localhost`.
    // The www block is a different host and its own listener, and is not one of these.
    const routes =
      kind === "routes" ? server.routes : (server.errors?.routes ?? []);
    const site = routes.find((route) =>
      route.match?.some((m) => m.host?.includes("localhost")),
    );
    const subroute = site?.handle?.find((h) => h.handler === "subroute");
    if (subroute?.routes)
      sites.set(server.listen[0] as string, subroute.routes);
  }
  return sites;
}

/** Where a `handle` block sends its request: the upstream it proxies to, or the file server. */
function destination(route: Route): string | undefined {
  const inner = route.handle?.find((h) => h.handler === "subroute")?.routes;
  for (const step of inner ?? []) {
    for (const handler of step.handle ?? []) {
      if (handler.handler === "reverse_proxy") {
        return handler.upstreams?.map((u) => u.dial).join(",");
      }
      if (handler.handler === "file_server") return "file_server";
    }
  }
  return undefined;
}

const pathOf = (route: Route) => route.match?.[0]?.path?.join(",");

test.skipIf(!dockerAvailable || !caddyImage)(
  "routes /health to the API, ahead of the SPA fallback, as Caddy itself reads the file",
  () => {
    const sites = adaptedAppSites();

    // The public address, and the one the web container's healthcheck asks on.
    expect([...sites.keys()].sort()).toEqual(
      [":80", `:${healthcheckPort}`].sort(),
    );

    for (const routes of sites.values()) {
      // `handle` blocks share one group: the first whose matcher fits wins, the rest are skipped.
      const handles = routes.filter((route) => route.group);
      const byPath = new Map(
        handles.map((route) => [pathOf(route) ?? "<fallback>", route] as const),
      );

      expect(destination(byPath.get("/health") as Route)).toBe("server:3001");
      expect(destination(byPath.get("/api/*") as Route)).toBe("server:3001");
      expect(destination(byPath.get("/connected") as Route)).toBe(
        "server:3001",
      );

      // The fallback is the one block with no matcher, it serves files, and it is last — a /health
      // sorted after it would be index.html again, which is the exact failure this test exists for.
      const fallback = handles.at(-1) as Route;
      expect(fallback.match).toBeUndefined();
      expect(destination(fallback)).toBe("file_server");
      expect(handles.indexOf(byPath.get("/health") as Route)).toBeLessThan(
        handles.indexOf(fallback),
      );
    }
  },
  // The first run on a fresh machine pulls the image.
  120_000,
);

/*
 * THE SPARE'S LOCK (app/Caddyfile). A standing spare runs this front door before anybody owns it,
 * to have its certificate ready, and every path must then answer 503 with nothing proxied. The
 * lock is a `handle` like the others, and Caddy sorts `handle` blocks that have a path matcher by
 * the path's length. So the only proof that it comes FIRST is the order Caddy produces, read here
 * for both states of the variable.
 */
test.skipIf(!dockerAvailable || !caddyImage)(
  "puts the spare's lock ahead of every route, and it proxies nothing",
  () => {
    for (const [value, expression] of [
      ["1", '"1" == "1"'],
      ["", '"" == "1"'],
    ] as const) {
      const sites = adaptedAppSites("routes", { LAF_FRONT_LOCKED: value });
      expect([...sites.keys()].sort()).toEqual(
        [":80", `:${healthcheckPort}`].sort(),
      );
      for (const routes of sites.values()) {
        const handles = routes.filter((route) => route.group);
        const lock = handles[0] as Route;
        expect(lock.match).toEqual([
          { expression: { expr: expression, name: "locked" } } as never,
        ]);
        const answers = handlersOf(lock);
        expect(answers.map((handler) => handler.handler)).toEqual([
          "static_response",
          "static_response",
        ]);
        expect(
          answers.map((handler) => [handler.status_code, handler.body]),
        ).toEqual([
          [200, '{"status":"locked"}'],
          [503, "Not in service."],
        ]);
      }
    }
  },
  120_000,
);

/** Every handler a route runs, through however many subroutes the adapter nested it in. */
function handlersOf(route: Route): Handler[] {
  return (route.handle ?? []).flatMap((handler) =>
    handler.handler === "subroute"
      ? (handler.routes ?? []).flatMap(handlersOf)
      : [handler],
  );
}

/** What an error route answers: its status, its body as JSON, and the content type it sets. */
function answerOf(route: Route) {
  const handlers = handlersOf(route);
  const response = handlers.find((h) => h.handler === "static_response");
  const headers = handlers.find((h) => h.handler === "headers");
  return {
    status: Number(response?.status_code),
    body: JSON.parse(response?.body ?? "null") as unknown,
    contentType: headers?.response?.set?.["Content-Type"],
  };
}

/*
 * WHEN THE API IS NOT THERE, `/health` AND `/api/*` SAY SO — AND NOTHING ELSE CHANGES.
 *
 * Measured 2026-09-14 on the web image built from this tree, with the server container stopped:
 * `/health` and `/api/me` were `502` with `content-length: 0`. A watcher reading the body learned
 * nothing, and the app could not tell a front door with nothing behind it from any other 502.
 */
const API_GONE_HEALTH = { status: "down", checks: { api: "unreachable" } };
const API_GONE_REFUSAL = { code: "laf:api_unreachable" };

test.skipIf(!dockerAvailable || !caddyImage)(
  "answers a missing API on /health and /api/* in JSON, and on no other path, as Caddy itself reads the file",
  () => {
    const sites = adaptedAppSites("errors");
    expect([...sites.keys()].sort()).toEqual(
      [":80", `:${healthcheckPort}`].sort(),
    );

    for (const errors of sites.values()) {
      // One block, and it is for the proxy's own failures only: an error of any other status keeps
      // Caddy's default answer.
      expect(errors).toHaveLength(1);
      const block = errors[0] as Route;
      expect(block.match).toEqual([
        { expression: "{http.error.status_code} in [502, 503, 504]" },
      ]);

      const routes =
        block.handle?.find((h) => h.handler === "subroute")?.routes ?? [];
      expect(routes).toHaveLength(2);
      const [health, api] = routes as [Route, Route];

      expect(health.match).toEqual([{ path: ["/health", "/api/health"] }]);
      expect(answerOf(health)).toEqual({
        status: 503,
        body: API_GONE_HEALTH,
        contentType: ["application/json"],
      });

      expect(api.match).toEqual([
        { path: ["/api/*"], not: [{ path: ["/api/health"] }] },
      ]);
      expect(answerOf(api)).toEqual({
        status: 503,
        body: API_GONE_REFUSAL,
        contentType: ["application/json"],
      });

      // Every error route names its paths: the SPA fallback and /connected have none here.
      for (const route of routes) {
        expect(route.match?.every((m) => (m.path?.length ?? 0) > 0)).toBe(true);
      }
    }
  },
  120_000,
);

/*
 * AND THE SAME, ASKED OF A RUNNING CADDY. The adapted JSON says what the routes are; this says what
 * the pinned image does with them, which a digest bump can change without the JSON moving. The
 * container has no network, so `server` resolves to nothing — the stopped API, as the proxy sees it.
 *
 * Asked with busybox `nc` from inside the container, with stdin held open for a moment: `nc` closes
 * its sending half on EOF, and a client that has half-closed reads to Caddy as one that went away —
 * measured, every proxied path then came back `200` with an empty body, which is Go's default for a
 * handler that wrote nothing.
 */
test.skipIf(!dockerAvailable || !caddyImage)(
  "answers a missing API that way when it is running",
  async () => {
    const started = Bun.spawnSync([
      "docker",
      "run",
      "--detach",
      "--rm",
      "--network",
      "none",
      "--env",
      `CADDYFILE=${caddyfile}`,
      caddyImage as string,
      "sh",
      "-c",
      'printf "%s" "$CADDYFILE" > /etc/caddy/Caddyfile && exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile',
    ]);
    const container = started.stdout.toString().trim();
    expect(started.exitCode).toBe(0);

    const ask = (path: string) => {
      const run = Bun.spawnSync([
        "docker",
        "exec",
        container,
        "sh",
        "-c",
        `(printf 'GET ${path} HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n'; sleep 0.5) | nc localhost ${healthcheckPort}`,
      ]);
      const raw = run.stdout.toString();
      const [head = "", body = ""] = raw.split("\r\n\r\n");
      return {
        status: Number(head.split(" ")[1]),
        contentType: /\r\ncontent-type: ([^\r\n]+)/i.exec(head)?.[1] ?? null,
        body,
      };
    };

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (!Number.isNaN(ask("/health").status)) break;
        await Bun.sleep(100);
      }
      for (const path of ["/health", "/api/health"]) {
        const answer = ask(path);
        expect({ path, ...answer, body: JSON.parse(answer.body) }).toEqual({
          path,
          status: 503,
          contentType: "application/json",
          body: API_GONE_HEALTH,
        });
      }
      const refusal = ask("/api/me");
      expect({ ...refusal, body: JSON.parse(refusal.body) }).toEqual({
        status: 503,
        contentType: "application/json",
        body: API_GONE_REFUSAL,
      });
      // Untouched: the page the API draws keeps Caddy's own answer, and so does the SPA fallback
      // (a 404 here, since this image has no built app in /srv).
      expect(ask("/connected")).toEqual({
        status: 502,
        contentType: null,
        body: "",
      });
      expect(ask("/").status).toBe(404);
    } finally {
      Bun.spawnSync(["docker", "rm", "--force", container]);
    }
  },
  120_000,
);

/*
 * The same facts read off the text, for a machine with no Docker: weaker, since they cannot see
 * what Caddy makes of the file, but never skipped.
 */
test("hands /health to the API rather than to the SPA fallback", () => {
  expect(caddyfile).toMatch(
    /handle \/health \{\n\t+reverse_proxy server:3001\n\t+\}/,
  );
});

test("answers a missing API in JSON, for the proxy's own failures only", () => {
  expect(caddyfile).toContain("handle_errors 502 503 504 {");
  expect(caddyfile).toContain(
    `respond \`${JSON.stringify(API_GONE_HEALTH)}\` 503`,
  );
  expect(caddyfile).toContain(
    `respond \`${JSON.stringify(API_GONE_REFUSAL)}\` 503`,
  );
});

test("serves the port the web container's healthcheck asks on", () => {
  expect(healthcheckPort).toBeDefined();
  expect(caddyfile).toContain(`http://localhost:${healthcheckPort} {`);
});

/*
 * THE HEADERS THE FRONT DOOR PUTS ON WHAT IT SERVES ITSELF.
 *
 * There were none (A8, measured 2026-09-10: no CSP, no HSTS, no frame-ancestors, no nosniff), so the
 * approval button could be framed by any page and pressed through the frame. The policy below was
 * measured on 2026-09-13 against the built SPA in Chromium, every main screen and a chat turn with a
 * code block: no violation — after one fix (Zod's `eval` probe) and one allowance (inline script,
 * for the sandboxed components that inherit this policy). These pin both, because each is the kind
 * of edit that looks like a tidy-up and breaks a screen with nothing but a console line to say so.
 */
const securityPolicy = /Content-Security-Policy "([^"]+)"/.exec(caddyfile)?.[1];
const directives = new Map(
  (securityPolicy ?? "")
    .split(";")
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name)
    .map(([name, ...values]) => [name as string, values] as const),
);

test("sets a Content-Security-Policy that frames nothing, embeds nothing and evaluates nothing", () => {
  expect(securityPolicy).toBeDefined();
  expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  expect(directives.get("object-src")).toEqual(["'none'"]);
  expect(directives.get("base-uri")).toEqual(["'self'"]);
  expect(directives.get("form-action")).toEqual(["'self'"]);
  expect(directives.get("default-src")).toEqual(["'self'"]);
  // The live screen and the activity feed are WebSockets on this host, spelled out — with the
  // port, which a deployment on a non-default one would otherwise lose — for the engines that do
  // not read `'self'` as covering them.
  expect(directives.get("connect-src")).toEqual([
    "'self'",
    "wss://{http.request.hostport}",
    "ws://{http.request.hostport}",
  ]);
  // Images: this origin, data and blob, and the sign-in providers' avatars. Nothing a Bot's answer
  // could point at.
  const images = directives.get("img-src") ?? [];
  expect(images).not.toContain("*");
  expect(images).not.toContain("https:");
  expect(images.filter((source) => source.startsWith("https://"))).toEqual([
    "https://*.googleusercontent.com",
    "https://*.kakaocdn.net",
    "https://*.pstatic.net",
  ]);
});

test("scripts come from this origin or inline, never evaluated and never named by hash", () => {
  const scripts = directives.get("script-src") ?? [];
  expect(scripts).not.toContain("'unsafe-eval'");
  expect(
    scripts.filter((source) => /^(https?:|\*|data:|blob:)/.test(source)),
  ).toEqual([]);
  /*
   * NO HASH, ON PURPOSE. A sandboxed component's iframe is `srcdoc`, and a srcdoc document inherits
   * this policy — measured: with the theme script named by hash, the playground's preview had its
   * inline script refused and drew nothing. A hash or nonce also switches `'unsafe-inline'` off.
   */
  expect(scripts).toEqual(["'self'", "'unsafe-inline'"]);
  expect(
    scripts.some((source) => /^'(sha256|sha384|sha512|nonce)-/.test(source)),
  ).toBe(false);

  // What keeps `eval` refusable: Zod's probe is switched off before the first schema is built.
  const main = readFileSync(join(root, "app", "src", "main.tsx"), "utf8");
  expect(main.split("\n")[0]).toBe('import "@/lib/zod-jitless";');
  expect(
    readFileSync(join(root, "app", "src", "lib", "zod-jitless.ts"), "utf8"),
  ).toContain("config({ jitless: true })");
});

test("sets HSTS, nosniff, no framing and a referrer policy on what it serves, and not on what it proxies", () => {
  const block =
    /@served not path ([^\n]+)\n\theader @served \{([\s\S]*?)\n\t\}/.exec(
      caddyfile,
    );
  expect(block).not.toBeNull();
  // Proxied answers carry the API's own (server/src/middleware/security.ts); doubling up would send
  // two policies, and a browser enforces both.
  expect(block?.[1]?.split(/\s+/)).toEqual(["/api/*", "/connected", "/health"]);
  const headers = block?.[2] ?? "";
  expect(headers).toContain(
    'Strict-Transport-Security "max-age=31536000; includeSubDomains"',
  );
  expect(headers).toContain('X-Content-Type-Options "nosniff"');
  expect(headers).toContain('X-Frame-Options "DENY"');
  expect(headers).toMatch(/Referrer-Policy "[^"]+"/);
  expect(headers).toMatch(/Permissions-Policy "[^"]*camera=\(\)/);
  // Deliberately absent: the shell's unreachable page probes this origin with a no-cors fetch,
  // which Cross-Origin-Resource-Policy would turn into a permanent "server down".
  expect(headers).not.toContain("Cross-Origin-Resource-Policy");
});

/*
 * AND THE LOCK, ASKED OF A RUNNING CADDY. Every path on both addresses is the same 503, even the
 * ones the open door proxies. The one answer that differs is the container's own healthcheck
 * (loopback, the internal port, /health), and it answers "locked" rather than asking a server the
 * spare does not have.
 */
test.skipIf(!dockerAvailable || !caddyImage)(
  "answers every path 503 while locked, and its own healthcheck 200",
  async () => {
    const started = Bun.spawnSync([
      "docker",
      "run",
      "--detach",
      "--rm",
      "--network",
      "none",
      "--env",
      `CADDYFILE=${caddyfile}`,
      "--env",
      "LAF_FRONT_LOCKED=1",
      caddyImage as string,
      "sh",
      "-c",
      'printf "%s" "$CADDYFILE" > /etc/caddy/Caddyfile && exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile',
    ]);
    const container = started.stdout.toString().trim();
    expect(started.exitCode).toBe(0);

    const ask = (port: string, path: string) => {
      const run = Bun.spawnSync([
        "docker",
        "exec",
        container,
        "sh",
        "-c",
        `(printf 'GET ${path} HTTP/1.0\\r\\nHost: localhost:${port}\\r\\n\\r\\n'; sleep 0.5) | nc localhost ${port}`,
      ]);
      const [head = "", body = ""] = run.stdout.toString().split("\r\n\r\n");
      return { status: Number(head.split(" ")[1]), body };
    };

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (!Number.isNaN(ask("80", "/").status)) break;
        await Bun.sleep(100);
      }
      for (const port of ["80", `${healthcheckPort}`]) {
        for (const path of [
          "/",
          "/api/capabilities",
          "/api/health",
          "/connected",
          "/assets/index.js",
          ...(port === "80" ? ["/health"] : []),
        ]) {
          expect({ port, path, ...ask(port, path) }).toEqual({
            port,
            path,
            status: 503,
            body: "Not in service.",
          });
        }
      }
      expect(ask(`${healthcheckPort}`, "/health")).toEqual({
        status: 200,
        body: '{"status":"locked"}',
      });
      // The compose healthcheck itself, verbatim.
      const probe = Bun.spawnSync([
        "docker",
        "exec",
        container,
        "sh",
        "-c",
        `wget -q -O /dev/null http://localhost:${healthcheckPort}/health`,
      ]);
      expect(probe.exitCode).toBe(0);
    } finally {
      Bun.spawnSync(["docker", "rm", "--force", container]);
    }
  },
  120_000,
);

test("the lock is the first thing the site block does after compressing", () => {
  const site = caddyfile.slice(
    caddyfile.indexOf(
      "{$PUBLIC_ORIGIN:http://localhost}, http://localhost:2021 {",
    ),
  );
  const firstHandle = /\n\thandle ([^\n]*)\{/.exec(site)?.[1]?.trim();
  expect(firstHandle).toBe("@locked");
  expect(caddyfile).toContain(
    '@locked expression `"{$LAF_FRONT_LOCKED}" == "1"`',
  );
});
