import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  activeControlPolls,
  pokeControl,
  SETTLED_READS,
  watchControl,
} from "../src/components/computer/control-poll";
import type { ControlState } from "../src/components/computer/take-the-wheel";
import { stubFetch } from "./support/fetch";

/**
 * The loop a transcript used to run one of per computer tool call.
 *
 * `ComputerView` mounts once beside the conversation and again on every browser action in the
 * thread, and the control read is 1 Hz. Nine cards meant nine requests a second to one endpoint,
 * forever, whether or not anything on the screen was moving. Both halves of the fix are asserted
 * here, because neither is visible from the component: that the cards share one loop, and that it
 * stops once the answer stops changing.
 *
 * Counted rather than timed. The loop's interval is set to zero and the assertions wait for it to
 * go quiet, so nothing here turns on how fast the machine running it happens to be.
 */

const BOT: ControlState = {
  holder: "bot",
  since: "2026-09-02T00:00:00Z",
  requested: false,
};

/** One read to learn the state, then the run of identical ones that settles it. */
const READS_TO_SETTLE = SETTLED_READS + 1;

let requests = 0;
let answer: () => Response;
let originalFetch: typeof fetch;

/** A distinct computer per test, so no test can inherit another's loop. */
let counter = 0;
const nextComputer = () => `computer-${++counter}`;

/** Wait until the loop has stopped asking, and answer with how many times it asked. */
async function quiet(): Promise<number> {
  let previous = -1;
  while (previous !== requests) {
    previous = requests;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return requests;
}

beforeEach(() => {
  requests = 0;
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

/** Watch, run the body, and always let go — a leaked loop would poison the next test. */
async function watching(
  computerId: string,
  isLive: () => boolean,
  body: () => Promise<void>,
): Promise<void> {
  const stop = watchControl(computerId, { isLive, onState: () => {} }, 0);
  try {
    await body();
  } finally {
    stop();
  }
}

describe("the shared control poll", () => {
  test("stops asking once the answer has come back the same enough times", async () => {
    const computerId = nextComputer();
    const seen: ControlState[] = [];
    const stop = watchControl(
      computerId,
      { isLive: () => false, onState: (state) => seen.push(state) },
      0,
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
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(requests).toBeGreaterThan(READS_TO_SETTLE);
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
      watchControl(computerId, { isLive: () => false, onState: () => {} }, 0),
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

  test("the last card leaving takes the loop with it", async () => {
    const computerId = nextComputer();
    const stop = watchControl(
      computerId,
      { isLive: () => true, onState: () => {} },
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(activeControlPolls()).toBe(0);
    const afterStop = await quiet();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toBe(afterStop);
  });
});
