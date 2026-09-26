/**
 * After a reload the routine tool line is drawn from the action the Bot asked for, not from this
 * tab's memory. A Bot that only listed its routines read "Changed a routine" until 2026-09-24.
 */
import { describe, expect, test } from "bun:test";
import { rememberLineFor, routineLineFor } from "@/lib/copilot/self-tools";
import { t } from "@/lib/i18n";
import { toolResultText } from "../../shared/prompt/tool-results.ko";

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

/*
 * The same fault on `remember`, measured in the 0.5.4 final QA: a saved shop location read
 * "가게 위치를 저장했어요 · 서울 마포구" while it ran and "기억해 두었어요" with nothing under it after
 * a reload.
 */
describe("rememberLineFor — a reloaded remember line says what was kept", () => {
  test("a saved place reads as the shop's location, with the place", () => {
    expect(
      rememberLineFor(
        { place: "서울 마포구" },
        JSON.stringify(toolResultText("laf:place_saved")),
      ),
    ).toEqual({ done: t("Saved the shop's location"), note: "서울 마포구" });
  });

  test("a kept fact reads as remembered, with the fact", () => {
    expect(
      rememberLineFor(
        { fact: "일요일은 쉰다" },
        toolResultText("laf:remembered"),
      ),
    ).toEqual({ done: t("Remembered something"), note: "일요일은 쉰다" });
  });

  test("a refusal shows nothing it was asked to keep, and reads as failed", () => {
    const line = rememberLineFor(
      { fact: "비밀번호는 hunter2" },
      toolResultText("laf:memory_looks_like_a_secret"),
    );
    expect(line.failed).toBe(true);
    expect(JSON.stringify(line)).not.toContain("hunter2");
  });

  test("a failed line names what was tried, not what was done", () => {
    expect(
      rememberLineFor({ fact: "" }, toolResultText("laf:memory_empty")),
    ).toEqual({ done: t("Remember something"), failed: true });
    expect(
      rememberLineFor(
        { place: "서울 마포구" },
        toolResultText("laf:place_refused"),
      ),
    ).toEqual({ done: t("Save the shop's location"), failed: true });
  });
});
