/**
 * The shop questions' two tables, as the surface reads them, and the one question only the surface
 * can answer: which of the places can THIS deployment actually touch.
 *
 * The tables are in `shared/shop/catalogue.ts`, because the server refuses an answer outside them
 * and composes every Bot's context line from them. Every name there is an English key read through
 * `t()` on a variable, which `i18n-coverage.test.ts` cannot see — `app/tests/shop-copy.test.ts`
 * walks them instead.
 *
 * WHAT IS OFFERED IS DECIDED BY THE 연결 SCREEN'S OWN READ. A deployment with no browser has no
 * sites, and one whose fleet registered no Google application cannot finish a Google consent — the
 * overview already leaves both out (`server/src/plugins/overview-routes.ts`). A chip for a place the
 * product cannot touch on this machine is a promise nothing keeps, so a place is offered only when
 * one of its doors is in that read.
 */
import {
  BUSINESS_KINDS,
  type BusinessKindId,
  DAILY_PLACES,
  type DailyPlace,
  EMPTY_SHOP,
  type PlaceConnection,
  type ShopProfile,
  shopFrom,
} from "@shared/shop/catalogue";
import type { ConnectionsOverview } from "@/lib/connections/queries";

export {
  BUSINESS_KINDS,
  type BusinessKind,
  type BusinessKindId,
  DAILY_PLACES,
  type DailyPlace,
  dailyPlaceById,
  EMPTY_SHOP,
  type ShopProfile,
} from "@shared/shop/catalogue";

type Overview = Pick<ConnectionsOverview, "sites" | "accounts">;

/**
 * What `/api/me` said, read forgivingly: a missing or malformed answer is no answer.
 *
 * Here rather than beside the save, because the current-user query reads it and the save writes the
 * current user — one module importing the other both ways would be a cycle.
 */
export function parseShop(value: unknown): ShopProfile {
  if (!value || typeof value !== "object") return EMPTY_SHOP;
  const { kind, places } = value as { kind?: unknown; places?: unknown };
  return shopFrom(kind, places);
}

/** Whether two answers are the same answer — the same kind and the same places in the same order. */
export function sameShop(a: ShopProfile, b: ShopProfile): boolean {
  return (
    a.kind === b.kind &&
    a.places.length === b.places.length &&
    a.places.every((place, index) => b.places[index] === place)
  );
}

/** How many places are drawn before 더 보기: one short block, the likeliest for this kind first. */
export const PLACES_SHOWN_FIRST = 8;

/** Every place, this kind's likeliest first and the rest in the catalogue's own order. */
export function placesInOrder(kind: BusinessKindId | null): DailyPlace[] {
  const leading = BUSINESS_KINDS.find((entry) => entry.id === kind)?.places;
  if (!leading?.length) return [...DAILY_PLACES];
  const first = leading
    .map((id) => DAILY_PLACES.find((place) => place.id === id))
    .filter((place): place is DailyPlace => place !== undefined);
  return [
    ...first,
    ...DAILY_PLACES.filter((place) => !leading.includes(place.id)),
  ];
}

/** Whether this deployment's overview has the door at all — connected or not. */
function doorExists(door: PlaceConnection, overview: Overview): boolean {
  return door.kind === "site"
    ? overview.sites.some((site) => site.id === door.id)
    : overview.accounts.some((account) => account.id === door.id);
}

/** Whether a door is open: signed in on the Bot's browser, or an account that still works. */
function doorConnected(door: PlaceConnection, overview: Overview): boolean {
  if (door.kind === "site") {
    return overview.sites.some(
      (site) => site.id === door.id && site.status === "connected",
    );
  }
  return overview.accounts.some(
    (account) => account.id === door.id && account.status === "connected",
  );
}

/** Whether a Bot on this deployment could reach the place by any of its doors. */
export function placeIsOffered(place: DailyPlace, overview: Overview): boolean {
  return place.connections.some((door) => doorExists(door, overview));
}

/** Whether a Bot can use the place right now, by any door. */
export function placeIsConnected(
  place: DailyPlace,
  overview: Overview,
): boolean {
  return place.connections.some((door) => doorConnected(door, overview));
}

/**
 * The places to draw, in the order to draw them.
 *
 * Offered ones only — and every place already picked, even one this deployment can no longer
 * reach, so a person can see what their Bots are being told and take it back.
 */
export function placesToOffer(
  overview: Overview,
  kind: BusinessKindId | null,
  picked: readonly string[] = [],
): DailyPlace[] {
  return placesInOrder(kind).filter(
    (place) => picked.includes(place.id) || placeIsOffered(place, overview),
  );
}
