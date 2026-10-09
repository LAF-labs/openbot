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
import { ko } from "../src/lib/i18n-ko";
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
 * SETTINGS → 내 정보 → 위치: where the person is, shown, changed and cleared.
 *
 * The Bot's browser runs on a cloud VM, and a Bot once told its owner the weather "in 제주시, 사장님
 * 위치" off a site's guess of the VM's place. The place kept here is what every run is told instead,
 * and what the Bot saves when it asks in a conversation — so this is where a person sees it and
 * takes it away. Pressed through the real route tree with the server stubbed.
 *
 * ONE SOURCE AT A TIME, AND THE DEVICE BY NAME. The form drew a box holding the place somebody had
 * typed and, under it, where their device had just said it was, as two numbers. The owner allowed
 * their device, saw the box still holding the place typed before, pressed seven more times and
 * asked whether the place in the box was the server's location (2026-10-06). Most of what follows
 * holds the form to what would have answered them: one press uses the device and takes the words
 * away; the device is drawn by the name the server gives it and never by a number; and the
 * sentence under the title says which of the words, the device or Seoul is in use.
 */

/** This browser's mark that its device has had its once (`lib/whereabouts/device-place.ts`). */
const DEVICE_ASKED = "laf.device-place-asked";
/** And that the person cleared this device's place here: `1`. Absent, they have not. */
const DEVICE_CLEARED = "laf.device-place-cleared";
/** When this device was last read by itself. */
const DEVICE_READ_AT = "laf.device-place-read-at";

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
/*
 * A DEVICE THAT WAS READ A MOMENT AGO, unless a test says otherwise. Every signed-in screen offers
 * the device's place when it is looked at (`useDevicePlace`), and this DOM's browser says yes to
 * everything: left alone, the first test to hand it a working `geolocation` would have its
 * coordinates saved at open, before the button this file is about was pressed. The tests passed
 * without this only in the order they were written in — whichever ran first spent the once for the
 * rest — and then only because their devices did not say how far off they were. A device read by
 * itself within the hour is asked nothing; the tests about what a device does by itself take the
 * note away first.
 */
beforeEach(() => {
  localStorage.setItem(DEVICE_READ_AT, String(Date.now()));
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

/**
 * What 기상청's table calls the cells these tests stand in — the real server's own answers for
 * them, held there by `server/tests/whereabouts-routes.test.ts`. The third has no row of its own
 * and is named by its neighbour, which is where the table itself says 부근. Any other point is
 * unnamed here.
 */
const NAMES: Record<string, string> = {
  "37.5,127.03": "서울특별시 강남구·서초구",
  "35.16,129.16": "부산광역시 수영구·해운대구",
  "33.2,126.28": "제주특별자치도 서귀포시 부근",
};

/**
 * The kept facts as the real server answers them (`withName`): the name beside the coordinates,
 * only where the device is the place — no words — and only where the table has one.
 */
function named<Held extends Kept>(held: Held): Held & { near?: string } {
  const near =
    held.coordinates && !held.place
      ? NAMES[`${held.coordinates.latitude},${held.coordinates.longitude}`]
      : undefined;
  return near ? { ...held, near } : held;
}

/** The one sentence under the title: which of the three the Bot goes by. */
const GOES_BY = {
  words:
    "When your Bot looks up the weather or somewhere nearby, it goes by the place written here.",
  device:
    "When your Bot looks up the weather or somewhere nearby, it goes by this device's location.",
  seoul:
    "When your Bot looks up the weather or somewhere nearby, it goes by Seoul for now.",
};

function server(
  kept: Kept,
  options: {
    refuse?: boolean;
    failClear?: () => boolean;
    failSave?: () => boolean;
    /** A server that names the coordinates whatever else is held — which the real one does not. */
    nameAnyway?: string;
  } = {},
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
          whereabouts: options.nameAnyway
            ? { ...held, near: options.nameAnyway }
            : named(held),
        },
        deployment: { autoReview: true },
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
      } else if (options.failSave?.()) {
        return json({ error: "down" }, 503);
      }
      // As the real door does: a key the body names is replaced, one it does not is left.
      held =
        method === "DELETE"
          ? { ...held, place: null, coordinates: null }
          : { ...held, ...(request.body as Kept) };
      return json({ whereabouts: named(held) });
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

/** A browser whose device is where these coordinates say, good to a street or two. */
function browserAt(coords: { latitude: number; longitude: number }) {
  const asked = { reads: 0 };
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (resolve: (position: unknown) => void) => {
        asked.reads += 1;
        resolve({ coords: { ...coords, accuracy: 65 } });
      },
    },
  });
  return asked;
}

/** An installed app whose shell answers a read with each of `places` in turn, then the last. */
function shellAnswering(permission: string, ...places: unknown[]) {
  const reads: unknown[] = [];
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: async (command: string, args: unknown) => {
        if (command === "device_place_permission") return permission;
        if (command === "device_place") {
          reads.push(args);
          return places[Math.min(reads.length, places.length) - 1];
        }
        return undefined;
      },
    },
  };
  return reads;
}

const GANGNAM = { latitude: 37.498_095, longitude: 127.027_61 };
const HAEUNDAE = { latitude: 35.163_1, longitude: 129.163_6 };
const NO_NUMBERS = /\d\d\.\d/;

describe("Settings → 내 정보 → 위치", () => {
  test("shows the kept place, says it is what the Bot goes by, and saves a new one on its own press", async () => {
    const { api, writes } = server({ place: "서울 강남구", coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");

    expect(view.host.textContent).toContain("Shop location");
    expect(view.host.textContent).toContain(GOES_BY.words);
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

  test("with nothing kept it says Seoul, and offers nothing to clear", async () => {
    const { api } = server({ place: null, coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");
    expect(view.host.textContent).toContain(GOES_BY.seoul);
    expect(view.buttonNamed("Clear the location")).toBeUndefined();
    expect(view.host.querySelector("[data-device-place]")).toBeNull();
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
    // Nothing kept, nothing to clear — and the sentence says what is used now.
    await view.waitFor(
      () => view.buttonNamed("Clear the location") === undefined,
      "the clear button to go",
    );
    expect(view.host.textContent).toContain(GOES_BY.seoul);
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

  test("one press uses this device: read, saved at once and drawn by its name — no number, and no second press", async () => {
    const asked = browserAt(GANGNAM);
    const { api, writes } = server({ place: null, coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await press(view, "Use this device's location");
    await view.waitFor(() => writes.length === 1, "the save");
    // Rounded before it is kept, and the words answered about in the same request.
    expect(writes).toEqual([
      {
        method: "PUT",
        body: {
          place: null,
          coordinates: { latitude: 37.5, longitude: 127.03 },
        },
      },
    ]);
    await view.waitFor(
      () => view.host.querySelector("[data-device-place]") !== null,
      "the device's place, by name",
    );
    expect(view.host.querySelector("[data-device-place]")?.textContent).toBe(
      "This device's location: around 서울특별시 강남구·서초구",
    );
    expect(view.host.textContent).toContain(GOES_BY.device);
    // A person reads a place. No coordinate is drawn anywhere on this screen.
    expect(view.host.textContent).not.toMatch(NO_NUMBERS);
    expect(asked.reads).toBe(1);
    // Nothing is left to save: the press was the save.
    expect(view.buttonNamed("Save the location")?.disabled).toBe(true);
  });

  test("with a place in words on the account, one press chooses the device over them: one request, the box emptied, the place named", async () => {
    /*
     * THE OWNER'S OWN PRESS (2026-10-06), told here with other places. The account held a place in
     * words; they pressed 이 기기 위치 쓰기 in the installed app, somewhere else, and allowed it.
     * The box went on saying the words, two numbers appeared under it, and a 저장 they did not
     * press would have changed nothing anyway — what a person said outranks where a device is.
     * They pressed seven more times and asked whether the place in the box was the server's
     * location.
     */
    const reads = shellAnswering("prompt", {
      kind: "place",
      ...HAEUNDAE,
      accuracy: 65,
    });
    const { api, writes } = server({ place: "강원 춘천시", coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(
      () => placeField(view)?.value === "강원 춘천시",
      "the place they had typed",
    );
    expect(view.host.textContent).toContain(GOES_BY.words);
    expect(view.host.querySelector("[data-device-place]")).toBeNull();

    await press(view, "Use this device's location");
    await view.waitFor(() => writes.length === 1, "the save");
    // One read, which may show the system's question, and ONE request: the device, and no words.
    expect(reads).toEqual([{ prompt: true }]);
    expect(writes).toEqual([
      {
        method: "PUT",
        body: {
          place: null,
          coordinates: { latitude: 35.16, longitude: 129.16 },
        },
      },
    ]);
    // The box is empty, the place is named, and the sentence says the device is what is used.
    await view.waitFor(() => placeField(view)?.value === "", "an empty box");
    expect(view.host.querySelector("[data-device-place]")?.textContent).toBe(
      "This device's location: around 부산광역시 수영구·해운대구",
    );
    expect(view.host.textContent).toContain(GOES_BY.device);
    expect(view.host.textContent).not.toContain(GOES_BY.words);
    expect(view.host.textContent).not.toContain("춘천");
    expect(view.host.textContent).not.toMatch(NO_NUMBERS);
  });

  test("a press that is refused, or that nobody answers, changes nothing and says why — and pressing again asks again", async () => {
    /*
     * A PRESS JOINED A WAIT THAT NEVER ENDED (review of pull request 94). The system shows its
     * question only for an app that is in use and says nothing when it does not; the shell waited
     * on an answer that could not come, and this button sat at "찾는 중…" with every control on
     * the section disabled until the app was quit. The shell answers `unanswered` after a minute.
     */
    const reads = shellAnswering(
      "prompt",
      { kind: "unanswered" },
      { kind: "denied" },
      { kind: "place", ...HAEUNDAE, accuracy: 65 },
    );
    const { api, writes } = server({ place: "강원 춘천시", coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    const unchanged = () => {
      expect(writes).toEqual([]);
      expect(placeField(view)?.value).toBe("강원 춘천시");
      expect(placeField(view)?.disabled).toBe(false);
      expect(view.host.textContent).toContain(GOES_BY.words);
      expect(view.host.querySelector("[data-device-place]")).toBeNull();
      // The section is the person's again: the button is back.
      expect(view.buttonNamed("Use this device's location")?.disabled).toBe(
        false,
      );
    };

    // Nobody answers the system's question.
    await press(view, "Use this device's location");
    await view.waitFor(
      () =>
        view.host.textContent?.includes(
          "The question about this device's location has not been answered. If you do not see it, press again.",
        ) === true,
      "what happened, in words",
    );
    unchanged();

    // Pressed again: asked again — and this time the answer is no.
    await press(view, "Use this device's location");
    await view.waitFor(
      () =>
        view.host.textContent?.includes(
          "Location was not allowed on this device.",
        ) === true,
      "the refusal, in words",
    );
    expect(view.host.textContent).not.toContain("has not been answered");
    unchanged();

    // And a yes is taken the moment it is given.
    await press(view, "Use this device's location");
    await view.waitFor(() => writes.length === 1, "the save");
    expect(reads).toEqual([
      { prompt: true },
      { prompt: true },
      { prompt: true },
    ]);
    await view.waitFor(() => placeField(view)?.value === "", "an empty box");
    expect(view.host.textContent).not.toContain("was not allowed");
  });

  test("a device that answers and a server that does not take it: what was there stays, and the screen says so", async () => {
    localStorage.setItem(DEVICE_CLEARED, "1");
    browserAt(GANGNAM);
    const { api, writes } = server(
      { place: "강원 춘천시", coordinates: null },
      { failSave: () => true },
    );
    const view = await mountApp({ path: "/settings/shop", api });
    await press(view, "Use this device's location");
    await view.waitFor(
      () =>
        view.host.textContent?.includes("That was not saved. Try again.") ===
        true,
      "the failure, in words",
    );
    expect(writes).toHaveLength(1);
    expect(placeField(view)?.value).toBe("강원 춘천시");
    expect(view.host.textContent).toContain(GOES_BY.words);
    expect(view.host.querySelector("[data-device-place]")).toBeNull();
    // And a 지우기 made here is not taken back by a press that saved nothing.
    expect(localStorage.getItem(DEVICE_CLEARED)).toBe("1");
  });

  test("typed words take the device's place: saved alone, and the device's line goes", async () => {
    // The device is the source, by name.
    const { api, writes } = server({
      place: null,
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(
      () => view.host.querySelector("[data-device-place]") !== null,
      "the device's place, by name",
    );
    expect(view.host.textContent).toContain(GOES_BY.device);
    expect(placeField(view)?.value).toBe("");

    const field = placeField(view);
    if (!field) throw new Error("no place field");
    await view.type(field, "부산 해운대구");
    await press(view, "Save the location");
    await view.waitFor(() => writes.length === 1, "the save");
    // The words, and the coordinates taken away in the same request — as the Bot's own `remember`
    // does when somebody says where they are.
    expect(writes).toEqual([
      { method: "PUT", body: { place: "부산 해운대구", coordinates: null } },
    ]);
    await view.waitFor(
      () => view.host.querySelector("[data-device-place]") === null,
      "the device's line to go",
    );
    expect(view.host.textContent).toContain(GOES_BY.words);
    expect(view.host.textContent).not.toContain(GOES_BY.device);
  });

  test("the device's place is said to be around its name, once: a name that already says 부근 is drawn as it is", async () => {
    /*
     * THE NAME IS A FORECAST CELL'S, five kilometres across, and names the districts most of its
     * 동 are in — somebody near a border reads their neighbours' 구. So the line says 부근, as
     * the prompt's place line does. And a cell with no row of its own already comes named
     * "서귀포시 부근": the prompt once wrote "부근 부근" there (review of pull request 91).
     */
    const inACell = server({
      place: null,
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    const view = await mountApp({ path: "/settings/shop", api: inACell.api });
    await view.waitFor(
      () => view.host.querySelector("[data-device-place]") !== null,
      "the device's place, by name",
    );
    expect(view.host.querySelector("[data-device-place]")?.textContent).toBe(
      "This device's location: around 서울특별시 강남구·서초구",
    );
    await view.unmount();

    const byANeighbour = server({
      place: null,
      coordinates: { latitude: 33.2, longitude: 126.28 },
    });
    const again = await mountApp({
      path: "/settings/shop",
      api: byANeighbour.api,
    });
    await again.waitFor(
      () => again.host.querySelector("[data-device-place]") !== null,
      "the device's place, by its neighbour's name",
    );
    expect(again.host.querySelector("[data-device-place]")?.textContent).toBe(
      "This device's location: 제주특별자치도 서귀포시 부근",
    );
    // And in Korean the word is the first sentence's alone.
    expect(
      ko["This device's location: around {name}"]?.match(/부근/g),
    ).toHaveLength(1);
    expect(ko["This device's location: {name}"]).not.toContain("부근");
  });

  test("the words are the place wherever the account also holds coordinates: no device line beside them", async () => {
    // Both held — a device's answer that landed beside words said in a conversation. The real
    // server names nothing then; this one does, and the form still draws one source.
    const { api } = server(
      {
        place: "강원 춘천시",
        coordinates: { latitude: 37.5, longitude: 127.03 },
      },
      { nameAnyway: "서울특별시 강남구·서초구" },
    );
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(
      () => placeField(view)?.value === "강원 춘천시",
      "the place they said",
    );
    expect(view.host.textContent).toContain(GOES_BY.words);
    expect(view.host.querySelector("[data-device-place]")).toBeNull();
    expect(view.host.textContent).not.toMatch(NO_NUMBERS);
  });

  test("clearing a place that held this device's coordinates is final here: the next open does not read the device again", async () => {
    /*
     * A CLEARED PLACE CAME BACK ONCE (review of pull request 91). Somebody who said where they are
     * is not asked at open and the device is not marked; they then choose the device on a press,
     * and clear. Nothing had marked the device, so the next open — the browser still saying yes —
     * read it and saved it again, and 지우기 was a control that did nothing.
     */
    localStorage.removeItem(DEVICE_ASKED);
    const asked = browserAt(GANGNAM);
    const { api, writes } = server({ place: "서울 강남구", coordinates: null });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => placeField(view) !== null, "the place field");
    // A said place: the device is not asked by itself, and its once is not spent.
    expect(asked.reads).toBe(0);
    expect(writes).toEqual([]);
    expect(localStorage.getItem(DEVICE_ASKED)).toBeNull();

    await press(view, "Use this device's location");
    await view.waitFor(() => writes.length === 1, "the save");
    await press(view, "Clear the location");
    await view.waitFor(() => writes.length === 2, "the clear");
    expect(writes[1]?.method).toBe("DELETE");
    // Cleared, which is its own mark: "asked" is true of every device whose place follows it.
    expect(localStorage.getItem(DEVICE_ASKED)).toBe("1");
    expect(localStorage.getItem(DEVICE_CLEARED)).toBe("1");
    await view.unmount();

    // The next open: nothing held, and a browser that would say yes without showing anything.
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted" }) },
    });
    localStorage.removeItem(DEVICE_READ_AT);
    const again = await mountApp({ path: "/settings/shop", api });
    await again.waitFor(() => placeField(again) !== null, "the place field");
    await again.settle(60);
    expect(asked.reads).toBe(1);
    expect(writes).toHaveLength(2);
    expect(placeField(again)?.value).toBe("");
  });

  test("a device that answers by itself while this screen is open is what the screen names — and typed words then take its place", async () => {
    /*
     * The form copied the account's coordinates when it mounted. The device answers by itself now,
     * so the copy went stale in front of the person: the line named where the device HAD been, the
     * save button lit with nothing changed, and saving a typed place sent the older coordinates
     * back over the ones the device had just given. (Left as known in pull request 91, when the
     * device answered once and the form's copy was a blank.)
     */
    for (const key of [DEVICE_ASKED, DEVICE_READ_AT]) {
      localStorage.removeItem(key);
    }
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted" }) },
    });
    browserAt(GANGNAM);
    // The account holds where the device was the last time — a point this file's table has no
    // name for, so the line that appears is the new place's and nothing else's.
    const { api, writes } = server({
      place: null,
      coordinates: { latitude: 33.5, longitude: 126.53 },
    });
    const view = await mountApp({ path: "/settings/shop", api });
    await view.waitFor(() => writes.length === 1, "the device's own answer");
    expect(writes[0]?.body).toEqual({
      coordinates: { latitude: 37.5, longitude: 127.03 },
    });
    await view.waitFor(
      () =>
        view.host.querySelector("[data-device-place]")?.textContent ===
        "This device's location: around 서울특별시 강남구·서초구",
      "the place the device just gave, by name",
    );
    expect(view.host.textContent).not.toMatch(NO_NUMBERS);
    // The person changed nothing: there is nothing to save.
    expect(view.buttonNamed("Save the location")?.disabled).toBe(true);

    // They type where they are and save: the words, and no coordinates old or new beside them.
    const field = placeField(view);
    if (!field) throw new Error("no place field");
    await view.type(field, "부산 해운대구");
    await press(view, "Save the location");
    await view.waitFor(() => writes.length === 2, "the save");
    expect(writes[1]).toEqual({
      method: "PUT",
      body: { place: "부산 해운대구", coordinates: null },
    });
  });

  test("a cleared place is taken back by a press that succeeds — and not by one that is refused", async () => {
    /*
     * THE PRESS UN-CLEARED BEFORE ANYTHING WAS SAVED (review of pull request 94). The mark was
     * lifted when the device was read, so a press that came to nothing still set the device
     * following again. It is lifted when the press's save has succeeded, and only then.
     */
    localStorage.setItem(DEVICE_CLEARED, "1");
    const reads = shellAnswering(
      "prompt",
      { kind: "denied" },
      { kind: "place", ...HAEUNDAE, accuracy: 65 },
    );
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
    expect(localStorage.getItem(DEVICE_CLEARED)).toBe("1");

    await press(view, "Use this device's location");
    await view.waitFor(() => writes.length === 1, "the save");
    expect(reads).toHaveLength(2);
    await view.waitFor(
      () => localStorage.getItem(DEVICE_CLEARED) === null,
      "the mark to go",
    );
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
    expect(localStorage.getItem(DEVICE_CLEARED)).toBeNull();
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
