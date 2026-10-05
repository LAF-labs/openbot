import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inTurn, TURN_WAIT_MS } from "../src/person-typing";
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
