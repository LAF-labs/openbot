import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { OWN_ADDRESS_VARIABLES } from "../shared/net/own-addresses";

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
 * The key the stored sign-in tokens are sealed under reaches the server on every deployment.
 *
 * NOT behind `AUTH_PROVIDERS` like the sign-in pair above: the server refuses to start without it
 * whether or not a provider is declared (config.ts), so a compose file that passed it only with a
 * provider would be a deployment without sign-in that never comes up.
 */
test("passes LAF_TOKEN_ENCRYPTION_KEY to the server unconditionally", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );
  expect(compose).toContain(
    "LAF_TOKEN_ENCRYPTION_KEY: ${LAF_TOKEN_ENCRYPTION_KEY:-}",
  );
  expect(compose).not.toMatch(/LAF_TOKEN_ENCRYPTION_KEY: \$\{AUTH_PROVIDERS/);
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
  // drizzle-kit behind one read of its ledger (server/scripts/migrate.ts), which still hands every
  // database that is behind, or cannot say, to `drizzle-kit migrate`.
  expect(parsedCompose.services.migrate?.command).toEqual([
    "bun",
    "scripts/migrate.ts",
  ]);
  const script = readFileSync(
    join(import.meta.dir, "..", "server", "scripts", "migrate.ts"),
    "utf8",
  );
  expect(script).toContain(
    '"drizzle-kit", "migrate", "--config=drizzle.config.ts"',
  );
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
  // The migration one-shot, the file converter and the workbench run the server image, so a
  // pull-mode deployment builds nothing at all and pulls nothing new for them.
  expect(
    compose.match(
      /image: ghcr\.io\/laf-labs\/openbot-server:\$\{IMAGE_TAG:-stable\}/g,
    ),
  ).toHaveLength(4);
});

/*
 * The facts below are read from the file as YAML rather than matched as text, because what they
 * assert is structural — which keys a service has — and a text match on `depends_on:` cannot tell
 * whose it is.
 */
const parsedCompose = parseYaml(
  readFileSync(join(import.meta.dir, "..", "docker-compose.yml"), "utf8"),
) as {
  services: Record<
    string,
    {
      depends_on?: unknown;
      mem_limit?: string;
      restart?: string;
      command?: string[];
      shm_size?: string;
      logging?: { driver?: string; options?: Record<string, string> };
      healthcheck?: {
        test?: string[];
        start_period?: string;
        start_interval?: string;
      };
      environment?: Record<string, string>;
    }
  >;
  volumes: Record<string, unknown>;
};

/**
 * The front door depends on nothing.
 *
 * It waited for the API's container to exist, and the API waits for the migration to succeed;
 * compose does not start a service whose dependency failed. Measured 2026-09-10: with the
 * migration table dropped, `up -d` ended in `dependency failed to start` and `web` was never
 * created — 80 and 443 closed, connection refused where the fleet monitor is written to read what
 * the front door answers. Without the dependency the app answers and `/health` is the 503 `down`
 * the documentation promises.
 */
test("starts the front door whatever the migration did", () => {
  expect(parsedCompose.services.web).toBeDefined();
  expect(parsedCompose.services.web?.depends_on).toBeUndefined();
});

/**
 * Every service is bounded twice — its log on disk and its memory — and restarts the same way.
 *
 * A service added without the logging anchor writes until the disk is full; one added without a
 * memory ceiling is the one the OOM killer's arithmetic lands on Postgres for. The browser's
 * ceiling was the only one until 2026-09-10 (audit A5 §12).
 */
test("bounds every service's log and memory, and restarts every long-lived one the same way", () => {
  const services = Object.entries(parsedCompose.services);
  expect(services.length).toBeGreaterThanOrEqual(6);
  for (const [name, service] of services) {
    expect(service.logging?.driver, name).toBe("json-file");
    expect(service.logging?.options?.["max-size"], name).toBe("10m");
    expect(service.logging?.options?.["max-file"], name).toBe("5");
    expect(service.mem_limit, name).toMatch(/^\d+(m|g)$/);
    // The migration is a one-shot; everything else outlives a reboot.
    expect(service.restart, name).toBe(
      name === "migrate" ? "no" : "unless-stopped",
    );
  }
});

/**
 * Postgres is set for the machine it runs on.
 *
 * The image's defaults are for a much smaller box and a spinning disk: 128MB of shared buffers,
 * a planner told random reads cost four times sequential ones. Each value here is documented on
 * the service; the test keeps the list from silently shrinking back to `max_connections`.
 */
test("sets Postgres for a 6GB VM on SSD, and logs the slow statements", () => {
  const command = parsedCompose.services.postgres?.command ?? [];
  const settings = command
    .filter((_, index) => index > 0 && command[index - 1] === "-c")
    .map((entry) => entry.split("=")[0]);
  expect(settings).toEqual([
    "max_connections",
    "shared_buffers",
    "effective_cache_size",
    "work_mem",
    "random_page_cost",
    "log_min_duration_statement",
  ]);
  expect(command).toContain("shared_buffers=256MB");
  expect(command).toContain("random_page_cost=1.1");
  // Parallel workers share memory through /dev/shm, and Docker's default 64MB is where a hash
  // join fails with "could not resize shared memory segment" once work_mem is raised.
  expect(parsedCompose.services.postgres?.shm_size).toBe("256m");
});

/**
 * Every healthcheck goes red on an HTTP error.
 *
 * `bun -e "await fetch(…)"` resolves on a 503 exactly as on a 200 — measured 2026-09-10 (audit A5
 * §9): 503 → exit 0 — so two dials could not go red for anything short of a closed port. `r.ok`
 * and busybox `wget` both fail on a non-2xx; `pg_isready` is Postgres's own word.
 */
test("gives every healthcheck a way to go red", () => {
  for (const [name, service] of Object.entries(parsedCompose.services)) {
    if (!service.healthcheck) continue;
    // A check that is switched OFF has no dial to go red: the workbench has no process in its
    // container but the daemon's and a script's, an image's healthcheck included.
    if ((service.healthcheck as { disable?: boolean }).disable === true) {
      expect(name).toBe("workbench");
      continue;
    }
    const command = service.healthcheck.test?.join(" ") ?? "";
    expect(
      /process\.exit\(r\.ok \? 0 : 1\)|^CMD-SHELL wget |^CMD-SHELL pg_isready /.test(
        command,
      ),
      `${name}: ${command}`,
    ).toBe(true);
  }
});

/**
 * The four long-lived services are checked every second while they start.
 *
 * With only `interval: 10s`, Docker's first check ran ten seconds after the start. The server
 * waited that long for agent-bot and agent-computer, and then ten more before it read as healthy
 * itself. Measured 2026-09-26 on a 1-OCPU VM: 23.3 s from `up` to an answering server, against
 * about 7 s with `start_interval: 1s`. The standing spare's claim, and every upgrade, pays that
 * difference.
 */
test("checks the long-lived services every second while they start", () => {
  for (const name of ["server", "web", "agent-bot", "agent-computer"]) {
    const health = parsedCompose.services[name]?.healthcheck;
    expect(health?.start_interval, name).toBe("1s");
    expect(health?.start_period, name).toBe("60s");
  }
});

/**
 * What the server waits for, and nothing more.
 *
 * A standing spare's claim starts only the server and the front door (`up -d --no-deps`): the
 * database, the migration, agent-bot and agent-computer are already done or running on the spare.
 * `--no-deps` hides any dependency added here from that claim, so a new one must be a decision
 * made with the claim in mind (laf-control core/operations.ts), not a line that slips in.
 */
test("the server depends on exactly the four services a spare has already started", () => {
  expect(
    Object.keys(
      (parsedCompose.services.server?.depends_on ?? {}) as Record<
        string,
        unknown
      >,
    ).sort(),
  ).toEqual(["agent-bot", "agent-computer", "migrate", "postgres"]);
});

/**
 * The spare's lock reaches the front door, and is off unless something sets it.
 *
 * app/Caddyfile answers every path with 503 while LAF_FRONT_LOCKED is "1". Compose passes it with
 * an empty default, so a deployment whose `.env` never names it serves as it always has
 * (tests/caddyfile.test.ts adapts both states).
 */
test("hands the spare's lock to the front door, open by default", () => {
  expect(parsedCompose.services.web?.environment?.LAF_FRONT_LOCKED).toBe(
    "${LAF_FRONT_LOCKED:-}",
  );
});

/**
 * Where an uploaded file is read (security package item 11): the converter, as nobody, with no
 * network, no capability, no new privileges and a read-only root — the Docker-native bubblewrap.
 * The daemon checks the same facts before it listens (`--require-isolation`); this keeps compose
 * from quietly dropping one of them.
 */
test("reads uploaded files as nobody, with no network and nothing to escalate with", () => {
  const converter = parsedCompose.services.converter as Record<string, unknown>;
  expect(converter).toBeDefined();
  expect(converter.user).toBe("65534:65534");
  expect(converter.network_mode).toBe("none");
  expect(converter.read_only).toBe(true);
  expect(converter.cap_drop).toEqual(["ALL"]);
  expect(converter.security_opt).toEqual(["no-new-privileges:true"]);
  expect(converter.ports).toBeUndefined();
  expect((converter.command as string[]).includes("--require-isolation")).toBe(
    true,
  );
  // The socket is the one thing it shares, and only with the server.
  const server = parsedCompose.services.server as Record<string, unknown>;
  expect(server.volumes).toEqual(["converter-socket:/run/laf-converter"]);
  expect(converter.volumes).toEqual(["converter-socket:/run/laf-converter"]);
  expect(
    (server.environment as Record<string, string>).LAF_CONVERTER_SOCKET,
  ).toBe("/run/laf-converter/converter.sock");
});

/**
 * Where a script a Bot wrote will run — and, until a Bot is given the tool, where nothing does.
 *
 * The converter's walls and what a stranger's CODE needs beyond them (the comment over the service
 * in docker-compose.yml has each reason). The daemon reads the same facts before it listens and
 * before every run and has no flag that skips the reading; this keeps compose from quietly
 * dropping one, and holds the two things only compose can say: that no deployment starts the
 * service yet, and that nothing else in the file knows it is there.
 */
test("the workbench is behind a profile, walled, process 1 of a container that keeps nothing, and known to no other service", () => {
  const workbench = parsedCompose.services.workbench as Record<string, unknown>;
  expect(workbench).toBeDefined();
  // NOT STARTED BY `up` OR BY AN UPGRADE: nothing sends it a script yet.
  expect(workbench.profiles).toEqual(["workbench"]);
  expect(workbench.user).toBe("65534:65534");
  expect(workbench.network_mode).toBe("none");
  expect(workbench.read_only).toBe(true);
  expect(workbench.cap_drop).toEqual(["ALL"]);
  expect(workbench.security_opt).toEqual(["no-new-privileges:true"]);
  expect(workbench.ports).toBeUndefined();
  // THE DAEMON IS PROCESS 1. Under an init a script — the daemon's own user — could stop it and
  // outlive its time; process 1 is what its own namespace cannot stop (shared/workbench/sweep.ts).
  expect(workbench.init).toBeUndefined();
  // From source, out of `shared/`, which the server's image and the computer's both carry — and
  // with the socket as its only argument: there is no flag for running outside the walls.
  expect(workbench.command).toEqual([
    "bun",
    "--no-env-file",
    "--no-install",
    "/app/shared/workbench/main.ts",
    "--socket",
    "/run/laf-workbench/workbench.sock",
  ]);
  expect(
    existsSync(join(import.meta.dir, "..", "shared/workbench/main.ts")),
  ).toBe(true);
  // A FUNCTION OF WHAT IT IS SENT: no volume but its socket's. Not the Bot's folder, not a profile.
  expect(workbench.volumes).toEqual(["workbench-socket:/run/laf-workbench"]);
  // Everything a script writes is memory of this container's own, not executable, and few.
  expect(workbench.tmpfs).toEqual([
    "/work:size=96m,nr_inodes=4096,mode=0700,uid=65534,gid=65534,noexec,nosuid,nodev",
    "/dev/shm:size=1m,nr_inodes=64,mode=1777,noexec,nosuid,nodev",
  ]);
  // Its own /dev/shm above, so the engine's — sized by this key, with no bound on names — is not made.
  expect(workbench.shm_size).toBeUndefined();
  expect(parsedCompose.volumes["workbench-socket"]).toEqual({
    driver: "local",
    driver_opts: {
      type: "tmpfs",
      device: "tmpfs",
      o: "size=1m,nr_inodes=64,mode=0700,uid=65534,gid=65534,noexec,nosuid,nodev",
    },
  });
  // EVERY PLACE A SCRIPT CAN WRITE IS HELD THE SAME WAY (the independent read, 2026-10-06: the two
  // small ones were a size and nothing else, so a program ran from them and names were unbounded).
  for (const mount of [
    ...(workbench.tmpfs as string[]),
    (
      parsedCompose.volumes["workbench-socket"] as {
        driver_opts: { o: string };
      }
    ).driver_opts.o,
  ]) {
    for (const held of ["noexec", "nosuid", "nodev", "size=", "nr_inodes="]) {
      expect(mount, mount).toContain(held);
    }
  }
  // No process but the daemon's and a script's: whatever image this is, its healthcheck is off.
  expect(workbench.healthcheck).toEqual({ disable: true });
  // No swap: the daemon bounds a run by what it holds resident, and cannot see what was swapped out.
  expect(workbench.memswap_limit).toBe(workbench.mem_limit);
  expect(workbench.mem_limit).toBe("768m");
  expect(workbench.pids_limit).toBe(128);
  expect(workbench.cpu_shares).toBe(256);
  // The key every answer is proven under comes from the deployment's environment and from nowhere
  // else: not a default, which every deployment would share, and not the command line, which a
  // script can read (shared/workbench/protocol.ts).
  expect(workbench.environment).toEqual({
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    WORKBENCH_KEY: "${WORKBENCH_KEY:-}",
  });
  expect(JSON.stringify(workbench.command)).not.toContain("KEY");
  // Nothing else in the file knows it: no service waits for it, mounts its socket or is told its
  // path. The server is handed the socket in the change that gives a Bot the tool, not before.
  for (const [name, service] of Object.entries(parsedCompose.services)) {
    if (name === "workbench") continue;
    expect(JSON.stringify(service), name).not.toContain("workbench");
  }
});

/**
 * The browser is told the deployment's own addresses in the server's own words.
 *
 * The Bot's browser never opens the app or its sign-in (`shared/net/own-addresses.ts`): the server
 * refuses the address a Bot asks for, and the browser's container refuses every hop after it. Both
 * read the same four variables, and a container handed a different expression than the server's —
 * or none — would refuse a different list, or nothing at all, with no error anywhere.
 */
test("hands the browser the same own addresses the server is told, in the same expressions", () => {
  const server = parsedCompose.services.server?.environment ?? {};
  const browser = parsedCompose.services["agent-computer"]?.environment ?? {};
  for (const name of OWN_ADDRESS_VARIABLES) {
    expect([name, typeof server[name]]).toEqual([name, "string"]);
    expect([name, browser[name]]).toEqual([name, server[name]]);
  }
});
