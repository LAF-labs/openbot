import {
  IconClockX,
  IconShieldCheck,
  IconShieldQuestion,
  IconShieldX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useId, useState, useSyncExternalStore } from "react";
import {
  alwaysLabel,
  duringLabel,
} from "@/components/channels/allowance-label";
import { CallPreviewList } from "@/components/channels/call-preview";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import {
  chatCard,
  chatCardChip,
  chatCardMeta,
  chatCardPadding,
  chatCardTitle,
  chatCardWaiting,
} from "@/components/ui/card-surface";
import {
  type AllowanceScope,
  type ApprovalDecision,
  type ApprovalTier,
  answerApproval,
  answerProblem,
  closeQuestion,
  decideQuestion,
  decisionOn,
  decisionPhrase,
  describeSubject,
  questionOn,
  reconsiderDecline,
  watchQuestions,
  whyAskedPhrase,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { useCountdown } from "@/lib/use-countdown";
import { cn } from "@/lib/utils";

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
 *
 * AND ONCE IT IS ANSWERED IT FOLDS INTO ONE LINE rather than vanishing. It used to disappear either
 * way: after "거부" the conversation held no trace that anybody had been asked, and after "허용" no
 * trace of what had been allowed (UI/UX audit 0.5.3, item 3).
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
  const decided = useSyncExternalStore(watchQuestions, () =>
    decisionOn(toolCallId ?? ""),
  );
  const [answering, setAnswering] = useState(false);
  /*
   * WHICH BUTTON THIS CARD'S OWN PRESS WAS. The wait holding the tool call reads "allowed" off the
   * server and can record the decision before this press's answer comes back — first writer wins
   * (`decideQuestion`), and it knows no tier. Measured 2026-09-25: "toss.im 항상 허용" pressed, a
   * standing row written, and the line read "허용함" with no way back drawn. The press knows better,
   * so the line is told.
   */
  const [pressedTier, setPressedTier] = useState<ApprovalTier | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Names the group, so the buttons announce what they are answering. */
  const questionId = useId();
  const timeLeft = useCountdown(asking?.expiresAt);
  /*
   * Only an administrator can open the admin screens — they send everybody else back to the home
   * screen — so only an administrator is told that is where an allowance is taken back, and only an
   * administrator is offered the rule itself. On one VM per person that is usually the owner, which
   * is why the rule sits behind 자세히 rather than on the card: the owner is not who it is written for.
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
      if (result.ok && granted) setPressedTier(tier);
      if (!result.ok) {
        // Expired, or answered in another tab: there is nothing here to press any more. The wait
        // that holds the tool call reads which it was and leaves that line (`lib/approvals.ts`).
        if (result.gone) {
          closeQuestion(toolCallId ?? "");
          setProblem(null);
          return;
        }
        // A refusal is said as what it is. "Try again" in front of one — a 403 that no press gets
        // past — was this card's answer to every failure (audit R5-06).
        setProblem(answerProblem(result));
        return;
      }
      // Folded here rather than waiting for the call to notice, so the buttons stop being pressable
      // the moment the answer lands. The Bot's turn is still on the server working out what to do
      // with it.
      decideQuestion(toolCallId ?? "", {
        outcome: granted ? "allowed" : "declined",
        ...(granted
          ? { tier }
          : { approvalId: asking.approvalId, botId: asking.botId }),
        ...(asking.subject ? { subject: asking.subject } : {}),
      });
      setProblem(null);
    },
    [asking, toolCallId],
  );

  if (!asking) {
    return decided ? (
      <DecidedLine
        decision={
          pressedTier && decided.outcome === "allowed" && !decided.tier
            ? { ...decided, tier: pressedTier }
            : decided
        }
        toolCallId={toolCallId ?? ""}
      />
    ) : null;
  }

  /*
   * The words are chosen here from the facts the server sent, never sent as words. A subject this
   * build cannot read says so plainly rather than rendering a blank: somebody about to press Allow
   * has to be able to tell "it wants to press 결제하기" from "we do not know what it wants".
   */
  const question = asking.subject
    ? describeSubject(asking.subject)
    : t("It is waiting on an answer about something this screen cannot name.");
  const why = whyAskedPhrase(asking.rule, asking.subject);

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
    // `data-waiting-card` is how the header's drawer finds this card to take the person to it.
    <div
      className={cn(
        chatCard,
        chatCardPadding,
        chatCardWaiting,
        "flex flex-col",
      )}
      data-waiting-card={toolCallId}
    >
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {t("Waiting for your answer: {question}", { question })}
      </div>
      {/*
       * THE SAME HEAD AS THE HELP CARD: what it is about, and whose turn it is, in amber. Two cards
       * that both wait on the person used to look nothing alike — a flat box here, a rounded amber
       * one there — so "the Bot is waiting on me" was two different pictures.
       */}
      <div className="flex items-start gap-2">
        <IconShieldQuestion
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-warning"
        />
        <p className={cn(chatCardTitle, "min-w-0 flex-1")} id={questionId}>
          {question}
        </p>
        <span className={cn(chatCardChip, "bg-warning/12 text-warning")}>
          {t("Your turn")}
        </span>
      </div>
      {/*
       * WHY, IN WORDS, WHERE THE RULE USED TO BE. The rule's own text is still here for whoever
       * wrote it, folded under 자세히 at the bottom; see `whyAskedPhrase`.
       */}
      {why ? (
        <p className={cn(chatCardMeta, "mt-0.5 ps-6")}>
          {t(why.key, why.params)}
        </p>
      ) : null}
      {/* What an outward call will send, so the yes is given about the call it is bound to. */}
      <CallPreviewList
        preview={asking.preview}
        toolRef={
          asking.subject?.tool
            ? `${asking.subject.tool.server}/${asking.subject.tool.name}`
            : undefined
        }
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-2 ps-6">
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
      <ButtonsExplained
        hasThread={Boolean(asking.threadId)}
        scope={asking.scope}
      />
      {/*
       * THE CLOCK, BECAUSE THE CARD LEAVES WITHOUT ONE OTHERWISE. Ten minutes after it was raised
       * the question expires and the buttons stop working; before this there was nothing on the
       * card that said so, and somebody who stepped away came back to a Bot that had given up for a
       * reason the screen never mentioned.
       */}
      {timeLeft ? (
        <p className="mt-1 ps-6 text-muted-foreground text-xs tabular-nums">
          {timeLeft}
        </p>
      ) : null}
      {/*
       * THE RULE ITSELF, FOR WHOEVER CAN CHANGE IT, FOLDED. It was the loudest thing on the card —
       * a monospace line of CEL beside the buttons — and the person answering could neither read
       * it nor edit it. Kept, because an administrator deciding whether a rule asks too often
       * needs to see which one it was; closed, because that is not the question being asked.
       */}
      {asking.rule && mayEditBoundaries ? (
        <details className="mt-1.5 ps-6 text-muted-foreground text-xs">
          <summary className="w-fit cursor-pointer select-none">
            {t("Details")}
          </summary>
          <p className="mt-1">{t("The rule that asked:")}</p>
          <code className="mt-0.5 block break-all font-mono">
            {asking.rule}
          </code>
        </details>
      ) : null}
      {problem ? (
        <p className="mt-2 ps-6 text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * WHAT EACH BUTTON DOES, BY ITS OWN NAME.
 *
 * The note used to say "이번만 허용은 이 행동 하나에만 적용되고, 다른 하나는 경계 설정에서 취소할
 * 때까지 같은 종류를 모두 허용합니다" — "the other one" for a button that has a name, and a settings
 * page an owner has never heard of (UI/UX audit 0.5.3, item 3). Each button present is named as it
 * is written on it, and said in a phrase.
 */
function ButtonsExplained({
  scope,
  hasThread,
}: {
  scope: AllowanceScope | undefined;
  hasThread: boolean;
}) {
  const parts = [t("Allow once: just this.")];
  if (scope && hasThread) {
    parts.push(
      t("{button}: here only, and for a day at most.", {
        button: duringLabel(scope),
      }),
    );
  }
  /*
   * WHERE IT IS TAKEN BACK, AND A WAY THERE. This said "관리 화면에서 취소할 때까지" to an
   * administrator and "누군가 취소할 때까지" to everybody else, and the admin page is CEL rules an
   * owner cannot use — or, for an owner who is not an administrator, cannot open at all
   * (ux-review-0.5.4 §1.7). The Bot's profile lists every standing permission with a button to take
   * it back, and it is the owner's whatever their role. Named here and linked from the line the card
   * folds into, not from the open question: leaving the conversation while the Bot waits on an
   * answer is not something this card should invite.
   */
  if (scope) {
    parts.push(
      t(
        "{button}: not asked again until you take it back on the Bot's profile.",
        {
          button: alwaysLabel(scope),
        },
      ),
    );
  }
  /*
   * SAID ON THE CARD, because it changes what the Deny button means. A no used to last until the
   * Bot tried again, which could be seconds; now it stands, and somebody deciding needs to know
   * that before they press it rather than afterwards.
   */
  parts.push(t("Deny: the same thing is refused without asking for a while."));
  return (
    <p className="mt-1.5 ps-6 text-muted-foreground text-xs">
      {parts.join(" ")}
    </p>
  );
}

const DECIDED_ICONS: Record<ApprovalDecision["outcome"], typeof IconClockX> = {
  allowed: IconShieldCheck,
  declined: IconShieldX,
  unanswered: IconClockX,
};

/**
 * The card after it was answered: what was decided, about what, in one line.
 *
 * Muted and small, because it is a record rather than a question — the one thing the conversation
 * still needs from it is that somebody scrolling back can see that a person was asked and what they
 * said. It wraps rather than truncating: at 375 wide "toss.im에서 ‘비즈니스’ 누르기" is the part that
 * would be cut, and it is the part that matters.
 */
function DecidedLine({
  decision,
  toolCallId,
}: {
  decision: ApprovalDecision;
  toolCallId: string;
}) {
  const [isPressing, setIsPressing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const Icon = decision.reconsidered
    ? IconShieldQuestion
    : DECIDED_ICONS[decision.outcome];
  const said = decisionPhrase(decision);
  /*
   * A No can be taken back while it stands — which is all the button does: the next attempt is asked
   * about again (`reconsiderDecline`). Drawn only where the line knows which question it answered.
   */
  const mayReconsider =
    decision.outcome === "declined" &&
    !decision.reconsidered &&
    decision.approvalId !== undefined &&
    decision.botId !== undefined;

  const handleReconsider = async () => {
    setIsPressing(true);
    const result = await reconsiderDecline(toolCallId, decision);
    setIsPressing(false);
    setProblem(result.ok ? null : answerProblem(result));
  };

  return (
    <div className="py-0.5 text-muted-foreground text-xs">
      <p className="flex items-start gap-1.5">
        <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 wrap-break-word">
          {t(said.key, said.params)}
        </span>
        {decision.outcome === "allowed" && decision.tier === "always" ? (
          /*
           * Where this "always" is taken back, from the line that records it. It used to be the
           * administrator's rules page, named and never linked (ux-review-0.5.4 §1.7).
           */
          <Link
            className={`ms-auto shrink-0 underline underline-offset-2 hover:text-foreground ${focusRing}`}
            hash="allowances"
            to="/agents"
          >
            {t("Take it back")}
          </Link>
        ) : null}
        {mayReconsider ? (
          <Button
            className="-my-1 ms-auto h-6 shrink-0 px-2 text-xs"
            disabled={isPressing}
            onClick={() => void handleReconsider()}
            size="sm"
            title={t(
              "Takes back this no. Nothing is allowed: the Bot is asked again the next time it tries.",
            )}
            variant="ghost"
          >
            {t("Ask me again next time")}
          </Button>
        ) : null}
      </p>
      {problem ? (
        <p className="ps-5 text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
