import { describe, expect, test } from "bun:test";
import { COMPUTER_TOOLS } from "../../shared/tools/computer";
import type {
  ProductsRefusal,
  RunEnding,
} from "../../shared/workbench/protocol";
import { auditEventTypes, auditFactCodes } from "../../server/src/audit";
import { STOPPED } from "../../server/src/computer/client";
import { ActionNeedsApprovalError } from "../../server/src/computer/gateway/caller";
import { RUN_SCRIPT_TOOL } from "../../server/src/computer/gateway/intent";
import {
  COMPUTER_FACTS,
  DECISIONS,
  DISCONNECT_REASONS,
  decisionOf,
  EVENTS,
  FACTS,
  OUTCOME_EVENT_TYPES,
  SCRIPT_ENDINGS,
  SCRIPT_FILES_LEFT,
  SCRIPT_FILES_WITHHELD,
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
      ...Object.values(COMPUTER_FACTS),
      ...Object.values(SCRIPT_ENDINGS),
      ...Object.values(SCRIPT_FILES_WITHHELD),
      ...Object.values(SCRIPT_FILES_LEFT),
      "These files were not tried",
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
    const unlabelled = auditEventTypes.filter(
      (type) => !(type in DECISIONS) && !OUTCOME_EVENT_TYPES.has(type),
    );
    expect(unlabelled).toEqual([]);
  });

  /*
   * THE ROWS THE CODE OUTLIVED. The trail is append-only, so a type the server stopped writing —
   * `coworker.asked` and `room.member_turn` since rooms and Bots asking each other were removed
   * (2026-09-24) — keeps its rows after its label is gone. Such a row has no verdict to show; the
   * fallback outcomes are the computer's own, and drawing one of these as "Allowed" is the exact
   * inversion this file exists to prevent.
   */
  test("a type the surface no longer labels has no verdict, and is never called Allowed", () => {
    for (const retired of ["coworker.asked", "room.member_turn"]) {
      expect(auditEventTypes as readonly string[]).not.toContain(retired);
      expect(retired in DECISIONS).toBe(false);
      expect(retired in EVENTS).toBe(false);
      expect(decisionOf(retired, false, false)).toBeUndefined();
      expect(decisionOf(retired, false, true)).toBeUndefined();
    }
    expect(decisionOf("computer.action_allowed", false, false)).toBe("Allowed");
    expect(decisionOf("computer.action_refused", true, false)).toBe("Blocked");
    expect(decisionOf("computer.action_failed", false, true)).toBe(
      "Did not happen",
    );
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

  /*
   * THE ONE ACT THE GATEWAY RECORDS UNDER A NAME THE CATALOGUE DOES NOT HAVE. A script's run is
   * offered to no Bot, so the walk above — the catalogue's names — never reaches it, and its rows
   * would print `mcp__workbench__run_script` in a chip. Held to the SERVER's own constant, so the
   * name cannot be respelled on one side.
   */
  test("the name a script's run is recorded under has words for the What column", () => {
    expect(TOOLS[RUN_SCRIPT_TOOL]).toBe("Run a small program");
    expect(COMPUTER_TOOLS.map((tool) => tool.name)).not.toContain(
      RUN_SCRIPT_TOOL,
    );
  });

  /*
   * HOW A RUN ENDED is read from a row by a variable too (`payload.ending`,
   * `payload.productsRefused`). The lists are the protocol's own types: a third way for a run to
   * end, added there, is a typecheck error here until this column has words for it.
   */
  test("every way a script's run can end, and every reason its files were withheld, has words", () => {
    const endings = Object.keys({
      exited: true,
      timed_out: true,
      out_of_memory: true,
    } satisfies Record<RunEnding, true>);
    const withheld = Object.keys({
      too_many: true,
      too_large: true,
      too_large_together: true,
    } satisfies Record<ProductsRefusal, true>);
    expect(Object.keys(SCRIPT_ENDINGS).sort()).toEqual([...endings].sort());
    expect(Object.keys(SCRIPT_FILES_WITHHELD).sort()).toEqual(
      [...withheld].sort(),
    );
    // Only the ending a script reaches by itself has a status to say.
    expect(SCRIPT_ENDINGS.exited).toContain("{code}");
    expect(ko[SCRIPT_ENDINGS.exited]).toContain("{code}");
    for (const killed of ["timed_out", "out_of_memory"] as const) {
      expect(SCRIPT_ENDINGS[killed]).not.toContain("{code}");
    }
  });

  /*
   * WHY A RUN'S FILES WERE NEVER TRIED is read from a row by a variable too (`payload.because`),
   * and it is one of the two facts a call can end its filing with: the caller's Stop, as the
   * computer's client says it, and a question, as the gateway's error for one says it. Held to
   * the server's own words for both, so neither can be respelled on one side.
   */
  test("each reason a run's files were left untried has words, and they are the two the server ends a filing with", () => {
    const asked = new ActionNeedsApprovalError({
      id: "a",
      subject: { kind: "file", intent: "write_file", reason: "policy_ask" },
      rule: "true",
    } as unknown as ConstructorParameters<typeof ActionNeedsApprovalError>[0]);
    expect(Object.keys(SCRIPT_FILES_LEFT).sort()).toEqual(
      [STOPPED, asked.code].sort(),
    );
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
