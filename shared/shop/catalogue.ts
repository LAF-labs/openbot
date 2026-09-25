/**
 * What kind of business a person runs, and the places they work in every day.
 *
 * Two questions the first run asks between the agreement and the first Bot, each skippable, and
 * both answered by pressing rather than typing. The answers belong to the person — one account per
 * deployment, so to the deployment — and every Bot reads them before every run
 * (`shared/prompt/shop.ko.ts`). Nothing but the person, through Settings and the first run, ever
 * writes them: no tool a Bot holds reaches them.
 *
 * IT IS DATA, AND ONLY DATA, like the site catalogue beside it. Every name here is an English key
 * with its Korean in `app/src/lib/i18n-ko.ts`; the Korean the Bot reads is in
 * `shared/prompt/shop.ko.ts`, and `app/tests/shop-copy.test.ts` holds the two to the same words, so
 * a Bot and the person it works for call a place by one name.
 *
 * IT LIVES IN `shared/` BECAUSE BOTH SIDES NEED THE SAME TABLE. The server refuses an answer that
 * names anything not in it and composes the Bot's context line from it; the surface draws the
 * choices from it. Two copies would disagree the first time a place was added.
 */
import type { SiteCategory } from "../sites/catalogue";

/**
 * EIGHT KINDS, AND WHY THESE.
 *
 * The question exists for two readers: the suggestions a new Bot is shown, and the one line every
 * Bot is told. So a kind earns its place when it changes one of them — when the places its owner
 * signs into every morning, or the work that fills the day, differ from every other kind's.
 *
 *  - 음식점·카페 — the delivery apps, table bookings and reviews: the biggest block of the site
 *    catalogue, and settlement work every morning.
 *  - 온라인 판매 — 스마트스토어, 쿠팡 윙, 카페24: orders, stock and customer questions.
 *  - 매장 판매 — the shop that sells over its own counter (clothes, flowers, groceries). Retail is
 *    the commonest small business there is, and without its own answer it would have nowhere to
 *    go but 그 밖에, which tells a Bot nothing.
 *  - 미용·뷰티 — bookings first, then reviews and Instagram.
 *  - 학원·교육 — parents' messages, notices and schedules: KakaoTalk and 알림톡.
 *  - 병원·약국 — bookings, reviews and notices. The product reaches none of the clinical systems,
 *    and the kind is still worth saying: a Bot writing for a clinic should know it is one.
 *  - 사무·전문직 — mail, calendar, documents and Hometax: the Google and Notion connections.
 *  - 그 밖에 — an answer, not a skip: the person told us none of these fits. Stored as such, and a
 *    Bot is told nothing about a kind rather than something wrong.
 *
 * NOT HERE, ON PURPOSE. 숙박 (펜션·게스트하우스): the catalogue signs into no lodging platform, so
 * the answer would move no suggestion and offer no place — it is 그 밖에 until one exists. 제조·도매
 * works in the same places 사무·전문직 does. More chips would make the first question a list to
 * read, which is the opposite of one press.
 *
 * `places` is the order this kind's owner is shown the places in, most likely first — a leading
 * list, not a filter: every place stays on offer, the rest after these in catalogue order.
 */
export type BusinessKindId =
  | "food"
  | "online"
  | "store"
  | "beauty"
  | "education"
  | "health"
  | "office"
  | "other";

export type BusinessKind = {
  id: BusinessKindId;
  /** English key. Korean in `i18n-ko.ts`. */
  name: string;
  /** Place ids, most likely first. Every one must be in {@link DAILY_PLACES}. */
  places: readonly string[];
};

export const BUSINESS_KINDS: readonly BusinessKind[] = [
  {
    id: "food",
    name: "Restaurant or café",
    places: [
      "baemin-ceo",
      "coupangeats-store",
      "yogiyo-ceo",
      "naver-smartplace",
      "catchtable-ceo",
      "naver-booking-talk",
      "instagram",
      "kakao-channel",
    ],
  },
  {
    id: "online",
    name: "Selling online",
    places: [
      "naver-smartstore",
      "coupang-wing",
      "cafe24",
      "instagram",
      "kakao-channel",
      "kakao-alimtalk",
      "naver-searchad",
      "tosspayments",
    ],
  },
  {
    id: "store",
    name: "Selling in a shop",
    places: [
      "naver-smartplace",
      "daangn-business",
      "instagram",
      "kakao-channel",
      "naver-smartstore",
      "tosspayments",
      "hometax",
      "google-sheets",
    ],
  },
  {
    id: "beauty",
    name: "Hair and beauty",
    places: [
      "naver-booking-talk",
      "naver-smartplace",
      "instagram",
      "kakao-channel",
      "kakao-alimtalk",
      "daangn-business",
      "google-calendar",
      "hometax",
    ],
  },
  {
    id: "education",
    name: "Academy or tutoring",
    places: [
      "kakao-channel",
      "kakao-alimtalk",
      "naver-smartplace",
      "naver-booking-talk",
      "google-calendar",
      "google-sheets",
      "instagram",
      "gmail",
    ],
  },
  {
    id: "health",
    name: "Clinic or pharmacy",
    places: [
      "naver-booking-talk",
      "naver-smartplace",
      "kakao-channel",
      "kakao-alimtalk",
      "google-business-profile",
      "instagram",
      "hometax",
      "google-calendar",
    ],
  },
  {
    id: "office",
    name: "Office or professional services",
    places: [
      "gmail",
      "google-calendar",
      "google-drive",
      "google-sheets",
      "notion",
      "hometax",
      "kakao-channel",
      "naver-smartplace",
    ],
  },
  { id: "other", name: "Something else", places: [] },
];

/**
 * How a Bot reaches a place: a site it signs into on its browser, or an account connected on 연결.
 *
 * `id` is the site catalogue's id (`shared/sites/catalogue.ts`) or the plugin catalogue's key
 * (`server/src/plugins/catalogue.ts`, the partner entry included). `server/tests/shop-catalogue.test.ts`
 * holds every one of them to a row that exists, so a place is never offered that nothing can touch.
 */
export type PlaceConnection = { kind: "site" | "account"; id: string };

export type DailyPlace = {
  id: string;
  /**
   * English key, and short on purpose: what an owner calls the place ("배달의민족"), not the name
   * of its admin console ("배달의민족 사장님"), which is what the 연결 row says.
   */
  name: string;
  /**
   * Every door to the place, the one to connect first. Cafe24 has two — the OAuth app and the
   * admin site — and is one place to the person whichever the Bot comes in by.
   */
  connections: readonly PlaceConnection[];
  /**
   * The kind of work the place mostly is, in the eight patterns the suggestions are ordered by. For
   * a site it is the site catalogue's own `category`, and a test says so.
   */
  pattern: SiteCategory;
};

/** Twenty-two places, grouped by whose they are so the list reads as families, not as a heap. */
export const DAILY_PLACES: readonly DailyPlace[] = [
  {
    id: "naver-smartplace",
    name: "Naver Smart Place",
    connections: [{ kind: "site", id: "naver-smartplace" }],
    pattern: "reputation",
  },
  {
    id: "naver-smartstore",
    name: "Naver Smart Store",
    connections: [{ kind: "site", id: "naver-smartstore" }],
    pattern: "enquiries",
  },
  {
    id: "naver-booking-talk",
    name: "Naver Booking and Talk",
    connections: [{ kind: "site", id: "naver-booking-talk" }],
    pattern: "schedule",
  },
  {
    id: "naver-searchad",
    name: "Naver Search Ads",
    connections: [{ kind: "site", id: "naver-searchad" }],
    pattern: "settlement",
  },
  {
    id: "baemin-ceo",
    name: "Baemin",
    connections: [{ kind: "site", id: "baemin-ceo" }],
    pattern: "settlement",
  },
  {
    id: "coupangeats-store",
    name: "Coupang Eats",
    connections: [{ kind: "site", id: "coupangeats-store" }],
    pattern: "night-watch",
  },
  {
    id: "yogiyo-ceo",
    name: "Yogiyo",
    connections: [{ kind: "site", id: "yogiyo-ceo" }],
    pattern: "reputation",
  },
  {
    id: "coupang-wing",
    name: "Coupang Wing",
    connections: [{ kind: "site", id: "coupang-wing" }],
    pattern: "stock",
  },
  {
    id: "catchtable-ceo",
    name: "CatchTable",
    connections: [{ kind: "site", id: "catchtable-ceo" }],
    pattern: "schedule",
  },
  {
    id: "kakao-channel",
    name: "KakaoTalk Channel",
    connections: [{ kind: "site", id: "kakao-channel" }],
    pattern: "enquiries",
  },
  {
    id: "kakao-alimtalk",
    name: "KakaoTalk notifications",
    connections: [{ kind: "account", id: "kakao-alimtalk" }],
    pattern: "schedule",
  },
  {
    id: "instagram",
    name: "Instagram",
    connections: [{ kind: "site", id: "instagram" }],
    pattern: "reputation",
  },
  {
    id: "daangn-business",
    name: "Daangn Business",
    connections: [{ kind: "site", id: "daangn-business" }],
    pattern: "reputation",
  },
  {
    id: "cafe24",
    name: "Cafe24",
    connections: [
      { kind: "account", id: "cafe24" },
      { kind: "site", id: "cafe24-admin" },
    ],
    pattern: "enquiries",
  },
  {
    id: "tosspayments",
    name: "Toss Payments",
    connections: [{ kind: "site", id: "tosspayments" }],
    pattern: "settlement",
  },
  {
    id: "hometax",
    name: "Hometax",
    connections: [{ kind: "site", id: "hometax" }],
    pattern: "paperwork",
  },
  {
    id: "gmail",
    name: "Gmail",
    connections: [{ kind: "account", id: "gmail" }],
    pattern: "enquiries",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    connections: [{ kind: "account", id: "google-calendar" }],
    pattern: "schedule",
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    connections: [{ kind: "account", id: "google-sheets" }],
    pattern: "settlement",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    connections: [{ kind: "account", id: "google-drive" }],
    pattern: "paperwork",
  },
  {
    id: "google-business-profile",
    name: "Google Business Profile",
    connections: [{ kind: "account", id: "google-business-profile" }],
    pattern: "reputation",
  },
  {
    id: "notion",
    name: "Notion",
    connections: [{ kind: "account", id: "notion" }],
    pattern: "paperwork",
  },
];

/** One place by id, or null for an id that is not in the table. */
export function dailyPlaceById(id: string): DailyPlace | null {
  return DAILY_PLACES.find((place) => place.id === id) ?? null;
}

/**
 * The two answers, as a person gave them.
 *
 * `kind` null is "not answered" — skipped, or never asked because the account is older than the
 * question. `places` keeps the order they were picked in: the first is the one a person reached for
 * first, and it is the one the first-task row offers to connect.
 */
export type ShopProfile = {
  kind: BusinessKindId | null;
  places: readonly string[];
};

export const EMPTY_SHOP: ShopProfile = { kind: null, places: [] };

/** The refusal a malformed answer gets. A code: the surface owns the words. */
export const SHOP_INVALID = "laf:shop_invalid";

const KIND_IDS = new Set<string>(BUSINESS_KINDS.map((kind) => kind.id));
const PLACE_IDS = new Set<string>(DAILY_PLACES.map((place) => place.id));

const isKindId = (value: unknown): value is BusinessKindId =>
  typeof value === "string" && KIND_IDS.has(value);

/** Known ids only, first occurrence kept, in the order given. */
function knownPlaces(values: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !PLACE_IDS.has(value)) continue;
    if (!kept.includes(value)) kept.push(value);
  }
  return kept;
}

/**
 * An answer as a request carries it, or a refusal.
 *
 * STRICT, because this is the door the person writes through: a kind or a place that is not in the
 * table is a client that has drifted from the catalogue, and saying so is better than keeping half
 * of what it meant. Both fields are required — the answer replaces the stored one whole, so an
 * absent field would be a question about which half was meant. A place named twice is kept once.
 */
export function parseShopAnswer(
  body: unknown,
): { ok: true; value: ShopProfile } | { ok: false; code: string } {
  const refused = { ok: false, code: SHOP_INVALID } as const;
  if (!body || typeof body !== "object" || Array.isArray(body)) return refused;
  const input = body as Record<string, unknown>;
  if (!("kind" in input) || !("places" in input)) return refused;

  const kind = input.kind;
  if (kind !== null && !isKindId(kind)) return refused;

  const places = input.places;
  if (!Array.isArray(places)) return refused;
  if (
    places.some((place) => typeof place !== "string" || !PLACE_IDS.has(place))
  ) {
    return refused;
  }
  return { ok: true, value: { kind, places: knownPlaces(places) } };
}

/**
 * The stored answer, read back tolerantly.
 *
 * FORGIVING, the other way round from the parser, because this reads what a row already holds: a
 * place removed from the catalogue since somebody picked it is dropped here rather than failing the
 * read that every run of every Bot makes.
 */
export function shopFrom(kind: unknown, places: unknown): ShopProfile {
  return {
    kind: isKindId(kind) ? kind : null,
    places: Array.isArray(places) ? knownPlaces(places) : [],
  };
}
