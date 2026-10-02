/**
 * The first page of a conversation is read until it is in (`lib/turns/thread-store.ts`).
 *
 * Reproduced 2026-10-02, before the store was changed: one failed read marked the page unreadable
 * and nothing ever read it again, and a later `refresh()` appended what it found under whatever the
 * stream had brought, without saying the page was in or that there was more above it.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import type { HistoryPage } from "@/lib/turns/client";
import type { TurnFrame } from "@/lib/turns/frames";
import { createThreadStore } from "@/lib/turns/thread-store";

const asked: Message = { id: "u1", role: "user", content: "날씨 알려줘" };
const answered: Message = {
  id: "a1",
  role: "assistant",
  content: "내일은 맑고 최고 26°예요.",
};
const page = (messages: Message[], hasOlder = false): HistoryPage => ({
  messages,
  times: {},
  seqs: Object.fromEntries(
    messages.map((message, index) => [message.id, index + 41]),
  ),
  oldestSeq: messages.length ? 41 : null,
  newestSeq: messages.length ? messages.length + 40 : null,
  hasOlder,
});

type Wait = { ms: number; run: () => void; cancelled: boolean; fired: boolean };

/**
 * A store whose reads are answered from a list, the last answer for good, and whose waits are held
 * until the test lets one go.
 */
function harness(answers: Array<HistoryPage | null>) {
  let onFrame: ((frame: TurnFrame) => void) | null = null;
  let reads = 0;
  let nudges = 0;
  const waits: Wait[] = [];
  const store = createThreadStore("thread-1", {
    readHistory: async () =>
      answers[Math.min(reads++, answers.length - 1)] ?? null,
    watchTurn: (_thread, handlers) => {
      onFrame = handlers.onFrame;
      return {
        close: () => {},
        nudge: () => {
          nudges += 1;
        },
      };
    },
    later: (run, ms) => {
      const wait: Wait = { ms, run, cancelled: false, fired: false };
      waits.push(wait);
      return () => {
        wait.cancelled = true;
      };
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    store,
    frame: (value: TurnFrame) => onFrame?.(value),
    reads: () => reads,
    nudges: () => nudges,
    /** The waits asked for so far, in milliseconds. */
    waited: () => waits.map((wait) => wait.ms),
    /** The waits still to come: neither let go nor called off. */
    pending: () => waits.filter((wait) => !wait.cancelled && !wait.fired),
    /** The newest wait runs out, and what it starts is given time to finish. */
    elapse: async () => {
      const wait = waits.findLast((held) => !held.cancelled && !held.fired);
      if (!wait) throw new Error("nothing is waiting");
      wait.fired = true;
      wait.run();
      await settle();
    },
    settle,
  };
}

describe("a first page that cannot be read", () => {
  test("is read again on the stream's backoff, until it is in", async () => {
    const { store, waited, pending, elapse, reads } = harness([
      null,
      null,
      null,
      page([asked, answered], true),
    ]);
    await store.open();
    expect(waited()).toEqual([500]);
    // Not in: nothing that waits for the page — words kept on this device — may go yet.
    expect(store.snapshot()).toMatchObject({ loaded: false, unreadable: true });

    await elapse();
    expect(waited()).toEqual([500, 1000]);
    await elapse();
    expect(waited()).toEqual([500, 1000, 2000]);
    expect(store.snapshot()).toMatchObject({ loaded: false, unreadable: true });

    await elapse();
    expect(reads()).toBe(4);
    expect(store.snapshot()).toMatchObject({
      loaded: true,
      unreadable: false,
      hasOlder: true,
    });
    expect(store.snapshot().messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
    ]);
    // In: nothing is left waiting to read it again.
    expect(pending()).toEqual([]);
  });

  test("waits no longer than eight seconds between reads", async () => {
    const { store, waited, elapse } = harness([null]);
    await store.open();
    for (let read = 0; read < 6; read += 1) await elapse();
    expect(waited()).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  test("다시 시도 reads at once, says it is reading, and starts the backoff over", async () => {
    const { store, waited, pending, elapse, reads, settle } = harness([null]);
    await store.open();
    await elapse();
    await elapse();
    expect(waited()).toEqual([500, 1000, 2000]);

    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.snapshot().rereading));
    void store.retry();
    // The press is answered before the read is: the button beside the line is busy.
    expect(store.snapshot().rereading).toBe(true);
    await settle();
    expect(reads()).toBe(4);
    expect(store.snapshot().rereading).toBe(false);
    expect(seen).toContain(true);
    // The two-second wait was called off, and the next is the first again.
    expect(pending().map((wait) => wait.ms)).toEqual([500]);
  });

  test("is read at once when the window comes back into view or back online", async () => {
    const { store, pending, reads, nudges, settle } = harness([
      null,
      page([asked, answered]),
    ]);
    await store.open();
    expect(reads()).toBe(1);
    store.nudge();
    await settle();
    expect(nudges()).toBe(1);
    expect(reads()).toBe(2);
    expect(store.snapshot()).toMatchObject({ loaded: true, unreadable: false });
    expect(pending()).toEqual([]);
  });

  test("stops being read when the conversation is closed", async () => {
    const { store, pending, reads } = harness([null]);
    await store.open();
    expect(pending()).toHaveLength(1);
    store.close();
    expect(pending()).toEqual([]);
    expect(reads()).toBe(1);
  });

  test("a read still out when the conversation closes starts nothing after it", async () => {
    let answer: (page: HistoryPage | null) => void = () => {};
    const waits: number[] = [];
    const store = createThreadStore("thread-1", {
      readHistory: () =>
        new Promise<HistoryPage | null>((resolve) => {
          answer = resolve;
        }),
      watchTurn: () => ({ close: () => {}, nudge: () => {} }),
      later: (_run, ms) => {
        waits.push(ms);
        return () => {};
      },
    });
    const opening = store.open();
    store.close();
    answer(null);
    await opening;
    expect(waits).toEqual([]);
  });

  test("opened, closed and opened again — a development double-mount — is read on one schedule", async () => {
    const { store, pending, reads, settle } = harness([null]);
    await store.open();
    store.close();
    await store.open();
    await settle();
    expect(reads()).toBe(2);
    expect(pending().map((wait) => wait.ms)).toEqual([500]);
  });
});

describe("a page read by another road on a store that never loaded", () => {
  const turn = { id: "t1", status: "running" as const, asked: ["u2"] };
  const live: Message = { id: "u2", role: "user", content: "그럼 모레는?" };

  test("a refresh completes the open: the page first, what the stream brought after it", async () => {
    const { store, frame, pending } = harness([
      null,
      page([asked, answered], true),
    ]);
    await store.open();
    frame({
      seq: 3,
      kind: "snapshot",
      epoch: "e1",
      turn,
      messages: [live],
      waiting: [],
    });
    expect(store.snapshot().messages.map((message) => message.id)).toEqual([
      "u2",
    ]);

    await store.refresh();
    expect(store.snapshot()).toMatchObject({
      loaded: true,
      unreadable: false,
      hasOlder: true,
    });
    expect(store.snapshot().messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
    expect(pending()).toEqual([]);
  });

  test("a refresh that finds nothing new still completes the open", async () => {
    const { store, frame } = harness([null, page([asked], true)]);
    await store.open();
    frame({
      seq: 3,
      kind: "snapshot",
      epoch: "e1",
      turn: { ...turn, asked: ["u1"] },
      messages: [asked],
      waiting: [],
    });
    await store.refresh();
    expect(store.snapshot()).toMatchObject({
      loaded: true,
      unreadable: false,
      hasOlder: true,
    });
    // And the page above can be asked for: the cursor the first page brings is held.
    await store.loadOlder();
    expect(store.snapshot().loadingOlder).toBe(false);
  });

  test("the page a restarted server's snapshot reads completes the open too", async () => {
    const { store, frame, pending, settle } = harness([
      null,
      page([asked, answered], true),
    ]);
    await store.open();
    frame({
      seq: 3,
      kind: "snapshot",
      epoch: "e1",
      turn,
      messages: [live],
      waiting: [],
    });
    // The server restarted: another process, which knows no turn.
    frame({
      seq: 0,
      kind: "snapshot",
      epoch: "e2",
      turn: null,
      messages: [],
      waiting: [],
    });
    await settle();
    expect(store.snapshot()).toMatchObject({
      loaded: true,
      unreadable: false,
      hasOlder: true,
    });
    expect(store.snapshot().messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
    ]);
    expect(pending()).toEqual([]);
  });
});
