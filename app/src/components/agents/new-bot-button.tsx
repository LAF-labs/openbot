import { IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useNewBot } from "@/lib/agents/new-bot";
import { seatsFullMessage } from "@/lib/agents/seats";
import { t } from "@/lib/i18n";

/**
 * 새 봇, and there is nothing behind it.
 *
 * Every entry point that used to link to `/agents?new=true` presses this instead: the Bot is made,
 * named, given a face, and its conversation opens. The form it replaced asked four questions, threw
 * one of the answers away, and stood between somebody and the thing they came for.
 *
 * WHY THE REASON IS TEXT AND NOT A TOOLTIP. A disabled button explains nothing, and a title
 * attribute explains nothing to anybody who is not holding a mouse. At five Bots this is the only
 * place the cap is ever mentioned, so it is said in the layout rather than hidden in an attribute.
 */
export function NewBotButton({
  className,
  label,
  size = "sm",
  variant = "ghost",
  withReason = true,
}: {
  className?: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "ghost";
  /**
   * Whether the sentence under the button is this component's to draw.
   *
   * IN A PAGE HEADER IT IS NOT. The three sibling pages put one primary verb on the title's
   * baseline, and this was the only one of the three that put a `<div>` there instead of a
   * `<Button>` — a column with a paragraph in it, which made the Bots title row taller than
   * Routines' and Skills'. The header passes `false` and the roster says the same thing in its
   * section description, where there is room for a sentence.
   */
  withReason?: boolean;
}) {
  const { create, isPending, problem, seats } = useNewBot();
  const reason = problem ?? (seats.isFull ? seatsFullMessage(seats) : null);

  const button = (
    <Button
      disabled={isPending || seats.isFull}
      onClick={() => void create()}
      size={size}
      // A disabled button explains nothing and a title attribute explains nothing to anybody
      // without a mouse — which is why the sentence still exists. This is the belt.
      title={withReason ? undefined : (reason ?? undefined)}
      variant={variant}
    >
      <IconPlus />
      {isPending ? t("Creating…") : (label ?? t("New Bot"))}
    </Button>
  );

  if (!withReason) return button;

  return (
    <div className={`flex flex-col items-center gap-1 ${className ?? ""}`}>
      {button}
      {problem ? (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : seats.isFull ? (
        <p className="max-w-xs text-balance text-center text-muted-foreground text-xs">
          {seatsFullMessage(seats)}
        </p>
      ) : null}
    </div>
  );
}
