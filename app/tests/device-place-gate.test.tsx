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
import { authKeys } from "../src/lib/auth/queries";
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
 * WHEN THE DEVICE IS ASKED WHERE IT IS — held on the mounted route tree, where the gate lives.
 *
 * `_authed` mounts the device's once (`useDevicePlaceOnce`) above every signed-in screen, and two
 * of those screens exist to ask for something first: `/welcome`, the first run, whose button
 * records the agreement to the terms, and `/consent`, which asks again when the text has changed.
 * The first cut ran for anybody signed in: a new person met the browser's location dialog on the
 * first-run screen, and a browser that had already said yes was read and its coordinates saved
 * before any agreement was recorded (review of pull request 91).
 *
 * So these mount the real routes with a browser that says yes to everything — the worst case, where
 * nothing would be shown — and count what was asked of it and what reached the server.
 *
 * And, further down, what an open does once the person may be asked: a device that already said
 * yes is read again and its place follows it; a place cleared on this device is left alone; the
 * two marks as a browser's storage really keeps them; and the installed app, which asks its shell.
 */

/** That this device's once is spent — the one key from before the place followed the device. */
const MARK = "laf.device-place-asked";
/** Whether the person cleared this device's place here: `1`, or `0` from a build that knows. */
const CLEARED = "laf.device-place-cleared";
const DEVICE = { latitude: 37.498_095, longitude: 127.027_61 };
/** `DEVICE`, as anything is ever allowed to hold it. */
const DEVICE_COARSE = { latitude: 37.5, longitude: 127.03 };
const ELSEWHERE = { latitude: 35.16, longitude: 129.16 };

let queried = 0;
let read = 0;
let state: "granted" | "prompt" | "denied" = "granted";
const real = {
  permissions: undefined as PropertyDescriptor | undefined,
  geolocation: undefined as PropertyDescriptor | undefined,
};

beforeAll(async () => {
  await installAppDom();
  real.permissions = Object.getOwnPropertyDescriptor(navigator, "permissions");
  real.geolocation = Object.getOwnPropertyDescriptor(navigator, "geolocation");
}, APP_DOM_TIMEOUT_MS);
beforeEach(() => {
  queried = 0;
  read = 0;
  state = "granted";
  localStorage.removeItem(MARK);
  localStorage.removeItem(CLEARED);
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: async () => {
        queried += 1;
        return { state };
      },
    },
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (resolve: (position: unknown) => void) => {
        read += 1;
        resolve({ coords: DEVICE });
      },
    },
  });
});
afterEach(async () => {
  await unmountApps();
  localStorage.removeItem(MARK);
  localStorage.removeItem(CLEARED);
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  for (const name of ["permissions", "geolocation"] as const) {
    const descriptor = real[name];
    if (descriptor) Object.defineProperty(navigator, name, descriptor);
    else delete (navigator as unknown as Record<string, unknown>)[name];
  }
});
setDefaultTimeout(20_000);
afterAll(removeAppDom);

type Me = {
  onboarded: boolean;
  /** The agreement on record against the current text; absent on a deployment that records none. */
  consent?: { version: string | null; current: string };
  whereabouts?: {
    place: string | null;
    coordinates: { latitude: number; longitude: number } | null;
  };
};

function server(me: Me) {
  const writes: Array<{ method: string; body: unknown }> = [];
  let held = {
    timeZone: "Asia/Seoul",
    locale: "ko-KR",
    place: null as string | null,
    coordinates: null as { latitude: number; longitude: number } | null,
    ...me.whereabouts,
  };
  const api = (request: ApiRequest) => {
    const { pathname, method } = request;
    if (pathname === "/api/me") {
      return json({
        user: {
          ...CURRENT_USER,
          role: "user",
          onboarded: me.onboarded,
          shop: { kind: null, places: [] },
          whereabouts: held,
        },
        deployment: { effort: true, autoReview: true },
        ...(me.consent ? { consent: me.consent } : {}),
      });
    }
    if (pathname === "/api/me/place") {
      writes.push({ method, body: request.body });
      held = { ...held, ...(request.body as object) };
      return json({ whereabouts: held });
    }
    // The device's clock, reported at every open: answered as kept, so it is not what is counted.
    if (pathname === "/api/me/device") return json({ whereabouts: held });
    return undefined;
  };
  return { api, writes };
}

const OWED = { version: null, current: "2026-10-01" };

describe("the browser is asked where it is only once the person has agreed", () => {
  test("the first-run screen asks nothing of it, reads nothing and saves nothing — and spends nothing", async () => {
    const { api, writes } = server({ onboarded: false, consent: OWED });
    const view = await mountApp({ path: "/welcome", api });
    await view.settle(60);
    expect(view.router.state.location.pathname).toBe("/welcome");
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
    expect(writes).toEqual([]);
    expect(localStorage.getItem(MARK)).toBeNull();
  });

  test("a first run on a deployment that records no agreement is still a first run", async () => {
    const { api, writes } = server({ onboarded: false });
    const view = await mountApp({ path: "/welcome", api });
    await view.settle(60);
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
    expect(writes).toEqual([]);
  });

  test("the screen that asks again for the agreement asks nothing of it either, wherever the person was going", async () => {
    const { api, writes } = server({ onboarded: true, consent: OWED });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.settle(60);
    // `_authed`'s guard: nothing else is reached until they answer.
    expect(view.router.state.location.pathname).toBe("/consent");
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
    expect(writes).toEqual([]);
    expect(localStorage.getItem(MARK)).toBeNull();
  });

  test("once they have agreed, the screen they land on asks — once, and the coordinates go alone", async () => {
    const owed = server({ onboarded: true, consent: OWED });
    let agreed = false;
    const view = await mountApp({
      path: "/consent",
      api: (request) => {
        if (request.pathname === "/api/me" && agreed) {
          return json({
            user: {
              ...CURRENT_USER,
              role: "user",
              onboarded: true,
              shop: { kind: null, places: [] },
              whereabouts: {
                timeZone: "Asia/Seoul",
                locale: "ko-KR",
                place: null,
                coordinates: null,
              },
            },
            deployment: { effort: true, autoReview: true },
            consent: { version: OWED.current, current: OWED.current },
          });
        }
        return owed.api(request);
      },
    });
    await view.settle(60);
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });

    // The agreement is recorded and the guards hear of it, as `agreeToLegal` does it.
    agreed = true;
    await view.queryClient.refetchQueries({
      queryKey: authKeys.currentUser(),
      type: "all",
    });
    await view.settle(60);
    // Still on the screen that asked: not here, even now.
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });

    await view.navigate("/settings/shop");
    await view.waitFor(() => owed.writes.length === 1, "the device's place");
    expect({ queried, read }).toEqual({ queried: 1, read: 1 });
    // Coarse, and no word about the place the person may have said: the key is not there at all.
    expect(owed.writes).toEqual([
      { method: "PUT", body: { coordinates: DEVICE_COARSE } },
    ]);
    // Asked, and not cleared: the old key as it always was, and the new one beside it.
    expect(localStorage.getItem(MARK)).toBe("1");
    expect(localStorage.getItem(CLEARED)).toBe("0");
  });
});

describe("and not when there is nothing to ask for", () => {
  test("a person who has said where they are is not asked, and the once is not spent", async () => {
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: "강원 춘천시", coordinates: null },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.settle(60);
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
    expect(writes).toEqual([]);
    expect(localStorage.getItem(MARK)).toBeNull();
  });

  test("a browser that has not said yes is shown nothing over a place the account holds, and the once is spent", async () => {
    state = "prompt";
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: ELSEWHERE },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(
      () => localStorage.getItem(MARK) === "1",
      "the once to be spent",
    );
    await view.settle(60);
    // Asked what it would say — which shows nothing — and not read.
    expect({ queried, read }).toEqual({ queried: 1, read: 0 });
    expect(writes).toEqual([]);
    expect(localStorage.getItem(CLEARED)).toBe("0");
  });

  test("a browser that has not decided is asked, and one that said no is left alone", async () => {
    state = "prompt";
    const asked = server({ onboarded: true });
    const first = await mountApp({ path: "/settings/shop", api: asked.api });
    await first.waitFor(() => asked.writes.length === 1, "the answer");
    expect({ queried, read }).toEqual({ queried: 1, read: 1 });
    await first.unmount();

    localStorage.removeItem(MARK);
    queried = 0;
    read = 0;
    state = "denied";
    const refused = server({ onboarded: true });
    const second = await mountApp({ path: "/settings/shop", api: refused.api });
    await second.waitFor(() => queried === 1, "the browser's answer");
    await second.settle(60);
    expect(read).toBe(0);
    expect(refused.writes).toEqual([]);
    expect(localStorage.getItem(MARK)).toBeNull();
  });
});

/**
 * THE PLACE FOLLOWS THE DEVICE.
 *
 * MEASURED BEFORE THIS, in a browser that had already said yes, opened in 부산 over an account
 * holding 춘천: the device was marked and never read. Coordinates saved at the first allow were a
 * snapshot, and the "real location" default was wherever the person had been that day.
 */
describe("a device that already said yes is read again at every open", () => {
  test("over a place the account holds, the place moves with the device — and nothing is shown for it", async () => {
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: ELSEWHERE },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => writes.length === 1, "the device's place");
    expect({ queried, read }).toEqual({ queried: 1, read: 1 });
    expect(writes).toEqual([
      { method: "PUT", body: { coordinates: DEVICE_COARSE } },
    ]);
    // A device seeing the account's place for the first time has had its once, and follows.
    expect(localStorage.getItem(MARK)).toBe("1");
    expect(localStorage.getItem(CLEARED)).toBe("0");
  });

  test("a device that has not moved is read and writes nothing", async () => {
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: DEVICE_COARSE },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => read === 1, "the device to be read");
    await view.settle(60);
    expect(writes).toEqual([]);
  });

  test("a person who has said where they are is not followed, whatever the account also holds", async () => {
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: "강원 춘천시", coordinates: ELSEWHERE },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(
      () => localStorage.getItem(MARK) === "1",
      "the once to be spent",
    );
    await view.settle(60);
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
    expect(writes).toEqual([]);
  });

  test("a place cleared on this device is not read back — not even after another device gives the account one", async () => {
    localStorage.setItem(MARK, "1");
    localStorage.setItem(CLEARED, "1");
    for (const coordinates of [null, ELSEWHERE]) {
      const { api, writes } = server({
        onboarded: true,
        whereabouts: { place: null, coordinates },
      });
      const view = await mountApp({ path: "/settings/shop", api });
      await view.settle(60);
      expect({ queried, read }).toEqual({ queried: 0, read: 0 });
      expect(writes).toEqual([]);
      await view.unmount();
    }
    expect(localStorage.getItem(CLEARED)).toBe("1");
  });

  test("a mark from before 'cleared' existed stays quiet over nothing, and follows over coordinates", async () => {
    /*
     * `laf.device-place-asked=1` was written when a device was asked and when its place was cleared
     * alike, and it is on people's devices with no second key beside it. Over nothing held it may
     * have been a 지우기, so nothing is read; over coordinates it was not, and the device follows —
     * and is marked the way this build marks, so the next open need not guess.
     */
    localStorage.setItem(MARK, "1");
    const quiet = server({ onboarded: true });
    const first = await mountApp({ path: "/settings/shop", api: quiet.api });
    await first.settle(60);
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
    expect(quiet.writes).toEqual([]);
    expect(localStorage.getItem(CLEARED)).toBeNull();
    await first.unmount();

    const held = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: ELSEWHERE },
    });
    const second = await mountApp({ path: "/settings/shop", api: held.api });
    await second.waitFor(() => held.writes.length === 1, "the device's place");
    expect(held.writes).toEqual([
      { method: "PUT", body: { coordinates: DEVICE_COARSE } },
    ]);
    expect(localStorage.getItem(MARK)).toBe("1");
    expect(localStorage.getItem(CLEARED)).toBe("0");
  });
});

/**
 * THE INSTALLED APP ASKS ITS SHELL.
 *
 * Its webview answers no geolocation request, so until the shell could read the device the
 * surface this product leads with was the one that fell straight to Seoul. The same hook runs
 * there, through the shell's two commands instead of the browser's two APIs — and the browser's
 * are not touched, which in a real webview would fail without a word.
 */
describe("in the installed app the shell is asked, by the same rules", () => {
  /**
   * A shell that answers the two questions about the device. What it was asked is kept apart:
   * `looks` — what it would say, which shows nobody anything and which this screen's own button
   * asks as well as the open — and `reads`, each of which is the device really being read.
   */
  function shell(answers: { permission: unknown; place?: unknown }) {
    const asked = { looks: [] as unknown[], reads: [] as unknown[] };
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      core: {
        invoke: async (command: string, args: unknown) => {
          if (command === "device_place_permission") {
            asked.looks.push(args);
            return answers.permission;
          }
          if (command === "device_place") {
            asked.reads.push(args);
            return answers.place;
          }
          // The tray, the badge and the rest of what a shell is asked: not what is counted.
          return undefined;
        },
      },
    };
    return asked;
  }

  test("a device that has not decided is asked once, and one that already said yes is read with nothing shown", async () => {
    const asked = shell({
      permission: "prompt",
      place: { kind: "place", ...DEVICE },
    });
    const first = server({ onboarded: true });
    const once = await mountApp({ path: "/settings/shop", api: first.api });
    await once.waitFor(() => first.writes.length === 1, "the device's place");
    // The one read that may put the system's question in front of the person.
    expect(asked.reads).toEqual([{ prompt: true }]);
    expect(asked.looks.length).toBeGreaterThan(0);
    // Rounded by the shell in the real thing; rounded here whatever the shell did.
    expect(first.writes).toEqual([
      { method: "PUT", body: { coordinates: DEVICE_COARSE } },
    ]);
    expect(localStorage.getItem(MARK)).toBe("1");
    await once.unmount();

    // The next open, somewhere else: allowed now, so read again — told to show nothing.
    const followed = shell({
      permission: "granted",
      place: { kind: "place", ...ELSEWHERE },
    });
    const second = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: DEVICE_COARSE },
    });
    const again = await mountApp({ path: "/settings/shop", api: second.api });
    await again.waitFor(() => second.writes.length === 1, "the new place");
    expect(followed.reads).toEqual([{ prompt: false }]);
    expect(second.writes).toEqual([
      { method: "PUT", body: { coordinates: ELSEWHERE } },
    ]);
    // The browser's own APIs were never part of it.
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
  });

  test("a shell that cannot read the device — from before it could, or on Windows — is asked and left alone", async () => {
    for (const permission of [undefined, "unsupported", "denied"]) {
      localStorage.removeItem(MARK);
      localStorage.removeItem(CLEARED);
      const asked = shell({
        permission,
        place: { kind: "place", ...DEVICE },
      });
      const { api, writes } = server({ onboarded: true });
      const view = await mountApp({ path: "/settings/shop", api });
      await view.waitFor(() => asked.looks.length > 0, "the shell's answer");
      await view.settle(60);
      // What it would say, and nothing after: no read, no dialog, no mark, no write.
      expect(asked.reads).toEqual([]);
      expect(writes).toEqual([]);
      expect(localStorage.getItem(MARK)).toBeNull();
      expect({ queried, read }).toEqual({ queried: 0, read: 0 });
      await view.unmount();
    }
  });
});
