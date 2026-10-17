/**
 * A task from the company board, worked in its own conversation (`task:<id>`), that stopped for its
 * person's yes — and the one press that lets it past for that task and that kind of action only.
 *
 * The server holds what stopped it and decides everything (`server/src/hub/task-asks.ts`): this asks
 * whether anything is waiting, says where in plain words, and sends the task's id and nothing else.
 */
import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { requestOrRefusal } from "@/lib/refusals";

/** The board task a conversation works, or null for every other conversation. */
export function boardTaskIdOf(threadId: string): string | null {
  if (!threadId.startsWith("task:")) return null;
  const id = threadId.slice("task:".length);
  return id ? id : null;
}

export type BoardTaskWaiting = { topic: string; askedAt: string } | null;

export const boardTaskKeys = {
  allowance: (taskId: string) => ["hub", "task", taskId, "allowance"] as const,
};

export function boardTaskAllowanceQueryOptions(taskId: string) {
  return queryOptions({
    queryKey: boardTaskKeys.allowance(taskId),
    queryFn: async (): Promise<BoardTaskWaiting> => {
      const body = (await requestOrRefusal(
        `/api/hub/tasks/${encodeURIComponent(taskId)}/allowance`,
        undefined,
        {},
      )) as { waiting?: BoardTaskWaiting } | null;
      return body?.waiting ?? null;
    },
  });
}

export type BoardTaskAllowed = {
  ok: true;
  topic: string;
  board: "queued" | "not_blocked" | "unreachable";
};

export async function allowBoardTask(
  taskId: string,
): Promise<BoardTaskAllowed> {
  return (await requestOrRefusal(
    `/api/hub/tasks/${encodeURIComponent(taskId)}/allowance`,
    { method: "POST" },
    BOARD_TASK_REFUSALS,
  )) as BoardTaskAllowed;
}

/** What the server says when the press did nothing, in the words the person reads. */
export const BOARD_TASK_REFUSALS: Readonly<Record<string, string>> = {
  "laf:task_nothing_waiting":
    "Nothing in this task is waiting for your OK any more.",
  "laf:task_not_yours": "Only the person this Bot belongs to can allow this.",
};

/**
 * Where the stopped action was, from its topic (`kind/intent@where`): the site, or the connected
 * service and its tool. The kind of action is the server's vocabulary and not the person's, so only
 * the place is said.
 */
export function topicPlace(topic: string): string | null {
  const at = topic.indexOf("@");
  if (at < 0) return null;
  const place = topic.slice(at + 1).trim();
  return place ? place : null;
}

/** The line above the button. */
export function waitingLine(waiting: { topic: string }): string {
  const place = topicPlace(waiting.topic);
  return place
    ? t("This task stopped for your OK on {place}.", { place })
    : t("This task stopped for your OK.");
}

/** The line after the press, by what became of the board. */
export function allowedLine(board: BoardTaskAllowed["board"]): string {
  switch (board) {
    case "queued":
      return t(
        "Allowed for this task. It goes back to the board's to-do list and runs again.",
      );
    case "not_blocked":
      return t(
        "Allowed for this task. It was already moved on the board, so it stays where it is.",
      );
    default:
      return t(
        "Allowed for this task. The board could not be reached, so move it back to to-do there.",
      );
  }
}
