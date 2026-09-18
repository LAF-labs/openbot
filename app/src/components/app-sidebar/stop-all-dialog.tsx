import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
import { workingKeys } from "@/lib/agents/working";
import { busyHeldChats, stopHeldChats } from "@/lib/copilot/held-chats";
import { t } from "@/lib/i18n";
import {
  describeWork,
  type Pressed,
  pressStopAll,
  runningQueryOptions,
  runningWithHeld,
  stopEverything,
  totalOf,
} from "@/lib/work/stop-all";

/**
 * `모두 멈추기`: how many things are going on, whether to stop them all, and what stopping came to.
 *
 * THE COUNT IS ASKED FOR, NOT GUESSED, and asked fresh on every open — and it is never what stands
 * between a person and the stop. When it cannot be read, the dialog says so and still offers the
 * button: this is the control for when something looks wrong, and the moment the server is slow to
 * answer is not a moment to refuse it.
 *
 * THIS WINDOW FIRST, THEN THE SERVER — see `pressStopAll` for the order and the measurement behind
 * it. A conversation both sides reached is counted once. If the server does not answer, what this
 * window stopped is still stopped, and the dialog says only that much.
 *
 * WHAT IT NEVER CLAIMS. It does not undo anything, and says so before the press. Questions a Bot is
 * waiting on stay unanswered — stopping is neither yes nor no — which the server's module says.
 */
export const StopAllDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const queryClient = useQueryClient();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const running = useQuery({ ...runningQueryOptions(), enabled: open });
  /** The conversations this window has a turn in flight in, as of opening. */
  const [held, setHeld] = useState<string[]>([]);
  const stop = useMutation({
    mutationFn: (): Promise<Pressed> =>
      pressStopAll({ stopHere: stopHeldChats, stopServer: stopEverything }),
    onSettled: () => {
      // The roster's "working" line would otherwise go on saying so for up to a poll interval.
      void queryClient.invalidateQueries({ queryKey: workingKeys.all });
    },
  });
  const resetStop = stop.reset;

  // Every open starts over: the count read again, the last press's answer put away.
  useEffect(() => {
    if (!open) return;
    setHeld(busyHeldChats());
    resetStop();
  }, [open, resetStop]);

  /*
   * `isFetching`, not `isPending`: every open asks again, and until the answer arrives the count
   * from the last open is exactly the stale number this dialog must not confirm a stop against.
   */
  const checking = running.isFetching;
  const counts =
    !checking && running.data ? runningWithHeld(running.data, held) : null;
  const total = counts ? totalOf(counts) : null;
  const pressed = stop.data;
  const said = pressed ? pressedSaid(pressed) : null;
  const isStopping = stop.isPending;

  /*
   * THE BUTTON THAT WAS PRESSED LEAVES WITH THE ANSWER. A stop that reached the server swaps the
   * footer for 닫기 alone, so the keyboard that pressed 모두 멈추기 was left on `<body>`; 닫기
   * takes it, after the commit that drew it. A stop the server never answered keeps its button,
   * as 다시 시도, and keeps the focus with it.
   */
  const hasReached = pressed?.reached === true;
  useEffect(() => {
    if (hasReached) cancelRef.current?.focus();
  }, [hasReached]);

  const handleStop = () => {
    if (isStopping) return;
    stop.mutate();
  };

  const close = (
    <Button
      onClick={() => onOpenChange(false)}
      ref={cancelRef}
      size="sm"
      variant="outline"
    >
      {t("Close")}
    </Button>
  );

  const body = said ? (
    <DialogHeader>
      <DialogTitle>{said.title}</DialogTitle>
      <DialogDescription>{said.description}</DialogDescription>
      {said.stuck ? (
        <p className="text-destructive text-sm">{said.stuck}</p>
      ) : null}
    </DialogHeader>
  ) : checking ? (
    <DialogHeader>
      <DialogTitle>{t("Stop everything that is running?")}</DialogTitle>
      <DialogDescription>{t("Checking what is running…")}</DialogDescription>
    </DialogHeader>
  ) : total === 0 ? (
    <DialogHeader>
      <DialogTitle>{t("Nothing is running")}</DialogTitle>
      <DialogDescription>
        {t(
          "Your Bots are not working on anything right now, so there is nothing to stop.",
        )}
      </DialogDescription>
    </DialogHeader>
  ) : (
    <DialogHeader>
      <DialogTitle>{t("Stop everything that is running?")}</DialogTitle>
      <DialogDescription>
        {counts && total !== null
          ? t("{count} things are running right now: {work}.", {
              count: total,
              work: describeWork(counts),
            })
          : t(
              "Could not check what is running. You can still stop everything.",
            )}{" "}
        {t("Work already done stays done. Nothing is undone.")}
      </DialogDescription>
    </DialogHeader>
  );

  /*
   * A press the server never answered keeps its button, as 다시 시도: the person pressed because
   * something looked wrong, and a dialog that could only be closed would send them round again.
   */
  const footer =
    pressed?.reached || (!pressed && total === 0) ? (
      <DialogFooter>{close}</DialogFooter>
    ) : checking && !pressed ? (
      <DialogFooter>
        <Button
          onClick={() => onOpenChange(false)}
          ref={cancelRef}
          size="sm"
          variant="outline"
        >
          {t("Cancel")}
        </Button>
      </DialogFooter>
    ) : (
      <DialogFooter>
        <Button
          disabled={isStopping}
          onClick={() => onOpenChange(false)}
          ref={cancelRef}
          size="sm"
          variant="outline"
        >
          {t("Cancel")}
        </Button>
        <Button
          /*
           * Filled, like the confirm that deletes: a stop cannot be taken back either, and the
           * `destructive` variant's own pale wash reads as a button that cannot be pressed.
           */
          className="bg-destructive text-white hover:bg-[color-mix(in_oklch,var(--destructive),black_12%)] dark:text-background dark:hover:bg-[color-mix(in_oklch,var(--destructive),black_8%)]"
          disabled={isStopping}
          // Keeps the focus it was pressed with while the stop is out.
          focusableWhenDisabled
          onClick={handleStop}
          size="sm"
          variant="destructive"
        >
          {isStopping
            ? t("Stopping…")
            : pressed
              ? t("Try again")
              : t("Stop everything")}
        </Button>
      </DialogFooter>
    );

  return (
    // Nothing closes it while the stop is out: what it came to is said here, not on the page.
    <Dialog isBusy={isStopping} onOpenChange={onOpenChange} open={open}>
      {/* Cancel, not the confirm, under Return: see `ConfirmDialog` for why focus is placed at all. */}
      <DialogContent initialFocus={cancelRef}>
        {body}
        {/*
         * WHAT THE PRESS CAME TO, SAID AS WELL AS DRAWN. The title and description above change in
         * place, and a heading that changes is not announced; these two lines are mounted with the
         * dialog, empty, so the answer is heard the moment it arrives. The alert only for what did
         * not stop.
         */}
        <LiveRegion className="sr-only">{said?.status}</LiveRegion>
        <LiveRegion className="sr-only" tone="alert">
          {said?.failure}
        </LiveRegion>
        {footer}
      </DialogContent>
    </Dialog>
  );
};

/**
 * What the press came to, in the person's words: what the dialog draws, and what it says aloud —
 * `status` for what stopped, `failure` for what did not.
 */
function pressedSaid(pressed: Pressed): {
  title: string;
  description: string;
  stuck: string | null;
  status: string | null;
  failure: string | null;
} {
  const { stopped, notStopped } = pressed.outcome;
  const stoppedAny = totalOf(stopped) > 0;
  const stuckAny = totalOf(notStopped) > 0;

  if (!pressed.reached) {
    const title = t("Could not stop everything");
    const description = `${t("The server did not answer. Check the connection and try again.")}${
      stoppedAny
        ? ` ${t("The conversation running in this window was stopped.")}`
        : ""
    }`;
    return {
      title,
      description,
      stuck: null,
      status: null,
      failure: `${title}. ${description}`,
    };
  }

  const title = stuckAny
    ? t("Some of it could not be stopped")
    : t("Everything is stopped");
  const description = stoppedAny
    ? t("Stopped: {work}.", { work: describeWork(stopped) })
    : stuckAny
      ? ""
      : t("Everything had already finished by the time you pressed.");
  const stuck = stuckAny
    ? t("Could not stop: {work}. Try again in a moment.", {
        work: describeWork(notStopped),
      })
    : null;
  return {
    title,
    description,
    stuck,
    status: description ? `${title}. ${description}` : title,
    failure: stuck,
  };
}
