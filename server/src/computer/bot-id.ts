/**
 * The one shape a Bot id may have on its way to a computer.
 *
 * A Bot id names a directory on the computer — its Chromium profile, its `control.json` — and it
 * arrived there from the URL, decoded, with nothing between them but an emptiness check. Hono
 * decodes `%2F`, so `/api/computers/..%2F..%2Fetc/status` reached `agent-computer` as
 * `x-openbot-bot-id: ../../etc`, and `join("/profiles", "../../etc")` is `/etc`. Measured: a
 * traversal id wrote `control.json` into `/tmp` of the running container, as root. `computers/reset`
 * would have `rm -rf`'d whatever the id pointed at.
 *
 * Every id this deployment mints is `agent_<uuid>`; the four the package once shipped were
 * kebab-case words. Letters, digits, `_` and `-`, nothing that a path or a header could read as
 * structure: no `/` or `\` (a path), no `.` (`..`, and dotfiles like `.ssh`), no `%` (a second round
 * of decoding somewhere downstream), no whitespace or control characters (a header value that
 * splits), and nothing outside ASCII (two spellings of one directory name once a filesystem
 * normalises them). The computer checks the same shape on its own side
 * (`agent-computer/src/authorisation.ts`), because that process must not depend on this one having
 * looked — each of them was once the only one checking, and that is exactly how the pair of silent
 * fallbacks got in.
 *
 * A FACT CODE, NOT A SENTENCE. Nobody reading this is a person: the surface never builds an address
 * out of anything but an id it was given, so a refusal here means a caller is wrong, and it says so
 * in the same shape as every other refusal that crosses this boundary.
 */
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const BOT_ID_INVALID = "laf:bot_id_invalid";

export function isBotId(value: unknown): value is string {
  return typeof value === "string" && BOT_ID.test(value);
}

/**
 * A call that named a Bot no filesystem should be asked about, refused before it left this process.
 *
 * Its own type so the route in front of it can answer 400 rather than 500. It should never be
 * thrown: the routes check first, and this is what catches the route somebody adds later.
 */
export class BotIdRefusedError extends Error {
  constructor() {
    super(BOT_ID_INVALID);
    this.name = "BotIdRefusedError";
  }
}

/**
 * WHICH BROWSER OF THE BOT'S COMPUTER (2026-10-10, `docs/laf/redesign-2026-10.md` §5, piece 5-3).
 *
 * The computer holds a main browser and a few background ones, each named by whoever opened it
 * (`agent-computer/src/browsers.ts`). The name rides in a header beside the Bot's id, so it is held
 * to the same rule for the same reason: it is a name on the far side, and never a path. The same
 * shape as the computer checks, a dot allowed.
 */
const BROWSER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isBrowserName(value: unknown): value is string {
  return typeof value === "string" && BROWSER_NAME.test(value);
}

/**
 * A COMPUTER'S ID IS THE BOT, OR THE BOT AND A BROWSER.
 *
 * The gateway has always been handed two ids — which computer, and whose Bot — and until
 * background browsers they were one value said twice. They still are for the main browser: its id
 * is the Bot's, so every row, cache and question from before reads as it did. A background
 * browser's is the Bot's id, an `@`, and the browser's name. What the gateway keeps per computer —
 * the last page it saw, the refs on it, what was typed where, a question about an element — is
 * kept per browser by that alone, and a ref from one browser's page names nothing in another's.
 *
 * `@` because neither a Bot's id nor a browser's name can hold one, so the two halves come apart
 * one way.
 */
export function computerIdOf(botId: string, browser?: string | null): string {
  return browser ? `${botId}@${browser}` : botId;
}

/** The Bot and the browser a computer's id names; `browser` is null for the main one. */
export function computerOf(computerId: string): {
  botId: string;
  browser: string | null;
} {
  const at = computerId.indexOf("@");
  return at < 0
    ? { botId: computerId, browser: null }
    : { botId: computerId.slice(0, at), browser: computerId.slice(at + 1) };
}

/**
 * Which browser a computer's id names, for the Bot the caller says it is acting as: null for the
 * main one.
 *
 * AN ID THAT NAMES NO BROWSER IS THE MAIN ONE'S, WHATEVER ELSE IT SAYS. The gateway's "which
 * computer" was a label before it meant anything — every caller in the product passes the Bot's
 * id, and a test may pass a word of its own — and a label with no `@` in it is still that: the
 * Bot's main browser, addressed by the Bot's id as it always was.
 *
 * ONE THAT NAMES A BROWSER HAS TO BE THIS BOT'S, AND A NAME. Another Bot's id before the `@`, or
 * something after it that is not a name, is a caller's mistake, and is refused as an id that is
 * not one before anything is addressed — never quietly carried out in the main browser instead.
 */
export function browserOf(computerId: string, botId: string): string | null {
  if (!computerId.includes("@")) return null;
  const named = computerOf(computerId);
  if (named.botId !== botId || !isBrowserName(named.browser)) {
    throw new BotIdRefusedError();
  }
  return named.browser;
}
