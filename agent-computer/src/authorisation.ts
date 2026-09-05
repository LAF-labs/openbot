/**
 * Who may speak to a computer at all.
 *
 * This check is the boundary in front of the browser process. Policy, audit and sign-in live in the
 * API server and are not on the direct computer port.
 *
 * It lives here rather than in `index.ts` because that file imports Playwright at module scope, so
 * anything in it needs Chrome merely to be imported by a test. The same reasoning moved the control
 * state machine out: if a decision matters, it does not belong next to `chromium.launch()`.
 */

/**
 * Does this secret match?
 *
 * Constant-time comparison prevents prefix timing leaks. Length still leaks, but not token content.
 */
export function matchesToken(expected: string, offered: string): boolean {
  if (expected.length === 0) return false;
  if (offered.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < offered.length; index += 1) {
    difference |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The secret a caller offered, however it could carry it.
 *
 * WebSocket clients cannot set upgrade headers, so the stream also accepts the token as a query
 * parameter.
 */
export function offeredToken(headers: Headers, url: URL): string {
  if (url.pathname === "/stream") return url.searchParams.get("token") ?? "";
  const header = headers.get("x-openbot-computer-token")?.trim();
  if (header) return header;
  const authorization = headers.get("authorization")?.trim() ?? "";
  return authorization.replace(/^Bearer /i, "");
}

/**
 * The Bot a caller named, and whether this process will treat it as a name at all.
 *
 * THE ID BECOMES A DIRECTORY. `x-openbot-bot-id` is joined onto `PROFILES_DIR` — the profile Chrome
 * launches from, the `control.json` written on every handover, and the tree `/computers/reset`
 * hands to `rm -rf`. Nothing ever looked at the string, and the server's routes did not either:
 * Hono decodes `%2F` in a path parameter, so `POST /api/computers/..%2F..%2Ftmp%2Fx/control/take`
 * arrived here as `../../tmp/x` and `join("/profiles", that)` is `/tmp/x`. Measured: taking control
 * wrote a file there, as root, in the container that holds every login this customer has.
 *
 * The server refuses this too, in `server/src/computer/bot-id.ts`, and the two checks are
 * deliberately duplicated rather than shared: this image copies `agent-computer/src` and nothing
 * else, and a container that drives a browser full of real logins is not a place to trust that
 * somebody upstream looked. The two patterns are the same by construction — ASCII, starting with a
 * letter or a digit, then letters, digits, `_` and `-`, and nothing that can mean "somewhere else":
 * no separator, no dot, no `%`, no whitespace.
 *
 * Here rather than in `index.ts` for the reason at the top of this file: `index.ts` imports
 * Playwright at module scope, so a decision that lives in it cannot be tested without Chrome.
 */
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A fact code, like every other refusal this container ships. The words are the surface's. */
export const BOT_ID_INVALID = "laf:bot_id_invalid";

export function isBotId(value: unknown): value is string {
  return typeof value === "string" && BOT_ID.test(value);
}

/**
 * Health is the one thing an unauthenticated caller may ask.
 *
 * An orchestrator has to be able to check whether this process is up without holding a secret, and
 * the answer names no Bot, touches no browser and reveals nothing about what is running.
 */
export function isOpenPath(pathname: string): boolean {
  return pathname === "/health";
}
