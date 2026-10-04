/**
 * What the Bot's browser tells a page about itself: the size of its window, its language, its
 * clock and its name. The launch (`browser-launch.ts`) starts the browser on these, and
 * `profiles.ts` corrects the version from the first browser that actually starts.
 */
import { log } from "./log";

/** The viewport, which is what a person's click coordinates are relative to. */
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * The Bot lives in Korea.
 *
 * Measured before this line existed, inside the shipping image: `navigator.language` was
 * `en-US@posix` and `Intl.DateTimeFormat().resolvedOptions().timeZone` was `UTC`. A Korean site
 * reads both — 네이버 and 홈택스 render dates and some of their navigation from them — so the Bot
 * was browsing a foreign-language, wrong-day version of every page its owner reads in Korean.
 */
export const LOCALE = "ko-KR";

/** Where the Bot's clock is, defaulting to Seoul the way the server's own does. */
export function botTimeZone(
  environment: Record<string, string | undefined> = process.env,
): string {
  const wanted = environment.BOT_TIME_ZONE?.trim();
  if (!wanted) return "Asia/Seoul";
  try {
    // A name Chromium would refuse takes the browser down at launch, which would make one typo in a
    // deployment's environment the reason no Bot has a computer. Validated here and ignored if bad,
    // the same decision `botTimeZone` in the server makes for the same variable.
    new Intl.DateTimeFormat("en-US", { timeZone: wanted });
    return wanted;
  } catch {
    log.warn("bot_time_zone_unusable", { value: wanted, using: "Asia/Seoul" });
    return "Asia/Seoul";
  }
}

/**
 * The Chromium this image ships, as the user agent has to spell it.
 *
 * Pinned rather than read from `playwright-core/browsers.json`: that file is not reachable through
 * the package's `exports`, and inside the image `playwright-core` does not resolve from this file at
 * all (measured). The Dockerfile already pins the Playwright version and the base image together
 * — "bump both or neither" — and this is the third thing in that set. It is also self-correcting:
 * the first launch compares this against what the browser actually reports and takes the browser's
 * answer for every launch after it.
 */
export const PINNED_CHROMIUM_VERSION = "151.0.7922.34";

/**
 * What the page sees us as: the string the browser would send, without the word that says nobody is
 * looking.
 *
 * Playwright's headless Chromium reports `HeadlessChrome/151.0.0.0`. That word is the single
 * cheapest automation signal a site can read, and the sites this product exists for answer it:
 * measured 2026-10-04 from a browser saying it, G마켓 answered 403, 11번가 an empty page, 배민
 * 사장님 368 characters of a page a browser gets 2,300 of, 쿠팡 403 — and all four opened once the
 * word was gone (`~/laf/docs/bot-browser-choice-2026-10-04.md` §4).
 *
 * THE VERSION IS THE MAJOR AND ZEROS, AS CHROME ITSELF WRITES IT. The build number was written out
 * in full here (`Chrome/151.0.7922.34`) from 2026-09-03 to 2026-10-04, and no Chrome has sent a full
 * build in its user agent for years — it lives in the client hints, where the browser still puts it.
 * Measured the day this changed: 쿠팡's seller centre refused a real, headed Chrome carrying the full
 * number three times of three and opened three of three with the zeros; a headless shell saying
 * either was refused, which is a different fact about a different thing. A string no browser sends
 * is a mark of its own.
 *
 * WHAT THIS DOES NOT DO. The `Sec-Ch-Ua` header on every request and `navigator.userAgentData`
 * still carry `"HeadlessChrome";v="151"` from the headless shell — Playwright's override reaches
 * the string, not the brand list — so the page is told twice more what this string no longer says,
 * and `docs/laf/browser-limits.md` says so. The one cure is the browser that does not say it: the
 * full Chromium, headed or in the new headless mode, which is the measured recommendation of that
 * document and is not taken here.
 *
 * Linux is kept, and deliberately: claiming Windows here would disagree with `navigator.platform`,
 * the client hints Chromium sends alongside, and the fonts the container has. A quiet, consistent
 * Linux Chrome is a better answer than a loud, contradictory Windows one. (The client hints read
 * `x86 64` from this string on an ARM machine; the string says so too, and is left consistent with
 * itself until the browser changes.)
 */
export function botUserAgent(version: string): string {
  const major = version.split(".")[0] ?? version;
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
