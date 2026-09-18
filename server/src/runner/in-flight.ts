/**
 * What this process is doing for somebody right now, and the one way to stop each piece of it.
 *
 * WHY A SECOND RECORD BESIDE THE LEDGER. `laf_thread_runs` says a run is going on; it cannot stop
 * one. What can is in memory, held by whatever started the run — the vendored runner's copy of a
 * chat's agent, the controller a room turn or a routine was handed — and none of it could be reached
 * from anywhere but the code that made it. So every run path says here what it has started, with
 * the function that stops it, for as long as it is going on. `모두 멈추기` reads this and nothing
 * else (`stop-all.ts`).
 *
 * IN THIS PROCESS, ON PURPOSE. One API process per VM (docs/laf/deployment-model.md): what this set
 * holds is all the work there is, and a run the process before a restart left behind is not running
 * — boot has already written its ledger row off as `unknown`.
 */

/** The kinds of work a person can have going on, in the order the surface lists them. */
export const WORK_KINDS = ["chat", "room", "routine", "handoff"] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

export type Work = {
  kind: WorkKind;
  /** The person it is being done for: whose conversation, room, routine or question it is. */
  userId: string | null;
  /** The Bot doing it. Null for a room's turn, which belongs to the room rather than to one Bot. */
  agentId: string | null;
  /** The conversation, for a chat: the thread is what the window that pressed Stop holds. */
  threadId?: string | null;
  /**
   * Stop it. Resolves whether it was stopped. Never expected to throw — a stop that cannot reach
   * what it stops says false — but the reader catches anyway.
   */
  stop: () => Promise<boolean>;
};

export type WorkInFlight = {
  /** Say something has started. The function handed back says it is over; twice is harmless. */
  track: (work: Work) => () => void;
  /** Everything going on for one person, oldest first. */
  of: (userId: string) => Work[];
  /** Whether an entry `of` handed out is still going — false once its work said it was over. */
  isGoing: (entry: Work) => boolean;
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
  };
}
