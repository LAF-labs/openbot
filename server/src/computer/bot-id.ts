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
 * structure. The computer checks the same shape on its own side (`agent-computer/src/bot-id.ts`),
 * because that process must not depend on this one having looked.
 */
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const BOT_ID_INVALID = "laf:bot_id_invalid";

export function isBotId(value: unknown): value is string {
  return typeof value === "string" && BOT_ID.test(value);
}
