import { describe, expect, test } from "bun:test";
import {
  MAX_SIGNALS as checkerMax,
  MAX_TEXT as checkerText,
  normalizeSignals as checkerNormalize,
} from "../scripts/laf-mcp-check";
import { MAX_SIGNALS, MAX_TEXT, normalizeSignals } from "../src/watch/differ";

/**
 * The public checker is deliberately self-contained: the exact file is vendored into the
 * laf-mcp-template repository, where a customer's CI runs it without this monorepo. Its signal
 * normalization therefore MIRRORS differ.ts rather than importing it — and a mirror that drifts
 * would tell customers their server passes while the registration surface disagrees, which is the
 * one lie a conformance checker must never tell. This test is the tether.
 */
describe("the public checker mirrors what registration enforces", () => {
  test("the limits are the same numbers", () => {
    expect(checkerMax).toBe(MAX_SIGNALS);
    expect(checkerText).toBe(MAX_TEXT);
  });

  const cases: Array<[string, unknown]> = [
    [
      "a healthy frame",
      {
        signals: [
          { key: "db.reachable", status: "ok", value: 1 },
          { key: "queue.orders", status: "warn", value: 47, detail: "backlog" },
        ],
      },
    ],
    [
      "a bare array instead of {signals}",
      [{ key: "a", status: "fail", since: "2026-08-25T00:00:00Z" }],
    ],
    [
      "duplicate keys keep the first",
      {
        signals: [
          { key: "dup", status: "ok", value: "first" },
          { key: "dup", status: "fail", value: "second" },
        ],
      },
    ],
    [
      "unknown statuses and empty keys are dropped",
      {
        signals: [
          { key: "", status: "ok" },
          { key: "shrug", status: "meh" },
          { key: "kept", status: "ok" },
        ],
      },
    ],
    [
      "strings are cut at the text limit",
      {
        signals: [{ key: "long", status: "warn", detail: "d".repeat(900) }],
      },
    ],
    [
      "the signal count is capped",
      {
        signals: Array.from({ length: 80 }, (_, index) => ({
          key: `s${String(index).padStart(3, "0")}`,
          status: "ok",
        })),
      },
    ],
    ["garbage is an empty list, not a crash", { signals: "not-a-list" }],
  ];

  test.each(cases)("normalizes %s identically", (_name, raw) => {
    expect(checkerNormalize(raw)).toEqual(normalizeSignals(raw));
  });
});
