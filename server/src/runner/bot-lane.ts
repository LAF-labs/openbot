/**
 * One thing at a time, per browser.
 *
 * Lifted out of the routine service, where it was written for a reason that is not the routine
 * service's alone: two tool loops on one browser drive it at once — each one's snapshot goes stale
 * under the other, and a click meant for one page lands on the other's. The routine tick is
 * sequential, but Run now is not the tick, and the two can name the same Bot — and a chat turn the
 * server owns (`turns/engine.ts`) takes the same lane.
 *
 * WHAT IS HELD IS A BROWSER, NOT THE BOT (piece 5-4, 2026-10-10). The lane was the Bot's: a
 * conversation that only talked waited behind a routine that was browsing, and a project's turn
 * behind the main conversation's. It is keyed by the computer's id now (`computer/bot-id.ts`) — the
 * Bot's own for its main browser, which is every caller's today, so nothing they pass changed —
 * and a chat turn takes it at the first call that uses the browser instead of at its first step
 * (which of the computer's tools that is: `drivesTheBrowser`, `shared/tools/computer.ts`).
 * A routine's run still takes it whole: a routine nearly always browses, its notepad is read
 * inside the lane so that a run queued behind another sees what that one settled, and its ledger
 * row opens once the lane lets it through (`routines/run.ts`).
 *
 * A promise chain rather than a lock: it costs nothing when there is no second caller, and it
 * cannot deadlock because nothing here waits on anything but the holder in front of it.
 *
 * HELD, AND LET GO OF MID-WORK. A chat turn can wait ten minutes on a person's answer, and holding
 * the browser for that long made the 07:30 briefing run at nine (review H1, 2026-09-27). So besides
 * `run`, a holder can `acquire` the lane, `release` it while it waits on somebody, and acquire it
 * again before it touches the browser — reading `grants` to learn whether anybody else drove it
 * in between, and so whether the page is still the one it left.
 */

export type LaneHold = {
  /** Let the next holder in. Twice is harmless. */
  release(): void;
};

export type BotLane = {
  /** Run `task` once whoever has this browser has finished. */
  run<T>(computerId: string, task: () => Promise<T>): Promise<T>;
  /** Hold the browser, once whoever has it has finished, until the hold is released. */
  acquire(computerId: string): Promise<LaneHold>;
  /** How many holds this browser's lane has granted, ever: a later count than yours means somebody else ran. */
  grants(computerId: string): number;
  /** Whether asking now would mean waiting: somebody holds the browser, or is in line for it. */
  busy(computerId: string): boolean;
};

export function createBotLane(): BotLane {
  const queues = new Map<string, Promise<unknown>>();
  const granted = new Map<string, number>();

  const acquire = (computerId: string): Promise<LaneHold> => {
    const previous = queues.get(computerId) ?? Promise.resolve();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    /*
     * The stored promise settles only when this holder lets go, whatever the holder in front of it
     * did: a failure there must not hand the NEXT caller a rejection. Cleared only when this holder
     * is still the newest, or a later arrival would have its lane dropped from under it.
     */
    const settled = previous.then(
      () => released,
      () => released,
    );
    queues.set(computerId, settled);
    void settled.then(() => {
      if (queues.get(computerId) === settled) queues.delete(computerId);
    });
    return previous.then(
      () => grant(computerId, release),
      () => grant(computerId, release),
    );
  };

  const grant = (computerId: string, release: () => void): LaneHold => {
    granted.set(computerId, (granted.get(computerId) ?? 0) + 1);
    return { release };
  };

  return {
    acquire,
    grants: (computerId) => granted.get(computerId) ?? 0,
    busy: (computerId) => queues.has(computerId),
    async run(computerId, task) {
      const hold = await acquire(computerId);
      try {
        return await task();
      } finally {
        hold.release();
      }
    },
  };
}
