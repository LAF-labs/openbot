/**
 * Who may watch a Bot's screen, and which Bot.
 *
 * The live-screen socket is the one place in this product where a person drives another process's
 * browser directly: clicks and keystrokes go down it, frames come back. It was guarded by the
 * session alone — the actor was resolved in `index.ts` and then never used — so any signed-in
 * person could name any Bot on the deployment in the path and watch it work, mid-task, with that
 * person's logins loaded. On a VM a shop owner shares with their staff, that is every Bot.
 *
 * Its own module because an upgrade cannot be exercised through `app.request(...)` — Bun hands the
 * connection over before Hono sees it — so the rule has to be somewhere a test can call it.
 */
import { isBotId } from "../computer/bot-id";
import type { UserRole } from "./roles";

/** What the deployment decided about one attempt to open the screen. */
export type StreamAccess =
  | "bad_id"
  | "unauthenticated"
  | "not_found"
  | "allowed";

/**
 * Decide whether this person may open this Bot's screen.
 *
 * The id is checked FIRST, before any lookup: a malformed one has no business reaching a database
 * query, let alone a filesystem path in another container.
 *
 * `lookup` is the profile store's own `get`, which is scoped to the actor — so a Bot they cannot
 * see is a Bot they cannot watch, and a Bot that does not exist and a Bot that is somebody else's
 * come back the same way. Which of the two it is, is itself a fact about another person's roster.
 */
export async function streamBotAccess(
  botId: string,
  actor: { id: string; role: UserRole } | null,
  lookup: (
    actor: { id: string; role: UserRole },
    botId: string,
  ) => Promise<unknown | null>,
): Promise<StreamAccess> {
  // The one shape a Bot id may have (`computer/bot-id.ts`): the id becomes a directory in the
  // browser container, and `decodeURIComponent` on the way out of the route pattern will happily
  // produce a path.
  if (!isBotId(botId)) return "bad_id";
  if (!actor) return "unauthenticated";
  const found = await lookup(actor, botId).catch(() => null);
  return found ? "allowed" : "not_found";
}
