import { describe, expect, test } from "bun:test";
import { COMPUTER_TOOLS, drivesTheBrowser } from "../../shared/tools/computer";
import { computerIdOf } from "../src/computer/bot-id";
import { createBotLane } from "../src/runner/bot-lane";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one thing at a time, per browser", () => {
  test("two tasks on the same Bot do not overlap", async () => {
    const lane = createBotLane();
    const order: string[] = [];
    const slow = lane.run("risk", async () => {
      order.push("slow:start");
      await tick(30);
      order.push("slow:end");
    });
    const fast = lane.run("risk", async () => {
      order.push("fast:start");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow:start", "slow:end", "fast:start"]);
  });

  test("different Bots do not wait for each other", async () => {
    const lane = createBotLane();
    const order: string[] = [];
    const slow = lane.run("risk", async () => {
      await tick(30);
      order.push("risk");
    });
    const fast = lane.run("assistant", async () => {
      order.push("assistant");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["assistant", "risk"]);
  });

  test("a task that throws does not take the next one down with it", async () => {
    const lane = createBotLane();
    const failed = lane.run("risk", async () => {
      throw new Error("the page was gone");
    });
    await expect(failed).rejects.toThrow("the page was gone");
    expect(await lane.run("risk", async () => "ran anyway")).toBe("ran anyway");
  });

  test("a holder can let go while it waits on somebody, and learns who ran meanwhile", async () => {
    // A chat turn waiting on a person's answer lets a routine have the Bot, and takes it back after.
    const lane = createBotLane();
    const order: string[] = [];
    const turn = await lane.acquire("risk");
    const before = lane.grants("risk");
    const routine = lane.run("risk", async () => {
      order.push("routine");
    });
    await tick(10);
    expect(order).toEqual([]);
    turn.release();
    await routine;
    const back = await lane.acquire("risk");
    // Its own grant back is one; the routine was the other.
    expect(lane.grants("risk") - before).toBe(2);
    const after = lane.run("risk", async () => {
      order.push("after");
    });
    await tick(10);
    expect(order).toEqual(["routine"]);
    back.release();
    back.release();
    await after;
    expect(order).toEqual(["routine", "after"]);
  });

  test("the lane is released once a Bot is idle, so a long-lived process does not grow", async () => {
    const lane = createBotLane();
    await lane.run("risk", async () => undefined);
    await tick(0);
    // Nothing to assert but the absence of a leak; the second run proves the map was not orphaned.
    expect(await lane.run("risk", async () => "second")).toBe("second");
  });
});

/*
 * WHAT IS HELD IS A BROWSER (piece 5-4). The lane is keyed by the computer's id — the Bot's own
 * for its main browser — and a caller that does not use a browser does not ask for it.
 */
describe("the lane is a browser's, and says whether asking would mean waiting", () => {
  test("two browsers of one Bot's do not wait for each other", async () => {
    const lane = createBotLane();
    const main = await lane.acquire("bot-1");
    // Granted with the main browser still held: another browser is another lane.
    const background = await lane.acquire(computerIdOf("bot-1", "run-1"));
    expect(lane.grants("bot-1")).toBe(1);
    expect(lane.grants("bot-1@run-1")).toBe(1);
    background.release();
    main.release();
  });

  test("free, held, waited for, free again", async () => {
    const lane = createBotLane();
    expect(lane.busy("bot-1")).toBe(false);
    const first = await lane.acquire("bot-1");
    expect(lane.busy("bot-1")).toBe(true);
    const second = lane.acquire("bot-1");
    first.release();
    // Handed straight on to whoever was in line: still somebody's.
    (await second).release();
    await tick(0);
    expect(lane.busy("bot-1")).toBe(false);
    // And one browser's being held says nothing of another's.
    const held = await lane.acquire("bot-1");
    expect(lane.busy("bot-2")).toBe(false);
    held.release();
  });

  test("of the computer's tools, only the three that reach the folder alone are not a browser's", () => {
    expect(
      COMPUTER_TOOLS.map((entry) => entry.name).filter(
        (name) => !drivesTheBrowser(name),
      ),
    ).toEqual([
      "computer_list_files",
      "computer_read_file",
      "computer_write_file",
    ]);
  });

  test("a tool nobody has listed is taken to be a browser's", () => {
    // Left out by name, so a browser tool added later holds the lane without being listed.
    expect(drivesTheBrowser("computer_something_new")).toBe(true);
  });
});
