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
 * `_authed` mounts the device's place (`useDevicePlace`) above every signed-in screen, and two of
 * those screens exist to ask for something first: `/welcome`, the first run, whose button records
 * the agreement to the terms, and `/consent`, which asks again when the text has changed. The
 * first cut ran for anybody signed in: a new person met the browser's location dialog on the
 * first-run screen, and a browser that had already said yes was read and its coordinates saved
 * before any agreement was recorded (review of pull request 91).
 *
 * So these mount the real routes with a browser that says yes to everything — the worst case, where
 * nothing would be shown — and count what was asked of it and what reached the server.
 *
 * And, further down, what a look does once the person may be asked: a device that already said
 * yes is read again and its place follows it, at most once an hour and only for a fix worth
 * keeping; a place cleared on this device is left alone; the marks as a browser's storage really
 * keeps them; the page being looked at again; and the installed app, which asks its shell.
 */

/** That this device's once is spent: `1`. `0` is the installed app's question, put and not answered. */
const MARK = "laf.device-place-asked";
/** That the person cleared this device's place here: `1`. Absent, they have not. */
const CLEARED = "laf.device-place-cleared";
/** When this device was last read by itself, in milliseconds. */
const READ_AT = "laf.device-place-read-at";
const DEVICE = { latitude: 37.498_095, longitude: 127.027_61 };
/** `DEVICE`, as anything is ever allowed to hold it. */
const DEVICE_COARSE = { latitude: 37.5, longitude: 127.03 };
const ELSEWHERE = { latitude: 35.16, longitude: 129.16 };

let queried = 0;
let read = 0;
let state: "granted" | "prompt" | "denied" = "granted";
/** Where the browser says the device is, and how far off it says that may be, in metres. */
let device = DEVICE;
let accuracy: number | undefined = 65;
/** What the page is told about being looked at. */
let visibility: "visible" | "hidden" = "visible";
const real = {
  permissions: undefined as PropertyDescriptor | undefined,
  geolocation: undefined as PropertyDescriptor | undefined,
};

/** The page is put away, or looked at again: what a tab switched back to and a window uncovered say. */
function look(next: "visible" | "hidden") {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** The window is clicked into, or brought to the front, while it was on screen all along. */
function comeBack() {
  window.dispatchEvent(new Event("focus"));
}

/** An hour and a minute have passed since this device was last read by itself. */
function anHourPasses() {
  localStorage.setItem(READ_AT, String(Date.now() - 61 * 60_000));
}

beforeAll(async () => {
  await installAppDom();
  real.permissions = Object.getOwnPropertyDescriptor(navigator, "permissions");
  real.geolocation = Object.getOwnPropertyDescriptor(navigator, "geolocation");
}, APP_DOM_TIMEOUT_MS);
beforeEach(() => {
  queried = 0;
  read = 0;
  state = "granted";
  device = DEVICE;
  accuracy = 65;
  visibility = "visible";
  for (const key of [MARK, CLEARED, READ_AT]) localStorage.removeItem(key);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
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
        resolve({ coords: { ...device, accuracy } });
      },
    },
  });
});
afterEach(async () => {
  await unmountApps();
  for (const key of [MARK, CLEARED, READ_AT]) localStorage.removeItem(key);
  delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  delete (document as unknown as Record<string, unknown>).visibilityState;
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
    // Decided, and not cleared: nothing is written about a 지우기 that was not pressed.
    expect(localStorage.getItem(MARK)).toBe("1");
    expect(localStorage.getItem(CLEARED)).toBeNull();
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
  });

  test("a prompt a browser's person ignores has still been the once: the next load does not ask again", async () => {
    /*
     * A browser shows its prompt the moment it is asked and says nothing back if it is ignored.
     * Spending the once only on an answer — which is right for the installed app, whose question
     * may never have appeared — made every load of a tab ask again (review of pull request 94).
     */
    state = "prompt";
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        // The prompt is up, and nobody answers it.
        getCurrentPosition: () => {
          read += 1;
        },
      },
    });
    const { api, writes } = server({ onboarded: true });
    const first = await mountApp({ path: "/settings/shop", api });
    await first.waitFor(() => read === 1, "the prompt");
    // Spent as the question was put, with no answer to wait for.
    expect(localStorage.getItem(MARK)).toBe("1");
    await first.unmount();

    const second = await mountApp({ path: "/settings/shop", api });
    await second.waitFor(() => queried === 2, "the browser's word on asking");
    await second.settle(60);
    expect(read).toBe(1);
    expect(writes).toEqual([]);
  });

  test("a browser that has not decided is asked, and one that said no is left alone", async () => {
    state = "prompt";
    const asked = server({ onboarded: true });
    const first = await mountApp({ path: "/settings/shop", api: asked.api });
    await first.waitFor(() => asked.writes.length === 1, "the answer");
    expect({ queried, read }).toEqual({ queried: 1, read: 1 });
    await first.unmount();

    for (const key of [MARK, READ_AT]) localStorage.removeItem(key);
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
describe("a device that already said yes is read again when the page is looked at", () => {
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
    expect(localStorage.getItem(CLEARED)).toBeNull();
    // And when it was read is kept on the device: that is what makes it once an hour.
    expect(Date.now() - Number(localStorage.getItem(READ_AT))).toBeLessThan(
      60_000,
    );
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

  test("the page looked at again follows the device — and looking twice in an hour reads it once", async () => {
    /*
     * THE INSTALLED APP IS NOT OPENED TWICE. Closing its window puts it away and the page behind
     * it lives for days, so a hook that ran once per mount ran once per install: somebody who
     * travelled with the app in the tray stayed where they had been until they quit it (review of
     * pull request 94). The page is told when it is seen again, and that is a look too.
     */
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: DEVICE_COARSE },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => read === 1, "the device to be read at the open");
    await view.settle(60);
    expect(writes).toEqual([]);

    // Put away and looked at again a moment later, in another town: within the hour the device
    // is not read — it is not even asked what it would say.
    device = ELSEWHERE;
    look("hidden");
    look("visible");
    await view.settle(60);
    expect({ queried, read }).toEqual({ queried: 1, read: 1 });
    expect(writes).toEqual([]);

    // An hour on, the same look reads it, and the place moves.
    anHourPasses();
    look("hidden");
    await view.settle(30);
    expect(read).toBe(1);
    look("visible");
    await view.waitFor(() => writes.length === 1, "the new place");
    expect({ queried, read }).toEqual({ queried: 2, read: 2 });
    expect(writes).toEqual([
      { method: "PUT", body: { coordinates: ELSEWHERE } },
    ]);
  });

  test("a page that is not being looked at asks nothing until it is", async () => {
    // A tab opened behind another; an app started at login with its window put away.
    visibility = "hidden";
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: ELSEWHERE },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.settle(60);
    expect({ queried, read }).toEqual({ queried: 0, read: 0 });
    expect(writes).toEqual([]);
    expect(localStorage.getItem(MARK)).toBeNull();

    look("visible");
    await view.waitFor(() => writes.length === 1, "the device's place");
    expect({ queried, read }).toEqual({ queried: 1, read: 1 });
  });

  test("a fix too vague to name the town is not kept by itself, and the place the account has stays", async () => {
    /*
     * A desktop on a cable is placed by its address, to within a city or two. "Last looked at
     * wins" would have let that overwrite the good place a laptop gave, at every open.
     */
    accuracy = 48_000;
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: ELSEWHERE },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => read === 1, "the device to be read");
    await view.settle(60);
    expect(writes).toEqual([]);

    // A browser that does not say how far off it is has not said it is good.
    accuracy = undefined;
    anHourPasses();
    look("visible");
    await view.waitFor(() => read === 2, "the device to be read again");
    await view.settle(60);
    expect(writes).toEqual([]);

    // Good to a few streets: now it is kept.
    accuracy = 800;
    anHourPasses();
    look("visible");
    await view.waitFor(() => writes.length === 1, "the device's place");
    expect(writes).toEqual([
      { method: "PUT", body: { coordinates: DEVICE_COARSE } },
    ]);
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
      // Not at the open, and not when the page is looked at again.
      look("hidden");
      look("visible");
      await view.settle(60);
      expect({ queried, read }).toEqual({ queried: 0, read: 0 });
      expect(writes).toEqual([]);
      await view.unmount();
    }
    expect(localStorage.getItem(CLEARED)).toBe("1");
  });

  test("a device whose person decided before, and that says yes, is read: the two marks are read plainly", async () => {
    // Decided, nothing held, allowed: the answer that never arrived is fetched with nothing shown.
    localStorage.setItem(MARK, "1");
    const { api, writes } = server({ onboarded: true });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => writes.length === 1, "the device's place");
    expect(writes).toEqual([
      { method: "PUT", body: { coordinates: DEVICE_COARSE } },
    ]);
    // No key about clearing appears because one about asking was there.
    expect(localStorage.getItem(CLEARED)).toBeNull();
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
   * `answers` may be changed between looks: the device moves, the person decides.
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

  test("a device that has not decided is asked, and one that already said yes is read with nothing shown", async () => {
    const asked = shell({
      permission: "prompt",
      place: { kind: "place", ...DEVICE, accuracy: 65 },
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

    // An hour on, somewhere else: allowed now, so read again — told to show nothing.
    anHourPasses();
    const followed = shell({
      permission: "granted",
      place: { kind: "place", ...ELSEWHERE, accuracy: 65 },
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

  test("in the installed app a question the person never answered spends nothing, and the next look asks again", async () => {
    /*
     * THE ONE ASK WAS SPENT ON A DIALOG NOBODY SAW (review of pull request 94). The system shows
     * its question only for an app that is in use, and says nothing when it does not: the ask
     * hung, already marked. The shell answers `unanswered` after a minute now.
     */
    const asked = shell({
      permission: "prompt",
      place: { kind: "unanswered" },
    });
    const { api, writes } = server({ onboarded: true });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => asked.reads.length === 1, "the ask");
    await view.settle(60);
    expect(asked.reads).toEqual([{ prompt: true }]);
    expect(writes).toEqual([]);
    // Asked, and not answered: nothing decided, and nothing noted as a read.
    expect(localStorage.getItem(MARK)).toBe("0");
    expect(localStorage.getItem(READ_AT)).toBeNull();

    // The window is brought to the front again: that is a look, and the person is asked again.
    comeBack();
    await view.waitFor(() => asked.reads.length === 2, "the second ask");
    expect(asked.reads).toEqual([{ prompt: true }, { prompt: true }]);
    expect(localStorage.getItem(MARK)).toBe("0");
  });

  test("a second look while the person is still being asked starts nothing: one question, one answer", async () => {
    // The system's question is up and the person is reading it. However often the window is
    // looked at meanwhile, the shell is asked nothing more — not even what it would say.
    let answer: (place: unknown) => void = () => {};
    const asked = shell({
      permission: "prompt",
      place: new Promise((resolve) => {
        answer = resolve;
      }),
    });
    const { api, writes } = server({ onboarded: true });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => asked.reads.length === 1, "the ask");
    await view.settle(60);
    const looks = asked.looks.length;
    comeBack();
    look("hidden");
    look("visible");
    comeBack();
    await view.settle(60);
    expect(asked.reads).toEqual([{ prompt: true }]);
    expect(asked.looks).toHaveLength(looks);

    // They say yes: one place, saved once.
    answer({ kind: "place", ...DEVICE, accuracy: 65 });
    await view.waitFor(() => writes.length === 1, "the device's place");
    await view.settle(60);
    expect(writes).toEqual([
      { method: "PUT", body: { coordinates: DEVICE_COARSE } },
    ]);
    expect(localStorage.getItem(MARK)).toBe("1");
  });

  test("bringing the window back is a look: put away and shown again, or clicked into, the device is followed", async () => {
    /*
     * Closing the installed app only puts its window away, and bringing it back reloads nothing.
     * What the page is told is what a tab is told — it is seen again, or its window has the
     * keyboard again — and both are a look.
     */
    const answers = {
      permission: "granted",
      place: { kind: "place", ...DEVICE, accuracy: 65 } as unknown,
    };
    const asked = shell(answers);
    const { api, writes } = server({
      onboarded: true,
      whereabouts: { place: null, coordinates: DEVICE_COARSE },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => asked.reads.length === 1, "the read at the open");
    await view.settle(60);
    expect(writes).toEqual([]);

    // Away in the tray and back within the hour, in another town: nothing.
    answers.place = { kind: "place", ...ELSEWHERE, accuracy: 65 };
    look("hidden");
    look("visible");
    comeBack();
    await view.settle(60);
    expect(asked.reads).toHaveLength(1);

    // An hour on, the window is brought back from the tray: read, with nothing shown, and moved.
    anHourPasses();
    look("hidden");
    look("visible");
    await view.waitFor(() => writes.length === 1, "the new place");
    expect(asked.reads).toEqual([{ prompt: false }, { prompt: false }]);
    expect(writes).toEqual([
      { method: "PUT", body: { coordinates: ELSEWHERE } },
    ]);

    // And another hour on, it was on screen all along and is clicked into: the same.
    answers.place = { kind: "place", ...DEVICE, accuracy: 65 };
    anHourPasses();
    comeBack();
    await view.waitFor(() => writes.length === 2, "the place, back again");
    expect(asked.reads).toHaveLength(3);
    // A window that is not on screen is not a look, whatever has the keyboard.
    anHourPasses();
    look("hidden");
    comeBack();
    await view.settle(60);
    expect(asked.reads).toHaveLength(3);
  });

  test("the first-run screen and the screen that asks again for the agreement ask the shell nothing either", async () => {
    /*
     * The gate is the hook's, not the browser's: the system's own location question in front of
     * somebody who has not yet read what continuing means is the same mistake in an installed app
     * as in a tab, and a shell that already said yes would be read with nothing shown at all. So
     * the worst case again — a shell that would answer everything.
     */
    for (const [path, me] of [
      ["/welcome", { onboarded: false, consent: OWED }],
      ["/welcome", { onboarded: false }],
      ["/settings/shop", { onboarded: true, consent: OWED }],
    ] as const) {
      const asked = shell({
        permission: "granted",
        place: { kind: "place", ...DEVICE, accuracy: 65 },
      });
      const { api, writes } = server(me);
      const view = await mountApp({ path, api });
      await view.settle(60);
      // Not even what it would say — at the open, or when the window is brought back.
      look("hidden");
      look("visible");
      comeBack();
      await view.settle(60);
      expect({ looks: asked.looks, reads: asked.reads }).toEqual({
        looks: [],
        reads: [],
      });
      expect(writes).toEqual([]);
      expect(localStorage.getItem(MARK)).toBeNull();
      await view.unmount();
    }
  });

  test("a shell that cannot read the device — from before it could, or on Windows — is asked and left alone", async () => {
    for (const permission of [undefined, "unsupported", "denied"]) {
      for (const key of [MARK, CLEARED, READ_AT]) localStorage.removeItem(key);
      const asked = shell({
        permission,
        place: { kind: "place", ...DEVICE, accuracy: 65 },
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
