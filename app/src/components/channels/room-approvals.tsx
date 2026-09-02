import { useState } from "react";
import { Button } from "@/components/ui/button";
import { alwaysLabel } from "@/components/channels/allowance-label";
import { answerApproval, describeSubject } from "@/lib/approvals";
import type { RoomApproval } from "@/lib/channels/room-events";
import { t } from "@/lib/i18n";
import { useCountdown } from "@/lib/use-countdown";

/**
 * The questions a room's members are waiting on, above the composer.
 *
 * In a one-to-one conversation an ask rule draws its buttons on the tool call's own line
 * (`ApprovalRequest`). A room draws no tool calls — a member's working is private, only what it
 * sends is shown — so the question has no line to sit on, and before this it sat in the server's
 * registry for ten minutes where nobody could see it while the member said "I'm waiting for your
 * approval" into the room. Here it is raised with who asked, and answered by the same call the
 * line-level card uses, so the server's record of consent is the same either way.
 *
 * A member holds its turn while this is on screen (`server/src/rooms/wait-for-approval.ts`), so an
 * answer given here is spent on the action the person actually saw.
 */
export function RoomApprovals({
  approvals,
  onAnswered,
}: {
  approvals: readonly RoomApproval[];
  /** The question is settled or gone; the card comes down. */
  onAnswered: (approvalId: string) => void;
}) {
  if (approvals.length === 0) return null;

  return (
    /*
     * ANNOUNCED, AND EACH BUTTON SAYS WHAT IT ANSWERS. A question appearing above the composer is a
     * silent change of the page for somebody using a screen reader, and two stacked cards otherwise
     * expose four buttons all reading "Allow"/"Deny" with nothing to tell them apart. `aria-live`
     * reads the question when it arrives; the labels name the member each button answers for.
     */
    <section
      aria-label={t("Waiting for your answer")}
      aria-live="polite"
      className="flex flex-col gap-2 pb-2"
    >
      {approvals.map((approval) => (
        <RoomApprovalCard
          approval={approval}
          key={approval.approvalId}
          onAnswered={onAnswered}
        />
      ))}
    </section>
  );
}

/**
 * One question, its own component so it can hold its own clock.
 *
 * A hook cannot run inside the map above, and the countdown is per question: two members can be
 * waiting on questions raised minutes apart, and one card counting for both would be wrong for at
 * least one of them.
 */
function RoomApprovalCard({
  approval,
  onAnswered,
}: {
  approval: RoomApproval;
  onAnswered: (approvalId: string) => void;
}) {
  const [answering, setAnswering] = useState(false);
  /*
   * Kept per question, not one for the section. A room can have two members waiting at once, and a
   * single string put one member's failure under another member's name — then cleared it the moment
   * anything else succeeded.
   */
  const [problem, setProblem] = useState(false);
  const timeLeft = useCountdown(approval.expiresAt);

  const answer = async (granted: boolean, always = false) => {
    setAnswering(true);
    const result = await answerApproval(
      approval.memberId,
      approval.approvalId,
      granted,
      always,
    );
    setAnswering(false);
    if (result.ok || result.gone) {
      // `gone` means it expired or somebody answered it elsewhere: nothing to fix, and nothing left
      // to press. Leaving the card up with an error would offer buttons that can never work again.
      onAnswered(approval.approvalId);
      return;
    }
    setProblem(true);
  };

  // The sentence is written here from the facts the server sent, exactly as the line-level card
  // writes it, so one press means one thing on both surfaces. See `lib/approvals.ts`.
  const question = approval.subject
    ? describeSubject(approval.subject)
    : t("It is waiting on an answer about something this screen cannot name.");

  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
      <p>
        {t("{name} is waiting for your answer: {question}", {
          name: approval.memberName,
          question,
        })}
      </p>
      <p className="mt-1 text-muted-foreground text-xs">
        {approval.scope
          ? t(
              "Asked because of this rule. Allowing once covers this action; the other covers every one like it until you take it back in Boundaries.",
            )
          : t(
              "Asked because of this rule. Allowing covers this one action.",
            )}{" "}
        {/* The same fact as on the line-level card: a no stands. See approval-request.tsx. */}
        {t("Saying no stops it being asked again for a while.")}{" "}
        {approval.rule ? <code>{approval.rule}</code> : null}
        {/* The clock, for the same reason the line-level card has one: without it the card leaves. */}
        {timeLeft ? (
          <span className="ml-2 tabular-nums">{timeLeft}</span>
        ) : null}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          aria-label={t("Allow: {question}", { question })}
          disabled={answering}
          onClick={() => void answer(true)}
          size="sm"
        >
          {t("Allow once")}
        </Button>
        {/*
         * The wider answer, named. Two cards can be stacked here, so the label carries the
         * question as well: without it a screen reader hears the same promise twice with
         * nothing to say which member it belongs to.
         */}
        {approval.scope ? (
          <Button
            aria-label={`${alwaysLabel(approval.scope)}: ${question}`}
            disabled={answering}
            onClick={() => void answer(true, true)}
            size="sm"
            variant="outline"
          >
            {alwaysLabel(approval.scope)}
          </Button>
        ) : null}
        <Button
          aria-label={t("Deny: {question}", { question })}
          disabled={answering}
          onClick={() => void answer(false)}
          size="sm"
          variant="outline"
        >
          {t("Deny")}
        </Button>
      </div>
      {problem ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {t("That answer could not be recorded. Try again.")}
        </p>
      ) : null}
    </div>
  );
}
