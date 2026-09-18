import { describe, expect, test } from "bun:test";
import { createWorkInFlight, type Work } from "../src/runner/in-flight";

/**
 * What this process is doing for somebody right now, as the one place that can stop it reads it.
 *
 * Nothing here stops anything — each entry carries its own way of stopping — so what is pinned is
 * the bookkeeping: an entry is seen for as long as its work goes on and not a moment after, only by
 * the person it is for, and saying it is over twice does not take somebody else's entry with it.
 */

const work = (overrides: Partial<Work> = {}): Work => ({
  kind: "routine",
  userId: "person-1",
  agentId: "bot-1",
  threadId: null,
  stop: async () => true,
  ...overrides,
});

describe("work in flight", () => {
  test("is seen from the moment it starts until it says it is over", () => {
    const going = createWorkInFlight();
    const done = going.track(work());
    expect(going.of("person-1")).toHaveLength(1);
    done();
    expect(going.of("person-1")).toEqual([]);
  });

  test("is only ever the asking person's", () => {
    const going = createWorkInFlight();
    going.track(work({ userId: "person-1" }));
    going.track(work({ userId: "person-2", kind: "chat" }));
    expect(going.of("person-1").map((entry) => entry.kind)).toEqual([
      "routine",
    ]);
    expect(going.of("person-2").map((entry) => entry.kind)).toEqual(["chat"]);
    expect(going.of("nobody")).toEqual([]);
  });

  test("work that belongs to nobody is nobody's to stop", () => {
    const going = createWorkInFlight();
    going.track(work({ userId: null }));
    expect(going.of("person-1")).toEqual([]);
  });

  test("two pieces of the same shape are two entries, and ending one leaves the other", () => {
    const going = createWorkInFlight();
    const first = going.track(work());
    going.track(work());
    first();
    // Twice is harmless: the second call must not find and remove the entry that is still going.
    first();
    expect(going.of("person-1")).toHaveLength(1);
  });

  test("says whether an entry it handed out is still going", () => {
    const going = createWorkInFlight();
    const done = going.track(work());
    const [entry] = going.of("person-1");
    if (!entry) throw new Error("the entry was not tracked");
    expect(going.isGoing(entry)).toBe(true);
    done();
    expect(going.isGoing(entry)).toBe(false);
  });
});
