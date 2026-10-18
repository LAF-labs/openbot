/**
 * 업무판: the company's task board as this person's VM reads it (`server/src/hub/routes-ui-tasks.ts`)
 * — the columns, where a dropped card lands, who a task is given to, and a 라피's notes in words.
 *
 * ORDER IS A NUMBER BETWEEN TWO NUMBERS. A task's place in its column is its `rank`, smallest first.
 * A card dropped between two others takes the number halfway between theirs, so one move is one
 * write to one task — never a renumbering of the column, which would be a write per card and a
 * `laf:task_stale` for whoever moved any of them at the same moment.
 *
 * A MOVE CARRIES THE VERSION IT WAS MADE AGAINST. The hub answers an older one with 409
 * `laf:task_stale` (a 라피's run moved it, or a colleague did); the board then reads again and says
 * so in one short line, rather than writing over what somebody else just did.
 *
 * A 라피'S NOTE IS FACTS WITH A CODE (`laf:task_ran run:<id> steps:3`, written by the VM that ran the
 * task). The surface owns the sentence, so `taskNoteText` turns each code into plain Korean and
 * never shows a code; a code this build does not know reads as a note from the 라피, not as itself.
 */
import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { RequestRefusedError, requestOrRefusal } from "@/lib/refusals";
import {
  type CompanyMember,
  companyFactText,
  companyKeys,
  memberName,
} from "./company";

export const TASK_STAGES = [
  "todo",
  "doing",
  "review",
  "blocked",
  "done",
] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

export type CompanyTask = {
  id: string;
  title: string;
  description: string | null;
  stage: TaskStage;
  visibility: string;
  members: string[];
  /** `m:<member>`, `bot:<member>` (that person's 라피) or `job:<id>` (a sub-Bot on its owner's VM). */
  assignee: string | null;
  assignedBy: string | null;
  createdBy: string | null;
  checkout: { runId: string; by: string; until: string } | null;
  version: number;
  rank: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
};

export type CompanyTaskNote = {
  id: number;
  by: string;
  text: string;
  runId: string | null;
  at: string;
};

export const taskKeys = {
  board: companyKeys.tasks,
  detail: companyKeys.task,
};

export function stageLabel(stage: TaskStage): string {
  switch (stage) {
    case "todo":
      return t("To do");
    case "doing":
      return t("Doing");
    case "review":
      return t("In review");
    case "blocked":
      return t("Stuck");
    case "done":
      return t("All done");
  }
}

/** The most pages of 200 the board reads: a thousand tasks is a company's whole board for years. */
const BOARD_PAGES = 5;

export const taskBoardQueryOptions = () =>
  queryOptions({
    retry: 1,
    queryKey: taskKeys.board,
    queryFn: async (): Promise<CompanyTask[]> => {
      const tasks: CompanyTask[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < BOARD_PAGES; page += 1) {
        const query: string = cursor
          ? `?limit=200&cursor=${encodeURIComponent(cursor)}`
          : "?limit=200";
        const body = (await requestOrRefusal(
          `/api/hub/tasks${query}`,
          undefined,
        )) as { tasks: CompanyTask[]; next: string | null };
        tasks.push(...body.tasks);
        cursor = body.next;
        if (!cursor) break;
      }
      return tasks;
    },
  });

export const taskDetailQueryOptions = (taskId: string) =>
  queryOptions({
    retry: 1,
    queryKey: taskKeys.detail(taskId),
    queryFn: async () =>
      (await requestOrRefusal(
        `/api/hub/tasks/${encodeURIComponent(taskId)}`,
        undefined,
      )) as { task: CompanyTask; notes: CompanyTaskNote[] },
  });

/** A refused write, with the field the hub (or this VM's door) named in refusing it. */
export class TaskRefusedError extends RequestRefusedError {
  readonly field: string | null;

  constructor(status: number, code: string | null, field: string | null) {
    super(t("That did not go through. Try again."), status, code);
    this.name = "TaskRefusedError";
    this.field = field;
  }
}

/**
 * A write with the press's own key, so a press retried after a dropped answer is one write. Its
 * refusal keeps the field it names, which is what lets the board say which part was refused.
 */
export async function taskWrite(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  key: string,
): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "include",
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    throw new TaskRefusedError(
      response.status,
      typeof answer?.code === "string" && answer.code ? answer.code : null,
      typeof answer?.field === "string" ? answer.field : null,
    );
  }
  return answer;
}

/** A task given to a 라피 or a routine is worked by a run; one given to a person, by that person. */
export const isWorkedByRun = (assignee: string | null) =>
  assignee !== null && !assignee.startsWith("m:");

/**
 * Whether a person may put this task in `stage` with `assignee` (its own unless given). A task a run
 * works enters 하는 중 only when its run takes it, so the hub refuses a person putting it there, or
 * handing a task that sits in 하는 중 with no run on it to a 라피 or a routine. The board does not
 * offer what the hub always refuses.
 */
export function personMayPlace(
  task: Pick<CompanyTask, "checkout" | "assignee">,
  stage: TaskStage,
  assignee: string | null = task.assignee,
): boolean {
  return !(
    stage === "doing" &&
    task.checkout === null &&
    isWorkedByRun(assignee)
  );
}

export type Columns = Record<TaskStage, CompanyTask[]>;

/** The board's five columns, each in rank order (and by age where two ranks are equal). */
export function columnsOf(tasks: readonly CompanyTask[]): Columns {
  const columns: Columns = {
    todo: [],
    doing: [],
    review: [],
    blocked: [],
    done: [],
  };
  for (const task of tasks) columns[task.stage]?.push(task);
  for (const stage of TASK_STAGES) {
    columns[stage].sort(
      (a, b) =>
        a.rank - b.rank ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  }
  return columns;
}

/**
 * The rank for a card put between `before` (the card above it) and `after` (the card below it).
 * The top of a column is one less than its first card, the bottom one more than its last, and an
 * empty column keeps the rank the card had.
 */
export function rankBetween(
  before: number | undefined,
  after: number | undefined,
  current: number,
): number {
  if (before === undefined && after === undefined) return current;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/**
 * Where a task lands when it is put at `index` in `stage`'s column (the index as the column reads
 * with the task itself taken out), or null when that is where it already is.
 */
export function placeTask(
  columns: Columns,
  taskId: string,
  stage: TaskStage,
  index: number,
): { stage: TaskStage; rank: number } | null {
  const task = TASK_STAGES.flatMap((one) => columns[one]).find(
    (one) => one.id === taskId,
  );
  if (!task) return null;
  const others = columns[stage].filter((one) => one.id !== taskId);
  const at = Math.max(0, Math.min(index, others.length));
  if (task.stage === stage) {
    const was = columns[stage].findIndex((one) => one.id === taskId);
    if (was === at) return null;
  }
  return {
    stage,
    rank: rankBetween(others[at - 1]?.rank, others[at]?.rank, task.rank),
  };
}

/**
 * The index a card dropped at `pointerY` takes among the cards of a column, from their vertical
 * middles (the dragged card's own left out): before the first middle it is above.
 */
export function dropIndex(
  middles: readonly number[],
  pointerY: number,
): number {
  const below = middles.findIndex((middle) => pointerY < middle);
  return below === -1 ? middles.length : below;
}

/**
 * The board after a move, for the moment before the hub answers. The version stays what it was:
 * the hub's answer brings the new one.
 */
export function movedLocally(
  tasks: readonly CompanyTask[],
  taskId: string,
  place: { stage: TaskStage; rank: number },
): CompanyTask[] {
  return tasks.map((task) =>
    task.id === taskId
      ? { ...task, stage: place.stage, rank: place.rank }
      : task,
  );
}

/** One step for the keyboard and the menu: up or down in its column, or to another column's top. */
export function stepTask(
  columns: Columns,
  taskId: string,
  step: "up" | "down" | TaskStage,
): { stage: TaskStage; rank: number } | null {
  const task = TASK_STAGES.flatMap((one) => columns[one]).find(
    (one) => one.id === taskId,
  );
  if (!task) return null;
  if (step === "up" || step === "down") {
    const was = columns[task.stage].findIndex((one) => one.id === taskId);
    return placeTask(
      columns,
      taskId,
      task.stage,
      step === "up" ? was - 1 : was + 1,
    );
  }
  if (step === task.stage) return null;
  return placeTask(columns, taskId, step, 0);
}

/** A routine of this person's, offered as a sub-Bot a task can be given to (`job:<routine id>`). */
export type JobChoice = { id: string; name: string };

/** Who a task is given to, as the board says it. */
export function assigneeLabel(
  assignee: string | null,
  context: {
    meId: string | undefined;
    members: readonly CompanyMember[] | undefined;
    jobs: readonly JobChoice[] | undefined;
  },
): string {
  if (!assignee) return t("Nobody yet");
  const at = assignee.indexOf(":");
  const kind = assignee.slice(0, at);
  const id = assignee.slice(at + 1);
  if (kind === "m") {
    return id === context.meId ? t("Me") : memberName(id, context.members);
  }
  if (kind === "bot") {
    return id === context.meId
      ? t("My Lafi")
      : t("{name}'s Lafi", { name: memberName(id, context.members) });
  }
  if (kind === "job") {
    const job = context.jobs?.find((one) => one.id === id);
    return job ? t("Routine · {name}", { name: job.name }) : t("A routine");
  }
  return t("Nobody yet");
}

/** The words for a note's fields, read off a 라피's note: `run:<id>`, `steps:<n>`, `topic:<…>`. */
function fieldsOf(rest: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of rest.split(" ")) {
    const at = part.indexOf(":");
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
  }
  return fields;
}

/**
 * What a stop for a person was about, from the topic the VM wrote (`topicOf` on the VM side:
 * `<kind>/<intent>@<site>` or `<kind>/<intent>@<service>/<tool>`). The site or service is named;
 * the action is said in a word. Anything unreadable is "something".
 */
export function approvalTopicText(topic: string | undefined): string {
  const at = topic?.indexOf("@") ?? -1;
  const head = topic ? (at === -1 ? topic : topic.slice(0, at)) : "";
  const where = topic && at !== -1 ? topic.slice(at + 1) : "";
  const intent = head.split("/")[1] ?? "";
  const place = where.split("/")[0] ?? "";
  const action = actionWord(intent);
  return place ? t("{action} on {place}", { action, place }) : action;
}

function actionWord(intent: string): string {
  switch (intent) {
    case "navigate":
      return t("Open a page");
    case "activate":
      return t("Press a button");
    case "type":
      return t("Type in a box");
    case "upload":
      return t("Send a file");
    case "fill_login":
    case "fill_secret":
      return t("Sign in to a site");
    case "read_file":
    case "list_files":
      return t("Read a file");
    case "write_file":
      return t("Save a file");
    case "run_script":
      return t("Work on files");
    default:
      return t("Do something");
  }
}

/**
 * A note as a person reads it. A 라피's coded note (`laf:task_…`, from the VM that ran the task)
 * becomes a sentence; a person's note, or a 라피's plain one, is its own text — a person who types
 * `laf:task_ran` sees what they typed, not a 라피's sentence under their name.
 */
export function taskNoteText(note: {
  text: string;
  by: string;
  runId?: string | null;
}): {
  text: string;
  /** The run the note is about, for the link to its conversation. */
  runId: string | null;
  /** Whether a person is needed to go on. */
  isStop: boolean;
} {
  const isRun = note.by.startsWith("bot:") || Boolean(note.runId);
  const match = isRun
    ? /^(laf:task_[a-z_]+)(?:\s+(.*))?$/.exec(note.text.trim())
    : null;
  if (!match) return { text: note.text, runId: null, isStop: false };
  const fields = fieldsOf(match[2] ?? "");
  const runId = fields.run ?? null;
  const steps = Number(fields.steps);
  switch (match[1]) {
    case "laf:task_ran":
      return {
        text:
          Number.isInteger(steps) && steps > 0
            ? t("Lafi finished in {n} steps. Have a look.", { n: steps })
            : t("Lafi finished. Have a look."),
        runId,
        isStop: false,
      };
    case "laf:task_needs_approval":
      return {
        text: t("Lafi is waiting for an OK: {what}", {
          what: approvalTopicText(fields.topic),
        }),
        runId,
        isStop: true,
      };
    case "laf:task_needs_login":
      return {
        text: t("Lafi stopped at a sign-in nobody saved."),
        runId,
        isStop: true,
      };
    case "laf:task_needs_person":
      return {
        text: t("Lafi stopped for somebody to look."),
        runId,
        isStop: true,
      };
    case "laf:task_run_failed":
      return {
        text: t("Lafi could not finish this."),
        runId,
        isStop: true,
      };
    case "laf:task_run_stopped":
      return { text: t("Lafi's work was stopped."), runId, isStop: true };
    default:
      return { text: t("A note from Lafi"), runId, isStop: false };
  }
}

/** The facts the board meets, in its words; the rest are 회사's. */
export function taskFactText(code: string | null): string | null {
  switch (code) {
    case "laf:task_stale":
      return t(
        "Somebody changed this task just now. The board is up to date again.",
      );
    case "laf:task_done_by_person":
      return t("Only a person can mark a task done.");
    default:
      return companyFactText(code);
  }
}

/** What a refusal that names a field says about it, or null where the field adds nothing. */
function refusedFieldText(
  code: string | null,
  field: string | null,
): string | null {
  if (code === "laf:hub_forbidden") {
    // `laf:task_not_your_run` on the hub: a run works with its owner's logins, from its own words.
    return field === "assignee" || field === "title" || field === "description"
      ? t("Only its own person gives a Lafi work or changes what it was asked.")
      : null;
  }
  if (code !== "laf:request_invalid") return null;
  switch (field) {
    case "stage":
      return t(
        "A task for a Lafi or a routine moves to Doing when it starts on it.",
      );
    case "assignee":
      return t("This task can't be given to them now.");
    case "title":
      return t("The title is empty or too long.");
    case "note":
    case "text":
      return t("The note is empty or too long.");
    default:
      return null;
  }
}

export function taskFailureText(error: unknown): string {
  const code = error instanceof RequestRefusedError ? error.code : null;
  const field = error instanceof TaskRefusedError ? error.field : null;
  return (
    refusedFieldText(code, field) ??
    taskFactText(code) ??
    t("That did not go through. Try again.")
  );
}

/** The conversation a task was worked in on this VM, when this VM's 라피 worked it. */
export function taskConversationOf<T extends { threadId?: string }>(
  taskId: string,
  channels: readonly T[] | undefined,
): T | undefined {
  return channels?.find((channel) => channel?.threadId === `task:${taskId}`);
}
