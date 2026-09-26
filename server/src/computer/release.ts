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
 *
 * AND WHAT IT LEFT THERE (2026-09-26). A sheet or a PDF the person handed the Bot was also filed in
 * the workspace as text (`attachments/service.ts`), and a long tool result from its conversations was
 * filed whole (`spillover.ts`); deleting the Bot's rows cannot reach a file. So the deletion hands
 * their paths here, and they are removed once the tabs are closed. Only those paths: the workspace is
 * the deployment's, like the profile, and a file somebody else put there — a download, another Bot's
 * notes — is not this Bot's to take.
 */
import type { AgentActor } from "../agents/profile-types";
import { type AuditStore, recordAuditEvent } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { ComputerClient } from "./client";

/**
 * Let go of one Bot on the deployment's browser, as `actor` asked. Whether its tabs were closed.
 *
 * Assignable to the Bot store's `ComputerRelease` (`agents/profile-store.ts`), which ignores the
 * answer; a person being removed (`account/deletion.ts`) reads it, to say which of their Bots were
 * let go of.
 */
export type BotRelease = (
  botId: string,
  actor: Pick<AgentActor, "id">,
  /** What the deleted Bot's attachments and conversations left in the workspace, removed last. */
  files?: readonly string[],
) => Promise<boolean>;

/** The two things a release asks of the computer, so a test can hand in a workspace of its own. */
export type ReleasingComputer = {
  forBot(
    botId: string,
  ): Pick<ReturnType<ComputerClient["forBot"]>, "stopComputer" | "removeFile">;
};

/** What became of the files a deletion handed over. Counts, never the paths: a name is content. */
type FilesOutcome = { removed: number; alreadyGone: number; failed: number };

/**
 * The release a deployment hands its Bot store — and its account deletion, for a leftover account
 * removed while the deployment's person stays: that person's logins stay too, so the leaver's Bots
 * are let go of exactly as a deleted Bot is.
 *
 * Never throws. The Bot's row is already gone, or about to be, when this runs, so there is nobody to
 * answer an error to who could act on it; what happened is written down instead — a
 * `computer.released` row when the tabs closed, a `computer.release_failed` row when the computer
 * could not be reached at all, so that the trail never shows a deleted Bot without saying what
 * became of its browser and its files.
 */
export function releaseComputerFor(
  client: ReleasingComputer | undefined,
  auditStore: AuditStore,
): BotRelease {
  return async (botId, actor, files = []) => {
    if (!client) return false;
    // Attribution as the computer routes do it: the local fixture is not a person and does not
    // become the actor of a row. The FK on `actor_user_id` is the other reason.
    const actorUserId = actor.id === DEV_ACTOR.id ? undefined : actor.id;
    const rowLost = (failure: unknown) => {
      log.error("agent_computer_release_row_lost", {
        bot: botId,
        reason: describeFailure(failure),
      });
    };
    let wasRunning: boolean;
    try {
      ({ wasRunning } = await client.forBot(botId).stopComputer());
    } catch (error) {
      log.error("agent_computer_not_released", {
        bot: botId,
        reason: describeFailure(error),
      });
      // Recorded, not thrown: the Bot is gone from the roster either way. The catch around the
      // row is the same rule again — an audit store that is down must not turn one lost row into
      // an exception nobody can act on.
      await recordAuditEvent(auditStore, {
        eventType: "computer.release_failed",
        targetType: "computer",
        targetId: botId,
        ...(actorUserId ? { actorUserId } : {}),
        payload: {
          bot: botId,
          actor: actor.id,
          reason: describeFailure(error),
          /*
           * Not tried: a computer that did not answer the stop would make each file wait out the
           * client's timeout in turn, under a delete the person is watching. Said as a number so
           * the files still on the volume are on the record rather than implied away.
           */
          ...(files.length > 0 ? { filesLeft: files.length } : {}),
        },
      }).catch(rowLost);
      return false;
    }
    const filesOutcome =
      files.length > 0
        ? await removeFiles(client.forBot(botId), botId, files)
        : null;
    /*
     * The tabs are closed whatever becomes of this row, so a row that cannot be written is logged as
     * lost rather than recorded as a release that failed — which is what it used to become.
     */
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
        wasRunning,
        // Said as a fact rather than implied by the absence of a `computer.reset` row: an
        // investigator reading this a month later must not have to know which release this was.
        loginsKept: true,
        ...(filesOutcome ? { files: filesOutcome } : {}),
      },
    }).catch(rowLost);
    return true;
  };
}

/**
 * Each file on its own, so one that cannot be removed does not keep the rest. A file already gone
 * — the person emptied the folder, or an older delete got there first — is counted as gone, never as
 * a failure: the delete it belongs to has already happened.
 */
async function removeFiles(
  computer: Pick<ReturnType<ComputerClient["forBot"]>, "removeFile">,
  botId: string,
  files: readonly string[],
): Promise<FilesOutcome> {
  const outcome: FilesOutcome = { removed: 0, alreadyGone: 0, failed: 0 };
  for (const path of files) {
    try {
      const { removed } = await computer.removeFile({ path });
      if (removed) outcome.removed += 1;
      else outcome.alreadyGone += 1;
    } catch (error) {
      outcome.failed += 1;
      log.error("agent_computer_file_not_removed", {
        bot: botId,
        reason: describeFailure(error),
      });
    }
  }
  return outcome;
}
