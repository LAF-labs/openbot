import { describe, expect, test } from "bun:test";
import {
  CLOSE_GRACE_MS,
  type ClosableContext,
  closeAndWait,
} from "../src/profiles";

/**
 * The close that ends a browser which will not end itself — without a browser.
 *
 * The wedge this guards against was measured on a real site (profiles.ts, CLOSE_GRACE_MS) and
 * cannot be produced on demand from a fixture: what is testable is the contract of the close
 * itself. A `close()` that never resolves must not hold the caller, and the process must be killed
 * once the grace is up; a `close()` that resolves must never be killed.
 */

type Fake = {
  context: ClosableContext;
  disconnect: () => void;
  killed: number[];
};

function fake(input: { closeResolves: boolean }): Fake {
  let handler: (() => void) | null = null;
  let connected = true;
  const killed: number[] = [];
  const context: ClosableContext = {
    close: () =>
      input.closeResolves
        ? Promise.resolve().then(() => {
            connected = false;
            handler?.();
          })
        : new Promise<void>(() => undefined),
    browser: () => ({
      isConnected: () => connected,
      once: (_event, next) => {
        handler = next;
        return undefined;
      },
    }),
  };
  return {
    context,
    disconnect: () => {
      connected = false;
      handler?.();
    },
    killed,
  };
}

describe("closing a browser that will not close", () => {
  test("a hung close returns after the grace, and the process is killed", async () => {
    const browser = fake({ closeResolves: false });
    const started = Date.now();
    await closeAndWait(browser.context, {
      pid: 4242,
      kill: (pid) => {
        browser.killed.push(pid);
        browser.disconnect();
      },
    });
    const elapsed = Date.now() - started;
    expect(browser.killed).toEqual([4242]);
    expect(elapsed).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 50);
    // The grace, the disconnect it produced, and the flush — never the old unbounded wait.
    expect(elapsed).toBeLessThan(CLOSE_GRACE_MS + 2_000);
  });

  test("a hung close with no pid still returns, so a reset is never queued behind it", async () => {
    const browser = fake({ closeResolves: false });
    const started = Date.now();
    await closeAndWait(browser.context, {
      pid: null,
      kill: (pid) => browser.killed.push(pid),
    });
    expect(browser.killed).toEqual([]);
    expect(Date.now() - started).toBeLessThan(CLOSE_GRACE_MS + 3_000);
  });

  test("a browser that closes when asked is never killed", async () => {
    const browser = fake({ closeResolves: true });
    await closeAndWait(browser.context, {
      pid: 4242,
      kill: (pid) => browser.killed.push(pid),
    });
    expect(browser.killed).toEqual([]);
  });
});
