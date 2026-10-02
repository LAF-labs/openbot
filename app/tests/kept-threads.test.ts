/**
 * A CONVERSATION IS KEPT WHILE THE PERSON LOOKS AT ANOTHER PLACE (`lib/turns/kept-threads.ts`).
 *
 * Pressed on the running app, 2026-10-02: from 대화 to 소식 and back. The conversation was built
 * again from nothing — the Bot's greeting drawn first, "안녕하세요, 저는 새벽이에요", for a third of a
 * second on the local stack, then the history read again and the rows cascading in. The screen a
 * person returns to most said hello again every time.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  distrustKeptThreads,
  forgetKeptThreads,
  holdThread,
  KEPT_FOR_MS,
  releaseThread,
  threadFor,
} from "@/lib/turns/kept-threads";

type Wait = { ms: number; run: () => void; cancelled: boolean };

/** Stores that only count what is asked of them, and waits the test lets go by hand. */
function harness() {
  const made: {
    id: string;
    opens: number;
    closes: number;
    resumes: number;
  }[] = [];
  const waits: Wait[] = [];
  const deps = {
    create: (threadId: string) => {
      const record = { id: threadId, opens: 0, closes: 0, resumes: 0 };
      made.push(record);
      return {
        open: async () => {
          record.opens += 1;
        },
        close: () => {
          record.closes += 1;
        },
        resume: () => {
          record.resumes += 1;
        },
      };
    },
    later: (run: () => void, ms: number) => {
      const wait: Wait = { ms, run, cancelled: false };
      waits.push(wait);
      return () => {
        wait.cancelled = true;
      };
    },
  };
  const elapse = () => {
    for (const wait of waits.splice(0)) if (!wait.cancelled) wait.run();
  };
  return { deps, made, waits, elapse };
}

afterEach(() => forgetKeptThreads());

describe("a conversation on screen", () => {
  test("is opened once, by the screen that holds it — not by asking for it", () => {
    const { deps, made } = harness();
    const store = threadFor("thread-1", deps);
    // A render that is thrown away asks and holds nothing: nothing is opened for it.
    expect(threadFor("thread-1", deps)).toBe(store);
    expect(made).toHaveLength(1);
    expect(made[0]?.opens).toBe(0);
    holdThread("thread-1", deps);
    expect(made[0]?.opens).toBe(1);
  });

  test("is not closed and opened again by a screen that mounts twice in a breath", () => {
    const { deps, made, waits } = harness();
    threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    releaseThread("thread-1", deps);
    holdThread("thread-1", deps);
    expect(made[0]).toMatchObject({ opens: 1, closes: 0 });
    expect(waits.every((wait) => wait.cancelled)).toBe(true);
    // The second hold is a coming back like any other: the store is told to resume.
    expect(made[0]?.resumes).toBe(1);
  });
});

/*
 * 다시 불러오기, and leaving and coming back, both read a conversation again while its store was made
 * by the screen. Kept, the same rows that had just failed to draw were handed back for ten minutes.
 */
describe("after a part of the screen failed to draw", () => {
  test("a conversation no screen is showing is closed at once, and the next look reads it again", () => {
    const { deps, made, waits } = harness();
    threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    releaseThread("thread-1", deps);

    distrustKeptThreads();
    expect(made[0]?.closes).toBe(1);
    expect(waits.every((wait) => wait.cancelled)).toBe(true);

    const again = threadFor("thread-1", deps);
    expect(made).toHaveLength(2);
    expect(holdThread("thread-1", deps, again)).toBe(false);
    expect(made[1]).toMatchObject({ opens: 1, closes: 0 });
  });

  test("one a screen is showing stays open under it, and is not kept when that screen leaves", () => {
    const { deps, made, waits } = harness();
    threadFor("thread-1", deps);
    holdThread("thread-1", deps);

    distrustKeptThreads();
    expect(made[0]).toMatchObject({ opens: 1, closes: 0 });

    releaseThread("thread-1", deps);
    expect(made[0]?.closes).toBe(1);
    expect(waits).toHaveLength(0);
    threadFor("thread-1", deps);
    expect(made).toHaveLength(2);
  });

  test("a conversation looked at afterwards is kept as usual", () => {
    const { deps, made, waits } = harness();
    distrustKeptThreads();
    threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    releaseThread("thread-1", deps);
    expect(made[0]?.closes).toBe(0);
    expect(waits.map((wait) => wait.ms)).toEqual([KEPT_FOR_MS]);
  });
});

describe("a conversation the person has left for another place", () => {
  test("is kept as it is, and is the same one when they come back", () => {
    const { deps, made } = harness();
    const store = threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    releaseThread("thread-1", deps);
    expect(made[0]?.closes).toBe(0);
    expect(threadFor("thread-1", deps)).toBe(store);
  });

  // What resuming does — the stream asked how the turn stands, the page read under its answer — is
  // the store's, and is in `thread-store-first-page.test.ts`.
  test("coming back tells it to resume, once, and opens nothing again", () => {
    const { deps, made } = harness();
    threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    expect(made[0]?.resumes).toBe(0);
    releaseThread("thread-1", deps);
    expect(holdThread("thread-1", deps)).toBe(true);
    expect(made[0]).toMatchObject({ opens: 1, resumes: 1 });
  });

  test("a second screen showing it at the same time does not resume it again", () => {
    const { deps, made } = harness();
    threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    holdThread("thread-1", deps);
    expect(made[0]).toMatchObject({ opens: 1, resumes: 0 });
  });

  test("is let go of after a while, and the next visit starts a new one", () => {
    const { deps, made, waits, elapse } = harness();
    const store = threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    releaseThread("thread-1", deps);
    expect(waits.at(-1)?.ms).toBe(KEPT_FOR_MS);
    elapse();
    expect(made[0]?.closes).toBe(1);
    const next = threadFor("thread-1", deps);
    expect(next).not.toBe(store);
    expect(holdThread("thread-1", deps)).toBe(false);
    expect(made[1]?.opens).toBe(1);
  });

  test("is not let go of while another screen still holds it", () => {
    const { deps, made, waits } = harness();
    threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    holdThread("thread-1", deps);
    releaseThread("thread-1", deps);
    expect(waits.filter((wait) => !wait.cancelled)).toHaveLength(0);
    expect(made[0]?.closes).toBe(0);
  });
});

describe("a screen that still holds a conversation everything else has forgotten", () => {
  /*
   * Signing out forgets what was kept while a conversation's screen may still be on it, and in
   * development every effect is torn down and set up again. The screen has the store in its hand:
   * holding by the conversation's name alone made a second store that no screen was reading, and
   * left the screen with a closed one.
   */
  test("holds the one it has: it is opened again, and no second one is made", () => {
    const { deps, made } = harness();
    const store = threadFor("thread-1", deps);
    holdThread("thread-1", deps, store);
    forgetKeptThreads();
    expect(made[0]?.closes).toBe(1);
    holdThread("thread-1", deps, store);
    expect(made).toHaveLength(1);
    expect(made[0]?.opens).toBe(2);
    expect(threadFor("thread-1", deps)).toBe(store);
  });

  test("letting go of a store that is no longer the kept one lets go of nothing", () => {
    const { deps, made, waits } = harness();
    const old = threadFor("thread-1", deps);
    holdThread("thread-1", deps, old);
    forgetKeptThreads();
    const next = threadFor("thread-1", deps);
    holdThread("thread-1", deps, next);
    releaseThread("thread-1", deps, old);
    expect(waits.filter((wait) => !wait.cancelled)).toHaveLength(0);
    expect(made[1]).toMatchObject({ opens: 1, closes: 0 });
  });
});

describe("signing out", () => {
  test("closes every conversation that was being kept, held or not", () => {
    const { deps, made, waits } = harness();
    threadFor("thread-1", deps);
    holdThread("thread-1", deps);
    threadFor("thread-2", deps);
    holdThread("thread-2", deps);
    releaseThread("thread-2", deps);
    forgetKeptThreads();
    expect(made.map((store) => store.closes)).toEqual([1, 1]);
    expect(waits.every((wait) => wait.cancelled)).toBe(true);
    // And what is asked for next is a new one.
    threadFor("thread-1", deps);
    expect(made).toHaveLength(3);
  });
});
