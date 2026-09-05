import { useQuery } from "@tanstack/react-query";
import { useCallback, useId, useState, useSyncExternalStore } from "react";
import {
  alwaysLabel,
  duringLabel,
} from "@/components/channels/allowance-label";
import { Button } from "@/components/ui/button";
import {
  type ApprovalTier,
  answerApproval,
  closeQuestion,
  describeSubject,
  questionOn,
  watchQuestions,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { useCountdown } from "@/lib/use-countdown";

/**
 * A transcript line that grew buttons, for the one action a boundary wanted a person to see.
 *
 * Not a modal, and the restraint is the point. A question about one click belongs where the click is
 * being reported, in sequence with everything else the Bot did, so a person can see what led up to it
 * without losing the conversation behind a dialog. A boundary that interrupts the whole screen is one
 * people learn to dismiss, and an ask rule that gets reflexively approved is worse than no rule at
 * all: it produces a record of consent that nobody actually gave.
 *
 * It draws the question its own tool call is waiting on, and nothing else. The alternative, asking
 * the server what this Bot is waiting on and showing the first unanswered thing, cannot tell one
 * question from another: a run that was stopped or a tab that was reloaded leaves its question open
 * in the registry for the rest of the ten minutes, so the card would offer somebody a stale question
 * on the line of an action nobody is being asked about, and record their Allow against the wrong
 * one. The tool call that raised the question is the only thing that knows which one is its own, so
 * it is what says so.
 */
export function ApprovalRequest({
  /** The tool call this line is reporting. Undefined before the SDK has named it. */
  toolCallId,
}: {
  toolCallId: string | undefined;
}) {
  const asking = useSyncExternalStore(watchQuestions, () =>
    questionOn(toolCallId ?? ""),
  );
  const [answering, setAnswering] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Names the group, so the buttons announce what they are answering. */
  const questionId = useId();
  const timeLeft = useCountdown(asking?.expiresAt);
  /*
   * Only an administrator can open the Boundaries page — it sends everybody else back to the home
   * screen — so only an administrator is told that is where an allowance is taken back. The sentence
   * was on every card, and for most people it named a page they cannot reach
   * (docs/laf/redesign-2026-09.md §5.6(g)-6).
   */
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const mayEditBoundaries = currentUser?.role === "admin";

  const answer = useCallback(
    async (granted: boolean, tier: ApprovalTier = "once") => {
      if (!asking) return;
      setAnswering(true);
      const result = await answerApproval(
        asking.botId,
        asking.approvalId,
        granted,
        tier,
      );
      setAnswering(false);
      if (!result.ok) {
        // Expired, or answered in another tab: there is nothing here to press any more.
        if (result.gone) {
          closeQuestion(toolCallId ?? "");
          setProblem(null);
          return;
        }
        setProblem(t("That answer could not be recorded. Try again."));
        return;
      }
      // Taken down here rather than waiting for the call to notice, so the buttons stop being
      // pressable the moment the answer lands. The Bot's turn is still on the server working out
      // what to do with it.
      closeQuestion(toolCallId ?? "");
      setProblem(null);
    },
    [asking, toolCallId],
  );

  if (!asking) return null;

  /*
   * The words are chosen here from the facts the server sent, never sent as words. A subject this
   * build cannot read says so plainly rather than rendering a blank: somebody about to press Allow
   * has to be able to tell "it wants to press 결제하기" from "we do not know what it wants".
   */
  const question = asking.subject
    ? describeSubject(asking.subject)
    : t("It is waiting on an answer about something this screen cannot name.");

  return (
    /*
     * A GROUP, NAMED BY THE QUESTION, WITH A POLITE ANNOUNCER.
     *
     * A Bot asking permission is the one thing in the transcript that is waiting on the reader, and
     * it arrived without a sound: two buttons appeared and nothing said they had. `role="alert"`
     * would be the reflex, and it is wrong here — assertive interrupts whatever is being read, and
     * the comment at the top of this file rejects interrupting on purpose. Polite says it at the
     * next natural break, which is what a question in a conversation deserves.
     */
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {t("Waiting for your answer: {question}", { question })}
      </div>
      <p className="text-sm" id={questionId}>
        {question}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {asking.rule ? (
          <span className="break-all font-mono text-muted-foreground text-xs">
            {asking.rule}
          </span>
        ) : null}
        {/*
         * THE CLOCK, BECAUSE THE CARD LEAVES WITHOUT ONE OTHERWISE. Ten minutes after it was
         * raised the question expires and the buttons stop working; before this there was nothing
         * on the card that said so, and somebody who stepped away came back to a Bot that had
         * given up for a reason the screen never mentioned.
         */}
        {timeLeft ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {timeLeft}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          // Described by the question rather than wrapped in a group role: "Allow" on its own says
          // nothing about what is being allowed.
          aria-describedby={questionId}
          disabled={answering}
          onClick={() => void answer(true)}
          size="sm"
        >
          {t("Allow once")}
        </Button>
        {/*
         * THE MIDDLE BUTTON: the same width, for this conversation and for a day, whichever ends
         * first. Drawn only when the server said which conversation the question came from — a
         * question raised from nowhere has nothing for it to bind to, and the answering route would
         * silently give the once. Between "once" and "always" because that is where it sits.
         */}
        {asking.scope && asking.threadId ? (
          <Button
            aria-describedby={questionId}
            disabled={answering}
            onClick={() => void answer(true, "thread")}
            size="sm"
            variant="outline"
          >
            {duringLabel(asking.scope)}
          </Button>
        ) : null}
        {/*
         * THE WIDER BUTTON SAYS HOW WIDE. A person cannot consent to something they were not shown,
         * and "Always allow" on its own is a promise about an unnamed set: the same press means one
         * website, one file or one tool depending on what the Bot was doing, and the difference
         * between those is the whole decision. Absent when the server derived no scope, in which
         * case there is nothing honest to write on it.
         */}
        {asking.scope ? (
          <Button
            aria-describedby={questionId}
            disabled={answering}
            onClick={() => void answer(true, "always")}
            size="sm"
            variant="outline"
          >
            {alwaysLabel(asking.scope)}
          </Button>
        ) : null}
        <Button
          aria-describedby={questionId}
          disabled={answering}
          onClick={() => void answer(false)}
          size="sm"
          variant="outline"
        >
          {t("Deny")}
        </Button>
      </div>
      <p className="mt-1.5 text-muted-foreground text-xs">
        {asking.scope
          ? mayEditBoundaries
            ? t(
                "Asked because of this rule. Allowing once covers this action; the other covers every one like it until you take it back in Boundaries.",
              )
            : // Same promise, no page named: Boundaries is admin-only and sends everybody else home.
              t(
                "Asked because of this rule. Allowing once covers this action; the other covers every one like it until somebody takes it back.",
              )
          : t(
              "Asked because of this rule. Allowing covers this one action.",
            )}{" "}
        {/*
         * The middle button's clock, said here because the button has no room for it: somebody
         * deciding between "this conversation" and "always" is owed the day before they press.
         */}
        {asking.scope && asking.threadId
          ? `${t("For this conversation means here only, and for a day at most.")} `
          : null}
        {/*
         * SAID ON THE CARD, because it changes what the Deny button means. A no used to last until
         * the Bot tried again, which could be seconds; now it stands, and somebody deciding needs
         * to know that before they press it rather than afterwards. No new control — this is what
         * the existing button already does.
         */}
        {t("Saying no stops it being asked again for a while.")}
      </p>
      {problem ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
