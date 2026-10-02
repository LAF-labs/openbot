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
