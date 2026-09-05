/**
 * The words a brand-new room says, walked for their Korean.
 *
 * The suggestions are read through `t(someVariable)`, which `i18n-coverage.test.ts` cannot see —
 * it only walks literal `t("…")`. A chip that shipped in English would be the first thing somebody
 * sees in the first room they ever make.
 */
import { describe, expect, it } from "bun:test";
import { ROOM_SUGGESTIONS } from "@/components/channels/room-suggestions";
import { ko } from "@/lib/i18n-ko";

describe("the room's empty state", () => {
  it("offers something to press, not just a sentence", () => {
    // The blank pane it replaced said nothing at all. Two is thin; four is a menu.
    expect(ROOM_SUGGESTIONS.length).toBeGreaterThanOrEqual(2);
    expect(ROOM_SUGGESTIONS.length).toBeLessThanOrEqual(4);
  });

  it("says every suggestion in Korean", () => {
    for (const suggestion of ROOM_SUGGESTIONS) {
      expect(ko[suggestion]).toBeString();
      expect(ko[suggestion]?.length).toBeGreaterThan(0);
    }
  });

  it("says what a room is for in Korean", () => {
    const line =
      "Everyone here answers the same message in turn. Address one with @, or ask them all at once.";
    expect(ko[line]).toBeString();
    // It has to mention the one thing a room does that a one-to-one chat does not.
    expect(ko[line]).toContain("@");
  });

  it("offers three different things rather than the same one thrice", () => {
    expect(new Set(ROOM_SUGGESTIONS).size).toBe(ROOM_SUGGESTIONS.length);
    expect(new Set(ROOM_SUGGESTIONS.map((line) => ko[line])).size).toBe(
      ROOM_SUGGESTIONS.length,
    );
  });
});
