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
