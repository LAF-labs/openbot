import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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

/** This browser's mark that its device has had its once (`lib/whereabouts/device-place.ts`). */
const DEVICE_ASKED = "laf.device-place-asked";
/** And whether the person cleared this device's place here: `1`, or `0` when they have not. */
const DEVICE_CLEARED = "laf.device-place-cleared";

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
/*
 * A DEVICE THAT HAS HAD ITS ONCE, unless a test says otherwise. Every signed-in screen asks the
 * browser where it is the first time (`useDevicePlaceOnce`), and this DOM's browser says yes to
 * everything: left unmarked, the first test to hand it a working `geolocation` would have its
 * coordinates saved at open, before the button this file is about was pressed. The tests passed
 * without this only in the order they were written in — whichever ran first spent the once for the
 * rest.
 */
beforeEach(() => {
  localStorage.setItem(DEVICE_ASKED, "1");
});
afterEach(async () => {
  await unmountApps();
  localStorage.removeItem(DEVICE_ASKED);
  localStorage.removeItem(DEVICE_CLEARED);
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

  test("clearing a place that held this device's coordinates is final here: the next open does not read the device again", async () => {
    /*
     * A CLEARED PLACE CAME BACK ONCE (review of pull request 91). Somebody who said where they are
     * is not asked at open and the device is not marked; they then give the device's place on a
     * press, save, and clear. Nothing had marked the device, so the next open — the browser still
     * saying yes — read it and saved it again, and 지우기 was a control that did nothing.
     */
    localStorage.removeItem(DEVICE_ASKED);
    let reads = 0;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (resolve: (position: unknown) => void) => {
          reads += 1;
          resolve({ coords: { latitude: 37.498_095, longitude: 127.027_61 } });
        },
      },
    });
    const { api, writes } = server({ place: "서울 강남구", coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");
    // A said place: the device is not asked by itself, and its once is not spent.
    expect(reads).toBe(0);
    expect(writes).toEqual([]);
    expect(localStorage.getItem(DEVICE_ASKED)).toBeNull();

    await press(view, "Use this device's location");
    await view.waitFor(
      () => view.host.textContent?.includes("37.50, 127.03") === true,
      "the device's place, coarse",
    );
    await press(view, "Save the location");
    await view.waitFor(() => writes.length === 1, "the save");
    await press(view, "Clear the location");
    await view.waitFor(() => writes.length === 2, "the clear");
    expect(writes[1]?.method).toBe("DELETE");
    // Cleared, which is its own mark: "asked" is true of every device whose place follows it.
    expect(localStorage.getItem(DEVICE_ASKED)).toBe("1");
    expect(localStorage.getItem(DEVICE_CLEARED)).toBe("1");
    await view.unmount();

    // The next open: nothing held, and a browser that would say yes without showing anything.
    const again = await mountApp({ path: "/settings/shop", api });
    await again.waitFor(() => placeField(again) !== null, "the place field");
    await again.settle(60);
    expect(reads).toBe(1);
    expect(writes).toHaveLength(2);
    expect(placeField(again)?.value).toBe("");
  });

  test("pressing the device's button again is how a cleared place is taken back", async () => {
    // 지우기 was pressed here once: this device is not read by itself.
    localStorage.setItem(DEVICE_CLEARED, "1");
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (resolve: (position: unknown) => void) =>
          resolve({ coords: { latitude: 37.498_095, longitude: 127.027_61 } }),
      },
    });
    const { api, writes } = server({ place: null, coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");
    await view.settle(60);
    expect(writes).toEqual([]);
    expect(localStorage.getItem(DEVICE_CLEARED)).toBe("1");

    // The person asks for this device's place again, themselves.
    await press(view, "Use this device's location");
    await view.waitFor(
      () => view.host.textContent?.includes("37.50, 127.03") === true,
      "the device's place, coarse",
    );
    expect(localStorage.getItem(DEVICE_CLEARED)).toBe("0");
    expect(localStorage.getItem(DEVICE_ASKED)).toBe("1");
  });

  test("clearing words alone spends nothing: the device was no part of that answer, and is the default again", async () => {
    localStorage.removeItem(DEVICE_ASKED);
    // No working `geolocation` here: only whether the once was spent is being read.
    const { api, writes } = server({ place: "서울 강남구", coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await press(view, "Clear the location");
    await view.waitFor(() => writes.length === 1, "the clear");
    expect(writes[0]?.method).toBe("DELETE");
    expect(localStorage.getItem(DEVICE_ASKED)).toBeNull();
  });

  test("the installed app offers the device's location through its shell, and a press may show the system's question", async () => {
    /*
     * The shell's webview answers no geolocation request, so until the shell could read the device
     * this button was not drawn in the installed app at all — the surface this product leads with.
     */
    const reads: unknown[] = [];
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: async (command: string, args: unknown) => {
          if (command === "device_place_permission") return "prompt";
          if (command === "device_place") {
            reads.push(args);
            // Rounded by the shell in the real thing; rounded again here whatever it did.
            return {
              kind: "place",
              latitude: 37.498_095,
              longitude: 127.027_61,
            };
          }
          return undefined;
        },
      },
    };
    // A browser API that must not be what answers: in the real webview it never would.
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: () => {
          throw new Error("the webview's own geolocation was asked");
        },
      },
    });
    const { api, writes } = server({ place: null, coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await press(view, "Use this device's location");
    await view.waitFor(
      () => view.host.textContent?.includes("37.50, 127.03") === true,
      "the device's place, coarse",
    );
    // The person pressed: this is the read that may put the system's question up.
    expect(reads).toEqual([{ prompt: true }]);
    await press(view, "Save the location");
    await view.waitFor(() => writes.length === 1, "the save");
    expect(writes[0]?.body).toEqual({
      place: null,
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
  });

  test("a device that said no in the installed app answers the press in words", async () => {
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: async (command: string) => {
          if (command === "device_place_permission") return "denied";
          if (command === "device_place") return { kind: "denied" };
          return undefined;
        },
      },
    };
    const { api, writes } = server({ place: null, coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await press(view, "Use this device's location");
    await view.waitFor(
      () =>
        view.host.textContent?.includes(
          "Location was not allowed on this device.",
        ) === true,
      "the refusal, in words",
    );
    expect(writes).toEqual([]);
  });

  test("an installed app whose shell cannot read the device draws no device button", async () => {
    /*
     * An installed app is not replaced when the deployment is, so for a while most shells that
     * open this page are from before the command; and on Windows the shell does not read the
     * device at all. A button there would ask and then say nothing.
     */
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition: () => undefined },
    });
    const shells: unknown[] = [
      // No bridge at all.
      {},
      // A shell from before the command: the call is refused.
      {
        core: {
          invoke: async (command: string) => {
            if (command.startsWith("device_place")) {
              throw new Error(`${command} not allowed`);
            }
            return undefined;
          },
        },
      },
      // Windows, today.
      {
        core: {
          invoke: async (command: string) =>
            command === "device_place_permission" ? "unsupported" : undefined,
        },
      },
    ];
    for (const shell of shells) {
      (globalThis as { __TAURI__?: unknown }).__TAURI__ = shell;
      const { api } = server({ place: null, coordinates: null });
      const view = await mountApp({ path: "/settings/shop", api });
      await view.waitFor(() => placeField(view) !== null, "the place field");
      await view.settle(60);
      expect(view.buttonNamed("Use this device's location")).toBeUndefined();
      await view.unmount();
    }
  });
});
