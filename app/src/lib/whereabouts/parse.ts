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
  return {
    timeZone: isUsableTimeZone(said.timeZone) ? said.timeZone : null,
    locale: canonicalLocale(said.locale),
    place,
    coordinates: coarseCoordinates(said.coordinates),
  };
}
