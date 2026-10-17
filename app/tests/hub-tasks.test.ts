import { describe, expect, test } from "bun:test";
import { companyKeys, hubKeysForFrame } from "../src/lib/hub/company";
import {
  assigneeLabel,
  type CompanyTask,
  columnsOf,
  dropIndex,
  movedLocally,
  placeTask,
  rankBetween,
  stepTask,
  taskConversationOf,
  taskFactText,
  taskNoteText,
} from "../src/lib/hub/tasks";
import { ko } from "../src/lib/i18n-ko";

/**
 * 업무판: where a dropped card lands (a rank between its neighbours, one write per move), the keyboard's
 * steps, a 라피's coded notes in plain Korean and never as codes, who a task is given to, and which
 * reads a task frame makes stale.
 */

function task(
  id: string,
  stage: CompanyTask["stage"],
  rank: number,
): CompanyTask {
  return {
    id,
    title: id,
    description: null,
    stage,
    visibility: "company",
    members: [],
    assignee: null,
    assignedBy: null,
    createdBy: "m_a",
    checkout: null,
    version: 1,
    rank,
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    doneAt: null,
  };
}

const board = [
  task("t_c", "todo", 30),
  task("t_a", "todo", 10),
  task("t_b", "todo", 20),
  task("t_d", "doing", 5),
];

describe("columns and ranks", () => {
  test("each column is in rank order, smallest first", () => {
    const columns = columnsOf(board);
    expect(columns.todo.map((one) => one.id)).toEqual(["t_a", "t_b", "t_c"]);
    expect(columns.doing.map((one) => one.id)).toEqual(["t_d"]);
    expect(columns.review).toEqual([]);
  });

  test.each([
    [10, 20, 0, 15],
    [undefined, 10, 0, 9],
    [30, undefined, 0, 31],
    [undefined, undefined, 7, 7],
  ])("between %p and %p (was %p) is %p", (before, after, current, rank) => {
    expect(rankBetween(before, after, current)).toBe(rank);
  });

  test("a card dropped between two takes the rank halfway between them", () => {
    // t_c to between t_a and t_b.
    expect(placeTask(columnsOf(board), "t_c", "todo", 1)).toEqual({
      stage: "todo",
      rank: 15,
    });
  });

  test("a card dropped at the top of another column goes above its first card", () => {
    expect(placeTask(columnsOf(board), "t_a", "doing", 0)).toEqual({
      stage: "doing",
      rank: 4,
    });
  });

  test("a card dropped at the bottom goes below the last, and into an empty column keeps its rank", () => {
    expect(placeTask(columnsOf(board), "t_a", "todo", 9)).toEqual({
      stage: "todo",
      rank: 31,
    });
    expect(placeTask(columnsOf(board), "t_b", "review", 0)).toEqual({
      stage: "review",
      rank: 20,
    });
  });

  test("a card dropped where it already is moves nothing", () => {
    expect(placeTask(columnsOf(board), "t_b", "todo", 1)).toBeNull();
  });

  test("the drop index is read off the cards' middles", () => {
    expect(dropIndex([100, 200, 300], 50)).toBe(0);
    expect(dropIndex([100, 200, 300], 150)).toBe(1);
    expect(dropIndex([100, 200, 300], 350)).toBe(3);
    expect(dropIndex([], 10)).toBe(0);
  });

  test("the move shows at once, with the version it was read at", () => {
    const moved = movedLocally(board, "t_a", { stage: "doing", rank: 4 });
    expect(moved.find((one) => one.id === "t_a")).toMatchObject({
      stage: "doing",
      rank: 4,
      version: 1,
    });
    expect(moved.find((one) => one.id === "t_b")?.stage).toBe("todo");
  });
});

describe("the menu's steps", () => {
  test("up and down swap places with the neighbour", () => {
    const columns = columnsOf(board);
    expect(stepTask(columns, "t_b", "up")).toEqual({ stage: "todo", rank: 9 });
    expect(stepTask(columns, "t_b", "down")).toEqual({
      stage: "todo",
      rank: 31,
    });
  });

  test("the top card cannot go up, and another column takes it at its top", () => {
    const columns = columnsOf(board);
    expect(stepTask(columns, "t_a", "up")).toBeNull();
    expect(stepTask(columns, "t_c", "doing")).toEqual({
      stage: "doing",
      rank: 4,
    });
    expect(stepTask(columns, "t_c", "todo")).toBeNull();
  });
});

describe("a 라피's notes, in Korean and never as codes", () => {
  const said = (text: string) => {
    const note = taskNoteText({ text });
    return { ...note, ko: ko[note.text] ?? null };
  };

  test.each([
    [
      "laf:task_ran run:run_1 steps:3",
      "Lafi finished in {n} steps. Have a look.",
      false,
    ],
    ["laf:task_ran run:run_1", "Lafi finished. Have a look.", false],
    [
      "laf:task_needs_login run:run_1",
      "Lafi stopped at a sign-in nobody saved.",
      true,
    ],
    [
      "laf:task_needs_person run:run_1",
      "Lafi stopped for somebody to look.",
      true,
    ],
    [
      "laf:task_run_failed run:run_1 code:laf:model_timeout",
      "Lafi could not finish this.",
      true,
    ],
    ["laf:task_run_stopped run:run_1", "Lafi's work was stopped.", true],
    ["laf:task_something_new run:run_1", "A note from Lafi", false],
  ])("%s", (text, key, isStop) => {
    const note = taskNoteText({ text });
    // Tests run in English: the sentence is the key, filled in, and the key has its Korean.
    expect(note.text).toBe(key.replace("{n}", "3"));
    expect(ko[key]).toBeString();
    expect(note.text).not.toContain("laf:");
    expect(note.runId).toBe("run_1");
    expect(note.isStop).toBe(isStop);
  });

  test("a needs-approval note names the site and the action in words", () => {
    const note = taskNoteText({
      text: "laf:task_needs_approval run:run_9 topic:browser/activate@smartstore.naver.com",
    });
    expect(note.text).toBe(
      "Lafi is waiting for an OK: Press a button on smartstore.naver.com",
    );
    expect(note.runId).toBe("run_9");
    expect(note.isStop).toBe(true);
  });

  test("a needs-approval note about a connected service names the service", () => {
    expect(
      taskNoteText({
        text: "laf:task_needs_approval run:r topic:tool/tool@gmail/send_email",
      }).text,
    ).toBe("Lafi is waiting for an OK: Do something on gmail");
  });

  test("a person's note is its own words", () => {
    expect(said("거래처에 전화했어요").text).toBe("거래처에 전화했어요");
    expect(said("거래처에 전화했어요").runId).toBeNull();
  });
});

describe("who a task is given to", () => {
  const context = {
    meId: "m_a",
    members: [
      { id: "m_a", name: "김민수", role: "admin" as const },
      { id: "m_b", name: "이수진", role: "member" as const },
    ],
    jobs: [{ id: "rt_1", name: "아침 매출 확인" }],
  };

  test.each([
    [null, "Nobody yet"],
    ["bot:m_a", "My Lafi"],
    ["bot:m_b", "이수진's Lafi"],
    ["m_a", "Nobody yet"],
    ["m:m_a", "Me"],
    ["m:m_b", "이수진"],
    ["job:rt_1", "Routine · 아침 매출 확인"],
    ["job:rt_other", "A routine"],
  ])("%p is %p", (assignee, label) => {
    expect(assigneeLabel(assignee, context)).toBe(label);
  });
});

describe("the board's facts and frames", () => {
  test("a stale move says somebody changed it, and the hub's own facts keep 회사's words", () => {
    expect(taskFactText("laf:task_stale")).toBe(
      "Somebody changed this task just now. The board is up to date again.",
    );
    expect(
      ko["Somebody changed this task just now. The board is up to date again."],
    ).toBe("방금 다른 사람이 이 업무를 바꿨어요. 업무판을 새로 불러왔어요.");
    expect(taskFactText("laf:hub_unreachable")).toBe(
      "Cannot reach the company server · trying again",
    );
    expect(taskFactText("laf:something_else")).toBeNull();
  });

  test("a task frame asks the board and that task again, and nothing else", () => {
    expect(hubKeysForFrame({ kind: "hub.task.changed", refId: "t_1" })).toEqual(
      [companyKeys.tasks, companyKeys.task("t_1")],
    );
    expect(
      hubKeysForFrame({ kind: "hub.task.assigned", refId: "t_2" }),
    ).toEqual([companyKeys.tasks, companyKeys.task("t_2")]);
  });

  test("the run's conversation is the one named by the task, on this VM", () => {
    const channels = [
      { id: "channel_1", threadId: "thread_main" },
      { id: "channel_2", threadId: "task:t_9" },
    ];
    expect(taskConversationOf("t_9", channels)?.id).toBe("channel_2");
    expect(taskConversationOf("t_8", channels)).toBeUndefined();
  });
});
