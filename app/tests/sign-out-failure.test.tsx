import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * A SIGN-OUT THAT FAILED IS TOLD IN THE APP'S OWN WORDS.
 *
 * Until 2026-10-06 the settings screen and the sidebar drew whatever was thrown: "Could not sign out
 * (500)" from the request helper, or the engine's own "Failed to fetch". Both are Errors, so the
 * Korean sentence kept for this moment sat behind an `instanceof` that was always true and was
 * never drawn — a Korean reader got English with a status in it, on the one press where being
 * understood matters (somebody who believes they signed out of a shared computer and did not).
 *
 * Mounted on the settings screen, where 로그아웃 is a plain button. The sidebar's is behind a menu
 * that this shared test process cannot open (`sidebar-foot-render.tsx` says why); it calls the same
 * mutation and catches it the same way.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const SAYS = "Could not log out.";

type View = Awaited<ReturnType<typeof mountApp>>;

async function pressLogOut(api: ApiAnswer): Promise<View> {
  const view = await mountApp({ path: "/settings", api });
  await view.waitFor(
    () => view.buttonNamed("Log out") !== undefined,
    "the log out button",
  );
  const button = view.buttonNamed("Log out");
  if (!button) throw new Error("no log out button");
  await view.click(button);
  await view.waitFor(() => told(view).length > 0, "the failure to be told");
  return view;
}

/**
 * What the screen says went wrong, about signing out. The settings screen has another alert of its
 * own in this mount — its footer cannot read a version nobody stubbed — so the lines are read by
 * what they are about, not by being the only ones.
 */
const told = (view: View) =>
  [...view.host.querySelectorAll('[role="alert"]')]
    .map((line) => line.textContent ?? "")
    .filter((words) => /log out|sign out|fetch|\d{3}/i.test(words));

describe("a sign-out that did not happen", () => {
  test("refused by the server: the app's sentence, and never the status or the helper's English", async () => {
    const view = await pressLogOut(({ pathname, method }) =>
      pathname === "/api/auth/sign-out" && method === "POST"
        ? new Response("{}", { status: 500 })
        : undefined,
    );
    expect(told(view)).toEqual([SAYS]);
    expect(view.host.textContent).not.toContain("500");
    expect(view.host.textContent).not.toContain("Could not sign out");
    // Still on the screen it was pressed on: nobody is sent to the door as though it had worked.
    expect(view.router.state.location.pathname).toBe("/settings");
    expect(ko[SAYS]).toBe("로그아웃하지 못했어요.");
  });

  test("the request never arriving: the same sentence, not the engine's", async () => {
    const view = await pressLogOut(({ pathname, method }) => {
      if (pathname === "/api/auth/sign-out" && method === "POST") {
        throw new TypeError("Failed to fetch");
      }
      return undefined;
    });
    expect(told(view)).toEqual([SAYS]);
    expect(view.host.textContent).not.toContain("Failed to fetch");
    expect(view.router.state.location.pathname).toBe("/settings");
  });
});
