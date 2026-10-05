import type { Coordinates, Whereabouts } from "@shared/whereabouts";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  authKeys,
  type CurrentUserResult,
  currentUserQueryOptions,
} from "@/lib/auth/queries";
import {
  canAskDeviceLocation,
  clearPlace,
  readDeviceCoordinates,
  saveDeviceCoordinates,
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
 * NOT BEFORE THE PERSON HAS AGREED TO ANYTHING. The first cut ran for anybody signed in, which
 * includes the first-run screen and the screen that asks again when the terms change: a new person
 * met the browser's location dialog before the sentence that says what continuing means, and a
 * browser that had already said yes was read and saved with nothing shown, before the agreement was
 * recorded (review of pull request 91). It waits for the same two facts `_authed`'s guard reads —
 * past the first run, no agreement owed — and never runs on the two screens that ask for them.
 *
 * NOT WHILE THE PERSON HAS SAID WHERE THEY ARE. What a person said outranks where a device is, in
 * the prompt and in the weather tool alike, so for them the browser's dialog would only be a
 * surprise with nothing behind it. They are not asked, and the once is not spent: if the words are
 * cleared later, the default is the device again and it is asked then.
 *
 * ONCE PER DEVICE, WHATEVER CAME OF IT. Asked and dismissed must never ask again — a prompt on every
 * open is how a product gets its location blocked for good. A browser that had already said yes is
 * read once too, not on every open. And an account that holds coordinates has had its once on every
 * device that sees them: a person who then clears their place on 내 정보 finds it stays cleared —
 * the coordinates do not come back at the next open, which would make 지우기 a control that does
 * nothing. After the once, the button in settings is the way.
 *
 * NOT IN THE DESKTOP SHELL (`canAskDeviceLocation`): its webview answers no geolocation request. A
 * person there is Seoul until they say where they are, or open a browser tab once.
 *
 * NEVER FINER THAN TWO DECIMALS, NEVER LOGGED, AND NEVER THE WORDS: `readDeviceCoordinates` rounds
 * before anything holds the answer, and it goes through the settings button's own door with no word
 * about the place the person said (`saveDeviceCoordinates`) — the server writes the coordinates and
 * leaves the words as they are, whatever this tab thought they were.
 */

/** Per device, in this browser's storage: that the device's once is spent. */
const DEVICE_PLACE_ASKED_KEY = "laf.device-place-asked";

/** What the browser says about being asked where it is; null where it cannot be asked that. */
export type GeolocationPermission = "granted" | "prompt" | "denied" | null;

export type DevicePlaceMove =
  /** Already allowed: read it and keep it, with nothing shown. Spends the once. */
  | "read"
  /** Not decided: the browser's own prompt, this once. Spends the once. */
  | "ask"
  /** The account holds coordinates already: nothing to ask, and the once is spent here too. */
  | "spent"
  /** Nothing, and nothing is marked: a later open decides again. */
  | "nothing";

/**
 * Whether a person is somebody the device may be asked about at all: past the first run, owing no
 * agreement, and not on the two screens that exist to ask for those. The same facts `_authed`'s
 * `beforeLoad` reads; the paths are named as well, because a person can stand on `/welcome` for a
 * moment after the stamp lands and before the screen leaves.
 */
export function mayAskAboutTheDevice(
  user: { onboarded: boolean; consentRequired: boolean } | null | undefined,
  pathname: string,
): boolean {
  if (!user?.onboarded || user.consentRequired) return false;
  return pathname !== "/welcome" && pathname !== "/consent";
}

/**
 * What to do at a signed-in open. In order, and the order is the rule:
 *
 *   not agreed, or a surface that cannot ask (the shell)   nothing
 *   the account holds coordinates                          spent — the once is over on this device
 *   the person has said where they are                     nothing — and the once is kept for later
 *   this device was asked before                           nothing
 *   the browser says yes already                           read
 *   the browser has not decided                            ask
 *   the browser says no, or cannot say (no Permissions API) nothing — asking blind is a prompt
 *                                                          nobody chose to risk
 */
export function devicePlaceMove(input: {
  agreed: boolean;
  canAsk: boolean;
  held: Pick<Whereabouts, "place" | "coordinates">;
  alreadyAsked: boolean;
  permission: GeolocationPermission;
}): DevicePlaceMove {
  if (!input.agreed || !input.canAsk) return "nothing";
  if (input.held.coordinates) return "spent";
  if (input.held.place?.trim()) return "nothing";
  if (input.alreadyAsked) return "nothing";
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

/** What the account holds, as this tab last heard it. */
function heldIn(
  queryClient: QueryClient,
): Pick<Whereabouts, "place" | "coordinates"> {
  const current = queryClient.getQueryData<CurrentUserResult>(
    authKeys.currentUser(),
  );
  const whereabouts =
    current && typeof current === "object" ? current.whereabouts : null;
  return {
    place: whereabouts?.place ?? null,
    coordinates: whereabouts?.coordinates ?? null,
  };
}

export type DevicePlaceDoors = {
  /** Past the first run, owing no agreement, on a screen that asks for neither — read when acted on. */
  agreed: () => boolean;
  canAsk: () => boolean;
  /** What the account holds, as this tab knows it. Read again after the device answers. */
  held: () => Pick<Whereabouts, "place" | "coordinates">;
  wasAsked: () => boolean;
  markAsked: () => boolean;
  permission: () => Promise<GeolocationPermission>;
  read: () => Promise<Coordinates>;
  /** The coordinates and nothing else: the words the account holds are not this door's to send. */
  save: (coordinates: Coordinates) => Promise<unknown>;
};

/**
 * The once, carried out. Says what it did, for a test.
 *
 * MARKED BEFORE THE DEVICE IS ASKED, not after: a prompt closed with the tab, or a read that never
 * comes back, has still been the once.
 *
 * THE BROWSER IS NOT EVEN ASKED WHAT IT WOULD SAY until every reason not to ask has been ruled out —
 * so somebody who has not agreed, or who has said where they are, costs the browser nothing and
 * leaves no mark.
 *
 * Quiet in every failure — denied at the prompt, no fix, offline. There is no screen here to say it
 * on, and the person is no worse off than before: Seoul, until they say otherwise.
 */
export async function offerDevicePlace(
  doors: DevicePlaceDoors,
): Promise<DevicePlaceMove | "unread" | "unsaved"> {
  const facts = () => ({
    agreed: doors.agreed(),
    canAsk: doors.canAsk(),
    held: doors.held(),
    alreadyAsked: doors.wasAsked(),
  });
  // Decided once without the browser: "prompt" stands for "whatever it would say".
  const first = devicePlaceMove({ ...facts(), permission: "prompt" });
  if (first === "spent") doors.markAsked();
  if (first !== "ask") return first;
  // And again with its answer, on the facts as they are now.
  const move = devicePlaceMove({
    ...facts(),
    permission: await doors.permission(),
  });
  if (move === "spent") doors.markAsked();
  if (move !== "read" && move !== "ask") return move;
  if (!doors.markAsked()) return "nothing";
  let coordinates: Coordinates;
  try {
    coordinates = await doors.read();
  } catch {
    return "unread";
  }
  // Given another way while the prompt was up (the settings button, another tab): theirs stands.
  if (doors.held().coordinates) return "spent";
  try {
    await doors.save(coordinates);
  } catch {
    return "unsaved";
  }
  return move;
}

/**
 * 지우기, on this device: the place is cleared, and where the device's coordinates were part of it
 * the once is spent here — whatever this device had or had not been asked.
 *
 * WITHOUT THIS A CLEARED PLACE CAME BACK ONCE. Somebody whose coordinates came from the settings
 * button — every person who gave them before the device was asked by itself — had never been
 * marked: they cleared their place, and at the next open a browser that still said yes was read and
 * saved again (review of pull request 91). Clearing words alone spends nothing: the device was
 * never part of that answer, and with nothing known it is the default again.
 */
export async function clearPlaceOnThisDevice(
  queryClient: QueryClient,
): Promise<Whereabouts> {
  const hadCoordinates = heldIn(queryClient).coordinates !== null;
  const cleared = await clearPlace(queryClient);
  if (hadCoordinates) markAsked();
  return cleared;
}

/**
 * At a signed-in open, once the person is somebody who may be asked: the device's place, once
 * (`offerDevicePlace`).
 *
 * One offer for each time this is mounted, however often the effect runs — and not spent while the
 * person is still on the first run or owes an agreement, so the offer is made on the screen they
 * land on after it. The work is in an effect and its own function: nothing here is read or written
 * while rendering.
 */
export function useDevicePlaceOnce(): void {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { data: user } = useQuery(currentUserQueryOptions());
  const mayAsk = mayAskAboutTheDevice(user, pathname);
  const offered = useRef(false);
  useEffect(() => {
    if (!mayAsk || offered.current) return;
    offered.current = true;
    void offerDevicePlace({
      // Read again when acted on: the cache and the address, not what this render saw.
      agreed: () => {
        const current = queryClient.getQueryData<CurrentUserResult>(
          authKeys.currentUser(),
        );
        return mayAskAboutTheDevice(
          current && typeof current === "object" ? current : null,
          router.state.location.pathname,
        );
      },
      canAsk: canAskDeviceLocation,
      held: () => heldIn(queryClient),
      wasAsked,
      markAsked,
      permission: geolocationPermission,
      read: readDeviceCoordinates,
      save: (coordinates) => saveDeviceCoordinates(coordinates, queryClient),
    });
  }, [mayAsk, queryClient, router]);
}
