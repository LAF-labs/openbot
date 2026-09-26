/**
 * What a window is handed when it watches a server-owned turn (`turns/hub.ts`).
 *
 * The live cursor is a number that means something only to the process that numbered it, and only
 * while that process still holds the frames after it. A window that asks from anywhere else — a
 * cursor from before a restart, one older than what is held, none at all — is handed the turn as it
 * stands instead, and never the middle of a message whose start it did not see.
 */
import { describe, expect, test } from "bun:test";
import type { BaseEvent, Message } from "@ag-ui/client";
import {
  createTurnHub,
  type TurnFrame,
  type TurnSnapshot,
} from "../src/turns/hub";

const running = { id: "t1", status: "running" as const, asked: ["u1"] };
const delta = (text: string) =>
  ({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: text }) as BaseEvent;

function watch(
  hub: ReturnType<typeof createTurnHub>,
  from: { epoch: string | null; after: number | null },
) {
  const seen: Array<TurnFrame | TurnSnapshot> = [];
  const stop = hub.subscribe("thread-1", from, (frame) => seen.push(frame));
  return { seen, stop };
}

describe("a window watching from a cursor", () => {
  test("is handed exactly what it missed, then what comes", () => {
    const hub = createTurnHub();
    hub.turn("thread-1", running);
    hub.event("thread-1", "t1", delta("가"));
    hub.event("thread-1", "t1", delta("나"));
    const { seen } = watch(hub, { epoch: hub.epoch, after: 2 });
    hub.event("thread-1", "t1", delta("다"));
    expect(seen.map((frame) => frame.kind === "event" && frame.event)).toEqual([
      delta("나"),
      delta("다"),
    ]);
  });

  test("from another process, is handed the turn as it stands", () => {
    const hub = createTurnHub();
    const messages: Message[] = [
      { id: "u1", role: "user", content: "질문" },
      { id: "a1", role: "assistant", content: "가나" },
    ];
    hub.turn("thread-1", running);
    hub.watchLive("thread-1", () => messages);
    hub.event("thread-1", "t1", delta("가"));
    const { seen } = watch(hub, { epoch: "a-process-that-died", after: 1 });
    expect(seen).toEqual([
      {
        kind: "snapshot",
        epoch: hub.epoch,
        seq: 2,
        turn: running,
        messages,
        waiting: [],
      },
    ]);
  });

  test("with no cursor, the same", () => {
    const hub = createTurnHub();
    const { seen } = watch(hub, { epoch: null, after: null });
    expect(seen).toEqual([
      {
        kind: "snapshot",
        epoch: hub.epoch,
        seq: 0,
        turn: null,
        messages: [],
        waiting: [],
      },
    ]);
  });

  test("a new turn starts a new log: nothing of the last is replayed into it", () => {
    const hub = createTurnHub();
    hub.turn("thread-1", running);
    hub.event("thread-1", "t1", delta("옛날"));
    hub.turn("thread-1", { ...running, status: "done" });
    hub.turn("thread-1", { id: "t2", status: "queued", asked: ["u2"] });
    const { seen } = watch(hub, { epoch: hub.epoch, after: 3 });
    hub.event("thread-1", "t2", delta("새로"));
    expect(seen.map((frame) => frame.kind)).toEqual(["turn", "event"]);
    // A cursor from inside the old turn is before what is held: a snapshot, not a replay.
    const late = watch(hub, { epoch: hub.epoch, after: 1 });
    expect(late.seen[0]?.kind).toBe("snapshot");
  });

  test("an ended turn is let go of once nobody is watching", async () => {
    const hub = createTurnHub({ keepEndedMs: 20 });
    hub.turn("thread-1", running);
    hub.turn("thread-1", { ...running, status: "done" });
    expect(hub.state("thread-1").turn?.status).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hub.state("thread-1")).toEqual({ turn: null, seq: 0 });
  });

  test("one window that throws does not stop the others", () => {
    const hub = createTurnHub();
    hub.subscribe("thread-1", { epoch: null, after: null }, (frame) => {
      if (frame.kind !== "snapshot") throw new Error("a closed socket");
    });
    const { seen } = watch(hub, { epoch: null, after: null });
    hub.turn("thread-1", running);
    expect(seen.map((frame) => frame.kind)).toEqual(["snapshot", "turn"]);
  });
});
