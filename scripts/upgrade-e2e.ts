/**
 * THE UPGRADE A CUSTOMER'S VM TAKES, END TO END, ON ONE MACHINE.
 *
 * An upgrade from the channel customers run (`:stable`) to the build about to replace it had been
 * measured by hand exactly once — the rehearsal VM, 68–136 s, data intact — and nothing proved it
 * again before a release. `tests/upgrade-script.test.ts` drills `scripts/upgrade.sh` against a fake
 * `docker`, which proves the script's order and its words and nothing about what two real sets of
 * images do to a real database. This does the real thing:
 *
 *  1. Stands a deployment up from the FROM tag's deploy bundle the way a VM is stood up:
 *     `docker create` / `docker cp` the bundle, write a `.env` with this run's own secrets,
 *     `docker compose pull`, `docker compose up -d`, wait for the honest /health.
 *  2. Seeds it through the front door as a signed-in person — their one Bot, a routine that has run
 *     against a fake model and delivered into the Bot's conversation, the Bot's browser opened once,
 *     a site connection, and the trail all of that leaves — then photographs every table. (It
 *     seeded two Bots and a room until 2026-09-24, when a person came to have one Bot and rooms were
 *     removed; a FROM build that still had them would accept either, a TO build refuses both.)
 *  3. Re-extracts the TO tag's bundle over the directory, as `laf upgrade` does, sets the TO tag in
 *     `.env` — the one place a version is chosen — and runs `scripts/upgrade.sh` as written, while
 *     `/`, `/health` and `/api/capabilities` are asked every 0.25 s from outside.
 *  4. Asserts: every row that existed is still there with the same content, the migrations were
 *     applied once, /health is ok, the person is still signed in, the API is the new build, one
 *     turn answers through the fake model, the Bot's browser answers and opens the profile the old
 *     one wrote, and the dump the upgrade took restores beside the live database with the counts the
 *     photograph recorded.
 *  5. Takes away every container, volume, network and image it made.
 *
 *   bun scripts/upgrade-e2e.ts                                  # stable → images built from this checkout
 *   bun scripts/upgrade-e2e.ts --to edge --expect-revision "$(git rev-parse HEAD)"   # what CI runs
 *   bun scripts/upgrade-e2e.ts --keep                           # leave the deployment up to look at
 *
 * Options:
 *   --from <tag>             the channel or version a deployment runs today (default: stable)
 *   --to <tag|local>         what it is upgraded to; `local` (the default) builds the five images
 *                            from this checkout, tagged `e2e-<commit>`, and never pushes them
 *   --expect-revision <sha>  with a registry TO tag: the commit its images must have been built from.
 *                            A different commit is accepted only when everything between the two is
 *                            documentation, which is exactly what images.yml does not rebuild for
 *   --work <dir>             where the deployment directory, the dump and the logs go (default: a
 *                            fresh temporary directory)
 *   --summary <file>         also append the result as Markdown (CI: $GITHUB_STEP_SUMMARY)
 *   --health-timeout <s>     HEALTH_TIMEOUT for upgrade.sh (default 300)
 *   --keep                   do not take anything away afterwards
 *   --no-build               with `--to local`: use the `e2e-<commit>` images an earlier build left on
 *                            this machine (each must carry this commit's revision label)
 *
 * Needs Docker with compose, git, and ports 80 and 443 free: the compose file publishes the front
 * door on both and nothing else can be measured "from outside".
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Glob } from "bun";
import {
  type Behaviour,
  says,
  startFakeProvider,
} from "../agent-bot/tests/fake-provider";

const repositoryRoot = resolve(import.meta.dir, "..");

export const REGISTRY = "ghcr.io/laf-labs";

/** The five images one IMAGE_TAG names, and the Dockerfile each is built from (images.yml). */
export const IMAGES = {
  server: "server/Dockerfile",
  web: "app/Dockerfile",
  "agent-bot": "agent-bot/Dockerfile",
  "agent-computer": "agent-computer/Dockerfile",
  deploy: "deploy/Dockerfile",
} as const;

export const imageRef = (image: keyof typeof IMAGES, tag: string) =>
  `${REGISTRY}/openbot-${image}:${tag}`;

/**
 * What `deploy/Dockerfile` copies into the bundle, as paths in this repository.
 *
 * Used for one thing: rebuilding the directory a VM holds when the FROM tag has no bundle image —
 * `openbot-deploy` was first published 2026-09-10, after the release `:stable` still names. Kept
 * beside the Dockerfile's own list by `tests/upgrade-e2e.test.ts`, so a file added to the bundle is
 * a file added here.
 */
export const BUNDLE_FILES = [
  "docker-compose.yml",
  ".env.example",
  "agent-computer/seccomp_profile.json",
  "scripts/upgrade.sh",
  "scripts/restore.sh",
  "scripts/laf-browser-firewall.sh",
  /*
   * The legal pages, which are RENDERED before the build (`app/scripts/render-legal.ts`) and are in
   * no commit — so a rebuild from git finds nothing here, which is right: no revision old enough to
   * have no bundle image had them. Listed because the Dockerfile copies it, and the local build below
   * renders it first.
   */
  "deploy/legal/",
] as const;

/**
 * The documentation `images.yml` does not rebuild for, in its own `paths-ignore` spelling. A commit
 * that changed only these has no `:edge` of its own, and the build before it IS its build.
 * `tests/upgrade-e2e.test.ts` holds this list to the workflow's.
 */
export const DOCUMENTATION_PATHS = [
  "docs/**",
  "*.md",
  "**/README.md",
  ".github/pull_request_template.md",
] as const;

export function isDocumentationOnly(paths: readonly string[]): boolean {
  const globs = DOCUMENTATION_PATHS.map((pattern) => new Glob(pattern));
  return paths.every((path) => globs.some((glob) => glob.match(path)));
}

// --- options -------------------------------------------------------------------------------------

export type Options = {
  from: string;
  /** A tag, or `local`: build the five images from this checkout. */
  to: string;
  expectRevision: string | null;
  work: string | null;
  summary: string | null;
  healthTimeoutSeconds: number;
  keep: boolean;
  /** With `--to local`: use the `e2e-<commit>` images already on this machine instead of building. */
  noBuild: boolean;
};

/** Docker's own grammar for a tag. Every tag here reaches a command line and a file name. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    from: "stable",
    to: "local",
    expectRevision: null,
    work: null,
    summary: null,
    healthTimeoutSeconds: 300,
    keep: false,
    noBuild: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (flag === "--keep" || flag === "--no-build") {
      if (flag === "--keep") options.keep = true;
      else options.noBuild = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(
        flag.startsWith("--")
          ? `${flag} needs a value.`
          : `Unexpected argument: ${flag}`,
      );
    }
    index += 1;
    switch (flag) {
      case "--from":
        options.from = value;
        break;
      case "--to":
        options.to = value;
        break;
      case "--expect-revision":
        options.expectRevision = value;
        break;
      case "--work":
        options.work = resolve(value);
        break;
      case "--summary":
        options.summary = resolve(value);
        break;
      case "--health-timeout":
        options.healthTimeoutSeconds = Number(value);
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  for (const [name, tag] of [
    ["--from", options.from],
    ["--to", options.to],
  ] as const) {
    if (!TAG.test(tag)) throw new Error(`${name} '${tag}' is not a tag.`);
  }
  if (options.from === options.to) {
    throw new Error(
      `--from and --to are both '${options.from}': that is not an upgrade.`,
    );
  }
  if (
    options.expectRevision !== null &&
    !/^[0-9a-f]{7,40}$/.test(options.expectRevision)
  ) {
    throw new Error("--expect-revision is a commit id.");
  }
  if (options.expectRevision !== null && options.to === "local") {
    throw new Error(
      "--expect-revision is for a registry --to tag; a local build is this checkout by definition.",
    );
  }
  if (options.noBuild && options.to !== "local") {
    throw new Error(
      "--no-build is for --to local; a registry tag is pulled, never built.",
    );
  }
  if (
    !Number.isInteger(options.healthTimeoutSeconds) ||
    options.healthTimeoutSeconds < 1
  ) {
    throw new Error("--health-timeout is a whole number of seconds.");
  }
  return options;
}

// --- the deployment's .env -----------------------------------------------------------------------

export type Secrets = {
  keyEncryptionKey: string;
  tokenEncryptionKey: string;
  betterAuthSecret: string;
  computerToken: string;
  postgresPassword: string;
  googleClientSecret: string;
};

/** Minted per run, in exactly the shapes `server/src/config.ts` refuses everything else in. */
export function mintSecrets(random: (size: number) => Buffer = randomBytes) {
  return {
    keyEncryptionKey: random(32).toString("base64"),
    tokenEncryptionKey: random(32).toString("hex"),
    betterAuthSecret: random(32).toString("base64"),
    computerToken: random(24).toString("hex"),
    postgresPassword: random(18).toString("hex"),
    googleClientSecret: random(18).toString("hex"),
  } satisfies Secrets;
}

export type EnvInput = {
  imageTag: string;
  ownerEmail: string;
  modelBaseUrl: string;
  model: string;
  ports: { postgres: number; bot: number; computer: number };
  secrets: Secrets;
};

/**
 * The `.env` of a deployment nobody will ever sign into by OAuth.
 *
 * Production in every way the server checks: no `LAF_DEV_NO_AUTH` (compose sets NODE_ENV=production,
 * which refuses it), real-shaped keys, a declared provider with a pair behind it. The provider is
 * never dialled — the person is signed in by a session row, the way the integration tests stand one
 * up — and the model is the fake this process serves. The three loopback ports are chosen free per
 * run, because a developer's own stack already holds the defaults.
 */
export function renderEnv(input: EnvInput): string {
  return [
    "# Made by scripts/upgrade-e2e.ts for one run and taken away after it. Every secret here was",
    "# minted for that run and opens nothing outside it.",
    `IMAGE_TAG=${input.imageTag}`,
    "PUBLIC_ORIGIN=http://localhost",
    `POSTGRES_PASSWORD=${input.secrets.postgresPassword}`,
    `POSTGRES_PORT=${input.ports.postgres}`,
    `BOT_PORT=${input.ports.bot}`,
    `COMPUTER_PORT=${input.ports.computer}`,
    `KEY_ENCRYPTION_KEY=${input.secrets.keyEncryptionKey}`,
    `LAF_TOKEN_ENCRYPTION_KEY=${input.secrets.tokenEncryptionKey}`,
    `BETTER_AUTH_SECRET=${input.secrets.betterAuthSecret}`,
    `COMPUTER_TOKEN=${input.secrets.computerToken}`,
    "AUTH_PROVIDERS=google",
    "GOOGLE_OAUTH_CLIENT_ID=upgrade-e2e.apps.googleusercontent.com",
    `GOOGLE_OAUTH_CLIENT_SECRET=${input.secrets.googleClientSecret}`,
    `INITIAL_ADMIN_EMAILS=${input.ownerEmail}`,
    `SIGN_IN_ALLOWED_EMAILS=${input.ownerEmail}`,
    "OPENAI_API_KEY=upgrade-e2e-fake-key",
    `OPENAI_BASE_URL=${input.modelBaseUrl}`,
    `BOT_MODEL=${input.model}`,
    "BOT_MODEL_EFFORT=false",
    "",
  ].join("\n");
}

/** Every `${NAME` a compose file reads. */
export function composeVariables(compose: string): Set<string> {
  return new Set(
    [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(
      (match) => match[1] as string,
    ),
  );
}

// --- what the database holds ---------------------------------------------------------------------

export type Row = Record<string, unknown>;
export type Table = {
  name: string;
  columns: string[];
  primaryKey: string[];
  rows: Row[];
};
export type Snapshot = Record<string, Table>;

/**
 * Columns the running product rewrites by itself, each with the reason it may move while a
 * deployment is upgraded. A change anywhere else in a row that existed before is a failure.
 *
 * `*` matches every table. Kept short on purpose: an entry here is a column this test has stopped
 * watching, so each one names what moves it.
 */
export const MOVING_COLUMNS: Record<string, string> = {
  "*.updated_at":
    "a row's own clock: better-auth touches the session and the user it reads",
  "public.sessions.expires_at":
    "better-auth extends a session each time it is used, and the new build uses it",
  // recordTenantPackage (server/src/tenant-package.ts) upserts this row on every boot. The package is
  // the image's, not anybody's data: measured on the first full run, stable → edge moved `loaded_at`
  // and nothing else here; a release that changes the package moves the other two with it.
  "public.deployment_packages.loaded_at":
    "re-stamped by recordTenantPackage every time a server boots",
  "public.deployment_packages.checksum":
    "the tenant package inside the new image, re-recorded at boot",
  "public.deployment_packages.source_path":
    "the tenant package inside the new image, re-recorded at boot",
};

export function isMoving(table: string, column: string): boolean {
  const bare = table.split(".").at(-1) ?? table;
  return (
    `*.${column}` in MOVING_COLUMNS ||
    `${table}.${column}` in MOVING_COLUMNS ||
    `public.${bare}.${column}` in MOVING_COLUMNS
  );
}

const canonical = (row: Row, columns: readonly string[]) =>
  JSON.stringify(columns.map((column) => [column, row[column] ?? null]));

const sha = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

const hashRows = (rows: readonly Row[], columns: readonly string[]) =>
  sha(
    rows
      .map((row) => canonical(row, columns))
      .sort()
      .join("\n"),
  );

export type TableVerdict = {
  name: string;
  before: number;
  /** Null when the table is gone. */
  after: number | null;
  lost: number;
  /** Column → how many rows that existed before now hold something else there. */
  changed: Record<string, number>;
  /** The same, for the columns in {@link MOVING_COLUMNS}. Reported, never a failure. */
  moved: Record<string, number>;
  added: number;
  /** When the table has an `event_type`: what the added rows were. */
  addedKinds: Record<string, number>;
  droppedColumns: string[];
  newColumns: string[];
  /** Over the rows that existed before and the columns both sides have, moving ones excluded. */
  hashBefore: string;
  hashAfter: string;
};

/**
 * Every row that existed before, found again after, compared column by column.
 *
 * Rows are matched by primary key; a table without one is matched by the whole row, so a change
 * there reads as a row lost. Only columns present on BOTH sides are compared — a migration that
 * adds a column (0036's consent stamps) or moves one away (0038's roster preview) changes the shape
 * of a row, not what it says. Rows that appear during the upgrade are counted and never a failure:
 * a booting server writes to its trail.
 */
export function compareSnapshots(
  before: Snapshot,
  after: Snapshot,
): {
  tables: TableVerdict[];
  newTables: { name: string; rows: number }[];
  failures: string[];
} {
  const tables: TableVerdict[] = [];
  const failures: string[] = [];

  for (const name of Object.keys(before).sort()) {
    const was = before[name] as Table;
    const now = after[name];
    if (!now) {
      failures.push(`${name}: the table is gone (${was.rows.length} rows).`);
      tables.push({
        name,
        before: was.rows.length,
        after: null,
        lost: was.rows.length,
        changed: {},
        moved: {},
        added: 0,
        addedKinds: {},
        droppedColumns: was.columns,
        newColumns: [],
        hashBefore: hashRows(was.rows, was.columns),
        hashAfter: "-",
      });
      continue;
    }

    const shared = was.columns.filter((column) => now.columns.includes(column));
    const compared = shared.filter((column) => !isMoving(name, column));
    const byKey =
      was.primaryKey.length > 0 &&
      was.primaryKey.every((column) => shared.includes(column));
    const keyOf = (row: Row) =>
      byKey
        ? canonical(row, was.primaryKey)
        : canonical(
            row,
            shared.filter((column) => !isMoving(name, column)),
          );

    const remaining = new Map<string, Row[]>();
    for (const row of now.rows) {
      const key = keyOf(row);
      remaining.set(key, [...(remaining.get(key) ?? []), row]);
    }

    let lost = 0;
    const changed: Record<string, number> = {};
    const moved: Record<string, number> = {};
    const matched: Row[] = [];
    for (const row of was.rows) {
      const candidates = remaining.get(keyOf(row));
      const match = candidates?.shift();
      if (!match) {
        lost += 1;
        continue;
      }
      matched.push(match);
      for (const column of shared) {
        if (JSON.stringify(row[column]) === JSON.stringify(match[column]))
          continue;
        const tally = isMoving(name, column) ? moved : changed;
        tally[column] = (tally[column] ?? 0) + 1;
      }
    }

    const addedRows = [...remaining.values()].flat();
    const addedKinds: Record<string, number> = {};
    if (now.columns.includes("event_type")) {
      for (const row of addedRows) {
        const kind = String(row.event_type);
        addedKinds[kind] = (addedKinds[kind] ?? 0) + 1;
      }
    }

    if (lost > 0) {
      failures.push(
        `${name}: ${lost} of ${was.rows.length} rows that existed before the upgrade are gone.`,
      );
    }
    for (const [column, count] of Object.entries(changed)) {
      failures.push(
        `${name}.${column}: ${count} row(s) that existed before now hold something else.`,
      );
    }

    tables.push({
      name,
      before: was.rows.length,
      after: now.rows.length,
      lost,
      changed,
      moved,
      added: addedRows.length,
      addedKinds,
      droppedColumns: was.columns.filter(
        (column) => !now.columns.includes(column),
      ),
      newColumns: now.columns.filter((column) => !was.columns.includes(column)),
      hashBefore: hashRows(was.rows, compared),
      hashAfter: hashRows(matched, compared),
    });
  }

  const newTables = Object.keys(after)
    .filter((name) => !(name in before))
    .sort()
    .map((name) => ({ name, rows: (after[name] as Table).rows.length }));
  return { tables, newTables, failures };
}

export const MIGRATIONS_TABLE = "drizzle.__drizzle_migrations";

/**
 * Applied once: the table holds exactly one row per entry in the new image's journal, no hash twice.
 * That the rows which were there before are untouched is {@link compareSnapshots}'s to say.
 */
export function migrationFailures(
  before: Snapshot,
  after: Snapshot,
  journalEntries: number,
): string[] {
  const failures: string[] = [];
  const was = before[MIGRATIONS_TABLE]?.rows ?? [];
  const now = after[MIGRATIONS_TABLE]?.rows ?? [];
  if (now.length !== journalEntries) {
    failures.push(
      `${MIGRATIONS_TABLE} holds ${now.length} rows and the new image's journal has ${journalEntries} entries.`,
    );
  }
  const hashes = now.map((row) => String(row.hash));
  if (new Set(hashes).size !== hashes.length) {
    failures.push(
      `${MIGRATIONS_TABLE} holds the same migration twice: applied more than once.`,
    );
  }
  if (now.length < was.length) {
    failures.push(
      `${MIGRATIONS_TABLE} went from ${was.length} rows to ${now.length}.`,
    );
  }
  return failures;
}

// --- scripts/restore.sh's table ------------------------------------------------------------------

export type RestoreLine = {
  table: string;
  live: number | null;
  restored: number | null;
};

/** The row-count table `scripts/restore.sh` prints, read back. `-` is a table one side lacks. */
export function parseRestoreTable(output: string): {
  lines: RestoreLine[];
  summary: string | null;
} {
  const lines: RestoreLine[] = [];
  const count = (value: string) => (value === "-" ? null : Number(value));
  for (const line of output.split("\n")) {
    const match = line.match(/^ {3}(\S+)\s+(\d+|-)\s+(\d+|-)\s+(=|DIFF.*)$/);
    if (match) {
      lines.push({
        table: match[1] as string,
        live: count(match[2] as string),
        restored: count(match[3] as string),
      });
    }
  }
  const summary =
    output.match(
      /\d+ tables · \d+ equal · \d+ differ · restore took \d+s/,
    )?.[0] ?? null;
  return { lines, summary };
}

/**
 * The dump the upgrade took, restored beside the live database, must hold what the photograph taken
 * just before the upgrade held: the same tables, each with the same number of rows. The live column
 * is the upgraded database and differs where the upgrade says it should; it is reported, not judged.
 */
export function restoreFailures(
  parsed: ReturnType<typeof parseRestoreTable>,
  before: Snapshot,
): string[] {
  const failures: string[] = [];
  if (!parsed.summary) {
    failures.push("scripts/restore.sh printed no row-count table.");
    return failures;
  }
  const restored = new Map(
    parsed.lines.map((line) => [line.table, line.restored]),
  );
  for (const [name, table] of Object.entries(before)) {
    const rows = restored.get(name);
    if (rows === undefined || rows === null) {
      failures.push(`${name}: not in the restored dump.`);
    } else if (rows !== table.rows.length) {
      failures.push(
        `${name}: the restored dump holds ${rows} rows; the database held ${table.rows.length} just before the upgrade.`,
      );
    }
  }
  return failures;
}

// --- outage, as seen from outside ----------------------------------------------------------------

/** One probe. `ok` is null when the answer cannot say either way (see {@link classifyHealth}). */
export type Sample = { at: number; ok: boolean | null; status: number | null };
export type Outage = {
  windows: { from: number; to: number | null }[];
  totalMs: number;
  longestMs: number;
  probes: number;
  failed: number;
};

/**
 * Windows of failure: from the first failed probe to the next one that answered ok. A window that
 * never closes runs to the last probe. An unmeasurable answer neither opens nor closes one.
 */
export function outageOf(samples: readonly Sample[]): Outage {
  const ordered = [...samples].sort((left, right) => left.at - right.at);
  const windows: Outage["windows"] = [];
  let open: number | null = null;
  for (const sample of ordered) {
    if (sample.ok === false && open === null) open = sample.at;
    if (sample.ok === true && open !== null) {
      windows.push({ from: open, to: sample.at });
      open = null;
    }
  }
  if (open !== null) windows.push({ from: open, to: null });
  const last = ordered.at(-1)?.at ?? 0;
  const lengths = windows.map((window) => (window.to ?? last) - window.from);
  return {
    windows,
    totalMs: lengths.reduce((sum, length) => sum + length, 0),
    longestMs: Math.max(0, ...lengths),
    probes: ordered.length,
    failed: ordered.filter((sample) => sample.ok === false).length,
  };
}

/**
 * `/health` from outside. Ok is 200 with `"status":"ok"`. A 200 that is HTML is the old front door
 * serving the app at that path — `app/Caddyfile` routed /health to the API only from 2026-09-06, so
 * a `:stable` older than that cannot be asked this question from outside at all — and is neither
 * up nor down.
 */
export function classifyHealth(
  status: number,
  contentType: string,
  body: string,
): boolean | null {
  if (status === 200 && contentType.includes("text/html")) return null;
  if (status !== 200) return false;
  try {
    return (JSON.parse(body) as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}

// --- local builds --------------------------------------------------------------------------------

/**
 * The override a LOCAL run adds, and the one thing it changes: `pull_policy: missing` on the services
 * whose images were built here. `upgrade.sh` pulls before anything is replaced and must — but a tag
 * that exists only on this machine is "not found" at the registry, and `docker compose pull` fails
 * the whole upgrade on it (measured: exit 1 even for a service that has a `build:` section). With
 * the policy, the pull skips an image that is already present and pulls everything else. A run
 * against registry tags (CI) has no override at all.
 */
export function localOverride(services: readonly string[]): string {
  return [
    "# scripts/upgrade-e2e.ts, local run only: these images were built on this machine and are not in",
    "# any registry, so the pull upgrade.sh makes must find them here rather than fail.",
    "services:",
    ...services.flatMap((service) => [
      `  ${service}:`,
      "    pull_policy: missing",
    ]),
    "",
  ].join("\n");
}

// --- the model -----------------------------------------------------------------------------------

/**
 * What the fake model answers a request with: the phrase, as prose.
 *
 * A request that is not a stream is somebody's one-question JSON call (the server's auto-review
 * probe, measured at boot): answered with a refusal, which that caller already reads as "this model
 * cannot", rather than with an event stream it would fail to parse.
 *
 * It used to answer a room member with a `send_message` call first, because a member's plain text
 * was scratch space nobody read. Rooms were removed on 2026-09-24.
 */
export function answerTo(
  body: Record<string, unknown>,
  phrase: string,
): Behaviour {
  if (body.stream !== true) return { kind: "status", status: 503 };
  return { kind: "stream", choices: says(phrase) };
}

// --- the run -------------------------------------------------------------------------------------

type RunResult = { code: number; stdout: string; stderr: string };

/**
 * The environment every docker, compose and script call gets: what docker itself needs and nothing
 * else. Compose lets the shell override `.env`, so a developer's own exported OPENAI_API_KEY or
 * IMAGE_TAG would otherwise decide what this deployment runs and which model it pays.
 */
export function scrubbedEnvironment(
  source: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
  ]) {
    const value = source[name];
    if (value !== undefined) kept[name] = value;
  }
  return { ...kept, ...extra };
}

async function run(
  command: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    input?: string;
    echo?: boolean;
    log?: string;
  } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? scrubbedEnvironment(process.env),
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    sink: NodeJS.WriteStream,
  ) => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      const piece = decoder.decode(chunk, { stream: true });
      text += piece;
      if (options.echo) sink.write(piece);
    }
    return text + decoder.decode();
  };
  const [stdout, stderr, code] = await Promise.all([
    drain(proc.stdout, process.stdout),
    drain(proc.stderr, process.stderr),
    proc.exited,
  ]);
  if (options.log) {
    appendFileSync(
      options.log,
      `\n$ ${command.join(" ")}\n${stdout}${stderr}[exit ${code}]\n`,
    );
  }
  return { code, stdout, stderr };
}

async function must(
  command: string[],
  options: Parameters<typeof run>[1] = {},
): Promise<string> {
  const result = await run(command, options);
  if (result.code !== 0) {
    throw new Error(
      `${command.slice(0, 4).join(" ")}… exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-800)}`,
    );
  }
  return result.stdout;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const clock = () => {
  const started = Date.now();
  return () => Date.now() - started;
};

async function freePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

async function until<T>(
  what: string,
  timeoutMs: number,
  attempt: () => Promise<T | null>,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline)
      throw new Error(`${what}: not within ${seconds(timeoutMs)}.`);
    await Bun.sleep(intervalMs);
  }
}

type Check = { name: string; ok: boolean; detail: string };

class Report {
  readonly checks: Check[] = [];
  readonly findings: string[] = [];
  readonly timings: [string, number][] = [];
  readonly lines: string[] = [];
  errors: string[] = [];

  check(name: string, ok: boolean, detail: string) {
    this.checks.push({ name, ok, detail });
    console.log(`   ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  }
  finding(text: string) {
    this.findings.push(text);
    console.log(`   FINDING  ${text}`);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::warning title=Upgrade e2e finding::${text}`);
    }
  }
  time(label: string, ms: number) {
    this.timings.push([label, ms]);
  }
  get passed() {
    return this.errors.length === 0 && this.checks.every((check) => check.ok);
  }
}

const say = (text: string) => console.log(`\n== ${text}`);

/**
 * Every ordinary table outside the catalogues — the set `scripts/restore.sh` counts — with its
 * columns, its primary key and every row, as JSON Postgres wrote it. Two queries whatever the size of
 * the schema: one for the shapes, one statement per table in a single psql call, one line each.
 */
async function photograph(
  psql: (sql: string) => Promise<string>,
): Promise<Snapshot> {
  const catalogue = await psql(`
    select n.nspname || '.' || c.relname,
      coalesce((select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
                where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), ''),
      coalesce((select string_agg(a.attname, ',' order by array_position(i.indkey::int2[], a.attnum))
                from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
                where i.indrelid = c.oid and i.indisprimary), '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
    order by 1;
  `);
  const shapes = catalogue
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, columns, primaryKey] = line.split("\t");
      return {
        name: name as string,
        columns: (columns ?? "").split(",").filter(Boolean),
        primaryKey: (primaryKey ?? "").split(",").filter(Boolean),
      };
    });
  const quoted = (name: string) =>
    name
      .split(".")
      .map((part) => `"${part.replaceAll('"', '""')}"`)
      .join(".");
  // jsonb, not json: `json_agg` puts newlines between elements and this reads one table per line.
  const dumped = await psql(
    shapes
      .map(
        (shape) =>
          `select '${shape.name}' || E'\\t' || coalesce((select jsonb_agg(to_jsonb(t)) from ${quoted(shape.name)} t), '[]'::jsonb)::text;`,
      )
      .join("\n"),
  );
  const snapshot: Snapshot = {};
  for (const line of dumped.split("\n").filter(Boolean)) {
    const at = line.indexOf("\t");
    const name = line.slice(0, at);
    const shape = shapes.find((candidate) => candidate.name === name);
    if (shape) {
      snapshot[name] = {
        ...shape,
        rows: JSON.parse(line.slice(at + 1)) as Row[],
      };
    }
  }
  return snapshot;
}

/**
 * Three doors, each asked every 0.25 s on a fresh connection until `stop`. `/` and `/health` are the
 * two a watcher reads. `/api/capabilities` is there because a `:stable` from before 2026-09-06 answers
 * /health with the app itself (see classifyHealth), and "the API answers through the front door" has
 * to mean the same thing on both sides of the switch.
 */
function probeFromOutside(base: string) {
  const probes: {
    path: string;
    classify: (response: Response, body: string) => boolean | null;
  }[] = [
    { path: "/", classify: (response) => response.status === 200 },
    {
      path: "/health",
      classify: (response, body) =>
        classifyHealth(
          response.status,
          response.headers.get("content-type") ?? "",
          body,
        ),
    },
    {
      path: "/api/capabilities",
      classify: (response) => response.status === 200,
    },
  ];
  const samples = new Map<string, Sample[]>(
    probes.map((probe) => [probe.path, []]),
  );
  let polling = true;
  const pollers = probes.map(async (probe) => {
    const list = samples.get(probe.path) as Sample[];
    while (polling) {
      const at = Date.now();
      try {
        // A kept-alive socket to a container that has just been replaced fails in a way a browser
        // retries silently; a fresh connection per probe is what a new visitor sees.
        const response = await fetch(`${base}${probe.path}`, {
          signal: AbortSignal.timeout(2000),
          headers: { connection: "close" },
          redirect: "manual",
        });
        const body = await response.text();
        list.push({
          at,
          ok: probe.classify(response, body),
          status: response.status,
        });
      } catch {
        list.push({ at, ok: false, status: null });
      }
      const wait = 250 - (Date.now() - at);
      if (wait > 0) await Bun.sleep(wait);
    }
  });
  return {
    samples,
    stop: async () => {
      polling = false;
      await Promise.all(pollers);
    },
  };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const report = new Report();
  const total = clock();
  const runId = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const work = options.work ?? mkdtempSync(join(tmpdir(), "laf-upgrade-e2e-"));
  mkdirSync(work, { recursive: true });
  // The directory's name is the compose project's, so it must not be `openbot`: that is the name a
  // developer's own stack runs under, and its volumes are somebody's afternoon.
  const deployment = join(work, `laf-upgrade-e2e-${runId}`);
  const backups = join(work, "backups");
  const logFile = join(work, "upgrade-e2e.log");
  mkdirSync(deployment, { recursive: true });
  console.log(`Working in ${work}`);

  const revision = (
    await must(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).trim();
  const toTag =
    options.to === "local" ? `e2e-${revision.slice(0, 12)}` : options.to;
  const local = options.to === "local";

  /*
   * What this run pulls or builds, by reference, and what each reference named before it started —
   * so that taking things away removes exactly what the run brought and puts back a tag a pull moved.
   * Never a global diff of the image store: another checkout on the same machine is building too.
   */
  const references = [
    "postgres:17",
    ...Object.keys(IMAGES).flatMap((image) => [
      imageRef(image as keyof typeof IMAGES, options.from),
      imageRef(image as keyof typeof IMAGES, toTag),
    ]),
  ];
  const imageId = async (reference: string) => {
    const result = await run([
      "docker",
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      reference,
    ]);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const imagesBefore = new Map<string, string | null>();
  for (const reference of references) {
    imagesBefore.set(reference, await imageId(reference));
  }

  const composeEnv: Record<string, string> = {};
  const compose = (args: string[], extra: Parameters<typeof run>[1] = {}) =>
    run(["docker", "compose", ...args], {
      cwd: deployment,
      env: scrubbedEnvironment(process.env, composeEnv),
      log: logFile,
      ...extra,
    });
  const psql = async (sql: string) => {
    const result = await compose(
      [
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "openbot",
        "-d",
        "openbot",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-F",
        "\t",
      ],
      { input: sql, log: undefined },
    );
    if (result.code !== 0) {
      throw new Error(`psql exited ${result.code}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };

  // The model. Every answer carries a phrase this run minted, so an answer is proof it came from here.
  const nonce = randomBytes(4).toString("hex").toUpperCase();
  let phrase = `확인했습니다. 업그레이드 전 ${nonce}`;
  // The script reads the request it answers: the fake records each one before asking the script.
  const fake = startFakeProvider((ordinal) =>
    answerTo(fake.requests[ordinal]?.body ?? {}, phrase),
  );
  const fakePort = Number(new URL(fake.url).port);

  // Outside the try, so a run that fails after the upgrade still reports what it measured.
  let outages = new Map<string, Outage>();
  let measuredRevision: string | null = null;
  let stackStarted = false;
  let hostFirewallApplied = false;
  let finished = false;
  const takeAway = async () => {
    if (finished) return;
    finished = true;
    fake.stop();
    if (options.keep) {
      console.log(
        `\n--keep: the deployment is still up in ${deployment} (IMAGE_TAG and COMPOSE_FILE as below).`,
      );
      console.log(JSON.stringify(composeEnv));
      return;
    }
    say("Taking away what this run made");
    if (hostFirewallApplied) {
      await run([
        "sudo",
        "-n",
        join(deployment, "scripts/laf-browser-firewall.sh"),
        "remove",
      ]);
    }
    if (stackStarted) {
      await compose([
        "down",
        "--volumes",
        "--remove-orphans",
        "--timeout",
        "20",
      ]);
    }
    for (const reference of references) {
      const was = imagesBefore.get(reference) ?? null;
      const now = await imageId(reference);
      if (now === null || now === was) continue;
      if (
        was !== null &&
        (await run(["docker", "image", "inspect", was])).code === 0
      ) {
        // A pull moved a tag somebody already had: put it back where it was.
        await run(["docker", "tag", was, reference]);
        console.log(`   ${reference}: tag put back`);
      } else {
        await run(["docker", "image", "rm", reference]);
        console.log(`   ${reference}: removed`);
      }
    }
    // A failed run keeps its directory: the log, the dump and the compose file are what explain it.
    if (!options.work && report.passed) {
      rmSync(work, { recursive: true, force: true });
    } else {
      console.log(`   kept ${work}`);
    }
  };
  const interrupted = () => {
    console.error("\nInterrupted.");
    void takeAway().finally(() => process.exit(130));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

  try {
    // --- preflight -------------------------------------------------------------------------------
    say("Preflight");
    await must(["docker", "compose", "version"]);
    const frontDoorTaken = await fetch("http://localhost/", {
      signal: AbortSignal.timeout(2000),
    })
      .then(() => true)
      .catch(() => false);
    if (frontDoorTaken) {
      throw new Error(
        "Something already answers on http://localhost/. The compose file publishes the front door on 80 and 443; stop whatever holds them.",
      );
    }
    const operatingSystem = (
      await must(["docker", "info", "--format", "{{.OperatingSystem}}"])
    ).trim();
    // Where a container finds this process. Docker Desktop names the host; on Linux the default
    // bridge's gateway is the host, the same route smoke.yml measured for the Bot's browser.
    const hostFromContainers = operatingSystem.includes("Docker Desktop")
      ? "host.docker.internal"
      : (
          await must([
            "docker",
            "network",
            "inspect",
            "bridge",
            "--format",
            "{{(index .IPAM.Config 0).Gateway}}",
          ])
        ).trim();
    const dirty =
      (
        await must(["git", "status", "--porcelain"], { cwd: repositoryRoot })
      ).trim().length > 0;
    console.log(
      `   docker: ${operatingSystem}; the fake model at ${hostFromContainers}:${fakePort}; checkout ${revision.slice(0, 12)}${dirty ? " (with uncommitted changes)" : ""}`,
    );

    const remoteRevision = async (reference: string) => {
      const result = await run([
        "docker",
        "buildx",
        "imagetools",
        "inspect",
        "--format",
        "{{json .Image}}",
        reference,
      ]);
      if (result.code !== 0) return null;
      return (
        result.stdout.match(
          /"org\.opencontainers\.image\.revision":\s*"([0-9a-f]{7,40})"/,
        )?.[1] ?? null
      );
    };

    // --- what TO is ------------------------------------------------------------------------------
    let toRevision: string;
    if (local && options.noBuild) {
      /*
       * The web image's build is five minutes of vite and wants most of a 4 GB Docker VM to itself —
       * measured here: the same build that passed in 303 s was killed for memory on the next run,
       * beside another checkout's containers. So a run can take the five images an earlier build
       * left, as long as each says it was built from this commit.
       */
      for (const image of Object.keys(IMAGES) as (keyof typeof IMAGES)[]) {
        const label = await run([
          "docker",
          "image",
          "inspect",
          "--format",
          '{{index .Config.Labels "org.opencontainers.image.revision"}}',
          imageRef(image, toTag),
        ]);
        if (label.code !== 0 || label.stdout.trim() !== revision) {
          throw new Error(
            `--no-build: ${imageRef(image, toTag)} is ${label.code === 0 ? `from ${label.stdout.trim() || "no commit"}` : "not on this machine"}. Build without --no-build first (with --keep to leave the images).`,
          );
        }
      }
      console.log(
        `   the five :${toTag} images are here, built from ${revision.slice(0, 12)}`,
      );
      toRevision = revision;
    } else if (local) {
      say(`Building the five images from this checkout as :${toTag}`);
      const built = clock();
      mkdirSync(join(work, "logs"), { recursive: true });
      // What images.yml does before the bundle's build: deploy/Dockerfile copies the rendered pages.
      const legal = await run([
        "bun",
        "app/scripts/render-legal.ts",
        "deploy/legal",
      ]);
      if (legal.code !== 0) {
        throw new Error(
          `Rendering the legal pages failed:\n${legal.stderr.trim().slice(-1500)}`,
        );
      }
      for (const [image, dockerfile] of Object.entries(IMAGES)) {
        const one = clock();
        const log = join(work, "logs", `build-${image}.log`);
        const result = await run(
          [
            "docker",
            "build",
            "--file",
            dockerfile,
            "--build-arg",
            "AUTH_PROVIDERS=google",
            "--build-arg",
            `REVISION=${revision}`,
            "--build-arg",
            `CHANNEL=${toTag}`,
            "--label",
            `org.opencontainers.image.revision=${revision}`,
            "--tag",
            imageRef(image as keyof typeof IMAGES, toTag),
            ".",
          ],
          { log },
        );
        if (result.code !== 0) {
          throw new Error(
            `Building ${image} failed (${log}):\n${result.stderr.trim().slice(-1500)}`,
          );
        }
        console.log(`   ${image}: built in ${seconds(one())}`);
      }
      report.time("build the five TO images locally", built());
      toRevision = revision;
    } else {
      const found = await remoteRevision(imageRef("server", toTag));
      if (!found) {
        throw new Error(
          `${imageRef("server", toTag)} is not in the registry, or carries no revision label.`,
        );
      }
      toRevision = found;
      if (
        options.expectRevision &&
        !toRevision.startsWith(options.expectRevision)
      ) {
        const between = await run(
          ["git", "diff", "--name-only", toRevision, options.expectRevision],
          { cwd: repositoryRoot },
        );
        const paths = between.stdout.split("\n").filter(Boolean);
        if (between.code !== 0 || !isDocumentationOnly(paths)) {
          throw new Error(
            `:${toTag} was built from ${toRevision.slice(0, 12)}, not ${options.expectRevision.slice(0, 12)}, and the two differ in more than documentation${
              between.code === 0
                ? ` (${paths
                    .filter((path) => !isDocumentationOnly([path]))
                    .slice(0, 5)
                    .join(", ")})`
                : ""
            }. Images for this commit are not published yet.`,
          );
        }
        report.finding(
          `:${toTag} is ${toRevision.slice(0, 12)}, not ${options.expectRevision.slice(0, 12)}; the ${paths.length} path(s) between them are documentation only, which images.yml does not rebuild for.`,
        );
      }
    }

    measuredRevision = toRevision;

    // --- the deployment as a VM has it -----------------------------------------------------------
    say(`Standing up :${options.from} from its deploy bundle`);
    const extract = async (tag: string) => {
      const name = `laf-upgrade-e2e-bundle-${runId}`;
      const created = await run(
        ["docker", "create", "--name", name, imageRef("deploy", tag)],
        {
          log: logFile,
        },
      );
      if (created.code !== 0) {
        if (/not found|manifest unknown/i.test(created.stderr)) return false;
        throw new Error(
          `docker create ${imageRef("deploy", tag)}: ${created.stderr.trim()}`,
        );
      }
      try {
        await must(["docker", "cp", `${name}:/deploy/.`, deployment], {
          log: logFile,
        });
      } finally {
        await run(["docker", "rm", name], { log: logFile });
      }
      return true;
    };

    if (!(await extract(options.from))) {
      const fromRevision = await remoteRevision(
        imageRef("server", options.from),
      );
      if (!fromRevision) {
        throw new Error(
          `There is no ${imageRef("deploy", options.from)}, and ${imageRef("server", options.from)} names no revision to rebuild the directory from.`,
        );
      }
      const present = await run(
        ["git", "cat-file", "-e", `${fromRevision}^{commit}`],
        {
          cwd: repositoryRoot,
        },
      );
      if (present.code !== 0) {
        throw new Error(
          `There is no ${imageRef("deploy", options.from)}, and this checkout does not have ${fromRevision} to rebuild the directory from (fetch the full history).`,
        );
      }
      const carried: string[] = [];
      for (const path of BUNDLE_FILES) {
        const file = await run(["git", "show", `${fromRevision}:${path}`], {
          cwd: repositoryRoot,
        });
        if (file.code !== 0) continue;
        mkdirSync(dirname(join(deployment, path)), { recursive: true });
        writeFileSync(join(deployment, path), file.stdout, {
          mode: path.endsWith(".sh") ? 0o755 : 0o644,
        });
        carried.push(path);
      }
      writeFileSync(
        join(deployment, "VERSION"),
        `revision=${fromRevision}\nchannel=${options.from}\n`,
      );
      report.finding(
        `${imageRef("deploy", options.from)} does not exist: the bundle was first published 2026-09-10, after the release :${options.from} names, so a VM on :${options.from} cannot be stood up or upgraded by extracting it. The directory was rebuilt from git at ${fromRevision.slice(0, 12)} — what a VM cloned then holds: ${carried.join(", ")}.`,
      );
    }

    const fromCompose = readFileSync(
      join(deployment, "docker-compose.yml"),
      "utf8",
    );
    const ownerEmail = "sajang@upgrade-e2e.test";
    const model = "upgrade-e2e/fake-model";
    const ports = {
      postgres: await freePort(),
      bot: await freePort(),
      computer: await freePort(),
    };
    const secrets = mintSecrets();
    const env = renderEnv({
      imageTag: options.from,
      ownerEmail,
      modelBaseUrl: `http://${hostFromContainers}:${fakePort}/v1`,
      model,
      ports,
      secrets,
    });
    writeFileSync(join(deployment, ".env"), env, { mode: 0o600 });
    const fromReads = composeVariables(fromCompose);
    const unread = env
      .split("\n")
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((name): name is string => !!name && name !== "IMAGE_TAG")
      .filter((name) => !fromReads.has(name));
    if (unread.length > 0) {
      const them = unread.length === 1 ? "it" : "them";
      report.finding(
        `:${options.from}'s compose file never passes ${unread.join(", ")}: a VM whose .env was written for :${options.from} need not have ${them}, and must gain ${them} before it upgrades to a build that requires ${them}. This run's .env carries ${them} from the start.`,
      );
    }

    const up = clock();
    const pulled = await compose(["pull"], { echo: false });
    if (pulled.code !== 0) {
      throw new Error(
        `docker compose pull (:${options.from}): ${pulled.stderr.trim().slice(-800)}`,
      );
    }
    stackStarted = true;
    const started = await compose(["up", "-d"]);
    if (started.code !== 0) {
      throw new Error(
        `docker compose up -d (:${options.from}): ${started.stderr.trim().slice(-1500)}`,
      );
    }
    const serverHealth = async () => {
      const result = await compose(
        [
          "exec",
          "-T",
          "server",
          "bun",
          "-e",
          "const r = await fetch('http://localhost:3001/health'); console.log(await r.text()); process.exit(r.ok ? 0 : 1)",
        ],
        { log: undefined },
      );
      return result.code === 0 ? result.stdout.trim() : null;
    };
    await until(
      `:${options.from} answering /health`,
      300_000,
      serverHealth,
      2000,
    );
    await until(`:${options.from}'s front door`, 60_000, async () =>
      (await fetch("http://localhost/", { signal: AbortSignal.timeout(3000) }))
        .ok
        ? true
        : null,
    );
    report.time(`:${options.from} pulled, up and healthy`, up());

    const reachable = await compose(
      [
        "exec",
        "-T",
        "agent-bot",
        "bun",
        "-e",
        "const r = await fetch(process.env.OPENAI_BASE_URL + '/models', { signal: AbortSignal.timeout(5000) }); process.exit(r.status === 404 ? 0 : 1)",
      ],
      { log: undefined },
    );
    if (reachable.code !== 0) {
      throw new Error(
        `agent-bot cannot reach the fake model at http://${hostFromContainers}:${fakePort}/v1 — every turn would fail for a reason that has nothing to do with the upgrade.`,
      );
    }

    // --- a person, signed in ---------------------------------------------------------------------
    say("Seeding through the front door");
    const seeding = clock();
    const userId = `e2e${randomBytes(12).toString("hex")}`;
    const token = randomBytes(24).toString("hex");
    /*
     * The session is a row, the way the server's integration tests stand a person up. The only real
     * way in is OAuth, and a provider stood up here would test the provider; better-auth reads this
     * row exactly as it reads one its own callback wrote. The cookie is better-auth's own signature
     * over the token (better-call's `signCookieValue`: HMAC-SHA256 under BETTER_AUTH_SECRET).
     */
    await psql(`
      insert into users (id, email, name, email_verified) values ('${userId}', '${ownerEmail}', '업그레이드 사장님', true);
      insert into user_roles (user_id, role) values ('${userId}', 'admin');
      insert into sessions (id, user_id, token, expires_at, ip_address, user_agent)
        values ('s${userId}', '${userId}', '${token}', now() + interval '30 days', '127.0.0.1', 'upgrade-e2e');
    `);
    const cookie = sessionCookie(secrets.betterAuthSecret, token);
    const api = async (
      path: string,
      init: RequestInit = {},
      timeoutMs = 60_000,
    ) => {
      const response = await fetch(`http://localhost${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          cookie,
          origin: "http://localhost",
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body: body as Record<string, unknown> };
    };
    const expectOk = async (
      label: string,
      path: string,
      init: RequestInit = {},
      timeoutMs?: number,
    ) => {
      const response = await api(path, init, timeoutMs);
      if (response.status < 200 || response.status > 299) {
        throw new Error(
          `${label}: ${init.method ?? "GET"} ${path} answered ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`,
        );
      }
      return response.body;
    };

    const me = await expectOk("signed in", "/api/me");
    const meId = (me.user as { id?: string } | undefined)?.id;
    if (meId !== userId)
      throw new Error(`/api/me answered ${JSON.stringify(me).slice(0, 200)}`);
    await expectOk("onboarded", "/api/me/onboarded", {
      method: "POST",
      body: "{}",
    });

    // Their one Bot. A name and nothing else, the way the first run makes it now.
    const orders = (
      (
        await expectOk("the Bot", "/api/agents", {
          method: "POST",
          body: JSON.stringify({
            name: "주문 담당",
            title: "",
            roleDescription: "",
          }),
        })
      ).agent as { id: string }
    ).id;

    const routine = (
      await expectOk("the routine", "/api/routines", {
        method: "POST",
        body: JSON.stringify({
          agentId: orders,
          name: "아침 주문 정리",
          instruction: "새로 들어온 주문을 확인하고 한 줄로 알려 주세요.",
          schedule: { kind: "interval", minutes: 1440 },
        }),
      })
    ).routine as { id: string };
    const lastRun = async () => {
      await expectOk(
        "running the routine",
        `/api/routines/${routine.id}/run`,
        { method: "POST", body: "{}" },
        180_000,
      );
      const { runs } = (await expectOk(
        "the routine's runs",
        `/api/routines/${routine.id}/runs`,
      )) as {
        runs: { ok?: boolean; answer?: string; error?: string }[];
      };
      return runs[0];
    };
    const seededRun = await lastRun();
    if (!seededRun?.ok || !seededRun.answer?.includes(nonce)) {
      throw new Error(
        `The routine's run before the upgrade: ${JSON.stringify(seededRun).slice(0, 300)}`,
      );
    }

    // The Bot's browser, opened once: its profile directory now exists in the volume, written by the
    // old computer — as root, on any :stable from before 2026-09-13.
    const screenshot = await expectOk(
      "the Bot's browser",
      `/api/computers/${orders}/screenshot`,
      {},
      180_000,
    );
    if (
      !(typeof screenshot.base64 === "string" && screenshot.base64.length > 0)
    ) {
      throw new Error(
        "The Bot's browser answered a screenshot with no picture.",
      );
    }

    /*
     * A site connection is a row, like the session. The only route that writes one reads the Bot's
     * browser and asks whether it is signed into the real site — 스마트스토어 on its own host — which
     * no run here can be.
     */
    await psql(`
      insert into laf_site_connections (user_id, site_id, bot_id, connected_at, last_seen_at, needs_login)
        values ('${userId}', 'naver-smartstore', '${orders}', now() - interval '3 days', now() - interval '1 hour', false);
    `);

    const trail = await expectOk(
      "the trail",
      "/api/admin/audit-events?limit=50",
    );
    const trailRows = (trail.events as unknown[] | undefined)?.length ?? 0;
    report.time("seed through the front door", seeding());
    console.log(
      `   one Bot, a routine that ran, a browser opened, a site connection, ${trailRows} trail rows on the first page; the fake model was asked ${fake.requests.length} time(s)`,
    );

    // --- the upgrade -----------------------------------------------------------------------------
    say(`Re-extracting the bundle for :${toTag}, as laf upgrade does`);
    const envHash = () =>
      createHash("sha256")
        .update(readFileSync(join(deployment, ".env")))
        .digest("hex");
    const envBefore = envHash();
    if (!(await extract(toTag))) {
      throw new Error(
        `There is no ${imageRef("deploy", toTag)} to upgrade with.`,
      );
    }
    const toVersion = readFileSync(join(deployment, "VERSION"), "utf8")
      .trim()
      .replaceAll("\n", ", ");
    console.log(`   VERSION: ${toVersion}`);
    report.check(
      ".env untouched by the bundle",
      envHash() === envBefore,
      "the copy never writes the directory's own .env",
    );

    /*
     * THE TO TAG GOES IN .env FIRST, as it must for a person moving a VM to another version:
     * `upgrade.sh` refuses an IMAGE_TAG in its environment that disagrees with .env (audit
     * 2026-09-16, R6 F6). This run used to export the TO tag and leave .env naming the FROM tag —
     * the shape that moved a deployment for one run, until the next `up -d` read .env and moved it
     * back. What the upgrade is held to below is that it leaves this .env exactly as it found it.
     */
    const envPath = join(deployment, ".env");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(
        /^IMAGE_TAG=.*$/m,
        `IMAGE_TAG=${toTag}`,
      ),
    );
    const envPinned = envHash();
    composeEnv.IMAGE_TAG = toTag;
    if (local) {
      const config = await run(
        ["docker", "compose", "config", "--format", "json"],
        {
          cwd: deployment,
          env: scrubbedEnvironment(process.env, { IMAGE_TAG: toTag }),
        },
      );
      if (config.code !== 0)
        throw new Error(`docker compose config: ${config.stderr.trim()}`);
      const services = Object.entries(
        (
          JSON.parse(config.stdout) as {
            services: Record<string, { image?: string }>;
          }
        ).services,
      )
        .filter(([, service]) => service.image?.endsWith(`:${toTag}`))
        .map(([service]) => service)
        .sort();
      writeFileSync(
        join(deployment, "upgrade-e2e.local.yml"),
        localOverride(services),
      );
      composeEnv.COMPOSE_FILE = "docker-compose.yml:upgrade-e2e.local.yml";
      console.log(
        `   local images: pull_policy missing on ${services.join(", ")}`,
      );
    }

    phrase = `확인했습니다. 업그레이드 후 ${nonce}`;
    const before = await photograph(psql);
    const upgradeStartedAt = Date.now();
    const requestsBefore = fake.requests.length;
    const outside = probeFromOutside("http://localhost");

    say(`scripts/upgrade.sh → :${toTag}`);
    const upgrading = clock();
    const upgraded = await run(["./scripts/upgrade.sh"], {
      cwd: deployment,
      env: scrubbedEnvironment(process.env, {
        ...composeEnv,
        BACKUP_DIR: backups,
        HEALTH_TIMEOUT: String(options.healthTimeoutSeconds),
      }),
      echo: true,
      log: logFile,
    });
    const upgradeMs = upgrading();
    report.time("scripts/upgrade.sh, start to exit", upgradeMs);
    report.check(
      "upgrade.sh exits 0",
      upgraded.code === 0,
      `exit ${upgraded.code} after ${seconds(upgradeMs)}`,
    );
    if (upgraded.code !== 0)
      throw new Error(
        "scripts/upgrade.sh did not succeed; nothing after it means anything.",
      );

    /*
     * THE HOST'S BROWSER RULES, AS A VM HOLDS THEM. Since 2026-09-26 the Bot's browser refuses to
     * browse (`laf:egress_unguarded`) until the host rejects its way to the metadata endpoint and
     * private ranges — the fleet installs those rules before every stack, and a self-hosted VM runs
     * the bundle's `scripts/laf-browser-firewall.sh`. The first run of this e2e after that change
     * failed on exactly this: the upgraded computer, correctly, would not open a page on a host
     * with no rules. So the upgraded directory's own script is applied here, as root, the way a VM
     * does it — and taken away with the rest of the run. A bundle without the script is a release
     * from before the rules moved to the host, whose computer holds its own.
     */
    const firewall = join(deployment, "scripts/laf-browser-firewall.sh");
    if (existsSync(firewall)) {
      const applied = await run(
        [
          "sudo",
          "-n",
          "env",
          `LAF_ENV_FILE=${join(deployment, ".env")}`,
          firewall,
          "apply",
        ],
        { cwd: deployment },
      );
      hostFirewallApplied = applied.code === 0;
      report.check(
        "the host's browser rules applied from the upgraded bundle",
        hostFirewallApplied,
        hostFirewallApplied
          ? applied.stdout.trim()
          : `exit ${applied.code}: ${applied.stderr.trim().slice(0, 200)} (no passwordless sudo here — run on CI or as root)`,
      );
    }

    // Probing on until every door has answered ok for five seconds straight, so the last window closes.
    await until(
      "every probe ok for five seconds after upgrade.sh",
      120_000,
      async () => {
        const settled = [...outside.samples.values()].every((list) => {
          const recent = list.filter((sample) => sample.at > Date.now() - 5000);
          return (
            recent.length >= 10 && recent.every((sample) => sample.ok !== false)
          );
        });
        return settled ? true : null;
      },
      500,
    ).catch((error) => report.errors.push(String(error)));
    await outside.stop();
    outages = new Map(
      [...outside.samples].map(([path, list]) => [path, outageOf(list)]),
    );
    for (const [path, outage] of outages) {
      const windows = outage.windows
        .map(
          (window) =>
            `t+${seconds(window.from - upgradeStartedAt)}→${window.to === null ? "never" : `t+${seconds(window.to - upgradeStartedAt)}`}`,
        )
        .join(", ");
      console.log(
        `   ${path}: ${seconds(outage.totalMs)} down over ${outage.windows.length} window(s)${windows ? ` (${windows})` : ""}; ${outage.failed}/${outage.probes} probes failed`,
      );
    }

    // --- what the upgrade left -------------------------------------------------------------------
    say("Checking");
    report.check(
      ".env untouched by the upgrade",
      envHash() === envPinned,
      "byte for byte, from the TO tag being set in it to after upgrade.sh",
    );

    const after = await photograph(psql);
    const comparison = compareSnapshots(before, after);
    const grew = comparison.tables.filter((table) => table.added > 0);
    const moved = comparison.tables.filter(
      (table) => Object.keys(table.moved).length > 0,
    );
    report.check(
      "every row that existed is still there, unchanged",
      comparison.failures.length === 0,
      comparison.failures.length === 0
        ? `${comparison.tables.length} tables, ${comparison.tables.reduce((sum, table) => sum + table.before, 0)} rows compared column by column`
        : comparison.failures.join(" "),
    );
    for (const table of comparison.tables.filter((table) => table.before > 0)) {
      report.lines.push(
        `${table.name.padEnd(46)} ${String(table.before).padStart(5)} → ${String(table.after ?? "-").padEnd(5)} ${table.hashBefore === table.hashAfter ? `hash ${table.hashBefore}` : `hash ${table.hashBefore} → ${table.hashAfter}`}${
          table.added > 0
            ? `  +${table.added}${
                Object.keys(table.addedKinds).length > 0
                  ? ` (${Object.entries(table.addedKinds)
                      .map(([kind, count]) => `${kind} ×${count}`)
                      .join(", ")})`
                  : ""
              }`
            : ""
        }${table.droppedColumns.length > 0 ? `  dropped: ${table.droppedColumns.join(", ")}` : ""}`,
      );
    }
    if (grew.length > 0)
      console.log(
        `   grew during the upgrade: ${grew.map((table) => `${table.name} +${table.added}`).join(", ")}`,
      );
    if (moved.length > 0)
      console.log(
        `   moving columns that moved: ${moved.map((table) => `${table.name}.${Object.keys(table.moved).join("/")}`).join(", ")}`,
      );
    if (comparison.newTables.length > 0)
      console.log(
        `   new tables: ${comparison.newTables.map((table) => `${table.name} (${table.rows})`).join(", ")}`,
      );

    const journal = await must([
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "cat",
      imageRef("server", toTag),
      "/app/server/drizzle/meta/_journal.json",
    ]);
    const journalEntries = (JSON.parse(journal) as { entries: unknown[] })
      .entries.length;
    const migrations = migrationFailures(before, after, journalEntries);
    const migrateExit = (
      await compose(["ps", "-a", "--format", "{{.ExitCode}}", "migrate"])
    ).stdout.trim();
    report.check(
      "migrations applied once",
      migrations.length === 0 && migrateExit === "0",
      migrations.length === 0
        ? `${before[MIGRATIONS_TABLE]?.rows.length ?? 0} → ${after[MIGRATIONS_TABLE]?.rows.length ?? 0}, one row per journal entry, no hash twice; migrate exited ${migrateExit}`
        : `${migrations.join(" ")} migrate exited ${migrateExit}`,
    );

    const health = await fetch("http://localhost/health", {
      signal: AbortSignal.timeout(5000),
    });
    const healthBody = await health.text();
    report.check(
      "/health ok from outside",
      health.status === 200 &&
        classifyHealth(
          200,
          health.headers.get("content-type") ?? "",
          healthBody,
        ) === true,
      `${health.status} ${healthBody.slice(0, 120)}`,
    );

    const meAfter = await api("/api/me");
    report.check(
      "the person is still signed in",
      meAfter.status === 200 &&
        (meAfter.body.user as { id?: string } | undefined)?.id === userId,
      `/api/me ${meAfter.status} with the cookie from before the upgrade`,
    );

    const version = await api("/api/version");
    report.check(
      "the API is the new build",
      version.status === 200 && version.body.revision === toRevision,
      `/api/version ${JSON.stringify(version.body).slice(0, 160)}; expected ${toRevision.slice(0, 12)}`,
    );

    const computerHealth = await fetch(
      `http://127.0.0.1:${ports.computer}/health`,
      {
        signal: AbortSignal.timeout(5000),
      },
    ).catch(() => null);
    report.check(
      "the Bot's browser answers /health",
      computerHealth?.status === 200,
      `127.0.0.1:${ports.computer}/health ${computerHealth?.status ?? "no answer"}`,
    );
    const shotAfter = await api(
      `/api/computers/${orders}/screenshot`,
      {},
      180_000,
    );
    report.check(
      "the Bot's browser opens the profile the old one wrote",
      shotAfter.status === 200 &&
        typeof shotAfter.body.base64 === "string" &&
        (shotAfter.body.base64 as string).length > 0,
      `screenshot ${shotAfter.status}${shotAfter.status === 200 ? "" : ` ${JSON.stringify(shotAfter.body).slice(0, 200)}`}`,
    );

    // The dump the upgrade took is the way back; it is only one if it restores to what was there.
    const dump = upgraded.stdout.match(
      /Dumping the database to (\S+\.sql\.gz)/,
    )?.[1];
    if (!dump) throw new Error("upgrade.sh printed no dump path.");
    const restoreEnv = scrubbedEnvironment(process.env, {
      ...composeEnv,
      BACKUP_DIR: backups,
    });
    const dryRun = await run(["./scripts/restore.sh", dump, "--dry-run"], {
      cwd: deployment,
      env: restoreEnv,
      log: logFile,
    });
    report.check(
      "restore.sh --dry-run on the pre-upgrade dump",
      dryRun.code === 0 &&
        dryRun.stdout.includes("DRY RUN — nothing was opened"),
      `exit ${dryRun.code}; the plan printed, no connection opened`,
    );
    const beside = await run(["./scripts/restore.sh", dump], {
      cwd: deployment,
      env: restoreEnv,
      log: logFile,
    });
    const table = parseRestoreTable(beside.stdout);
    const restoreProblems =
      beside.code === 0
        ? restoreFailures(table, before)
        : [`exit ${beside.code}: ${beside.stderr.trim().slice(-300)}`];
    report.check(
      "the pre-upgrade dump restores beside, with the counts it had",
      restoreProblems.length === 0,
      restoreProblems.length === 0
        ? `${table.summary} — every table the photograph held, row for row (differences are the upgraded live side)`
        : restoreProblems.join(" "),
    );

    // One turn, on the other side: the routine seeded before the upgrade, run by the new build.
    const turned = await lastRun().catch((error) => ({
      ok: false,
      error: String(error),
      answer: "",
    }));
    // Streams only: the new build's boot probe asks the same model a one-question JSON call, and a
    // count that included it would say the turn reached the model when only the probe had.
    const asked = fake.requests
      .slice(requestsBefore)
      .filter(
        (request) =>
          request.body.model === model && request.body.stream === true,
      );
    report.check(
      "one turn answers through the fake model",
      turned?.ok === true &&
        (turned.answer ?? "").includes(`업그레이드 후 ${nonce}`) &&
        asked.length > 0,
      `the routine from before the upgrade ran: ${JSON.stringify({ ok: turned?.ok, answer: turned?.answer?.slice(0, 60), error: turned?.error })}; the model was asked ${asked.length} time(s) since`,
    );

    report.time("everything, first command to last check", total());
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    console.error(
      `\nFAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (stackStarted) {
      await compose(["ps", "-a"], { echo: true });
      await compose(["logs", "--tail", "40", "--no-color"], { echo: true });
    }
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    printSummary(
      report,
      {
        from: options.from,
        to: toTag,
        toRevision: measuredRevision,
        outages,
      },
      options.summary,
    );
    await takeAway();
  }
  return report.passed ? 0 : 1;
}

/**
 * The cookie better-auth reads a session from: the token, a dot, and HMAC-SHA256 of the token under
 * BETTER_AUTH_SECRET in base64, URI-encoded — better-call's `signCookieValue`, reproduced so that a
 * session written as a row can be presented the way a browser presents one.
 */
export function sessionCookie(secret: string, token: string): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

function printSummary(
  report: Report,
  run: {
    from: string;
    to: string;
    toRevision: string | null;
    outages: Map<string, Outage>;
  },
  markdownFile: string | null,
) {
  const verdict = report.passed ? "PASSED" : "FAILED";
  const text = [
    "",
    `== Upgrade e2e ${verdict}: :${run.from} → :${run.to}${run.toRevision ? ` (${run.toRevision.slice(0, 12)})` : ""}`,
    ...report.timings.map(
      ([label, ms]) => `   ${label.padEnd(44)} ${seconds(ms)}`,
    ),
    ...[...run.outages].map(
      ([path, outage]) =>
        `   outage ${path.padEnd(37)} ${seconds(outage.totalMs)} (${outage.windows.length} window(s), longest ${seconds(outage.longestMs)}, ${outage.failed}/${outage.probes} probes failed)`,
    ),
    ...report.checks.map(
      (check) => `   ${check.ok ? "PASS" : "FAIL"} ${check.name}`,
    ),
    ...report.errors.map((error) => `   ERROR ${error}`),
    ...report.findings.map((finding) => `   FINDING ${finding}`),
    ...(report.lines.length > 0
      ? [
          "",
          "   table                                          before → after",
          ...report.lines.map((line) => `   ${line}`),
        ]
      : []),
  ];
  console.log(text.join("\n"));
  if (!markdownFile) return;
  const markdown = [
    `## Upgrade e2e ${verdict}: \`:${run.from}\` → \`:${run.to}\`${run.toRevision ? ` (\`${run.toRevision.slice(0, 12)}\`)` : ""}`,
    "",
    "| | |",
    "|---|---|",
    ...report.timings.map(([label, ms]) => `| ${label} | ${seconds(ms)} |`),
    ...[...run.outages].map(
      ([path, outage]) =>
        `| outage \`${path}\`, seen from outside every 0.25 s | ${seconds(outage.totalMs)} over ${outage.windows.length} window(s) |`,
    ),
    "",
    ...report.checks.map(
      (check) =>
        `- ${check.ok ? "PASS" : "**FAIL**"} ${check.name} — ${check.detail}`,
    ),
    ...report.errors.map((error) => `- **ERROR** ${error}`),
    ...(report.findings.length > 0
      ? [
          "",
          "### Findings",
          "",
          ...report.findings.map((finding) => `- ${finding}`),
        ]
      : []),
    ...(report.lines.length > 0
      ? [
          "",
          "<details><summary>Every table with rows</summary>",
          "",
          "```",
          ...report.lines,
          "```",
          "",
          "</details>",
        ]
      : []),
    "",
  ];
  appendFileSync(markdownFile, markdown.join("\n"));
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    const source = readFileSync(import.meta.path, "utf8");
    console.log(
      source
        .slice(source.indexOf("/**") + 3, source.indexOf("*/"))
        .replace(/^ ?\* ?/gm, "")
        .trim(),
    );
    process.exit(0);
  }
  if (!existsSync(join(repositoryRoot, "docker-compose.yml"))) {
    console.error("Run from a checkout of this repository.");
    process.exit(64);
  }
  try {
    parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("See: bun scripts/upgrade-e2e.ts --help");
    process.exit(64);
  }
  process.exit(await main());
}
