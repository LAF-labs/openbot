import type { Category } from "@shared/persona";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { categoryName } from "@/lib/goals/queries";
import { t } from "@/lib/i18n";

/**
 * A CATEGORY PRESSED: ONE SHEET, ONE BUTTON (muse-shape plan §3.4; teardown §4, "the category
 * handoff is right as planned").
 *
 * It says what happens next — the Bot asks a few things in the conversation, the goal is set there,
 * and it is tracked here — and [대화에서 시작] sends "{분류} 목표를 같이 세워 줘" as the person's
 * message. In the ONE conversation: Muse opens a thread per goal, and LAF keeps one (plan D1).
 *
 * A dialog on the PC app, a sheet from the bottom on a phone.
 */
export function CategorySheet({
  category,
  onOpenChange,
  onStart,
}: {
  category: Category | null;
  onOpenChange: (open: boolean) => void;
  onStart: (category: Category) => void;
}) {
  const name = category ? categoryName(category) : "";
  return (
    <Dialog onOpenChange={onOpenChange} open={category !== null}>
      <DialogContent
        className="max-md:top-auto max-md:bottom-0 max-md:w-full max-md:max-w-none max-md:translate-y-0 max-md:rounded-b-none max-md:pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
        data-goal-sheet
      >
        <DialogHeader>
          <DialogTitle>
            {t("Make a {category} goal", { category: name })}
          </DialogTitle>
          <DialogDescription>
            {t(
              "First I'll ask you a few things in the conversation and we'll shape the goal together. Once it is set, you can follow how it is going here.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            data-goal-start
            onClick={() => {
              if (category) onStart(category);
            }}
          >
            {t("Start in the conversation")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
