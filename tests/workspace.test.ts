import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function packageManifest(path: string) {
  return JSON.parse(
    readFileSync(join(repositoryRoot, path, "package.json"), "utf8"),
  ) as {
    name: string;
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
});
