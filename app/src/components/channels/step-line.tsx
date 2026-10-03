import { IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { ToolRenderBoundary } from "./tool-boundary";

/** The fold beside a run's newest line: how many came before it, and whether they are drawn. */
export type StepFold = {
  count: number;
  /** How many of the lines it stands for did not work. */
  failed: number;
  isOpen: boolean;
  onToggle: () => void;
};

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
 * The fold beside the newest line of a run of steps: the way to the ones before it.
 *
 * AN ICON, NOT WORDS (the owner, 2026-10-04: "가장 최근 1개 + 펼치기 아이콘"). It read "이전 3단계"
 * beside every run — one more phrase on a screen whose trouble is the number of phrases. How many
 * steps it stands for is its name, for a screen reader and on hover, and is what opening it shows.
 *
 * AND IT SAYS WHEN ONE OF THEM DID NOT WORK, in its colour and in its name. A failed or refused
 * step is folded like any other now (`staysInTheOpen`), and a control that looked the same over a
 * failure as over four things that went well would be hiding it.
 *
 * A real button, so the keyboard reaches it and a screen reader is told whether the record is open.
 * Taller under a finger than under a pointer: the line it sits on is one line of small text.
 */
function StepRunFold({ count, failed, isOpen, onToggle }: StepFold) {
  const name = isOpen
    ? t("Hide earlier steps")
    : failed > 0
      ? t("{count} earlier steps, {failed} did not work", { count, failed })
      : t("{count} earlier steps", { count });
  return (
    <button
      aria-expanded={isOpen}
      aria-label={name}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted pointer-coarse:size-9 ${
        failed > 0
          ? "text-warning"
          : "text-muted-foreground hover:text-foreground"
      } ${focusRing}`}
      onClick={onToggle}
      title={name}
      type="button"
    >
      <IconChevronRight
        aria-hidden="true"
        className={`size-3.5 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
      />
    </button>
  );
}
