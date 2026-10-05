import { describe, expect, test } from "bun:test";
import type { Coordinates } from "@shared/whereabouts";
import {
  type DevicePlaceDoors,
  devicePlaceMove,
  type GeolocationPermission,
  mayAskAboutTheDevice,
  offerDevicePlace,
} from "../src/lib/whereabouts/device-place";

/**
 * THE DEVICE'S PLACE, ASKED FOR ONCE (the owner, 2026-10-05: "기본값 실제 위치 데이터").
 *
 * Until then the device was read only on a press in settings, so the "real location" default was
 * nothing for nearly everybody. A browser tab now asks at a signed-in open — and these hold the
 * whole of when it may: never before the person has agreed to anything, never in the shell, never
 * while the person has said where they are, never over coordinates already held, never twice on one
 * device, never blind where the browser cannot say whether a prompt would appear.
 *
 * The gate itself — that the first-run screen and the screen that asks again for the agreement do
 * not ask — is held where it lives, on the mounted route tree (`device-place-gate.test.tsx`).
 */

const HERE: Coordinates = { latitude: 37.88, longitude: 127.73 };
const NOTHING_HELD = { place: null, coordinates: null };

describe("who the device may be asked about", () => {
  test("somebody past the first run who owes no agreement — and never on the two screens that ask for those", () => {
    const through = { onboarded: true, consentRequired: false };
    expect(mayAskAboutTheDevice(through, "/")).toBe(true);
    expect(mayAskAboutTheDevice(through, "/settings/shop")).toBe(true);
    // The first run: no Bot yet, nothing agreed to.
    expect(
      mayAskAboutTheDevice(
        { onboarded: false, consentRequired: true },
        "/welcome",
      ),
    ).toBe(false);
    // A deployment that records no agreement still has a first run.
    expect(
      mayAskAboutTheDevice(
        { onboarded: false, consentRequired: false },
        "/welcome",
      ),
    ).toBe(false);
    // The text changed since they agreed.
    expect(
      mayAskAboutTheDevice(
        { onboarded: true, consentRequired: true },
        "/consent",
      ),
    ).toBe(false);
    // The stamp has landed and the screen has not left yet: still not here.
    expect(mayAskAboutTheDevice(through, "/welcome")).toBe(false);
    expect(mayAskAboutTheDevice(through, "/consent")).toBe(false);
    // Nobody read yet.
    expect(mayAskAboutTheDevice(undefined, "/")).toBe(false);
    expect(mayAskAboutTheDevice(null, "/")).toBe(false);
  });
});

describe("what to do about the device's place at a signed-in open", () => {
  const base = {
    agreed: true,
    canAsk: true,
    held: NOTHING_HELD,
    alreadyAsked: false,
    permission: "prompt" as GeolocationPermission,
  };

  test("the decision table", () => {
    // Already allowed in this browser: read, with nothing shown.
    expect(devicePlaceMove({ ...base, permission: "granted" })).toBe("read");
    // Not decided, and never asked on this device: the browser's own prompt, once.
    expect(devicePlaceMove(base)).toBe("ask");

    // BEFORE ANYTHING IS AGREED TO: nothing, however willing the browser is.
    expect(devicePlaceMove({ ...base, agreed: false })).toBe("nothing");
    expect(
      devicePlaceMove({ ...base, agreed: false, permission: "granted" }),
    ).toBe("nothing");
    // …and nothing is spent by it, even over coordinates: a later open decides.
    expect(
      devicePlaceMove({
        ...base,
        agreed: false,
        held: { place: null, coordinates: HERE },
      }),
    ).toBe("nothing");

    // The desktop shell, whose webview answers no geolocation request.
    expect(
      devicePlaceMove({ ...base, permission: "granted", canAsk: false }),
    ).toBe("nothing");

    // Coordinates are held already — from this device or another: the once is over here.
    expect(
      devicePlaceMove({
        ...base,
        permission: "granted",
        held: { place: null, coordinates: HERE },
      }),
    ).toBe("spent");
    // With words beside them too: clearing both later must not bring the coordinates back.
    expect(
      devicePlaceMove({
        ...base,
        held: { place: "강원 춘천시", coordinates: HERE },
      }),
    ).toBe("spent");

    // THE PERSON HAS SAID WHERE THEY ARE: not asked, and not spent — cleared later, it is asked then.
    for (const permission of ["granted", "prompt"] as const) {
      expect(
        devicePlaceMove({
          ...base,
          permission,
          held: { place: "강원 춘천시", coordinates: null },
        }),
      ).toBe("nothing");
    }
    // Blank words are no words.
    expect(
      devicePlaceMove({ ...base, held: { place: "  ", coordinates: null } }),
    ).toBe("ask");

    // Asked before — allowed, dismissed or refused: never again.
    expect(devicePlaceMove({ ...base, alreadyAsked: true })).toBe("nothing");
    expect(
      devicePlaceMove({ ...base, permission: "granted", alreadyAsked: true }),
    ).toBe("nothing");
    // The person said no in the browser's settings.
    expect(devicePlaceMove({ ...base, permission: "denied" })).toBe("nothing");
    // No Permissions API: whether a prompt would appear is unknowable, so none is risked.
    expect(devicePlaceMove({ ...base, permission: null })).toBe("nothing");
  });
});

describe("the once, carried out", () => {
  function doors(
    over: Partial<DevicePlaceDoors> & {
      place?: string | null;
      coordinates?: Coordinates | null;
    } = {},
  ) {
    const did: string[] = [];
    const saved: Coordinates[] = [];
    let asked = false;
    const made: DevicePlaceDoors = {
      agreed: () => true,
      canAsk: () => true,
      held: () => ({
        place: over.place ?? null,
        coordinates: over.coordinates ?? null,
      }),
      wasAsked: () => asked,
      markAsked: () => {
        did.push("marked");
        asked = true;
        return true;
      },
      permission: async () => {
        did.push("permission");
        return "prompt";
      },
      read: async () => {
        did.push("read");
        return HERE;
      },
      save: async (coordinates) => {
        did.push("saved");
        saved.push(coordinates);
      },
      ...over,
    };
    return { made, did, saved };
  }

  test("a browser that has not decided is prompted once: marked before it is asked, and the coordinates saved alone", async () => {
    const first = doors();
    expect(await offerDevicePlace(first.made)).toBe("ask");
    // Marked BEFORE the read: a prompt closed with the tab has still been the once.
    expect(first.did).toEqual(["permission", "marked", "read", "saved"]);
    // The coordinates and nothing else: the door is handed no word about the place.
    expect(first.saved).toEqual([HERE]);
    // The next open on this device does nothing — the browser is not even asked what it would say.
    first.did.length = 0;
    expect(await offerDevicePlace(first.made)).toBe("nothing");
    expect(first.did).toEqual([]);
  });

  test("a browser that already said yes is read with nothing shown — and that is the once too", async () => {
    const allowed = doors({ permission: async () => "granted" });
    expect(await offerDevicePlace(allowed.made)).toBe("read");
    expect(allowed.saved).toEqual([HERE]);
    expect(await offerDevicePlace(allowed.made)).toBe("nothing");
    expect(allowed.saved).toHaveLength(1);
  });

  test("before the person has agreed, the browser is not asked even what it would say, and nothing is marked", async () => {
    /*
     * The first cut ran for anybody signed in: the location dialog on the first-run screen, and a
     * browser that had already said yes read and saved before the agreement was recorded (review of
     * pull request 91).
     */
    for (const permission of ["granted", "prompt"] as const) {
      const early = doors({
        agreed: () => false,
        permission: async () => {
          early.did.push("permission");
          return permission;
        },
      });
      expect(await offerDevicePlace(early.made)).toBe("nothing");
      expect(early.did).toEqual([]);
      expect(early.saved).toEqual([]);
    }
  });

  test("a person who has said where they are is not asked, and the once is kept for the day the words are cleared", async () => {
    let place: string | null = "강원 춘천시";
    const said = doors({ held: () => ({ place, coordinates: null }) });
    expect(await offerDevicePlace(said.made)).toBe("nothing");
    // Not the browser, not the mark, not the device.
    expect(said.did).toEqual([]);
    // The words are cleared: with nothing known the device is the default again, and is asked.
    place = null;
    expect(await offerDevicePlace(said.made)).toBe("ask");
    expect(said.saved).toEqual([HERE]);
  });

  test("coordinates the account already holds spend the once on this device: cleared afterwards, they do not come back", async () => {
    /*
     * This returned before marking. Somebody whose coordinates came from the settings button had
     * never been marked; they cleared their place, and the next open — the browser still saying
     * yes — read the device and saved it again (review of pull request 91).
     */
    let coordinates: Coordinates | null = HERE;
    const held = doors({
      held: () => ({ place: null, coordinates }),
      permission: async () => "granted",
    });
    expect(await offerDevicePlace(held.made)).toBe("spent");
    expect(held.did).toEqual(["marked"]);
    // 지우기, and the next open.
    coordinates = null;
    held.did.length = 0;
    expect(await offerDevicePlace(held.made)).toBe("nothing");
    expect(held.did).toEqual([]);
    expect(held.saved).toEqual([]);
  });

  test("refused, unknowable, or in the shell: the device is not asked and nothing is marked", async () => {
    for (const over of [
      { permission: async () => "denied" as const },
      { permission: async () => null },
      { canAsk: () => false },
    ]) {
      const quiet = doors(over);
      expect(await offerDevicePlace(quiet.made)).toBe("nothing");
      expect(quiet.did).not.toContain("marked");
      expect(quiet.did).not.toContain("read");
      expect(quiet.saved).toEqual([]);
    }
  });

  test("storage that cannot keep the once means the device is not asked at all", async () => {
    const forgetful = doors({ markAsked: () => false });
    expect(await offerDevicePlace(forgetful.made)).toBe("nothing");
    expect(forgetful.did).not.toContain("read");
  });

  test("a dismissed prompt, a failed save, or coordinates that arrived meanwhile: quiet, and never asked again", async () => {
    const dismissed = doors({
      read: async () => {
        throw new Error("denied at the prompt");
      },
    });
    expect(await offerDevicePlace(dismissed.made)).toBe("unread");
    expect(dismissed.saved).toEqual([]);
    expect(await offerDevicePlace(dismissed.made)).toBe("nothing");

    const offline = doors({
      save: async () => {
        throw new Error("offline");
      },
    });
    expect(await offerDevicePlace(offline.made)).toBe("unsaved");

    // The settings button was pressed while the prompt was up: what it saved stands.
    let held: Coordinates | null = null;
    const raced = doors({
      held: () => ({ place: null, coordinates: held }),
      read: async () => {
        held = { latitude: 35.16, longitude: 129.16 };
        return HERE;
      },
    });
    expect(await offerDevicePlace(raced.made)).toBe("spent");
    expect(raced.saved).toEqual([]);
  });

  test("words said while the prompt was up are not this door's to send: the coordinates go alone", async () => {
    /*
     * The answer was saved with the words this tab held — `{ place: null, coordinates }` for a tab
     * that had not heard the person tell their Bot "나 춘천 살아" a minute earlier — and the door
     * replaced the place whole (review of pull request 91). The door takes coordinates only now,
     * and the server leaves the words as it holds them (`whereabouts-routes.test.ts`).
     */
    let place: string | null = null;
    const meanwhile = doors({
      held: () => ({ place, coordinates: null }),
      read: async () => {
        place = "강원 춘천시";
        return HERE;
      },
    });
    expect(await offerDevicePlace(meanwhile.made)).toBe("ask");
    expect(meanwhile.saved).toEqual([HERE]);
  });
});
