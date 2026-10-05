import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  followTyping,
  inFocus,
  inTurn,
  TURN_WAIT_MS,
  typedIntoBlind,
} from "../src/person-typing";
import { createSessions } from "../src/sessions";

/**
 * A PERSON'S INPUT, ONE PIECE AT A TIME — WITHOUT A BROWSER.
 *
 * Every keystroke now waits on a question to the page before it is sent (`person-typing.ts`), so the
 * pieces are put in a line: out of order, two syllables land swapped. And a line is a thing that can
 * stall, so the wait for the piece before is bounded — a renderer that never takes a key must not keep
 * the person from handing the wheel back.
 */

const session = () =>
  createSessions({
    stateDirectoryFor: (botId) => join(tmpdir(), "laf-person-typing", botId),
  }).sessionFor("person-typing-bot");

describe("a person's input", () => {
  test("is applied in the order it arrived, whichever piece would have answered first", async () => {
    const bot = session();
    const applied: string[] = [];
    await Promise.all([
      inTurn(bot, async () => {
        await Bun.sleep(50);
        applied.push("한");
      }),
      inTurn(bot, async () => {
        applied.push("글");
      }),
    ]);
    expect(applied).toEqual(["한", "글"]);
  });

  test("a piece that fails stops nothing behind it, and its own caller hears the failure", async () => {
    const bot = session();
    const failed = inTurn(bot, async () => {
      throw new Error("the page went away");
    });
    const next = inTurn(bot, async () => "applied");
    await expect(failed).rejects.toThrow("the page went away");
    expect(await next).toBe("applied");
  });

  test("a piece the page never finishes holds the ones behind it for a bounded time, not for ever", async () => {
    const bot = session();
    void inTurn(bot, () => new Promise<void>(() => {}));
    const started = Date.now();
    expect(await inTurn(bot, async () => "handed back")).toBe("handed back");
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(TURN_WAIT_MS - 50);
    expect(waited).toBeLessThan(TURN_WAIT_MS + 2_000);
  }, 15_000);
});

/**
 * WHAT HAS FOCUS IS ANSWERED WITH A STRING. An object does not come back from a page that replaces
 * `Map` (고용24): it arrived as nothing, which was read as a page that would not say, and every key
 * a person pressed there was a key typed blind. Through the door on such a page in
 * `takeover-secret.test.ts`; here, what each answer means and that anything else means none.
 */
describe("what the page says has focus", () => {
  test("is read from a string: nothing to follow, a frame to enter, the same box with what it holds, another box or region", () => {
    expect(inFocus("n")).toEqual({ kind: "none" });
    expect(inFocus("f")).toEqual({ kind: "frame" });
    expect(inFocus("o")).toEqual({ kind: "other" });
    expect(inFocus("s")).toEqual({ kind: "same", value: "" });
    // What the box holds is everything after the first character, whatever it is.
    expect(inFocus("so | n")).toEqual({ kind: "same", value: "o | n" });
  });

  test("and anything that is not one of those answers is no answer, not an empty focus", () => {
    for (const said of [undefined, null, {}, { kind: "none" }, "", "x", 0]) {
      expect(inFocus(said)).toBeUndefined();
    }
  });

  /*
   * A QUESTION THAT FAILED IS NOT AN ANSWER THAT NOTHING HAS FOCUS. It fails when the document is
   * replaced under it or the frame goes, and the key is then on its way into a document nobody
   * asked anything. It was read as no box at all until 2026-10-05: the key went, nothing was
   * followed, and the tab was not blind either — so whatever the key landed in was shown.
   */
  test("a question that fails is not an answer: the tab is typed into blind, where a page that says nothing has focus is not", async () => {
    const pageWhoseFocus = (asked: () => Promise<unknown>) =>
      ({ mainFrame: () => ({ evaluateHandle: asked }) }) as unknown as Page;

    const failing = session();
    const gone = pageWhoseFocus(async () => {
      throw new Error("Execution context was destroyed");
    });
    await followTyping(failing, gone, "CANARY-failed-focus-7391");
    expect(typedIntoBlind(failing, gone)).toBe(true);
    expect(failing.secretFields).toEqual([]);

    // The page answered, and nothing it could name has focus: that is known, and not blind.
    const answering = session();
    const idle = pageWhoseFocus(async () => ({
      asElement: () => null,
      dispose: async () => undefined,
    }));
    await followTyping(answering, idle, "CANARY-no-focus-7391");
    expect(typedIntoBlind(answering, idle)).toBe(false);
  });
});
