import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { IconX } from "@tabler/icons-react";
import type * as React from "react";
import { createContext, useContext } from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Whether the dialog's action is running, for the × that `DialogContent` draws. */
const DialogBusyContext = createContext(false);

/**
 * A centred modal, for a form that is short enough to finish in one sitting.
 *
 * WHY THIS EXISTS ALONGSIDE `DetailPanel`. The panel is the right answer on the screens somebody
 * lives in — writing a skill, editing an agent — where the list stays visible beside what you are
 * editing and the work is worth a URL. Admin is not that: a credential is added once and forgotten,
 * and giving it a route and a side panel dresses a two-field form as a place you might come back to.
 *
 * Built on the same Base UI dialog as `Sheet`, so focus trapping, scroll locking and the escape key
 * behave identically across the app rather than nearly identically.
 *
 * `isBusy`: THE DIALOG'S ACTION IS RUNNING, AND NOTHING BASE UI DOES MAY CLOSE IT. Measured on
 * 2026-09-18, before this existed: Escape during a Bot's 삭제 closed the dialog mid-request, and
 * the refusal that came back a moment later was drawn on the profile behind it — the answer to a
 * question somebody had just been told was over. So while it is set, Escape, a press on the
 * overlay and the × are all refused here, the × is drawn disabled, and the one close left is the
 * caller's own, which it makes on success. A 취소 the caller draws is the caller's to disable.
 *
 * Refused with `cancel()`, not by leaving `open` alone: Base UI would otherwise begin closing its
 * own copy of the state — focus handed back to the page, the exit animation started — around a
 * dialog that is still open.
 */
function Dialog({
  disablePointerDismissal,
  isBusy = false,
  onOpenChange,
  ...props
}: DialogPrimitive.Root.Props & { isBusy?: boolean }) {
  return (
    <DialogBusyContext.Provider value={isBusy}>
      <DialogPrimitive.Root
        data-slot="dialog"
        disablePointerDismissal={isBusy || disablePointerDismissal}
        onOpenChange={(open, details) => {
          if (!open && isBusy) {
            details.cancel();
            return;
          }
          onOpenChange?.(open, details);
        }}
        {...props}
      />
    </DialogBusyContext.Provider>
  );
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/20 dark:bg-black/55 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  const isBusy = useContext(DialogBusyContext);
  return (
    <DialogPortal>
      <DialogOverlay
        /*
         * While the action runs a press out here closes nothing — and it must not take the focus the
         * pressed button is holding either. The overlay cannot take focus, so a press on it hands
         * focus to `<body>`: measured, a click beside a running 삭제 left the keyboard nowhere.
         */
        onMouseDown={isBusy ? (event) => event.preventDefault() : undefined}
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          /*
           * `max-h-[85svh]` with the body scrolling, not the popup growing: a form that is long on a
           * laptop must not push its own submit button off the bottom of the screen, which is exactly
           * where somebody looks for it.
           */
          "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex max-h-[85svh] w-[calc(100%-2rem)] max-w-lg flex-col gap-4 rounded-xl border border-border bg-popover p-5 text-sm text-popover-foreground shadow-popover transition duration-150 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            disabled={isBusy}
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <IconX />
            <span className="sr-only">{t("Close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1 pr-8", className)}
      {...props}
    />
  );
}

/** Body scrolls, so the header and footer stay put on a short viewport. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      // `overflow-y-auto`: the comment above and on DialogContent both say the body scrolls, and it
      // had no overflow property at all — a long form painted out of the rounded card while the
      // overlay held the page still, so the fields past the fold were unreachable.
      className={cn(
        "-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-1",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-row items-center justify-end gap-2", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      // `text-xl` is 22px/28 on this scale, not the 19px an older comment here claimed. See the
      // @theme block in styles.css — the scale is stated there rung by rung, so a size written as
      // a number in a comment is a number that can go stale without anything noticing.
      className={cn(
        "font-heading font-semibold text-xl text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm text-pretty", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
