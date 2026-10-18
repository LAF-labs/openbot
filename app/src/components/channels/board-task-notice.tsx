import { IconShieldCheck } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  allowBoardTask,
  allowedLine,
  boardTaskAllowanceQueryOptions,
  boardTaskKeys,
  waitingLine,
} from "@/lib/hub/board-task";
import { t } from "@/lib/i18n";

/**
 * "이 일감에서는 해도 돼": on a company board task's conversation, when its last run stopped for the
 * person's yes. One press allows that kind of action, there, for this task only — the server makes
 * the allowance from what the run met and sends the task back to the board's to-do list
 * (`server/src/hub/task-asks.ts`). Drawn only while something waits.
 */
export function BoardTaskNotice({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const waiting = useQuery(boardTaskAllowanceQueryOptions(taskId));
  const allow = useMutation({
    mutationFn: () => allowBoardTask(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: boardTaskKeys.allowance(taskId),
      });
    },
  });
  if (allow.data) {
    return (
      <p
        className="mb-2 rounded-lg border border-border bg-muted px-3 py-1.5 text-muted-foreground text-sm"
        data-slot="board-task-notice"
        role="status"
      >
        {allowedLine(allow.data.board)}
      </p>
    );
  }
  if (!waiting.data) return null;
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1.5 text-muted-foreground text-sm"
      data-slot="board-task-notice"
      role="status"
    >
      <span className="min-w-0 flex-1">{waitingLine(waiting.data)}</span>
      <Button
        className="shrink-0"
        disabled={allow.isPending}
        onClick={() => allow.mutate()}
        size="xs"
        variant="outline"
      >
        <IconShieldCheck />
        {t("Allow it for this task")}
      </Button>
      {allow.error ? (
        <span className="w-full text-destructive text-xs" role="alert">
          {allow.error.message}
        </span>
      ) : null}
    </div>
  );
}
