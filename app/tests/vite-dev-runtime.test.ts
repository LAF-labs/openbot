import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  BUN_SERVES_FROM,
  devServerRefusal,
} from "../src/lib/build/dev-runtime";

/**
 * WHICH RUNTIME THE DEV SERVER WILL START UNDER.
 *
 * Under Bun 1.3 Vite's proxy cannot carry a websocket and the first one the app opens exits the
 * dev server (`src/lib/build/dev-runtime.ts`). The config carries a plugin whose `config` hook —
 * the first thing Vite runs for a command — refuses to serve there and says the two ways out.
 * Node, and a Bun from `BUN_SERVES_FROM` on, are not refused. The config is loaded as Vite would
 * load it, in a process of its own (`support/vite-config-probe.ts` says why), so the plugin being
 * in its list is held here and not only the helper it calls.
 */

type Probe = {
  plugins: string[];
  guardHasConfigHook: boolean;
  hooks: Record<string, string | null>;
};

let probing: Promise<Probe> | undefined;

/** One process for the two tests that read the config. */
function probed(): Promise<Probe> {
  probing ??= (async () => {
    const script = join(import.meta.dir, "support/vite-config-probe.ts");
    const child = Bun.spawn(["bun", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("VITE_CONFIG "));
    if (status !== 0 || !line) {
      throw new Error(
        `the config did not load (exit ${status}):\n${stderr.slice(-2000)}`,
      );
    }
    return JSON.parse(line.slice("VITE_CONFIG ".length)) as Probe;
  })();
  return probing;
}

test("Node is never refused: there is no Bun version to read", () => {
  expect(devServerRefusal(undefined)).toBeNull();
});

test("Bun 1.3 is refused, and the sentence names the version, both ways out and the Bun that serves", () => {
  const refusal = devServerRefusal("1.3.14");
  expect(refusal).toContain("Bun 1.3.14");
  expect(refusal).toContain("`node` is on PATH");
  expect(refusal).toContain(`Bun ${BUN_SERVES_FROM} or later`);
  // The last 1.3 there could be, and the 1.2 line before it.
  expect(devServerRefusal("1.3.99")).not.toBeNull();
  expect(devServerRefusal("1.2.10")).not.toBeNull();
});

test("a Bun from the fix on is not refused — and a prerelease of the floor is before it", () => {
  for (const version of [BUN_SERVES_FROM, "1.4.3", "1.5.0", "2.0.0"]) {
    expect([version, devServerRefusal(version)]).toEqual([version, null]);
  }
  // A canary cut before the fix merged carries the bug under the fixed number.
  expect(devServerRefusal("1.4.0-canary.1")).not.toBeNull();
});

/*
 * THE WHOLE VERSION IS COMPARED. The way out if an early 1.4.x still fails is to raise the floor
 * to a patch, which a comparison that stopped at the minor would never honour: 1.4.0 passed a
 * floor of 1.4.3. The floor is a parameter here so that can be held without changing the real one.
 */
test("the floor is read to its patch: below it is refused, from it on is not, a later prerelease is not", () => {
  expect(devServerRefusal("1.4.0", "1.4.3")).toContain("Bun 1.4.3 or later");
  expect(devServerRefusal("1.4.2", "1.4.3")).not.toBeNull();
  expect(devServerRefusal("1.4.3-canary.2", "1.4.3")).not.toBeNull();
  expect(devServerRefusal("1.4.3", "1.4.3")).toBeNull();
  expect(devServerRefusal("1.4.10", "1.4.3")).toBeNull();
  expect(devServerRefusal("1.5.0-canary.1", "1.4.3")).toBeNull();
});

test("the config's plugin list carries the runtime check, with a config hook for Vite to run", async () => {
  const probe = await probed();
  expect(probe.plugins).toContain("laf:dev-runtime");
  expect(probe.guardHasConfigHook).toBe(true);
}, 20_000);

test("the hook refuses `serve` under Bun 1.3 with the sentence, and lets a build, Node and Bun 1.4 through", async () => {
  const { hooks } = await probed();
  expect(hooks["bun 1.3.14 serve"]).toContain("Bun 1.3.14");
  expect(hooks["bun 1.3.14 serve"]).toContain("`node` is on PATH");
  expect(hooks["bun 1.3.14 build"]).toBeNull();
  expect(hooks["node serve"]).toBeNull();
  expect(hooks["bun 1.4.0 serve"]).toBeNull();
}, 20_000);
