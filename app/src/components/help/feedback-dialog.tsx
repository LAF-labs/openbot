import { useMutation } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ConnectionCheckDialog } from "@/components/help/connection-check-dialog";
import { DiagnosticsPreview } from "@/components/help/diagnostics-preview";
import { LiveRegion } from "@/components/layout/live-region";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { activeLocale, t } from "@/lib/i18n";
import {
  lastConnectionCheck,
  subscribeToConnectionCheck,
} from "@/lib/support/connection-check";
import {
  FEEDBACK_MAX_LENGTH,
  type FeedbackReceipt,
  FeedbackRefusedError,
  fetchDiagnostics,
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
 * THE BOXES ARE OFF UNTIL TICKED. "Send what is on screen too" attaches two facts — this screen's
 * path and the last failure code it drew — and the line under it says exactly that, because a
 * checkbox that reads as "attach a screenshot" and does something else is a checkbox nobody ticks
 * twice. What it will attach is printed the moment it is ticked, so there is nothing to take on
 * trust.
 *
 * "SEND DIAGNOSTIC DETAILS TOO" GATHERS ONLY WHEN TICKED, AND SHOWS BEFORE IT SENDS. Ticking it asks
 * the server for the bundle (`GET /api/support/diagnostics`) and draws it, folded, under the box;
 * 보내기 waits until it is there, and what goes is the id of the one drawn. If the server no longer
 * holds it — a restart, half an hour open — the send is refused, the box gathers a new one and
 * says so, and nothing is attached that the person was not shown.
 *
 * 보냈습니다 IS THE SERVER'S SENTENCE, NOT THE BUTTON'S. It is drawn from the receipt the route
 * answered with, after a 201 and never before: the time it was received, whether anybody was
 * told, and whether the details went with it. A box that said "sent" on the press would say so to a
 * dead server too.
 *
 * 연결 점검 OPENS OVER THE BOX, NOT INSTEAD OF IT, so a half-written message survives it; and the
 * details, when ticked, are gathered again once it closes, because the last check's result is part
 * of them (`fetchDiagnostics`) and the preview must show the one that will go.
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
  const diagnosticsBoxId = useId();
  const [text, setText] = useState("");
  const [withScreen, setWithScreen] = useState(false);
  const [withDiagnostics, setWithDiagnostics] = useState(false);
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const lastCheck = useSyncExternalStore(
    subscribeToConnectionCheck,
    lastConnectionCheck,
    () => null,
  );

  const facts = screenFactsFor(location.pathname, lastTurnFailure());
  const gather = useMutation({
    mutationFn: () => fetchDiagnostics(fetch, lastConnectionCheck()),
  });
  const preview = withDiagnostics ? (gather.data ?? null) : null;
  const send = useMutation({
    mutationFn: () =>
      sendFeedback(
        text,
        withScreen ? facts : null,
        fetch,
        preview ? preview.id : null,
      ),
    onSuccess: (sent) => setReceipt(sent),
    onError: (error) => {
      // The bundle that was shown is gone: show the one that would go now, before anything is sent.
      if (
        error instanceof FeedbackRefusedError &&
        error.code === "laf:diagnostics_expired"
      ) {
        gather.mutate();
      }
    },
  });

  // A fresh box every time it opens: the last message was sent, and the last error was about it.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setText("");
      setWithScreen(false);
      setWithDiagnostics(false);
      setReceipt(null);
      setIsChecking(false);
      send.reset();
      gather.reset();
    }
    onOpenChange(next);
  };

  const handleCheckingChange = (next: boolean) => {
    setIsChecking(next);
    if (!next && withDiagnostics) gather.mutate();
  };

  const handleDiagnosticsChange = (checked: boolean) => {
    setWithDiagnostics(checked);
    send.reset();
    if (checked) gather.mutate();
    else gather.reset();
  };

  // Ticked and not yet drawn is not sendable: nothing goes that the person has not been shown.
  const isWaitingForDiagnostics = withDiagnostics && !preview;
  const isSending = send.isPending;
  const hasGatherFailed =
    withDiagnostics && !gather.isPending && !preview && gather.error !== null;

  /*
   * THE RECEIPT TAKES THE FORM'S PLACE, AND THE BUTTON THAT SENT IT WITH IT. 닫기 takes the focus
   * after the commit that draws it; left alone, the keyboard that pressed 보내기 was on `<body>`.
   */
  const closeRef = useRef<HTMLButtonElement>(null);
  const hasReceipt = receipt !== null;
  useEffect(() => {
    if (hasReceipt) closeRef.current?.focus();
  }, [hasReceipt]);

  const handleSend = () => {
    if (!text.trim() || isSending || isWaitingForDiagnostics) return;
    send.mutate();
  };

  const receivedAt = receipt
    ? new Intl.DateTimeFormat(activeLocale, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(receipt.receivedAt))
    : "";

  return (
    // While the message is on its way nothing closes the box: it would take the answer with it.
    <Dialog isBusy={isSending} onOpenChange={handleOpenChange} open={open}>
      <DialogContent initialFocus={textareaRef}>
        <DialogHeader>
          <DialogTitle>{t("Questions and feedback")}</DialogTitle>
          <DialogDescription>
            {t(
              "Write what did not work, or what you would like. The people who make the app read it.",
            )}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted from the open, so the receipt is heard when it replaces the form. */}
        <LiveRegion as="p" className="text-sm">
          {receipt ? (
            <>
              <span className="font-medium">{t("Sent.")}</span>{" "}
              {t("Received {time}.", { time: receivedAt })}
              {receipt.told.length > 0
                ? ` ${t("It has reached the people who run the app.")}`
                : null}
              {receipt.withDiagnostics
                ? ` ${t("The diagnostic details went with it.")}`
                : null}
            </>
          ) : null}
        </LiveRegion>
        {receipt ? null : (
          // The body scrolls, so an opened preview never pushes 보내기 off a short screen.
          <DialogBody>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleSend();
              }}
            >
              {/*
               * Locked while it sends: the text, both boxes, and the two buttons inside. A message
               * edited after 보내기 is not the message that went.
               */}
              <fieldset
                className="flex min-w-0 flex-col gap-3"
                disabled={isSending}
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
                          ? t(
                              "Will attach: {route} and the last failure, {code}",
                              {
                                route: facts.route,
                                code: facts.failureCode,
                              },
                            )
                          : t("Will attach: {route}", { route: facts.route })}
                      </span>
                    ) : null}
                  </span>
                </label>
                <div className="flex flex-col gap-2">
                  <label
                    className="flex cursor-pointer items-start gap-2 text-sm"
                    htmlFor={diagnosticsBoxId}
                  >
                    <input
                      checked={withDiagnostics}
                      className="mt-1 size-4 shrink-0 accent-primary"
                      id={diagnosticsBoxId}
                      onChange={(event) =>
                        handleDiagnosticsChange(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span>{t("Send diagnostic details too")}</span>
                      <span className="text-muted-foreground text-xs">
                        {t(
                          "The app version, whether the server is working, recent failure codes and your own Bots' recent records.",
                        )}
                      </span>
                      {lastCheck ? (
                        <span className="text-muted-foreground text-xs">
                          {t("And the result of the last connection check.")}
                        </span>
                      ) : null}
                    </span>
                  </label>
                  {/* Both mounted with the box, so the gathering and its failure are heard. */}
                  <LiveRegion as="p" className="text-muted-foreground text-xs">
                    {withDiagnostics && gather.isPending
                      ? t("Gathering the diagnostic details…")
                      : null}
                  </LiveRegion>
                  {withDiagnostics && preview ? (
                    <DiagnosticsPreview bundle={preview.diagnostics} />
                  ) : null}
                  <LiveRegion
                    as="p"
                    className="text-destructive text-xs"
                    tone="alert"
                  >
                    {hasGatherFailed ? (
                      <>
                        {gather.error?.message}{" "}
                        <button
                          className="underline underline-offset-2"
                          onClick={() => gather.mutate()}
                          type="button"
                        >
                          {t("Try again")}
                        </button>
                      </>
                    ) : null}
                  </LiveRegion>
                </div>
                <p className="text-muted-foreground text-xs">
                  {t(
                    "If the app seems stuck, a connection check may already say why.",
                  )}{" "}
                  <button
                    className="underline underline-offset-2"
                    onClick={() => setIsChecking(true)}
                    type="button"
                  >
                    {t("Connection check")}
                  </button>
                </p>
              </fieldset>
            </form>
          </DialogBody>
        )}
        {/* Outside the form, which goes when the receipt comes: this line is the box's, not the form's. */}
        <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
          {receipt ? null : send.error?.message}
        </LiveRegion>
        <DialogFooter>
          {receipt ? (
            <Button
              onClick={() => handleOpenChange(false)}
              ref={closeRef}
              size="sm"
            >
              {t("Close")}
            </Button>
          ) : (
            <>
              <Button
                disabled={isSending}
                onClick={() => handleOpenChange(false)}
                size="sm"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button
                disabled={!text.trim() || isSending || isWaitingForDiagnostics}
                // Keeps the focus it was pressed with while the message is on its way.
                focusableWhenDisabled={isSending}
                onClick={handleSend}
                size="sm"
              >
                {isSending ? t("Sending…") : t("Send")}
              </Button>
            </>
          )}
        </DialogFooter>
        {/* Inside the box's popup, so Base UI nests it rather than stacking two dialogs side by side. */}
        <ConnectionCheckDialog
          onOpenChange={handleCheckingChange}
          open={isChecking}
        />
      </DialogContent>
    </Dialog>
  );
}
