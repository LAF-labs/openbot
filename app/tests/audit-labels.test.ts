import { describe, expect, test } from "bun:test";
import { COMPUTER_TOOLS } from "../../shared/tools/computer";
import { auditEventTypes, auditFactCodes } from "../../server/src/audit";
import {
  DECISIONS,
  DISCONNECT_REASONS,
  EVENTS,
  FACTS,
  TOOLS,
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
      ...Object.values(EVENTS),
      ...Object.values(TOOLS),
      ...Object.values(FACTS),
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

/**
 * THE OTHER TWO COLUMNS THAT USED TO PRINT IDENTIFIERS.
 *
 * `DECISIONS` above covers the last column. The middle one — what the Bot did — had no table at
 * all: it showed `payload.action` with the namespace sliced off, and for every row without a tool
 * it showed the raw event type, so the audit trail opened on `computer.isolation_loaded`,
 * `model.usage` and `routine.ran`, in English, on a Korean screen.
 *
 * Both tables are walked against the source of truth on the OTHER side of the wire rather than
 * against themselves: the server's own event list, and the tool catalogue every Bot is registered
 * from. A tool added to `shared/tools/computer.ts` or an event type added to `server/src/audit.ts`
 * fails here until somebody decides what it says.
 */
describe("what the trail says happened", () => {
  test("every event type the server writes has words for the What column", () => {
    const unlabelled = auditEventTypes.filter((type) => !(type in EVENTS));
    expect(unlabelled).toEqual([]);
  });

  test("every tool in the catalogue has words for the What column", () => {
    const unlabelled = COMPUTER_TOOLS.map((tool) => tool.name).filter(
      (name) => !(name in TOOLS),
    );
    expect(unlabelled).toEqual([]);
    // The catalogue is a Vite-free plain module here, so an empty import would pass the line above
    // by walking nothing at all.
    expect(COMPUTER_TOOLS.length).toBeGreaterThanOrEqual(14);
  });

  test("every fact code the server records has a sentence", () => {
    const unlabelled = auditFactCodes.filter((code) => !(code in FACTS));
    expect(unlabelled).toEqual([]);
    expect(auditFactCodes.length).toBeGreaterThan(0);
  });

  test("no fact code is answered with the code", () => {
    // The failure this would otherwise have: a table entry written as `"laf:x": "laf:x"` to make the
    // walk above go green, which puts the prefix in front of a reader anyway.
    for (const [code, label] of Object.entries(FACTS)) {
      expect(label.startsWith("laf:")).toBe(false);
      expect(code.startsWith("laf:")).toBe(true);
    }
  });
});
