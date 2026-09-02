import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a clone can do before anybody has configured it.
 *
 * Everything here is a property of the repository rather than of the machine it was cloned onto, and
 * each one has already shipped broken once: a dependency only a non-workspace package declared, so
 * nothing at the root resolved it, and a tenant package that named an environment variable, so
 * loading it needed a `.env` that a clone does not have. Both left `bun run test` failing for
 * everybody except the person who added them, whose checkout was already configured.
 */

const root = join(import.meta.dir, "..");

function manifest(path: string) {
  return JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")) as {
    name?: string;
    workspaces?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

const rootManifest = manifest(".");
const workspaces = rootManifest.workspaces ?? [];

describe("a clone that has only run bun install", () => {
  /*
   * This used to be the opposite test. `agent-computer` was outside the workspaces, so it asserted
   * that whatever its tests imported could still be resolved from the root install — a rule for
   * living with the gap rather than closing it. Being outside was the actual defect: root
   * `typecheck` never saw the service that drives the browser, and its image installed with no
   * lockfile. It is a member now, and what is worth keeping is that nothing else ends up where it
   * was, which is easy to do by accident — a new directory with a package.json is simply invisible
   * to the root install, and it is invisible in a way that passes.
   */
  test("leaves no package outside the root install", () => {
    const withManifests = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .filter((entry) => entry.name !== "node_modules")
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(root, name, "package.json")));

    // Asserted so this cannot quietly pass by matching nothing.
    expect(withManifests.length).toBeGreaterThan(0);

    for (const name of withManifests) {
      expect(workspaces).toContain(name);
      // The lockfile and every `--filter` in a Dockerfile address a workspace by the name in its
      // manifest, so a package whose name is not its directory is a trap in both.
      expect(manifest(name).name).toBe(name);
    }
  });

  test("can read the default tenant package with nothing set", () => {
    // `pretest` loads this package, so a name here with no fallback fails the suite before a single
    // test runs. model.yaml is where the environment references live in this package.
    const model = readFileSync(join(root, "tenant/laf/model.yaml"), "utf8");
    const referenced = [
      ...model.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g),
    ];

    expect(referenced.length).toBeGreaterThan(0);
    for (const [, name, rest] of referenced) {
      expect(
        rest.startsWith(":-"),
        `\${${name}} in model.yaml has no fallback, so a clone with no .env cannot read it`,
      ).toBe(true);
    }
  });

  test("keeps every .env variant out of the repository", () => {
    // A backup taken beside .env carried live keys into a commit once.
    const ignored = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignored).toContain(".env.*");
    expect(ignored).toContain("!.env.example");
  });
});
