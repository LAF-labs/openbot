/**
 * Who may open a Bot's screen, and which Bot.
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
import { actorMayDriveBot, type BotOwnerLookup } from "./guards";
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
 * WHOSE THE BOT IS, ASKED OF THE TABLE. This used to take the profile store's `get`, which is
 * scoped to what the actor may SEE — and a Bot marked `public` was visible to every signed-in
 * person on the deployment, so the socket their keystrokes travel down opened for anybody on one.
 * Measured 2026-09-10 (audit A8) against the real store; the unit test had stubbed a stricter
 * roster than the store and proved nothing about it. The lookup is whose the Bot is, and the answer
 * is the one predicate every other door a Bot id opens uses (`actorMayDriveBot`): the owner, or a
 * Bot nobody made. Not an administrator — that exception went on 2026-09-16, and this socket is the
 * clearest case for why: it carries live frames of somebody's browser out and their keystrokes in.
 * A Bot that does not exist and a Bot that is somebody else's come back the same way; which of the
 * two it is, is itself a fact about another person's roster.
 */
export async function streamBotAccess(
  botId: string,
  actor: { id: string; role: UserRole } | null,
  lookup: BotOwnerLookup,
): Promise<StreamAccess> {
  // The one shape a Bot id may have (`computer/bot-id.ts`): the id becomes a directory in the
  // browser container, and `decodeURIComponent` on the way out of the route pattern will happily
  // produce a path.
  if (!isBotId(botId)) return "bad_id";
  if (!actor) return "unauthenticated";
  // A lookup that failed is a Bot that is not there. Never "allowed" on an error.
  const owner = await lookup(botId).catch(() => undefined);
  return actorMayDriveBot(actor, owner) ? "allowed" : "not_found";
}
