import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TaskBoardShown } from "./support/task-board-render";

/**
 * 업무판, pressed the way a person presses it. What each scenario saw is read in a process of its
 * own (`support/task-board-render.tsx` says why a card's menu cannot be opened here: beside a file
 * that imported an app module before any DOM existed, it opens nothing).
 */
let rendering: Promise<TaskBoardShown> | undefined;
function rendered(): Promise<TaskBoardShown> {
  rendering ??= render();
  return rendering;
}

async function render(): Promise<TaskBoardShown> {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/task-board-render.tsx")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("TASK_BOARD "));
  if (status !== 0 || !line) {
    throw new Error(
      `the board's render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("TASK_BOARD ".length)) as TaskBoardShown;
}

/** A cold `bun` that imports the route tree is seconds of CPU when every core is busy. */
const RENDER_TIMEOUT_MS = 60_000;

describe("a card on its way", () => {
  /*
   * A second move would carry the version the first one is about to replace, and the hub would
   * refuse it as `laf:task_stale`: the second place dropped, and the board saying somebody else
   * changed a task nobody else touched.
   */
  test(
    "the menu does not send a second move while the first is unanswered",
    async () => {
      const { pending } = await rendered();
      expect(pending.error).toBeUndefined();
      expect(pending.afterFirst).toEqual([
        { version: 1, stage: "doing", rank: 10 },
      ]);
      expect(pending.whileOnItsWay).toHaveLength(1);
      // Once the hub has answered, the card moves again, from the version it gave back.
      expect(pending.afterLanding).toHaveLength(2);
      expect(pending.afterLanding[1]).toMatchObject({
        version: 2,
        stage: "review",
      });
    },
    RENDER_TIMEOUT_MS,
  );
});
