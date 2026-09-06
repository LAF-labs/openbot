/**
 * The trail's one line about a Bot's screen being looked at.
 *
 * `docs/laf/data-lifecycle.md` §5 listed two things the system could not account for, and this
 * closes one of them: a person can open the live screen of a Bot — a browser signed into the
 * owner's own sites — and, once a demonstration has been recorded, read back every page it went to
 * and every control it pressed. Until this, nothing recorded that either had been opened.
 *
 * ONE ROW PER LOOK, NEVER PER FRAME. The live screen is a socket carrying thirty frames a second;
 * the fact is that a screen was watched between an open and a close, so the proxy that terminates
 * the socket (`index.ts`) asks this once, on open. The recording is polled once a second while
 * somebody is still driving; the fact is that a finished recording was read back, so the route asks
 * this on every read and it answers with a row once per recording and viewer.
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

export type ScreenViewer = { id: string; role: UserRole };

/** Which of the two ways a screen is looked at. */
export type ScreenViewSource = "live" | "demonstration";

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
   * promise resolves was the one that noticed — so the catch is in this module, on both doors.
   */
  opened: (botId: string, viewer: ScreenViewer) => Promise<void>;
  /**
   * Record that `viewer` read back a finished recording of `botId`'s browser.
   *
   * Once per recording and viewer: the panel that shows a recording asks for it on every mount and
   * once a second while it is still being made, and a row for each of those would be the per-frame
   * mistake in another shape. `startedAt` is the recording's identity — the recorder keeps one per
   * Bot and stamps it when the wheel is taken.
   */
  replayed: (
    botId: string,
    viewer: ScreenViewer,
    recording: { startedAt: number },
  ) => Promise<void>;
};

export function createScreenViewAudit(dependencies: {
  auditStore: AuditStore;
  /** Who owns this Bot, or null for a Bot nobody owns — a package's, or one whose owner has left. */
  ownerOf: (botId: string) => Promise<string | null>;
}): ScreenViewAudit {
  /*
   * The last replay recorded per Bot: `<viewer>:<startedAt>`. One entry per Bot, so it is bounded
   * by the roster, and a new recording or a different reader replaces it. In memory on purpose —
   * one API process per VM (docs/laf/deployment-model.md) — and a restart costing one extra row
   * is the right way round.
   */
  const lastReplay = new Map<string, string>();

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
      // The screen is open either way; a trail that is away is said on the console, not to the
      // person watching, who could do nothing about it.
      console.error("screen view could not be recorded", error);
    }
  };

  return {
    opened: (botId, viewer) => write(botId, viewer, "live"),
    replayed: async (botId, viewer, recording) => {
      const key = `${viewer.id}:${recording.startedAt}`;
      if (lastReplay.get(botId) === key) return;
      lastReplay.set(botId, key);
      await write(botId, viewer, "demonstration");
    },
  };
}
