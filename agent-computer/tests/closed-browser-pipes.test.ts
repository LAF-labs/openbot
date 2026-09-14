import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { keepChildProcesses } from "../src/child-processes";
import { createProfiles } from "../src/profiles";

/**
 * A BROWSER LAUNCHED AFTER ANOTHER CLOSED MUST SURVIVE THE CLOSED ONE'S GARBAGE.
 *
 * W1-d (2026-09-13) left one fact unexplained: in one run of four, eight pages timed out at once.
 * Reproduced 2026-09-14 in the image with the same shape — 5 Bots x 20 navigations, then reset — as
 * every second run losing all five browsers within seconds of launch, and traced to Bun: collecting a
 * finished `ChildProcess` closes its pipes a second time by number, and the numbers are the next
 * browser's DevTools pipe. Chromium exits 0 ("Connection terminated while reading from pipe"),
 * Playwright still calls it connected, and the Bot's next navigation waits out its deadline.
 *
 * The collection is forced here, because in the container it came whenever the collector chose —
 * which is why it looked like one run in four. Without `keepChildProcesses` every browser in the
 * second batch is dead (measured: 9 of 9 in the image, and 3 of 3 in this test's first round).
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe("keeping the processes Playwright starts", () => {
  /** A `child_process` module whose children are plain emitters, so no process is started. */
  function fakeModule() {
    const spawned: ChildProcess[] = [];
    return {
      spawned,
      module: {
        spawn: () => {
          const child = new EventEmitter() as unknown as ChildProcess;
          const streams = [null, new EventEmitter(), new EventEmitter()];
          Object.defineProperty(child, "stdio", { value: streams });
          spawned.push(child);
          return child;
        },
      },
    };
  }

  test("keeps every child, once, however often it is asked", () => {
    const fake = fakeModule();
    const kept = keepChildProcesses(fake.module);
    expect(keepChildProcesses(fake.module)).toBe(kept);
    fake.module.spawn();
    fake.module.spawn();
    expect(kept.size).toBe(2);
    expect([...kept]).toEqual(fake.spawned);
  });

  test("lets go of what a closed child listened to, and cannot be thrown at afterwards", async () => {
    const fake = fakeModule();
    keepChildProcesses(fake.module);
    const child = fake.module.spawn();
    const stdout = child.stdio[1] as unknown as EventEmitter;
    // What Playwright hangs on a browser: its transport, its logs, its cleanup.
    stdout.on("data", () => undefined);
    let closedHeard = false;
    child.once("close", () => {
      closedHeard = true;
    });
    child.emit("close", 0, null);
    expect(closedHeard).toBe(true);
    await Bun.sleep(10);
    expect(stdout.listenerCount("data")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    // An error after close finds a listener rather than becoming an uncaught throw.
    expect(() => stdout.emit("error", new Error("EBADF"))).not.toThrow();
    expect(() => child.emit("error", new Error("EBADF"))).not.toThrow();
  });
});

describe.skipIf(!HAS_BROWSER)("a browser launched after another closed", () => {
  test("survives the closed one being collected, and closing still disconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "laf-pipes-"));
    const profiles = createProfiles(root, { idleCloseMs: 0 });
    try {
      for (let round = 0; round < 2; round += 1) {
        const first = [1, 2, 3].map((n) => `closed-${round}-${n}`);
        const firstBrowsers = await Promise.all(
          first.map(async (bot) =>
            (await profiles.page(bot)).context().browser(),
          ),
        );
        await Promise.all(first.map((bot) => profiles.stop(bot)));
        // The close was a close: nothing here took the kill path, which leaves a browser connected.
        expect(firstBrowsers.map((browser) => browser?.isConnected())).toEqual([
          false,
          false,
          false,
        ]);

        const second = [1, 2, 3].map((n) => `launched-${round}-${n}`);
        const pages = await Promise.all(
          second.map((bot) => profiles.page(bot)),
        );
        Bun.gc(true);
        await Bun.sleep(1_500);
        const verdicts = await Promise.all(
          pages.map(async (page) => {
            try {
              await page.goto(
                `data:text/html;charset=utf-8,${encodeURIComponent("<h1>살아 있음</h1>")}`,
                { timeout: 5_000 },
              );
              return await page.textContent("h1", { timeout: 2_000 });
            } catch (error) {
              return `dead: ${String(error).split("\n")[0]}`;
            }
          }),
        );
        expect(verdicts).toEqual(["살아 있음", "살아 있음", "살아 있음"]);
        await Promise.all(second.map((bot) => profiles.stop(bot)));
      }
    } finally {
      await profiles.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
