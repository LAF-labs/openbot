import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

/**
 * WHERE A RUN SAYS THE BROWSER MUST BE THERE, ITS ABSENCE IS A FAILURE AND NOT A SKIP.
 *
 * Every suite here that drives Chromium skips itself where Playwright has none, which is right on a
 * laptop that never installed one and was wrong in CI for at least four weeks: the workflow
 * installed a browser, for a newer Playwright than the one these suites run on, and each suite
 * looked for its own build, found nothing and skipped. Measured 2026-10-02 on the run for
 * dd0d1173: 92 of this workspace's 386 tests skipped, among them every one that opens a page, and
 * the job green — a skipped test counts toward the floor (`scripts/test-ci.ts`), so nothing fell.
 *
 * The workflow now installs from this workspace and says so here (`.github/workflows/checks.yml`).
 * Asked the same way the suites ask, so that it fails exactly when they would have skipped.
 */
test.skipIf(!process.env.LAF_BROWSER_REQUIRED)(
  "the browser these suites drive is installed, where the run says it must be",
  () => {
    expect(existsSync(chromium.executablePath())).toBe(true);
  },
);
