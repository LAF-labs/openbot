/**
 * The trail's one line about a Bot's screen being looked at.
 *
 * `docs/laf/data-lifecycle.md` §5 listed two things the system could not account for, and this
 * closes one of them: a person can open the live screen of a Bot — a browser signed into the
 * owner's own sites. Until this, nothing recorded that it had been opened.
 *
 * ONE ROW PER LOOK, NEVER PER FRAME. The live screen is a socket carrying thirty frames a second;
 * the fact is that a screen was watched between an open and a close, so the proxy that terminates
 * the socket (`live-screen.ts`) asks this once, on open.
 *
 * THE OWNER IS RECORDED TOO. The first draft left the owner out — "a person driving their own Bot
 * is the product working as drawn" — and the row said `Somebody else watched the screen`. But the
 * payload carries who owns the Bot, so a reader can tell the two apart, and a trail that is silent
 * for one class of viewer is a trail with a hole where the question "who has seen this screen"
 * most needs an answer. The row says who looked, with what role, and whether it was their own Bot.
 */

import { eq } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { UserRole } from "../auth/roles";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";

export type ScreenViewer = { id: string; role: UserRole };

/**
 * Which way a screen was looked at. There is one way now, and the field stays on the row because
 * the trail is append-only: rows written while teaching by demonstration existed say
 * `demonstration` (a finished recording read back), and the audit page still tells the two apart.
 */
type ScreenViewSource = "live";

/**
 * Who owns a Bot, read straight off its profile row.
 *
 * Not `AgentProfileStore.get`: that takes an actor and answers through the access filter, and the
 * question here is the opposite one — not "may this person see the Bot" but "is this person the
 * Bot's owner", asked precisely because an administrator may see every Bot.
 */
export const botOwnerLookup =
  (database: Database) =>
  async (botId: string): Promise<string | null> => {
    const [row] = await database
      .select({ ownerUserId: agentProfiles.ownerUserId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId))
      .limit(1);
    return row?.ownerUserId ?? null;
  };

export type ScreenViewAudit = {
  /**
   * Record that `viewer` opened `botId`'s live screen.
   *
   * Never throws: a socket must open whether or not the row lands. `recordAuditEvent` itself does
   * NOT swallow a store failure — the first draft here said it did, and the test that asserts this
   * promise resolves was the one that noticed — so the catch is in this module.
   */
  opened: (botId: string, viewer: ScreenViewer) => Promise<void>;
};

export function createScreenViewAudit(dependencies: {
  auditStore: AuditStore;
  /** Who owns this Bot, or null for a Bot nobody owns — a package's, or one whose owner has left. */
  ownerOf: (botId: string) => Promise<string | null>;
}): ScreenViewAudit {
  const write = async (
    botId: string,
    viewer: ScreenViewer,
    source: ScreenViewSource,
  ) => {
    let owner: string | null;
    try {
      owner = await dependencies.ownerOf(botId);
    } catch {
      // Unknown is not "theirs". A lookup that failed must not read as the owner watching, so the
      // row is written and says the owner could not be resolved rather than naming somebody.
      owner = null;
    }
    try {
      await recordAuditEvent(dependencies.auditStore, {
        eventType: "computer.screen_viewed",
        targetType: "bot",
        targetId: botId,
        actorUserId: viewer.id,
        payload: {
          // `bot`, as every other computer row names it, so the trail's Bot column fills in.
          bot: botId,
          source,
          // The owner's id and not their address: this table outlives the account by a year, and
          // deletion can re-point the actor column but never a payload.
          ownerUserId: owner,
          // Said outright rather than left for a reader to compare, because after the owner
          // leaves, the actor column is a pseudonym and the payload is not — the comparison
          // would then lie.
          own: owner !== null && owner === viewer.id,
          viewerRole: viewer.role,
        },
      });
    } catch (error) {
      // The screen is open either way; a trail that is away is said in the log, not to the
      // person watching, who could do nothing about it.
      log.error("screen_view_not_recorded", { reason: describeFailure(error) });
    }
  };

  return {
    opened: (botId, viewer) => write(botId, viewer, "live"),
  };
}
