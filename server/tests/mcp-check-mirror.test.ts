import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  MAX_SIGNALS,
  MAX_TEXT,
  normalizeSignals,
} from "../scripts/laf-mcp-check";

/**
 * The public checker, held to the contract it checks against.
 *
 * The exact file is vendored into the laf-mcp-template repository, where a customer's CI runs it
 * without this monorepo, so it is deliberately self-contained. It used to be tethered instead to
 * `watch/differ.ts` — the platform's own copy of the same normalization — because a checker that
 * disagreed with the registration surface would tell customers their server passes while the
 * platform reads it differently, which is the one lie a conformance checker must never tell.
 *
 * That second implementation is gone: the platform-side polling of `laf.watch` is parked until a
 * customer asks for it (docs/laf/redesign-2026-09.md §7-2). The contract is not parked — customer
 * developers are building against it now — so the tether moves to the contract document, which is
 * what the checker is actually a checker for. `mcp-contract.md` §1 states both limits in prose, and
 * a checker that quietly used different ones would fail servers that are correct by the only
 * description their authors have.
 */
describe("the public checker matches the contract it enforces", () => {
  test("the limits are the numbers the contract publishes", async () => {
    const contract = await readFile(
      new URL("../../docs/laf/mcp-contract.md", import.meta.url),
      "utf8",
    );

    expect(MAX_SIGNALS).toBe(64);
    expect(MAX_TEXT).toBe(500);
    expect(contract).toContain(`신호 **${MAX_SIGNALS}개**`);
    expect(contract).toContain(`문자열 필드 **${MAX_TEXT}자**`);
  });

  test("keeps the first of a duplicated key, as the contract says", () => {
    expect(
      normalizeSignals({
        signals: [
          { key: "dup", status: "ok", value: "first" },
          { key: "dup", status: "fail", value: "second" },
        ],
      }),
    ).toEqual([{ key: "dup", status: "ok", value: "first" }]);
  });

  test("accepts a bare array as well as the documented envelope", () => {
    const signal = { key: "a", status: "fail", since: "2026-08-25T00:00:00Z" };
    expect(normalizeSignals([signal])).toEqual(
      normalizeSignals({ signals: [signal] }),
    );
  });

  test("drops an empty key and an unknown status rather than guessing", () => {
    expect(
      normalizeSignals({
        signals: [
          { key: "", status: "ok" },
          { key: "shrug", status: "meh" },
          { key: "kept", status: "ok" },
        ],
      }),
    ).toEqual([{ key: "kept", status: "ok" }]);
  });

  test("cuts a long string at the limit rather than refusing the frame", () => {
    const [signal] = normalizeSignals({
      signals: [{ key: "long", status: "warn", detail: "d".repeat(900) }],
    });
    expect(signal?.detail).toHaveLength(MAX_TEXT);
  });

  test("caps the signal count", () => {
    expect(
      normalizeSignals({
        signals: Array.from({ length: 80 }, (_, index) => ({
          key: `s${String(index).padStart(3, "0")}`,
          status: "ok",
        })),
      }),
    ).toHaveLength(MAX_SIGNALS);
  });

  test("reads garbage as an empty list rather than crashing", () => {
    expect(normalizeSignals({ signals: "not-a-list" })).toEqual([]);
    expect(normalizeSignals(null)).toEqual([]);
  });
});
