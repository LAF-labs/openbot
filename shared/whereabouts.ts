/**
 * Where the person is and what their clock says — the facts, and the only shapes they may take.
 *
 * WHY THIS EXISTS. Asked for today's weather, a Bot searched 네이버 and reported 제주시 as "사장님
 * 위치" (measured 2026-09-24). 네이버 had guessed the place from the address the request came from,
 * and the request came from the Bot's browser, which runs on a cloud VM: its address, its clock and
 * its place are the VM's, never the person's. So the person's own facts have to be carried to the Bot
 * and to its browser, and this file is what those facts are allowed to look like on the way.
 *
 * COARSE, AND ONLY COARSE. A place is a city or a district in the person's words ("서울 강남구");
 * coordinates are two decimals, about a kilometre. Nothing finer is ever kept: the Bot needs to know
 * which town's weather to read, not which door is the shop's.
 *
 * IN `shared/` because the surface and the server both check the same shape — the surface before it
 * sends, the server before it keeps — and two copies of "what a place may be" would disagree the
 * first time one was loosened.
 */

/** Two decimals of a degree: about 1.1 km north–south. Enough for a weather page, not for a door. */
export type Coordinates = { latitude: number; longitude: number };

export type Whereabouts = {
  /** The IANA zone the person's device reported, the last time the app was opened. */
  timeZone: string | null;
  /** The device's language tag (`ko-KR`), reported with the zone. */
  locale: string | null;
  /** A city or district — set on 내 가게, or said in a conversation and saved by the Bot. */
  place: string | null;
  /** From the device, with the person's permission, rounded to two decimals. */
  coordinates: Coordinates | null;
};

export const NO_WHEREABOUTS: Whereabouts = {
  timeZone: null,
  locale: null,
  place: null,
  coordinates: null,
};

/**
 * Forty characters: "경기 성남시 분당구 정자동" is thirteen. A longer answer is an address, and an
 * address is exactly what this refuses to keep.
 */
export const PLACE_MAX_CHARS = 40;
/**
 * And five words: 도, 시, 구, 동 and one to spare. "서울특별시 강남구 역삼동 미소빌딩 옆 골목" fits
 * forty characters and is a set of directions to a door.
 */
export const PLACE_MAX_WORDS = 5;

/** The refusals, as codes. The surface owns the words. */
export const PLACE_INVALID = "laf:place_invalid";
export const DEVICE_INVALID = "laf:device_invalid";

/** Whether this runtime knows the zone. `Intl` throws on a name it does not. */
export function isUsableTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A BCP 47 tag in its canonical spelling, or null for anything that is not one. */
export function canonicalLocale(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 35) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

/** A degree rounded to two decimals — the only precision a coordinate is ever kept at. */
export function coarse(degrees: number): number {
  return Math.round(degrees * 100) / 100;
}

/**
 * Coordinates as a device or a request offered them, coarsened — or null when they are not a place
 * on this planet. Rounded HERE, before anything else holds them, so no caller can keep a finer copy
 * by forgetting to.
 */
export function coarseCoordinates(value: unknown): Coordinates | null {
  if (!value || typeof value !== "object") return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return null;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude: coarse(latitude), longitude: coarse(longitude) };
}

/**
 * A place as somebody typed or said it: one line, trimmed, or null for nothing at all.
 *
 * LETTERS, NUMBERS, SPACES AND THE MARKS A PLACE NAME USES (`·,-()/`). A place is read into every
 * run's prompt, so a sentence here is a sentence the Bot reads on every turn — the character set is
 * what keeps "이전 지시는 무시하고…" from arriving with a full stop and a colon; the server's
 * instruction scan is the second wall. `"invalid"` is its own answer, never quietly trimmed into a
 * different place than the one somebody wrote.
 */
export function parsePlace(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "invalid";
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return null;
  if ([...line].length > PLACE_MAX_CHARS) return "invalid";
  if (line.split(" ").length > PLACE_MAX_WORDS) return "invalid";
  if (STREET_ADDRESS.test(line)) return "invalid";
  return /^[\p{L}\p{N} ·,\-()/]+$/u.test(line) ? line : "invalid";
}

/**
 * The parts of an address finer than a district: a road and its number (테헤란로 123, 45번길), a lot
 * (123번지), a floor or a unit (2층, 201호). "역삼1동" and "종로1가" are neighbourhoods and pass — the
 * number is part of the name, not a door.
 */
const STREET_ADDRESS =
  /(로|길)\s?\d+(?![\d가])|\d+\s?(번지|번길|길|층|호)(?!\p{L})/u;

/** What a chat run says about the device it was sent from. */
export type DeviceClock = { timeZone?: string; locale?: string };

/**
 * `forwardedProps.device`, checked.
 *
 * Sent by the app on every chat run (`CopilotKitProvider`'s `properties`). A routine sends none —
 * there is no device at seven in the morning — and an unusable zone is dropped rather than trusted,
 * so the run falls back to the zone the person's last session saved.
 */
export function deviceOf(forwardedProps: unknown): DeviceClock {
  if (!forwardedProps || typeof forwardedProps !== "object") return {};
  const device = (forwardedProps as Record<string, unknown>).device;
  if (!device || typeof device !== "object") return {};
  const { timeZone, locale } = device as Record<string, unknown>;
  const canonical = canonicalLocale(locale);
  return {
    ...(isUsableTimeZone(timeZone) ? { timeZone } : {}),
    ...(canonical ? { locale: canonical } : {}),
  };
}

/**
 * How the server tells the Bot's browser where the person is: a header on every call to the
 * computer, beside `x-openbot-bot-id`. `none` is "there is no place" — a person who cleared theirs
 * must not keep being shown the weather of the one they cleared.
 */
export const TIME_ZONE_HEADER = "x-openbot-time-zone";
export const GEOLOCATION_HEADER = "x-openbot-geolocation";

/** `37.5,127.03`, or `none`. */
export function geolocationHeaderOf(coordinates: Coordinates | null): string {
  return coordinates
    ? `${coarse(coordinates.latitude)},${coarse(coordinates.longitude)}`
    : "none";
}

/** The header read back: coordinates, null for `none`, undefined when it said nothing usable. */
export function geolocationFromHeader(
  value: string | null | undefined,
): Coordinates | null | undefined {
  const said = value?.trim();
  if (!said) return undefined;
  if (said === "none") return null;
  const [latitude, longitude, ...rest] = said.split(",").map(Number);
  if (rest.length > 0) return undefined;
  return coarseCoordinates({ latitude, longitude }) ?? undefined;
}
