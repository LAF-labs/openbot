import type { GoalView, Momentum } from "@shared/goals";
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

/**
 * One goal in the list: its title and how it is going, and one line under them.
 *
 * ONE LINE UNDER THE TITLE (2026-10-04). A row was three: the title with its chip, the target, and
 * a line of four facts — the category's name beside the category's icon, the day it is due, the
 * number it watches, how many entries. The line is what a person checks from the list: when it is
 * due and where the number stands; for a goal that watches neither, the target, which is all it
 * has. The category is its icon, named in its tooltip. The target and every entry are a press
 * away, in the goal opened.
 */
export function GoalRow({
  goal,
  isSelected,
  onSelect,
}: {
  goal: GoalView;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const Icon = CATEGORY_ICONS[goal.category] ?? IconDots;
  const watched = [dueLine(goal.dueOn), measureLine(goal)].filter(
    (fact) => fact !== null,
  );
  return (
    <button
      aria-pressed={isSelected}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent aria-pressed:border-foreground/30 aria-pressed:bg-accent",
        focusRing,
      )}
      data-goal={goal.id}
      onClick={onSelect}
      type="button"
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        title={categoryName(goal.category)}
      >
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-sm leading-5">{goal.title}</span>
          {goal.status === "active" ? (
            <MomentumChip momentum={goal.momentum} />
          ) : (
            <Badge>{t(STATUS_LABELS[goal.status])}</Badge>
          )}
        </span>
        <span className="text-muted-foreground text-xs" data-goal-line>
          {watched.length > 0 ? watched.join(" · ") : goal.target}
        </span>
      </span>
    </button>
  );
}
