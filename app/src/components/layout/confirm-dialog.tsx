import { type ReactNode, useEffect, useRef, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
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
import { pressOnce } from "@/lib/press";

/** Where one press has got to. `done` looks like `running` while the dialog fades out. */
type Press =
  | { phase: "asking" }
  | { phase: "running" }
  | { phase: "done" }
  | { phase: "failed"; sentence: string }
  | { phase: "moot"; sentence: string };

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
 * AND IT OWNS ITS PRESS, since 2026-09-18 (`docs/laf/dialogs.md`). It used to be handed `pending`
 * and `error` and trust each caller to wire them, and the six callers wired six different things:
 * three closed the dialog on the press and let the request fail on the page behind, one never
 * showed the error at all, and every one of them could be closed by Escape halfway through a
 * delete. Now a caller hands over the action as a promise and the dialog keeps the list: nothing
 * closes it while it runs, a failure is said inside it and 삭제 becomes 다시 시도, and it closes
 * only when the action has succeeded.
 *
 * `recheck` IS ASKED AT THE PRESS, NOT AT RENDER. The question on screen was true when it opened;
 * by the press, another window may have deleted the thing, or the thing's Bot may be gone. A
 * sentence back means nothing is sent — the dialog says why, and 닫기 is the only answer left.
 *
 * The title takes the noun ALREADY CARRYING ITS PARTICLE (see `lib/josa.ts`); this component does
 * not know Korean grammar, it just refuses to build the sentence itself.
 */
export function ConfirmDialog({
  confirmLabel,
  description,
  onConfirm,
  onOpenChange,
  onStale,
  open,
  pendingLabel,
  recheck,
  title,
}: {
  confirmLabel: string;
  description: ReactNode;
  /** The action. Resolves once it is done; throws the person's sentence when it is not. */
  onConfirm: () => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
  /**
   * Called once the dialog has closed after `recheck` found the thing gone: the moment to refresh
   * what is behind it. Not sooner — a list refreshed while the dialog is up takes the row it is
   * drawn from, and the dialog with it, before the sentence saying why has been read.
   */
  onStale?: () => void;
  open: boolean;
  /** What the button says while it works. */
  pendingLabel?: string;
  /** Asked at the press, before `onConfirm`: why the action no longer applies, or `null`. */
  recheck?: () => Promise<string | null>;
  title: string;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [press, setPress] = useState<Press>({ phase: "asking" });
  const isRunning = press.phase === "running" || press.phase === "done";
  const isMoot = press.phase === "moot";

  /*
   * A MOOT PRESS TAKES THE BUTTON THAT HELD FOCUS AWAY, so 닫기 takes it — after the commit, not in
   * the handler. Measured in Chrome: focusing it in the handler did nothing, because at that moment
   * it was still the disabled 취소 of the running press, and focus fell to `<body>` when the confirm
   * left. (happy-dom focuses a disabled button without complaint, so only the browser showed it.)
   */
  useEffect(() => {
    if (isMoot) cancelRef.current?.focus();
  }, [isMoot]);

  const handleConfirm = async () => {
    if (isRunning || isMoot) return;
    setPress({ phase: "running" });
    const outcome = await pressOnce({ act: onConfirm, recheck });
    if (outcome.kind === "done") {
      setPress({ phase: "done" });
      onOpenChange(false);
      return;
    }
    setPress(
      outcome.kind === "moot"
        ? { phase: "moot", sentence: outcome.sentence }
        : { phase: "failed", sentence: outcome.sentence },
    );
  };

  return (
    <Dialog
      isBusy={isRunning}
      onOpenChange={onOpenChange}
      // Every open starts from the question, never from what the last press came to.
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        if (isMoot) onStale?.();
        setPress({ phase: "asking" });
      }}
      open={open}
    >
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
        {/* Both mounted from the open, so what the press came to is heard when it is said. */}
        <LiveRegion as="p" className="text-sm">
          {press.phase === "moot" ? press.sentence : null}
        </LiveRegion>
        <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
          {press.phase === "failed" ? press.sentence : null}
        </LiveRegion>
        <DialogFooter>
          <Button
            disabled={isRunning}
            onClick={() => onOpenChange(false)}
            ref={cancelRef}
            size="sm"
            variant="outline"
          >
            {isMoot ? t("Close") : t("Cancel")}
          </Button>
          {isMoot ? null : (
            <Button
              /*
               * Filled, not tinted. The `destructive` variant's own background is `destructive/10`,
               * and on this popover ground that is a pink so pale it reads as unavailable.
               *
               * `dark:text-background` rather than white in both themes: the dark palette's red is
               * a bright coral (#ff5667) and white on it is about 3:1. The near-black ground colour
               * on that coral is legible, and it is the same trick `--sand-text-on-primary` plays.
               */
              className="bg-destructive text-white hover:bg-[color-mix(in_oklch,var(--destructive),black_12%)] dark:text-background dark:hover:bg-[color-mix(in_oklch,var(--destructive),black_8%)]"
              disabled={isRunning}
              // Keeps the focus it was pressed with while it works, rather than dropping it on the page.
              focusableWhenDisabled
              onClick={() => void handleConfirm()}
              size="sm"
              variant="destructive"
            >
              {isRunning
                ? (pendingLabel ?? t("Deleting…"))
                : press.phase === "failed"
                  ? t("Try again")
                  : confirmLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
