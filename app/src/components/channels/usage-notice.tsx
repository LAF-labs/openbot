import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import {
  noticeDue,
  readDismissedDay,
  seoulDayKey,
  usageOf,
  writeDismissedDay,
} from "@/lib/usage/today";

/**
 * One line above the composer once a free trial's day is 80% used: how much, and when it fills.
 *
 * Above the composer because that is where the next question is about to be typed — the question
 * the day may not have room for. Until this, the first sign of a spent day was the refusal under a
 * question that had already been asked.
 *
 * NOT IN THE TRIAL BANNER. The day's allowance was drawn there first, and measured on a local trial
 * it wrapped that label to four rows across the conversation's header (`layout/trial-banner.tsx`).
 *
 * Dismissable for the rest of the Seoul day — the day the server counts — and only in this browser:
 * it is a reminder, not a record, and a viewer whose storage is blocked simply sees it again.
 */
export const UsageNotice = () => {
  const { data: user } = useQuery(currentUserQueryOptions());
  const [dismissedDay, setDismissedDay] = useState(readDismissedDay);
  const usage = usageOf(user?.deployment.trial);
  if (!usage || !noticeDue(usage, dismissedDay, new Date())) return null;

  const handleDismiss = () => {
    const today = seoulDayKey(new Date());
    writeDismissedDay(today);
    setDismissedDay(today);
  };

  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1 text-muted-foreground text-sm"
      data-slot="usage-notice"
      role="status"
    >
      <span className="min-w-0 flex-1">
        {usage.percent >= 100
          ? t(
              "Today's free allowance is used up · it fills up again at midnight, Korean time",
            )
          : t(
              "You have used {percent}% of today's free allowance · it fills up again at midnight, Korean time",
              { percent: usage.percent },
            )}
      </span>
      <Button
        aria-label={t("Hide until tomorrow")}
        className="shrink-0 text-muted-foreground"
        onClick={handleDismiss}
        size="icon-xs"
        variant="ghost"
      >
        <IconX />
      </Button>
    </div>
  );
};
