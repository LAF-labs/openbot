import { IconPlayerPlay } from "@tabler/icons-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { questionOn, watchQuestions } from "@/lib/approvals";
import type { TaskStop } from "@/lib/copilot/stranded-steps";
import { t } from "@/lib/i18n";

/**
 * "멈춘 일이 있어요 · 이어서 하기": a task that ended in the middle of the Bot's work, said as what it
 * is, with the one press that picks it up again (UX review 0.5.4, candidate 1).
 *
 * A task stopped partway used to leave nothing but a card reading 멈춤, and after a reload not even
 * a reason — the owner had to guess that typing "계속해" would do anything. The press sends that
 * sentence as the owner's own message, in the thread where they can see it; the Bot reads the step
 * that never finished as unfinished (`repair-history.ts`) and carries on from where it was.
 *
 * Drawn only once the conversation has looked for open questions (`checked`), and never while one
 * is open on the stopped step: a step still waiting on the owner's answer is not stopped, and the
 * card on it is the thing to press.
 */
export function CarryOnNotice({
  stop,
  checked,
  busy,
  onCarryOn,
}: {
  stop: TaskStop | null;
  checked: boolean;
  busy: boolean;
  onCarryOn: () => void;
}) {
  const unanswered = stop?.unanswered.join(",") ?? "";
  const isAsking = useSyncExternalStore(watchQuestions, () =>
    unanswered
      .split(",")
      .some((toolCallId) => toolCallId && questionOn(toolCallId) !== undefined),
  );
  if (!stop || !checked || busy || isAsking) return null;
  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1 text-muted-foreground text-sm"
      data-slot="carry-on-notice"
      role="status"
    >
      <span className="min-w-0 flex-1">
        {stop.reason === "stopped"
          ? t("You stopped this task partway.")
          : t("This task stopped before its last step finished.")}
      </span>
      <Button
        className="shrink-0"
        onClick={onCarryOn}
        size="xs"
        variant="outline"
      >
        <IconPlayerPlay />
        {t("Carry on")}
      </Button>
    </div>
  );
}
