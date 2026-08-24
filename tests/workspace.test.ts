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

describe("OpenBot workspace", () => {
  test("defines the app, server, worker and desktop packages", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces: string[] };

    /*
     * Pinned, so a new workspace is a decision and not a side effect of a stray package.json.
     * `desktop` is the installable shell (Tauri): a window onto the deployed origin, holding no
     * product logic, which is why it is a workspace and not a fourth runtime.
     */
    expect(rootManifest.workspaces).toEqual([
      "app",
      "server",
      "worker",
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

    // Two today. Asserted so this does not quietly pass by matching nothing.
    expect(dockerfiles.length).toBeGreaterThan(0);

    for (const dockerfile of dockerfiles) {
      const contents = readFileSync(join(repositoryRoot, dockerfile), "utf8");
      const install = contents.indexOf("bun install --frozen-lockfile");
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
});
