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

describe("a drag put back with Escape", () => {
  /*
   * The release's click is swallowed so a drag does not open the task. Escape ended the drag
   * before the release, and the release then found nothing to end, so nothing un-swallowed it: the
   * next click on a title that no press had come before — Enter, a finger's tap — opened nothing.
   */
  test(
    "leaves the next click on a card to open its task",
    async () => {
      const { escaped } = await rendered();
      expect(escaped.error).toBeUndefined();
      expect(escaped.wasDragging).toBe(true);
      expect(escaped.putBack).toBe(true);
      expect(escaped.opened).toBe("t_a");
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("a write's key follows what is written", () => {
  /*
   * The hub answers a repeated key with its first answer, whatever the body. A key kept from the
   * first press would have an edited retry answered as the old write, which is never made.
   */
  test(
    "a new task pressed again keeps its key, and an edited title gets a new one",
    async () => {
      const { newTask } = await rendered();
      expect(newTask.error).toBeUndefined();
      const [first, again, edited] = newTask.writes;
      expect(newTask.writes).toHaveLength(3);
      expect(first?.body).toEqual({ title: "견적서", visibility: "company" });
      expect(again?.key).toBe(first?.key ?? "missing");
      expect(edited?.body).toEqual({
        title: "견적서 보내기",
        visibility: "company",
      });
      expect(edited?.key).toEqual(expect.any(String));
      expect(edited?.key).not.toBe(first?.key ?? null);
    },
    RENDER_TIMEOUT_MS,
  );

  test(
    "a note sent again keeps its key, and edited words get a new one",
    async () => {
      const { note } = await rendered();
      expect(note.error).toBeUndefined();
      const [first, again, edited] = note.writes;
      expect(note.writes).toHaveLength(3);
      expect(first?.body).toEqual({ text: "내일 보내요" });
      expect(again?.key).toBe(first?.key ?? "missing");
      expect(edited?.body).toEqual({ text: "내일 아침에 보내요" });
      expect(edited?.key).toEqual(expect.any(String));
      expect(edited?.key).not.toBe(first?.key ?? null);
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("회사 draws one part at a time", () => {
  test(
    "on 업무판 a tab the address still names draws nothing under the board",
    async () => {
      const { company } = await rendered();
      expect(company.error).toBeUndefined();
      expect(company.onTasks).toEqual({ board: true, files: false });
      // The same tab, away from 업무판, is drawn: the absence above is the board's doing.
      expect(company.onFiles).toEqual({ board: false, files: true });
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("a press ends wherever it is let go", () => {
  /*
   * The card hears a release only once it holds the pointer, or while the pointer is over it. A
   * press whose first move had already left the card, let go over the column, stayed open: the next
   * hover over any card dragged the first one, and the next click dropped it there.
   */
  test(
    "a flick off the card let go over the column leaves no drag for the next press",
    async () => {
      const { strayPress } = await rendered();
      expect(strayPress.error).toBeUndefined();
      expect(strayPress.ghostWhileHeld).toBe(false);
      expect(strayPress.patches).toEqual([]);
    },
    RENDER_TIMEOUT_MS,
  );

  test(
    "a flick let go outside the window leaves no drag for the next hover and click",
    async () => {
      const { lostRelease } = await rendered();
      expect(lostRelease.error).toBeUndefined();
      expect(lostRelease.ghostOnHover).toBe(false);
      expect(lostRelease.patches).toEqual([]);
    },
    RENDER_TIMEOUT_MS,
  );

  test(
    "a card taken off the page mid-drag ends the drag, and nothing moves later",
    async () => {
      const { unmounted } = await rendered();
      expect(unmounted.error).toBeUndefined();
      expect(unmounted.wasDragging).toBe(true);
      // A finger's grip handing its capture to the card is not the drag ending; the card's loss is.
      expect(unmounted.ghostAfterHandOver).toBe(true);
      expect(unmounted.ghostAfterLost).toBe(false);
      expect(unmounted.ghostOnHover).toBe(false);
      expect(unmounted.patches).toEqual([]);
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("the board offers only what the hub takes", () => {
  /*
   * A task given to a 라피 or a routine enters 하는 중 only when its run takes it; the hub refuses a
   * person putting it there, every time. Offered, it came back with no reason.
   */
  test(
    "a 라피's card is not offered 하는 중, by its menu or as a place to drop it; a person's is",
    async () => {
      const { runCard } = await rendered();
      expect(runCard.error).toBeUndefined();
      expect(runCard.menu).toEqual(["review", "blocked", "done", "up", "down"]);
      expect(runCard.lineForRun).toBe(false);
      expect(runCard.lineForPerson).toBe(true);
      expect(runCard.patches).toEqual([
        {
          path: "/api/hub/tasks/t_b",
          body: { version: 1, stage: "doing", rank: 20 },
        },
      ]);
    },
    RENDER_TIMEOUT_MS,
  );

  test(
    "a refused move puts back its own card alone, and says which part was refused",
    async () => {
      const { refusedAlone } = await rendered();
      expect(refusedAlone.error).toBeUndefined();
      // B's move, taken while A's was on its way, stays where the hub put it.
      expect(refusedAlone.columns).toEqual({ t_a: "todo", t_b: "review" });
      expect(refusedAlone.notice).toBe(
        "A task for a Lafi or a routine moves to Doing when it starts on it.",
      );
    },
    RENDER_TIMEOUT_MS,
  );
});

describe("who does it, as the hub would take it", () => {
  /*
   * A task a person holds in 하는 중 handed to a 라피 or a routine is refused by the hub every time:
   * nothing takes it there but its run's own checkout.
   */
  test(
    "a task a person is doing is not offered to a 라피 or a routine; the same task to do is",
    async () => {
      const { choices } = await rendered();
      expect(choices.error).toBeUndefined();
      expect(choices.doing).toEqual([]);
      expect(choices.todo).toEqual(["bot:m_a", "job:rt_1"]);
    },
    RENDER_TIMEOUT_MS,
  );
});
