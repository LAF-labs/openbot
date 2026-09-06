import { useMutation } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { activeLocale, t } from "@/lib/i18n";
import {
  FEEDBACK_MAX_LENGTH,
  type FeedbackReceipt,
  screenFactsFor,
  sendFeedback,
} from "@/lib/support/feedback";
import { lastTurnFailure } from "@/lib/support/last-failure";

/**
 * 문의·의견: the one place a person can say something to the people who run the product.
 *
 * A dialog rather than a page, because it is reached from wherever somebody got stuck — Settings
 * and the help page today — and a page would take them away from the screen they want to describe.
 *
 * THE BOX IS OFF UNTIL TICKED. "Send what is on screen too" attaches two facts — this screen's
 * path and the last failure code it drew — and the line under it says exactly that, because a
 * checkbox that reads as "attach a screenshot" and does something else is a checkbox nobody ticks
 * twice. What it will attach is printed the moment it is ticked, so there is nothing to take on
 * trust.
 *
 * 보냈습니다 IS THE SERVER'S SENTENCE, NOT THE BUTTON'S. It is drawn from the receipt the route
 * answered with, after a 201 and never before: the time it was received, and whether anybody was
 * told. A box that said "sent" on the press would say so to a dead server too.
 */
export function FeedbackDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const location = useLocation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const boxId = useId();
  const [text, setText] = useState("");
  const [withScreen, setWithScreen] = useState(false);
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);

  const facts = screenFactsFor(location.pathname, lastTurnFailure());
  const send = useMutation({
    mutationFn: () => sendFeedback(text, withScreen ? facts : null),
    onSuccess: (sent) => setReceipt(sent),
  });

  // A fresh box every time it opens: the last message was sent, and the last error was about it.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setText("");
      setWithScreen(false);
      setReceipt(null);
      send.reset();
    }
    onOpenChange(next);
  };

  const handleSend = () => {
    if (!text.trim() || send.isPending) return;
    send.mutate();
  };

  const receivedAt = receipt
    ? new Intl.DateTimeFormat(activeLocale, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(receipt.receivedAt))
    : "";

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent initialFocus={textareaRef}>
        <DialogHeader>
          <DialogTitle>{t("Questions and feedback")}</DialogTitle>
          <DialogDescription>
            {t(
              "Write what did not work, or what you would like. The people who make the app read it.",
            )}
          </DialogDescription>
        </DialogHeader>
        {receipt ? (
          <p className="text-sm" role="status">
            <span className="font-medium">{t("Sent.")}</span>{" "}
            {t("Received {time}.", { time: receivedAt })}
            {receipt.told.length > 0
              ? ` ${t("It has reached the people who run the app.")}`
              : null}
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleSend();
            }}
          >
            <Textarea
              aria-label={t("Questions and feedback")}
              maxLength={FEEDBACK_MAX_LENGTH}
              onChange={(event) => setText(event.target.value)}
              placeholder={t(
                "For example: the review summary has not worked since yesterday.",
              )}
              ref={textareaRef}
              rows={5}
              value={text}
            />
            <p className="text-right text-muted-foreground text-xs">
              {text.length}/{FEEDBACK_MAX_LENGTH}
            </p>
            <label
              className="flex cursor-pointer items-start gap-2 text-sm"
              htmlFor={boxId}
            >
              <input
                checked={withScreen}
                className="mt-1 size-4 shrink-0 accent-primary"
                id={boxId}
                onChange={(event) => setWithScreen(event.target.checked)}
                type="checkbox"
              />
              <span className="flex flex-col gap-0.5">
                <span>{t("Send what is on screen too")}</span>
                <span className="text-muted-foreground text-xs">
                  {t(
                    "Only this screen's address and the last failure code. Never a screenshot, never a message.",
                  )}
                </span>
                {withScreen ? (
                  <span className="text-muted-foreground text-xs">
                    {facts.failureCode
                      ? t("Will attach: {route} and the last failure, {code}", {
                          route: facts.route,
                          code: facts.failureCode,
                        })
                      : t("Will attach: {route}", { route: facts.route })}
                  </span>
                ) : null}
              </span>
            </label>
            {send.error ? (
              <p className="text-destructive text-sm" role="alert">
                {send.error.message}
              </p>
            ) : null}
          </form>
        )}
        <DialogFooter>
          {receipt ? (
            <Button onClick={() => handleOpenChange(false)} size="sm">
              {t("Close")}
            </Button>
          ) : (
            <>
              <Button
                onClick={() => handleOpenChange(false)}
                size="sm"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button
                disabled={!text.trim() || send.isPending}
                onClick={handleSend}
                size="sm"
              >
                {send.isPending ? t("Sending…") : t("Send")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
