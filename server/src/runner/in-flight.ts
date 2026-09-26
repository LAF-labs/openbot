/**
 * What this process is doing for somebody right now, and the one way to stop each piece of it.
 *
 * WHY A SECOND RECORD BESIDE THE LEDGER. `laf_thread_runs` says a run is going on; it cannot stop
 * one. What can is in memory, held by whatever started the run — the vendored runner's copy of a
 * chat's agent, the controller a routine was handed — and none of it could be reached
 * from anywhere but the code that made it. So every run path says here what it has started, with
 * the function that stops it, for as long as it is going on. `모두 멈추기` reads this and nothing
 * else (`stop-all.ts`).
 *
 * IN THIS PROCESS, ON PURPOSE. One API process per VM (docs/laf/deployment-model.md): what this set
 * holds is all the work there is, and a run the process before a restart left behind is not running
 * — boot has already written its ledger row off as `unknown`.
 */

/**
 * The kinds of work a person can have going on, in the order the surface lists them.
 *
 * Two since 2026-09-24: a room's turn and one Bot answering another went with rooms when a person
 * came to have one Bot (docs/laf/deployment-model.md, "봇은 하나다").
 */
export const WORK_KINDS = ["chat", "routine"] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * Why a routine's run is stopped when no person pressed stop: its routine was deleted (`gone`) or
 * switched off (`off`) under it (`routines/service.ts`). Its record says which, not "모두 멈추기".
 */
export type Withdrawn = "gone" | "off";

export type Work = {
  kind: WorkKind;
  /** The person it is being done for: whose conversation or routine it is. */
  userId: string | null;
  /** The Bot doing it. */
  agentId: string | null;
  /** The conversation, for a chat: the thread is what the window that pressed Stop holds. */
  threadId?: string | null;
  /** The routine, for a routine's run: what deleting or switching it off stops (`routines/service.ts`). */
  routineId?: string;
  /**
   * Stop it. Resolves whether it was stopped. Never expected to throw — a stop that cannot reach
   * what it stops says false — but the reader catches anyway. `withdrawn` says the stop is its
   * routine being taken back rather than a person's; only a routine's run reads it.
   */
  stop: (withdrawn?: Withdrawn) => Promise<boolean>;
};

export type WorkInFlight = {
  /** Say something has started. The function handed back says it is over; twice is harmless. */
  track: (work: Work) => () => void;
  /** Everything going on for one person, oldest first. */
  of: (userId: string) => Work[];
  /** Whether an entry `of` handed out is still going — false once its work said it was over. */
  isGoing: (entry: Work) => boolean;
  /** Every run of one routine going on or queued, whoever it is being done for. */
  ofRoutine: (routineId: string) => Work[];
};

export function createWorkInFlight(): WorkInFlight {
  // Identity, not equality: two routines on one Bot are two entries even when every field matches.
  const going = new Set<Work>();
  return {
    track(work) {
      const entry = { ...work };
      going.add(entry);
      return () => {
        going.delete(entry);
      };
    },
    of(userId) {
      return [...going].filter((entry) => entry.userId === userId);
    },
    isGoing(entry) {
      return going.has(entry);
    },
    ofRoutine(routineId) {
      return [...going].filter(
        (entry) => entry.kind === "routine" && entry.routineId === routineId,
      );
    },
  };
}
