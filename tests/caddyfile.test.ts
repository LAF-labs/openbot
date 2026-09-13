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
};
type Route = {
  match?: { path?: string[]; host?: string[] }[];
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
 */
function adaptedAppSites(): Map<string, Route[]> {
  const run = Bun.spawnSync(
    [
      "docker",
      "run",
      "--rm",
      "--interactive",
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
        servers: Record<string, { listen: string[]; routes: Route[] }>;
      };
    };
  };

  const sites = new Map<string, Route[]>();
  for (const server of Object.values(config.apps.http.servers)) {
    // PUBLIC_ORIGIN is unset here, so the app's host is the Caddyfile's own default, `localhost`.
    // The www block is a different host and its own listener, and is not one of these.
    const site = server.routes.find((route) =>
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
 * The same facts read off the text, for a machine with no Docker: weaker, since they cannot see
 * what Caddy makes of the file, but never skipped.
 */
test("hands /health to the API rather than to the SPA fallback", () => {
  expect(caddyfile).toMatch(
    /handle \/health \{\n\t+reverse_proxy server:3001\n\t+\}/,
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
