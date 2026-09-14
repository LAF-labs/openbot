import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * `scripts/upgrade.sh` without a deployment.
 *
 * Nothing watched this script until 2026-09-10: audit A6 §2 put `cp .env.example .env` after its
 * dump line and the whole root group stayed green, 114 of 114. It is the one script that runs
 * beside a customer's `.env`, at 2am, with nobody reading — so what it must never do (write that
 * file, stop anything before the new images are on disk, print the unsafe restore) is asserted
 * here the way `restore-script.test.ts` asserts its sibling: a fake `docker` ahead of the real one
 * on PATH, recording every call and answering by scenario, in a temporary directory shaped like a
 * deployment (the bundle's files plus a `.env`), since the script takes its directory from its
 * own path and a deployment directory is exactly that.
 */

const root = join(import.meta.dir, "..");

/** The head of what `pg_dump` writes — enough for `restore.sh` to accept the file as a dump. */
const dumpText = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "SET statement_timeout = 0;",
  "",
].join("\n");

/**
 * Bytes a script that "does not touch .env" must leave exactly: no trailing newline, a CRLF in the
 * middle, a comment, and a value with a `$` in it, so a rewrite through any shell path would show.
 */
const envBytes = Buffer.from(
  "# a deployment\r\nIMAGE_TAG=stable\nKEY_ENCRYPTION_KEY=abc$def=\nBOT_MODEL=x/y",
);

type Scenario = {
  /** What the shimmed `pg_dump` prints; empty is the "database answered nothing" case. */
  dump?: string;
  pullFails?: boolean;
  migrateFails?: boolean;
  healthy?: boolean;
};

/**
 * One deployment directory per run: the script and its sibling copied under `scripts/`, a `.env`,
 * and a `docker` on PATH that logs `compose …` calls to `calls` and answers by scenario.
 */
const deployment = (scenario: Scenario = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "laf-upgrade-"));
  mkdirSync(join(dir, "scripts"));
  for (const name of ["upgrade.sh", "restore.sh"]) {
    copyFileSync(join(root, "scripts", name), join(dir, "scripts", name));
    chmodSync(join(dir, "scripts", name), 0o755);
  }
  writeFileSync(join(dir, ".env"), envBytes);
  const shims = join(dir, "shims");
  mkdirSync(shims);
  const calls = join(dir, "calls");
  const dump = scenario.dump ?? dumpText;
  writeFileSync(
    join(shims, "docker"),
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  "compose exec -T postgres pg_dump"*) printf '%s' '${dump}'; exit 0 ;;
  "compose images"*) echo "openbot-server-1 ghcr.io/laf-labs/openbot-server stable sha256:before"; exit 0 ;;
  "compose pull"*) ${scenario.pullFails ? 'echo "Error response from daemon: denied" >&2; exit 1' : "exit 0"} ;;
  "compose up -d"*) ${scenario.migrateFails ? 'echo "dependency failed to start: container laf-migrate-1 exited (1)" >&2; exit 1' : "exit 0"} ;;
  "compose ps -a --format {{.ExitCode}} migrate") echo ${scenario.migrateFails ? 1 : 0}; exit 0 ;;
  "compose exec -T server bun -e"*) ${scenario.healthy ? 'echo \'{"status":"ok"}\'; exit 0' : 'echo \'{"status":"degraded","checks":{"database":"down"}}\'; exit 1'} ;;
  "compose ps"*|"compose logs"*) echo "(compose $2)"; exit 0 ;;
  *) echo "unexpected docker call: $*" >&2; exit 97 ;;
esac
`,
  );
  chmodSync(join(shims, "docker"), 0o755);
  return { dir, shims, calls, backups: join(dir, "backups") };
};

const run = (
  space: ReturnType<typeof deployment>,
  env: Record<string, string> = {},
) => {
  const proc = Bun.spawnSync(
    ["bash", join(space.dir, "scripts", "upgrade.sh")],
    {
      cwd: space.dir,
      env: {
        ...process.env,
        PATH: `${space.shims}:${process.env.PATH ?? ""}`,
        BACKUP_DIR: space.backups,
        // Zero: probe /health once and do not sleep. The wait loop is "at least one probe, no sleep
        // after the last", so a deployment that is healthy on the first ask is still found healthy.
        HEALTH_TIMEOUT: "0",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const calls = existsSync(space.calls)
    ? readFileSync(space.calls, "utf8").trim().split("\n")
    : [];
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    calls,
    /** The `compose <verb>` of each call, in order. */
    verbs: calls.map((line) => line.split(" ").slice(0, 2).join(" ")),
    env: existsSync(join(space.dir, ".env"))
      ? readFileSync(join(space.dir, ".env"))
      : Buffer.alloc(0),
    dumps: existsSync(space.backups)
      ? readdirSync(space.backups).filter((name) => name.endsWith(".sql.gz"))
      : [],
  };
};

/** The verbs that would take a running deployment down; the script must never utter them. */
const stopping = [
  "compose stop",
  "compose down",
  "compose restart",
  "compose rm",
];

describe("scripts/upgrade.sh", () => {
  test("is executable and parses", () => {
    const script = join(root, "scripts", "upgrade.sh");
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const parse = Bun.spawnSync(["bash", "-n", script], { stderr: "pipe" });
    expect(parse.stderr.toString()).toBe("");
    expect(parse.exitCode).toBe(0);
  });

  test("a good upgrade: dump, pull, up, /health — in that order, stopping nothing, .env byte for byte", () => {
    const space = deployment({ healthy: true });
    const result = run(space);

    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Healthy.");

    // The pull is before `up`, which is the only call that replaces anything; and nothing is ever
    // stopped by hand, whatever happens.
    expect(result.verbs).toEqual([
      "compose exec", // pg_dump
      "compose images",
      "compose pull",
      "compose up",
      "compose ps", // migrate's exit code
      "compose exec", // /health
      "compose ps",
    ]);
    for (const verb of stopping) expect(result.verbs).not.toContain(verb);

    expect(Buffer.compare(result.env, envBytes)).toBe(0);

    // The dump is the database's bytes, gzipped, under the name restore.sh looks for.
    expect(result.dumps).toHaveLength(1);
    expect(result.dumps[0]).toMatch(/^laf-\d{8}T\d{6}Z\.sql\.gz$/);
    const written = gunzipSync(
      readFileSync(join(space.backups, result.dumps[0] as string)),
    ).toString();
    expect(written).toBe(dumpText);
  });

  test("a failed pull stops before anything is replaced, says so, and leaves .env alone", () => {
    const space = deployment({ pullFails: true });
    const result = run(space);

    expect(result.code).not.toBe(0);
    expect(result.err).toContain(
      "The pull failed. Nothing was stopped or replaced",
    );
    expect(result.verbs.at(-1)).toBe("compose pull");
    expect(result.verbs).not.toContain("compose up");
    for (const verb of stopping) expect(result.verbs).not.toContain(verb);
    expect(Buffer.compare(result.env, envBytes)).toBe(0);
    // The dump it took is named, so the run left something behind and says what.
    expect(result.err).toContain(space.backups);
  });

  test("an empty dump refuses before the pull", () => {
    const space = deployment({ dump: "" });
    const result = run(space);

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("The dump is empty");
    expect(result.verbs).not.toContain("compose pull");
    expect(result.verbs).not.toContain("compose up");
    expect(Buffer.compare(result.env, envBytes)).toBe(0);
  });

  test("no .env: not a deployment, nothing dialled", () => {
    const space = deployment();
    unlinkSync(join(space.dir, ".env"));
    const result = run(space);

    expect(result.code).toBe(1);
    expect(result.err).toContain("No .env here");
    expect(result.calls).toEqual([]);
  });

  test("not healthy: the rollback it prints restores BESIDE the live database, never into it", () => {
    const space = deployment({ healthy: false });
    const result = run(space);

    expect(result.code).toBe(1);
    expect(result.err).toContain("NOT HEALTHY after 0s");
    expect(result.err).toContain(
      "IMAGE_TAG=<previous version> docker compose pull",
    );
    // .env said IMAGE_TAG=stable, a channel that has moved, so the inventory file is the answer.
    expect(result.err).toContain("which is a channel that has already moved");
    expect(result.err).toContain(".images.txt");

    // The safe form, with the dump this run took, and the reading instruction beside it.
    const dump = join(space.backups, result.dumps[0] as string);
    expect(result.err).toContain(`scripts/restore.sh ${dump} --replace`);
    expect(result.err).toContain("Read the counts before you type");
    // The unsafe form, in any spelling: restore.sh's own header names it as the thing to avoid.
    expect(result.err).not.toContain("zcat");
    expect(result.err).not.toContain("psql -U openbot openbot");
    expect(result.err).not.toMatch(
      /psql[^\n]*\bopenbot\b[^\n]*<|\|\s*docker compose exec -T postgres psql/,
    );

    for (const verb of stopping) expect(result.verbs).not.toContain(verb);
    expect(Buffer.compare(result.env, envBytes)).toBe(0);

    // And the line it printed is one restore.sh accepts: the same dump, through the same shim,
    // reaches the plan and dials nothing on --dry-run.
    const rehearsal = Bun.spawnSync(
      [
        "bash",
        join(space.dir, "scripts", "restore.sh"),
        dump,
        "--replace",
        "--dry-run",
      ],
      {
        cwd: space.dir,
        env: {
          ...process.env,
          PATH: `${space.shims}:${process.env.PATH ?? ""}`,
          PG_URL: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(rehearsal.stderr.toString()).toBe("");
    expect(rehearsal.exitCode).toBe(0);
    expect(rehearsal.stdout.toString()).toContain("then REPLACED: --replace");
  });

  test("a failed migration is named, with its log, and the API's absence is said — before any health wait", () => {
    const space = deployment({ migrateFails: true, healthy: true });
    const result = run(space, { HEALTH_TIMEOUT: "180" });

    expect(result.code).toBe(1);
    expect(result.out).toContain("THE MIGRATION FAILED (migrate exited 1)");
    expect(result.out).toContain("front door is up and answers 503 (down)");
    expect(result.err).toContain("The schema is where it was");
    expect(
      result.calls.some((line) => line.startsWith("compose logs migrate")),
    ).toBe(true);
    // No /health probe: there is no API to ask, and 180s of asking would say nothing new.
    expect(
      result.calls.filter((line) => line.includes("localhost:3001/health")),
    ).toEqual([]);
    expect(result.err).toContain("scripts/restore.sh ");
    expect(result.err).not.toContain("zcat");
    for (const verb of stopping) expect(result.verbs).not.toContain(verb);
    expect(Buffer.compare(result.env, envBytes)).toBe(0);
  });

  test("a pinned deployment is told its own tag back", () => {
    const space = deployment({ healthy: false });
    writeFileSync(join(space.dir, ".env"), "IMAGE_TAG=v0.4.1\n");
    const result = run(space);

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "This deployment was on IMAGE_TAG=v0.4.1 before this run",
    );
    expect(readFileSync(join(space.dir, ".env"), "utf8")).toBe(
      "IMAGE_TAG=v0.4.1\n",
    );
  });

  test("the operator's document says what the script prints on failure", () => {
    const deploying = readFileSync(
      join(root, "docs", "laf", "deploying.md"),
      "utf8",
    );
    expect(deploying).toContain("scripts/upgrade.sh");
    expect(deploying).toContain("scripts/restore.sh <dump> --replace");
    expect(deploying).toContain("dependency failed to start");
  });
});
