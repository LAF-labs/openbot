import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { PageEmpty } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import type { CompanyMember } from "@/lib/hub/company";
import {
  assigneeLabel,
  type CompanyTask,
  columnsOf,
  type JobChoice,
  movedLocally,
  stageLabel,
  stepTask,
  placeTask,
  TASK_STAGES,
  type TaskStage,
  taskBoardQueryOptions,
  taskFailureText,
  taskKeys,
  taskWrite,
} from "@/lib/hub/tasks";
import { t } from "@/lib/i18n";
import { RequestRefusedError } from "@/lib/refusals";
import { routineListQueryOptions } from "@/lib/routines/queries";
import { NewTask } from "./new-task";
import { TaskCard } from "./task-card";
import { TaskDetail } from "./task-detail";
import { useBoardDrag } from "./use-board-drag";

/**
 * 업무판: the company's tasks in five columns — 할 일 · 하는 중 · 검토 · 막힘 · 끝.
 *
 * A MOVE SHOWS AT ONCE AND IS THE HUB'S TO KEEP. The card goes where it was dropped before the hub
 * answers; the hub's answer brings the task back with its new version. A move made against an
 * older version (a 라피's run or a colleague moved it first) is 409 `laf:task_stale`: the board reads
 * again and says so in one line. Any other refusal puts the card back where it was, with the reason.
 *
 * LIVE BY NAME. A colleague's move reaches this screen as a `hub.task.changed` frame, which makes the
 * board's read stale (`hubKeysForFrame`); nothing here polls.
 */
export function TaskBoard({
  meId,
  members,
  openTask,
}: {
  meId: string | undefined;
  members: readonly CompanyMember[] | undefined;
  openTask: string | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const board = useQuery(taskBoardQueryOptions());
  const routines = useQuery(routineListQueryOptions());
  const jobs: JobChoice[] | undefined = routines.data?.map((routine) => ({
    id: routine.id,
    name: routine.name,
  }));
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<readonly string[]>([]);
  const root = useRef<HTMLDivElement>(null);

  // A notice says its one thing and goes.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const columns = columnsOf(board.data ?? []);

  const move = useMutation({
    mutationFn: (input: {
      task: CompanyTask;
      place: { stage: TaskStage; rank: number };
      key: string;
    }) =>
      taskWrite(
        `/api/hub/tasks/${encodeURIComponent(input.task.id)}`,
        "PATCH",
        {
          version: input.task.version,
          stage: input.place.stage,
          rank: input.place.rank,
        },
        input.key,
      ),
    onMutate: async (input) => {
      setPending((before) => [...before, input.task.id]);
      await queryClient.cancelQueries({ queryKey: taskKeys.board });
      const before = queryClient.getQueryData<CompanyTask[]>(taskKeys.board);
      queryClient.setQueryData<CompanyTask[]>(taskKeys.board, (tasks) =>
        tasks ? movedLocally(tasks, input.task.id, input.place) : tasks,
      );
      return { before };
    },
    onSuccess: (answer) => {
      const next = (answer as { task?: CompanyTask } | null)?.task;
      if (!next) return;
      queryClient.setQueryData<CompanyTask[]>(taskKeys.board, (tasks) =>
        tasks?.map((task) => (task.id === next.id ? next : task)),
      );
    },
    onError: (error, _input, context) => {
      const code = error instanceof RequestRefusedError ? error.code : null;
      if (code !== "laf:task_stale" && context?.before) {
        queryClient.setQueryData(taskKeys.board, context.before);
      }
      setNotice(taskFailureText(error));
      void queryClient.invalidateQueries({ queryKey: taskKeys.board });
    },
    onSettled: (_answer, _error, input) => {
      setPending((before) => before.filter((id) => id !== input.task.id));
    },
  });

  const moveTo = (
    taskId: string,
    place: { stage: TaskStage; rank: number } | null,
    announce: boolean,
  ) => {
    const task = board.data?.find((one) => one.id === taskId);
    if (!task || !place) return;
    move.mutate({ task, place, key: crypto.randomUUID() });
    // Said for whoever moved it without seeing it move: the menu's press, a screen reader.
    if (announce) {
      setNotice(t("Moved to {stage}.", { stage: stageLabel(place.stage) }));
    }
  };

  const { drag, cardHandlers, isClick } = useBoardDrag({
    board: () => root.current,
    canDrag: (taskId) => !pending.includes(taskId),
    onDrop: (taskId, target) =>
      moveTo(
        taskId,
        placeTask(columns, taskId, target.stage, target.index),
        false,
      ),
  });

  const whoOf = (task: CompanyTask) =>
    assigneeLabel(task.assignee, { meId, members, jobs });
  const dragged = drag
    ? board.data?.find((task) => task.id === drag.taskId)
    : undefined;

  const openDetail = (taskId: string | undefined) =>
    void navigate({
      to: "/company/tasks",
      search: (before) => ({ ...before, task: taskId }),
    });

  return (
    <div className="flex flex-col gap-3" data-task-board ref={root}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <p
          aria-live="polite"
          className="text-muted-foreground text-sm"
          data-task-notice
          role="status"
        >
          {notice}
        </p>
        <NewTask jobs={jobs} meId={meId} members={members} />
      </div>

      {board.isPending ? (
        <div className="flex gap-3">
          {TASK_STAGES.map((stage) => (
            <Skeleton className="h-40 w-56 shrink-0" key={stage} />
          ))}
        </div>
      ) : board.isError ? (
        <PageEmpty>{taskFailureText(board.error)}</PageEmpty>
      ) : (
        <div
          className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2"
          data-task-scroller
        >
          {TASK_STAGES.map((stage) => {
            const tasks = columns[stage];
            const target = drag?.target?.stage === stage ? drag.target : null;
            const others = tasks.filter((task) => task.id !== drag?.taskId);
            return (
              <section
                aria-label={stageLabel(stage)}
                className={
                  target
                    ? "flex w-64 shrink-0 snap-start flex-col gap-2 rounded-xl bg-accent p-2 lg:w-auto lg:min-w-40 lg:flex-1"
                    : "flex w-64 shrink-0 snap-start flex-col gap-2 rounded-xl bg-muted p-2 lg:w-auto lg:min-w-40 lg:flex-1"
                }
                data-task-column={stage}
                key={stage}
              >
                <h2 className="flex items-center justify-between px-1 font-medium text-sm">
                  {stageLabel(stage)}
                  <span className="text-muted-foreground text-xs">
                    {tasks.length}
                  </span>
                </h2>
                <div className="flex min-h-16 flex-col gap-2">
                  {tasks.map((task) => {
                    const at = others.findIndex((one) => one.id === task.id);
                    const index = tasks.findIndex((one) => one.id === task.id);
                    return (
                      <Fragment key={task.id}>
                        {target && at !== -1 && target.index === at ? (
                          <DropLine />
                        ) : null}
                        <TaskCard
                          canStep={{
                            up: index > 0,
                            down: index < tasks.length - 1,
                          }}
                          handlers={cardHandlers(task.id)}
                          isDragged={drag?.taskId === task.id}
                          isPending={pending.includes(task.id)}
                          onOpen={() => {
                            if (isClick()) openDetail(task.id);
                          }}
                          onStep={(step) =>
                            moveTo(
                              task.id,
                              stepTask(columns, task.id, step),
                              true,
                            )
                          }
                          task={task}
                          who={whoOf(task)}
                        />
                      </Fragment>
                    );
                  })}
                  {target && target.index >= others.length ? (
                    <DropLine />
                  ) : null}
                  {tasks.length === 0 && !target ? (
                    <p className="px-1 py-3 text-center text-muted-foreground text-xs">
                      {t("Nothing here")}
                    </p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* The copy that follows the pointer; where it is drawn is set on the board as it moves. */}
      {dragged ? (
        <div className="pointer-events-none fixed top-0 left-0 z-50 w-(--drag-w) translate-x-(--drag-x) translate-y-(--drag-y)">
          <TaskCard isGhost task={dragged} who={whoOf(dragged)} />
        </div>
      ) : null}

      {openTask ? (
        <TaskDetail
          jobs={jobs}
          meId={meId}
          members={members}
          onClose={() => openDetail(undefined)}
          taskId={openTask}
        />
      ) : null}
    </div>
  );
}

function DropLine() {
  return <div className="h-0.5 rounded-full bg-primary" data-task-drop-line />;
}
