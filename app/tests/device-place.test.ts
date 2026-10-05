import { afterEach, describe, expect, test } from "bun:test";
import type { Coordinates } from "@shared/whereabouts";
import {
  AUTOMATIC_ACCURACY_METRES,
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
  type DeviceReading,
  devicePermission,
  readDevice,
  readDeviceCoordinates,
} from "../src/lib/whereabouts/queries";

/**
 * THE DEVICE'S PLACE, ASKED FOR ONCE AND FOLLOWED AFTER (the owner, 2026-10-05: "기본값 실제 위치
 * 데이터").
 *
 * Until then the device was read only on a press in settings, so the "real location" default was
 * nothing for nearly everybody. It is asked now — in a browser tab and, through its shell, in the
 * installed app — and these hold the whole of when it may be: never before the person has agreed
 * to anything, never while the person has said where they are, never a dialog over coordinates
 * already held, never again once the device's once is spent — in a tab when the question is put,
 * in the installed app when it is answered — never blind where the device cannot say whether a
 * prompt would appear, and never again by itself on a device whose place the person cleared there.
 *
 * And what it does once it may: a device that already said yes is read again with nothing shown,
 * at most once an hour, and the answer kept only when it is good enough and has really moved —
 * coordinates saved at the first allow were a snapshot, and somebody who allowed location in 춘천
 * and opened the app in 부산 was still in 춘천.
 *
 * The gate itself — that the first-run screen and the screen that asks again for the agreement do
 * not ask — is held where it lives, on the mounted route tree (`device-place-gate.test.tsx`), and
 * so are the marks as a browser's storage really keeps them, and the page being looked at again.
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

describe("what to do about the device's place when the page is looked at", () => {
  const base = {
    agreed: true,
    canAsk: true,
    held: NOTHING_HELD,
    mark: "none" as DeviceMark,
    isRecent: false,
    permission: "prompt" as DevicePermission,
  };
  const EVERY_ANSWER: DevicePermission[] = [
    "granted",
    "prompt",
    "denied",
    null,
  ];
  const EVERY_MARK: DeviceMark[] = ["none", "asked", "cleared"];
  const EVERYTHING_HELD = [
    NOTHING_HELD,
    { place: null, coordinates: THERE },
    { place: "강원 춘천시", coordinates: null },
    { place: "강원 춘천시", coordinates: THERE },
  ];

  test("the decision table, with nothing held", () => {
    // Already allowed on this device: read, with nothing shown.
    expect(devicePlaceMove({ ...base, permission: "granted" })).toBe("read");
    // Not decided, and its person has not decided either: the device's own prompt.
    expect(devicePlaceMove(base)).toBe("ask");

    // BEFORE ANYTHING IS AGREED TO: nothing, however willing the device is.
    expect(devicePlaceMove({ ...base, agreed: false })).toBe("nothing");
    expect(
      devicePlaceMove({ ...base, agreed: false, permission: "granted" }),
    ).toBe("nothing");
    // …and nothing is spent by it, even over coordinates: a later look decides.
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

    // Its person decided before, and it is not allowed — refused, or the prompt closed: never a
    // second dialog.
    expect(devicePlaceMove({ ...base, mark: "asked" })).toBe("nothing");
    // The person said no in the device's settings.
    expect(devicePlaceMove({ ...base, permission: "denied" })).toBe("nothing");
    // No way to know whether a prompt would appear — no Permissions API, or a shell that cannot
    // read the device: none is risked.
    expect(devicePlaceMove({ ...base, permission: null })).toBe("nothing");

    // DECIDED BEFORE, AND ALLOWED: read. The device said yes and its answer never arrived — a
    // save that failed, a fix too vague to keep. Nothing is shown for it.
    expect(
      devicePlaceMove({ ...base, mark: "asked", permission: "granted" }),
    ).toBe("read");
  });

  test("the place follows a device that already said yes, and no other", () => {
    const held = { place: null, coordinates: THERE };
    // Allowed, over coordinates the account holds: read again, with nothing shown.
    for (const mark of ["none", "asked"] as const) {
      expect(
        devicePlaceMove({ ...base, held, mark, permission: "granted" }),
      ).toBe("follow");
    }
    // NOT ALLOWED: the once is spent on this device — nobody is shown a dialog about a place the
    // account already has — and nothing is read.
    for (const permission of ["prompt", "denied", null] as const) {
      for (const mark of ["none", "asked"] as const) {
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
      // Nothing held; or another device gave the account a place since: this one still does not
      // follow.
      for (const held of EVERYTHING_HELD) {
        expect(
          devicePlaceMove({ ...base, held, permission, mark: "cleared" }),
        ).toBe("nothing");
      }
    }
  });

  test("a device read by itself within the hour is left alone, whatever it and the account say", () => {
    /*
     * The page is looked at many times an hour — a window uncovered, a tab switched back to — and
     * each look runs this table. One read an hour is the bound, and it is the same bound for the
     * read that follows and the one that would ask.
     */
    for (const mark of ["none", "asked"] as const) {
      for (const permission of EVERY_ANSWER) {
        for (const held of EVERYTHING_HELD) {
          expect(
            devicePlaceMove({
              ...base,
              mark,
              permission,
              held,
              isRecent: true,
            }),
          ).toBe("nothing");
        }
      }
    }
  });

  test("nobody is shown anything except by the one ask, and that only where nobody has decided", () => {
    // Every row of the table: "ask" comes out of exactly one.
    const asks: string[] = [];
    for (const mark of EVERY_MARK) {
      for (const isRecent of [false, true]) {
        for (const permission of EVERY_ANSWER) {
          for (const held of EVERYTHING_HELD) {
            const move = devicePlaceMove({
              ...base,
              mark,
              isRecent,
              permission,
              held,
            });
            if (move === "ask") {
              asks.push(
                `${mark}/${isRecent}/${permission}/${held.place}/${!!held.coordinates}`,
              );
            }
          }
        }
      }
    }
    expect(asks).toEqual(["none/false/prompt/null/false"]);
  });
});

describe("the move, carried out", () => {
  function doors(
    over: Partial<DevicePlaceDoors> & {
      place?: string | null;
      coordinates?: Coordinates | null;
      marked?: DeviceMark;
      device?: Coordinates;
      accuracy?: number | null;
      allowed?: DevicePermission;
      answers?: "yes" | "no" | "nothing";
      /** A browser tab, or the installed app — which differ in whether an unanswered ask is told. */
      surface?: "tab" | "app";
    } = {},
  ) {
    const did: string[] = [];
    const saved: Coordinates[] = [];
    // The account, the device's marks and the device's word on being asked, as they change.
    const world = {
      place: over.place ?? null,
      coordinates: over.coordinates ?? null,
      mark: over.marked ?? ("none" as DeviceMark),
      // Whether this device was read by itself within the hour: an hour passing clears it.
      isRecent: false,
      permission:
        over.allowed === undefined
          ? ("prompt" as DevicePermission)
          : over.allowed,
      device: over.device ?? HERE,
      // Good to a street or two unless a test says otherwise.
      accuracy: over.accuracy === undefined ? 65 : over.accuracy,
      // What the person does with the device's own question.
      answers: over.answers ?? "yes",
    };
    const made: DevicePlaceDoors = {
      agreed: () => true,
      canAsk: () => true,
      held: () => ({ place: world.place, coordinates: world.coordinates }),
      mark: () => world.mark,
      tellsWhenUnanswered: () => over.surface === "app",
      canMark: () => {
        did.push("can mark");
        return true;
      },
      markAsked: () => {
        did.push("marked");
        if (world.mark !== "cleared") world.mark = "asked";
        return true;
      },
      isRecent: () => world.isRecent,
      markRead: () => {
        did.push("noted");
        world.isRecent = true;
      },
      permission: async () => {
        did.push("permission");
        return world.permission;
      },
      read: async (mayPrompt): Promise<DeviceReading> => {
        did.push(mayPrompt ? "read, may prompt" : "read, silently");
        if (world.permission === "prompt") {
          // Only the ask may put the question up; what comes of it is the person's.
          if (!mayPrompt || world.answers === "nothing") {
            // The shell says so after a minute. A browser says nothing, ever: its prompt stays.
            if (over.surface !== "app") return new Promise(() => {});
            return { coordinates: null, refusal: "unanswered" };
          }
          world.permission = world.answers === "yes" ? "granted" : "denied";
        }
        if (world.permission !== "granted") {
          return { coordinates: null, refusal: "denied" };
        }
        return { coordinates: world.device, accuracy: world.accuracy };
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

  test("a device that has not decided is asked: marked before the question in a tab, and after the answer in the installed app", async () => {
    // A BROWSER shows its prompt the moment it is asked: the once is spent before the question.
    const tab = doors({ surface: "tab" });
    expect(await offerDevicePlace(tab.made)).toBe("ask");
    expect(tab.did).toEqual([
      "permission",
      "marked",
      "read, may prompt",
      "noted",
      "saved",
    ]);
    // THE INSTALLED APP's may never appear: whether a mark can be kept is found out before the
    // question, and the mark is written after the answer.
    const app = doors({ surface: "app" });
    expect(await offerDevicePlace(app.made)).toBe("ask");
    expect(app.did).toEqual([
      "permission",
      "can mark",
      "read, may prompt",
      "marked",
      "noted",
      "saved",
    ]);
    for (const first of [tab, app]) {
      // The coordinates and nothing else: the door is handed no word about the place. And that
      // read was the only one told it may show the person anything.
      expect(first.saved).toEqual([HERE]);
      // Looked at again within the hour: the device is not even asked what it would say.
      first.did.length = 0;
      expect(await offerDevicePlace(first.made)).toBe("nothing");
      expect(first.did).toEqual([]);
      // And an hour on: allowed now, so it is read with nothing shown — and it has not moved, so
      // nothing is written.
      first.world.isRecent = false;
      expect(await offerDevicePlace(first.made)).toBe("same");
      expect(first.did).toEqual([
        "permission",
        "marked",
        "noted",
        "read, silently",
      ]);
      expect(first.saved).toHaveLength(1);
    }
  });

  test("in the installed app a question nobody answered spends nothing: the device is asked again at the next look", async () => {
    /*
     * THE ONE ASK WAS SPENT ON A DIALOG NOBODY SAW (review of pull request 94). The installed app's
     * question goes through the system, which shows nothing where the app is not in use and then
     * says nothing either: the ask never came back, and it had been marked the moment it was put.
     * The shell answers `unanswered` after a minute now, and that is not a decision.
     */
    const ignored = doors({ surface: "app", answers: "nothing" });
    expect(await offerDevicePlace(ignored.made)).toBe("unanswered");
    expect(ignored.did).toEqual(["permission", "can mark", "read, may prompt"]);
    expect(ignored.world.mark).toBe("none");
    expect(ignored.saved).toEqual([]);
    // Not noted as a read either, so the next look does not wait an hour: it asks again.
    expect(ignored.world.isRecent).toBe(false);
    ignored.did.length = 0;
    ignored.world.answers = "yes";
    expect(await offerDevicePlace(ignored.made)).toBe("ask");
    expect(ignored.world.mark).toBe("asked");
    expect(ignored.saved).toEqual([HERE]);
  });

  test("in a browser tab the once is spent when the question is put: an ignored prompt is never shown again", async () => {
    /*
     * A browser's prompt is on screen the moment it is asked, and an ignored one says nothing
     * back, ever. Spending the once only on an answer meant every load of the page asked again —
     * a prompt on every open is how a product gets its location blocked for good.
     */
    const ignored = doors({ surface: "tab", answers: "nothing" });
    // The prompt is up and stays up: the offer does not come back.
    void offerDevicePlace(ignored.made);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ignored.did).toEqual(["permission", "marked", "read, may prompt"]);
    expect(ignored.world.mark).toBe("asked");

    // The page is loaded again, the prompt still unanswered as far as the browser says.
    ignored.did.length = 0;
    expect(await offerDevicePlace(ignored.made)).toBe("nothing");
    expect(ignored.did.join()).not.toContain("read");
    expect(ignored.saved).toEqual([]);
  });

  test("a no — or a prompt closed without a yes — is the person's answer: never asked again", async () => {
    const refused = doors({ answers: "no" });
    expect(await offerDevicePlace(refused.made)).toBe("unread");
    expect(refused.world.mark).toBe("asked");
    expect(refused.saved).toEqual([]);
    // Whatever the device says afterwards about being asked, and however long it has been.
    for (const allowed of ["prompt", "denied", null] as const) {
      refused.world.permission = allowed;
      refused.world.isRecent = false;
      refused.did.length = 0;
      expect(await offerDevicePlace(refused.made)).toBe("nothing");
      expect(refused.did.join()).not.toContain("read");
    }
  });

  test("a device that already said yes is read with nothing shown", async () => {
    const allowed = doors({ allowed: "granted" });
    expect(await offerDevicePlace(allowed.made)).toBe("read");
    // That yes was the person's decision: marked, and noted as read, before the device answers.
    expect(allowed.did).toEqual([
      "permission",
      "marked",
      "noted",
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
      "noted",
      "read, silently",
      "saved",
    ]);
    expect(moved.saved).toEqual([HERE]);
    // A device seeing the account's place for the first time follows too, and its once is spent.
    expect(moved.world.mark).toBe("asked");
  });

  test("allowed, held, and the device has not really moved: nothing is written — not for the same cell, and not for the one beside it", async () => {
    const still = doors({ allowed: "granted", coordinates: HERE });
    expect(await offerDevicePlace(still.made)).toBe("same");
    expect(still.saved).toEqual([]);
    /*
     * AT THE EDGE OF A CELL THE ROUNDED VALUE FLIPS. Somebody sitting still on a line between two
     * hundredths is 127.73 at one read and 127.74 at the next, and each write is a new place line
     * in the prompt and a colder cache. One hundredth, on either axis or both, is not a move.
     */
    for (const [latitude, longitude] of [
      [37.88, 127.74],
      [37.88, 127.72],
      [37.89, 127.73],
      [37.87, 127.73],
      [37.89, 127.74],
      [37.87, 127.72],
    ]) {
      const jitter = doors({
        allowed: "granted",
        coordinates: HERE,
        device: { latitude, longitude },
      });
      expect(await offerDevicePlace(jitter.made)).toBe("same");
      expect(jitter.saved).toEqual([]);
    }
    // Two hundredths, either way, is: the device's own value is what is kept.
    for (const [latitude, longitude] of [
      [37.88, 127.75],
      [37.88, 127.71],
      [37.9, 127.73],
      [37.86, 127.74],
    ]) {
      const moved = doors({
        allowed: "granted",
        coordinates: HERE,
        device: { latitude, longitude },
      });
      expect(await offerDevicePlace(moved.made)).toBe("follow");
      expect(moved.saved).toEqual([{ latitude, longitude }]);
    }
  });

  test("a fix too vague to name the town is not kept for somebody who pressed nothing", async () => {
    /*
     * "LAST LOOKED AT WINS" LET AN ADDRESS OVERWRITE A PLACE. A desktop on a cable is placed by
     * its network address, to within a city or two, and it would have written that over the good
     * fix a laptop gave at every open; and a first read that names the wrong city is worse than
     * the Seoul that says it does not know. Three kilometres, as the device itself reports it.
     */
    expect(AUTOMATIC_ACCURACY_METRES).toBe(3000);
    for (const accuracy of [3000.5, 5000, 48_000, null]) {
      // A follow: the account keeps the place it had.
      const followed = doors({
        allowed: "granted",
        coordinates: THERE,
        accuracy,
      });
      expect(await offerDevicePlace(followed.made)).toBe("vague");
      expect(followed.saved).toEqual([]);
      // The first read of a device that already said yes: the account stays empty, which is Seoul.
      const first = doors({ allowed: "granted", accuracy });
      expect(await offerDevicePlace(first.made)).toBe("vague");
      expect(first.saved).toEqual([]);
      // And the ask: the person did answer, so the once is spent — but nothing vague is kept.
      const asked = doors({ accuracy });
      expect(await offerDevicePlace(asked.made)).toBe("vague");
      expect(asked.saved).toEqual([]);
      expect(asked.world.mark).toBe("asked");
    }
    // Exactly three kilometres is good enough, and so is anything better.
    for (const accuracy of [3000, 1200, 65, 0]) {
      const kept = doors({ allowed: "granted", coordinates: THERE, accuracy });
      expect(await offerDevicePlace(kept.made)).toBe("follow");
      expect(kept.saved).toEqual([HERE]);
    }
    // A vague fix is still a read: the device is not asked again for an hour, and then it is.
    const later = doors({ allowed: "granted", accuracy: 48_000 });
    expect(await offerDevicePlace(later.made)).toBe("vague");
    expect(await offerDevicePlace(later.made)).toBe("nothing");
    later.world.isRecent = false;
    later.world.accuracy = 65;
    expect(await offerDevicePlace(later.made)).toBe("read");
    expect(later.saved).toEqual([HERE]);
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
      // The place is cleared on another device, and this one is looked at again: no dialog.
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

  test("storage that cannot keep a mark means the device is neither asked nor read", async () => {
    // To be asked in the installed app: found out before the question is put, since there the
    // mark comes after the answer. In a tab the mark itself comes first.
    for (const over of [
      { surface: "app" as const, canMark: () => false },
      { surface: "tab" as const, markAsked: () => false },
    ]) {
      const forgetful = doors(over);
      expect(await offerDevicePlace(forgetful.made)).toBe("nothing");
      expect(forgetful.did.join()).not.toContain("read");
    }
    // Already allowed, over a place held or over none.
    for (const coordinates of [null, THERE]) {
      const silent = doors({
        allowed: "granted",
        coordinates,
        markAsked: () => false,
      });
      expect(await offerDevicePlace(silent.made)).toBe("nothing");
      expect(silent.did.join()).not.toContain("read");
      expect(silent.saved).toEqual([]);
    }
  });

  test("a device that said yes and was not heard is read at a later look", async () => {
    // Allowed at the prompt, and the save did not land.
    let isOffline = true;
    const offline = doors();
    const save = offline.made.save;
    offline.made.save = async (coordinates) => {
      if (isOffline) throw new Error("offline");
      await save(coordinates);
    };
    expect(await offerDevicePlace(offline.made)).toBe("unsaved");
    expect(offline.saved).toEqual([]);
    expect(offline.world.mark).toBe("asked");
    // An hour on, back online: the device said yes, so it is read — with nothing shown.
    isOffline = false;
    offline.world.isRecent = false;
    offline.did.length = 0;
    expect(await offerDevicePlace(offline.made)).toBe("read");
    expect(offline.did).toEqual([
      "permission",
      "marked",
      "noted",
      "read, silently",
      "saved",
    ]);
    expect(offline.saved).toEqual([HERE]);

    // A door that fails outright is quiet too, and nothing is saved.
    const broken = doors({
      allowed: "granted",
      read: async () => {
        throw new Error("no device");
      },
    });
    expect(await offerDevicePlace(broken.made)).toBe("unread");
    expect(broken.saved).toEqual([]);
  });

  test("coordinates given another way while the prompt was up stand", async () => {
    // The settings button was pressed while the prompt was up: what it saved stands.
    const raced = doors();
    raced.made.read = async () => {
      raced.world.coordinates = THERE;
      return { coordinates: HERE, accuracy: 65 };
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
      return { coordinates: HERE, accuracy: 65 };
    };
    expect(await offerDevicePlace(meanwhile.made)).toBe("ask");
    expect(meanwhile.saved).toEqual([HERE]);
  });

  test("지우기, or a place said, while a following device was answering: theirs stands", async () => {
    const cleared = doors({ allowed: "granted", coordinates: THERE });
    cleared.made.read = async () => {
      // 지우기 marks before its request goes, so a follow in the air sees it when it lands.
      cleared.world.mark = "cleared";
      return { coordinates: HERE, accuracy: 65 };
    };
    expect(await offerDevicePlace(cleared.made)).toBe("nothing");
    expect(cleared.saved).toEqual([]);

    const said = doors({ allowed: "granted", coordinates: THERE });
    said.made.read = async () => {
      // `remember` replaces the place whole: the words in, the coordinates out.
      said.world.place = "부산 해운대구";
      said.world.coordinates = null;
      return { coordinates: HERE, accuracy: 65 };
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
    // Each of them is a row the table already has: read, asked, or left alone.
    const facts = {
      agreed: true,
      canAsk: true,
      held: NOTHING_HELD,
      mark: "none" as const,
      isRecent: false,
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

  test("where the shell says the device is, is rounded again here, carries how far off it may be, and is told whether it may show anything", async () => {
    // The shell rounds before it answers. This side rounds too: nothing here holds a finer value
    // because the other side promised.
    shell({
      place: {
        kind: "place",
        latitude: 37.498_095,
        longitude: 127.027_61,
        accuracy: 65,
      },
    });
    expect(await readDevice(false)).toEqual({
      coordinates: { latitude: 37.5, longitude: 127.03 },
      accuracy: 65,
    });
    expect(calls).toEqual([["device_place", { prompt: false }]]);
    // A fix that does not say how far off it is has not said it is good.
    for (const accuracy of [undefined, null, "65", -1, Number.NaN]) {
      shell({
        place: { kind: "place", latitude: 35.16, longitude: 129.16, accuracy },
      });
      expect(await readDevice(false)).toEqual({
        coordinates: THERE,
        accuracy: null,
      });
    }
    // A press, and the one ask, may put the system's question up — and a person who pressed is
    // given whatever the device has, however vague: they are looking at it.
    shell({
      place: {
        kind: "place",
        latitude: 35.16,
        longitude: 129.16,
        accuracy: 48_000,
      },
    });
    expect(await readDeviceCoordinates()).toEqual(THERE);
    expect(calls).toEqual([["device_place", { prompt: true }]]);
  });

  test("every reason the shell has no place is one of three, and only two of them are the person's answer", async () => {
    const refusals: Array<[unknown, "denied" | "unavailable" | "unanswered"]> =
      [
        [{ kind: "denied" }, "denied"],
        [{ kind: "restricted" }, "denied"],
        // Allowed, and the device could not say, or not in time.
        [{ kind: "unavailable" }, "unavailable"],
        [{ kind: "timeout" }, "unavailable"],
        // NOBODY DECIDED: the minute passed, or the read was told to show nothing, or the shell
        // does not read this platform — or said nothing this page knows.
        [{ kind: "unanswered" }, "unanswered"],
        [{ kind: "undetermined_no_prompt" }, "unanswered"],
        [{ kind: "unsupported" }, "unanswered"],
        [{ kind: "somewhere" }, "unanswered"],
        [{ latitude: 37.5, longitude: 127.03 }, "unanswered"],
        [{ kind: "place", latitude: "37.5", longitude: 127.03 }, "unanswered"],
        [null, "unanswered"],
        // A place that is not on this planet is a device that could not say.
        [{ kind: "place", latitude: 91, longitude: 127.03 }, "unavailable"],
      ];
    const words = {
      denied: "Location was not allowed on this device.",
      unavailable: "This device did not say where it is.",
      unanswered:
        "The question about this device's location has not been answered. If you do not see it, press again.",
    };
    for (const [place, refusal] of refusals) {
      shell({ place });
      expect(await readDevice(false)).toEqual({ coordinates: null, refusal });
      // A press says it in this surface's words, and never as a place.
      await expect(readDeviceCoordinates()).rejects.toThrow(words[refusal]);
    }
  });
});

/**
 * AND A BROWSER TAB ASKS ITS OWN API, through the same door: a fix with how far off it may be, or
 * why there is none. A browser has no word for "nobody decided" — a prompt closed without a yes
 * is reported as a no, and its clock for the device does not run while it asks — so every failure
 * it reports is the person's answer.
 */
describe("in a browser tab, the device is asked through the browser", () => {
  const real = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  const asked: unknown[] = [];

  function browser(
    answer: (
      resolve: (position: unknown) => void,
      reject: (failure: unknown) => void,
    ) => void,
  ) {
    asked.length = 0;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          resolve: (position: unknown) => void,
          reject: (failure: unknown) => void,
          options: unknown,
        ) => {
          asked.push(options);
          answer(resolve, reject);
        },
      },
    });
  }

  afterEach(() => {
    if (real) Object.defineProperty(navigator, "geolocation", real);
    else delete (navigator as unknown as Record<string, unknown>).geolocation;
  });

  test("a fix is rounded before anything holds it, and carries how far off the browser says it may be", async () => {
    browser((resolve) =>
      resolve({
        coords: { latitude: 37.498_095, longitude: 127.027_61, accuracy: 40 },
      }),
    );
    expect(await readDevice(false)).toEqual({
      coordinates: { latitude: 37.5, longitude: 127.03 },
      accuracy: 40,
    });
    // Coarse, an answer up to an hour old, and ten seconds for the device once it may be read.
    expect(asked).toEqual([
      { enableHighAccuracy: false, maximumAge: 3_600_000, timeout: 10_000 },
    ]);
    // A browser that does not say how far off it is has not said it is good.
    browser((resolve) =>
      resolve({ coords: { latitude: 35.16, longitude: 129.16 } }),
    );
    expect(await readDevice(false)).toEqual({
      coordinates: THERE,
      accuracy: null,
    });
    // And a press is given what the device has.
    expect(await readDeviceCoordinates()).toEqual(THERE);
  });

  test("a no and a closed prompt are the person's answer; no fix comes only after a yes; and a browser that will not be asked has asked nobody", async () => {
    const failure = (code: number) => ({ code, PERMISSION_DENIED: 1 });
    browser((_resolve, reject) => reject(failure(1)));
    expect(await readDevice(true)).toEqual({
      coordinates: null,
      refusal: "denied",
    });
    await expect(readDeviceCoordinates()).rejects.toThrow(
      "Location was not allowed on this device.",
    );
    // POSITION_UNAVAILABLE and TIMEOUT.
    for (const code of [2, 3]) {
      browser((_resolve, reject) => reject(failure(code)));
      expect(await readDevice(true)).toEqual({
        coordinates: null,
        refusal: "unavailable",
      });
    }
    // Not a place on this planet.
    browser((resolve) => resolve({ coords: { latitude: 91, longitude: 0 } }));
    expect(await readDevice(true)).toEqual({
      coordinates: null,
      refusal: "unavailable",
    });
    await expect(readDeviceCoordinates()).rejects.toThrow(
      "This device did not say where it is.",
    );
    // The API itself refuses the call: nothing was put in front of anybody.
    browser(() => {
      throw new Error("not in a secure context");
    });
    expect(await readDevice(true)).toEqual({
      coordinates: null,
      refusal: "unanswered",
    });
  });
});
