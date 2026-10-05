import {
  canonicalLocale,
  coarseCoordinates,
  isUsableTimeZone,
  NO_WHEREABOUTS,
  type Whereabouts,
} from "@shared/whereabouts";

/**
 * `/api/me`'s `whereabouts`, read forgivingly: anything unreadable is "nothing known".
 *
 * Its own file so `auth/queries.ts` can read it without importing the doors that write it, which
 * import the current user's cache key from there.
 */
export function parseWhereabouts(value: unknown): Whereabouts {
  if (!value || typeof value !== "object") return NO_WHEREABOUTS;
  const said = value as Record<string, unknown>;
  const place =
    typeof said.place === "string" && said.place.trim() ? said.place : null;
  const coordinates = coarseCoordinates(said.coordinates);
  // The server's name for where the coordinates fall. Only beside coordinates: a name with no
  // place under it would be drawn as one.
  const near =
    coordinates && typeof said.near === "string" && said.near.trim()
      ? said.near.trim()
      : null;
  return {
    timeZone: isUsableTimeZone(said.timeZone) ? said.timeZone : null,
    locale: canonicalLocale(said.locale),
    place,
    coordinates,
    ...(near ? { near } : {}),
  };
}
