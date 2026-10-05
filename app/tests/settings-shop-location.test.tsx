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
/** And that the person cleared this device's place here: `1`. Absent, they have not. */
const DEVICE_CLEARED = "laf.device-place-cleared";
/** When this device was last read by itself. */
const DEVICE_READ_AT = "laf.device-place-read-at";

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
/*
 * A DEVICE WHOSE PERSON HAS DECIDED, unless a test says otherwise. Every signed-in screen asks the
 * browser where it is when it is looked at (`useDevicePlace`), and this DOM's browser says yes to
 * everything: left unmarked, the first test to hand it a working `geolocation` would have its
 * coordinates saved at open, before the button this file is about was pressed. The tests passed
 * without this only in the order they were written in — whichever ran first spent the once for the
 * rest. (Marked, with nothing held, the device is read by itself only where the browser also says
 * it is already allowed — which is the two tests that say so.)
 */
beforeEach(() => {
  localStorage.removeItem(DEVICE_READ_AT);
  localStorage.setItem(DEVICE_ASKED, "1");
});
afterEach(async () => {
  await unmountApps();
  for (const key of [DEVICE_ASKED, DEVICE_CLEARED, DEVICE_READ_AT]) {
    localStorage.removeItem(key);
  }
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  delete (navigator as unknown as Record<string, unknown>).permissions;
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

function server(
  kept: Kept,
  options: { refuse?: boolean; failClear?: () => boolean } = {},
) {
  const writes: Array<{ method: string; body: unknown }> = [];
  /** What this device's "cleared" mark said at the moment each 지우기 reached the server. */
  const clearedMarkAtClear: Array<string | null> = [];
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
      if (method === "DELETE") {
        clearedMarkAtClear.push(localStorage.getItem(DEVICE_CLEARED));
        if (options.failClear?.()) return json({ error: "down" }, 503);
      }
      held =
        method === "DELETE"
          ? { ...held, place: null, coordinates: null }
          : { ...held, ...(request.body as Kept) };
      return json({ whereabouts: held });
    }
    return undefined;
  };
  return { api, writes, clearedMarkAtClear };
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

  test("a device that answers by itself while this screen is open is what the screen shows, and what a typed save sends", async () => {
    /*
     * The form copied the account's coordinates when it mounted. The device answers by itself at
     * every open now, so the copy went stale in front of the person: the line named where the
     * device HAD been, the save button lit with nothing changed, and saving a typed place sent the
     * older coordinates back over the ones the device had just given. (Left as known in pull
     * request 91, when the device answered once and the form's copy was a blank.)
     */
    localStorage.removeItem(DEVICE_ASKED);
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted" }) },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (resolve: (position: unknown) => void) =>
          resolve({
            coords: {
              latitude: 37.498_095,
              longitude: 127.027_61,
              accuracy: 65,
            },
          }),
      },
    });
    // The account holds where the device was the last time; the device has moved since.
    const { api, writes } = server({
      place: null,
      coordinates: { latitude: 35.16, longitude: 129.16 },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => writes.length === 1, "the device's own answer");
    expect(writes[0]?.body).toEqual({
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    await view.waitFor(
      () => view.host.textContent?.includes("37.50, 127.03") === true,
      "the place the device just gave",
    );
    expect(view.host.textContent).not.toContain("35.16");
    // The person changed nothing: there is nothing to save.
    expect(view.buttonNamed("Save the location")?.disabled).toBe(true);

    // They type where the shop is and save: the coordinates that go are the account's own.
    const field = placeField(view);
    if (!field) throw new Error("no place field");
    await view.type(field, "부산 해운대구");
    await press(view, "Save the location");
    await view.waitFor(() => writes.length === 2, "the save");
    expect(writes[1]).toEqual({
      method: "PUT",
      body: {
        place: "부산 해운대구",
        coordinates: { latitude: 37.5, longitude: 127.03 },
      },
    });
  });

  test("a cleared place is taken back by SAVING what the device's button gave — looking is not giving", async () => {
    /*
     * THE PRESS UN-CLEARED BEFORE ANYTHING WAS SAVED (review of pull request 94). Somebody who had
     * cleared this device's place pressed its button, looked at where it said they were, and left
     * without saving: the mark was already lifted, so the next open read the device by itself and
     * saved it — the place they had cleared, back without their having given it.
     */
    localStorage.setItem(DEVICE_CLEARED, "1");
    let reads = 0;
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted" }) },
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (resolve: (position: unknown) => void) => {
          reads += 1;
          resolve({
            coords: {
              latitude: 37.498_095,
              longitude: 127.027_61,
              accuracy: 65,
            },
          });
        },
      },
    });
    const { api, writes } = server({ place: null, coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");
    await view.settle(60);
    // Cleared here: a browser that says yes is not read by itself.
    expect(reads).toBe(0);

    // The person looks at where this device is — and leaves.
    await press(view, "Use this device's location");
    await view.waitFor(
      () => view.host.textContent?.includes("37.50, 127.03") === true,
      "the device's place, coarse",
    );
    expect(reads).toBe(1);
    expect(localStorage.getItem(DEVICE_CLEARED)).toBe("1");
    await view.unmount();

    // The next open: still cleared, so still nothing read and nothing saved by itself.
    const again = await mountApp({ path: "/settings/shop", api });
    await again.waitFor(() => placeField(again) !== null, "the place field");
    await again.settle(60);
    expect(reads).toBe(1);
    expect(writes).toEqual([]);

    // This time they save it: that is giving the place again, and the mark goes.
    await press(again, "Use this device's location");
    await again.waitFor(
      () => again.host.textContent?.includes("37.50, 127.03") === true,
      "the device's place, coarse",
    );
    await press(again, "Save the location");
    await again.waitFor(() => writes.length === 1, "the save");
    expect(writes[0]?.body).toEqual({
      place: null,
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    expect(localStorage.getItem(DEVICE_CLEARED)).toBeNull();
    // And they decided about this device by pressing: nobody is to ask them again.
    expect(localStorage.getItem(DEVICE_ASKED)).toBe("1");
  });

  test("지우기 marks this device before its request goes, and takes the mark off again if the server does not take the clear", async () => {
    /*
     * The mark was written when the server's answer came back. A follow reading the device at that
     * moment looks at the mark when the device answers — and between the request and its answer
     * there was none, so it could save the place back (review of pull request 94).
     */
    let isDown = true;
    const { api, writes, clearedMarkAtClear } = server(
      { place: null, coordinates: { latitude: 37.5, longitude: 127.03 } },
      { failClear: () => isDown },
    );
    const view = await mountApp({ path: "/settings/shop", api });

    // The server is down: the place was not cleared, so no device is left silenced.
    await press(view, "Clear the location");
    await view.waitFor(() => writes.length === 1, "the clear that fails");
    await view.waitFor(
      () =>
        view.host.textContent?.includes("That was not saved. Try again.") ===
        true,
      "the failure, in words",
    );
    // It was marked when the request arrived…
    expect(clearedMarkAtClear).toEqual(["1"]);
    // …and is not marked now.
    expect(localStorage.getItem(DEVICE_CLEARED)).toBeNull();

    // Back up: cleared, and marked from before the request to after it.
    isDown = false;
    await press(view, "Clear the location");
    await view.waitFor(() => writes.length === 2, "the clear");
    await view.waitFor(
      () => view.buttonNamed("Clear the location") === undefined,
      "the clear button to go",
    );
    expect(clearedMarkAtClear).toEqual(["1", "1"]);
    expect(localStorage.getItem(DEVICE_CLEARED)).toBe("1");
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

  test("a question nobody answers gives the button back and says so, and a second press asks again", async () => {
    /*
     * A PRESS JOINED A WAIT THAT NEVER ENDED (review of pull request 94). The system shows its
     * question only for an app that is in use and says nothing when it does not; the shell waited
     * on an answer that could not come, and this button sat at "찾는 중…" with every control on
     * the section disabled until the app was quit. The shell answers `unanswered` after a minute.
     */
    const reads: unknown[] = [];
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: async (command: string, args: unknown) => {
          if (command === "device_place_permission") return "prompt";
          if (command === "device_place") {
            reads.push(args);
            // The first time the question goes unanswered; the second, the person says yes.
            return reads.length === 1
              ? { kind: "unanswered" }
              : {
                  kind: "place",
                  latitude: 37.498_095,
                  longitude: 127.027_61,
                  accuracy: 65,
                };
          }
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
          "The question about this device's location has not been answered. If you do not see it, press again.",
        ) === true,
      "what happened, in words",
    );
    // The section is the person's again: the button is back, and nothing was saved or decided.
    expect(view.buttonNamed("Use this device's location")?.disabled).toBe(
      false,
    );
    expect(placeField(view)?.disabled).toBe(false);
    expect(writes).toEqual([]);

    await press(view, "Use this device's location");
    await view.waitFor(
      () => view.host.textContent?.includes("37.50, 127.03") === true,
      "the device's place, coarse",
    );
    expect(reads).toEqual([{ prompt: true }, { prompt: true }]);
    expect(view.host.textContent).not.toContain("has not been answered");
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
