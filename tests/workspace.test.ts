import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function packageManifest(path: string) {
  return JSON.parse(
    readFileSync(join(repositoryRoot, path, "package.json"), "utf8"),
  ) as {
    name: string;
    scripts?: Record<string, string>;
  };
}

describe("LAF Agent workspace", () => {
  test("defines the app, server, both agents and the desktop packages", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces: string[] };

    /*
     * Pinned, so a new workspace is a decision and not a side effect of a stray package.json.
     * `desktop` is the installable shell (Tauri): a window onto the deployed origin, holding no
     * product logic, which is why it is a workspace and not a fifth runtime.
     *
     * `agent-computer` was outside this list until 2026-09, which is why root `typecheck` had never
     * seen the service that drives the browser.
     */
    expect(rootManifest.workspaces).toEqual([
      "app",
      "server",
      "agent-bot",
      "agent-computer",
      "desktop",
    ]);

    for (const packageName of rootManifest.workspaces) {
      expect(existsSync(join(repositoryRoot, packageName))).toBe(true);
      expect(packageManifest(packageName).name).toBe(packageName);
    }
  });

  /**
   * An image that installs from the root lockfile has to carry every workspace's manifest.
   *
   * bun refuses a `--frozen-lockfile` install when a workspace named in the root package.json is
   * not on disk. The refusal is invisible on a machine that has built once — the install layer is
   * cached, so the Dockerfile only fails the first time it is built somewhere new, and somewhere
   * new is a deployment. `desktop` was missing from both images for exactly that reason, and both
   * of them built green here the whole time.
   */
  test("every image installing from the root lockfile copies each workspace manifest", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces: string[] };

    const dockerfiles = readdirSync(repositoryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(entry.name, "Dockerfile"))
      .filter((path) => existsSync(join(repositoryRoot, path)))
      .filter((path) =>
        readFileSync(join(repositoryRoot, path), "utf8").includes("bun.lock"),
      );

    // Four today. Asserted so this does not quietly pass by matching nothing.
    expect(dockerfiles.length).toBeGreaterThan(0);

    for (const dockerfile of dockerfiles) {
      const contents = readFileSync(join(repositoryRoot, dockerfile), "utf8");
      // The instruction, not the first mention: a Dockerfile may well explain its install in a
      // comment above the manifests, and a comment is not where bun reads them.
      const install = contents.search(/^RUN bun install --frozen-lockfile/m);
      expect(install).toBeGreaterThan(0);

      for (const workspace of rootManifest.workspaces) {
        expect(contents).toContain(`COPY ${workspace}/package.json`);
        // Order is the property, not just presence: a manifest copied after the install is not
        // there when bun reads it.
        expect(contents.indexOf(`COPY ${workspace}/package.json`)).toBeLessThan(
          install,
        );
      }
    }
  });

  test("the shell is not built by the web build", () => {
    /*
     * The root `build` is `bun run --filter '*' build`, and CI runs it on a Linux runner. A `build`
     * script in `desktop` would put `tauri build` there, which cannot produce a bundle on that
     * runner and has no reason to try: the shell is built by .github/workflows/release.yml, for the
     * platforms it ships on. The script is called `bundle` for exactly this reason, and this test is
     * here because renaming it back would break CI on a change that looks unrelated.
     */
    const desktop = packageManifest("desktop");
    expect(desktop.scripts?.build).toBeUndefined();
    expect(desktop.scripts?.bundle).toBe("tauri build");
  });

  /**
   * No manifest pretends to be the version.
   *
   * There were six of them: `0.0.0` in two, `0.2.0` in three that had to be kept equal by hand,
   * and none in the rest — while the fleet ran `v0.4.5`. The version IS the git tag: images.yml
   * bakes the ref and the commit into the images (`GET /api/version`), release.yml stamps the tag
   * into the shell's bundle. A number here would be a second source that is wrong on every day
   * but the one it was edited, so the manifests say so in words.
   */
  test("leaves the version to git", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { version?: string; workspaces: string[] };
    expect(rootManifest.version).toBeUndefined();

    for (const workspace of rootManifest.workspaces) {
      const manifest = JSON.parse(
        readFileSync(join(repositoryRoot, workspace, "package.json"), "utf8"),
      ) as { version?: string };
      if (manifest.version !== undefined) {
        expect(manifest.version, `${workspace}/package.json`).toBe(
          "0.0.0-workspace",
        );
      }
    }
  });

  /**
   * Two advisories the lockfile could not close on its own, closed by overriding UPWARD.
   *
   * `bun audit` on 2026-09-10: 27 findings, nine high. Updating the packages this repository
   * names (`hono`, `fast-uri`, `js-yaml`) took it to four high, all in packages nobody here
   * names: `lodash-es` 4.17.21 pinned EXACTLY by chevrotain under cel-js (the policy language), and
   * `undici` 5.29.0 asked for by `@ai-sdk/provider-utils` under CopilotKit's runtime — which never
   * imports it: the only code in the tree that does is `openai` and `dotenvx`, and they want 7.x.
   * So both are overridden to the fixed line, and the floor is written down here: an override
   * moved BELOW the fix, or dropped, would reopen an advisory without `bun audit` being run.
   */
  test("overrides the two transitive advisories to their fixed versions, and no lower", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { overrides?: Record<string, string> };
    const overrides = rootManifest.overrides ?? {};

    const atLeast = (name: string, floor: [number, number, number]) => {
      const spec = overrides[name];
      expect(spec, `${name} is no longer overridden`).toBeDefined();
      // A caret range, so Dependabot can still move it forward within the fixed major.
      const found = spec?.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
      expect(found, `${name}: ${spec} is not a caret range`).not.toBeNull();
      const [major = 0, minor = 0, patch = 0] = (found ?? [])
        .slice(1, 4)
        .map(Number);
      const order = major - floor[0] || minor - floor[1] || patch - floor[2];
      expect(order, `${name} ${spec} is below the fix`).toBeGreaterThanOrEqual(
        0,
      );
    };
    // GHSA-r5fr-rjxr-66jc and the two `_.unset` prototype pollutions: fixed in 4.17.23.
    atLeast("lodash-es", [4, 17, 23]);
    // The WebSocket and header advisories: fixed across 6.23 / 7.x; 7 is what its importers want.
    atLeast("undici", [7, 29, 0]);

    // And the lockfile agrees: the vulnerable lines are gone from what would be installed.
    const lock = readFileSync(join(repositoryRoot, "bun.lock"), "utf8");
    expect(lock).not.toMatch(/"undici@5\./);
    expect(lock).not.toMatch(/"lodash-es@4\.17\.2[012]"/);
  });
});
