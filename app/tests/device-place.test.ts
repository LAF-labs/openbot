import { describe, expect, test } from "bun:test";
import type { Coordinates } from "@shared/whereabouts";
import {
  type DevicePlaceDoors,
  devicePlaceMove,
  type GeolocationPermission,
  offerDevicePlace,
} from "../src/lib/whereabouts/device-place";

/**
 * THE DEVICE'S PLACE, ASKED FOR ONCE (the owner, 2026-10-05: "기본값 실제 위치 데이터").
 *
 * Until then the device was read only on a press in settings, so the "real location" default was
 * nothing for nearly everybody. A browser tab now asks at the first signed-in open — and these hold
 * the whole of when it may: never in the shell, never over coordinates already held, never twice on
 * one device, never blind where the browser cannot say whether a prompt would appear.
 */

const HERE: Coordinates = { latitude: 37.88, longitude: 127.73 };

describe("what to do about the device's place at a signed-in open", () => {
  const base = {
    canAsk: true,
    held: null,
    alreadyAsked: false,
    permission: "prompt" as GeolocationPermission,
  };

  test("the decision table", () => {
    // Already allowed in this browser: read, with nothing shown.
    expect(devicePlaceMove({ ...base, permission: "granted" })).toBe("read");
    // Not decided, and never asked on this device: the browser's own prompt, once.
    expect(devicePlaceMove(base)).toBe("ask");
    // Asked before — allowed, dismissed or refused: never again.
    expect(devicePlaceMove({ ...base, alreadyAsked: true })).toBe("nothing");
    expect(
      devicePlaceMove({ ...base, permission: "granted", alreadyAsked: true }),
    ).toBe("nothing");
    // The person said no in the browser's settings.
    expect(devicePlaceMove({ ...base, permission: "denied" })).toBe("nothing");
    // No Permissions API: whether a prompt would appear is unknowable, so none is risked.
    expect(devicePlaceMove({ ...base, permission: null })).toBe("nothing");
    // Coordinates are held already.
    expect(
      devicePlaceMove({ ...base, permission: "granted", held: HERE }),
    ).toBe("nothing");
    // The desktop shell, whose webview answers no geolocation request.
    expect(
      devicePlaceMove({ ...base, permission: "granted", canAsk: false }),
    ).toBe("nothing");
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
    const saved: { place: string | null; coordinates: Coordinates }[] = [];
    let asked = false;
    const made: DevicePlaceDoors = {
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
      save: async (answer) => {
        did.push("saved");
        saved.push(answer);
      },
      ...over,
    };
    return { made, did, saved };
  }

  test("a browser that has not decided is prompted once: marked before it is asked, and saved with the words the account holds", async () => {
    const first = doors({ place: "강원 춘천시" });
    expect(await offerDevicePlace(first.made)).toBe("ask");
    // Marked BEFORE the read: a prompt closed with the tab has still been the once.
    expect(first.did).toEqual(["permission", "marked", "read", "saved"]);
    // The door replaces the place whole, so the words go back with the coordinates.
    expect(first.saved).toEqual([{ place: "강원 춘천시", coordinates: HERE }]);
    // The next open on this device does nothing — the browser is not even asked what it would say.
    first.did.length = 0;
    expect(await offerDevicePlace(first.made)).toBe("nothing");
    expect(first.did).toEqual([]);
  });

  test("a browser that already said yes is read with nothing shown — and that is the once too", async () => {
    const allowed = doors({ permission: async () => "granted" });
    expect(await offerDevicePlace(allowed.made)).toBe("read");
    expect(allowed.saved).toEqual([{ place: null, coordinates: HERE }]);
    // A place cleared on 내 정보 afterwards stays cleared: this does not put it back.
    expect(await offerDevicePlace(allowed.made)).toBe("nothing");
    expect(allowed.saved).toHaveLength(1);
  });

  test("refused, unknowable, already held, or in the shell: the device is not asked and nothing is marked", async () => {
    for (const over of [
      { permission: async () => "denied" as const },
      { permission: async () => null },
      { coordinates: HERE },
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
    expect(await offerDevicePlace(raced.made)).toBe("nothing");
    expect(raced.saved).toEqual([]);
  });
});
