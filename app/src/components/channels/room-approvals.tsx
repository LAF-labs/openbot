import { useState } from "react";
import { Button } from "@/components/ui/button";
import { answerApproval } from "@/lib/approvals";
import type { RoomApproval } from "@/lib/channels/room-events";
import { t } from "@/lib/i18n";

/**
 * The questions a room's members are waiting on, above the composer.
 *
 * In a one-to-one conversation an ask rule draws its buttons on the tool call's own line
 * (`ApprovalRequest`). A room draws no tool calls — a member's working is private, only what it
 * sends is shown — so the question has no line to sit on, and before this it sat in the server's
 * registry for ten minutes where nobody could see it while the member said "I'm waiting for your
 * approval" into the room. Here it is raised with who asked, and answered by the same call the
 * line-level card uses, so the server's record of consent is the same either way.
 */
export function RoomApprovals({
  approvals,
  onAnswered,
}: {
  approvals: readonly RoomApproval[];
  /** The answer landed; the card comes down. The member is told on its next turn. */
  onAnswered: (approvalId: string) => void;
}) {
  const [answering, setAnswering] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (approvals.length === 0) return null;

  const answer = async (approval: RoomApproval, granted: boolean) => {
    setAnswering(approval.approvalId);
    const result = await answerApproval(
      approval.memberId,
      approval.approvalId,
      granted,
    );
    setAnswering(null);
    if (!result.ok) {
      setProblem(result.error ?? t("That answer could not be recorded."));
      return;
    }
    setProblem(null);
    onAnswered(approval.approvalId);
  };

  return (
    <section
      aria-label={t("Waiting for your answer")}
      className="flex flex-col gap-2 pb-2"
    >
      {approvals.map((approval) => (
        <div
          className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
          key={approval.approvalId}
        >
          <p>
            {t("{name} is waiting for your answer: {question}", {
              name: approval.memberName,
              question: approval.question,
            })}
          </p>
          {approval.rule ? (
            <p className="mt-1 text-muted-foreground text-xs">
              {t(
                "Asked because of this rule. Allowing covers this one action.",
              )}{" "}
              <code>{approval.rule}</code>
            </p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <Button
              disabled={answering === approval.approvalId}
              onClick={() => void answer(approval, true)}
              size="sm"
            >
              {t("Allow")}
            </Button>
            <Button
              disabled={answering === approval.approvalId}
              onClick={() => void answer(approval, false)}
              size="sm"
              variant="outline"
            >
              {t("Deny")}
            </Button>
          </div>
        </div>
      ))}
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
