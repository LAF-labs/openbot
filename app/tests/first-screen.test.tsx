import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { channelServer } from "./support/channel-server";

/**
 * HOME DOES NOT START THE BOT RUNTIME; A CONVERSATION DOES.
 *
 * MEASURED 2026-09-10 (audit A4, finding 5) and 2026-09-13 at `61a0fc8`: the first screen after
 * sign-in statically loaded 46 JavaScript files, 893 kB gzipped, of which the CopilotKit runtime (815
 * kB raw) and the transcript renderer (1,049 kB raw) drew nothing — because `CopilotProvider` wrapped
 * `_authed`'s outlet, every signed-in screen was a screen that ran Bots. The installed app is the
 * product and every launch is a first screen.
 *
 * The bundle half is enforced by the build (`vite.config.ts`, `bundle-graph.test.ts`). This is the
 * half a screen can show: a mounted provider announces itself to the server — it asks the runtime
 * what it serves and announces the gallery — so Home asking for neither is Home without the provider,
 * and the conversation asking is where it went.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
// The whole route tree renders here; under a loaded machine that is more than the runner's five seconds.
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const runtimeTraffic = (requests: { method: string; pathname: string }[]) =>
  requests.filter(
    (request) =>
      request.pathname.startsWith("/api/copilotkit") ||
      (request.method === "PUT" &&
        request.pathname === "/api/components/catalogue"),
  );

describe("the first screen after sign-in", () => {
  test("Home asks nothing of the Bot runtime, and opening a conversation does", async () => {
    const channelId = "channel_first-screen";
    const server = channelServer({ channelId });
    const view = await mountApp({ path: "/", api: server.api });
    try {
      await view.settle(200);
      expect(view.router.state.location.pathname).toBe("/");
      expect(runtimeTraffic(view.requests)).toEqual([]);

      await view.navigate(`/channel/${channelId}`);
      await view.waitFor(
        () =>
          view.requests.some(
            (request) => request.pathname === "/api/copilotkit/info",
          ),
        "the conversation to start the runtime",
        8000,
      );
    } finally {
      await view.unmount();
    }
  });
});
