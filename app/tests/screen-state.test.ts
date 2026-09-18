import { describe, expect, test } from "bun:test";
import { screenProblemText } from "../src/lib/computer/screen-problems";
import { screenView } from "../src/lib/computer/screen-state";
import { ko } from "../src/lib/i18n-ko";

/**
 * THE SCREEN CARD'S STATE, FROM ITS THREE FACTS: A FRAME, WHETHER IT IS BLANK, AND THE LAST PROBLEM.
 *
 * Decided in the card's JSX until 2026-09-18, where two cases fell through: a poll that failed after
 * a frame had arrived left the old picture up with nothing to say it had stopped, and a screen this
 * place does not have — no computer here, or a Bot this account may not see — was told to wait for
 * an administrator to check a computer.
 */

const view = (hasFrame: boolean, isBlank: boolean, problem: string | null) =>
  screenView({ hasFrame, isBlank, problem });

describe("the screen card", () => {
  test("waits only while there is nothing and nothing is wrong", () => {
    expect(view(false, false, null)).toEqual({
      kind: "waiting",
      label: "Waiting for the Bot's screen…",
    });
  });

  test("a page on screen is shown, and says nothing about itself", () => {
    expect(view(true, false, null)).toEqual({ kind: "showing", stale: null });
  });

  test("a page whose next frame failed is still shown, and says it has stopped updating", () => {
    const shown = view(true, false, "laf:computer_unreachable");
    expect(shown.kind).toBe("showing");
    if (shown.kind !== "showing") return;
    expect(shown.stale).toContain(
      "The picture is not updating. This is the last one that arrived.",
    );
    expect(shown.stale).toContain(
      screenProblemText("laf:computer_unreachable"),
    );
  });

  test("a problem with the wheel is not a frozen picture", () => {
    // Somebody else driving, or a key that did not land: the frames are still arriving.
    for (const code of [
      "laf:human_has_control",
      "laf:take_control_first",
      "laf:input_not_applied",
    ]) {
      expect(view(true, false, code)).toEqual({ kind: "showing", stale: null });
    }
  });

  test("a blank browser says so in words", () => {
    expect(view(true, true, null)).toEqual({
      kind: "blank",
      sentence: "The Bot has not opened a page yet.",
    });
  });

  test("nothing to show and a problem is the problem, with the advice that fits it", () => {
    expect(view(false, false, "laf:computer_unreachable")).toEqual({
      kind: "problem",
      heading: "You cannot see the screen right now",
      sentence: "The Bot's computer could not be reached.",
      advice:
        "The Bot may still be working. An administrator can check whether its computer is running.",
    });
    // Nobody needs to check a computer because somebody else holds its wheel.
    const held = view(false, false, "laf:human_has_control");
    expect(held.kind === "problem" && held.advice).toBeNull();
  });

  test("a screen this place or this account cannot have says so, and sends nobody to check on it", () => {
    const none = view(false, false, "laf:not_found");
    expect(none).toEqual({
      kind: "unavailable",
      sentence:
        "This place has no computer for its Bots, so there is no screen to show.",
    });
    const notYours = view(true, false, "laf:bot_not_found");
    expect(notYours).toEqual({
      kind: "unavailable",
      sentence: "This account cannot see this Bot's screen.",
    });
    // Not even the frame from before: a refusal outranks what was shown.
    expect(view(true, false, "laf:no_access").kind).toBe("unavailable");
  });

  test("every sentence it can say has Korean", () => {
    const sentences = [
      "Waiting for the Bot's screen…",
      "The picture is not updating. This is the last one that arrived.",
      "The Bot has not opened a page yet.",
      "You cannot see the screen right now",
      "The Bot may still be working. An administrator can check whether its computer is running.",
      "This place has no computer for its Bots, so there is no screen to show.",
      "This account cannot see this Bot's screen.",
    ];
    expect(sentences.filter((sentence) => !ko[sentence])).toEqual([]);
  });
});
