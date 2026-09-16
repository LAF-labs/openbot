/**
 * What happens to the computer when a Bot is deleted.
 *
 * MEASURED 2026-09-10 (audit A3, "봇 하나를 지워도 그 봇의 브라우저·프로필이 남는다"): after
 * `DELETE /api/agents/:id` the Bot's browser was still listed and still running, and its profile —
 * 1.4MB, cookies included — was still in the `agent-profiles` volume. So this hook was written to
 * call `computers/reset` per Bot, on the reasoning that a person deletes a Bot to take back the
 * logins they handed it.
 *
 * THAT REASONING STOPPED BEING TRUE ON 2026-09-16, AND THE CALL HAD TO GO WITH IT. There is one
 * browser profile per deployment now (`agent-computer/src/profiles.ts`): the logins are the
 * PERSON'S, shared by every Bot they have, so "take back the logins I handed this Bot" is not a
 * thing deleting one Bot can do. Resetting here would have signed the other four out of 스마트스토어,
 * 홈택스 and their bank because somebody tidied a roster — no confirmation, no undo, and the row
 * would have said it was that one Bot's profile that went.
 *
 * So the Bot's own things go and nothing else does: its tabs close, its wheel is let go, and the
 * trail says out loud that the logins stayed and why. The two doors that DO empty the profile both
 * ask first and both say whose it is — the 초기화 button on the Computers page, and a person leaving
 * (`account/deletion.ts`).
 *
 * Addressed the same way it always was — `forBot`, which sets the header the computer keys
 * everything on.
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
 * error to who could act on it; what happened is written down instead — a `computer.released` row
 * when the tabs closed, a `computer.reset_failed` row when the computer could not be reached at all,
 * so that the trail never shows a deleted Bot without saying what became of its browser.
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
      const result = await client.forBot(botId).stopComputer();
      await recordAuditEvent(auditStore, {
        eventType: "computer.released",
        targetType: "computer",
        targetId: botId,
        ...(actorUserId ? { actorUserId } : {}),
        payload: {
          bot: botId,
          actor: actor.id,
          reason:
            "the Bot was deleted; its tabs closed and the shared logins stayed, because they belong to the account and its other Bots",
          wasRunning: result.wasRunning,
          // Said as a fact rather than implied by the absence of a `computer.reset` row: an
          // investigator reading this a month later must not have to know which release this was.
          loginsKept: true,
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
