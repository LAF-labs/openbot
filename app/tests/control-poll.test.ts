import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activeControlPolls,
  type ControlTimers,
  MAX_FAILURE_INTERVAL_MS,
  pokeControl,
  SETTLED_READS,
  watchControl,
} from "../src/components/computer/control-poll";
import type { ControlState } from "../src/components/computer/take-the-wheel";
import { stubFetch } from "./support/fetch";

/**
 * The loop a transcript used to run one of per computer tool call.
 *
 * A view of the computer mounted once beside the conversation and again on every browser action in
 * the thread (the live view and the help cards read it the same way now), and the control read is
 * 1 Hz. Nine cards meant nine requests a second to one endpoint,
 * forever, whether or not anything on the screen was moving. Both halves of the fix are asserted
 * here, because neither is visible from the component: that the cards share one loop, and that it
 * stops once the answer stops changing.
 *
 * Counted on a clock this file turns by hand. It used to be the wall clock with the interval set to
 * zero, and "keeps asking while live" and the backoff test failed three times in one day's full
 * `test:ci` under load — never alone — because both counted reads between two real instants. Now
 * every wait the loop asks for is queued here, a read happens only when the test fires it, and each
 * read is awaited to its end before the next, so nothing turns on how fast the machine is.
 */

type Pending = { at: number; tick: () => Promise<void>; id: number };

/** A clock nothing moves but the test. */
function handClock() {
  let now = 0;
  let nextId = 0;
  let queue: Pending[] = [];
  let inFlight: Promise<void>[] = [];
  const timers: ControlTimers = {
    run: (tick) => {
      inFlight.push(tick());
    },
    later: (ms, tick) => {
      nextId += 1;
      queue.push({ at: now + ms, tick, id: nextId });
      return nextId;
    },
    cancel: (handle) => {
      queue = queue.filter((pending) => pending.id !== handle);
    },
  };
  /** Let every read already started finish, including the wait it asks for at its end. */
  async function settle(): Promise<void> {
    while (inFlight.length > 0) {
      const running = inFlight;
      inFlight = [];
      await Promise.all(running);
    }
  }
  function earliest(): Pending | undefined {
    queue.sort((a, b) => a.at - b.at || a.id - b.id);
    return queue[0];
  }
  /** Fire the earliest wait, moving the clock to it. False when nothing is waiting. */
  async function step(): Promise<boolean> {
    await settle();
    const next = earliest();
    if (!next) return false;
    queue.shift();
    now = next.at;
    inFlight.push(next.tick());
    await settle();
    return true;
  }
  return {
    timers,
    now: () => now,
    pending: () => queue.length,
    step,
    /** Fire every wait due within `ms` from now, then stand the clock there. */
    async advance(ms: number): Promise<void> {
      const until = now + ms;
      await settle();
      for (let next = earliest(); next && next.at <= until; next = earliest()) {
        await step();
      }
      now = until;
    },
  };
}

const BOT: ControlState = {
  holder: "bot",
  since: "2026-09-02T00:00:00Z",
  requested: false,
};

/** One read to learn the state, then the run of identical ones that settles it. */
const READS_TO_SETTLE = SETTLED_READS + 1;

/** Far more reads than any settling loop makes: a loop still asking after this never settles. */
const RUNAWAY = 200;

let requests = 0;
let answer: () => Response;
let originalFetch: typeof fetch;
let clock: ReturnType<typeof handClock>;

/** A distinct computer per test, so no test can inherit another's loop. */
let counter = 0;
const nextComputer = () => `computer-${++counter}`;

/** Run the loop until it stops asking, and answer with how many times it has asked. */
async function quiet(): Promise<number> {
  for (let steps = 0; steps < RUNAWAY; steps += 1) {
    if (!(await clock.step())) return requests;
  }
  throw new Error(`the loop was still asking after ${RUNAWAY} reads`);
}

beforeEach(() => {
  requests = 0;
  clock = handClock();
  answer = () => new Response(JSON.stringify(BOT), { status: 200 });
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async () => {
    requests += 1;
    return answer();
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Watch on the hand clock. */
function watch(
  computerId: string,
  isLive: () => boolean,
  onState: (state: ControlState) => void = () => {},
  intervalMs = 0,
): () => void {
  return watchControl(
    computerId,
    { isLive, onState },
    intervalMs,
    clock.timers,
  );
}

/** Watch, run the body, and always let go — a leaked loop would poison the next test. */
async function watching(
  computerId: string,
  isLive: () => boolean,
  body: () => Promise<void>,
  intervalMs = 0,
): Promise<void> {
  const stop = watch(computerId, isLive, () => {}, intervalMs);
  try {
    await body();
  } finally {
    stop();
  }
}

describe("the shared control poll", () => {
  test("stops asking once the answer has come back the same enough times", async () => {
    const seen: ControlState[] = [];
    const stop = watch(
      nextComputer(),
      () => false,
      (state) => seen.push(state),
    );
    try {
      expect(await quiet()).toBe(READS_TO_SETTLE);
      // Every read reached the card; settling is the loop stopping, not answers being dropped.
      expect(seen.length).toBe(READS_TO_SETTLE);
    } finally {
      stop();
    }
  });

  test("keeps asking while a card says it is live", async () => {
    await watching(
      nextComputer(),
      () => true,
      async () => {
        // Many times the reads that would settle it, and every one of them asked for another.
        for (let read = 0; read < READS_TO_SETTLE * 5; read += 1) {
          expect(await clock.step()).toBe(true);
        }
        expect(requests).toBe(READS_TO_SETTLE * 5 + 1);
        expect(clock.pending()).toBe(1);
      },
    );
  });

  test("a changed answer restarts the count", async () => {
    let holder: ControlState["holder"] = "bot";
    answer = () =>
      new Response(JSON.stringify({ ...BOT, holder }), { status: 200 });

    await watching(
      nextComputer(),
      () => false,
      async () => {
        expect(await quiet()).toBe(READS_TO_SETTLE);
        holder = "human";
        // Nothing wakes it on its own; a state change is only seen because something poked it.
        expect(await quiet()).toBe(READS_TO_SETTLE);
      },
    );
  });

  test("a poke wakes a settled loop", async () => {
    const computerId = nextComputer();
    await watching(
      computerId,
      () => false,
      async () => {
        expect(await quiet()).toBe(READS_TO_SETTLE);
        pokeControl(computerId);
        // A poke buys another full run of identical reads. One fewer than the first time, because
        // the read it wakes on is compared against what the loop already had.
        expect(await quiet()).toBe(READS_TO_SETTLE + SETTLED_READS);
      },
    );
  });

  test("nine cards on one computer are one loop, not nine", async () => {
    const computerId = nextComputer();
    const stops = Array.from({ length: 9 }, () =>
      watch(computerId, () => false),
    );
    try {
      expect(activeControlPolls()).toBe(1);
      // Nine loops would have asked nine times per interval; one asks once.
      expect(await quiet()).toBe(READS_TO_SETTLE);
    } finally {
      for (const stop of stops) stop();
    }
    expect(activeControlPolls()).toBe(0);
  });

  test("a deployment with no control surface is asked exactly once", async () => {
    answer = () => new Response("null", { status: 404 });
    // `isLive` is true throughout: absence outranks it, because a 404 a second for the life of the
    // tab reads as an outage rather than as a deployment that has no computer.
    await watching(
      nextComputer(),
      () => true,
      async () => {
        expect(await quiet()).toBe(1);
      },
    );
  });

  /*
   * MEASURED 2026-09-10 (audit A4, finding 4): with the API stopped, a read answered
   * `{state: null}`, which counted as neither a change nor a repeat, so the loop never settled and
   * asked once a second for the whole outage — twelve 500s in twelve seconds — and was the first
   * thing waiting at the door when the server came back.
   */
  test("a failing read counts as nothing new, and each one waits longer than the last", async () => {
    answer = () => new Response("{}", { status: 500 });
    const stamps: number[] = [];
    globalThis.fetch = stubFetch(async () => {
      stamps.push(clock.now());
      requests += 1;
      return answer();
    });
    const gaps = () =>
      stamps.slice(1).map((at, index) => at - (stamps[index] as number));
    // Live throughout, so nothing but the backoff decides the rhythm.
    await watching(
      nextComputer(),
      () => true,
      async () => {
        await clock.advance(300);
        // A healthy loop at a 10ms base makes thirty reads in 300ms; a doubling one makes five,
        // and the first failure already waits twice the base.
        expect(stamps).toEqual([0, 20, 60, 140, 300]);
        expect(gaps()).toEqual([20, 40, 80, 160]);
        // And it doubles up to the outage cap, not past it.
        for (let read = 0; read < 30; read += 1) await clock.step();
        expect(gaps().at(-1)).toBe(MAX_FAILURE_INTERVAL_MS);
        expect(Math.max(...gaps())).toBe(MAX_FAILURE_INTERVAL_MS);
      },
      10,
    );
  });

  test("a failing read settles a card that has no reason to stay awake", async () => {
    answer = () => new Response("{}", { status: 500 });
    await watching(
      nextComputer(),
      () => false,
      async () => {
        // Not one read per second forever: `SETTLED_READS` failures, then silence.
        expect(await quiet()).toBeLessThanOrEqual(SETTLED_READS + 1);
      },
    );
  });

  test("a request that throws is a failed read, not the end of the loop", async () => {
    globalThis.fetch = stubFetch(async () => {
      requests += 1;
      throw new TypeError("Failed to fetch");
    });
    const computerId = nextComputer();
    await watching(
      computerId,
      () => false,
      async () => {
        expect(await quiet()).toBeLessThanOrEqual(SETTLED_READS + 1);
        // And a poke still wakes it: the loop is settled, not dead.
        answer = () => new Response(JSON.stringify(BOT), { status: 200 });
        globalThis.fetch = stubFetch(async () => {
          requests += 1;
          return answer();
        });
        const before = requests;
        pokeControl(computerId);
        expect(await quiet()).toBeGreaterThan(before);
      },
    );
  });

  test("the last card leaving takes the loop with it", async () => {
    const stop = watch(nextComputer(), () => true);
    for (let read = 0; read < READS_TO_SETTLE * 2; read += 1) {
      expect(await clock.step()).toBe(true);
    }
    const atStop = requests;
    stop();

    expect(activeControlPolls()).toBe(0);
    // The wait it had asked for is gone with it, so nothing is left to fire.
    expect(clock.pending()).toBe(0);
    expect(await quiet()).toBe(atStop);
  });
});
