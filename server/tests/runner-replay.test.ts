import { describe, expect, test } from "bun:test";
import { type BaseEvent, verifyEvents } from "@ag-ui/client";
import { from, lastValueFrom, Subject, toArray } from "rxjs";
import { createReplaySettler, settleReplay } from "../src/runner/replay";

const e = (type: string, fields: Record<string, unknown> = {}) =>
  ({ type, ...fields }) as unknown as BaseEvent;

/**
 * What the vendored runner replayed for a thread whose second run a person stopped while the Bot
 * was thinking, and which then went on — measured on the 0.5.4 stack (`getThreadEvents`).
 */
const history = [
  e("RUN_STARTED", { threadId: "t", runId: "r1" }),
  e("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
  e("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "열어볼게요" }),
  e("TEXT_MESSAGE_END", { messageId: "m1" }),
  e("RUN_FINISHED", { threadId: "t", runId: "r1" }),
  e("RUN_STARTED", { threadId: "t", runId: "r2" }),
  e("RUN_ERROR", { message: "The operation was aborted.", code: "abort" }),
  e("RUN_STARTED", { threadId: "t", runId: "r3" }),
  e("RUN_FINISHED", { threadId: "t", runId: "r3" }),
];

const verified = (events: BaseEvent[]) =>
  lastValueFrom(verifyEvents(false)(from(events)).pipe(toArray()));

describe("a thread's replay", () => {
  test("is refused by AG-UI as it was, which is the window's agent_connect_failed", async () => {
    await expect(verified(history)).rejects.toThrow("already errored");
  });

  test("passes once a past run's error is settled as that run finishing", async () => {
    const settle = createReplaySettler();
    const settled = history.flatMap(settle);
    const out = await verified(settled);
    expect(out.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
      "RUN_STARTED",
      "RUN_FINISHED",
      "RUN_STARTED",
      "RUN_FINISHED",
    ] as BaseEvent["type"][]);
    expect(settled[6]).toMatchObject({ threadId: "t", runId: "r2" });
  });

  test("closes what the stopped run had open, and answers no call it made", async () => {
    const settled = [
      e("RUN_STARTED", { threadId: "t", runId: "r1" }),
      e("STEP_STARTED", { stepName: "think" }),
      e("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      e("TOOL_CALL_START", {
        toolCallId: "c1",
        toolCallName: "computer_navigate",
      }),
      e("RUN_ERROR", { message: "The operation was aborted." }),
    ].flatMap(createReplaySettler());
    await verified(settled);
    const types = settled.map((event) => String(event.type));
    expect(types).toContain("TOOL_CALL_END");
    expect(types).not.toContain("TOOL_CALL_RESULT");
    expect(settled.at(-1)?.type).toBe("RUN_FINISHED" as BaseEvent["type"]);
  });

  test("leaves an error a run still going on sends for the windows to hear", async () => {
    const live = new Subject<BaseEvent>();
    const seen: BaseEvent[] = [];
    const past = [
      e("RUN_STARTED", { threadId: "t", runId: "r1" }),
      e("RUN_ERROR", { message: "The operation was aborted." }),
    ];
    const source = new Subject<BaseEvent>();
    settleReplay(source, past.length).subscribe((event) => seen.push(event));
    for (const event of past) source.next(event);
    live.subscribe((event) => source.next(event));
    live.next(e("RUN_STARTED", { threadId: "t", runId: "r2" }));
    live.next(e("RUN_ERROR", { message: "provider down" }));
    expect(seen.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "RUN_FINISHED",
      "RUN_STARTED",
      "RUN_ERROR",
    ] as BaseEvent["type"][]);
  });
});
