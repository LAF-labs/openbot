import { describe, expect, test } from "bun:test";
import { auditEventTypes } from "../../server/src/audit";
import {
  DECISIONS,
  DISCONNECT_REASONS,
  UNLABELLED_OUTCOMES,
} from "../src/routes/_authed/admin/audit";
import { ko } from "../src/lib/i18n-ko";

/**
 * The audit table's labels are `t()` called on a VARIABLE, so `i18n-coverage.test.ts` cannot see
 * them — the same blind spot the presets and the catalogue copy have, closed the same way.
 *
 * And the worse half, which this file exists for. An event type with no entry falls back to
 * "Allowed", so adding a type on the server and forgetting the surface does not render an English
 * word — it renders a WRONG one. `mcp.account_disconnected` and `credential.rotation_refused` each
 * read as "Allowed" for exactly as long as nobody looked, which is the one thing an audit trail must
 * never do: an access that was withdrawn is not a permission granted.
 *
 * So the coverage assertion is against the SERVER's own list of event types, imported rather than
 * copied. A type added there fails here until somebody decides what it says.
 */
describe("the audit trail's labels", () => {
  test("every label and reason has Korean", () => {
    const missing = [
      ...Object.values(DECISIONS),
      ...Object.values(DISCONNECT_REASONS),
      ...UNLABELLED_OUTCOMES,
    ].filter((label) => !(label in ko));
    expect(missing).toEqual([]);
  });

  test("every event type the server writes says what it was", () => {
    /*
     * The three outcomes a row can fall back to are correct for exactly three event types — the
     * computer's own allow, refuse and fail — because those are what the fallback was written
     * about. Every other type needs its own words, and this list is the explicit statement of that:
     * a type is either labelled or named here, never silently defaulted.
     */
    const defaulted = new Set([
      "computer.action_allowed",
      "computer.action_refused",
      "computer.action_failed",
    ]);
    const unlabelled = auditEventTypes.filter(
      (type) => !(type in DECISIONS) && !defaulted.has(type),
    );
    expect(unlabelled).toEqual([]);
  });

  test("a label never claims an ended access was a permission", () => {
    // The specific inversion this file was written after finding: rows that read "Allowed".
    for (const type of [
      "mcp.account_disconnected",
      "credential.rotation_refused",
      "credential.revoked",
    ] as const) {
      expect(DECISIONS[type]).toBeDefined();
      expect(ko[DECISIONS[type] as string]).not.toBe(ko.Allowed);
    }
  });
});
