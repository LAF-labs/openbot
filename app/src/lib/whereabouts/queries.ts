import {
  type Coordinates,
  canonicalLocale,
  coarseCoordinates,
  isUsableTimeZone,
  type Whereabouts,
} from "@shared/whereabouts";
import type { QueryClient } from "@tanstack/react-query";
import { authKeys, type CurrentUserResult } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import {
  inShell,
  shellDevicePermission,
  shellDevicePlace,
} from "@/lib/notifications/shell";
import { parseWhereabouts } from "./parse";

/**
 * The person's clock and place, on the wire: read off `/api/me`, written through `/api/me/device`
 * and `/api/me/place` (`server/src/account/whereabouts.ts`).
 *
 * The Bot's browser runs on a cloud VM, so its clock and its place are the VM's: a Bot once told its
 * owner the weather "in 제주시, 사장님 위치" off a site that had guessed from the VM's address. This
 * device is where the person is, so this is where their zone and — with their permission — their
 * place come from.
 */

/** The device's zone and language, as `Intl` and the browser report them. */
export type DeviceClock = { timeZone: string; locale: string };

/**
 * Read now, not cached: a laptop that crossed a border since the tab opened answers differently,
 * and the next run should be told the new answer. Seoul and Korean when the device will not say,
 * which is where this product's people are.
 */
export function deviceClock(): DeviceClock {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    timeZone: isUsableTimeZone(zone) ? zone : "Asia/Seoul",
    locale:
      canonicalLocale(
        typeof navigator === "undefined" ? null : navigator.language,
      ) ?? "ko-KR",
  };
}

/** Put what the server now holds onto the current user, the way the shop answers are. */
function hold(queryClient: QueryClient, whereabouts: Whereabouts): void {
  queryClient.setQueryData<CurrentUserResult>(
    authKeys.currentUser(),
    (current) =>
      current && typeof current === "object"
        ? { ...current, whereabouts }
        : current,
  );
}

async function heldFrom(response: Response): Promise<Whereabouts> {
  const body = (await response.json().catch(() => null)) as {
    whereabouts?: unknown;
  } | null;
  return parseWhereabouts(body?.whereabouts);
}

/**
 * Tell the server this device's clock. Sent whenever the app opens, so a routine at 07:30 — which
 * runs with no device present — reads the zone the person was last in.
 *
 * Quiet on failure: the clock line of the next run is already this device's (it rides on the run),
 * and the next open reports again.
 */
export async function reportDevice(queryClient: QueryClient): Promise<void> {
  try {
    const response = await fetch("/api/me/device", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deviceClock()),
    });
    if (response.ok) hold(queryClient, await heldFrom(response));
  } catch {
    // Offline, or a deployment without the door. Nothing to say to anybody.
  }
}

/**
 * Keep a place — the words, and the device's coarse coordinates when the person gave them — and put
 * what the server holds onto the current user. The words of a failure are this surface's.
 */
export async function savePlace(
  answer: { place: string | null; coordinates: Coordinates | null },
  queryClient: QueryClient,
): Promise<Whereabouts> {
  return wordsOf(await send("PUT", answer, queryClient));
}

/**
 * Keep the device's coordinates, and say nothing about the words.
 *
 * NO `place` IN THE BODY, on purpose. The device answers minutes after it was asked, and this tab's
 * copy of the account may be older than a place the person said meanwhile — to their Bot, in
 * another tab. Sent with the tab's `place: null`, the answer erased it. A body that does not name
 * the words leaves them as the server holds them (`placeAnswerOf`, server).
 */
export async function saveDeviceCoordinates(
  coordinates: Coordinates,
  queryClient: QueryClient,
): Promise<Whereabouts> {
  return wordsOf(await send("PUT", { coordinates }, queryClient));
}

/**
 * Forget the place and the coordinates. The weather is Seoul's again until one is said or given.
 * The settings screen clears through `clearPlaceOnThisDevice` (`device-place.ts`), which also keeps
 * this device from being read again by itself.
 */
export async function clearPlace(
  queryClient: QueryClient,
): Promise<Whereabouts> {
  return wordsOf(await send("DELETE", undefined, queryClient));
}

type PlaceResult =
  | { ok: true; whereabouts: Whereabouts }
  | { ok: false; code: "laf:place_invalid" | "laf:place_unsaved" };

function wordsOf(result: PlaceResult): Whereabouts {
  if (result.ok) return result.whereabouts;
  throw new Error(
    result.code === "laf:place_invalid"
      ? t("That place was not saved. Only a city and district can be kept.")
      : t("That was not saved. Try again."),
  );
}

async function send(
  method: "PUT" | "DELETE",
  answer: unknown,
  queryClient: QueryClient,
): Promise<PlaceResult> {
  let response: Response;
  try {
    response = await fetch("/api/me/place", {
      method,
      credentials: "include",
      ...(answer === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(answer),
          }),
    });
  } catch {
    return { ok: false, code: "laf:place_unsaved" };
  }
  if (response.status === 400) return { ok: false, code: "laf:place_invalid" };
  if (!response.ok) return { ok: false, code: "laf:place_unsaved" };
  const whereabouts = await heldFrom(response);
  hold(queryClient, whereabouts);
  return { ok: true, whereabouts };
}

/*
 * —— The device, on either surface ————————————————————————————————————————————————————————————————
 *
 * A browser tab asks `navigator.geolocation`. THE INSTALLED APP ASKS ITS SHELL: its webview
 * (WKWebView, through wry) answers no geolocation request, so until 2026-10-05 the surface this
 * product leads with was the one where a person's place fell straight to Seoul. The shell reads
 * the device itself now (`desktop/src-tauri/src/location.rs`) and these three go through it there
 * and through the browser's own API in a tab — the same three questions, so everything that
 * decides what to do with the answers is written once (`device-place.ts`).
 */

/** What the device says about being asked where it is; null where it cannot say, or cannot be asked. */
export type DevicePermission = "granted" | "prompt" | "denied" | null;

/**
 * Whether this surface has a way to ask the device at all: the browser's own API in a tab, the
 * shell in the installed app.
 *
 * A SHELL IS ONLY WORTH ASKING, NOT KNOWN TO ANSWER. One from before the command, and one on
 * Windows, can say nothing about the device — and that is not knowable without asking it, which
 * `devicePermission` does (null) and `canUseDeviceLocation` does for a control that must not be
 * drawn dead.
 */
export function canAskDeviceLocation(): boolean {
  if (inShell()) return true;
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

/**
 * Whether a press here would really reach the device — what decides if the button is drawn.
 *
 * In a tab that is `canAskDeviceLocation`. In the installed app the shell is asked whether it can
 * be: a button over a shell that cannot read the device asks and then says nothing, which is
 * worse than no button. A device that said no still gets the button, as it does in a tab: the
 * press is answered in words, and the person learns why.
 */
export async function canUseDeviceLocation(): Promise<boolean> {
  if (!inShell()) return canAskDeviceLocation();
  const said = await shellDevicePermission();
  return said !== null && said !== "unsupported";
}

/**
 * What the device would say to being asked, without asking it: nothing is shown and no location
 * is read, on either surface.
 */
export async function devicePermission(): Promise<DevicePermission> {
  if (inShell()) {
    const said = await shellDevicePermission();
    // A machine whose person may not decide has said no as far as anything here goes.
    if (said === "restricted") return "denied";
    return said === "unsupported" ? null : said;
  }
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

/**
 * Ask the device where it is, once, coarsely: low accuracy, a cached answer up to an hour old, and
 * the result rounded to two decimals before anything holds it. Rejects with the surface's words.
 *
 * `mayPrompt` IS FOR THE READ THAT MUST SHOW NOTHING. The shell is told, and answers without a
 * dialog whatever the system holds. A browser cannot be told: it decides for itself, so a tab is
 * read this way only when it has just said it is already allowed.
 */
export function readDeviceCoordinates(mayPrompt = true): Promise<Coordinates> {
  return inShell() ? readThroughTheShell(mayPrompt) : readThroughTheBrowser();
}

/**
 * The shell's answer, rounded again here although the shell already has: the rule is that nothing
 * holds a finer value, and a rule kept by one side only is kept until that side changes.
 */
async function readThroughTheShell(mayPrompt: boolean): Promise<Coordinates> {
  const said = await shellDevicePlace({ prompt: mayPrompt });
  const coordinates = said?.kind === "place" ? coarseCoordinates(said) : null;
  if (coordinates) return coordinates;
  throw new Error(
    said?.kind === "denied" || said?.kind === "restricted"
      ? t("Location was not allowed on this device.")
      : t("This device did not say where it is."),
  );
}

function readThroughTheBrowser(): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coordinates = coarseCoordinates({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        if (coordinates) resolve(coordinates);
        else reject(new Error(t("This device did not say where it is.")));
      },
      (failure) =>
        reject(
          new Error(
            failure.code === failure.PERMISSION_DENIED
              ? t("Location was not allowed on this device.")
              : t("This device did not say where it is."),
          ),
        ),
      { enableHighAccuracy: false, maximumAge: 3_600_000, timeout: 10_000 },
    );
  });
}
