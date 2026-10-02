import { describe, expect, test } from "bun:test";
import {
  arrivedBelow,
  furthestSeen,
  type TranscriptItem,
} from "../src/components/channels/chat-messages";
import { ko } from "../src/lib/i18n-ko";

/**
 * WHAT ARRIVED BELOW WHILE THE READER WAS ABOVE HAS A NAME.
 *
 * Pressed on the running app, 2026-10-02: reading nine hundred pixels above the end when a
 * routine's briefing was delivered. The page kept its place, which is right — and the only sign that
 * anything had arrived was the arrow that was already there for "the end is further down". A
 * delivered answer and the end of the conversation looked the same.
 *
 * The count and what has been seen are these two functions; whether the reader is above the end
 * and which rows are on screen are the scroller's own words (`useMessageScrollerScrollable`,
 * `useMessageScrollerVisibility`), which a test without layout cannot ask. The button was pressed on
 * the running app instead: see the pull request.
 */

const said = (id: string, role: "user" | "assistant"): TranscriptItem => ({
  kind: "text",
  id,
  role,
  text: id,
});

const ITEMS: TranscriptItem[] = [
  said("u-1", "user"),
  said("a-1", "assistant"),
  said("u-2", "user"),
  said("a-2", "assistant"),
  said("a-3", "assistant"),
];

describe("what arrived below the row the reader last saw at the end", () => {
  test("nothing, while that row is still the last", () => {
    expect(arrivedBelow(ITEMS, "a-3")).toBe(0);
  });

  test("the Bot's messages after it, each bubble one", () => {
    expect(arrivedBelow(ITEMS, "a-1")).toBe(2);
    expect(arrivedBelow(ITEMS, "u-2")).toBe(2);
    expect(arrivedBelow(ITEMS, "a-2")).toBe(1);
  });

  test("not the person's own words, which another window of theirs sent", () => {
    expect(arrivedBelow([...ITEMS, said("u-3", "user")], "a-3")).toBe(0);
  });

  test("nothing where the row is not known: before anything was seen, or after it left the list", () => {
    expect(arrivedBelow(ITEMS, null)).toBe(0);
    expect(arrivedBelow(ITEMS, "gone")).toBe(0);
  });
});

describe("the furthest row the reader has had on screen", () => {
  test("moves on to the lowest row now on screen, and never back", () => {
    expect(furthestSeen(ITEMS, "a-1", ["u-2", "a-2"])).toBe("a-2");
    expect(furthestSeen(ITEMS, "a-2", ["u-1", "a-1"])).toBe("a-2");
  });

  test("is whatever is on screen when nothing has been seen yet", () => {
    expect(furthestSeen(ITEMS, null, ["u-1", "a-1"])).toBe("a-1");
    expect(furthestSeen(ITEMS, null, [])).toBeNull();
  });

  test("an answer being written under the question on screen is seen, not news", () => {
    // The question was sent from this window: the page shows it with the answer growing under it.
    const seen = furthestSeen(ITEMS, "a-1", ["u-2", "a-2"]);
    expect(arrivedBelow(ITEMS, seen)).toBe(1);
    expect(arrivedBelow(ITEMS.slice(0, 4), seen)).toBe(0);
  });

  test("a row on screen that the list no longer holds changes nothing", () => {
    expect(furthestSeen(ITEMS, "a-1", ["gone"])).toBe("a-1");
  });
});

describe("the words on the button", () => {
  test("are Korean, for one and for several", () => {
    expect(ko["New message"]).toBe("새 메시지");
    expect(ko["{count} new messages"]).toBe("새 메시지 {count}개");
  });
});
