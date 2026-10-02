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
  isTurnQueued,
  mergeMessages,
  mergeTurn,
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

/*
 * A snapshot, and the server's own copies at the end of a step, are the turn from its first row,
 * in order, every time. A window holds the newest page and what came after it, and a turn longer
 * than a page begins above that: added as new, the turn's first rows went last on every one of
 * those frames — the question, and the first steps of a long task, under its newest (model check
 * of the kept conversation, 2026-10-03).
 */
describe("the turn's messages, sent whole", () => {
  const row = (id: string, content = id): Message => ({
    id,
    role: "assistant",
    content,
  });
  const ids = (messages: readonly Message[]) =>
    messages.map((message) => message.id);

  test("replace what is held where it stands, and what is new after the last of them goes last", () => {
    const merged = mergeTurn(
      [row("h"), row("a", "half"), row("x")],
      [row("a", "whole"), row("b")],
    );
    expect(ids(merged)).toEqual(["h", "a", "x", "b"]);
    expect((merged[1] as { content: string }).content).toBe("whole");
  });

  test("a row between two that are held goes before the later of them", () => {
    expect(
      ids(
        mergeTurn(
          [row("a"), row("c"), row("x")],
          [row("a"), row("b"), row("c")],
        ),
      ),
    ).toEqual(["a", "b", "c", "x"]);
  });

  test("rows before the first one held are above what is held, and are left there", () => {
    const held = [row("c"), row("d")];
    const merged = mergeTurn(held, [
      row("a"),
      row("b"),
      row("c"),
      row("d"),
      row("e"),
    ]);
    expect(ids(merged)).toEqual(["c", "d", "e"]);
  });

  test("with nothing in common, all of it is new", () => {
    expect(ids(mergeTurn([row("h")], [row("a"), row("b")]))).toEqual([
      "h",
      "a",
      "b",
    ]);
    expect(ids(mergeTurn([], [row("a")]))).toEqual(["a"]);
  });

  test("and a snapshot of a turn longer than what is held does not draw its first rows last", () => {
    const state = applyFrame(
      { ...EMPTY_THREAD, messages: [row("s3"), row("s4")] },
      {
        seq: 9,
        kind: "snapshot",
        epoch: "e1",
        turn: { id: "t1", status: "running", asked: ["q"] },
        messages: [
          row("q"),
          row("s1"),
          row("s2"),
          row("s3"),
          row("s4"),
          row("s5"),
        ],
        waiting: [],
      },
    );
    expect(ids(state.messages)).toEqual(["s3", "s4", "s5"]);
  });
});

/*
 * A page can bring a message before the stream says it: the record holds part of an answer while
 * its turn runs, and the whole of it once the turn is over, and a window whose stream is behind
 * reads either. The stream then says the message from its first piece. Added to what the page had
 * brought, every piece read twice; begun again from nothing, an answer that was whole on the
 * screen shrank to its first piece and grew back (model check of the kept conversation,
 * 2026-10-03).
 */
describe("a message held before the stream said it", () => {
  const whole = "내일은 맑고 최고 26°예요.";
  const holding = (content: string): ThreadState => ({
    ...EMPTY_THREAD,
    messages: [{ id: "a1", role: "assistant", content }],
  });
  const said = (state: ThreadState) =>
    (state.messages.at(-1) as { content: string }).content;
  const start = () =>
    event({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" });
  const piece = (delta: string) =>
    event({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta });
  /** What the message says after each frame. */
  const saidAfterEach = (from: ThreadState, frames: TurnFrame[]) => {
    let state = from;
    return frames.map((frame) => {
      state = applyFrame(state, frame);
      return said(state);
    });
  };

  test("stands while the stream says what is held already: never shorter, never said twice", () => {
    const frames = [
      start(),
      piece("내일은"),
      piece(" 맑고"),
      piece(" 최고 26°예요."),
      event({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
    ];
    expect(saidAfterEach(holding(whole), frames)).toEqual([
      whole,
      whole,
      whole,
      whole,
      whole,
    ]);
    // And once it has said all of it, the stream is behind on nothing.
    expect(fold(frames.slice(0, 4), holding(whole)).behind).toEqual({});
  });

  test("and is the stream's from the piece that says more than is held", () => {
    // Part of it: the record was written while the answer was arriving.
    expect(
      saidAfterEach(holding("내일은"), [
        start(),
        piece("내일"),
        piece("은 맑고"),
        piece(" 최고 26°예요."),
      ]),
    ).toEqual(["내일은", "내일은", "내일은 맑고", whole]);
  });

  test("or that says otherwise", () => {
    expect(
      saidAfterEach(holding("내일은 맑아요"), [start(), piece("모레는")]),
    ).toEqual(["내일은 맑아요", "모레는"]);
  });

  test("a message that begins with nothing held of it grows as it always did", () => {
    expect(
      saidAfterEach(holding(""), [start(), piece("내일"), piece("은")]),
    ).toEqual(["", "내일", "내일은"]);
  });

  test("one let go of meanwhile comes back with all the stream has said of it", () => {
    const behind = fold([start(), piece("내일")], holding(whole));
    expect(said(behind)).toBe(whole);
    // Let go from the top, with the rest of an old page; the stream goes on.
    const state = applyFrame({ ...behind, messages: [] }, piece("은 맑고"));
    expect(state.messages).toEqual([
      { id: "a1", role: "assistant", content: "내일은 맑고" },
    ]);
    expect(state.behind).toEqual({});
  });

  const snapshot = (content: string): TurnFrame => ({
    seq: ++seq,
    kind: "snapshot",
    epoch: "e1",
    turn: { id: "t1", status: "running", asked: [] },
    messages: [{ id: "a1", role: "assistant", content }],
    waiting: [],
  });

  test("a snapshot that says more of it is the message, and what follows is added to that", () => {
    const behind = fold([start(), piece("내")], holding("내일은"));
    const state = fold([snapshot("내일은 맑고"), piece(" 최고")], behind);
    expect(said(state)).toBe("내일은 맑고 최고");
    expect(state.behind).toEqual({});
  });

  /*
   * A snapshot is the turn as it stood when the stream was opened; a page read since may be on
   * the screen before it arrives. It took the answer back to where the turn had stood.
   */
  test("a snapshot that says less of it does not take it back: the stream is behind from there", () => {
    expect(
      saidAfterEach(holding(whole), [
        snapshot("내일은"),
        piece(" 맑고"),
        piece(" 최고 26°예요."),
        piece(" 우산은"),
      ]),
    ).toEqual([whole, whole, whole, `${whole} 우산은`]);
  });

  test("the same for a call's arguments", () => {
    const calling = (args: string): ThreadState => ({
      ...EMPTY_THREAD,
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "computer_navigate", arguments: args },
            },
          ],
        },
      ],
    });
    const args = (state: ThreadState) =>
      (
        state.messages[0] as {
          toolCalls: { function: { arguments: string } }[];
        }
      ).toolCalls.map((call) => call.function.arguments);
    const frames = [
      event({
        type: "TOOL_CALL_START",
        toolCallId: "c1",
        toolCallName: "computer_navigate",
        parentMessageId: "a1",
      }),
      event({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"url":' }),
      event({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '"a.kr"}' }),
      event({ type: "TOOL_CALL_END", toolCallId: "c1" }),
    ];
    const after = (from: ThreadState) => {
      let state = from;
      return frames.map((frame) => {
        state = applyFrame(state, frame);
        return args(state);
      });
    };
    // Held whole: it stands, once.
    expect(after(calling('{"url":"a.kr"}'))).toEqual([
      ['{"url":"a.kr"}'],
      ['{"url":"a.kr"}'],
      ['{"url":"a.kr"}'],
      ['{"url":"a.kr"}'],
    ]);
    // Held in part: the stream's from the piece that says more.
    expect(after(calling('{"url"'))).toEqual([
      ['{"url"'],
      ['{"url":'],
      ['{"url":"a.kr"}'],
      ['{"url":"a.kr"}'],
    ]);

    // And a snapshot that has less of a call, or has not come to one yet, takes neither back.
    const call = (id: string, given: string) => ({
      id,
      type: "function" as const,
      function: { name: "computer_navigate", arguments: given },
    });
    const held: ThreadState = {
      ...EMPTY_THREAD,
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            call("c1", '{"url":"a.kr"}'),
            call("c2", '{"url":"b.kr"}'),
          ],
        },
      ],
    };
    let state = held;
    const seen = (
      [
        {
          seq: ++seq,
          kind: "snapshot",
          epoch: "e1",
          turn: { id: "t1", status: "running", asked: [] },
          messages: [
            {
              id: "a1",
              role: "assistant",
              content: "",
              toolCalls: [call("c1", '{"url":')],
            },
          ],
          waiting: [],
        },
        event({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '"a.kr"}' }),
        event({
          type: "TOOL_CALL_START",
          toolCallId: "c2",
          toolCallName: "computer_navigate",
          parentMessageId: "a1",
        }),
        event({ type: "TOOL_CALL_ARGS", toolCallId: "c2", delta: '{"url":"b' }),
      ] satisfies TurnFrame[]
    ).map((frame) => {
      state = applyFrame(state, frame);
      return args(state);
    });
    const both = ['{"url":"a.kr"}', '{"url":"b.kr"}'];
    expect(seen).toEqual([both, both, both, both]);
  });
});

/*
 * `queued` IS A STATE OF ITS OWN: the turn was accepted and is waiting for the Bot, which is
 * finishing something else first. It used to be told apart from `running` nowhere — both are
 * "going" — and the transcript drew a Bot thinking for as long as a routine took (2026-10-02).
 */
describe("a turn that waits for the Bot", () => {
  const turn = (status: "queued" | "running" | "done"): TurnFrame => ({
    seq: ++seq,
    kind: "turn",
    turn: { id: "t1", status, asked: ["u1"] },
  });

  test("is queued until it is told it runs, and is going either way", () => {
    let state = applyFrame(EMPTY_THREAD, turn("queued"));
    expect(isTurnQueued(state.turn)).toBe(true);
    expect(isTurnGoing(state.turn)).toBe(true);
    state = applyFrame(state, turn("running"));
    expect(isTurnQueued(state.turn)).toBe(false);
    expect(isTurnGoing(state.turn)).toBe(true);
    expect(isTurnQueued(null)).toBe(false);
  });

  test("can be queued again partway, more than once, and keeps what it has said and asked", () => {
    let state = fold([
      turn("queued"),
      turn("running"),
      {
        seq: ++seq,
        kind: "messages",
        turn: "t1",
        messages: [{ id: "a1", role: "assistant", content: "찾아볼게요." }],
      },
      event({ type: "CUSTOM", name: "laf.answer_truncated" }),
      { seq: ++seq, kind: "waiting", turn: "t1", toolCallIds: ["c1"] },
    ]);
    // It let go of the Bot to wait on the person, and waits for the Bot to be free again.
    for (const _again of [1, 2]) {
      state = applyFrame(state, turn("queued"));
      expect(isTurnQueued(state.turn)).toBe(true);
      expect(isTurnGoing(state.turn)).toBe(true);
      // The same turn: nothing it wrote, asked or was told is cleared by waiting.
      expect(state.messages.map((message) => message.id)).toEqual(["a1"]);
      expect(state.waiting).toEqual(["c1"]);
      expect(state.notice).toBe("laf.answer_truncated");
      state = applyFrame(state, turn("running"));
      expect(isTurnQueued(state.turn)).toBe(false);
    }
    state = applyFrame(state, turn("done"));
    expect(isTurnQueued(state.turn)).toBe(false);
    expect(isTurnGoing(state.turn)).toBe(false);
  });

  test("is read off a snapshot too: a window that opens on a waiting turn", () => {
    const state = applyFrame(EMPTY_THREAD, {
      seq: ++seq,
      kind: "snapshot",
      epoch: "boot-1",
      turn: { id: "t9", status: "queued", asked: ["u9"] },
      messages: [{ id: "u9", role: "user", content: "경제 뉴스 알려줘" }],
      waiting: [],
    });
    expect(isTurnQueued(state.turn)).toBe(true);
  });
});
