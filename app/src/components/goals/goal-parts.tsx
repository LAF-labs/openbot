import type { Momentum } from "@shared/goals";
import type { Category } from "@shared/persona";
import {
  IconBriefcase,
  IconCoin,
  IconDots,
  IconHeartbeat,
  IconHome,
  IconSchool,
  IconUsers,
} from "@tabler/icons-react";
import { Badge, type Tone } from "@/components/gallery/frame";
import { focusRing } from "@/components/ui/focus";
import { activeLocale, t } from "@/lib/i18n";
import {
  categoryName,
  type Goal,
  MOMENTUM_LABELS,
  measureLine,
  STATUS_LABELS,
} from "@/lib/goals/queries";
import { cn } from "@/lib/utils";

/**
 * The small pieces 목표's page is drawn from (muse-shape plan §3.4): a category's icon, the momentum
 * chip, a goal's row. Category icons are drawn, never cover images (plan §8).
 */

export const CATEGORY_ICONS: Readonly<Record<Category, typeof IconHome>> = {
  work: IconBriefcase,
  study: IconSchool,
  money: IconCoin,
  health: IconHeartbeat,
  relationships: IconUsers,
  life: IconHome,
  other: IconDots,
};

const MOMENTUM_TONES: Readonly<Record<Momentum, Tone>> = {
  on_track: "positive",
  at_risk: "caution",
  behind: "negative",
};

export function MomentumChip({ momentum }: { momentum: Momentum | null }) {
  if (!momentum) return null;
  return (
    <span data-momentum={momentum}>
      <Badge tone={MOMENTUM_TONES[momentum]}>
        {t(MOMENTUM_LABELS[momentum])}
      </Badge>
    </span>
  );
}

/** "12월 31일까지" — a calendar day, read without a zone, since it has none. */
export function dueLine(dueOn: string | null): string | null {
  if (!dueOn) return null;
  const day = new Date(`${dueOn}T12:00:00Z`);
  if (Number.isNaN(day.getTime())) return null;
  return t("Until {date}", {
    date: day.toLocaleDateString(activeLocale, {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }),
  });
}

/** One goal in the list: its category, title, how it is going and what to watch. */
export function GoalRow({
  goal,
  isSelected,
  onSelect,
}: {
  goal: Goal;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const Icon = CATEGORY_ICONS[goal.category] ?? IconDots;
  const measure = measureLine(goal);
  const due = dueLine(goal.dueOn);
  return (
    <button
      aria-pressed={isSelected}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent aria-pressed:border-foreground/30 aria-pressed:bg-accent",
        focusRing,
      )}
      data-goal={goal.id}
      onClick={onSelect}
      type="button"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{goal.title}</span>
          {goal.status === "active" ? (
            <MomentumChip momentum={goal.momentum} />
          ) : (
            <Badge>{t(STATUS_LABELS[goal.status])}</Badge>
          )}
        </span>
        <span className="text-muted-foreground text-sm">{goal.target}</span>
        <span className="flex flex-wrap gap-x-3 text-muted-foreground text-xs">
          <span>{categoryName(goal.category)}</span>
          {due ? <span>{due}</span> : null}
          {measure ? <span>{measure}</span> : null}
          {goal.entryCount > 0 ? (
            <span>{t("{count} entries", { count: goal.entryCount })}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
