import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { t } from "../src/lib/i18n";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * Home's block is centred in the window, and a margin is not allowed to move it.
 *
 * `justify-center` was already there and a `mt-8` beside it was pushing everything 32px down inside
 * it: measured at 1280x1080 the greeting had 420px above and the composer 388px below, and the same
 * 32px skew held at every window height. It is the sort of margin that gets added to nudge a block
 * that was never centred, survives the change that centres it, and then reads as a mistake on the
 * one screen a person opens every time they start work. Now above and below match exactly — 264 at
 * 800, 314 at 900, 404 at 1080, 584 at 1440.
 *
 * The class list is read off the RENDERED element, not off the source with the comments stripped:
 * the earlier version of this file matched `className="flex w-full flex-1…"` as text and would
 * have gone green on a class string that was built and never applied. The pixels were counted in a
 * browser; what is held here is that the block on screen still carries the classes that produced
 * them.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const team = [
  agentFixture({ id: "bot-1", name: "초롱" }),
  agentFixture({ id: "bot-2", name: "조약돌" }),
];

async function home(agents: () => Response | Promise<Response>) {
  const view = await mountApp({
    path: "/",
    api: ({ pathname }) => (pathname === "/api/agents" ? agents() : undefined),
  });
  const main = view.main();
  if (!main) throw new Error("the app shell did not draw its main pane");
  return {
    ...view,
    main,
    /** The route's outermost element: the first thing inside the shell's `<main>`. */
    block: () => {
      const block = main.firstElementChild;
      if (!block) throw new Error("Home drew nothing inside main");
      return block;
    },
    rosterReads: () =>
      view.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === "/api/agents",
      ).length,
  };
}

describe("the home block", () => {
  test("fills the window and centres in it", async () => {
    const view = await home(() => json({ agents: team }));
    const outer = view.block().className;
    expect(outer).toContain("flex-1");
    expect(outer).toContain("justify-center");
    expect(outer).toContain("items-center");
    await view.unmount();
  });

  test("carries no top margin to lean the centring", async () => {
    const view = await home(() => json({ agents: team }));
    expect(view.block().className).not.toMatch(/\bmt-\d/);
    await view.unmount();
  });

  test("greets by the hour, and the composer is under the greeting", async () => {
    const view = await home(() => json({ agents: team }));
    const greeting = view.block().querySelector("h1")?.textContent ?? "";
    expect(
      ["Working late?", "Good morning", "Good afternoon", "Good evening"].map(
        (line) => t(line),
      ),
    ).toContain(greeting);
    // The composer is a contenteditable, not a textarea, and it is aimed at the first face.
    expect(view.block().querySelector("[contenteditable]")).not.toBeNull();
    expect(view.block().textContent).toContain("Goes to 초롱.");
    expect(
      view.block().querySelectorAll('button[aria-pressed="true"]'),
    ).toHaveLength(1);
    await view.unmount();
  });
});

describe("while the team is not there", () => {
  test("holds the row's place while it loads", async () => {
    // Rendering nothing until the roster arrived dropped the composer up the screen and then
    // shoved it back down, on the one screen a person sees every time they open the app.
    const view = await home(() => new Promise<Response>(() => {}));
    expect(
      view.block().querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(view.block().querySelector('[role="alert"]')).toBeNull();
    expect(view.block().textContent).not.toContain("No Bots on your team yet.");
    await view.unmount();
  });

  test("says so when it could not be loaded, and the press asks again", async () => {
    let failing = true;
    const view = await home(() =>
      failing ? json({ error: "boom" }, 500) : json({ agents: team }),
    );
    const alert = view.block().querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Your team could not be loaded.");
    expect(ko["Your team could not be loaded."]).toBeTruthy();
    // Measured: the shell reads the roster more than once on the way in (a second observer mounts
    // after the first answer), so what is held is that the PRESS adds a read, not the total.
    const before = view.rosterReads();

    failing = false;
    const again = view.buttonNamed("Try again");
    if (!again) throw new Error("no Try again button under the alert");
    await view.click(again);
    await view.waitFor(
      () => view.block().querySelector('[role="alert"]') === null,
      "the alert to clear",
    );

    expect(view.rosterReads()).toBeGreaterThan(before);
    expect(view.block().textContent).toContain("초롱");
    await view.unmount();
  });
});
