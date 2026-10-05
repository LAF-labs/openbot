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
 * the device itself now (`desktop/src-tauri/src/location.rs`) and what follows goes through it
 * there and through the browser's own API in a tab — the same questions, so everything that
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
 * Why a device gave no place. Three, because what the caller has to know is whether the PERSON
 * DECIDED anything:
 *
 *   denied        they said no — at the prompt, in their settings, or the machine did for them
 *   unavailable   they said yes, and the device could not say where it is, or not in time
 *   unanswered    nobody decided: the question was not answered within the shell's minute, was
 *                 never put, or cannot be put here at all
 *
 * The first two are answers to being asked. The third is not, and whoever keeps "once per device"
 * must not count it.
 */
export type DeviceRefusal = "denied" | "unavailable" | "unanswered";

/**
 * What a device said when it was asked where it is: coarse coordinates and how far off it says
 * they may be, in metres (null where it did not say) — or why there are none.
 *
 * A FACT EITHER WAY, NEVER THROWN. The caller that reads a device by itself decides differently
 * about each refusal and about a fix too vague to keep, and a caught Error carries a sentence
 * where it needs a kind.
 */
export type DeviceReading =
  | { coordinates: Coordinates; accuracy: number | null }
  | { coordinates: null; refusal: DeviceRefusal };

/**
 * Ask the device where it is, once, coarsely: low accuracy, a cached answer up to an hour old, and
 * the result rounded to two decimals before anything holds it.
 *
 * `mayPrompt` IS FOR THE READ THAT MUST SHOW NOTHING. The shell is told, and answers without a
 * dialog whatever the system holds. A browser cannot be told: it decides for itself, so a tab is
 * read this way only when it has just said it is already allowed.
 */
export function readDevice(mayPrompt: boolean): Promise<DeviceReading> {
  return inShell() ? readThroughTheShell(mayPrompt) : readThroughTheBrowser();
}

/**
 * The read a person asked for by pressing: whatever the device gives, however vague, since they
 * are looking at it and decide whether to keep it. It may show the system's question. Rejects
 * with the surface's words.
 */
export async function readDeviceCoordinates(): Promise<Coordinates> {
  const reading = await readDevice(true);
  if (reading.coordinates) return reading.coordinates;
  throw new Error(wordsFor(reading.refusal));
}

function wordsFor(refusal: DeviceRefusal): string {
  switch (refusal) {
    case "denied":
      return t("Location was not allowed on this device.");
    case "unavailable":
      return t("This device did not say where it is.");
    case "unanswered":
      return t(
        "The question about this device's location has not been answered. If you do not see it, press again.",
      );
  }
}

/** Metres, as a device reports how far off a fix may be — or nothing where it reports none. */
function metres(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * The shell's answer, rounded again here although the shell already has: the rule is that nothing
 * holds a finer value, and a rule kept by one side only is kept until that side changes.
 */
async function readThroughTheShell(mayPrompt: boolean): Promise<DeviceReading> {
  const said = await shellDevicePlace({ prompt: mayPrompt });
  switch (said?.kind) {
    case "place": {
      const coordinates = coarseCoordinates(said);
      return coordinates
        ? { coordinates, accuracy: metres(said.accuracy) }
        : { coordinates: null, refusal: "unavailable" };
    }
    case "denied":
    case "restricted":
      return { coordinates: null, refusal: "denied" };
    case "unavailable":
    case "timeout":
      return { coordinates: null, refusal: "unavailable" };
    default:
      // Not answered within the minute, not to be asked, not read on this platform — or a shell
      // that said nothing this page knows. Nobody decided anything.
      return { coordinates: null, refusal: "unanswered" };
  }
}

function readThroughTheBrowser(): Promise<DeviceReading> {
  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coordinates = coarseCoordinates({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
          resolve(
            coordinates
              ? { coordinates, accuracy: metres(position.coords.accuracy) }
              : { coordinates: null, refusal: "unavailable" },
          );
        },
        (failure) =>
          resolve({
            coordinates: null,
            // A browser says "denied" for a no and for a prompt closed without one alike, and
            // every other failure comes only after a yes: its clock does not run while it asks.
            refusal:
              failure.code === failure.PERMISSION_DENIED
                ? "denied"
                : "unavailable",
          }),
        { enableHighAccuracy: false, maximumAge: 3_600_000, timeout: 10_000 },
      );
    } catch {
      // The browser would not even take the question: nobody was asked.
      resolve({ coordinates: null, refusal: "unanswered" });
    }
  });
}
