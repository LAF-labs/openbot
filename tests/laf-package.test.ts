import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packageDirectory = join(import.meta.dir, "..", "tenant", "laf");

/*
 * The default tenant package. Everything — the server, the app build, `bun run test`'s pretest —
 * loads this directory when TENANT_PACKAGE_DIR is unset, so a missing file here fails every clone.
 *
 * Two files, not five. `agents.yaml` and `channels.yaml` were empty lists that a synchronise loop
 * read on every boot, and `knowledge.yaml` fed a connector plane with no adapters behind it; all
 * three are deleted. What the package still decides is who this deployment is, which model it runs
 * on, and how it looks.
 */
test("ships the complete LAF deployment package", () => {
  for (const fileName of ["brand.yaml", "model.yaml"]) {
    expect(existsSync(join(packageDirectory, fileName))).toBe(true);
  }

  // The id stays `openbot` on purpose: it is baked into thread fingerprints and package-agent
  // ownership, so changing it is a data migration, not branding (see brand.yaml's own note).
  expect(readFileSync(join(packageDirectory, "brand.yaml"), "utf8")).toContain(
    "id: openbot",
  );
});
