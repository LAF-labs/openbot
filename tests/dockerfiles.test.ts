import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * What the images are built from, and what goes into them.
 *
 * Both were measured wrong on 2026-09-10 (audit A7, S2-4 and S2-5). Every base image was named by
 * tag alone, and `caddy:2-alpine` floats across every 2.x minor: a VM opened next month would get a
 * front door no test here had seen. And the server image installed every workspace's production
 * and development dependencies — 1.95 GB, of which the server's own closure was 392 MB — and
 * shipped the test files beside them.
 */

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const dockerfiles = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => join(entry.name, "Dockerfile"))
  .filter((path) => existsSync(join(root, path)));

/**
 * Every image a Dockerfile pulls: each `FROM`, and each `COPY --from=` that names a registry
 * image rather than a stage declared earlier in the same file. `scratch` is not an image.
 */
function pulledImages(contents: string): string[] {
  const stages = new Set(
    [...contents.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]),
  );
  const froms = [...contents.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]);
  const copies = [...contents.matchAll(/^COPY\s+--from=(\S+)/gim)].map(
    (m) => m[1],
  );
  return [...froms, ...copies].filter(
    (reference): reference is string =>
      !!reference && reference !== "scratch" && !stages.has(reference),
  );
}

describe("the base images", () => {
  test("are the five the workflow builds", () => {
    expect(dockerfiles.sort()).toEqual([
      "agent-bot/Dockerfile",
      "agent-computer/Dockerfile",
      "app/Dockerfile",
      "deploy/Dockerfile",
      "server/Dockerfile",
    ]);
  });

  test("are every one pinned by digest, with the tag still readable beside it", () => {
    let pinned = 0;
    for (const path of dockerfiles) {
      for (const reference of pulledImages(read(path))) {
        // `name:tag@sha256:…` — the tag is for the person reading, the digest is what is pulled.
        // A digest alone would satisfy Docker and tell nobody what it was.
        expect(
          reference,
          `${path} pulls ${reference} without a digest`,
        ).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
        pinned += 1;
      }
    }
    // Asserted so a regex that matches nothing cannot pass: bun ×3 (server twice, app), caddy,
    // bun-alpine, playwright, and the bun copied into the computer image.
    expect(pinned).toBeGreaterThanOrEqual(6);
  });

  /**
   * One digest per tag across the repository. The server's two stages and the computer's bun copy
   * all name `oven/bun:1.3.14`; three different digests for one tag would be three different bun
   * builds with one name, which is the drift the pin exists to end.
   */
  test("resolve one tag to one digest everywhere it is used", () => {
    const seen = new Map<string, string>();
    for (const path of dockerfiles) {
      for (const reference of pulledImages(read(path))) {
        const [tagged, digest] = reference.split("@");
        if (!tagged || !digest) continue;
        const before = seen.get(tagged);
        expect(before ?? digest, `${tagged} is pinned to two digests`).toBe(
          digest,
        );
        seen.set(tagged, digest);
      }
    }
  });
});

describe("the server image", () => {
  const dockerfile = read("server/Dockerfile");

  test("installs this workspace's production dependencies and nothing beside them", () => {
    expect(dockerfile).toContain(
      "bun install --frozen-lockfile --filter=server --production",
    );
    // Two stages: the install happens in one that is thrown away. A single-stage image keeps
    // bun's download cache and the lockfile of every workspace beside the server.
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(2);
    expect(dockerfile).toContain("COPY --from=install /app/node_modules");
    expect(dockerfile).toContain(
      "COPY --from=install /app/server/node_modules",
    );
  });

  /**
   * The `migrate` service runs `bun x drizzle-kit` from THIS image (docker-compose.yml), so the
   * migrator is a production dependency of the image whatever it is to a developer. Listed as a
   * devDependency it would be exactly what `--production` leaves behind, and the first deployment
   * would fail at its migration step.
   */
  test("carries the migrator the compose file runs from it", () => {
    const manifest = JSON.parse(read("server/package.json")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies["drizzle-kit"]).toBeDefined();
    expect(manifest.devDependencies?.["drizzle-kit"]).toBeUndefined();

    // The compose file runs it through server/scripts/migrate.ts, which reads the ledger first and
    // hands anything behind to drizzle-kit, so the image must carry that script too.
    const compose = read("docker-compose.yml");
    expect(compose).toContain('command: ["bun", "scripts/migrate.ts"]');
    expect(read("server/scripts/migrate.ts")).toContain(
      '"drizzle-kit", "migrate", "--config=drizzle.config.ts"',
    );
    expect(read("server/Dockerfile")).toContain(
      "COPY server/scripts/migrate.ts server/scripts/migrate.ts",
    );
  });

  /**
   * The server starts from one bundle, not from ~2,500 TS modules: the start is the `/health` 502
   * window of every upgrade, and the bundle cut it from 27 s to 9 s on a loaded host (the comment
   * above the build line has the measurement).
   */
  test("runs the bundle it builds, not the sources", () => {
    expect(dockerfile).toContain(
      "RUN bun build server/src/index.ts --target=bun --outfile server/dist/index.js",
    );
    expect(dockerfile).toContain(
      "COPY --from=install /app/server/dist server/dist",
    );
    expect(dockerfile).toContain('CMD ["bun", "dist/index.js"]');
  });

  test("copies the sources and the migrations, not the tests or the scripts", () => {
    expect(dockerfile).toContain("COPY server/src server/src");
    expect(dockerfile).toContain("COPY server/drizzle server/drizzle");
    expect(dockerfile).toContain("server/drizzle.config.ts");
    // The one line that used to bring everything: `COPY server server`.
    expect(dockerfile).not.toMatch(/^COPY server server\b/m);
    // Instructions, not prose: the file is allowed to SAY what it leaves out.
    expect(dockerfile).not.toMatch(/^COPY .*server\/tests/m);
    // Of the scripts, only the `migrate` service's command, which runs from this image.
    expect(
      dockerfile
        .split("\n")
        .filter((line) => /^COPY .*server\/scripts/.test(line)),
    ).toEqual(["COPY server/scripts/migrate.ts server/scripts/migrate.ts"]);
  });
});

/**
 * Which build an image is, baked in where the image can read it.
 *
 * `GET /api/version` and the `boot` log line answer from `GIT_SHA` and `BUILD_CHANNEL`
 * (`shared/log.ts`, `buildOf`). Those reach the image only if the Dockerfile declares the build
 * args AND the workflow passes them — either half alone is a version endpoint that says `source`
 * on every VM, which is what it said until 2026-09-10 without anybody noticing, because it looked
 * exactly like a version endpoint.
 */
describe("the build baked into the images", () => {
  const workflow = read(".github/workflows/images.yml");

  test("is declared by the images that answer for it", () => {
    for (const path of ["server/Dockerfile", "agent-bot/Dockerfile"]) {
      const contents = read(path);
      expect(contents).toMatch(/^ARG REVISION=/m);
      expect(contents).toMatch(/^ARG CHANNEL=/m);
      expect(contents).toContain("GIT_SHA=${REVISION}");
      expect(contents).toContain("BUILD_CHANNEL=${CHANNEL}");
    }
  });

  test("is passed by the workflow that publishes them", () => {
    // The per-arch build step. The deploy bundle's step passes the same two into its VERSION file.
    expect(workflow.match(/--build-arg REVISION="\$REVISION"/g)).toHaveLength(
      2,
    );
    expect(workflow.match(/--build-arg CHANNEL="\$CHANNEL"/g)).toHaveLength(2);
  });
});

/**
 * A digest is a thing nobody re-reads by hand, so every directory that pins one has to be watched
 * by the docker entry in `.github/dependabot.yml` — otherwise the pin is a freeze, and a freeze on
 * the front door is a CVE with a date on it.
 */
describe("what re-pins the base images", () => {
  type Update = {
    "package-ecosystem": string;
    directory?: string;
    directories?: string[];
    schedule?: { interval?: string };
  };
  const updates = (
    parse(read(".github/dependabot.yml")) as { updates: Update[] }
  ).updates;

  const watched = (ecosystem: string) =>
    updates
      .filter((update) => update["package-ecosystem"] === ecosystem)
      .flatMap((update) => [
        ...(update.directory ? [update.directory] : []),
        ...(update.directories ?? []),
      ]);

  test("is a docker entry for every directory whose Dockerfile pulls an image", () => {
    const docker = watched("docker");
    for (const path of dockerfiles) {
      if (pulledImages(read(path)).length === 0) continue;
      const directory = `/${path.replace(/\/Dockerfile$/, "")}`;
      expect(docker, `${path} is pinned but not watched`).toContain(directory);
    }
  });

  test("covers the manifests, the shell's crates and the workflows as well", () => {
    // `bun`, not `npm`: the only lockfile here is bun.lock, which the npm updater does not read.
    // Measured: a week of `npm` produced no pull request and no run.
    expect(watched("bun")).toEqual(["/"]);
    expect(watched("npm")).toEqual([]);
    expect(watched("cargo")).toEqual(["/desktop/src-tauri"]);
    expect(watched("github-actions")).toEqual(["/"]);
  });

  test("runs every ecosystem weekly", () => {
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.schedule?.interval).toBe("weekly");
    }
  });
});
