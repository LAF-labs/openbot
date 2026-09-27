import type { GoalStatus } from "@shared/goals";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "@/components/gallery/frame";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { LiveRegion } from "@/components/layout/live-region";
import { ReadNotice } from "@/components/layout/read-states";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  categoryName,
  type GoalEntry,
  goalEditDraft,
  goalQueryOptions,
  MOMENTUM_LABELS,
  measureLine,
  removeGoal,
  STATUS_LABELS,
  setGoalStatus,
} from "@/lib/goals/queries";
import { activeLocale, t } from "@/lib/i18n";
import { failureSentence } from "@/lib/press";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { dueLine, MomentumChip } from "./goal-parts";

/**
 * ONE GOAL, OPENED: what it is, how it is going, and its timeline (muse-shape plan §3.4).
 *
 * The timeline is what the Bot logged — a linked routine's check-ins and what the person told it in
 * the conversation — newest first, each line in the Bot's words with its value and its reading of
 * the momentum. The buttons are the person's: 완료, 그만두기 (or 다시 진행), 삭제, and 대화에서
 * 바꾸기, which starts "'{목표}'를 이렇게 바꿔 줘: " in the composer for them to finish.
 */
export function GoalDetail({
  goalId,
  channelId,
  agentId,
  onRemoved,
}: {
  goalId: string;
  channelId: string | undefined;
  agentId: string | undefined;
  onRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery(goalQueryOptions(goalId));
  const reading = useReading(detail);
  const settled = settledOf(reading);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<GoalStatus | null>(null);
  const [isAskingRemove, setIsAskingRemove] = useState(false);

  const handleStatus = async (status: GoalStatus) => {
    setProblem(null);
    setPending(status);
    await setGoalStatus(queryClient, goalId, status).catch((caught: unknown) =>
      setProblem(failureSentence(caught)),
    );
    setPending(null);
  };

  if (!settled) {
    return (
      <div className="flex flex-col gap-3" data-goal-detail>
        <ReadNotice
          line={readLineOf(reading, {
            failed: t("That goal could not be loaded."),
            notHere: t("That goal is no longer there."),
          })}
          onRetry={() => void detail.refetch()}
        />
        {reading.state === "loading" ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : null}
      </div>
    );
  }

  const { goal, entries } = settled.data;
  const measure = measureLine(goal);
  const due = dueLine(goal.dueOn);
  const draft = goalEditDraft(goal.title);

  return (
    <section
      aria-label={goal.title}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4"
      data-goal-detail
    >
      <header className="flex flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          <span>{categoryName(goal.category)}</span>
          {goal.status === "active" ? (
            <MomentumChip momentum={goal.momentum} />
          ) : (
            <Badge>{t(STATUS_LABELS[goal.status])}</Badge>
          )}
        </span>
        <h2 className="font-semibold text-lg">{goal.title}</h2>
        <p className="text-sm">{goal.target}</p>
        <p className="flex flex-wrap gap-x-3 text-muted-foreground text-xs">
          {due ? <span>{due}</span> : null}
          {measure ? <span>{measure}</span> : null}
          {goal.routines.map((routine) => (
            <span key={routine.id}>
              {t("Checked by the {name} routine", { name: routine.name })}
            </span>
          ))}
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {goal.status === "active" ? (
          <>
            <Button
              disabled={pending !== null}
              onClick={() => void handleStatus("done")}
              size="sm"
            >
              {t("Mark as done")}
            </Button>
            <Button
              disabled={pending !== null}
              onClick={() => void handleStatus("dropped")}
              size="sm"
              variant="outline"
            >
              {t("Stop this goal")}
            </Button>
          </>
        ) : (
          <Button
            disabled={pending !== null}
            onClick={() => void handleStatus("active")}
            size="sm"
            variant="outline"
          >
            {t("Take it up again")}
          </Button>
        )}
        {channelId ? (
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            params={{ channelId }}
            search={{ draft }}
            to="/channel/$channelId"
          >
            {t("Change it in the conversation")}
          </Link>
        ) : agentId ? (
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            search={{ agent: agentId, draft }}
            to="/channel/new"
          >
            {t("Change it in the conversation")}
          </Link>
        ) : null}
        <Button
          onClick={() => setIsAskingRemove(true)}
          size="sm"
          variant="ghost"
        >
          {t("Delete")}
        </Button>
      </div>
      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {problem}
      </LiveRegion>

      <div className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">{t("How it has gone")}</h3>
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t(
              "Nothing logged yet. Tell the Bot how it went in the conversation, or ask it to check at a time you choose.",
            )}
          </p>
        ) : (
          <ol className="flex flex-col gap-2" data-goal-timeline>
            {entries.map((entry) => (
              <TimelineEntry entry={entry} key={entry.id} />
            ))}
          </ol>
        )}
      </div>

      <ConfirmDialog
        confirmLabel={t("Delete")}
        description={t(
          "The goal and everything logged on it go. A routine that checked it stays, and checks nothing.",
        )}
        onConfirm={async () => {
          await removeGoal(queryClient, goalId);
          onRemoved();
        }}
        onOpenChange={setIsAskingRemove}
        open={isAskingRemove}
        title={t("Delete “{title}”?", { title: goal.title })}
      />
    </section>
  );
}

function TimelineEntry({ entry }: { entry: GoalEntry }) {
  const at = new Date(entry.at);
  return (
    <li className="flex gap-3 text-sm" data-goal-entry={entry.source}>
      <time
        className="w-28 shrink-0 text-muted-foreground text-xs leading-5"
        dateTime={entry.at}
      >
        {at.toLocaleDateString(activeLocale, {
          month: "numeric",
          day: "numeric",
        })}{" "}
        {at.toLocaleTimeString(activeLocale, {
          hour: "numeric",
          minute: "2-digit",
        })}
      </time>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>{entry.text}</span>
        <span className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          {entry.value !== null ? (
            <span>{t("Value {value}", { value: entry.value })}</span>
          ) : null}
          {entry.momentum ? (
            <span>{t(MOMENTUM_LABELS[entry.momentum])}</span>
          ) : null}
          <span>
            {entry.source === "owner"
              ? t("Written by me")
              : t("Logged by the Bot")}
          </span>
        </span>
      </span>
    </li>
  );
}
