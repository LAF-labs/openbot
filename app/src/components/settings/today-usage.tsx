import { useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { USAGE_NOTICE_AT, usageOf } from "@/lib/usage/today";
import { cn } from "@/lib/utils";

/**
 * 오늘 사용량: how much of a free trial's day is used, and when it fills again.
 *
 * Here so that "how much do I have left" has an answer before a question is refused rather than
 * only after — the refusal under a question is the one other place the day's budget is mentioned.
 * A quiet meter and a number, because on a normal day there is nothing to act on; the bar turns the
 * warning colour at the same 80% the notice above the composer appears at.
 *
 * Not drawn at all on a deployment without a budget, nor when the server could not read the count:
 * an empty meter there would be a claim, and the claim would be "plenty left".
 */
export const TodayUsageSection = () => {
  const { data: user } = useQuery(currentUserQueryOptions());
  const usage = usageOf(user?.deployment.trial);
  if (!usage) return null;
  const nearlySpent = usage.ratio >= USAGE_NOTICE_AT;

  return (
    <PageSection title={t("Free trial")}>
      <PageRows>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>{t("Today's usage")}</ItemTitle>
            <ItemDescription>
              {t(
                "How much of today's free allowance is used. It fills up again every day at midnight, Korean time.",
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <div className="flex items-center gap-2.5" data-slot="today-usage">
              {/*
               * A native progress bar, styled through its own parts: it is announced as a
               * percentage without any extra wiring, and a width in a class list is the only way
               * to draw a fraction in Tailwind that is not an inline style.
               */}
              <progress
                aria-label={t("Today's usage")}
                className={cn(
                  "h-1.5 w-28 appearance-none overflow-hidden rounded-full bg-muted",
                  "[&::-webkit-progress-bar]:bg-muted",
                  nearlySpent
                    ? "[&::-moz-progress-bar]:bg-warning [&::-webkit-progress-value]:bg-warning"
                    : "[&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary",
                )}
                max={100}
                value={usage.percent}
              />
              <span className="w-10 text-right text-muted-foreground text-sm tabular-nums">
                {usage.percent}%
              </span>
            </div>
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
};
