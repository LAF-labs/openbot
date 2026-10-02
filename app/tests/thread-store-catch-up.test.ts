/**
 * A window that resumes past the frames the server kept is sent a snapshot, not what it missed,
 * and the half it had streamed must give way to the stored answer (2026-09-27 code sprint).
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import type { HistoryPage } from "@/lib/turns/client";
import type { TurnFrame } from "@/lib/turns/frames";
import { createThreadStore } from "@/lib/turns/thread-store";

const asked: Message = { id: "u1", role: "user", content: "날씨 알려줘" };
const page = (messages: Message[]): HistoryPage => ({
  messages,
  times: {},
  seqs: Object.fromEntries(
    messages.map((message, index) => [message.id, index + 1]),
  ),
  oldestSeq: messages.length ? 1 : null,
  newestSeq: messages.length || null,
  hasOlder: false,
});

function harness(pages: HistoryPage[]) {
  let onFrame: ((frame: TurnFrame) => void) | null = null;
  let reads = 0;
  const store = createThreadStore("thread-1", {
    readHistory: async () => pages[Math.min(reads++, pages.length - 1)] ?? null,
    watchTurn: (_thread, handlers) => {
      onFrame = handlers.onFrame;
      return { close: () => {}, nudge: () => {} };
    },
  });
  const frame = (value: TurnFrame) => onFrame?.(value);
  return { store, frame, reads: () => reads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a resumed snapshot brings the stored answer over the half that was streamed", () => {
  test("same process, frames swept: the partial reply is replaced by the stored one", async () => {
    const whole: Message = {
      id: "a1",
      role: "assistant",
      content: "내일은 맑고 최고 26°예요.",
    };
    const { store, frame } = harness([page([asked]), page([asked, whole])]);
    await store.open();
    frame({
      seq: 1,
      kind: "turn",
      turn: { id: "t1", status: "running", asked: ["u1"] },
    });
    frame({
      seq: 2,
      kind: "messages",
      turn: "t1",
      messages: [{ id: "a1", role: "assistant", content: "내일은 맑" }],
    });
    // The phone came back after the turn ended and its frames were swept.
    frame({
      seq: 9,
      kind: "snapshot",
      epoch: "e1",
      turn: { id: "t1", status: "done", asked: ["u1"] },
      messages: [],
      waiting: [],
    });
    await settle();
    const reply = store
      .snapshot()
      .messages.find((message) => message.id === "a1");
    expect(reply?.content).toBe("내일은 맑고 최고 26°예요.");
  });

  test("the first snapshot of a fresh window does not read the page a second time", async () => {
    const { store, frame, reads } = harness([page([asked])]);
    await store.open();
    frame({
      seq: 3,
      kind: "snapshot",
      epoch: "e1",
      turn: null,
      messages: [],
      waiting: [],
    });
    await settle();
    expect(reads()).toBe(1);
  });
});

/*
 * Review, third round. The snapshot that starts the read brings the going turn's messages as they
 * are then, and the turn goes on while the read is out. Laid over the page as they came, they
 * rolled the answer back to where the snapshot had it: what the stream had added since was gone,
 * and the next pieces were appended to the older copy until the message's last frame put it right.
 */
describe("a turn that goes on while the page is being read", () => {
  /** A store whose reads after the first stay out until the test lets them back. */
  function slowReads(first: HistoryPage, later: HistoryPage) {
    let onFrame: ((frame: TurnFrame) => void) | null = null;
    let reads = 0;
    let answer = () => {};
    const store = createThreadStore("thread-1", {
      readHistory: async () => {
        reads += 1;
        if (reads === 1) return first;
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return later;
      },
      watchTurn: (_thread, handlers) => {
        onFrame = handlers.onFrame;
        return { close: () => {}, nudge: () => {} };
      },
    });
    return {
      store,
      frame: (value: TurnFrame) => onFrame?.(value),
      answerRead: async () => {
        answer();
        await settle();
      },
    };
  }
  const answerOf = (store: ReturnType<typeof createThreadStore>) =>
    store.snapshot().messages.find((message) => message.id === "a1")?.content;
  const going = { id: "t1", status: "running" as const, asked: ["u1"] };
  const added = (seq: number, delta: string): TurnFrame => ({
    seq,
    kind: "event",
    turn: "t1",
    event: { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta },
  });

  test("keeps what the stream added after the snapshot, when somebody came back mid-answer", async () => {
    const { store, frame, answerRead } = slowReads(
      page([asked]),
      page([asked]),
    );
    await store.open();
    frame({
      seq: 3,
      kind: "snapshot",
      epoch: "e1",
      turn: going,
      messages: [],
      waiting: [],
    });

    store.resume();
    frame({
      seq: 5,
      kind: "snapshot",
      epoch: "e1",
      turn: going,
      messages: [{ id: "a1", role: "assistant", content: "내일은" }],
      waiting: [],
    });
    // The page is still being read, and the answer goes on arriving.
    frame(added(6, " 맑고"));
    frame(added(7, " 최고 26°예요."));
    expect(answerOf(store)).toBe("내일은 맑고 최고 26°예요.");

    await answerRead();
    expect(answerOf(store)).toBe("내일은 맑고 최고 26°예요.");
    // And the next piece lands on the whole of it.
    frame(added(8, " 우산은 필요 없어요."));
    expect(answerOf(store)).toBe(
      "내일은 맑고 최고 26°예요. 우산은 필요 없어요.",
    );
  });

  /*
   * Review, fifth round. A restart's read was still out when the stream spoke again and brought a
   * new turn. Answering late, it put the page in place of everything, with the going messages of
   * the snapshot that had started it — none — and the new turn's question and what had been said
   * of its answer went with what the dead process had left.
   */
  test("a restart's page, answered late, keeps the turn a later snapshot brought — and drops what the dead process left", async () => {
    const pieced: Message = { id: "h1", role: "assistant", content: "내일은" };
    const asking: Message = { id: "u2", role: "user", content: "그럼 모레는?" };
    const { store, frame, answerRead } = slowReads(
      page([asked]),
      page([asked]),
    );
    await store.open();
    frame({
      seq: 3,
      kind: "snapshot",
      epoch: "e1",
      turn: going,
      messages: [pieced],
      waiting: [],
    });

    // The server restarted: nothing is going, and the page is asked for.
    frame({
      seq: 0,
      kind: "snapshot",
      epoch: "e2",
      turn: null,
      messages: [],
      waiting: [],
    });
    // Before it answers the stream speaks again, with a turn that has begun since.
    frame({
      seq: 0,
      kind: "snapshot",
      epoch: "e2",
      turn: { id: "t2", status: "running", asked: ["u2"] },
      messages: [asking, { id: "a2", role: "assistant", content: "모레는" }],
      waiting: [],
    });
    frame({
      seq: 1,
      kind: "event",
      turn: "t2",
      event: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a2",
        delta: " 비가 와요.",
      },
    });

    await answerRead();
    const held = store.snapshot().messages;
    expect(held.map((message) => message.id)).toEqual(["u1", "u2", "a2"]);
    expect(held.find((message) => message.id === "a2")?.content).toBe(
      "모레는 비가 와요.",
    );
  });

  test("and the same for a window that resumed past the frames the server kept", async () => {
    const { store, frame, answerRead } = slowReads(
      page([asked]),
      page([asked]),
    );
    await store.open();
    frame({ seq: 1, kind: "turn", turn: going });
    // Past what the server still held: a snapshot, with the answer as far as it had got.
    frame({
      seq: 40,
      kind: "snapshot",
      epoch: "e1",
      turn: going,
      messages: [{ id: "a1", role: "assistant", content: "내일은" }],
      waiting: [],
    });
    frame(added(41, " 맑아요."));
    await answerRead();
    expect(answerOf(store)).toBe("내일은 맑아요.");
  });
});

/*
 * A PAGE THAT DOES NOT REACH WHAT IS HELD. More than a page written while this window heard
 * nothing — a laptop asleep through a long turn, an evening on the phone — and the newest page
 * begins past everything held. Laid under the old rows all the same, it read as one conversation:
 * probed with rows 101–180 over a store holding 1–80, the store held 160 rows and said nothing was
 * above. Rows 81–100 were in neither and were never asked for, because the page above is asked for
 * from the oldest row held.
 */
describe("a page that does not reach what is held", () => {
  /** A record of rows numbered from 1, read a page of eighty at a time, as the server reads it. */
  function record(rows: number) {
    let written = rows;
    const read = (before: number | null): HistoryPage => {
      const end = before === null ? written : Math.min(written, before - 1);
      const start = Math.max(1, end - 79);
      const messages: Message[] =
        end < start
          ? []
          : Array.from({ length: end - start + 1 }, (_, index) => ({
              id: `r${start + index}`,
              role: "user" as const,
              content: `${start + index}`,
            }));
      return {
        messages,
        times: {},
        seqs: Object.fromEntries(
          messages.map((message, index) => [message.id, start + index]),
        ),
        oldestSeq: messages.length ? start : null,
        newestSeq: messages.length ? end : null,
        hasOlder: start > 1,
      };
    };
    return {
      write: (count: number) => {
        written += count;
      },
      read,
    };
  }

  /** A store over that record, whose reads can be kept out and let back one at a time. */
  function over(rows: number) {
    const kept = record(rows);
    let onFrame: ((frame: TurnFrame) => void) | null = null;
    let nudges = 0;
    let isHolding = false;
    const out: Array<() => void> = [];
    const asked: (number | null)[] = [];
    const store = createThreadStore("thread-1", {
      readHistory: async (_thread, before) => {
        asked.push(before);
        // The record as it stood when the server read it, however late the answer arrives.
        const read = kept.read(before);
        if (isHolding) {
          await new Promise<void>((resolve) => {
            out.push(resolve);
          });
        }
        return read;
      },
      watchTurn: (_thread, handlers) => {
        onFrame = handlers.onFrame;
        return {
          close: () => {},
          nudge: () => {
            nudges += 1;
          },
        };
      },
    });
    const idle: TurnFrame = {
      seq: 0,
      kind: "snapshot",
      epoch: "e1",
      turn: null,
      messages: [],
      waiting: [],
    };
    return {
      store,
      write: kept.write,
      frame: (value: TurnFrame) => onFrame?.(value),
      idle,
      asked,
      nudges: () => nudges,
      hold: () => {
        isHolding = true;
      },
      /** Let the read that went out `nth` (of those kept out) answer. */
      answer: async (nth: number) => {
        out[nth]?.();
        await settle();
      },
      ids: () => store.snapshot().messages.map((message) => message.id),
    };
  }

  const stretch = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => `r${from + index}`);
  /** The same rows as the stream brings them: the record's ids, before any page has. */
  const rows = (from: number, to: number): Message[] =>
    stretch(from, to).map((id) => ({
      id,
      role: "user" as const,
      content: id.slice(1),
    }));

  test("is put in place of it, and what lies between can be scrolled to", async () => {
    const { store, write, frame, idle, asked, ids } = over(80);
    await store.open();
    frame(idle);
    await settle();
    expect(ids()).toEqual(stretch(1, 80));

    // A hundred rows while nobody looked, and somebody comes back.
    write(100);
    store.resume();
    frame(idle);
    await settle();
    expect(ids()).toEqual(stretch(101, 180));
    expect(store.snapshot().hasOlder).toBe(true);

    // Scrolling up reads the page above the one now held — the rows that were in neither.
    await store.loadOlder();
    expect(asked.at(-1)).toBe(101);
    expect(ids()).toEqual(stretch(21, 180));
  });

  test("even when the two share a row: the going turn's question, held and stored", async () => {
    const { store, write, frame, idle, ids } = over(80);
    await store.open();
    frame(idle);
    await settle();

    // A hundred rows, and then a question another window asked: the record's 181st row.
    write(101);
    const going = { id: "t9", status: "running" as const, asked: ["r181"] };
    store.resume();
    frame({
      ...idle,
      seq: 4,
      turn: going,
      messages: [
        { id: "r181", role: "user", content: "181" },
        { id: "a9", role: "assistant", content: "내일은" },
      ],
    });
    frame({
      seq: 5,
      kind: "event",
      turn: "t9",
      event: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a9",
        delta: " 맑아요.",
      },
    });
    await settle();

    // The page, and the answer as far as the stream has brought it — which the record has not.
    expect(ids()).toEqual([...stretch(102, 181), "a9"]);
    expect(store.snapshot().messages.at(-1)?.content).toBe("내일은 맑아요.");
    expect(store.snapshot().hasOlder).toBe(true);
  });

  /*
   * The screen reads the record again when the turn it was watching is over, and for somebody who
   * left mid-turn that is the snapshot that says so: two reads of the same page, out together. The
   * turn's own, landing first, laid the page under the old rows — and the read under the snapshot
   * then found its first row held and nothing to put right.
   */
  test("whichever read lands first: the turn's own waits for the one under the snapshot", async () => {
    const { store, write, frame, idle, hold, answer, asked, nudges, ids } =
      over(80);
    await store.open();
    frame(idle);
    await settle();

    write(100);
    hold();
    const refreshed = store.refresh();
    // Its read is out before the stream speaks again.
    await settle();
    store.resume();
    frame(idle);
    const asks = nudges();

    // Its page, landing first, is not laid — and the stream is not asked a second time for it.
    await answer(0);
    expect(ids()).toEqual(stretch(1, 80));
    expect(nudges()).toBe(asks);
    expect(store.snapshot().epoch).toBe("e1");

    // The page under the snapshot is put in place, and that is the page the turn's own asked for.
    const reads = asked.length;
    await answer(1);
    await refreshed;
    expect(ids()).toEqual(stretch(101, 180));
    expect(store.snapshot().hasOlder).toBe(true);
    expect(asked.length).toBe(reads);
  });

  /*
   * It stood aside, and that lost what it was asked for: a routine delivered while the snapshot's
   * read was out, that read came back without the delivery, and nothing read again — while the
   * caller, told the read was done, marked the conversation read.
   */
  test("asked for while the snapshot's read is out, it reads after that one — and is not done until it has", async () => {
    const { store, write, frame, idle, hold, answer, asked, ids } = over(10);
    await store.open();
    frame(idle);
    await settle();

    hold();
    store.resume();
    frame(idle);
    // A routine delivers after that read went out, and the screen asks for the record.
    write(1);
    let isDone = false;
    const refreshed = store.refresh().then(() => {
      isDone = true;
    });
    await settle();
    expect(asked.length).toBe(2);

    // The snapshot's read lands, as the record stood when it went out: without the delivery.
    await answer(0);
    expect(ids()).toEqual(stretch(1, 10));
    expect(isDone).toBe(false);
    // And only then is the page read for what was asked.
    expect(asked.length).toBe(3);
    await answer(1);
    await refreshed;
    expect(ids()).toEqual(stretch(1, 11));
  });

  test("asked for twice before its read has gone out it reads once, and once more only for a call made after", async () => {
    const { store, write, frame, idle, hold, answer, asked, ids } = over(10);
    await store.open();
    frame(idle);
    await settle();

    hold();
    store.resume();
    frame(idle);
    // The turn's end and the roster's news of it, a moment apart: both wait for the snapshot's page.
    const first = store.refresh();
    const second = store.refresh();
    await settle();
    expect(asked.length).toBe(2);
    await answer(0);
    // One read for the two of them.
    expect(asked.length).toBe(3);
    // A routine delivers while that read is out, and the screen asks again: this one is owed its own.
    write(1);
    const third = store.refresh();
    await answer(1);
    expect(asked.length).toBe(4);
    await answer(2);
    await Promise.all([first, second, third]);
    expect(asked.length).toBe(4);
    expect(ids()).toEqual(stretch(1, 11));
  });

  test("a read that fails is made again, and the refresh is not done until a page is in", async () => {
    const waits: Array<() => void> = [];
    let isDown = true;
    const row = (id: string): Message => ({ id, role: "user", content: id });
    const whole: HistoryPage = {
      messages: [row("a"), row("b")],
      times: {},
      seqs: { a: 1, b: 2 },
      oldestSeq: 1,
      newestSeq: 2,
      hasOlder: false,
    };
    let reads = 0;
    const store = createThreadStore("thread-1", {
      readHistory: async () => {
        reads += 1;
        if (reads === 1)
          return { ...whole, messages: [row("a")], newestSeq: 1 };
        return isDown ? null : whole;
      },
      watchTurn: () => ({ close: () => {}, nudge: () => {} }),
      later: (run) => {
        waits.push(run);
        return () => {};
      },
    });
    await store.open();
    let isDone = false;
    const refreshed = store.refresh().then(() => {
      isDone = true;
    });
    await settle();
    expect(reads).toBe(2);
    expect(isDone).toBe(false);

    // Its wait runs out, and the record can be read again.
    isDown = false;
    waits.shift()?.();
    await refreshed;
    expect(reads).toBe(3);
    expect(store.snapshot().messages.map((message) => message.id)).toEqual([
      "a",
      "b",
    ]);
  });

  test("with no snapshot's read to bring it, the stream is asked again and the page under its answer is put in place", async () => {
    const { store, write, frame, idle, nudges, ids } = over(80);
    await store.open();
    frame({ ...idle, seq: 3 });
    await settle();

    write(100);
    const before = nudges();
    const refreshed = store.refresh();
    await settle();
    // Not laid under the old rows: the stream is asked how the turn stands, as on coming back.
    expect(ids()).toEqual(stretch(1, 80));
    expect(nudges()).toBe(before + 1);
    expect(store.snapshot().epoch).toBeNull();

    frame({ ...idle, seq: 3 });
    await settle();
    await refreshed;
    expect(ids()).toEqual(stretch(101, 180));
    expect(store.snapshot().epoch).toBe("e1");
  });

  /*
   * ONLY A ROW A PAGE BROUGHT COUNTS AS HELD. What the stream brings is the turns, and the record
   * is more than the turns.
   */
  test("nor does a row the stream brought make it reach: a turn missed behind one that is still going", async () => {
    const { store, write, frame, idle, asked, ids } = over(80);
    await store.open();
    frame(idle);
    await settle();

    // A short turn nobody heard — rows 81 to 84 — and a long one still going: 85 to 200.
    write(120);
    store.resume();
    frame({
      ...idle,
      seq: 9,
      turn: { id: "t9", status: "running", asked: ["r85"] },
      messages: rows(85, 200),
    });
    await settle();
    // The page begins on row 121, which the snapshot brought: held, and no page's.
    expect(ids()).toEqual(stretch(121, 200));
    expect(store.snapshot().hasOlder).toBe(true);

    await store.loadOlder();
    expect(asked.at(-1)).toBe(121);
    expect(ids()).toEqual(stretch(41, 200));
  });

  test("nor what the stream brought while it ran unbroken: a delivery early in a turn that then wrote a page of rows", async () => {
    const { store, write, frame, idle, asked, ids } = over(80);
    await store.open();
    frame(idle);
    await settle();

    // Row 81 is a routine's delivery, which is no frame. Then a turn of ninety rows, all heard.
    write(91);
    const turn = { id: "t1", status: "running" as const, asked: ["r82"] };
    frame({ seq: 1, kind: "turn", turn });
    frame({ seq: 2, kind: "messages", turn: "t1", messages: rows(82, 171) });
    frame({ seq: 3, kind: "turn", turn: { ...turn, status: "done" } });
    expect(ids()).toEqual([...stretch(1, 80), ...stretch(82, 171)]);

    // The turn's end reads the record: rows 92 to 171. The delivery is above them, in neither.
    const refreshed = store.refresh();
    await settle();
    frame({ ...idle, seq: 3 });
    await settle();
    await refreshed;
    expect(ids()).toEqual(stretch(92, 171));
    expect(store.snapshot().hasOlder).toBe(true);

    await store.loadOlder();
    expect(asked.at(-1)).toBe(92);
    expect(ids()).toEqual(stretch(12, 171));
  });

  /*
   * The words this window sent were its own until a page held them, and no page did: asked before
   * a long task, the question was still "being sent" when the lid was opened on the finished
   * answer, and the page put in place kept it — under its own answer.
   */
  test("a question the server took is above it with the rest, not under it", async () => {
    for (const told of [
      "by its answer to the send",
      "by the stream",
    ] as const) {
      const { store, write, frame, idle, ids } = over(80);
      await store.open();
      frame(idle);
      await settle();

      store.addLocal(rows(81, 81), "2026-10-03T00:00:00.000Z");
      write(1);
      if (told === "by the stream") {
        frame({
          seq: 1,
          kind: "turn",
          turn: { id: "t1", status: "running", asked: ["r81"] },
        });
      } else {
        store.sent(["r81"]);
      }
      // A hundred rows of answer while the lid was shut.
      write(100);
      store.resume();
      frame({ ...idle, seq: 5 });
      await settle();
      expect(ids()).toEqual(stretch(102, 181));
      store.close();
    }
  });

  test("and words not yet taken stay under it, last", async () => {
    const { store, write, frame, idle, ids } = over(80);
    await store.open();
    frame(idle);
    await settle();

    store.addLocal(
      [{ id: "mine", role: "user", content: "아직 보내는 중" }],
      "2026-10-03T00:00:00.000Z",
    );
    write(100);
    store.resume();
    frame(idle);
    await settle();
    expect(ids()).toEqual([...stretch(101, 180), "mine"]);
  });

  test("a page read earlier that lands later takes nothing back", async () => {
    const { store, write, frame, idle, hold, answer, ids } = over(80);
    await store.open();
    frame(idle);
    await settle();

    write(100);
    hold();
    store.resume();
    frame(idle);
    // Five more rows, and the stream speaks again before the first read has answered.
    write(5);
    store.resume();
    frame(idle);

    // The later read lands first: rows 106–185, in place of what was held.
    await answer(1);
    expect(ids()).toEqual(stretch(106, 185));
    // The earlier one was read before the stream spoke again, and is not laid: nothing goes, and
    // what it holds above is read by scrolling up.
    await answer(0);
    expect(ids()).toEqual(stretch(106, 185));
    expect(store.snapshot().hasOlder).toBe(true);
  });

  test("nor is it laid at all where everything it holds is older than what is held", async () => {
    const { store, write, frame, idle, hold, answer, ids } = over(80);
    await store.open();
    frame(idle);
    await settle();

    write(100);
    hold();
    store.resume();
    frame(idle);
    // A hundred more before the stream speaks again: the two reads share no row.
    write(100);
    store.resume();
    frame(idle);

    await answer(1);
    expect(ids()).toEqual(stretch(201, 280));
    await answer(0);
    expect(ids()).toEqual(stretch(201, 280));
    expect(store.snapshot().hasOlder).toBe(true);
  });

  /*
   * What stays over a page put in place is the turn as the stream brought it under its snapshot.
   * A read made again long after that snapshot — it failed, it waited — is answered with a record
   * the stream has not kept up with: a laptop that woke offline in the middle of a long task.
   */
  test("a read made again that cannot place what the stream brought asks the stream first", async () => {
    const kept = record(80);
    const waits: Array<() => void> = [];
    let onFrame: ((frame: TurnFrame) => void) | null = null;
    let nudges = 0;
    let isDown = false;
    const store = createThreadStore("thread-1", {
      readHistory: async (_thread, before) =>
        isDown ? null : kept.read(before),
      watchTurn: (_thread, handlers) => {
        onFrame = handlers.onFrame;
        return {
          close: () => {},
          nudge: () => {
            nudges += 1;
          },
        };
      },
      later: (run) => {
        waits.push(run);
        return () => {};
      },
    });
    const frame = (value: TurnFrame) => onFrame?.(value);
    const ids = () => store.snapshot().messages.map((message) => message.id);
    const idle: TurnFrame = {
      seq: 0,
      kind: "snapshot",
      epoch: "e1",
      turn: null,
      messages: [],
      waiting: [],
    };
    const going = { id: "t1", status: "running" as const, asked: ["r81"] };
    await store.open();
    frame(idle);
    await settle();

    // A long task: its question and its first step, heard.
    kept.write(2);
    frame({ seq: 1, kind: "turn", turn: going });
    frame({ seq: 2, kind: "messages", turn: "t1", messages: rows(81, 82) });
    // Asleep, and awake offline: the stream says the task is still going, and the read fails.
    isDown = true;
    store.resume();
    frame({ ...idle, seq: 5, turn: going, messages: rows(81, 82) });
    await settle();
    expect(waits).toHaveLength(1);

    // A hundred rows of the task later the wait runs out, and the record can be read.
    kept.write(100);
    isDown = false;
    const asks = nudges;
    waits.shift()?.();
    await settle();
    // Rows 103–182 hold nothing the stream brought: not put in place with the question under them.
    expect(ids()).toEqual(stretch(1, 82));
    expect(nudges).toBe(asks + 1);

    // The stream says how the task stands now, and the page read under that is put in place.
    frame({ ...idle, seq: 9, turn: going, messages: rows(81, 182) });
    await settle();
    expect(ids()).toEqual(stretch(103, 182));
    expect(store.snapshot().hasOlder).toBe(true);
    store.close();
  });

  test("and a page above rows that are no longer held is not laid over the ones that are", async () => {
    const { store, write, frame, idle, hold, answer, asked, ids } = over(200);
    await store.open();
    frame(idle);
    await settle();
    expect(ids()).toEqual(stretch(121, 200));

    // Scrolling up, and the page above is slow.
    hold();
    const older = store.loadOlder();
    write(100);
    store.resume();
    frame(idle);
    await answer(1);
    expect(ids()).toEqual(stretch(221, 300));

    await answer(0);
    await older;
    expect(ids()).toEqual(stretch(221, 300));
    expect(store.snapshot().loadingOlder).toBe(false);

    // The next scroll up asks for the page above what is held now.
    const next = store.loadOlder();
    await answer(2);
    await next;
    expect(asked.at(-1)).toBe(221);
    expect(ids()).toEqual(stretch(141, 300));
  });
});

/*
 * ONE RULE FOR EVERY PAGE THAT IS LAID. The record's copy of a row replaces the held one, unless
 * that row belongs to a turn still in flight or is words being sent; and where a page is put in
 * place of what is held, what stays with it is what the stream has brought since it last said how
 * things stand. Each test below is a way the store did otherwise (adversarial read and model check
 * of the kept conversation, 2026-10-03).
 */
describe("the record's copy of a row, and the stream's", () => {
  /** A store whose every read stays out until the test answers it. */
  function manual() {
    let onFrame: ((frame: TurnFrame) => void) | null = null;
    let cursor: (() => string | null) | null = null;
    const out: Array<(page: HistoryPage | null) => void> = [];
    const opened: (string | null)[] = [];
    const store = createThreadStore("thread-1", {
      readHistory: () =>
        new Promise((resolve) => {
          out.push(resolve);
        }),
      watchTurn: (_thread, handlers) => {
        onFrame = handlers.onFrame;
        cursor = handlers.cursor;
        // Where this stream starts from: null asks the server how the turn stands.
        opened.push(handlers.cursor());
        return {
          close: () => {},
          nudge: () => {
            opened.push(cursor?.() ?? null);
          },
        };
      },
    });
    return {
      store,
      frame: (value: TurnFrame) => onFrame?.(value),
      /** How many reads have gone out. */
      reads: () => out.length,
      opened,
      /** The read that went out `nth` is answered. */
      answer: async (nth: number, read: HistoryPage | null) => {
        out[nth]?.(read);
        await settle();
      },
      ids: () => store.snapshot().messages.map((message) => message.id),
      said: (id: string) =>
        store.snapshot().messages.find((message) => message.id === id)?.content,
    };
  }

  const half: Message = { id: "a1", role: "assistant", content: "내일은" };
  const whole: Message = {
    id: "a1",
    role: "assistant",
    content: "내일은 맑고 최고 26°예요.",
  };
  const going = { id: "t1", status: "running" as const, asked: ["u1"] };
  const snapshot = (
    more: Partial<Extract<TurnFrame, { kind: "snapshot" }>> = {},
  ): TurnFrame => ({
    seq: 0,
    kind: "snapshot",
    epoch: "e1",
    turn: null,
    messages: [],
    waiting: [],
    ...more,
  });

  /*
   * The first page lays what it finds under what the stream has brought. It was everything the
   * stream had ever brought: half an answer from before somebody came back, over the whole of it.
   */
  test("a first page that lands after the turn ended brings the whole answer, not the half held", async () => {
    const { store, frame, answer, reads, said } = manual();
    void store.open();
    frame(snapshot({ seq: 2, turn: going, messages: [asked, half] }));
    // The first page could not be read; somebody leaves, and comes back to a turn that is over.
    await answer(0, null);
    store.resume();
    frame(snapshot({ seq: 9, turn: { ...going, status: "done" } }));
    expect(reads()).toBe(2);
    // Read while the stream was starting over, so read once more (below) — and then it is in.
    await answer(1, page([asked, whole]));
    await answer(2, page([asked, whole]));
    expect(said("a1")).toBe(whole.content);
    expect(store.snapshot().loaded).toBe(true);
  });

  test("and a first page read across that break is read again, not put in place", async () => {
    const { store, frame, answer, reads, said, ids } = manual();
    void store.open();
    frame(snapshot({ seq: 2, turn: going, messages: [asked, half] }));
    // Still out when somebody comes back: read before the turn ended, landing after.
    store.resume();
    frame(snapshot({ seq: 9, turn: { ...going, status: "done" } }));
    await answer(0, page([asked]));
    // Not laid under the half, and not put in place of it: asked for again.
    expect(store.snapshot().loaded).toBe(false);
    expect(reads()).toBe(2);
    await answer(1, page([asked, whole]));
    expect(ids()).toEqual(["u1", "a1"]);
    expect(said("a1")).toBe(whole.content);
  });

  /*
   * The server replays only the turn's own frames to a window that reconnects late: the turn is
   * over, and nothing of what it said in between. No snapshot, so nothing read the page under one;
   * and the read at the turn's end kept every held copy as it was.
   */
  test("the page read when a turn ends replaces the half this window pieced together", async () => {
    const { store, frame, answer, said } = manual();
    void store.open();
    frame(snapshot({ seq: 2, turn: going, messages: [asked] }));
    await answer(0, page([asked]));
    frame({
      seq: 3,
      kind: "event",
      turn: "t1",
      event: { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
    });
    frame({
      seq: 4,
      kind: "event",
      turn: "t1",
      event: { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "내일은" },
    });
    // Asleep through the rest; all it is replayed on waking is that the turn is over.
    frame({ seq: 20, kind: "turn", turn: { ...going, status: "done" } });
    expect(said("a1")).toBe("내일은");

    const refreshed = store.refresh();
    await settle();
    await answer(1, page([asked, whole]));
    await refreshed;
    expect(said("a1")).toBe(whole.content);
  });

  test("but not the copy of a row whose turn is still in flight: frames are still arriving for it", async () => {
    const { store, frame, answer, said } = manual();
    void store.open();
    frame(snapshot({ seq: 2, turn: going, messages: [asked, half] }));
    await answer(0, page([asked]));
    frame({
      seq: 3,
      kind: "event",
      turn: "t1",
      event: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a1",
        delta: " 맑고 최고 26°예요. 우산은",
      },
    });
    // Something else wrote to the conversation, and the page read for it holds an older a1.
    const refreshed = store.refresh();
    await settle();
    await answer(1, page([asked, whole]));
    await refreshed;
    expect(said("a1")).toBe("내일은 맑고 최고 26°예요. 우산은");
  });

  /*
   * A restart is owed a page put in place of what was pieced together — but not one read before
   * the restart: that takes with it what the stream brought, and the dying process wrote, after
   * the read went out.
   */
  test("a restart is not settled by a page that was read before it", async () => {
    const { store, frame, answer, ids, said } = manual();
    void store.open();
    frame(snapshot({ seq: 2, turn: going, messages: [asked] }));
    await answer(0, page([asked]));
    // Somebody comes back mid-turn: a read goes out, and the answer goes on arriving.
    store.resume();
    frame(snapshot({ seq: 5, turn: going, messages: [asked, half] }));
    frame({
      seq: 6,
      kind: "event",
      turn: "t1",
      event: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a1",
        delta: " 맑고 최고 26°예요.",
      },
    });
    // The server restarts, having written what it had; the stream says so, and a read goes out.
    frame(snapshot({ epoch: "e2" }));
    // The read from before the restart lands: not laid, and the answer it never saw stays.
    await answer(1, page([asked]));
    expect(ids()).toEqual(["u1", "a1"]);
    // The restart's own read puts the record in place.
    await answer(2, page([asked, whole]));
    expect(ids()).toEqual(["u1", "a1"]);
    expect(said("a1")).toBe(whole.content);
  });

  test("nor by a page that ends before one already in: it is read again", async () => {
    const delivered: Message = {
      id: "r1",
      role: "assistant",
      content: "아침 브리핑이에요.",
    };
    const { store, frame, answer, reads, ids } = manual();
    void store.open();
    // The server restarts while the first page is still being read.
    frame(snapshot({ seq: 2 }));
    frame(snapshot({ epoch: "e2" }));
    expect(reads()).toBe(2);
    // The first page is answered late, with the record as it stands now.
    await answer(0, page([asked, whole, delivered]));
    expect(ids()).toEqual(["u1", "a1", "r1"]);
    // The restart's own read was answered before the delivery was written, and lands after.
    await answer(1, page([asked, whole]));
    expect(ids()).toEqual(["u1", "a1", "r1"]);
    // Still owed, and nothing on its way to settle it: asked for again.
    expect(reads()).toBe(3);
    await answer(2, page([asked, whole, delivered]));
    expect(ids()).toEqual(["u1", "a1", "r1"]);
  });

  /*
   * THE RECORD REWRITES A ROW IN PLACE WHILE ITS TURN RUNS: part of an answer, then the whole of
   * it, under the cursor it keeps. So two pages can hold the same rows under the same cursors and
   * say different things, and the one read earlier says less (review, sixth round).
   */
  test("a page read before the newest snapshot is not laid over the page read under it", async () => {
    const { store, frame, answer, reads, said } = manual();
    void store.open();
    frame(snapshot({ seq: 2 }));
    await answer(0, page([asked]));
    // Somebody comes back twice to a turn this window never heard: a read goes out under each.
    store.resume();
    frame(snapshot({ seq: 5 }));
    store.resume();
    frame(snapshot({ seq: 9 }));
    expect(reads()).toBe(3);
    // The later read lands first, with the whole answer.
    await answer(2, page([asked, whole]));
    expect(said("a1")).toBe(whole.content);
    // The earlier one was answered while the turn was still writing.
    await answer(1, page([asked, half]));
    expect(said("a1")).toBe(whole.content);
  });

  test("nor a page read for a refresh over the one a snapshot after it has brought", async () => {
    const { store, frame, answer, reads, said } = manual();
    void store.open();
    frame(snapshot({ seq: 2 }));
    await answer(0, page([asked]));
    // A routine delivered, and the page is read for it — still out when somebody comes back.
    const refreshed = store.refresh();
    await settle();
    expect(reads()).toBe(2);
    frame(snapshot({ seq: 9 }));
    expect(reads()).toBe(3);
    await answer(2, page([asked, whole]));
    expect(said("a1")).toBe(whole.content);
    await answer(1, page([asked, half]));
    await refreshed;
    expect(said("a1")).toBe(whole.content);
  });

  /*
   * And a page read while the turn was still writing, landing once the stream has said the turn
   * is over: the row is nobody's to protect any more, and the page holds part of it.
   */
  test("nor is an answer the stream finished replaced by a page read before its turn was over", async () => {
    const { store, frame, answer, said } = manual();
    void store.open();
    frame(snapshot({ seq: 2, turn: going, messages: [asked] }));
    await answer(0, page([asked]));
    const refreshed = store.refresh();
    await settle();
    frame({
      seq: 3,
      kind: "event",
      turn: "t1",
      event: { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
    });
    frame({
      seq: 4,
      kind: "event",
      turn: "t1",
      event: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "a1",
        delta: whole.content,
      },
    });
    frame({ seq: 5, kind: "turn", turn: { ...going, status: "done" } });
    // Answered as the record stood when it was read.
    await answer(1, page([asked, half]));
    await refreshed;
    expect(said("a1")).toBe(whole.content);

    // A page read after the turn was over is the record's word on it.
    const longer = `${whole.content} 우산은 두고 가세요.`;
    const again = store.refresh();
    await settle();
    await answer(2, page([asked, { ...whole, content: longer }]));
    await again;
    expect(said("a1")).toBe(longer);
  });

  /*
   * The page brings a row before the stream has said it: a window whose stream is behind reads the
   * record, and the frames it missed arrive after. Each piece was added to what the page had
   * brought (`behind` in `frames.ts`).
   */
  test("a row a page brought before the stream said it is neither said twice nor begun again", async () => {
    const { store, frame, answer, said } = manual();
    void store.open();
    frame(snapshot({ seq: 2, turn: going, messages: [asked] }));
    // Read late: the record holds the whole answer by now, and the stream has yet to say any.
    await answer(0, page([asked, whole]));
    const seen: unknown[] = [];
    const say = (seq: number, event: Record<string, unknown>) => {
      frame({
        seq,
        kind: "event",
        turn: "t1",
        event: event as { type: string },
      });
      seen.push(said("a1"));
    };
    say(3, { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" });
    say(4, { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "내일은" });
    say(5, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "a1",
      delta: " 맑고 최고 26°예요.",
    });
    say(6, { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: " 우산은" });
    expect(seen).toEqual([
      whole.content,
      whole.content,
      whole.content,
      `${whole.content} 우산은`,
    ]);
  });

  test("what the stream adds goes before the words this window is still sending", async () => {
    const { store, frame, answer, ids } = manual();
    void store.open();
    frame(snapshot({ seq: 2 }));
    await answer(0, page([asked, whole]));
    store.addLocal(
      [{ id: "mine", role: "user", content: "고마워요" }],
      "2026-10-03T00:00:00.000Z",
    );
    // Another window's turn, heard late: asked before these words were typed.
    const theirs: Message = { id: "o8", role: "user", content: "모레는요?" };
    frame({
      seq: 3,
      kind: "turn",
      turn: { id: "t8", status: "running", asked: ["o8"] },
    });
    frame({ seq: 4, kind: "messages", turn: "t8", messages: [theirs] });
    expect(ids()).toEqual(["u1", "a1", "o8", "mine"]);
  });

  /*
   * Closed and opened again — a screen handed back the store it had — it picked up where it left
   * off: its old epoch, its old cursor, a turn it believed idle.
   */
  test("opened again after a close, it is a coming back: asked afresh, and the page read under the answer", async () => {
    const { store, frame, answer, reads, opened } = manual();
    void store.open();
    frame(snapshot({ seq: 3 }));
    await answer(0, page([asked]));
    expect(opened).toEqual([null]);
    expect(store.snapshot().epoch).toBe("e1");

    store.close();
    void store.open();
    // No cursor, and the stream has not spoken until it answers.
    expect(opened).toEqual([null, null]);
    expect(store.snapshot().epoch).toBeNull();
    frame(
      snapshot({ seq: 7, turn: { id: "t9", status: "running", asked: [] } }),
    );
    await settle();
    expect(store.snapshot().epoch).toBe("e1");
    expect(reads()).toBe(2);
    await answer(1, page([asked, whole]));
    expect(store.snapshot().messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
    ]);
  });
});
