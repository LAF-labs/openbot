import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { stamp, stampsOf } from "../src/runner/thread-store";

const message = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, role: "user", content: id, ...extra }) as Message;

/**
 * The merge rule behind the transcript's time separators.
 *
 * Worth its own test because every run hands the WHOLE history back as its input, unstamped — AG-UI
 * strips unknown keys on the way in — so a save that got this wrong would not fail loudly. It would
 * quietly march every message in a conversation forward to the time of the most recent reply, and
 * the transcript would then draw a separator claiming it all happened this afternoon.
 */
describe("message stamps", () => {
  test("keeps the time a message was first seen, not the time of the latest save", () => {
    const previous = [message("a", { lafAt: "2026-08-01T09:00:00.000Z" })];
    const merged = stamp(
      [message("a"), message("b")],
      stampsOf(previous),
      new Set(["a"]),
      "2026-08-21T17:00:00.000Z",
    );

    expect(merged.map((m) => m.lafAt)).toEqual([
      "2026-08-01T09:00:00.000Z",
      "2026-08-21T17:00:00.000Z",
    ]);
  });

  test("leaves a message the thread already held but never stamped without a time", () => {
    // The one-time case: the first save after stamping shipped. Nobody recorded when these were
    // said, and inventing a time here is what would make the record lie rather than fall silent.
    const merged = stamp(
      [message("old"), message("new")],
      new Map(),
      new Set(["old"]),
      "2026-08-21T17:00:00.000Z",
    );

    expect(merged[0]?.lafAt).toBeUndefined();
    expect(merged[1]?.lafAt).toBe("2026-08-21T17:00:00.000Z");
  });

  test("prefers a stamp the message already carries over the snapshot's", () => {
    // Assistant messages arrive already stamped, taken live at TEXT_MESSAGE_START — that reading is
    // closer to when the Bot spoke than anything the save could reconstruct afterwards.
    const merged = stamp(
      [message("a", { lafAt: "2026-08-21T16:59:58.000Z" })],
      new Map([["a", "2026-08-21T17:00:00.000Z"]]),
      new Set(["a"]),
      "2026-08-21T17:00:05.000Z",
    );

    expect(merged[0]?.lafAt).toBe("2026-08-21T16:59:58.000Z");
  });

  test("reads back only the stamps that are really there", () => {
    expect(
      stampsOf([
        message("a", { lafAt: "2026-08-21T17:00:00.000Z" }),
        message("b"),
        message("c", { lafAt: 1_724_000_000_000 }),
      ]),
    ).toEqual(new Map([["a", "2026-08-21T17:00:00.000Z"]]));
  });
});
