import { describe, expect, test } from "bun:test";
import {
  diffSignals,
  MAX_SIGNALS,
  normalizeSignals,
} from "../src/watch/differ";

describe("normalizeSignals", () => {
  test("accepts the contract shape and sorts by key", () => {
    const signals = normalizeSignals({
      signals: [
        { key: "b", status: "ok" },
        { key: "a", status: "fail", detail: "x" },
      ],
    });
    expect(signals.map((signal) => signal.key)).toEqual(["a", "b"]);
  });

  test("drops invalid entries instead of failing the poll", () => {
    const signals = normalizeSignals({
      signals: [
        { key: "good", status: "warn" },
        { key: "", status: "ok" },
        { key: "bad-status", status: "meh" },
        { status: "ok" },
        "garbage",
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.key).toBe("good");
  });

  test("first key wins and the list is capped", () => {
    const flood = Array.from({ length: MAX_SIGNALS + 10 }, (_, index) => ({
      key: `k${String(index).padStart(3, "0")}`,
      status: "ok",
    }));
    expect(normalizeSignals({ signals: flood })).toHaveLength(MAX_SIGNALS);
    const dupes = normalizeSignals({
      signals: [
        { key: "same", status: "ok" },
        { key: "same", status: "fail" },
      ],
    });
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.status).toBe("ok");
  });

  test("a bare array is accepted, non-arrays become empty", () => {
    expect(normalizeSignals([{ key: "a", status: "ok" }])).toHaveLength(1);
    expect(normalizeSignals("no")).toHaveLength(0);
    expect(normalizeSignals(undefined)).toHaveLength(0);
  });
});

describe("diffSignals", () => {
  const ok = (key: string) => ({ key, status: "ok" as const });
  const fail = (key: string) => ({ key, status: "fail" as const });

  test("status transitions are news", () => {
    const changes = diffSignals([ok("db")], [fail("db")]);
    expect(changes).toEqual([
      { key: "db", prevStatus: "ok", nextStatus: "fail" },
    ]);
  });

  test("appearance and disappearance are news", () => {
    const changes = diffSignals([ok("old")], [ok("new")]);
    expect(changes).toContainEqual({
      key: "new",
      prevStatus: null,
      nextStatus: "ok",
    });
    expect(changes).toContainEqual({
      key: "old",
      prevStatus: "ok",
      nextStatus: null,
    });
  });

  test("a value wobble inside the same status is not news", () => {
    const changes = diffSignals(
      [{ key: "q", status: "warn", value: 47 }],
      [{ key: "q", status: "warn", value: 52 }],
    );
    expect(changes).toHaveLength(0);
  });

  test("no changes on identical lists", () => {
    expect(diffSignals([ok("a"), fail("b")], [ok("a"), fail("b")])).toEqual([]);
  });
});
