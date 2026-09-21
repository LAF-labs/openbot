import { describe, expect, test } from "bun:test";
import { screenProblemText } from "../src/lib/computer/screen-problems";
import { screenLine, screenView } from "../src/lib/computer/screen-state";
import { ko } from "../src/lib/i18n-ko";

/**
 * THE SCREEN CARD'S STATE, FROM ITS FOUR FACTS: A FRAME, WHETHER IT IS BLANK, THE LAST PROBLEM, AND
 * WHETHER THIS PANE HAS ALREADY WATCHED A PAGE HERE.
 *
 * Decided in the card's JSX until 2026-09-18, where two cases fell through: a poll that failed after
 * a frame had arrived left the old picture up with nothing to say it had stopped, and a screen this
 * place does not have — no computer here, or a Bot this account may not see — was told to wait for
 * an administrator to check a computer.
 *
 * The fourth fact landed 2026-09-21, and it is the one no answer carries. MEASURED against the
 * shipping `agent-computer` image: with the Bot's tabs closed, the screenshot route answers 200 with
 * a frame byte-identical to a browser that has never been used — same sha256, same `about:blank`.
 * So "the Bot closed the page" and "the Bot has not opened one" are the same answer, and the pane's
 * own memory of having seen a page is what tells them apart.
 */

const view = (
  hasFrame: boolean,
  isBlank: boolean,
  problem: string | null,
  sawPage = false,
) => screenView({ hasFrame, isBlank, problem, sawPage });

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

  test("a page that was here and is gone is a different sentence from one that never was", () => {
    const closed = view(true, true, null, true);
    expect(closed).toEqual({
      kind: "closed",
      sentence: "The Bot closed the page it was looking at.",
      advice: "Nothing has gone wrong. It opens another when it needs one.",
    });
    // The same white rectangle, the same `about:blank`, the opposite sentence.
    expect(view(true, true, null, false).kind).toBe("blank");
  });

  test("a page having been here does not turn a failure into a closed page", () => {
    /*
     * The third of the three, and the order matters: a poll that starts failing after the Bot
     * closed a tab must say the connection is the trouble, not that a page was closed.
     */
    const down = view(false, false, "laf:computer_unreachable", true);
    expect(down.kind).toBe("problem");
    // And a frame still arriving with a page on it outranks both.
    expect(view(true, false, null, true).kind).toBe("showing");
    expect(view(true, true, "laf:not_found", true).kind).toBe("unavailable");
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
      "The Bot closed the page it was looking at.",
      "Nothing has gone wrong. It opens another when it needs one.",
      "The Bot is on {site}.",
      "The Bot is looking at a page.",
    ];
    expect(sentences.filter((sentence) => !ko[sentence])).toEqual([]);
  });
});

/**
 * THE ONE LINE A FOLDED PANEL KEEPS.
 *
 * Folding the panel has to leave something behind, or it is the same gesture as closing it. Every
 * branch here is a state the card already decided: the line is that state said in one sentence, not
 * a second opinion about it.
 */
describe("the whole card in one line", () => {
  test("a page on screen is named by its address, which is the only thing the picture said", () => {
    expect(
      screenLine(view(true, false, null), "https://nid.naver.com/login?x=1"),
    ).toBe("The Bot is on nid.naver.com.");
    // A port is part of which page this is; a path is not.
    expect(screenLine(view(true, false, null), "http://localhost:3000/a")).toBe(
      "The Bot is on localhost:3000.",
    );
  });

  test("a page whose address cannot be read is still a page", () => {
    // An older computer sends no `url` at all, and Chrome can report one this parser will not take.
    for (const url of [null, "", "not a url"]) {
      expect(screenLine(view(true, false, null), url)).toBe(
        "The Bot is looking at a page.",
      );
    }
  });

  test("a picture that has stopped says that, rather than where it stopped", () => {
    const line = screenLine(
      view(true, false, "laf:computer_unreachable"),
      "https://nid.naver.com/",
    );
    expect(line).toContain("The picture is not updating.");
    expect(line).not.toContain("nid.naver.com");
  });

  test("every other state hands over its own sentence", () => {
    expect(screenLine(view(false, false, null), null)).toBe(
      "Waiting for the Bot's screen…",
    );
    expect(screenLine(view(true, true, null), "about:blank")).toBe(
      "The Bot has not opened a page yet.",
    );
    expect(screenLine(view(true, true, null, true), "about:blank")).toBe(
      "The Bot closed the page it was looking at.",
    );
    expect(screenLine(view(false, false, "laf:not_found"), null)).toBe(
      "This place has no computer for its Bots, so there is no screen to show.",
    );
    expect(
      screenLine(view(false, false, "laf:computer_unreachable"), null),
    ).toBe("The Bot's computer could not be reached.");
  });

  test("it always has words: a folded panel that goes blank is a panel that closed itself", () => {
    for (const problem of [null, "laf:computer_unreachable", "laf:not_found"]) {
      for (const hasFrame of [true, false]) {
        for (const isBlank of [true, false]) {
          for (const sawPage of [true, false]) {
            const line = screenLine(
              view(hasFrame, isBlank, problem, sawPage),
              "https://example.com/",
            );
            expect(line.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
