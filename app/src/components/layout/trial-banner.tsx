import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { currentUserQueryOptions, type Trial } from "@/lib/auth/queries";
import { activeLocale, t } from "@/lib/i18n";

/**
 * A free trial's countdown, and the only one there is.
 *
 * No mail and no message goes to a trial's owner (self-serve contract §16): this line is how
 * somebody learns the trial ends, and when. Its sentences are the contract's (§9) — D-14 to D-4 the
 * count and the date, D-3 to D-1 where to take everything before it ends, D-0 tonight — and the day
 * is SEOUL'S, because the fleet stops a trial at 23:59:59 in Seoul whatever clock this machine keeps.
 *
 * Nothing is said while a trial is kept after it ends: its machine is off then, and the front door
 * and the installed shell's own page say that sentence instead (`desktop/public/index.html`).
 *
 * NOT THE DAY'S SPENT ALLOWANCE, though `/api/me` says whether it is (`budgetReachedToday`). It was
 * drawn here first, and measured on a local trial with a budget of one it wrapped this line to four
 * rows across the conversation's header and its first message — while the conversation itself
 * already said the same sentence under the question that was refused, at the moment it mattered.
 */

/** The zone a trial's days are counted in. The server judges its daily budget in the same one. */
const TRIAL_TIME_ZONE = "Asia/Seoul";

/**
 * What the banner can say, as the English `t()` reads as a key.
 *
 * Read through `t(variable)`, which `i18n-coverage.test.ts` cannot see: `trial-banner.test.ts` walks
 * this table instead.
 */
export const TRIAL_BANNER_SENTENCES = {
  counting: "Free trial D-{days} · ends {date}",
  download:
    "Before it ends, you can download everything from Settings → My data.",
  tonight: "The free trial ends at midnight tonight.",
  ended: "The free trial has ended.",
} as const;

export type TrialBannerLine = keyof typeof TRIAL_BANNER_SENTENCES;

const seoulDay = new Intl.DateTimeFormat("en-US", {
  timeZone: TRIAL_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** The Seoul calendar day an instant falls on, as a count of days, so two of them can be subtracted. */
function seoulDayNumber(at: Date): number {
  const parts = seoulDay.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((piece) => piece.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

/**
 * Whole Seoul days from `now` to the trial's last day: 0 on that day, negative once it is over.
 * NaN for an end that cannot be read, which draws nothing.
 */
export function trialDaysLeft(endsAt: string, now: Date): number {
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return Number.NaN;
  return seoulDayNumber(end) - seoulDayNumber(now);
}

/** The trial's last day, as a month and a day in Seoul, in the reader's language: 9월 29일. */
export function trialEndDate(endsAt: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: TRIAL_TIME_ZONE,
    month: "long",
    day: "numeric",
  }).format(new Date(endsAt));
}

/** Which sentences the banner says, in order, on a given day. */
export function trialBannerLines(trial: Trial, now: Date): TrialBannerLine[] {
  const days = trialDaysLeft(trial.endsAt, now);
  if (Number.isNaN(days)) return [];
  if (days < 0) return ["ended"];
  if (days === 0) return ["tonight"];
  return days <= 3 ? ["counting", "download"] : ["counting"];
}

/** The wall clock, read again every minute, so D-1 becomes D-0 at midnight without a reload. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A small label in the middle of the title bar, on every signed-in screen, while a trial runs.
 *
 * Floated rather than laid out, for the reason `ConnectionNotice` gives: the shell's title row is the
 * window's drag handle, and a strip across it would move the handle. Centred in that row's height and
 * at most two short lines, because the middle of the title row is the one part of it no screen uses —
 * a conversation's name sits at its left and its controls at its right — and a label that grew past
 * the row would lie across the first message. It lets every press through to the handle underneath,
 * except on the one link it carries. The connection notice draws over it for the seconds the server
 * is gone; that sentence is the more urgent of the two.
 *
 * MEASURED 2026-09-15 at a 1100px window: the two-line D-2 label spans x 409–691 inside the 44px row,
 * clear of a conversation's name (ends at 346) and its controls (from 1018). Centred on the window
 * rather than on the pane beside the roster, because that pane also holds the detail panel, whose
 * opening would put the label on the conversation's controls. What it can still cover, at the
 * narrowest window the shell allows, is the end of a long Bot name or of the new conversation's
 * "받는 봇" placeholder.
 */
export const TrialBanner = () => {
  const { data: user } = useQuery(currentUserQueryOptions());
  const now = useMinuteClock();
  const trial = user?.deployment.trial;
  if (!trial) return null;

  const lines = trialBannerLines(trial, now);
  if (lines.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-40 flex h-titlebar items-center justify-center px-4">
      <div
        className="flex max-w-[min(92vw,24rem)] flex-col items-center rounded-xl border border-border bg-background/95 px-3 py-0.5 text-center text-muted-foreground text-xs shadow-sm"
        data-slot="trial-banner"
        role="status"
      >
        {lines.map((line) =>
          line === "download" ? (
            <Link
              className="pointer-events-auto underline underline-offset-2 hover:text-foreground"
              key={line}
              to="/settings/account"
            >
              {t(TRIAL_BANNER_SENTENCES.download)}
            </Link>
          ) : (
            <span
              className={
                line === "counting"
                  ? "whitespace-nowrap"
                  : "whitespace-nowrap text-foreground"
              }
              key={line}
            >
              {line === "counting"
                ? t(TRIAL_BANNER_SENTENCES.counting, {
                    days: trialDaysLeft(trial.endsAt, now),
                    date: trialEndDate(trial.endsAt, activeLocale),
                  })
                : t(TRIAL_BANNER_SENTENCES[line])}
            </span>
          ),
        )}
      </div>
    </div>
  );
};
