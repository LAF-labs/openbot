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
