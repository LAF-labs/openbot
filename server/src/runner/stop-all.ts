/**
 * `모두 멈추기`: everything a person has going on, on their own Bots, stopped by one press.
 *
 * Somebody whose Bot was working in a conversation and on a routine at once had no single way to
 * make it all stop when something looked wrong: Stop lived inside one conversation, and a routine
 * at seven in the morning had none at all. This reads what every run path has listed as going on
 * (`in-flight.ts`) and asks each piece to stop in its own way — a chat's stream aborted and its next
 * browser step not carried on (`laf-runner.ts`), a routine aborted or never started if it was still
 * queued (`routines/run.ts`).
 *
 * WHAT IT DOES NOT DO, ON PURPOSE:
 *
 *   - Undo anything. A message a Bot sent, a click that landed, a file it wrote: done is done, and
 *     nothing here pretends otherwise. The surface says so before the press.
 *   - Answer the questions Bots are waiting on. A question the boundary raised is the person's to
 *     answer (`computer/approvals.ts`), and stopping is not an answer to it — neither yes, which would
 *     let the action through, nor no, which would put a refusal on the trail the person never gave.
 *     The questions stay where they are, answerable; the turn that asked no longer waits for them.
 *
 * WHOSE WORK. The person's own — work listed as done for them — and only on Bots the ownership rule
 * every other door uses lets them drive (`actorMayDriveBot`). One account per deployment makes the
 * second clause redundant today; it is here so it stays true on the day a deployment is a slot on
 * shared hardware.
 *
 * HONEST ABOUT WHAT IT COULD NOT STOP. A piece of work whose stop says no, or throws, and is still
 * going on afterwards is reported as not stopped, by kind; one that ended on its own in the moment
 * between being listed and being asked is neither, because nothing was left to stop.
 */
import { type AuditStore, recordAuditEvent } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import { log } from "../log";
import {
  WORK_KINDS,
  type Work,
  type WorkInFlight,
  type WorkKind,
} from "./in-flight";

export type WorkCounts = Record<WorkKind, number>;

/** What is going on for a person right now, as the confirm dialog counts it. */
export type RunningNow = {
  running: WorkCounts;
  /**
   * The conversations among them, by thread — so the window asking can tell the conversation it
   * holds itself from the rest, and count it once.
   */
  chats: string[];
};

/** What one press did, by kind, and which conversations it did it to. */
export type StopAllResult = {
  stopped: WorkCounts;
  /** Found going on, asked to stop, and still going on. Never folded into `stopped`. */
  notStopped: WorkCounts;
  chats: { stopped: string[]; notStopped: string[] };
};

/** Whether the person asking may drive a Bot: the request's own `mayDriveBot`. */
export type MayDrive = (botId: string) => Promise<boolean>;

export type StopAll = {
  running: (actor: { id: string }, mayDrive: MayDrive) => Promise<RunningNow>;
  stopAll: (
    actor: { id: string },
    mayDrive: MayDrive,
  ) => Promise<StopAllResult>;
};

const noneOfIt = (): WorkCounts =>
  Object.fromEntries(WORK_KINDS.map((kind) => [kind, 0])) as WorkCounts;

/** Chats counted once per conversation; everything else once per listing. */
function countOf(entries: readonly Work[]): {
  counts: WorkCounts;
  chats: string[];
} {
  const counts = noneOfIt();
  const chats = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "chat" && entry.threadId) {
      if (chats.has(entry.threadId)) continue;
      chats.add(entry.threadId);
    }
    counts[entry.kind] += 1;
  }
  return { counts, chats: [...chats] };
}

export function createStopAll(options: {
  work: WorkInFlight;
  auditStore?: AuditStore;
}): StopAll {
  /** The person's own work, on Bots they may drive. Each Bot is asked about once. */
  const mine = async (actor: { id: string }, mayDrive: MayDrive) => {
    const found = options.work.of(actor.id);
    const verdicts = new Map<string, Promise<boolean>>();
    const allowed = await Promise.all(
      found.map((entry) => {
        if (entry.agentId === null) return true;
        let verdict = verdicts.get(entry.agentId);
        if (!verdict) {
          verdict = mayDrive(entry.agentId).catch(() => false);
          verdicts.set(entry.agentId, verdict);
        }
        return verdict;
      }),
    );
    return found.filter((_, index) => allowed[index]);
  };

  return {
    async running(actor, mayDrive) {
      const { counts, chats } = countOf(await mine(actor, mayDrive));
      return { running: counts, chats };
    },

    async stopAll(actor, mayDrive) {
      const entries = await mine(actor, mayDrive);
      const outcomes = await Promise.all(
        entries.map(async (entry) => ({
          entry,
          stopped: await entry.stop().catch(() => false),
        })),
      );
      const stopped = outcomes
        .filter((outcome) => outcome.stopped)
        .map((outcome) => outcome.entry);
      const stuck = outcomes
        .filter(
          (outcome) => !outcome.stopped && options.work.isGoing(outcome.entry),
        )
        .map((outcome) => outcome.entry);
      const done = countOf(stopped);
      const left = countOf(stuck);
      const result: StopAllResult = {
        stopped: done.counts,
        notStopped: left.counts,
        chats: { stopped: done.chats, notStopped: left.chats },
      };

      const anyLeft = stuck.length > 0;
      if (anyLeft) {
        log.warn("stop_all_left_work", {
          ...left.counts,
          note: "Work was found going on, asked to stop, and was still going on afterwards.",
        });
      }
      /*
       * On the trail whether or not anything was running — "she pressed it and nothing was going
       * on" is a fact worth having, as `computer.stopped` says — and written after the stops, so
       * the row says what they came to. Counts and Bot ids, never a word of anybody's work. A trail
       * that cannot be written does not undo a stop that already happened.
       */
      if (options.auditStore) {
        await recordAuditEvent(options.auditStore, {
          eventType: "work.stopped_all",
          targetType: "user",
          targetId: actor.id,
          // A fixture is not a person: named in the payload, never the actor of a row.
          ...(actor.id === DEV_ACTOR.id ? {} : { actorUserId: actor.id }),
          payload: {
            actor: actor.id,
            stopped: result.stopped,
            ...(anyLeft ? { notStopped: result.notStopped } : {}),
            bots: [
              ...new Set(
                stopped
                  .map((entry) => entry.agentId)
                  .filter((botId): botId is string => botId !== null),
              ),
            ].sort(),
          },
        }).catch(() => {
          log.warn("stop_all_row_lost", {
            note: "Everything was stopped; the trail row saying so could not be written.",
          });
        });
      }
      return result;
    },
  };
}
