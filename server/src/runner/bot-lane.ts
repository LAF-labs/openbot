/**
 * One thing at a time, per Bot.
 *
 * Lifted out of the routine service, where it was written for a reason that is not the routine
 * service's alone: an account gets ONE virtual computer, so two tool loops on the same Bot drive one
 * browser at once — each one's snapshot goes stale under the other, and a click meant for one page
 * lands on the other's. The routine tick is sequential, but Run now is not the tick, and the two can
 * name the same Bot — and a chat turn the server owns (`turns/engine.ts`) takes the same lane.
 *
 * A promise chain rather than a lock: it costs nothing when there is no second caller, and it
 * cannot deadlock because nothing here waits on anything but the holder in front of it.
 *
 * HELD, AND LET GO OF MID-WORK. A chat turn can wait ten minutes on a person's answer, and holding
 * the Bot for that long made the 07:30 briefing run at nine (review H1, 2026-09-27). So besides
 * `run`, a holder can `acquire` the lane, `release` it while it waits on somebody, and acquire it
 * again before it touches the browser — reading `grants` to learn whether anybody else drove the
 * Bot in between, and so whether the page is still the one it left.
 */
export type LaneHold = {
  /** Let the next holder in. Twice is harmless. */
  release(): void;
};

export type BotLane = {
  /** Run `task` once whatever this Bot is already doing has finished. */
  run<T>(botId: string, task: () => Promise<T>): Promise<T>;
  /** Hold the Bot, once whatever it is already doing has finished, until the hold is released. */
  acquire(botId: string): Promise<LaneHold>;
  /** How many holds this Bot's lane has granted, ever: a later count than yours means somebody else ran. */
  grants(botId: string): number;
};

export function createBotLane(): BotLane {
  const queues = new Map<string, Promise<unknown>>();
  const granted = new Map<string, number>();

  const acquire = (botId: string): Promise<LaneHold> => {
    const previous = queues.get(botId) ?? Promise.resolve();
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
    queues.set(botId, settled);
    void settled.then(() => {
      if (queues.get(botId) === settled) queues.delete(botId);
    });
    return previous.then(
      () => grant(botId, release),
      () => grant(botId, release),
    );
  };

  const grant = (botId: string, release: () => void): LaneHold => {
    granted.set(botId, (granted.get(botId) ?? 0) + 1);
    return { release };
  };

  return {
    acquire,
    grants: (botId) => granted.get(botId) ?? 0,
    async run(botId, task) {
      const hold = await acquire(botId);
      try {
        return await task();
      } finally {
        hold.release();
      }
    },
  };
}
