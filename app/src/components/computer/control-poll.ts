import { OUTAGE_CAP_MS } from "@/lib/polling";
import { type ControlState, readControl } from "./take-the-wheel";

/**
 * ONE CONTROL POLL PER COMPUTER, AND IT STOPS WHEN NOTHING IS HAPPENING.
 *
 * `ComputerView` draws once beside the conversation and again on the line of every computer tool
 * call in the transcript (`lib/copilot/computer-tools.tsx`), so a thread with eight browser actions
 * in it mounts nine of them. Each used to run its own `setTimeout` loop at 1 Hz against
 * `/api/computers/:id/control`, forever, whether or not its screenshot loop had long since settled
 * — nine requests a second to one endpoint, all asking the same question about the same computer,
 * for as long as the tab was open. The screenshot loop beside it has had a settle guard since it
 * was written; this one had none.
 *
 * So: subscribers share one loop per computer, and the loop stops once the answer has come back
 * identical `SETTLED_READS` times running and no subscriber says it still needs to be awake.
 * Anything that changes the situation — the person taking the wheel, a secret being asked for, a
 * tool call starting — pokes it awake again.
 *
 * `absent` is permanent, and separately so: a deployment with no computer does not mount these
 * routes, and a 404 every second for the life of the tab reads as an outage in every network log.
 */

/** Identical reads in a row after which the loop stops until something pokes it. */
export const SETTLED_READS = 5;

const DEFAULT_INTERVAL_MS = 1000;
/**
 * The longest the loop waits after a read that failed — the same minute every poll in the app backs
 * off to (`OUTAGE_CAP_MS` in `lib/polling.ts`).
 *
 * MEASURED 2026-09-10 (audit A4, finding 4): a failed read answered `{state: null}`, which counted
 * as neither a change nor a repeat, so with the API stopped the loop never settled and asked once a
 * second for the whole outage — twelve 500s in twelve seconds. A failure now counts as a read that
 * changed nothing, and each one doubles the wait up to this.
 */
export const MAX_FAILURE_INTERVAL_MS = OUTAGE_CAP_MS;

/**
 * Where the loop's reads and waits come from. The real clock in the app; a clock a test turns by
 * hand in `control-poll.test.ts`, because a loop whose every assertion is about how many reads fit
 * between two instants cannot be checked against the wall clock on a machine under load — the
 * backoff test failed three times in one day's full run and never alone.
 */
export type ControlTimers = {
  /** Make a read now. */
  run: (tick: () => Promise<void>) => void;
  /** Make a read after `ms`. */
  later: (ms: number, tick: () => Promise<void>) => unknown;
  cancel: (handle: unknown) => void;
};

const REAL_TIMERS: ControlTimers = {
  run: (tick) => void tick(),
  later: (ms, tick) => setTimeout(tick, ms),
  cancel: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout> | undefined),
};

type Watcher = {
  onState: (state: ControlState) => void;
  /** True while this view has its own reason to keep the loop awake, whatever the state says. */
  isLive: () => boolean;
};

type Loop = {
  watchers: Set<Watcher>;
  timer: unknown;
  timers: ControlTimers;
  polling: boolean;
  /** Consecutive identical reads. Reset by a change and by every poke. */
  unchanged: number;
  last: string;
  /** No control surface on this deployment. There is nothing this loop could ever learn. */
  absent: boolean;
  intervalMs: number;
  /** The wait before the next read: `intervalMs` while reads succeed, doubling while they fail. */
  waitMs: number;
};

const loops = new Map<string, Loop>();

function loopFor(
  computerId: string,
  intervalMs: number,
  timers: ControlTimers,
): Loop {
  const existing = loops.get(computerId);
  if (existing) return existing;
  const created: Loop = {
    watchers: new Set(),
    timer: undefined,
    timers,
    polling: false,
    unchanged: 0,
    last: "",
    absent: false,
    intervalMs,
    waitMs: intervalMs,
  };
  loops.set(computerId, created);
  return created;
}

function shouldContinue(loop: Loop): boolean {
  if (loop.watchers.size === 0) return false;
  if (loop.absent) return false;
  for (const watcher of loop.watchers) {
    if (watcher.isLive()) return true;
  }
  return loop.unchanged < SETTLED_READS;
}

function start(computerId: string, loop: Loop): void {
  if (loop.polling || loop.absent || loop.watchers.size === 0) return;
  loop.polling = true;

  const tick = async () => {
    // A request that throws — the API gone, not merely answering badly — is a failed read too,
    // and must not take the loop down with it: `polling` would stay true and nothing could restart it.
    const { state, absent } = await readControl(computerId).catch(() => ({
      state: null,
      absent: false,
    }));
    if (absent) loop.absent = true;
    if (state) {
      // The whole answer, not one field: a reason appearing or a secret being asked for are both
      // changes, and both are why somebody is looking at this card.
      const shape = JSON.stringify(state);
      loop.unchanged = shape === loop.last ? loop.unchanged + 1 : 0;
      loop.last = shape;
      loop.waitMs = loop.intervalMs;
      for (const watcher of loop.watchers) watcher.onState(state);
    } else if (!absent) {
      loop.unchanged += 1;
      loop.waitMs = Math.min(
        Math.max(loop.waitMs * 2, 1),
        MAX_FAILURE_INTERVAL_MS,
      );
    }
    if (shouldContinue(loop)) {
      loop.timer = loop.timers.later(loop.waitMs, tick);
      return;
    }
    loop.polling = false;
    loop.timer = undefined;
  };

  loop.timers.run(tick);
}

/**
 * Watch one computer's control state. Returns the unsubscribe.
 *
 * Subscribing counts as activity, so a card that has just been mounted gets an answer even if the
 * shared loop had already settled.
 */
export function watchControl(
  computerId: string,
  watcher: Watcher,
  intervalMs = DEFAULT_INTERVAL_MS,
  timers: ControlTimers = REAL_TIMERS,
): () => void {
  const loop = loopFor(computerId, intervalMs, timers);
  loop.watchers.add(watcher);
  loop.unchanged = 0;
  start(computerId, loop);

  return () => {
    loop.watchers.delete(watcher);
    if (loop.watchers.size > 0) return;
    loop.timers.cancel(loop.timer);
    loop.timer = undefined;
    loop.polling = false;
    loops.delete(computerId);
  };
}

/** Something happened that the next read should see. Wakes a settled loop. */
export function pokeControl(computerId: string): void {
  const loop = loops.get(computerId);
  if (!loop) return;
  loop.unchanged = 0;
  // Something happened, so the next read is worth making now rather than at the end of a backoff.
  loop.waitMs = loop.intervalMs;
  start(computerId, loop);
}

/** How many loops are alive, for tests that need to prove the sharing rather than assume it. */
export function activeControlPolls(): number {
  return loops.size;
}
