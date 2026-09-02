import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Plain postgres, and NOT pgvector, which this asserted for as long as one dead table carried a
 * `vector(1536)` column. Migration 0024 drops the column, the table and the extension; an image
 * carrying an extension nothing uses is a larger pull and a second thing to keep current, and
 * `not.toContain` is here so re-adding one is a failing test rather than a quiet requirement.
 */
test("provides PostgreSQL 17 for local development", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  expect(compose).toContain("image: postgres:17");
  expect(compose).not.toContain("pgvector");
  expect(compose).toContain("127.0.0.1:${POSTGRES_PORT:-5432}:5432");
});

/**
 * Every published port is settable, defaults to the number the documentation gives, and is bound
 * to loopback.
 *
 * `scripts/start.sh` reads these same names to decide where to look for each service.
 *
 * The bind address is the property under test, and it is asserted here because nothing else can
 * see it. On a VM the only thing that ever kept Postgres off the internet was the cloud ingress
 * list; a rule there widened by a range rather than a port reaches the database directly, and the
 * host's own `INPUT` firewall is not a second lock because Docker publishes by DNAT. Dropping
 * `127.0.0.1:` from a line here breaks nothing anybody would notice — in-compose traffic goes by
 * service name and local development goes over loopback either way — so the mistake is silent
 * until it is somebody's credential vault.
 */
test("publishes every service on loopback, on a settable port with the documented default", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  const published = [
    ["POSTGRES_PORT", "5432", "5432"],
    ["COMPUTER_PORT", "4100", "4100"],
    ["BOT_PORT", "4200", "4200"],
  ] as const;

  for (const [name, host, container] of published) {
    expect(compose).toContain(`127.0.0.1:\${${name}:-${host}}:${container}`);
  }

  // `web` is the exception and the only one: the front door has to answer the internet.
  expect(compose).toContain('- "80:80"');
  expect(compose).toContain('- "443:443"');
});

/**
 * Everything that calls a model is reachable at whatever `OPENAI_BASE_URL` names.
 *
 * This used to say "both Bots", because the API server was not a compose service and read the
 * variable out of `.env` itself. Now that a deployment runs it here too, it sees only what compose
 * hands it — and a deployment that moved its models to a gateway and found part of itself still
 * calling OpenAI would have no way to tell.
 */
test("gives everything that calls a model the OpenAI-compatible endpoint", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  // The API server and the Bot endpoint. Two services call a model; both must hear the same answer.
  expect(
    compose.match(/OPENAI_BASE_URL: \$\{OPENAI_BASE_URL:-?\}/g),
  ).toHaveLength(2);
});

/**
 * The sign-in button and the server that answers it are decided by one setting.
 *
 * Whether the button exists is compiled into the app, so it is a build input; whether sign-in works
 * is a run-time setting on the API. Two conditions meant two ways to be half-configured — a server
 * accepting sign-ins the surface never offered, or a button that posted into a 503. Both are keyed
 * off GOOGLE_OAUTH_CLIENT_ID so the two halves cannot disagree.
 */
test("draws the sign-in button exactly when the API can answer it", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  // The web build and the server read the same declaration, so the buttons and the API cannot
  // disagree; the server validates the declaration against the credentials at startup.
  expect(compose).toContain("AUTH_PROVIDERS: ${AUTH_PROVIDERS:-}");
  expect(compose).toContain(
    "BETTER_AUTH_URL: ${AUTH_PROVIDERS:+${PUBLIC_ORIGIN}}",
  );
  expect(compose).toContain(
    "BETTER_AUTH_SECRET: ${AUTH_PROVIDERS:+${BETTER_AUTH_SECRET}}",
  );
});

/**
 * The www name redirects to the apex instead of serving a second copy of the app.
 *
 * Found live: www resolved (a CNAME existed) but Caddy held no certificate for it, so the first
 * person to type www got ERR_SSL_PROTOCOL_ERROR mid sign-in. And the tempting fix — serving the
 * app on both names — is worse than the error: the cookie origin is one string, so the www copy
 * would offer sign-in forever without ever holding a session.
 */
test("redirects the www name to the apex rather than serving it", () => {
  const caddyfile = readFileSync(
    join(import.meta.dir, "..", "app", "Caddyfile"),
    "utf8",
  );
  expect(caddyfile).toContain("{$PUBLIC_WWW_ORIGIN:http://www.localhost} {");
  expect(caddyfile).toContain("redir {$PUBLIC_ORIGIN:http://localhost}{uri}");

  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );
  expect(compose).toContain(
    "PUBLIC_WWW_ORIGIN: ${PUBLIC_WWW_ORIGIN:-http://www.localhost}",
  );
});

/*
 * The chain has to walk on the image compose names, and it did not.
 *
 * 0000 opened with `CREATE EXTENSION IF NOT EXISTS vector` for one `vector(1536)` column in a table
 * nothing ever wrote to. Measured against `postgres:17`: "extension "vector" is not available",
 * and the chain stops on its first statement — so switching the image without also taking that line
 * out would have left every fresh database, CI's included, unable to migrate at all. This is the
 * assertion that the two stay in step: no migration may require an extension the image lacks.
 */
test("needs no Postgres extension the image does not ship", () => {
  const migrations = readdirSync(
    join(import.meta.dir, "..", "server", "drizzle"),
  )
    .filter((name) => name.endsWith(".sql"))
    .map((name) =>
      readFileSync(
        join(import.meta.dir, "..", "server", "drizzle", name),
        "utf8",
      ),
    );

  expect(migrations.length).toBeGreaterThan(0);
  for (const migration of migrations) {
    expect(migration).not.toMatch(/^\s*CREATE EXTENSION/im);
  }
});

test("runs migrations after PostgreSQL becomes healthy", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  expect(compose).toContain("migrate:");
  expect(compose).toContain("condition: service_healthy");
  expect(compose).toContain('"drizzle-kit", "migrate"');
});

/**
 * A deployment pulls; only development builds.
 *
 * The images are published by .github/workflows/images.yml, and the external provisioner's whole
 * contract with this repository is these names: write an .env, `docker compose pull`, `up -d`.
 * A service that lost its image coordinate would silently fall back to building on the customer's
 * one small OCPU, which is the twenty-minute failure this arrangement exists to prevent.
 */
test("every built service names its published image, on one switchable channel", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  for (const service of ["server", "web", "agent-bot"]) {
    expect(compose).toContain(
      `image: ghcr.io/laf-labs/openbot-${service}:\${IMAGE_TAG:-stable}`,
    );
  }
  // The computer keeps its override for a deployment that must pin a different build outright.
  expect(compose).toContain(
    "image: ${COMPUTER_IMAGE:-ghcr.io/laf-labs/openbot-agent-computer:${IMAGE_TAG:-stable}}",
  );
  // The migration one-shot runs the server image, so a pull-mode deployment builds nothing at all.
  expect(
    compose.match(
      /image: ghcr\.io\/laf-labs\/openbot-server:\$\{IMAGE_TAG:-stable\}/g,
    ),
  ).toHaveLength(2);
});
