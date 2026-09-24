import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  answerTo,
  BUNDLE_FILES,
  classifyHealth,
  compareSnapshots,
  composeVariables,
  DOCUMENTATION_PATHS,
  isDocumentationOnly,
  isMoving,
  localOverride,
  MIGRATIONS_TABLE,
  MOVING_COLUMNS,
  migrationFailures,
  mintSecrets,
  outageOf,
  parseOptions,
  parseRestoreTable,
  renderEnv,
  restoreFailures,
  type Snapshot,
  scrubbedEnvironment,
  sessionCookie,
} from "../scripts/upgrade-e2e";

/**
 * `scripts/upgrade-e2e.ts` without Docker.
 *
 * The driver itself runs weekly on a runner (`.github/workflows/upgrade-e2e.yml`) and by hand before a
 * release; what can be held still on every gate is the half that DECIDES — what counts as a row lost,
 * a window of outage, a restore that restored the wrong thing, a `.env` a production server would
 * refuse — and the lists it keeps in step with other files, which drift the day nobody is looking.
 */

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the options", () => {
  test("default to :stable upgraded to a build of this checkout", () => {
    expect(parseOptions([])).toEqual({
      from: "stable",
      to: "local",
      expectRevision: null,
      work: null,
      summary: null,
      healthTimeoutSeconds: 300,
      keep: false,
      noBuild: false,
    });
    expect(parseOptions(["--no-build"]).noBuild).toBe(true);
  });

  test("take what CI passes", () => {
    const options = parseOptions([
      "--from",
      "v0.4.5",
      "--to",
      "edge",
      "--expect-revision",
      "e71d09e",
      "--health-timeout",
      "240",
      "--keep",
    ]);
    expect(options.from).toBe("v0.4.5");
    expect(options.to).toBe("edge");
    expect(options.expectRevision).toBe("e71d09e");
    expect(options.healthTimeoutSeconds).toBe(240);
    expect(options.keep).toBe(true);
  });

  test("refuse what would reach a command line as something other than a tag", () => {
    expect(() => parseOptions(["--to", "edge; rm -rf /"])).toThrow(
      "is not a tag",
    );
    expect(() => parseOptions(["--from", "-x"])).toThrow();
    expect(() => parseOptions(["--to"])).toThrow("needs a value");
    expect(() => parseOptions(["--frm", "stable"])).toThrow("Unknown option");
    expect(() => parseOptions(["--from", "edge", "--to", "edge"])).toThrow(
      "not an upgrade",
    );
    expect(() => parseOptions(["--expect-revision", "HEAD"])).toThrow(
      "commit id",
    );
    // A local build is this checkout by definition; there is nothing to hold it to.
    expect(() => parseOptions(["--expect-revision", "e71d09e"])).toThrow(
      "registry --to tag",
    );
    // A registry tag is pulled, never built, so there is no build to skip.
    expect(() => parseOptions(["--to", "edge", "--no-build"])).toThrow(
      "never built",
    );
  });
});

describe("the deployment's .env", () => {
  const secrets = mintSecrets();
  const env = renderEnv({
    imageTag: "stable",
    ownerEmail: "sajang@upgrade-e2e.test",
    modelBaseUrl: "http://host.docker.internal:40123/v1",
    model: "upgrade-e2e/fake-model",
    ports: { postgres: 40001, bot: 40002, computer: 40003 },
    secrets,
  });
  const values = Object.fromEntries(
    env
      .split("\n")
      .filter((line) => /^[A-Z]/.test(line))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

  test("carries keys in exactly the shapes the server accepts, and none of the public examples", () => {
    // server/src/config.ts: base64 of 32 bytes that round-trips, 64 hex, at least 32 characters.
    const vault = Buffer.from(values.KEY_ENCRYPTION_KEY, "base64");
    expect(vault.byteLength).toBe(32);
    expect(vault.toString("base64")).toBe(values.KEY_ENCRYPTION_KEY);
    expect(values.LAF_TOKEN_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(values.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);

    const example = read(".env.example");
    for (const name of ["KEY_ENCRYPTION_KEY", "LAF_TOKEN_ENCRYPTION_KEY"]) {
      const published = example.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
      expect(published).toBeDefined();
      expect(values[name]).not.toBe(published);
    }
    // Two runs never share a secret.
    expect(mintSecrets().keyEncryptionKey).not.toBe(secrets.keyEncryptionKey);
  });

  test("is a production .env: no development sign-in, a declared provider with its pair", () => {
    expect(env).not.toContain("LAF_DEV_NO_AUTH");
    expect(env).not.toContain("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS");
    expect(values.AUTH_PROVIDERS).toBe("google");
    expect(values.GOOGLE_OAUTH_CLIENT_ID).toBeTruthy();
    expect(values.GOOGLE_OAUTH_CLIENT_SECRET).toBeTruthy();
    expect(values.SIGN_IN_ALLOWED_EMAILS).toBe("sajang@upgrade-e2e.test");
  });

  test("sets nothing the current compose file does not read", () => {
    // A line here that compose never passes would be configuration the upgraded deployment ignores,
    // and a check that passes because of it would be measuring nothing.
    const reads = composeVariables(read("docker-compose.yml"));
    for (const name of Object.keys(values)) {
      expect({ name, read: reads.has(name) }).toEqual({ name, read: true });
    }
  });

  test("composeVariables finds every ${NAME, defaulted or not", () => {
    expect([
      ...composeVariables(
        "a: ${A}\nb: ${B_2:-x}\nc: ${C:+${D}}\nimage: x:${IMAGE_TAG:-stable}",
      ),
    ]).toEqual(["A", "B_2", "C", "D", "IMAGE_TAG"]);
  });
});

describe("what a docker call is handed", () => {
  test("is what docker needs, and never the shell's model key or channel", () => {
    const env = scrubbedEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        DOCKER_HOST: "unix:///var/run/docker.sock",
        OPENAI_API_KEY: "sk-real",
        IMAGE_TAG: "edge",
        COMPOSE_FILE: "elsewhere.yml",
        COMPOSE_PROJECT_NAME: "openbot",
      },
      { IMAGE_TAG: "e2e-abc" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      IMAGE_TAG: "e2e-abc",
    });
  });
});

describe("the lists kept in step with other files", () => {
  test("the bundle is what deploy/Dockerfile copies", () => {
    const sources = [
      ...read("deploy/Dockerfile").matchAll(/^COPY\s+(?:--\S+\s+)*(.+)$/gm),
    ]
      .flatMap((match) => (match[1] as string).trim().split(/\s+/).slice(0, -1))
      .filter((source) => !source.startsWith("<<"));
    const bundle: string[] = [...BUNDLE_FILES];
    expect(bundle.sort()).toEqual(sources.sort());
  });

  test("documentation is what images.yml does not rebuild for", () => {
    const workflow = parse(read(".github/workflows/images.yml")) as {
      on: { push: { "paths-ignore": string[] } };
    };
    const documentation: string[] = [...DOCUMENTATION_PATHS];
    expect(documentation).toEqual(workflow.on.push["paths-ignore"]);
  });

  test("documentation only means only documentation, in the workflow's glob spelling", () => {
    expect(
      isDocumentationOnly([
        "docs/laf/redesign-2026-09.md",
        "README.md",
        "app/README.md",
      ]),
    ).toBe(true);
    expect(isDocumentationOnly(["docs/laf/x.md", "server/src/app.ts"])).toBe(
      false,
    );
    // Bundled into the web image, so NOT documentation: images.yml learned that the hard way.
    expect(isDocumentationOnly(["app/src/help/guide.md"])).toBe(false);
    expect(isDocumentationOnly([])).toBe(true);
  });
});

describe("comparing the database before and after", () => {
  const table = (
    name: string,
    columns: string[],
    primaryKey: string[],
    rows: Record<string, unknown>[],
  ) => ({ name, columns, primaryKey, rows });

  const before: Snapshot = {
    "public.users": table(
      "public.users",
      ["id", "email", "updated_at"],
      ["id"],
      [
        { id: "u1", email: "a@x", updated_at: "2026-09-14T00:00:00Z" },
        { id: "u2", email: "b@x", updated_at: "2026-09-14T00:00:00Z" },
      ],
    ),
    "public.channels": table(
      "public.channels",
      ["id", "name", "last_message"],
      ["id"],
      [{ id: "c1", name: "방", last_message: "안녕" }],
    ),
    "public.audit_events": table(
      "public.audit_events",
      ["id", "event_type"],
      ["id"],
      [{ id: "e1", event_type: "agent.created" }],
    ),
    "public.channel_agents": table(
      "public.channel_agents",
      ["channel_id", "agent_id"],
      [],
      [{ channel_id: "c1", agent_id: "a1" }],
    ),
  };

  const clone = (snapshot: Snapshot): Snapshot =>
    JSON.parse(JSON.stringify(snapshot)) as Snapshot;

  test("an upgrade that kept everything passes, whatever it added around it", () => {
    const after = clone(before);
    // A moving column moved, a migration dropped one column and added another, the boot wrote to
    // the trail, and a new table appeared.
    (after["public.users"] as Snapshot[string]).rows[0] = {
      id: "u1",
      email: "a@x",
      updated_at: "2026-09-14T01:00:00Z",
    };
    after["public.channels"] = table(
      "public.channels",
      ["id", "name"],
      ["id"],
      [{ id: "c1", name: "방" }],
    );
    (after["public.users"] as Snapshot[string]).columns.push("consented_at");
    (after["public.audit_events"] as Snapshot[string]).rows.push(
      { id: "e2", event_type: "boot" },
      { id: "e3", event_type: "boot" },
    );
    after["public.laf_feedback"] = table(
      "public.laf_feedback",
      ["id"],
      ["id"],
      [],
    );

    const result = compareSnapshots(before, after);
    expect(result.failures).toEqual([]);
    const byName = Object.fromEntries(result.tables.map((t) => [t.name, t]));
    expect(byName["public.users"]?.moved).toEqual({ updated_at: 1 });
    expect(byName["public.users"]?.newColumns).toEqual(["consented_at"]);
    expect(byName["public.users"]?.hashAfter).toBe(
      byName["public.users"]?.hashBefore as string,
    );
    expect(byName["public.channels"]?.droppedColumns).toEqual(["last_message"]);
    expect(byName["public.audit_events"]?.added).toBe(2);
    expect(byName["public.audit_events"]?.addedKinds).toEqual({ boot: 2 });
    expect(result.newTables).toEqual([
      { name: "public.laf_feedback", rows: 0 },
    ]);
  });

  test("the columns allowed to move are the product's own clocks and the image's package, nothing a person wrote", () => {
    expect(isMoving("public.users", "updated_at")).toBe(true);
    expect(isMoving("public.sessions", "expires_at")).toBe(true);
    expect(isMoving("public.deployment_packages", "loaded_at")).toBe(true);
    expect(isMoving("public.users", "email")).toBe(false);
    expect(isMoving("public.laf_thread_messages", "message")).toBe(false);
    // A session's expiry moves; a routine's or an allowance's does not.
    expect(isMoving("public.computer_standing_approvals", "expires_at")).toBe(
      false,
    );
    for (const reason of Object.values(MOVING_COLUMNS)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  test("a row that is gone fails, by name and by count", () => {
    const after = clone(before);
    (after["public.users"] as Snapshot[string]).rows.pop();
    const result = compareSnapshots(before, after);
    expect(result.failures).toEqual([
      "public.users: 1 of 2 rows that existed before the upgrade are gone.",
    ]);
  });

  test("a value that changed fails, even when the row count did not", () => {
    const after = clone(before);
    (
      (after["public.users"] as Snapshot[string]).rows[1] as {
        email: string;
      }
    ).email = "c@x";
    const result = compareSnapshots(before, after);
    expect(result.failures).toEqual([
      "public.users.email: 1 row(s) that existed before now hold something else.",
    ]);
    const users = result.tables.find((t) => t.name === "public.users");
    expect(users?.hashAfter).not.toBe(users?.hashBefore as string);
  });

  test("a table with no primary key is matched by the whole row, so a changed row reads as lost", () => {
    const after = clone(before);
    (after["public.channel_agents"] as Snapshot[string]).rows = [
      { channel_id: "c1", agent_id: "a2" },
    ];
    const result = compareSnapshots(before, after);
    expect(result.failures).toEqual([
      "public.channel_agents: 1 of 1 rows that existed before the upgrade are gone.",
    ]);
  });

  test("a table that is gone fails", () => {
    const after = clone(before);
    delete after["public.channels"];
    expect(compareSnapshots(before, after).failures).toEqual([
      "public.channels: the table is gone (1 rows).",
    ]);
  });

  test("migrations: one row per journal entry, none twice", () => {
    const migrations = (hashes: string[]) =>
      ({
        [MIGRATIONS_TABLE]: table(
          MIGRATIONS_TABLE,
          ["id", "hash", "created_at"],
          ["id"],
          hashes.map((hash, index) => ({ id: index + 1, hash, created_at: 1 })),
        ),
      }) as Snapshot;
    const was = migrations(["a", "b"]);
    expect(migrationFailures(was, migrations(["a", "b", "c"]), 3)).toEqual([]);
    expect(migrationFailures(was, migrations(["a", "b", "c"]), 4)[0]).toContain(
      "the new image's journal has 4 entries",
    );
    expect(migrationFailures(was, migrations(["a", "b", "b"]), 3)[0]).toContain(
      "applied more than once",
    );
  });
});

describe("scripts/restore.sh's table", () => {
  test("the parser reads the format restore.sh prints", () => {
    // Held to the script's own printf, so a change of format there fails here rather than turning
    // every weekly run into "printed no row-count table".
    const script = read("scripts/restore.sh");
    expect(script).toContain(
      'printf "   %-46s %10s %10s  %s\\n", $1, $2, $3, mark',
    );
    expect(script).toContain(
      '"\\n   %d tables · %d equal · %d differ · restore took %ss\\n"',
    );
  });

  const output = [
    "== Row counts: openbot (live) against openbot_restore (restored)",
    `   ${"table".padEnd(46)} ${"live".padStart(10)} ${"restored".padStart(10)}`,
    `   ${"drizzle.__drizzle_migrations".padEnd(46)} ${"39".padStart(10)} ${"34".padStart(10)}  DIFF (-5)`,
    `   ${"public.laf_feedback".padEnd(46)} ${"0".padStart(10)} ${"-".padStart(10)}  DIFF (live only)`,
    `   ${"public.users".padEnd(46)} ${"1".padStart(10)} ${"1".padStart(10)}  =`,
    "",
    "   3 tables · 1 equal · 2 differ · restore took 1s",
  ].join("\n");

  test("is read back line by line", () => {
    const parsed = parseRestoreTable(output);
    expect(parsed.summary).toBe(
      "3 tables · 1 equal · 2 differ · restore took 1s",
    );
    expect(parsed.lines).toEqual([
      { table: "drizzle.__drizzle_migrations", live: 39, restored: 34 },
      { table: "public.laf_feedback", live: 0, restored: null },
      { table: "public.users", live: 1, restored: 1 },
    ]);
  });

  const photograph = (counts: Record<string, number>): Snapshot =>
    Object.fromEntries(
      Object.entries(counts).map(([name, rows]) => [
        name,
        {
          name,
          columns: ["id"],
          primaryKey: ["id"],
          rows: Array.from({ length: rows }, (_, id) => ({ id })),
        },
      ]),
    );

  test("the restored side must hold what the database held just before the upgrade", () => {
    const parsed = parseRestoreTable(output);
    expect(
      restoreFailures(
        parsed,
        photograph({ "drizzle.__drizzle_migrations": 34, "public.users": 1 }),
      ),
    ).toEqual([]);
    expect(
      restoreFailures(
        parsed,
        photograph({ "drizzle.__drizzle_migrations": 34, "public.users": 2 }),
      ),
    ).toEqual([
      "public.users: the restored dump holds 1 rows; the database held 2 just before the upgrade.",
    ]);
    expect(restoreFailures(parsed, photograph({ "public.agents": 2 }))).toEqual(
      ["public.agents: not in the restored dump."],
    );
    expect(
      restoreFailures({ lines: [], summary: null }, photograph({})),
    ).toEqual(["scripts/restore.sh printed no row-count table."]);
  });
});

describe("outage, as seen from outside", () => {
  test("is the time from the first failed probe to the next one that answered", () => {
    const outage = outageOf([
      { at: 0, ok: true, status: 200 },
      { at: 250, ok: false, status: null },
      { at: 500, ok: false, status: 502 },
      { at: 750, ok: true, status: 200 },
      { at: 1000, ok: false, status: 503 },
      { at: 1500, ok: true, status: 200 },
    ]);
    expect(outage.windows).toEqual([
      { from: 250, to: 750 },
      { from: 1000, to: 1500 },
    ]);
    expect(outage.totalMs).toBe(1000);
    expect(outage.longestMs).toBe(500);
    expect(outage.failed).toBe(3);
    expect(outage.probes).toBe(6);
  });

  test("an answer that cannot say neither opens a window nor closes one", () => {
    const outage = outageOf([
      { at: 0, ok: null, status: 200 },
      { at: 250, ok: false, status: null },
      { at: 500, ok: null, status: 200 },
      { at: 750, ok: true, status: 200 },
    ]);
    expect(outage.windows).toEqual([{ from: 250, to: 750 }]);
  });

  test("a window that never closes runs to the last probe", () => {
    const outage = outageOf([
      { at: 0, ok: true, status: 200 },
      { at: 250, ok: false, status: 503 },
      { at: 900, ok: false, status: 503 },
    ]);
    expect(outage.windows).toEqual([{ from: 250, to: null }]);
    expect(outage.totalMs).toBe(650);
  });

  test("/health is ok only as JSON saying so; the app served at /health is neither", () => {
    expect(
      classifyHealth(200, "application/json", '{"status":"ok","checks":{}}'),
    ).toBe(true);
    expect(
      classifyHealth(200, "text/html; charset=utf-8", "<!doctype html>"),
    ).toBe(null);
    expect(
      classifyHealth(503, "application/json", '{"status":"degraded"}'),
    ).toBe(false);
    expect(
      classifyHealth(200, "application/json", '{"status":"degraded"}'),
    ).toBe(false);
    expect(classifyHealth(502, "", "")).toBe(false);
  });
});

describe("a local run's images", () => {
  test("are found where they were built rather than pulled from a registry that never had them", () => {
    const override = parse(localOverride(["migrate", "server", "web"])) as {
      services: Record<string, { pull_policy: string }>;
    };
    expect(override.services).toEqual({
      migrate: { pull_policy: "missing" },
      server: { pull_policy: "missing" },
      web: { pull_policy: "missing" },
    });
  });
});

describe("the fake model", () => {
  const offered = [
    { type: "function", function: { name: "computer_navigate" } },
  ];

  test("answers in prose, and a one-question JSON call with a refusal", () => {
    const routine = answerTo(
      {
        stream: true,
        tools: [offered[0]],
        messages: [{ role: "user" }],
      },
      "P",
    );
    expect(routine).toEqual({
      kind: "stream",
      choices: [
        { delta: { content: "P" } },
        { delta: {}, finish_reason: "stop" },
      ],
    });
    expect(answerTo({ stream: false }, "P")).toEqual({
      kind: "status",
      status: 503,
    });
  });
});

describe("the seeded session", () => {
  test("is presented the way better-call signs a cookie", async () => {
    const secret = "a-long-enough-local-development-auth-secret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("tok")),
    ).toString("base64");
    expect(signature).toHaveLength(44);
    expect(sessionCookie(secret, "tok")).toBe(
      `better-auth.session_token=${encodeURIComponent(`tok.${signature}`)}`,
    );
  });
});

describe(".github/workflows/upgrade-e2e.yml", () => {
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
  const workflow = parse(read(".github/workflows/upgrade-e2e.yml")) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { "cancel-in-progress": boolean };
    jobs: Record<
      string,
      {
        permissions: Record<string, string>;
        "timeout-minutes": number;
        steps: Step[];
      }
    >;
  };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

  test("runs weekly and by hand, and on nothing a push can start", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
  });

  test("holds nothing at the top, reads only what it pulls, and gives way to a newer run", () => {
    expect(workflow.permissions).toEqual({});
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toEqual({ contents: "read", packages: "read" });
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
    }
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  });

  test("pins every action by commit and keeps no credential in the checkout", () => {
    const actions = steps.filter((step) => step.uses);
    expect(actions.length).toBeGreaterThan(0);
    for (const step of actions) {
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    const checkout = actions.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  test("runs the driver and nothing that stands in for it", () => {
    const script = steps.map((step) => step.run ?? "").join("\n");
    expect(script).toContain("bun scripts/upgrade-e2e.ts");
    expect(script).not.toContain("docker compose");
  });
});
