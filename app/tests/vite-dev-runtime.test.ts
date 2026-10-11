import { expect, test } from "bun:test";
import {
  BUN_SERVES_FROM,
  devServerRefusal,
} from "../src/lib/build/dev-runtime";

/**
 * WHICH RUNTIME THE DEV SERVER WILL START UNDER.
 *
 * Under Bun 1.3 Vite's proxy cannot carry a websocket and the first one the app opens exits the
 * dev server (`src/lib/build/dev-runtime.ts`; `vite.config.ts` asks it before serving). The config
 * refuses to serve there and says the two ways out. Node, and a Bun from `BUN_SERVES_FROM` on, are
 * not refused.
 */

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

test("a Bun from the fix on is not refused, whatever follows the minor", () => {
  for (const version of [
    BUN_SERVES_FROM,
    "1.4.3",
    "1.5.0",
    "2.0.0",
    "1.4.0-canary.1",
  ]) {
    expect([version, devServerRefusal(version)]).toEqual([version, null]);
  }
});
