import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { runOutcome } from "../src/runner/laf-runner";

const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as BaseEvent;

describe("what a run's events say it came to", () => {
  test("a run the Bot closed is done", () => {
    expect(
      runOutcome([event("RUN_STARTED"), event("RUN_FINISHED")], null),
    ).toEqual({
      status: "done",
      error: null,
    });
  });

  test("a stream that closed with no ending was stopped", () => {
    expect(
      runOutcome([event("RUN_STARTED"), event("TEXT_MESSAGE_START")], null),
    ).toEqual({ status: "stopped", error: null });
  });

  test("RUN_ERROR is an error in the Bot's words, even though the stream completed", () => {
    expect(
      runOutcome(
        [
          event("RUN_STARTED"),
          event("RUN_ERROR", { message: "stalled for 60 s" }),
        ],
        null,
      ),
    ).toEqual({ status: "error", error: "stalled for 60 s" });
    expect(runOutcome([event("RUN_ERROR")], null).error).toBe(
      "The Bot reported an error.",
    );
  });

  /**
   * A stream cut mid-answer used to complete like a finished one: TEXT_MESSAGE_END, RUN_FINISHED,
   * `done` in the ledger, and half a sentence delivered as the whole (audit A2 row 8). agent-bot
   * ends such a run with RUN_ERROR and its own fact, and the ledger counts it as what it was.
   */
  test("a stream cut mid-answer is an error with the Bot's own fact, whatever text arrived", () => {
    expect(
      runOutcome(
        [
          event("RUN_STARTED"),
          event("TEXT_MESSAGE_START", { messageId: "m1" }),
          event("TEXT_MESSAGE_CONTENT", {
            messageId: "m1",
            delta: "주문이 세 건 ",
          }),
          event("TEXT_MESSAGE_END", { messageId: "m1" }),
          event("RUN_ERROR", { message: "laf:provider_stream_cut" }),
        ],
        null,
      ),
    ).toEqual({ status: "error", error: "laf:provider_stream_cut" });
  });

  test("a person's Stop arrives as an abort, and is not an error", () => {
    // As the runtime delivers it: a RUN_ERROR event with the transport's wording.
    expect(
      runOutcome(
        [
          event("RUN_STARTED"),
          event("RUN_ERROR", { message: "The operation was aborted." }),
        ],
        null,
      ),
    ).toEqual({ status: "stopped", error: null });
    // And as a transport that dropped first would.
    expect(
      runOutcome([event("RUN_STARTED")], "The operation was aborted."),
    ).toEqual({ status: "stopped", error: null });
  });

  test("a transport failure outranks whatever the events say", () => {
    expect(runOutcome([event("RUN_FINISHED")], "socket reset")).toEqual({
      status: "error",
      error: "socket reset",
    });
  });
});
