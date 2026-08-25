import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packageDirectory = join(import.meta.dir, "..", "tenant", "laf");

// The default tenant package. Everything — the server, the app build, `bun run test`'s pretest —
// loads this directory when TENANT_PACKAGE_DIR is unset, so a missing file here fails every clone.
test("ships the complete LAF deployment package", () => {
  for (const fileName of [
    "brand.yaml",
    "agents.yaml",
    "channels.yaml",
    "model.yaml",
    "knowledge.yaml",
  ]) {
    expect(existsSync(join(packageDirectory, fileName))).toBe(true);
  }

  // The id stays `openbot` on purpose: it is baked into thread fingerprints and package-agent
  // ownership, so changing it is a data migration, not branding (see brand.yaml's own note).
  expect(readFileSync(join(packageDirectory, "brand.yaml"), "utf8")).toContain(
    "id: openbot",
  );
});
