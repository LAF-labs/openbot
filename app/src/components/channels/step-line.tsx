import { IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { ToolRenderBoundary } from "./tool-boundary";

/** The fold beside a run's newest line: how many came before it, and whether they are drawn. */
export type StepFold = { count: number; isOpen: boolean; onToggle: () => void };

/**
 * One drawn step, inside its own seam — and, where it is the newest of a run, the fold for the ones
 * before it, OUTSIDE that seam.
 *
 * A line that throws is replaced by the seam's one sentence, and everything inside the seam goes
 * with it. The fold was inside: the earlier lines of the run are not drawn until it is pressed, so
 * a newest line that failed to draw took with it the only way to the record behind it (Codex on
 * pull request 44, round 4). The fold is the transcript's own and draws nothing a tool supplied; it
 * stands beside whatever the seam shows.
 *
 * WHAT A TOOL DRAWS IS ONE THING BESIDE THE FOLD, HOWEVER MANY THINGS IT IS. A connected service's
 * renderer hands back a question's card, its line and the rows for what a mail held, as siblings —
 * and the seam passes them through as they are. Put straight into this row they were each a peer
 * of the fold: a card beside its own line on a wide screen, squeezed and wrapping on a narrow one
 * (Codex on pull request 44, round 7). So they are stacked in a block of their own, as they were
 * before there was a fold, and the fold is that block's one neighbour: beside it where it is a
 * line, at its foot — where the line is — or under it where it is wider than the row.
 */
export function StepLine({
  name,
  fold,
  children,
}: {
  /** The tool's name, for the seam's sentence. */
  name: string;
  fold?: StepFold;
  children: ReactNode;
}) {
  const line = <ToolRenderBoundary name={name}>{children}</ToolRenderBoundary>;
  if (!fold) return line;
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-x-2 gap-y-1">
      <div className="min-w-0 max-w-full">{line}</div>
      <StepRunFold {...fold} />
    </div>
  );
}

/**
 * The fold beside the newest line of a run of steps: how many came before it, and the way to them.
 *
 * A real button, so the keyboard reaches it and a screen reader is told whether the record is open.
 * Taller under a finger than under a pointer: the line it sits on is one line of small text.
 */
function StepRunFold({ count, isOpen, onToggle }: StepFold) {
  return (
    <button
      aria-expanded={isOpen}
      className={`inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground pointer-coarse:h-9 pointer-coarse:px-2.5 ${focusRing}`}
      onClick={onToggle}
      type="button"
    >
      <IconChevronRight
        aria-hidden="true"
        className={`size-3 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
      />
      {isOpen ? t("Hide earlier steps") : t("{count} earlier steps", { count })}
    </button>
  );
}
