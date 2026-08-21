import { describe, expect, test } from "bun:test";
import {
  addRecipient,
  canSend,
  MAX_RECIPIENTS,
  removeRecipient,
} from "../src/components/channels/compose-state";

const KNOWLEDGE = { id: "knowledge", name: "Knowledge" };
const RISK = { id: "risk-analyst", name: "Risk Analyst" };

describe("addRecipient", () => {
  test("adds to an empty list", () => {
    expect(addRecipient([], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });

  test("appends a second coworker rather than replacing the first", () => {
    // A room holds several now; picking another adds them to it.
    expect(addRecipient([KNOWLEDGE], RISK)).toEqual([KNOWLEDGE, RISK]);
  });

  test("drops the oldest once the room is full", () => {
    const full = Array.from({ length: MAX_RECIPIENTS }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
    }));
    const after = addRecipient(full, RISK);
    expect(after).toHaveLength(MAX_RECIPIENTS);
    expect(after.at(-1)).toEqual(RISK);
    expect(after.at(0)).toEqual(full[1]);
  });

  test("adding the coworker already chosen is a no-op", () => {
    expect(addRecipient([KNOWLEDGE], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });
});

describe("removeRecipient", () => {
  test("removes by id", () => {
    expect(removeRecipient([KNOWLEDGE], "knowledge")).toEqual([]);
  });

  test("ignores an id that is not present", () => {
    expect(removeRecipient([KNOWLEDGE], "nobody")).toEqual([KNOWLEDGE]);
  });
});

describe("canSend", () => {
  test("needs at least one recipient and some text", () => {
    expect(canSend([KNOWLEDGE], "hello")).toBe(true);
    expect(canSend([KNOWLEDGE, RISK], "hello")).toBe(true);
  });

  test("refuses with no recipient", () => {
    expect(canSend([], "hello")).toBe(false);
  });

  test("refuses whitespace-only text", () => {
    expect(canSend([KNOWLEDGE], "   ")).toBe(false);
  });

  /*
   * The cap is asserted, not because the number is sacred, but because `canSend` used to read
   * `length === MAX_RECIPIENTS`: raising the cap with that test in place would have made the
   * composer refuse every draft until the room was full, and nothing else would have failed.
   */
  test("a room holds several, and a draft does not have to fill it", () => {
    expect(MAX_RECIPIENTS).toBeGreaterThan(1);
    expect(canSend([KNOWLEDGE], "hello")).toBe(true);
  });
});
