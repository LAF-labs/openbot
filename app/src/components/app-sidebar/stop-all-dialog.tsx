import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
  outcomeWithHeld,
  runningQueryOptions,
  runningWithHeld,
  type StopAllOutcome,
  stopEverything,
  totalOf,
} from "@/lib/work/stop-all";

/** What a press came to. `reached` false is a server that did not answer at all. */
type Pressed = { reached: boolean; outcome: StopAllOutcome };

/**
 * `모두 멈추기`: how many things are going on, whether to stop them all, and what stopping came to.
 *
 * THE COUNT IS ASKED FOR, NOT GUESSED, and asked fresh on every open — and it is never what stands
 * between a person and the stop. When it cannot be read, the dialog says so and still offers the
 * button: this is the control for when something looks wrong, and the moment the server is slow to
 * answer is not a moment to refuse it.
 *
 * THE SERVER FIRST, THEN THIS WINDOW. The server stops every run on the wire and every conversation
 * whose next step is with a browser; then this window stops the conversation it holds, which also
 * cuts the step already under way. Stopped the other way round, this window's own stop would race
 * the server's for the same run and one of them would report it as not stopped. If the server does
 * not answer at all, this window still stops what it holds, and says only that much.
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
    mutationFn: async (): Promise<Pressed> => {
      const server = await stopEverything().catch(() => null);
      const here = stopHeldChats();
      return {
        reached: server !== null,
        outcome: outcomeWithHeld(server, here),
      };
    },
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

  const handleStop = () => {
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

  const body = pressed ? (
    <PressedBody pressed={pressed} />
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
          disabled={stop.isPending}
          onClick={handleStop}
          size="sm"
          variant="destructive"
        >
          {stop.isPending
            ? t("Stopping…")
            : pressed
              ? t("Try again")
              : t("Stop everything")}
        </Button>
      </DialogFooter>
    );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {/* Cancel, not the confirm, under Return: see `ConfirmDialog` for why focus is placed at all. */}
      <DialogContent initialFocus={cancelRef}>
        {body}
        {footer}
      </DialogContent>
    </Dialog>
  );
};

/** What the press came to, in the person's words. */
const PressedBody = ({ pressed }: { pressed: Pressed }) => {
  const { stopped, notStopped } = pressed.outcome;
  const stoppedAny = totalOf(stopped) > 0;
  const stuckAny = totalOf(notStopped) > 0;

  if (!pressed.reached) {
    return (
      <DialogHeader>
        <DialogTitle>{t("Could not stop everything")}</DialogTitle>
        <DialogDescription>
          {t("The server did not answer. Check the connection and try again.")}
          {stoppedAny
            ? ` ${t("The conversation running in this window was stopped.")}`
            : ""}
        </DialogDescription>
      </DialogHeader>
    );
  }

  return (
    <DialogHeader>
      <DialogTitle>
        {stuckAny
          ? t("Some of it could not be stopped")
          : t("Everything is stopped")}
      </DialogTitle>
      <DialogDescription>
        {stoppedAny
          ? t("Stopped: {work}.", { work: describeWork(stopped) })
          : stuckAny
            ? ""
            : t("Everything had already finished by the time you pressed.")}
      </DialogDescription>
      {stuckAny ? (
        <p className="text-destructive text-sm" role="alert">
          {t("Could not stop: {work}. Try again in a moment.", {
            work: describeWork(notStopped),
          })}
        </p>
      ) : null}
    </DialogHeader>
  );
};
