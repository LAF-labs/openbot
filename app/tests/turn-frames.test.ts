/**
 * What a window makes of a server-owned turn's frames (`lib/turns/frames.ts`).
 *
 * The window is not AG-UI's client any more: it may join a turn halfway, rejoin after sleeping,
 * or be handed the server's own copy of a message it pieced together from deltas. Every one of
 * those has to leave the transcript right, in order, and with each message once.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  applyFrame,
  EMPTY_THREAD,
  isTurnGoing,
  mergeMessages,
  type ThreadState,
  type TurnFrame,
} from "../src/lib/turns/frames";

let seq = 0;
const event = (payload: Record<string, unknown>): TurnFrame => ({
  seq: ++seq,
  kind: "event",
  turn: "t1",
  event: payload as { type: string },
});
const fold = (frames: TurnFrame[], start: ThreadState = EMPTY_THREAD) =>
  frames.reduce(applyFrame, start);

describe("a streamed answer", () => {
  test("text deltas build one assistant message", () => {
    const state = fold([
      event({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }),
      event({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "안녕" }),
      event({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "하세요" }),
      event({ type: "TEXT_MESSAGE_END", messageId: "m1" }),
    ]);
    expect(state.messages).toEqual([
      { id: "m1", role: "assistant", content: "안녕하세요" },
    ]);
  });

  test("a delta for a message whose start this window never saw still lands", () => {
    const state = fold([
      event({ type: "TEXT_MESSAGE_CONTENT", messageId: "m9", delta: "…중간" }),
    ]);
    expect(state.messages).toEqual([
      { id: "m9", role: "assistant", content: "…중간" },
    ]);
  });

  test("a tool call joins the message it belongs to, and its result is filed once", () => {
    const state = fold([
      event({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }),
      event({
        type: "TOOL_CALL_START",
        toolCallId: "c1",
        toolCallName: "computer_navigate",
        parentMessageId: "m1",
      }),
      event({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"url":' }),
      event({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '"a.kr"}' }),
      event({ type: "TOOL_CALL_END", toolCallId: "c1" }),
      event({
        type: "TOOL_CALL_RESULT",
        messageId: "r1",
        toolCallId: "c1",
        content: '{"ok":true}',
      }),
      // The same result replayed after a reconnect must not be drawn twice.
      event({
        type: "TOOL_CALL_RESULT",
        messageId: "r1",
        toolCallId: "c1",
        content: '{"ok":true}',
      }),
    ]);
    expect(state.messages).toHaveLength(2);
    const [asked, result] = state.messages as [
      Message & { toolCalls: { function: { arguments: string } }[] },
      Message,
    ];
    expect(asked.toolCalls[0]?.function.arguments).toBe('{"url":"a.kr"}');
    expect(result).toMatchObject({ role: "tool", toolCallId: "c1" });
  });

  test("the server's own copy replaces a message pieced together from deltas", () => {
    const state = fold([
      event({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "잘린" }),
      {
        seq: ++seq,
        kind: "messages",
        turn: "t1",
        messages: [{ id: "m1", role: "assistant", content: "잘린 데 없는 답" }],
      },
    ]);
    expect(state.messages).toEqual([
      { id: "m1", role: "assistant", content: "잘린 데 없는 답" },
    ]);
  });
});

describe("the turn around it", () => {
  test("a frame already applied is not applied again", () => {
    const first = event({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "한 번",
    });
    const state = fold([first, first]);
    expect(state.messages).toEqual([
      { id: "m1", role: "assistant", content: "한 번" },
    ]);
  });

  test("a snapshot merges the turn's messages by id and takes the cursor", () => {
    const held: ThreadState = {
      ...EMPTY_THREAD,
      messages: [
        { id: "u0", role: "user", content: "이전 질문" },
        { id: "a1", role: "assistant", content: "부분" },
      ],
    };
    const state = applyFrame(held, {
      seq: 41,
      kind: "snapshot",
      epoch: "boot-2",
      turn: { id: "t2", status: "running", asked: ["u1"] },
      messages: [
        { id: "a1", role: "assistant", content: "부분이 아닌 전부" },
        { id: "u1", role: "user", content: "새 질문" },
      ],
      waiting: ["c7"],
    });
    expect(state.epoch).toBe("boot-2");
    expect(state.seq).toBe(41);
    expect(state.waiting).toEqual(["c7"]);
    expect(state.messages.map((message) => message.id)).toEqual([
      "u0",
      "a1",
      "u1",
    ]);
    expect((state.messages[1] as { content: string }).content).toBe(
      "부분이 아닌 전부",
    );
  });

  test("a failure is read off the run's error, and a new turn clears it", () => {
    let state = fold([
      {
        seq: ++seq,
        kind: "turn",
        turn: { id: "t1", status: "running", asked: [] },
      },
      event({ type: "RUN_ERROR", message: "laf:model_rate_limited" }),
      {
        seq: ++seq,
        kind: "turn",
        turn: { id: "t1", status: "error", asked: [] },
      },
    ]);
    expect(state.failure).toBe("laf:model_rate_limited");
    expect(isTurnGoing(state.turn)).toBe(false);
    state = applyFrame(state, {
      seq: ++seq,
      kind: "turn",
      turn: { id: "t2", status: "queued", asked: ["u2"] },
    });
    expect(state.failure).toBeNull();
    expect(isTurnGoing(state.turn)).toBe(true);
  });

  test("the run's cost and retries are not a notice; a cut-off answer is", () => {
    const state = fold([
      event({ type: "CUSTOM", name: "laf.model.usage", value: {} }),
      event({ type: "CUSTOM", name: "laf.retry", value: {} }),
    ]);
    expect(state.notice).toBeNull();
    expect(
      applyFrame(state, event({ type: "CUSTOM", name: "laf.answer_truncated" }))
        .notice,
    ).toBe("laf.answer_truncated");
  });

  test("merging keeps the order of what is held and appends what is new", () => {
    const merged = mergeMessages(
      [
        { id: "a", role: "user", content: "1" },
        { id: "b", role: "assistant", content: "2" },
      ],
      [
        { id: "c", role: "user", content: "3" },
        { id: "a", role: "user", content: "1!" },
      ],
    );
    expect(merged.map((message) => message.id)).toEqual(["a", "b", "c"]);
    expect((merged[0] as { content: string }).content).toBe("1!");
  });
});
