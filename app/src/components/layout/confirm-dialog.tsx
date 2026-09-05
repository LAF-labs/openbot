import { type ReactNode, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";

/**
 * THE QUESTION ASKED BEFORE SOMETHING IS GONE FOR GOOD.
 *
 * Three screens each wrote their own — a Bot, a routine, a skill — and each got a different half of
 * it right. This is the one they should all have been, and it lives beside the page shell for the
 * same reason that does: these are not three dialogs, they are one dialog asked about three nouns,
 * and the next screen that deletes something should inherit the answers rather than rediscover them.
 *
 * TWO THINGS WERE MEASURED WRONG IN ALL THREE, in the browser, on 2026-09-06:
 *
 * 1. FOCUS NEVER ENTERED THE DIALOG. Base UI traps focus once it is inside the popup, and it never
 *    got there: opened from a dropdown item, `document.activeElement` stayed on the menu item — an
 *    element already inside an `aria-hidden` subtree — and opened from a plain button it stayed on
 *    `body`. Tab went nowhere. So a keyboard could not reach 취소 or 삭제 at all, on the one dialog
 *    in the product that destroys something. `initialFocus` is the fix, and it points at CANCEL:
 *    the safe answer is the one that should be under Return, and a focused destructive button is a
 *    delete one keystroke away from somebody who was only trying to read the question.
 *
 * 2. THE DESTRUCTIVE BUTTON READ AS DISABLED. `variant="destructive"` is a 10%-alpha wash of the
 *    red — a pale pink pill, lighter than the ghost 취소 beside it, which is exactly how this
 *    codebase draws a button that cannot be pressed. The confirm here is filled, because the whole
 *    job of this dialog is to make the irreversible press unmistakable.
 *
 * The title takes the noun ALREADY CARRYING ITS PARTICLE (see `lib/josa.ts`); this component does
 * not know Korean grammar, it just refuses to build the sentence itself.
 */
export function ConfirmDialog({
  confirmLabel,
  description,
  error,
  onConfirm,
  onOpenChange,
  open,
  pending,
  pendingLabel,
  title,
}: {
  confirmLabel: string;
  description: ReactNode;
  /** What went wrong last time it was pressed, if anything. */
  error?: string | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pending?: boolean;
  /** What the button says while it works. */
  pendingLabel?: string;
  title: string;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        /*
         * A ref, not `true`. `initialFocus: true` focuses the popup's first tabbable element, which
         * is the × in the corner — reachable, but it tells a person nothing about the choice they
         * are being asked to make. Cancel is the answer somebody who pressed by accident wants.
         */
        initialFocus={cancelRef}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            ref={cancelRef}
            size="sm"
            variant="outline"
          >
            {t("Cancel")}
          </Button>
          <Button
            /*
             * Filled, not tinted. The `destructive` variant's own background is `destructive/10`,
             * and on this popover ground that is a pink so pale it reads as unavailable.
             *
             * `dark:text-background` rather than white in both themes: the dark palette's red is a
             * bright coral (#ff5667) and white on it is about 3:1. The near-black ground colour on
             * that coral is legible, and it is the same trick `--sand-text-on-primary` plays.
             */
            className="bg-destructive text-white hover:bg-[color-mix(in_oklch,var(--destructive),black_12%)] dark:text-background dark:hover:bg-[color-mix(in_oklch,var(--destructive),black_8%)]"
            disabled={pending}
            onClick={onConfirm}
            size="sm"
            variant="destructive"
          >
            {pending ? (pendingLabel ?? t("Deleting…")) : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
