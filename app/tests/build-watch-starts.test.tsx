import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE WATCH FOR A NEWER BUILD IS STARTED BY THE SIGNED-IN SHELL, AND BY NOTHING ELSE.
 *
 * `build-watch.test.ts` and `update-notice.test.tsx` each call `watchBuild()` themselves, so the
 * one line that starts it in the product (`routes/_authed.tsx`, `useEffect(watchBuild, [])`) could
 * be deleted with every test green and no notice ever drawn for anybody (review of pull request
 * 112). This mounts the real route tree and starts nothing by hand: the page is given a commit, the
 * server another, and the window takes the focus.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  const watch = await import("../src/lib/build-watch");
  watch.configureBuildWatch(null);
});
afterAll(async () => {
  await removeAppDom();
});

test("a signed-in screen looks for a newer build when the window is looked at again", async () => {
  const watch = await import("../src/lib/build-watch");
  let reads = 0;
  watch.configureBuildWatch({
    bundleRevision: () => "1bf325e4aaaa",
    readBuild: async () => {
      reads += 1;
      return { revision: "e9be7221bbbb" };
    },
    isVisible: () => true,
    storage: () => null,
    lookEveryMs: 3_600_000,
  });

  const view = await mountApp({ path: "/settings" });
  // Not as it begins: a page that has just loaded is the bundle the web server holds now.
  expect(reads).toBe(0);
  expect(watch.buildFacts().bundleRevision).toBe("1bf325e4aaaa");

  globalThis.dispatchEvent(new Event("focus"));
  await view.waitFor(
    () => watch.buildFacts().serverRevision !== null,
    "the server's build to be learned",
  );
  expect(reads).toBe(1);
  expect(
    watch.updateOffer({ ...watch.buildFacts(), isBotBusy: false }),
  ).toEqual({ kind: "reload", isHeld: false });
});
