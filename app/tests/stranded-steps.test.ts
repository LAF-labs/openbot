import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { taskStopOf } from "../src/lib/copilot/stranded-steps";

/**
 * A TASK THAT ENDED IN THE MIDDLE OF THE BOT'S WORK (UX review 0.5.4, candidate 1): when the last
 * task is said to have stopped. Which calls a window may carry on, and where their results go, were
 * here too until the window-driven path was removed (2026-10-05).
 */

const user: Message = {
  id: "u1",
  role: "user",
  content: "토스에서 앱 받아 줘",
};
const click = (id: string) => ({
  id,
  type: "function" as const,
  function: {
    name: "computer_click",
    arguments: '{"ref":"e7","snapshotId":3}',
  },
});
const asked = (...calls: string[]): Message =>
  ({
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: calls.map(click),
  }) as Message;
const result = (toolCallId: string, content: unknown, id = `r-${toolCallId}`) =>
  ({
    id,
    role: "tool",
    toolCallId,
    content: typeof content === "string" ? content : JSON.stringify(content),
  }) as Message;

describe("how the last task ended", () => {
  test("a step with no result: its window went away with it", () => {
    expect(taskStopOf([user, asked("c1")])).toEqual({
      reason: "window_closed",
      unanswered: ["c1"],
    });
  });

  test("a step the person stopped", () => {
    expect(
      taskStopOf([
        user,
        asked("c1"),
        result("c1", { ok: false, code: "laf:stopped", stopped: true }),
      ]),
    ).toEqual({ reason: "stopped", unanswered: [] });
  });

  test("nothing, once the Bot said something after its step", () => {
    expect(
      taskStopOf([
        user,
        asked("c1"),
        result("c1", { ok: true }),
        { id: "a2", role: "assistant", content: "받았어요." } as Message,
      ]),
    ).toBeNull();
  });

  test("nothing, once the person spoke since", () => {
    expect(
      taskStopOf([
        user,
        asked("c1"),
        { id: "u2", role: "user", content: "다른 거 해 줘" } as Message,
      ]),
    ).toBeNull();
  });

  /*
   * MEASURED 2026-09-25 (0.5.4 final QA): Stop pressed while the Bot was thinking between two steps
   * — where it nearly always lands — offered no 이어서 하기. A thread that ends on answered steps with
   * nothing said after them was cut off. While the turn is still going on (this window's run, or a
   * step another window is carrying) the notice is not drawn at all: `CarryOnNotice` reads `busy`.
   */
  test("a turn cut off between two steps: the person's Stop", () => {
    expect(taskStopOf([user, asked("c1"), result("c1", { ok: true })])).toEqual(
      { reason: "stopped", unanswered: [] },
    );
  });

  test("nothing, for a turn cut off by a failure: its own line says so", () => {
    expect(
      taskStopOf([user, asked("c1"), result("c1", { ok: true })], {
        failed: true,
      }),
    ).toBeNull();
  });
});
