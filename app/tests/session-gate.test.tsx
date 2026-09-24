import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * WHEN THE SERVER SAYS WHO YOU ARE NOT, THE SCREEN SAYS THAT — AND NOTHING ELSE.
 *
 * MEASURED 2026-09-10 (audit A4, finding 2), with every `/api/**` forced to answer 401 on a signed-in
 * screen: pressing 루틴 drew "루틴을 불러오지 못했습니다 · 다시 시도", pressing 봇 drew "봇 목록을
 * 불러오지 못했습니다", and a minute later the screen was still there — four places in the app read a
 * 401 and none of them was on that path, and the current-user answer was fresh for sixty seconds. And
 * a 403 from `/api/me` — a good session for somebody whose role was taken away — landed on "서버에
 * 닿지 못했습니다. 대개 저절로 풀립니다." The installed app has no address bar to type /sign into.
 *
 * The real route tree, mounted on a memory history with the server stubbed; the session watch is
 * installed over the stub exactly as `main.tsx` installs it over the browser's `fetch` at boot.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
// The whole route tree renders here; under a loaded machine that is more than the runner's five seconds.
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

/** `main.tsx`'s one line, over whatever `fetch` the test has installed. Returns the way to undo it. */
async function watchingTheSession() {
  const { watchSession } = await import("../src/lib/auth/session-watch");
  return watchSession();
}

describe("a session that ends while the app is open", () => {
  test("lands on the door, carrying where the person was", async () => {
    let over = false;
    const view = await mountApp({
      path: "/skills",
      api: ({ pathname }) =>
        over && pathname !== "/api/me"
          ? json(
              { error: "laf:unauthenticated", code: "laf:unauthenticated" },
              401,
            )
          : undefined,
    });
    const unwatch = await watchingTheSession();
    try {
      expect(view.router.state.location.pathname).toBe("/skills");

      // The session ends. The next screen the person opens asks the server for its data.
      over = true;
      await view.navigate("/routines");
      await view.waitFor(
        () => view.router.state.location.pathname === "/sign",
        "the sign-in door",
        8000,
      );

      expect(view.router.state.location.search).toEqual({
        redirect: "/routines",
      });
      await view.waitFor(
        () => view.host.textContent?.includes("Sign in to") === true,
        "the sign-in screen to draw",
        8000,
      );
      // Not the sentence about loading that was on screen before.
      expect(view.host.textContent).not.toContain(
        "Your routines could not be loaded.",
      );
    } finally {
      unwatch();
      await view.unmount();
    }
  });

  test("a server fault on the same screen is not a session ending", async () => {
    let failing = false;
    const view = await mountApp({
      path: "/skills",
      api: ({ pathname }) =>
        failing && pathname !== "/api/me"
          ? json({ error: "boom" }, 500)
          : undefined,
    });
    const unwatch = await watchingTheSession();
    try {
      failing = true;
      await view.navigate("/routines");
      await view.settle(200);
      expect(view.router.state.location.pathname).toBe("/routines");
    } finally {
      unwatch();
      await view.unmount();
    }
  });

  test("a 401 from somewhere that is not this deployment's API moves nothing", async () => {
    const view = await mountApp({
      path: "/skills",
      api: ({ url }) =>
        url.origin !== "http://localhost:3110"
          ? json({ error: "not yours" }, 401)
          : undefined,
    });
    const unwatch = await watchingTheSession();
    try {
      await fetch("https://images.example/api/avatar.png");
      await view.settle(100);
      expect(view.router.state.location.pathname).toBe("/skills");
    } finally {
      unwatch();
      await view.unmount();
    }
  });
});

/**
 * A SESSION TAKEN AWAY IS NOT A SESSION THAT ENDED.
 *
 * MEASURED 2026-09-14: staff struck off the sign-in list kept a working session for its seven days
 * (`server/src/auth/session-revocation.ts`). The server now revokes it and answers every request
 * `401 laf:session_revoked` — and read by its status alone, that 401 drew the door with nothing on it,
 * exactly what an ordinary expiry draws. The person removed has to be told they were.
 */
describe("a session taken away", () => {
  const REVOKED = { error: "laf:session_revoked", code: "laf:session_revoked" };
  const SENTENCE =
    "This account's access here was taken away, so it was signed out. If that is a mistake, ask whoever manages this place.";

  test("a reload lands on the door, saying the access was taken away", async () => {
    const view = await mountApp({
      path: "/skills",
      api: ({ pathname }) =>
        pathname === "/api/me" ? json(REVOKED, 401) : undefined,
    });
    try {
      await view.waitFor(
        () => view.router.state.location.pathname === "/sign",
        "the sign-in door",
        8000,
      );
      // The fact, and no destination: signing in again is not a way back to that screen.
      expect(view.router.state.location.search).toEqual({
        error: "laf:session_revoked",
      });
      await view.waitFor(
        () => view.host.textContent?.includes(SENTENCE) === true,
        "the sentence under the buttons",
        8000,
      );
      expect(ko[SENTENCE]).toBe(
        "이 계정의 권한이 회수되어 로그아웃되었습니다. 잘못된 일이라면 이곳을 관리하는 분께 문의해 주세요.",
      );
    } finally {
      await view.unmount();
    }
  });

  test("while the app is open, the next request takes the person to the door, saying so", async () => {
    let removed = false;
    const view = await mountApp({
      path: "/skills",
      api: () => (removed ? json(REVOKED, 401) : undefined),
    });
    const unwatch = await watchingTheSession();
    try {
      expect(view.router.state.location.pathname).toBe("/skills");

      // An administrator removes them. The next screen they open asks the server for its data.
      removed = true;
      await view.navigate("/routines");
      await view.waitFor(
        () => view.router.state.location.pathname === "/sign",
        "the sign-in door",
        8000,
      );
      expect(view.router.state.location.search).toEqual({
        error: "laf:session_revoked",
      });
      await view.waitFor(
        () => view.host.textContent?.includes(SENTENCE) === true,
        "the sentence under the buttons",
        8000,
      );
    } finally {
      unwatch();
      await view.unmount();
    }
  });
});

describe("a 403 from /api/me", () => {
  test("says the account's access was taken away, not that the server is down", async () => {
    const view = await mountApp({
      path: "/skills",
      api: ({ pathname }) =>
        pathname === "/api/me"
          ? json({ error: "laf:no_access", code: "laf:no_access" }, 403)
          : undefined,
    });
    try {
      expect(view.router.state.location.pathname).toBe("/no-access");
      expect(view.host.textContent).toContain(
        "This account no longer has access here.",
      );
      expect(view.host.textContent).not.toContain("Cannot reach the server.");
      expect(view.buttonNamed("Check again")).toBeDefined();
      expect(view.buttonNamed("Log out")).toBeDefined();
      expect(ko["This account no longer has access here."]).toBe(
        "이 계정은 더 이상 여기에 들어올 수 없습니다.",
      );
    } finally {
      await view.unmount();
    }
  });
});
