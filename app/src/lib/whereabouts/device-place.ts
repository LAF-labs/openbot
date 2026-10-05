import type { Coordinates, Whereabouts } from "@shared/whereabouts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  authKeys,
  type CurrentUserResult,
  currentUserQueryOptions,
} from "@/lib/auth/queries";
import {
  canAskDeviceLocation,
  readDeviceCoordinates,
  savePlace,
} from "./queries";

/**
 * The device's own place, asked for once — so the default is where the person really is.
 *
 * The owner, 2026-10-05: "지역과 날짜는 기본값 실제 위치 데이터, fallback은 서울, 유저가 특정 위치를
 * 말해주면 저장." The date already was the device's (its zone rides on every turn and is kept for the
 * routines). The place was not: the device was read only when somebody found 내 정보 → 위치 and
 * pressed a button there, so for nearly everybody "real location" was nothing, and nothing is now
 * Seoul. This asks the browser at the first signed-in open instead.
 *
 * ONCE PER DEVICE, WHATEVER CAME OF IT. Asked and dismissed must never ask again — a prompt on every
 * open is how a product gets its location blocked for good. And a browser that had already said yes
 * is read once too, not on every open: a person who cleared their place on 내 정보 would otherwise
 * find the coordinates back the next time the tab opened, and 지우기 would be a control that does
 * nothing. After the once, the button in settings is the way.
 *
 * NOT IN THE DESKTOP SHELL (`canAskDeviceLocation`): its webview answers no geolocation request. A
 * person there is Seoul until they say where they are, or open a browser tab once.
 *
 * NEVER FINER THAN TWO DECIMALS, NEVER LOGGED: `readDeviceCoordinates` rounds before anything holds
 * the answer, and it goes through the same door the settings button uses (`PUT /api/me/place`).
 */

/** Per device, in this browser's storage: that the device has been asked (or read) once. */
const DEVICE_PLACE_ASKED_KEY = "laf.device-place-asked";

/** What the browser says about being asked where it is; null where it cannot be asked that. */
export type GeolocationPermission = "granted" | "prompt" | "denied" | null;

export type DevicePlaceMove =
  /** Already allowed: read it and keep it, with nothing shown. */
  | "read"
  /** Not decided: the browser's own prompt, this once. */
  | "ask"
  | "nothing";

/**
 * What to do at a signed-in open. Nothing, unless every one of these holds: this surface can ask a
 * device at all, no coordinates are held, this device was never asked, and the browser says the
 * answer is yes or not yet decided. A browser with no Permissions API cannot say which, and asking
 * blind is a prompt nobody chose to risk — so it is left alone.
 */
export function devicePlaceMove(input: {
  canAsk: boolean;
  held: Coordinates | null;
  alreadyAsked: boolean;
  permission: GeolocationPermission;
}): DevicePlaceMove {
  if (!input.canAsk || input.held || input.alreadyAsked) return "nothing";
  if (input.permission === "granted") return "read";
  if (input.permission === "prompt") return "ask";
  return "nothing";
}

function wasAsked(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEVICE_PLACE_ASKED_KEY) === "1";
  } catch {
    // Storage that throws cannot remember a dismissal, so the device is treated as asked already.
    return true;
  }
}

/** Whether it was kept. Where it cannot be, the device is not asked: the once could not be held to. */
function markAsked(): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(DEVICE_PLACE_ASKED_KEY, "1");
    return storage.getItem(DEVICE_PLACE_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

async function geolocationPermission(): Promise<GeolocationPermission> {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    const state = status?.state;
    return state === "granted" || state === "prompt" || state === "denied"
      ? state
      : null;
  } catch {
    return null;
  }
}

export type DevicePlaceDoors = {
  canAsk: () => boolean;
  /** What the account holds now — read again just before saving, so words said meanwhile are kept. */
  held: () => Pick<Whereabouts, "place" | "coordinates">;
  wasAsked: () => boolean;
  markAsked: () => boolean;
  permission: () => Promise<GeolocationPermission>;
  read: () => Promise<Coordinates>;
  save: (answer: {
    place: string | null;
    coordinates: Coordinates;
  }) => Promise<unknown>;
};

/**
 * The once, carried out. Says what it did, for a test.
 *
 * MARKED BEFORE THE DEVICE IS ASKED, not after: a prompt closed with the tab, or a read that never
 * comes back, has still been the once. And saved WITH THE WORDS THE ACCOUNT HOLDS: the door replaces
 * the place whole (`savePlace`, server), so coordinates sent alone would erase "강원 춘천시".
 *
 * Quiet in every failure — denied at the prompt, no fix, offline. There is no screen here to say it
 * on, and the person is no worse off than before: Seoul, until they say otherwise.
 */
export async function offerDevicePlace(
  doors: DevicePlaceDoors,
): Promise<DevicePlaceMove | "unread" | "unsaved"> {
  if (!doors.canAsk() || doors.held().coordinates || doors.wasAsked()) {
    return "nothing";
  }
  const move = devicePlaceMove({
    canAsk: true,
    held: null,
    alreadyAsked: false,
    permission: await doors.permission(),
  });
  if (move === "nothing") return move;
  if (!doors.markAsked()) return "nothing";
  let coordinates: Coordinates;
  try {
    coordinates = await doors.read();
  } catch {
    return "unread";
  }
  const now = doors.held();
  // Given another way while the prompt was up (the settings button, another tab): theirs stands.
  if (now.coordinates) return "nothing";
  try {
    await doors.save({ place: now.place, coordinates });
  } catch {
    return "unsaved";
  }
  return move;
}

/** One offer a page load, however many times the effect below runs. */
let offered = false;

/**
 * At the first signed-in open: the device's place, once (`offerDevicePlace`).
 *
 * Waits for the current user, because "no coordinates are held" is a fact about the account and an
 * account not read yet holds nothing by default. The work is in an effect and its own function:
 * nothing here is read or written while rendering.
 */
export function useDevicePlaceOnce(): void {
  const queryClient = useQueryClient();
  const { data: user } = useQuery(currentUserQueryOptions());
  const isSignedIn = Boolean(user);
  useEffect(() => {
    if (!isSignedIn || offered) return;
    offered = true;
    const held = () => {
      const current = queryClient.getQueryData<CurrentUserResult>(
        authKeys.currentUser(),
      );
      const whereabouts =
        current && typeof current === "object" ? current.whereabouts : null;
      return {
        place: whereabouts?.place ?? null,
        coordinates: whereabouts?.coordinates ?? null,
      };
    };
    void offerDevicePlace({
      canAsk: canAskDeviceLocation,
      held,
      wasAsked,
      markAsked,
      permission: geolocationPermission,
      read: readDeviceCoordinates,
      save: (answer) => savePlace(answer, queryClient),
    });
  }, [isSignedIn, queryClient]);
}
