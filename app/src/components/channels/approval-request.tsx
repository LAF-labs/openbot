import { useCallback, useId, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { alwaysLabel } from "@/components/channels/allowance-label";
import {
  answerApproval,
  closeQuestion,
  questionOn,
  watchQuestions,
} from "@/lib/approvals";
import { t } from "@/lib/i18n";

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

  const answer = useCallback(
    async (granted: boolean, always = false) => {
      if (!asking) return;
      setAnswering(true);
      const result = await answerApproval(
        asking.botId,
        asking.approvalId,
        granted,
        always,
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
        {t("Waiting for your answer: {question}", {
          question: asking.question,
        })}
      </div>
      <p className="text-sm" id={questionId}>
        {asking.question}
      </p>
      {asking.rule ? (
        <p className="mt-1 break-all font-mono text-muted-foreground text-xs">
          {asking.rule}
        </p>
      ) : null}
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
            onClick={() => void answer(true, true)}
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
          ? t(
              "Asked because of this rule. Allowing once covers this action; the other covers every one like it until you take it back in Boundaries.",
            )
          : t(
              "Asked because of this rule. Allowing covers this one action.",
            )}{" "}
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
