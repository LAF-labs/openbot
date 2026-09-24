/**
 * After a reload the routine tool line is drawn from the action the Bot asked for, not from this
 * tab's memory. A Bot that only listed its routines read "Changed a routine" until 2026-09-24.
 */
import { describe, expect, test } from "bun:test";
import { routineLineFor } from "@/lib/copilot/self-tools";
import { t } from "@/lib/i18n";

describe("routineLineFor — the line says what the Bot did", () => {
  test("listing reads as looking, never as changing", () => {
    expect(routineLineFor("list")).toEqual({
      doing: t("Looking at its routines"),
      done: t("Looked at its routines"),
    });
    expect(routineLineFor("list").done).not.toBe(t("Changed a routine"));
  });

  test("create and delete say so, and an unknown action falls back to changing", () => {
    expect(routineLineFor("create").done).toBe(t("Saved a routine"));
    expect(routineLineFor("delete").done).toBe(t("Deleted a routine"));
    expect(routineLineFor("update").done).toBe(t("Changed a routine"));
    expect(routineLineFor(undefined).done).toBe(t("Changed a routine"));
  });
});
