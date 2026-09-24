import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { ConnectionsOverview } from "../src/lib/connections/queries";
import {
  type ApiRequest,
  APP_DOM_TIMEOUT_MS,
  CURRENT_USER,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * SETTINGS → 내 가게: the first run's two answers, shown and changed later.
 *
 * What the screen shows has to be what every Bot is being told, and what it saves has to be what
 * the person left pressed — the whole answer, through the one door (`PUT /api/me/shop`). Pressed
 * through the real route tree with the server stubbed.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const OVERVIEW: ConnectionsOverview = {
  generatedAt: "2026-09-18T00:00:00.000Z",
  accounts: [],
  sites: ["baemin-ceo", "naver-smartplace", "instagram", "hometax"].map(
    (id) => ({
      id,
      status: "not_connected" as const,
      botId: null,
      lastSeenAt: null,
      connectedAt: null,
    }),
  ),
  bots: [],
};

function server(options: { shop: unknown; refuse?: boolean }) {
  const puts: unknown[] = [];
  let held = options.shop;
  const api = (request: ApiRequest) => {
    const { pathname, method } = request;
    if (pathname === "/api/me") {
      return json({
        user: { ...CURRENT_USER, role: "user", onboarded: true, shop: held },
        deployment: { effort: true, autoReview: true },
      });
    }
    if (pathname === "/api/me/shop" && method === "PUT") {
      puts.push(request.body);
      if (options.refuse) {
        return json({ error: "laf:internal", code: "laf:internal" }, 500);
      }
      held = request.body;
      return json({ shop: request.body });
    }
    if (pathname === "/api/connections/overview") return json(OVERVIEW);
    return undefined;
  };
  return { api, puts };
}

type View = Awaited<ReturnType<typeof mountApp>>;

const pressed = (view: View, name: string) =>
  view.buttonNamed(name)?.getAttribute("aria-pressed");

async function press(view: View, name: string) {
  await view.waitFor(
    () => view.buttonNamed(name) !== undefined,
    `a button called ${name}`,
  );
  const button = view.buttonNamed(name);
  if (!button) throw new Error(`no button called ${name}`);
  await view.click(button);
}

describe("Settings → 내 가게", () => {
  test("shows what every Bot is being told, pressed", async () => {
    const { api } = server({
      shop: { kind: "food", places: ["baemin-ceo", "hometax"] },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(
      () => view.buttonNamed("Baemin") !== undefined,
      "the places",
    );

    expect(view.host.textContent).toContain("My shop");
    expect(pressed(view, "Restaurant or café")).toBe("true");
    expect(pressed(view, "Selling online")).toBe("false");
    expect(pressed(view, "Baemin")).toBe("true");
    expect(pressed(view, "Hometax")).toBe("true");
    expect(pressed(view, "Instagram")).toBe("false");
    // Nothing changed yet, so there is nothing to save.
    expect(view.buttonNamed("Save")?.disabled).toBe(true);
  });

  test("saves the whole answer as it was left, and says so", async () => {
    const { api, puts } = server({
      shop: { kind: "food", places: ["baemin-ceo"] },
    });
    const view = await mountApp({ path: "/settings/shop", api });

    await press(view, "Selling in a shop");
    await press(view, "Baemin");
    await press(view, "Instagram");
    expect(view.buttonNamed("Save")?.disabled).toBe(false);
    await press(view, "Save");

    await view.waitFor(
      () => view.host.textContent?.includes("Saved") === true,
      "the save to be confirmed",
    );
    expect(puts).toEqual([{ kind: "store", places: ["instagram"] }]);
    expect(view.buttonNamed("Save")?.disabled).toBe(true);
  });

  test("the places hold still while the kind is being changed", async () => {
    // The order follows the SAVED kind. Following the pressed one moved every chip under the
    // pointer the moment a kind was pressed — measured in the browser on this screen.
    const { api } = server({ shop: { kind: "food", places: [] } });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(
      () => view.buttonNamed("Baemin") !== undefined,
      "the places",
    );
    const order = () =>
      [
        ...view.host.querySelectorAll<HTMLButtonElement>(
          '[data-slot="daily-places"] button',
        ),
      ].map((chip) => chip.textContent);
    const before = order();

    await press(view, "Office or professional services");
    expect(order()).toEqual(before);
  });

  test("clears an answer when everything is taken back", async () => {
    const { api, puts } = server({
      shop: { kind: "beauty", places: ["naver-smartplace"] },
    });
    const view = await mountApp({ path: "/settings/shop", api });

    await press(view, "Hair and beauty");
    await press(view, "Naver Smart Place");
    await press(view, "Save");
    await view.waitFor(() => puts.length === 1, "the save");
    expect(puts).toEqual([{ kind: null, places: [] }]);
  });

  test("keeps the edit on screen when the save fails", async () => {
    const { api, puts } = server({
      shop: { kind: null, places: [] },
      refuse: true,
    });
    const view = await mountApp({ path: "/settings/shop", api });

    await press(view, "Clinic or pharmacy");
    await press(view, "Save");
    await view.waitFor(
      () =>
        view.host.textContent?.includes("That was not saved. Try again.") ===
        true,
      "the failure to be said",
    );
    expect(puts).toHaveLength(1);
    expect(pressed(view, "Clinic or pharmacy")).toBe("true");
    expect(view.buttonNamed("Save")?.disabled).toBe(false);
  });
});
