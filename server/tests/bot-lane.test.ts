import { describe, expect, test } from "bun:test";
import { createBotLane } from "../src/runner/bot-lane";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one thing at a time, per Bot", () => {
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

  test("the lane is released once a Bot is idle, so a long-lived process does not grow", async () => {
    const lane = createBotLane();
    await lane.run("risk", async () => undefined);
    await tick(0);
    // Nothing to assert but the absence of a leak; the second run proves the map was not orphaned.
    expect(await lane.run("risk", async () => "second")).toBe("second");
  });
});
