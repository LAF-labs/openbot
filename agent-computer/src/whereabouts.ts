/**
 * Where the person this browser works for is — read off the call, and what that means for Chromium.
 *
 * THE BROWSER RUNS ON A CLOUD VM, and a site reads the VM's clock, zone and address as its visitor's.
 * A Bot asked for today's weather read 네이버's guess of the VM's place (제주시) and told its owner
 * that was theirs (2026-09-24). So the server names the owner's zone and coarse coordinates on every
 * call, beside the Bot (`server/src/computer/client.ts`), and this browser follows them:
 *
 *   ZONE: `timezoneId`, which Playwright sets only when a context is created. A persistent context is
 *   created once per browser start, so a changed zone takes effect AT THE NEXT BROWSER START — at
 *   once when no Bot has a tab open (the browser is closed and the call that brought the change
 *   starts a new one), otherwise when the last tab closes or the browser has been idle for ten
 *   minutes (`profiles.ts`). Never by closing a browser a Bot is working in: a click lost to a zone
 *   change is a worse failure than a page drawn on the old clock for a few minutes.
 *
 *   PLACE: `geolocation` with the permission granted, which CAN change on a running context, so it
 *   does at once. A person with no coordinates gets no permission at all: a site asking is refused,
 *   exactly as a desktop Chrome refuses a site its owner never allowed, and never shown the VM's.
 *
 * NOTHING HERE IS LOGGED BUT THAT IT MOVED. The coordinates are the person's; an operator reading the
 * container's log learns that a place was followed, never which.
 */
import {
  type Coordinates,
  GEOLOCATION_HEADER,
  geolocationFromHeader,
  isUsableTimeZone,
  TIME_ZONE_HEADER,
} from "../../shared/whereabouts";

/** What one call said. `undefined` is "said nothing" — keep what was last followed. */
export type Whereabouts = {
  timeZone?: string;
  geolocation?: Coordinates | null;
};

/** The headers, checked. A zone Chromium would refuse at launch is dropped here, not at launch. */
export function whereaboutsOf(headers: Headers): Whereabouts {
  const zone = headers.get(TIME_ZONE_HEADER)?.trim();
  const geolocation = geolocationFromHeader(headers.get(GEOLOCATION_HEADER));
  return {
    ...(isUsableTimeZone(zone) ? { timeZone: zone } : {}),
    ...(geolocation !== undefined ? { geolocation } : {}),
  };
}

/** Whether two answers to "where" are the same place, null being nowhere. */
export function samePlace(
  a: Coordinates | null | undefined,
  b: Coordinates | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.latitude === b.latitude && a.longitude === b.longitude;
}
