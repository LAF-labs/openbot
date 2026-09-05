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
