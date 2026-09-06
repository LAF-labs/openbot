import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * `scripts/restore.sh` without a database.
 *
 * A shell script has no unit test of its own, and the half of it that matters most — what it does
 * BEFORE it dials anything — is exactly the half that can be tested without dialling anything. So
 * every run here has fake `docker`, `psql` and `oci` binaries ahead of the real ones on PATH; each
 * one leaves a marker and fails. A run that reaches the database shows up as the marker, whatever
 * its exit code says.
 */

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "restore.sh");

/** The first 4KB of what `pg_dump` writes, gzipped — the only proof the script asks of a dump. */
const dumpBytes = gzipSync(
  [
    "--",
    "-- PostgreSQL database dump",
    "--",
    "\\restrict fixture",
    "SET statement_timeout = 0;",
    "",
  ].join("\n"),
);

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "laf-restore-"));
  const shims = join(dir, "shims");
  mkdirSync(shims);
  const marker = join(dir, "dialled");
  for (const binary of ["docker", "psql", "oci"]) {
    const path = join(shims, binary);
    writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 99\n`);
    chmodSync(path, 0o755);
  }
  return { dir, shims, marker };
};

const run = (
  args: string[],
  options: {
    env?: Record<string, string>;
    space?: ReturnType<typeof workspace>;
  } = {},
) => {
  const space = options.space ?? workspace();
  const proc = Bun.spawnSync(["bash", script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${space.shims}:${process.env.PATH ?? ""}`,
      // A laptop's environment must not leak into the run: the defaults under test are the
      // script's own.
      BACKUP_DIR: join(space.dir, "no-such-backups"),
      PG_URL: "",
      OFFSITE_BUCKET: "",
      LIVE_DB: "",
      RESTORE_DB: "",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    dialled: existsSync(space.marker),
    space,
  };
};

describe("scripts/restore.sh", () => {
  test("is executable and parses", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const parse = Bun.spawnSync(["bash", "-n", script], { stderr: "pipe" });
    expect(parse.stderr.toString()).toBe("");
    expect(parse.exitCode).toBe(0);
  });

  test("dry run: names the dump and both databases, and dials nothing", () => {
    const space = workspace();
    const dump = join(space.dir, "laf-20260905-0400.sql.gz");
    writeFileSync(dump, dumpBytes);

    const result = run([dump, "--dry-run"], { space });

    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain(dump);
    expect(result.out).toContain("Into:     openbot_restore");
    expect(result.out).toContain(
      "Against:  openbot (row counts only; not touched)",
    );
    expect(result.out).toContain("DRY RUN");
    expect(result.out).toContain("never written");
    expect(result.dialled).toBe(false);
  });

  test("dry run with --replace still dials nothing, and says what the swap would be", () => {
    const space = workspace();
    const dump = join(space.dir, "d.sql.gz");
    writeFileSync(dump, dumpBytes);

    const result = run([dump, "--dry-run", "--replace"], { space });

    expect(result.code).toBe(0);
    expect(result.out).toContain("then REPLACED: --replace");
    expect(result.out).toContain(
      "rename openbot to openbot_before_restore_<stamp>",
    );
    expect(result.out).toContain("rename openbot_restore to openbot");
    expect(result.dialled).toBe(false);
  });

  test("`latest` is the newest laf-*.sql.gz in BACKUP_DIR, by modification time", () => {
    const space = workspace();
    const backups = join(space.dir, "backups");
    mkdirSync(backups);
    const older = join(backups, "laf-20260901-0400.sql.gz");
    const newer = join(backups, "laf-20260830-0400.sql.gz");
    writeFileSync(older, dumpBytes);
    writeFileSync(newer, dumpBytes);
    // The names are deliberately in the wrong order: the newest FILE wins, not the biggest name,
    // because a dump copied back from the bucket carries the bucket's name and today's mtime.
    utimesSync(
      older,
      new Date("2026-09-01T04:00:00Z"),
      new Date("2026-09-01T04:00:00Z"),
    );
    utimesSync(
      newer,
      new Date("2026-09-05T04:00:00Z"),
      new Date("2026-09-05T04:00:00Z"),
    );

    const result = run(["latest", "--dry-run"], {
      space,
      env: { BACKUP_DIR: backups },
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      `Dump:     ${newer} (the newest laf-*.sql.gz in ${backups})`,
    );
    expect(result.dialled).toBe(false);
  });

  test("`latest` with OFFSITE_BUCKET is the operator's path: the dry run describes it without the oci CLI", () => {
    const result = run(["latest", "--dry-run"], {
      env: { OFFSITE_BUCKET: "laf-backup-probe" },
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain("the newest object in laf-backup-probe");
    // The shimmed `oci` was never run: a dry run promises to open nothing, the bucket included.
    expect(result.dialled).toBe(false);
  });

  test("refuses before dialling: a dump that is not a pg_dump, a missing dump, no dump at all", () => {
    const space = workspace();
    const notADump = join(space.dir, "laf-x.sql.gz");
    writeFileSync(notADump, gzipSync("hello\n"));

    const wrong = run([notADump, "--dry-run"], { space });
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain("does not decompress to a pg_dump");
    expect(wrong.dialled).toBe(false);

    const missing = run([join(space.dir, "absent.sql.gz")], { space });
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("No such dump");
    expect(missing.dialled).toBe(false);

    const none = run([], { space });
    expect(none.code).toBe(64);
    expect(none.err).toContain("scripts/restore.sh <dump.sql.gz>");
    expect(none.dialled).toBe(false);

    const empty = run(["latest"], { space });
    expect(empty.code).not.toBe(0);
    expect(empty.err).toContain("No laf-*.sql.gz in");
    expect(empty.dialled).toBe(false);
  });

  test("refuses names before dialling: the same name on both sides, and a name that is not a name", () => {
    const space = workspace();
    const dump = join(space.dir, "d.sql.gz");
    writeFileSync(dump, dumpBytes);

    const same = run([dump], {
      space,
      env: { LIVE_DB: "openbot", RESTORE_DB: "openbot" },
    });
    expect(same.code).not.toBe(0);
    expect(same.err).toContain("both 'openbot'");
    expect(same.dialled).toBe(false);

    const injected = run([dump], {
      space,
      env: { RESTORE_DB: 'x"; drop database openbot; --' },
    });
    expect(injected.code).not.toBe(0);
    expect(injected.err).toContain(
      "is not a database name this script will use",
    );
    expect(injected.dialled).toBe(false);

    const queried = run([dump], {
      space,
      env: { PG_URL: "postgres://u:p@localhost:5432/postgres?sslmode=require" },
    });
    expect(queried.code).not.toBe(0);
    expect(queried.err).toContain("query string");
    expect(queried.dialled).toBe(false);
  });

  test("past the dry run, the first thing it does is ask Postgres — and stops when Postgres is not there", () => {
    const space = workspace();
    const dump = join(space.dir, "d.sql.gz");
    writeFileSync(dump, dumpBytes);

    const result = run([dump], { space });

    // The shim answered the first psql with exit 99, and the script did not go on.
    expect(result.code).not.toBe(0);
    expect(result.dialled).toBe(true);
    const dialled = readFileSync(space.marker, "utf8").trim().split("\n");
    expect(dialled).toHaveLength(1);
    expect(dialled[0]).toContain("docker compose exec -T postgres psql");
    expect(dialled[0]).toContain("pg_database");
    expect(result.out).not.toContain("Restoring into");
  });

  test("the operator's document says how to drill with it", () => {
    const deploying = readFileSync(
      join(root, "docs", "laf", "deploying.md"),
      "utf8",
    );
    expect(deploying).toContain("scripts/restore.sh latest");
    expect(deploying).toContain("--replace");
    expect(deploying).toContain("--fresh");
    expect(deploying).toContain("openbot_restore");
  });
});
