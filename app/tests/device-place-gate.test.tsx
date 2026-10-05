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
 * WHEN THE BROWSER IS ASKED WHERE IT IS — held on the mounted route tree, where the gate lives.
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
 */

const MARK = "laf.device-place-asked";
const DEVICE = { latitude: 37.498_095, longitude: 127.027_61 };

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
      {
        method: "PUT",
        body: { coordinates: { latitude: 37.5, longitude: 127.03 } },
      },
    ]);
    expect(localStorage.getItem(MARK)).toBe("1");
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

  test("coordinates the account holds are not asked for again, and the once is spent on this device", async () => {
    const { api, writes } = server({
      onboarded: true,
      whereabouts: {
        place: null,
        coordinates: { latitude: 35.16, longitude: 129.16 },
      },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(
      () => localStorage.getItem(MARK) === "1",
      "the once to be spent",
    );
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
    expect(writes).toEqual([]);
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
