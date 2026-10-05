import { afterEach, describe, expect, test } from "bun:test";
import type { Coordinates } from "@shared/whereabouts";
import {
  type DeviceMark,
  type DevicePlaceDoors,
  devicePlaceMove,
  mayAskAboutTheDevice,
  offerDevicePlace,
} from "../src/lib/whereabouts/device-place";
import {
  canAskDeviceLocation,
  canUseDeviceLocation,
  type DevicePermission,
  devicePermission,
  readDeviceCoordinates,
} from "../src/lib/whereabouts/queries";

/**
 * THE DEVICE'S PLACE, ASKED FOR ONCE AND FOLLOWED AFTER (the owner, 2026-10-05: "기본값 실제 위치
 * 데이터").
 *
 * Until then the device was read only on a press in settings, so the "real location" default was
 * nothing for nearly everybody. It is asked at a signed-in open now — in a browser tab and, through
 * its shell, in the installed app — and these hold the whole of when it may be: never before the
 * person has agreed to anything, never while the person has said where they are, never a dialog
 * over coordinates already held, never twice on one device, never blind where the device cannot
 * say whether a prompt would appear, and never again by itself on a device whose place the person
 * cleared there.
 *
 * And what it does once it may: a device that already said yes is read at every open with nothing
 * shown, and the answer kept only when it has moved — coordinates saved at the first allow were a
 * snapshot, and somebody who allowed location in 춘천 and opened the app in 부산 was still in 춘천.
 *
 * The gate itself — that the first-run screen and the screen that asks again for the agreement do
 * not ask — is held where it lives, on the mounted route tree (`device-place-gate.test.tsx`), and
 * so are the two marks as a browser's storage really keeps them.
 */

const HERE: Coordinates = { latitude: 37.88, longitude: 127.73 };
const THERE: Coordinates = { latitude: 35.16, longitude: 129.16 };
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
    mark: "none" as DeviceMark,
    permission: "prompt" as DevicePermission,
  };
  const EVERY_ANSWER: DevicePermission[] = [
    "granted",
    "prompt",
    "denied",
    null,
  ];
  const EVERY_MARK: DeviceMark[] = ["none", "asked", "cleared", "old"];

  test("the decision table, with nothing held", () => {
    // Already allowed on this device: read, with nothing shown.
    expect(devicePlaceMove({ ...base, permission: "granted" })).toBe("read");
    // Not decided, and never asked on this device: the device's own prompt, once.
    expect(devicePlaceMove(base)).toBe("ask");

    // BEFORE ANYTHING IS AGREED TO: nothing, however willing the device is.
    expect(devicePlaceMove({ ...base, agreed: false })).toBe("nothing");
    expect(
      devicePlaceMove({ ...base, agreed: false, permission: "granted" }),
    ).toBe("nothing");
    // …and nothing is spent by it, even over coordinates: a later open decides.
    expect(
      devicePlaceMove({
        ...base,
        agreed: false,
        permission: "granted",
        held: { place: null, coordinates: HERE },
      }),
    ).toBe("nothing");

    // A surface with no way to ask at all.
    expect(
      devicePlaceMove({ ...base, permission: "granted", canAsk: false }),
    ).toBe("nothing");

    // THE PERSON HAS SAID WHERE THEY ARE: not asked, not read, and not spent — cleared later, it
    // is asked then.
    for (const permission of EVERY_ANSWER) {
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

    // Asked before, and not allowed since — dismissed or refused: never a second dialog.
    expect(devicePlaceMove({ ...base, mark: "asked" })).toBe("nothing");
    // The person said no in the device's settings.
    expect(devicePlaceMove({ ...base, permission: "denied" })).toBe("nothing");
    // No way to know whether a prompt would appear — no Permissions API, or a shell that cannot
    // read the device: none is risked.
    expect(devicePlaceMove({ ...base, permission: null })).toBe("nothing");

    // ASKED BEFORE, AND ALLOWED: read. The device said yes and its first answer never arrived — a
    // save that failed, a dialog answered after the wait ran out. Nothing is shown for it.
    expect(
      devicePlaceMove({ ...base, mark: "asked", permission: "granted" }),
    ).toBe("read");
  });

  test("the place follows a device that already said yes, and no other", () => {
    const held = { place: null, coordinates: THERE };
    // Allowed, over coordinates the account holds: read again, with nothing shown.
    for (const mark of ["none", "asked", "old"] as const) {
      expect(
        devicePlaceMove({ ...base, held, mark, permission: "granted" }),
      ).toBe("follow");
    }
    // NOT ALLOWED: the once is spent on this device — nobody is shown a dialog about a place the
    // account already has — and nothing is read.
    for (const permission of ["prompt", "denied", null] as const) {
      for (const mark of ["none", "asked", "old"] as const) {
        expect(devicePlaceMove({ ...base, held, mark, permission })).toBe(
          "spent",
        );
      }
    }
    // THE PERSON HAS SAID WHERE THEY ARE: their words are the place, and the device is not read
    // under them however willing it is. The once is spent as it always was over coordinates, so
    // clearing both later shows no dialog.
    for (const permission of EVERY_ANSWER) {
      expect(
        devicePlaceMove({
          ...base,
          permission,
          held: { place: "강원 춘천시", coordinates: THERE },
        }),
      ).toBe("spent");
    }
  });

  test("a place cleared on this device is never read by itself, whatever the device and the account say", () => {
    for (const permission of EVERY_ANSWER) {
      for (const held of [
        NOTHING_HELD,
        // Another device gave the account a place since: this one still does not follow.
        { place: null, coordinates: THERE },
        { place: "강원 춘천시", coordinates: null },
        { place: "강원 춘천시", coordinates: THERE },
      ]) {
        expect(
          devicePlaceMove({ ...base, held, permission, mark: "cleared" }),
        ).toBe("nothing");
      }
    }
  });

  test("a mark from before 'cleared' existed is read by what the account holds", () => {
    /*
     * One key used to be written when a device was asked and when its place was cleared alike, and
     * it is on people's devices. Coordinates held: it was not a 지우기 — that would have emptied
     * them — and the device follows. Nothing held: it may have been, so nothing is read, however
     * willing the device is. A place cleared before this change stays cleared.
     */
    for (const permission of EVERY_ANSWER) {
      expect(devicePlaceMove({ ...base, permission, mark: "old" })).toBe(
        "nothing",
      );
    }
    expect(
      devicePlaceMove({
        ...base,
        permission: "granted",
        mark: "old",
        held: { place: null, coordinates: THERE },
      }),
    ).toBe("follow");
  });

  test("nobody is shown anything except by the one ask, and that only on a device never asked", () => {
    // Every row of the table: "ask" comes out of exactly one.
    const asks: string[] = [];
    for (const mark of EVERY_MARK) {
      for (const permission of EVERY_ANSWER) {
        for (const held of [
          NOTHING_HELD,
          { place: null, coordinates: THERE },
          { place: "강원 춘천시", coordinates: null },
          { place: "강원 춘천시", coordinates: THERE },
        ]) {
          if (devicePlaceMove({ ...base, mark, permission, held }) === "ask") {
            asks.push(
              `${mark}/${permission}/${held.place}/${!!held.coordinates}`,
            );
          }
        }
      }
    }
    expect(asks).toEqual(["none/prompt/null/false"]);
  });
});

describe("the move, carried out", () => {
  function doors(
    over: Partial<DevicePlaceDoors> & {
      place?: string | null;
      coordinates?: Coordinates | null;
      marked?: DeviceMark;
      device?: Coordinates;
      allowed?: DevicePermission;
    } = {},
  ) {
    const did: string[] = [];
    const saved: Coordinates[] = [];
    // The account, the device's mark and the device's word on being asked, as they change.
    const world = {
      place: over.place ?? null,
      coordinates: over.coordinates ?? null,
      mark: over.marked ?? ("none" as DeviceMark),
      permission:
        over.allowed === undefined
          ? ("prompt" as DevicePermission)
          : over.allowed,
      device: over.device ?? HERE,
    };
    const made: DevicePlaceDoors = {
      agreed: () => true,
      canAsk: () => true,
      held: () => ({ place: world.place, coordinates: world.coordinates }),
      mark: () => world.mark,
      markAsked: () => {
        did.push("marked");
        if (world.mark !== "cleared") world.mark = "asked";
        return true;
      },
      permission: async () => {
        did.push("permission");
        return world.permission;
      },
      read: async (mayPrompt) => {
        did.push(mayPrompt ? "read, may prompt" : "read, silently");
        // The person answers the device's own question with a yes.
        if (mayPrompt && world.permission === "prompt") {
          world.permission = "granted";
        }
        return world.device;
      },
      save: async (coordinates) => {
        did.push("saved");
        saved.push(coordinates);
        world.coordinates = coordinates;
      },
      ...over,
    };
    return { made, did, saved, world };
  }

  test("a device that has not decided is prompted once: marked before it is asked, and the coordinates saved alone", async () => {
    const first = doors();
    expect(await offerDevicePlace(first.made)).toBe("ask");
    // Marked BEFORE the read: a prompt closed with the tab has still been the once. And this read
    // is the only one told it may show the person anything.
    expect(first.did).toEqual([
      "permission",
      "marked",
      "read, may prompt",
      "saved",
    ]);
    // The coordinates and nothing else: the door is handed no word about the place.
    expect(first.saved).toEqual([HERE]);
    // The next open on this device: allowed now, so it is read with nothing shown — and it has
    // not moved, so nothing is written.
    first.did.length = 0;
    expect(await offerDevicePlace(first.made)).toBe("same");
    expect(first.did).toEqual(["permission", "marked", "read, silently"]);
    expect(first.saved).toHaveLength(1);
  });

  test("a device that already said yes is read with nothing shown", async () => {
    const allowed = doors({ allowed: "granted" });
    expect(await offerDevicePlace(allowed.made)).toBe("read");
    expect(allowed.did).toEqual([
      "permission",
      "marked",
      "read, silently",
      "saved",
    ]);
    expect(allowed.saved).toEqual([HERE]);
  });

  test("before the person has agreed, the device is not asked even what it would say, and nothing is marked", async () => {
    /*
     * The first cut ran for anybody signed in: the location dialog on the first-run screen, and a
     * browser that had already said yes read and saved before the agreement was recorded (review of
     * pull request 91).
     */
    for (const allowed of ["granted", "prompt"] as const) {
      for (const coordinates of [null, THERE]) {
        const early = doors({ agreed: () => false, allowed, coordinates });
        expect(await offerDevicePlace(early.made)).toBe("nothing");
        expect(early.did).toEqual([]);
        expect(early.saved).toEqual([]);
      }
    }
  });

  test("a person who has said where they are is not asked, and the once is kept for the day the words are cleared", async () => {
    const said = doors({ place: "강원 춘천시" });
    expect(await offerDevicePlace(said.made)).toBe("nothing");
    // Not the device, not the mark.
    expect(said.did).toEqual([]);
    // The words are cleared: with nothing known the device is the default again, and is asked.
    said.world.place = null;
    expect(await offerDevicePlace(said.made)).toBe("ask");
    expect(said.saved).toEqual([HERE]);
  });

  test("allowed, held, and the device has moved: the new place is saved, with nothing shown", async () => {
    /*
     * MEASURED BEFORE THIS: a browser that had already said yes, opened in 부산 over an account
     * holding 춘천, was marked and never read. The coordinates of the first allow were kept until
     * somebody found a button in settings.
     */
    const moved = doors({ allowed: "granted", coordinates: THERE });
    expect(await offerDevicePlace(moved.made)).toBe("follow");
    expect(moved.did).toEqual([
      "permission",
      "marked",
      "read, silently",
      "saved",
    ]);
    expect(moved.saved).toEqual([HERE]);
    // A device opened for the first time over a place another device gave follows too, and is
    // marked: it has had its once.
    expect(moved.world.mark).toBe("asked");
  });

  test("allowed, held, and the device has not moved: nothing is written", async () => {
    const still = doors({ allowed: "granted", coordinates: HERE });
    expect(await offerDevicePlace(still.made)).toBe("same");
    expect(still.did).toEqual(["permission", "marked", "read, silently"]);
    expect(still.saved).toEqual([]);
    // One hundredth of a degree is a move; less than that cannot reach here — the door rounds.
    const nudged = doors({
      allowed: "granted",
      coordinates: HERE,
      device: { latitude: 37.88, longitude: 127.74 },
    });
    expect(await offerDevicePlace(nudged.made)).toBe("follow");
    expect(nudged.saved).toEqual([{ latitude: 37.88, longitude: 127.74 }]);
  });

  test("a place cleared on this device: the device is not asked even what it would say", async () => {
    for (const coordinates of [null, THERE]) {
      const cleared = doors({
        allowed: "granted",
        marked: "cleared",
        coordinates,
      });
      expect(await offerDevicePlace(cleared.made)).toBe("nothing");
      expect(cleared.did).toEqual([]);
      expect(cleared.saved).toEqual([]);
    }
  });

  test("a person who has said where they are is not followed: their words are the place", async () => {
    const said = doors({
      allowed: "granted",
      place: "강원 춘천시",
      coordinates: THERE,
    });
    expect(await offerDevicePlace(said.made)).toBe("spent");
    // Spent, as it always was over coordinates — and the device is neither asked nor read.
    expect(said.did).toEqual(["marked"]);
    expect(said.saved).toEqual([]);
  });

  test("a device that has not said yes is shown nothing over a place the account holds, and the once is spent", async () => {
    /*
     * This returned before marking. Somebody whose coordinates came from the settings button had
     * never been marked; they cleared their place, and the next open asked the device again
     * (review of pull request 91).
     */
    for (const allowed of ["prompt", "denied", null] as const) {
      const held = doors({ allowed, coordinates: THERE });
      expect(await offerDevicePlace(held.made)).toBe("spent");
      expect(held.did).toEqual(["permission", "marked"]);
      // The place is cleared on another device, and this one is opened again: no dialog.
      held.world.coordinates = null;
      held.did.length = 0;
      expect(await offerDevicePlace(held.made)).toBe("nothing");
      expect(held.did).toEqual(["permission"]);
      expect(held.saved).toEqual([]);
    }
  });

  test("refused, unknowable, or a surface with no way to ask: the device is not read and nothing is marked", async () => {
    for (const over of [
      { allowed: "denied" as const },
      // No Permissions API in a tab; in the installed app, a shell that cannot read the device.
      { allowed: null },
      { canAsk: () => false },
    ]) {
      const quiet = doors(over);
      expect(await offerDevicePlace(quiet.made)).toBe("nothing");
      expect(quiet.did).not.toContain("marked");
      expect(quiet.did.join()).not.toContain("read");
      expect(quiet.saved).toEqual([]);
    }
  });

  test("storage that cannot keep the once means the device is not read at all", async () => {
    for (const over of [
      {},
      { allowed: "granted" as const, coordinates: THERE },
    ]) {
      const forgetful = doors({ ...over, markAsked: () => false });
      expect(await offerDevicePlace(forgetful.made)).toBe("nothing");
      expect(forgetful.did.join()).not.toContain("read");
      expect(forgetful.saved).toEqual([]);
    }
  });

  test("a dismissed prompt is never shown again; a device that said yes and was not heard is read at the next open", async () => {
    const dismissed = doors({
      read: async () => {
        throw new Error("denied at the prompt");
      },
    });
    expect(await offerDevicePlace(dismissed.made)).toBe("unread");
    expect(dismissed.saved).toEqual([]);
    // Still not decided, as far as the device says: asked before, so nothing.
    expect(await offerDevicePlace(dismissed.made)).toBe("nothing");

    // Allowed, and the save did not land.
    let isOffline = true;
    const offline = doors();
    const save = offline.made.save;
    offline.made.save = async (coordinates) => {
      if (isOffline) throw new Error("offline");
      await save(coordinates);
    };
    expect(await offerDevicePlace(offline.made)).toBe("unsaved");
    expect(offline.saved).toEqual([]);
    // The next open, back online: the device said yes, so it is read — with nothing shown.
    isOffline = false;
    offline.did.length = 0;
    expect(await offerDevicePlace(offline.made)).toBe("read");
    expect(offline.did).toEqual([
      "permission",
      "marked",
      "read, silently",
      "saved",
    ]);
    expect(offline.saved).toEqual([HERE]);
  });

  test("coordinates given another way while the prompt was up stand", async () => {
    // The settings button was pressed while the prompt was up: what it saved stands.
    const raced = doors();
    raced.made.read = async () => {
      raced.world.coordinates = THERE;
      return HERE;
    };
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
    const meanwhile = doors();
    meanwhile.made.read = async () => {
      meanwhile.world.place = "강원 춘천시";
      return HERE;
    };
    expect(await offerDevicePlace(meanwhile.made)).toBe("ask");
    expect(meanwhile.saved).toEqual([HERE]);
  });

  test("지우기, or a place said, while a following device was answering: theirs stands", async () => {
    const cleared = doors({ allowed: "granted", coordinates: THERE });
    cleared.made.read = async () => {
      cleared.world.mark = "cleared";
      cleared.world.coordinates = null;
      return HERE;
    };
    expect(await offerDevicePlace(cleared.made)).toBe("nothing");
    expect(cleared.saved).toEqual([]);

    const said = doors({ allowed: "granted", coordinates: THERE });
    said.made.read = async () => {
      // `remember` replaces the place whole: the words in, the coordinates out.
      said.world.place = "부산 해운대구";
      said.world.coordinates = null;
      return HERE;
    };
    expect(await offerDevicePlace(said.made)).toBe("nothing");
    expect(said.saved).toEqual([]);
  });
});

/**
 * THE INSTALLED APP ASKS ITS SHELL THE SAME TWO QUESTIONS.
 *
 * Its webview answers no geolocation request, so the surface this product leads with was the one
 * where a person's place fell straight to Seoul. The shell reads the device now
 * (`desktop/src-tauri/src/location.rs`), and the table above is fed by it through the same doors:
 * what it says about being asked becomes the table's own four answers, and where it says the
 * device is goes through the same rounding. So these are the shell's rows of the table — and the
 * shells that cannot read the device, which are most of the ones installed for a while yet.
 */
describe("in the installed app, the device is asked through the shell", () => {
  type Global = typeof globalThis & { __TAURI__?: unknown };
  const calls: Array<[string, unknown]> = [];

  function shell(answers: { permission?: unknown; place?: unknown }) {
    calls.length = 0;
    (globalThis as Global).__TAURI__ = {
      core: {
        invoke: async (command: string, args: unknown) => {
          calls.push([command, args]);
          if (command === "device_place_permission") return answers.permission;
          if (command === "device_place") return answers.place;
          throw new Error(`${command} is not a command of this shell`);
        },
      },
    };
  }

  afterEach(() => {
    (globalThis as Global).__TAURI__ = undefined;
  });

  test("what the shell says about being asked is one of the table's four answers", async () => {
    for (const [said, read] of [
      ["granted", "granted"],
      ["prompt", "prompt"],
      ["denied", "denied"],
      // A machine whose person may not decide — a profile, a parental control — has said no.
      ["restricted", "denied"],
      // Windows, today: the shell is there and does not read the device.
      ["unsupported", null],
      // Anything else it might say is not an answer.
      ["authorized", null],
      [{ state: "granted" }, null],
      [undefined, null],
    ] as const) {
      shell({ permission: said });
      expect(await devicePermission()).toBe(read);
      // Asked of the shell, with nothing that could show the person anything.
      expect(calls).toEqual([["device_place_permission", undefined]]);
    }
    // Each of them is a row the table already has: read, asked once, or left alone.
    const facts = {
      agreed: true,
      canAsk: true,
      held: NOTHING_HELD,
      mark: "none" as const,
    };
    expect(devicePlaceMove({ ...facts, permission: "granted" })).toBe("read");
    expect(devicePlaceMove({ ...facts, permission: "prompt" })).toBe("ask");
    expect(devicePlaceMove({ ...facts, permission: "denied" })).toBe("nothing");
    expect(devicePlaceMove({ ...facts, permission: null })).toBe("nothing");
  });

  test("a shell from before it could read the device is one that cannot be asked — and no control is drawn over it", async () => {
    // An installed app is not replaced when the deployment is: this is most shells, for a while.
    (globalThis as Global).__TAURI__ = {
      core: {
        invoke: async () => {
          throw new Error("device_place_permission not allowed");
        },
      },
    };
    // Worth asking — it is a shell — and its answer is that it cannot say.
    expect(canAskDeviceLocation()).toBe(true);
    expect(await devicePermission()).toBeNull();
    expect(await canUseDeviceLocation()).toBe(false);
    // A shell with no bridge at all.
    (globalThis as Global).__TAURI__ = {};
    expect(await devicePermission()).toBeNull();
    expect(await canUseDeviceLocation()).toBe(false);
    // Windows, today.
    shell({ permission: "unsupported" });
    expect(await canUseDeviceLocation()).toBe(false);
    // And a shell that can read it draws the control whatever the person has said so far — a
    // device that said no answers a press in words, as a browser tab's does.
    for (const permission of ["granted", "prompt", "denied", "restricted"]) {
      shell({ permission });
      expect(await canUseDeviceLocation()).toBe(true);
    }
  });

  test("where the shell says the device is, is rounded again here and told whether it may show anything", async () => {
    // The shell rounds before it answers. This side rounds too: nothing here holds a finer value
    // because the other side promised.
    shell({
      place: { kind: "place", latitude: 37.498_095, longitude: 127.027_61 },
    });
    expect(await readDeviceCoordinates(false)).toEqual({
      latitude: 37.5,
      longitude: 127.03,
    });
    expect(calls).toEqual([["device_place", { prompt: false }]]);
    // A press, and the one ask, may put the system's question up; that is the default.
    shell({ place: { kind: "place", latitude: 35.16, longitude: 129.16 } });
    expect(await readDeviceCoordinates()).toEqual(THERE);
    expect(calls).toEqual([["device_place", { prompt: true }]]);
  });

  test("every reason the shell has no place is said in this surface's words, and never as a place", async () => {
    const refusals: Array<[unknown, string]> = [
      [{ kind: "denied" }, "Location was not allowed on this device."],
      [{ kind: "restricted" }, "Location was not allowed on this device."],
      // Not decided, and the read was told to show nothing.
      [
        { kind: "undetermined_no_prompt" },
        "This device did not say where it is.",
      ],
      [{ kind: "unavailable" }, "This device did not say where it is."],
      [{ kind: "timeout" }, "This device did not say where it is."],
      [{ kind: "unsupported" }, "This device did not say where it is."],
      // Not a place on this planet, not two numbers, not a kind this page knows, nothing at all.
      [
        { kind: "place", latitude: 91, longitude: 127.03 },
        "This device did not say where it is.",
      ],
      [
        { kind: "place", latitude: "37.5", longitude: 127.03 },
        "This device did not say where it is.",
      ],
      [{ kind: "somewhere" }, "This device did not say where it is."],
      [
        { latitude: 37.5, longitude: 127.03 },
        "This device did not say where it is.",
      ],
      [null, "This device did not say where it is."],
    ];
    for (const [place, words] of refusals) {
      shell({ place });
      await expect(readDeviceCoordinates(false)).rejects.toThrow(words);
    }
  });
});
