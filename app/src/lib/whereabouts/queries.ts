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
import { inShell } from "@/lib/notifications/shell";
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

/** Forget the place and the coordinates. The Bot asks again the next time it needs one. */
export async function clearPlace(
  queryClient: QueryClient,
): Promise<Whereabouts> {
  return wordsOf(await send("DELETE", undefined, queryClient));
}

/**
 * The same save, answered as a code rather than thrown in words — for the Bot's `remember`, whose
 * caller is a model reading `shared/prompt/tool-results.ko.ts`, not a person reading a toast.
 */
export function keepPlace(
  answer: { place: string | null; coordinates: Coordinates | null },
  queryClient: QueryClient,
): Promise<PlaceResult> {
  return send("PUT", answer, queryClient);
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

/**
 * Whether this surface can ask the device where it is.
 *
 * NOT IN THE DESKTOP SHELL. Its macOS webview (WKWebView, through wry) answers no geolocation
 * request: the bundle declares no location usage and the shell handles no permission for it, so
 * the browser's prompt never appears and the request fails — a button that asks and then says
 * nothing. Until the shell grants it, the person types the place, which works everywhere. A browser
 * tab can ask, and does only when the person presses.
 */
export function canAskDeviceLocation(): boolean {
  return (
    typeof navigator !== "undefined" && "geolocation" in navigator && !inShell()
  );
}

/**
 * Ask the device where it is, once, coarsely: low accuracy, a cached answer up to an hour old, and
 * the result rounded to two decimals before anything holds it. Rejects with the surface's words.
 */
export function readDeviceCoordinates(): Promise<Coordinates> {
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
