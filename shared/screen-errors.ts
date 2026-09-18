/**
 * A PART OF THE SCREEN THAT FAILED, AS THE APP TELLS ITS OWN SERVER.
 *
 * Until 2026-09-18 a render error anywhere outside a tool card took the whole window down to the
 * router's error screen, and nobody learned that it had: the server's log and the 문의·의견 box's
 * diagnostic details only knew what the server had seen. The app now catches a failure section by
 * section (`app/src/components/layout/section-boundary.tsx`), and reports it — and an error nothing
 * on screen caught — to `POST /api/support/screen-errors` on the deployment that served it, and to
 * nowhere else. The server writes one log line per report (`server/src/support/screen-errors.ts`),
 * and the diagnostic details can carry that line back to the operator.
 *
 * CLOSED FACTS, AND ONLY THESE. Which part of the screen, from the list below. Which route, as its
 * template from the list below — `/channel/$channelId`, never the address with the id in it or its
 * query. What kind of error, as the name of its constructor. A fingerprint: a digest of where it was
 * thrown, so two reports of one failure can be told from two failures. The build the page knows it
 * is running, and whether it is running in the desktop app or a browser.
 *
 * NEVER THE MESSAGE. An error's message is written by whatever threw, and it quotes what it was
 * handed: a URL that would not parse is quoted whole, query and all; JSON that would not parse is
 * quoted from the character that broke it; a site's refusal is the site's sentence about whatever
 * somebody typed. Nothing on either side reads it into a report, and the server refuses a report
 * with any field this file does not name — so a client that grew a `message` is turned away at the
 * door rather than trusted to have scrubbed it.
 *
 * Both sides read this file. The app builds a report out of these shapes and leaves out an optional
 * fact that does not fit; the server refuses the whole report when anything does not fit.
 */

/**
 * Every part of the screen a report can name.
 *
 * The first eleven are the seams a section boundary sits on, and the diagnostics preview's
 * `sectionName` says each one in the person's words. The last three are not sections:
 * `route_screen` is the router's own error screen, reached by whatever no section caught;
 * `window_error` is an error thrown outside React's drawing — an event handler, a timer;
 * `unhandled_rejection` is a promise nobody awaited.
 */
export const SCREEN_SECTIONS = [
  "sidebar",
  "main",
  "conversation",
  "transcript",
  "detail",
  "computer",
  "live_screen",
  "settings_page",
  "admin_page",
  "notices",
  "connection_check",
  "route_screen",
  "window_error",
  "unhandled_rejection",
] as const;

export type ScreenSection = (typeof SCREEN_SECTIONS)[number];

/**
 * Every route the app has, as the template the router names it by (its `fullPath`).
 *
 * A LIST, NOT A SHAPE. A template and an address are the same characters — `/channel/new` is a
 * template and `/channel/0f9c2d4e-…` is an address with an id in it — so no pattern can tell them
 * apart, and a pattern loose enough for every template lets every id through. The list is checked
 * against the generated route tree in both directions by `app/tests/screen-routes.test.ts`, which
 * the typecheck enforces as well: a route added without a line here fails the gate.
 */
export const SCREEN_ROUTES = [
  "/",
  "/admin",
  "/admin/",
  "/admin/audit",
  "/admin/bots",
  "/admin/boundaries",
  "/admin/components",
  "/admin/computers",
  "/admin/credentials",
  "/admin/playground",
  "/admin/plugins",
  "/agents/",
  "/approve/$approvalId",
  "/channel/$channelId",
  "/channel/new",
  "/consent",
  "/help",
  "/legal/privacy",
  "/legal/terms",
  "/no-access",
  "/privacy",
  "/routines",
  "/settings",
  "/settings/",
  "/settings/account",
  "/settings/connected-accounts",
  "/settings/shop",
  "/sign",
  "/skills",
  "/terms",
  "/unreachable",
  "/welcome",
] as const;

export type ScreenRoute = (typeof SCREEN_ROUTES)[number];

export const SCREEN_SURFACES = ["shell", "browser"] as const;

export type ScreenSurface = (typeof SCREEN_SURFACES)[number];

/**
 * The name of an error's constructor, or what a thrown thing that is not an object is.
 *
 * NARROWER THAN AN IDENTIFIER ON PURPOSE. Any single word is an identifier, and so is a password
 * like `Hunter2`; a constructor's name ends in `Error` or `Exception` (`TypeError`, `DOMException`,
 * `AbortError`), and the rest are the words `typeof` says. A class whose name a minifier shortened
 * is reported by the nearest ancestor whose name still fits — `Error`, at worst.
 */
export const ERROR_KIND =
  /^(?:(?:[A-Z][A-Za-z0-9]{0,48})?(?:Error|Exception)|Object|string|number|boolean|bigint|symbol|function|undefined|null)$/;

/** Twelve hex digits: a digest, which cannot hold a word. */
export const FINGERPRINT = /^[0-9a-f]{12}$/;

/**
 * A build, as `GET /api/version` names one: a release tag, or one of the three channel words.
 *
 * Closed rather than "a short token", because a short token is also a password. A deployment pulled
 * under a tag of its own has a build no report can carry; the app then leaves the fact out.
 */
export const BUILD_VERSION =
  /^(?:v\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?|edge|stable|source)$/;

/** A commit, in hex. */
export const BUILD_REVISION = /^[0-9a-f]{7,40}$/;

/** The largest body a report can honestly be, with room to spare. The server refuses anything past it. */
export const SCREEN_ERROR_MAX_BYTES = 2_048;

export type ScreenErrorReport = {
  section: ScreenSection;
  route?: ScreenRoute;
  kind: string;
  fingerprint: string;
  build?: string;
  revision?: string;
  surface: ScreenSurface;
};

const sections: ReadonlySet<string> = new Set(SCREEN_SECTIONS);
const routes: ReadonlySet<string> = new Set(SCREEN_ROUTES);
const surfaces: ReadonlySet<string> = new Set(SCREEN_SURFACES);

export const isScreenSection = (value: unknown): value is ScreenSection =>
  typeof value === "string" && sections.has(value);

export const isScreenRoute = (value: unknown): value is ScreenRoute =>
  typeof value === "string" && routes.has(value);

const fits = (shape: RegExp, value: unknown): value is string =>
  typeof value === "string" && shape.test(value);

/** Each fact, and what it has to be. The one table both readers below go through. */
const FACTS: Record<
  keyof ScreenErrorReport,
  { required: boolean; fits: (value: unknown) => boolean }
> = {
  section: { required: true, fits: isScreenSection },
  route: { required: false, fits: isScreenRoute },
  kind: { required: true, fits: (value) => fits(ERROR_KIND, value) },
  fingerprint: { required: true, fits: (value) => fits(FINGERPRINT, value) },
  build: { required: false, fits: (value) => fits(BUILD_VERSION, value) },
  revision: { required: false, fits: (value) => fits(BUILD_REVISION, value) },
  surface: {
    required: true,
    fits: (value) => typeof value === "string" && surfaces.has(value),
  },
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * A report as the wire carried it, or null when ANY of it does not fit.
 *
 * Whole or nothing: a key this file does not name, a required fact missing, an optional one present
 * and wrong. A report with one bad field is a client that is not the one this file describes, and
 * the other fields are then not facts anybody can vouch for either.
 */
export function readScreenErrorReport(body: unknown): ScreenErrorReport | null {
  if (!isPlainObject(body)) return null;
  for (const [key, value] of Object.entries(body)) {
    // Own keys only: `constructor` and `__proto__` are keys of every object, and facts of none.
    if (!Object.hasOwn(FACTS, key)) return null;
    if (!FACTS[key as keyof ScreenErrorReport].fits(value)) return null;
  }
  for (const [key, fact] of Object.entries(FACTS)) {
    if (fact.required && !Object.hasOwn(body, key)) return null;
  }
  return body as ScreenErrorReport;
}

/**
 * The facts of a report that still fit, from a log line read back later — and nothing else of it.
 *
 * For the diagnostic details, which read lines this server wrote at some other time and judge them
 * by the rules in force the day they leave (`shared/log.ts`, `readLogLine`). A line is facts about
 * one report, so a fact that no longer fits is dropped by itself and the rest still stand.
 */
export function screenErrorFacts(
  fields: Record<string, unknown>,
): Partial<ScreenErrorReport> {
  const out: Record<string, unknown> = {};
  for (const [key, fact] of Object.entries(FACTS)) {
    if (Object.hasOwn(fields, key) && fact.fits(fields[key])) {
      out[key] = fields[key];
    }
  }
  return out as Partial<ScreenErrorReport>;
}
