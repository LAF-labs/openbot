/**
 * What happens to a Bot's computer when the Bot is deleted.
 *
 * MEASURED 2026-09-10 (audit A3, "봇 하나를 지워도 그 봇의 브라우저·프로필이 남는다"): after
 * `DELETE /api/agents/:id` the Bot's browser was still listed and still running, and its profile —
 * 1.4MB, cookies included — was still in the `agent-profiles` volume. The only thing that ever
 * called `computers/reset` per Bot was deleting the whole account. A person deletes a Bot, more
 * often than not, to take back the logins they handed it; the row went and the logins stayed.
 *
 * This is the same call the account deletion makes (`account/deletion.ts`), addressed the same way
 * — `forBot`, which sets the header the computer keys everything on — and recorded the way the
 * reset button is recorded, so the trail reads the same whichever door a reset came through.
 */
import type { AgentActor } from "../agents/profile-types";
import type { ComputerRelease } from "../agents/profile-store";
import { type AuditStore, recordAuditEvent } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { ComputerClient } from "./client";

/**
 * The release a deployment hands its Bot store.
 *
 * Never throws. The Bot's row is already gone when this runs, so there is nobody to answer an
 * error to who could act on it; what happened is written down instead — a `computer.reset` row
 * when the profile went, a `computer.reset_failed` row when it did not, so that the audit trail
 * never shows a deleted Bot without saying what became of its logins.
 */
export function releaseComputerFor(
  client: ComputerClient | undefined,
  auditStore: AuditStore,
): ComputerRelease {
  return async (botId: string, actor: AgentActor): Promise<void> => {
    if (!client) return;
    // Attribution as the computer routes do it: the local fixture is not a person and does not
    // become the actor of a row. The FK on `actor_user_id` is the other reason.
    const actorUserId = actor.id === DEV_ACTOR.id ? undefined : actor.id;
    try {
      const result = await client.forBot(botId).resetComputer();
      await recordAuditEvent(auditStore, {
        eventType: "computer.reset",
        targetType: "computer",
        targetId: botId,
        ...(actorUserId ? { actorUserId } : {}),
        payload: {
          bot: botId,
          actor: actor.id,
          reason:
            "the Bot was deleted, and every saved login on its computer with it",
          reset: result.reset,
        },
      });
    } catch (error) {
      log.error("agent_computer_not_released", {
        bot: botId,
        reason: describeFailure(error),
      });
      // Recorded, not thrown: the Bot is gone from the roster either way. The catch around the
      // row is the same rule again — an audit store that is down must not turn one lost row into
      // an exception nobody can act on.
      await recordAuditEvent(auditStore, {
        eventType: "computer.reset_failed",
        targetType: "computer",
        targetId: botId,
        ...(actorUserId ? { actorUserId } : {}),
        payload: {
          bot: botId,
          actor: actor.id,
          reason: describeFailure(error),
        },
      }).catch((failure: unknown) => {
        log.error("agent_computer_release_row_lost", {
          bot: botId,
          reason: describeFailure(failure),
        });
      });
    }
  };
}
