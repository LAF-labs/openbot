import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The legal pages ride in the deploy bundle, rendered by CI and copied — never built — by the image.
 *
 * The front door serves `/legal/terms`, `/legal/privacy` and `/privacy.html` from `legal/` in the
 * bundle of the channel it runs (self-serve contract §4.1, §14 W4–W5), and it closes sign-up when
 * `legal/version` is missing. Two halves have to agree for that file to exist: the workflow renders
 * the markdown before the build, and `deploy/Dockerfile` copies what it rendered. The Dockerfile stays
 * instructions that execute nothing — which is what lets both architectures build on one runner in
 * seconds — so the rendering cannot move into it.
 */

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
const workflow = parse(read(".github/workflows/images.yml")) as {
  jobs: Record<string, { steps: Step[] }>;
};
const checks = parse(read(".github/workflows/checks.yml")) as {
  jobs: Record<string, { steps: Step[] }>;
};

describe("the deploy bundle's legal pages", () => {
  const steps = workflow.jobs.deploy?.steps ?? [];
  const render = steps.findIndex((step) =>
    step.run?.includes("bun app/scripts/render-legal.ts deploy/legal"),
  );
  const build = steps.findIndex((step) =>
    step.run?.includes("--file deploy/Dockerfile"),
  );

  test("are rendered by the deploy job, before the image is built", () => {
    expect(render).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(render);
  });

  test("with the Bun the checks run, pinned the same way, and no cache in a run that publishes", () => {
    const pinned = (list: Step[]) =>
      list.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    const here = steps.findIndex((step) =>
      step.uses?.startsWith("oven-sh/setup-bun@"),
    );
    const checked = pinned(checks.jobs.static?.steps ?? []);
    expect(here).toBeGreaterThan(-1);
    expect(here).toBeLessThan(render);
    expect(steps[here]?.uses).toBe(checked?.uses);
    expect(steps[here]?.with?.["bun-version"]).toBe(
      checked?.with?.["bun-version"],
    );
    /*
     * The one way this step differs from the checks', on purpose. setup-bun caches by default, and a
     * cache a pull request's run wrote must never be restored into a job that pushes images — the
     * push that added this step without the line failed zizmor (cache-poisoning, 2026-09-15), and
     * release.yml carries the same line for the same reason.
     */
    expect(steps[here]?.with?.["no-cache"]).toBe(true);
  });

  test("are copied by the Dockerfile, which still runs nothing", () => {
    const dockerfile = read("deploy/Dockerfile");
    expect(dockerfile).toMatch(/^COPY deploy\/legal\/ \/deploy\/legal\/$/m);
    expect(dockerfile).not.toMatch(/^RUN /m);
  });

  test("are not committed: the markdown is the source, and a stale copy would be a second one", () => {
    expect(read(".gitignore")).toMatch(/^deploy\/legal\/$/m);
  });
});
