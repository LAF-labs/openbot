import {
  IconArrowDown,
  IconArrowUp,
  IconDots,
  IconGripVertical,
} from "@tabler/icons-react";
import type { PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRingBare } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import {
  type CompanyTask,
  stageLabel,
  TASK_STAGES,
  type TaskStage,
} from "@/lib/hub/tasks";
import { cn } from "@/lib/utils";

/**
 * One task on the board: its title, who has it, and two ways to move it besides dragging — the
 * menu (to another column, or up and down in this one), which is the keyboard's and a screen
 * reader's way, and the grip, which is a finger's.
 */
export function TaskCard({
  task,
  who,
  isDragged,
  isGhost,
  isPending,
  handlers,
  onOpen,
  onStep,
  canStep,
}: {
  task: CompanyTask;
  who: string;
  isDragged?: boolean;
  /** The copy that follows the pointer: not interactive, not announced. */
  isGhost?: boolean;
  isPending?: boolean;
  handlers?: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
  };
  onOpen?: () => void;
  onStep?: (step: "up" | "down" | TaskStage) => void;
  canStep?: { up: boolean; down: boolean };
}) {
  const isWorking = task.checkout !== null;
  return (
    <div
      aria-hidden={isGhost || undefined}
      className={cn(
        "group/task flex items-start gap-1 rounded-lg border border-border bg-card p-2 text-sm shadow-xs",
        !isGhost && "cursor-grab select-none active:cursor-grabbing",
        isDragged && "opacity-40",
        isGhost && "shadow-lg ring-1 ring-ring",
        isPending && "opacity-70",
      )}
      data-task-card={isGhost ? undefined : task.id}
      data-task-stage={task.stage}
      {...(isGhost ? {} : handlers)}
    >
      <span
        className="mt-0.5 flex size-6 shrink-0 touch-none items-center justify-center text-muted-foreground"
        data-task-grip
      >
        <IconGripVertical className="size-4" />
      </span>
      <button
        className={cn(
          "min-w-0 flex-1 rounded-sm py-0.5 text-left",
          focusRingBare,
        )}
        data-task-open
        onClick={onOpen}
        tabIndex={isGhost ? -1 : undefined}
        type="button"
      >
        <span className="block break-words font-medium">{task.title}</span>
        <span className="mt-0.5 block truncate text-muted-foreground text-xs">
          {isWorking ? t("{who} · working on it", { who }) : who}
        </span>
      </button>
      {isGhost ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("Move {title}", { title: task.title })}
                className="shrink-0"
                data-task-menu
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <IconDots />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40 p-1">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="px-1.5 py-1 text-muted-foreground text-xs">
                {t("Move to")}
              </DropdownMenuLabel>
              {TASK_STAGES.filter((stage) => stage !== task.stage).map(
                (stage) => (
                  <DropdownMenuItem
                    data-task-move={stage}
                    key={stage}
                    onClick={() => onStep?.(stage)}
                  >
                    {stageLabel(stage)}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-task-move="up"
              disabled={!canStep?.up}
              onClick={() => onStep?.("up")}
            >
              <IconArrowUp />
              {t("Move up")}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-task-move="down"
              disabled={!canStep?.down}
              onClick={() => onStep?.("down")}
            >
              <IconArrowDown />
              {t("Move down")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
