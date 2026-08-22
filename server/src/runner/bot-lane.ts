/**
 * One thing at a time, per Bot.
 *
 * Lifted out of the routine service, where it was written for a reason that is not the routine
 * service's alone: an account gets ONE virtual computer and up to five Bots share it, so two tool
 * loops on the same Bot drive one browser at once — each one's snapshot goes stale under the other,
 * and a click meant for one page lands on the other's. The routine tick is sequential, but Run now
 * is not the tick, a room turn is not either, and two of those can name the same Bot.
 *
 * A promise chain rather than a lock: it costs nothing when there is no second caller, and it
 * cannot deadlock because nothing here waits on anything but the task in front of it.
 */
export type BotLane = {
  /** Run `task` once whatever this Bot is already doing has finished. */
  run<T>(botId: string, task: () => Promise<T>): Promise<T>;
};

export function createBotLane(): BotLane {
  const queues = new Map<string, Promise<unknown>>();

  return {
    run(botId, task) {
      const previous = queues.get(botId) ?? Promise.resolve();
      const started = previous.then(task, task);
      /*
       * The stored promise swallows failures so one task's error cannot reject the NEXT caller's
       * wait; the caller still gets its own rejection from `started`. Cleared only when this task
       * is still the newest, or a later arrival would have its lane dropped from under it.
       */
      const settled = started.then(
        () => undefined,
        () => undefined,
      );
      queues.set(botId, settled);
      void settled.then(() => {
        if (queues.get(botId) === settled) queues.delete(botId);
      });
      return started;
    },
  };
}
