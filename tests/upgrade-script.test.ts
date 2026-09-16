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
 *
 * AND WHAT IT PRINTS MUST WORK WHEN RUN. Until 2026-09-16 this file checked that the rollback line
 * was printed, and the line did not roll back: `IMAGE_TAG=<v> docker compose pull && docker compose
 * up -d` hands the tag to the pull only, and the `up -d` read .env and restarted the images that had
 * just failed (audit 2026-09-16, R6 F6). So the fake resolves IMAGE_TAG for each call the way compose
 * does — measured against compose 5.1.1 — and records it, and the printed rollback is run as printed.
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

/** The commit the running images were built from, as images.yml stamps it on every image. */
const RUNNING_REVISION = "1ecd51ffa1045d90d2b9a50a4a2ece30e33c5129";

/**
 * What every run starts from: this process's environment without any IMAGE_TAG it exports. The
 * script refuses one that disagrees with .env, and a developer's shell is not what these cases are.
 */
const { IMAGE_TAG: _exported, ...inherited } = process.env;

type Scenario = {
  /** What the shimmed `pg_dump` prints; empty is the "database answered nothing" case. */
  dump?: string;
  pullFails?: boolean;
  migrateFails?: boolean;
  healthy?: boolean;
  /** The tag the running containers were created from, and the revision their images carry. */
  running?: { tag: string; revision: string };
  /** The deployment's VERSION file; null for a directory without one. */
  version?: string | null;
};

/**
 * One deployment directory per run: the script and its sibling copied under `scripts/`, a `.env`, a
 * `VERSION`, and a `docker` on PATH that logs every call to `calls`, logs the tag each pull and `up`
 * would take to `tags`, and answers by scenario.
 */
const deployment = (scenario: Scenario = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "laf-upgrade-"));
  mkdirSync(join(dir, "scripts"));
  for (const name of ["upgrade.sh", "restore.sh"]) {
    copyFileSync(join(root, "scripts", name), join(dir, "scripts", name));
    chmodSync(join(dir, "scripts", name), 0o755);
  }
  writeFileSync(join(dir, ".env"), envBytes);
  const version =
    scenario.version === undefined
      ? `revision=${RUNNING_REVISION}\nchannel=edge\n`
      : scenario.version;
  if (version !== null) writeFileSync(join(dir, "VERSION"), version);
  const shims = join(dir, "shims");
  mkdirSync(shims);
  const calls = join(dir, "calls");
  const tags = join(dir, "tags");
  const dump = scenario.dump ?? dumpText;
  const running = scenario.running ?? {
    tag: "stable",
    revision: RUNNING_REVISION,
  };
  writeFileSync(
    join(shims, "docker"),
    `#!/bin/sh
echo "$*" >> "${calls}"
# The tag compose would take for this call: the environment's when IMAGE_TAG is set there at all
# (empty is stable), otherwise the last IMAGE_TAG line of .env, otherwise stable. Measured against
# compose 5.1.1. A tag that came from the environment is marked, so a case can tell the two apart.
if [ -n "\${IMAGE_TAG+set}" ]; then
  tag="\${IMAGE_TAG:-stable}"
else
  tag="$(sed -n 's/^IMAGE_TAG=//p' .env 2>/dev/null | tail -n 1 | tr -d '\\r' | sed -e 's/^"\\(.*\\)"$/\\1/')"
  tag="\${tag:-stable}"
fi
case "$*" in
  "compose pull"*|"compose up"*) echo "$2 $tag\${IMAGE_TAG+ (shell)}" >> "${tags}" ;;
esac
case "$*" in
  "compose exec -T postgres pg_dump"*) printf '%s' '${dump}'; exit 0 ;;
  "compose ps -aq") printf 'c-server\\nc-web\\nc-postgres\\n'; exit 0 ;;
  "container inspect --format "*" c-server c-web c-postgres")
    echo "server ghcr.io/laf-labs/openbot-server:${running.tag} revision=${running.revision} image=sha256:5e1"
    echo "web ghcr.io/laf-labs/openbot-web:${running.tag} revision=${running.revision} image=sha256:3eb"
    echo "postgres postgres:17 revision=(none) image=sha256:9a5"
    exit 0 ;;
  "compose images"*) echo "openbot-server-1 ghcr.io/laf-labs/openbot-server stable sha256:before"; exit 0 ;;
  "compose pull"*) ${scenario.pullFails ? 'echo "Error response from daemon: denied" >&2; exit 1' : 'case "$tag" in vX.Y.Z) echo "manifest unknown: ghcr.io/laf-labs/openbot-server:vX.Y.Z" >&2; exit 1 ;; esac; exit 0'} ;;
  "compose up -d"*) ${scenario.migrateFails ? 'echo "dependency failed to start: container laf-migrate-1 exited (1)" >&2; exit 1' : "exit 0"} ;;
  "compose ps -a --format {{.ExitCode}} migrate") echo ${scenario.migrateFails ? 1 : 0}; exit 0 ;;
  "compose exec -T server bun -e"*) ${scenario.healthy ? 'echo \'{"status":"ok"}\'; exit 0' : 'echo \'{"status":"degraded","checks":{"database":"down"}}\'; exit 1'} ;;
  "compose ps"*|"compose logs"*) echo "(compose $2)"; exit 0 ;;
  *) echo "unexpected docker call: $*" >&2; exit 97 ;;
esac
`,
  );
  chmodSync(join(shims, "docker"), 0o755);
  return { dir, shims, calls, tags, backups: join(dir, "backups") };
};

type Space = ReturnType<typeof deployment>;

const lines = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];

const run = (space: Space, env: Record<string, string> = {}) => {
  const proc = Bun.spawnSync(
    ["bash", join(space.dir, "scripts", "upgrade.sh")],
    {
      cwd: space.dir,
      env: {
        ...inherited,
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
  const calls = lines(space.calls);
  const backups = existsSync(space.backups) ? readdirSync(space.backups) : [];
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    calls,
    /** The first two words of each call, in order: `compose pull`, `container inspect`. */
    verbs: calls.map((line) => line.split(" ").slice(0, 2).join(" ")),
    /** `<pull|up> <tag>` for each call that takes a tag, marked `(shell)` when the tag was exported. */
    tags: lines(space.tags),
    env: existsSync(join(space.dir, ".env"))
      ? readFileSync(join(space.dir, ".env"))
      : Buffer.alloc(0),
    dumps: backups.filter((name) => name.endsWith(".sql.gz")),
    inventories: backups
      .filter((name) => name.endsWith(".images.txt"))
      .map((name) => readFileSync(join(space.backups, name), "utf8")),
  };
};

/** A line as an operator pastes it: bash, in the deployment directory, the fake docker first. */
const paste = (
  space: Space,
  command: string,
  env: Record<string, string> = {},
) => {
  if (existsSync(space.tags)) unlinkSync(space.tags);
  const proc = Bun.spawnSync(["bash", "-c", command], {
    cwd: space.dir,
    env: {
      ...inherited,
      PATH: `${space.shims}:${process.env.PATH ?? ""}`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, tags: lines(space.tags) };
};

/** The two lines of a printed rollback a person acts on: the `.env` line, and the command. */
const printedRollback = (err: string) => ({
  pin: err.match(/^\s*(IMAGE_TAG=\S+)\s*$/m)?.[1],
  command: err.match(
    /^\s*(export IMAGE_TAG=\S+; docker compose pull && docker compose up -d)\s*$/m,
  )?.[1],
});

/**
 * The rollback that did not roll back, in any spelling: a tag written in front of the pull, which
 * reaches the pull alone. `export IMAGE_TAG=…; docker compose pull` is not it — the `;` ends the
 * assignment as a command of its own.
 */
const tagInFrontOfThePull =
  /IMAGE_TAG=(?:<[^>\n]*>|[^;\s]+) docker compose pull/;

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

  test("a good upgrade: dump, record, pull, up, /health — in that order, stopping nothing, .env byte for byte", () => {
    const space = deployment({ healthy: true });
    const result = run(space);

    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Healthy.");

    // The pull is before `up`, which is the only call that replaces anything; and nothing is ever
    // stopped by hand, whatever happens.
    expect(result.verbs).toEqual([
      "compose exec", // pg_dump
      "compose ps", // the containers, for the record
      "container inspect", // what each was created from, and its revision
      "compose images",
      "compose pull",
      "compose up",
      "compose ps", // migrate's exit code
      "compose exec", // /health
      "compose ps",
    ]);
    for (const verb of stopping) expect(result.verbs).not.toContain(verb);
    // Both calls that move images took .env's tag, from .env.
    expect(result.tags).toEqual(["pull stable", "up stable"]);

    expect(Buffer.compare(result.env, envBytes)).toBe(0);

    // The dump is the database's bytes, gzipped, under the name restore.sh looks for.
    expect(result.dumps).toHaveLength(1);
    expect(result.dumps[0]).toMatch(/^laf-\d{8}T\d{6}Z\.sql\.gz$/);
    const written = gunzipSync(
      readFileSync(join(space.backups, result.dumps[0] as string)),
    ).toString();
    expect(written).toBe(dumpText);
  });

  test("the record beside the dump keeps VERSION and every container's image and revision", () => {
    /*
     * A tag and a short image id are not a version, and `stable` has moved by the time anybody reads
     * the file (audit 2026-09-16, R6 F6). What a version is read from is kept instead: the bundle's
     * VERSION as the run found it, and for each container the image it was created from and the
     * commit that image was built from.
     */
    const space = deployment({
      healthy: true,
      version:
        "revision=0e08817b26316f72d17ed2384dfe7a3bec306429\nchannel=v0.5.2\n",
    });
    const result = run(space);

    expect(result.code).toBe(0);
    expect(result.inventories).toHaveLength(1);
    const record = result.inventories[0] as string;
    expect(record).toContain("IMAGE_TAG in .env when it began: stable");
    expect(record).toContain(
      "revision=0e08817b26316f72d17ed2384dfe7a3bec306429\nchannel=v0.5.2\n",
    );
    expect(record).toContain(
      `server ghcr.io/laf-labs/openbot-server:stable revision=${RUNNING_REVISION} image=sha256:5e1`,
    );
    expect(record).toContain(
      `web ghcr.io/laf-labs/openbot-web:stable revision=${RUNNING_REVISION} image=sha256:3eb`,
    );
    expect(record).toContain("postgres postgres:17 revision=(none)");
    // compose's own table is still there, for the person who knows it.
    expect(record).toContain(
      "openbot-server-1 ghcr.io/laf-labs/openbot-server stable sha256:before",
    );
    // The revision is the label images.yml writes, asked of the containers compose listed.
    const inspect = result.calls.find((call) =>
      call.startsWith("container inspect"),
    );
    expect(inspect).toContain(
      '.Config.Labels "org.opencontainers.image.revision"',
    );
    expect(inspect).toEndWith(" c-server c-web c-postgres");
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
    // What ran is on the screen, from the record, with the record's name.
    expect(result.err).toContain(".images.txt");
    expect(result.err).toContain(
      `server ghcr.io/laf-labs/openbot-server:stable revision=${RUNNING_REVISION}`,
    );
    expect(result.err).toContain(`revision=${RUNNING_REVISION}\n`);
    expect(result.err).not.toMatch(tagInFrontOfThePull);

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
});

describe("the way back it prints", () => {
  /**
   * A deployment that ran v0.4.1 and was moved to v0.4.2 the one way a version is chosen now — the
   * IMAGE_TAG line of .env — and came up unhealthy.
   */
  const movedOffARelease = () => {
    const space = deployment({
      healthy: false,
      running: { tag: "v0.4.1", revision: RUNNING_REVISION },
    });
    writeFileSync(join(space.dir, ".env"), "IMAGE_TAG=v0.4.2\n");
    return space;
  };

  test("names the release the containers ran, whatever .env names now", () => {
    const space = movedOffARelease();
    const result = run(space);

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "Those images are v0.4.1, so that is the version below.",
    );
    expect(printedRollback(result.err)).toEqual({
      pin: "IMAGE_TAG=v0.4.1",
      command:
        "export IMAGE_TAG=v0.4.1; docker compose pull && docker compose up -d",
    });
    // Said, not done: .env is the operator's to change.
    expect(readFileSync(join(space.dir, ".env"), "utf8")).toBe(
      "IMAGE_TAG=v0.4.2\n",
    );
  });

  test("run as printed, it hands the old tag to the up -d as well as the pull, and .env keeps it there", () => {
    const space = movedOffARelease();
    const { err } = run(space);
    const { pin, command } = printedRollback(err);
    if (!pin || !command) {
      throw new Error(`No runnable rollback was printed:\n${err}`);
    }

    // The control, which is the bug: a tag written in front of the first command reaches that
    // command only. The fake tells the two apart, or none of the lines below would mean anything.
    expect(
      paste(
        space,
        "IMAGE_TAG=v0.4.1 docker compose pull && docker compose up -d",
      ).tags,
    ).toEqual(["pull v0.4.1 (shell)", "up v0.4.2"]);

    // Step 2 as printed, from a shell still exporting the tag that failed.
    const pasted = paste(space, command, { IMAGE_TAG: "v0.4.2" });
    expect(pasted.code).toBe(0);
    expect(pasted.tags).toEqual(["pull v0.4.1 (shell)", "up v0.4.1 (shell)"]);

    // Step 1 as printed — the IMAGE_TAG line of .env set to it — and the next `up -d` anybody runs,
    // with nothing exported at all, still starts the version that was gone back to.
    const envPath = join(space.dir, ".env");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(/^IMAGE_TAG=.*$/m, pin),
    );
    expect(paste(space, "docker compose up -d").tags).toEqual(["up v0.4.1"]);
  });

  test("a stable deployment whose VERSION is the build that ran is told that release", () => {
    // The bundle was not refreshed before this run, so VERSION still describes the running images:
    // the same revision, built for v0.5.1. `stable` itself names nothing once it has moved.
    const space = deployment({
      healthy: false,
      version: `revision=${RUNNING_REVISION}\nchannel=v0.5.1\n`,
    });
    const result = run(space);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Those images are v0.5.1");
    expect(printedRollback(result.err).command).toBe(
      "export IMAGE_TAG=v0.5.1; docker compose pull && docker compose up -d",
    );
  });

  test("with no version in the record it names none, says what to look for, and the line fails safe", () => {
    // The bundle was refreshed first, as deploying.md says, so VERSION is already the build this run
    // moved TO; the running images carry an older revision, and `stable` names neither any more.
    const space = deployment({
      healthy: false,
      version:
        "revision=0e08817b26316f72d17ed2384dfe7a3bec306429\nchannel=v0.5.2\n",
    });
    const result = run(space);

    expect(result.code).toBe(1);
    expect(result.err).toContain("None of that names a version");
    expect(result.err).toContain(`revision=${RUNNING_REVISION}`);
    expect(result.err).toContain("channel=v0.5.2");
    const { pin, command } = printedRollback(result.err);
    expect(pin).toBe("IMAGE_TAG=vX.Y.Z");
    expect(command).toBe(
      "export IMAGE_TAG=vX.Y.Z; docker compose pull && docker compose up -d",
    );

    // Pasted unfilled, the pull refuses a tag no registry has, and nothing is started.
    const pasted = paste(space, command as string);
    expect(pasted.code).not.toBe(0);
    expect(pasted.tags).toEqual(["pull vX.Y.Z (shell)"]);
  });
});

describe("an IMAGE_TAG in the environment", () => {
  test("that disagrees with .env is refused before anything is dialled", () => {
    // The usage this script's own header documented, and the one that left .env on the old tag for
    // the next `up -d` to move back to (audit 2026-09-16, R6 F6).
    const space = deployment({ healthy: true });
    const result = run(space, { IMAGE_TAG: "v0.3.2" });

    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.dumps).toEqual([]);
    expect(Buffer.compare(result.env, envBytes)).toBe(0);
    expect(result.err).toContain(
      "IMAGE_TAG is v0.3.2 in this shell and stable in .env. Refusing",
    );
    // What to do instead, in order: .env first.
    expect(result.err).toContain(
      `In ${space.dir}/.env, set the IMAGE_TAG line to IMAGE_TAG=v0.3.2`,
    );
    expect(result.err).toContain("unset IMAGE_TAG");
  });

  test("that is set but empty is stable to compose, so a pinned .env refuses it too", () => {
    // Measured: an exported empty IMAGE_TAG beats .env, and `${IMAGE_TAG:-stable}` makes it stable.
    const space = deployment({ healthy: true });
    writeFileSync(join(space.dir, ".env"), "IMAGE_TAG=v0.4.2\n");
    const result = run(space, { IMAGE_TAG: "" });

    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.err).toContain(
      "IMAGE_TAG is stable in this shell and v0.4.2 in .env",
    );
  });

  test("that agrees with .env changes nothing, and every compose call reads .env", () => {
    const space = deployment({ healthy: true });
    const result = run(space, { IMAGE_TAG: "stable" });

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    // No "(shell)": the agreeing variable was dropped before the first compose call.
    expect(result.tags).toEqual(["pull stable", "up stable"]);
    expect(Buffer.compare(result.env, envBytes)).toBe(0);
  });

  /*
   * .env read the way compose reads it. Each right-hand value is what `docker compose config`
   * (compose 5.1.1, 2026-09-16) resolved `${IMAGE_TAG:-stable}` to for that .env. A reader that gets
   * one wrong either refuses an operator whose shell agrees with compose, or lets through the very
   * disagreement this check exists for.
   */
  test.each([
    ["IMAGE_TAG=v0.4.1\n", "v0.4.1"],
    ['IMAGE_TAG="v0.4.2"\r\n', "v0.4.2"],
    ["IMAGE_TAG=v0.4.3 # pinned\n", "v0.4.3"],
    ["# nothing here\n", "stable"],
    ["IMAGE_TAG=v0.4.1\nIMAGE_TAG=v0.4.4\n", "v0.4.4"],
    ["export IMAGE_TAG=v0.6.1\n", "v0.6.1"],
    ["IMAGE_TAG = v0.6.2\n", "v0.6.2"],
    ["IMAGE_TAG=  v0.6.3  \n", "v0.6.3"],
    ["IMAGE_TAG='v0.6.4' # pinned\n", "v0.6.4"],
    ["IMAGE_TAG=v0.6.5#nospace\n", "v0.6.5#nospace"],
    ["IMAGE_TAG=\n", "stable"],
    ["  IMAGE_TAG=v0.6.6\n", "v0.6.6"],
  ])("reads %j from .env as compose does: %s", (env, compose) => {
    // An empty dump stops the run right after the check, so each case costs one short run.
    const space = deployment({ dump: "" });
    writeFileSync(join(space.dir, ".env"), env);

    const agreeing = run(space, { IMAGE_TAG: compose });
    expect(agreeing.err).not.toContain("in this shell and");
    expect(agreeing.err).toContain("The dump is empty");

    const disagreeing = run(space, { IMAGE_TAG: "v9.9.9" });
    expect(disagreeing.code).toBe(1);
    expect(disagreeing.err).toContain(
      `IMAGE_TAG is v9.9.9 in this shell and ${compose} in .env.`,
    );
  });
});

describe("the operator's document", () => {
  const deploying = readFileSync(
    join(root, "docs", "laf", "deploying.md"),
    "utf8",
  );

  test("says what the script prints on failure", () => {
    expect(deploying).toContain("scripts/upgrade.sh");
    expect(deploying).toContain("scripts/restore.sh <dump> --replace");
    expect(deploying).toContain("dependency failed to start");
  });

  test("prints the rollback the script prints, and not the one that did not roll back", () => {
    expect(deploying).toContain(
      "export IMAGE_TAG=<version>; docker compose pull && docker compose up -d",
    );
    expect(deploying).not.toMatch(tagInFrontOfThePull);
    // And moving to a version is done in .env, which the script now insists on. Read as prose,
    // whatever the paragraph's line breaks.
    expect(deploying.replace(/\s+/g, " ")).toContain(
      "An `IMAGE_TAG` in the environment that disagrees with `.env` is refused",
    );
  });
});
