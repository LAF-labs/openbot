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
}: {
  className?: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "ghost";
}) {
  const { create, isPending, problem, seats } = useNewBot();

  return (
    <div className={`flex flex-col items-center gap-1 ${className ?? ""}`}>
      <Button
        disabled={isPending || seats.isFull}
        onClick={() => void create()}
        size={size}
        variant={variant}
      >
        <IconPlus />
        {isPending ? t("Creating…") : (label ?? t("New Bot"))}
      </Button>
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
