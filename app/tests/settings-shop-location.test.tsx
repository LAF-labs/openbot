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
 * SETTINGS → 내 가게 → 가게 위치: where the shop is, shown, changed and cleared.
 *
 * The Bot's browser runs on a cloud VM, and a Bot once told its owner the weather "in 제주시, 사장님
 * 위치" off a site's guess of the VM's place. The place kept here is what every run is told instead,
 * and what the Bot saves when it asks in a conversation — so this is where a person sees it and
 * takes it away. Pressed through the real route tree with the server stubbed.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: undefined,
  });
});
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

type Kept = {
  place: string | null;
  coordinates: { latitude: number; longitude: number } | null;
};

function server(kept: Kept, options: { refuse?: boolean } = {}) {
  const writes: Array<{ method: string; body: unknown }> = [];
  let held = { timeZone: "Asia/Seoul", locale: "ko-KR", ...kept };
  const api = (request: ApiRequest) => {
    const { pathname, method } = request;
    if (pathname === "/api/me") {
      return json({
        user: {
          ...CURRENT_USER,
          role: "user",
          onboarded: true,
          shop: { kind: "food", places: [] },
          whereabouts: held,
        },
        deployment: { effort: true, autoReview: true },
      });
    }
    if (pathname === "/api/me/place") {
      writes.push({ method, body: request.body });
      if (options.refuse) {
        return json(
          { error: "laf:place_invalid", code: "laf:place_invalid" },
          400,
        );
      }
      held =
        method === "DELETE"
          ? { ...held, place: null, coordinates: null }
          : { ...held, ...(request.body as Kept) };
      return json({ whereabouts: held });
    }
    return undefined;
  };
  return { api, writes };
}

type View = Awaited<ReturnType<typeof mountApp>>;

async function press(view: View, name: string) {
  await view.waitFor(
    () => view.buttonNamed(name) !== undefined,
    `a button called ${name}`,
  );
  const button = view.buttonNamed(name);
  if (!button) throw new Error(`no button called ${name}`);
  await view.click(button);
}

const placeField = (view: View) =>
  view.host.querySelector<HTMLInputElement>(
    'input[placeholder="e.g. Seoul Gangnam-gu"]',
  );

describe("Settings → 내 가게 → 가게 위치", () => {
  test("shows the kept place, and saves a new one on its own press", async () => {
    const { api, writes } = server({ place: "서울 강남구", coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");

    expect(view.host.textContent).toContain("Shop location");
    expect(placeField(view)?.value).toBe("서울 강남구");
    // Nothing changed, nothing to save.
    expect(view.buttonNamed("Save the location")?.disabled).toBe(true);

    const field = placeField(view);
    if (!field) throw new Error("no place field");
    await view.type(field, "서울 마포구");
    await press(view, "Save the location");
    await view.waitFor(() => writes.length === 1, "the save");
    expect(writes).toEqual([
      { method: "PUT", body: { place: "서울 마포구", coordinates: null } },
    ]);
    // The shop's own save is a different button, untouched by this one.
    expect(view.buttonNamed("Save")?.disabled).toBe(true);
  });

  test("clears the place, and the field with it", async () => {
    const { api, writes } = server({
      place: "서울 강남구",
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await press(view, "Clear the location");
    await view.waitFor(() => writes.length === 1, "the clear");
    expect(writes[0]?.method).toBe("DELETE");
    await view.waitFor(() => placeField(view)?.value === "", "an empty field");
    expect(view.host.textContent).not.toContain("37.50");
    // Nothing kept, nothing to clear.
    await view.waitFor(
      () => view.buttonNamed("Clear the location") === undefined,
      "the clear button to go",
    );
  });

  test("a refused place is said in the surface's words", async () => {
    const { api } = server(
      { place: null, coordinates: null },
      { refuse: true },
    );
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");
    const field = placeField(view);
    if (!field) throw new Error("no place field");
    await view.type(field, "강남구 미소빌딩 2층");
    await press(view, "Save the location");
    await view.waitFor(
      () =>
        view.host.textContent?.includes(
          "That place was not saved. Only a city and district can be kept.",
        ) === true,
      "the refusal",
    );
  });

  test("a browser tab can offer the device's location, rounded before it is kept", async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (resolve: (position: unknown) => void) =>
          resolve({ coords: { latitude: 37.498_095, longitude: 127.027_61 } }),
      },
    });
    const { api, writes } = server({ place: null, coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await press(view, "Use this device's location");
    await view.waitFor(
      () => view.host.textContent?.includes("37.50, 127.03") === true,
      "the device's place, coarse",
    );
    await press(view, "Save the location");
    await view.waitFor(() => writes.length === 1, "the save");
    expect(writes[0]?.body).toEqual({
      place: null,
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
  });

  test("the desktop shell draws no device button — its webview answers no location request", async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition: () => undefined },
    });
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {};
    const { api } = server({ place: null, coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");
    expect(view.buttonNamed("Use this device's location")).toBeUndefined();
  });
});
