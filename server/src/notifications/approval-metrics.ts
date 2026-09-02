/**
 * The number this product is judged by: how long a person takes to answer, and how long at night.
 *
 * §5.7 names it "야간 승인 해소 시간" and says to measure it from `approval.requested` to the answer.
 * A Bot that stops for a person is only worth the stop if the person is actually reached, and until
 * this endpoint existed the only evidence either way was somebody's memory of an evening.
 *
 * COMPUTED FROM THE TRAIL, NOT FROM THE OUTBOX, and that is the whole reason the two are separate
 * tables. `audit_events` is append-only and holds `approval.requested` beside `approval.granted`
 * and `approval.denied`; the outbox is a delivery queue whose rows are edited as they go out and
 * deleted after thirty days. A KPI computed from a table that gets tidied is a KPI that improves
 * when somebody runs the sweep.
 *
 * FACTS ONLY. Counts and seconds, no verdict, no target, no colour. What "good" is here is a
 * product decision that has not been made, and an endpoint that decided it would be inventing one.
 *
 * "NIGHT" IS 22:00–07:00 IN `BOT_TIME_ZONE`, which is the deployment's clock rather than the VM's —
 * the machine may be anywhere and the person is in Korea (the same reason `copilot.ts` resolves the
 * Bot's own clock that way). It is computed from the moment the question was ASKED, not the moment
 * it was answered: the thing being measured is whether a question raised at two in the morning ever
 * gets to somebody, and answering it at nine makes it a nine-hour night, not a daytime answer.
 */
import { sql } from "drizzle-orm";
import { resolveTimeZone } from "../../../shared/prompt";
import type { Database } from "../db/client";

export type ApprovalMetrics = {
  /** The window, echoed so a reader is never guessing what they are looking at. */
  days: number;
  /** The clock "night" was decided in. */
  timeZone: string;
  /** Questions raised in the window. */
  count: number;
  /** Seconds from question to answer. Null when nothing in the window was answered. */
  medianSeconds: number | null;
  p90Seconds: number | null;
  /** The same, over the questions raised between 22:00 and 07:00. */
  nightMedianSeconds: number | null;
  /** Raised in the window and never answered — expired, or still open. */
  unanswered: number;
};

/** One question and its answer, as the query hands them over. */
export type ApprovalPair = {
  requestedAt: string | Date;
  /** Null when nobody ever answered. */
  decidedAt: string | Date | null;
};

/** Night starts at 22 and ends at 07, local. Both ends written down rather than assumed. */
const NIGHT_FROM_HOUR = 22;
const NIGHT_UNTIL_HOUR = 7;

/**
 * The arithmetic, with no database in it.
 *
 * Split out because everything that can be wrong here is arithmetic — a percentile off by one, a
 * night that is an hour wide, a median over an empty list reported as zero — and none of it needs a
 * Postgres to be wrong in front of.
 */
export function summariseApprovals(
  pairs: ApprovalPair[],
  options: { days: number; timeZone: string },
): ApprovalMetrics {
  const timeZone = resolveTimeZone(options.timeZone);
  const answered: number[] = [];
  const atNight: number[] = [];
  let unanswered = 0;

  for (const pair of pairs) {
    const requested = new Date(pair.requestedAt);
    if (Number.isNaN(requested.getTime())) continue;
    if (!pair.decidedAt) {
      unanswered += 1;
      continue;
    }
    const decided = new Date(pair.decidedAt);
    if (Number.isNaN(decided.getTime())) {
      unanswered += 1;
      continue;
    }
    // Never negative. Clocks and a `min()` over rows written by two statements can disagree by
    // milliseconds, and a negative answer time is a number nobody can read.
    const seconds = Math.max(
      0,
      (decided.getTime() - requested.getTime()) / 1000,
    );
    answered.push(seconds);
    if (isNight(requested, timeZone)) atNight.push(seconds);
  }

  return {
    days: options.days,
    timeZone,
    count: pairs.length,
    medianSeconds: percentile(answered, 0.5),
    p90Seconds: percentile(answered, 0.9),
    nightMedianSeconds: percentile(atNight, 0.5),
    unanswered,
  };
}

/**
 * Whether this moment falls in the night window, in the deployment's own clock.
 *
 * `Intl` rather than an offset, because an offset is wrong twice a year wherever daylight saving
 * exists — the same reason `laf_routines.daily_time_zone` stores a zone name (see laf.ts).
 * `hourCycle: "h23"` because `hour12: false` renders midnight as 24 in en-US, which would put every
 * midnight question outside a window it is squarely inside.
 */
export function isNight(at: Date, timeZone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: resolveTimeZone(timeZone),
      hourCycle: "h23",
      hour: "2-digit",
    }).format(at),
  );
  if (Number.isNaN(hour)) return false;
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR;
}

/**
 * Nearest-rank, and null for an empty list.
 *
 * Nearest-rank for the median as well as for p90, so every number this endpoint reports is a
 * duration somebody actually waited rather than an average of two of them. With an even count that
 * is the lower of the middle pair.
 *
 * Null rather than 0, because "nobody answered anything this month" and "every answer was instant"
 * are opposite facts and a zero would say the good one. Every reader of this endpoint has to handle
 * the empty month, so it is made impossible to handle it by accident.
 */
function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1),
  );
  return Math.round(sorted[rank] ?? 0);
}

/** How many days a caller may ask for. A year, because the trail is kept for one. */
export const MAX_METRIC_DAYS = 365;

export function metricDays(raw: string | undefined, fallback = 30): number {
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return fallback;
  return Math.min(Math.floor(days), MAX_METRIC_DAYS);
}

/**
 * The pairs, out of the trail.
 *
 * JOINED ON THE APPROVAL ID INSIDE THE PAYLOAD, which is the only thing the two rows share: they
 * have different target types (a question about a browser click is filed against the computer, one
 * about a tool call against the tool) and different actors (the person who was driving, and the
 * person who answered — usually not the same person, which is the reason the answer is its own
 * row). `payload->>'approval'` works because these columns hold real jsonb objects; see
 * `db/schema/json.ts` for the encoding trap that used to make every `->>` here return null.
 *
 * `min(...)` over the answers rather than one row: a question is answered once by construction
 * (`approvals.ts` refuses a second answer), and taking the earliest is what makes that assumption
 * harmless instead of load-bearing.
 */
export async function readApprovalPairs(
  database: Database,
  options: { days: number; now?: () => Date },
): Promise<Array<ApprovalPair & { approvalId: string }>> {
  const now = options.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - options.days * 24 * 60 * 60 * 1000);
  const rows = await database.execute<{
    approval_id: string;
    requested_at: string | Date;
    decided_at: string | Date | null;
  }>(sql`
    select r.payload ->> 'approval' as approval_id,
           r.created_at as requested_at,
           min(d.created_at) as decided_at
      from audit_events r
      left join audit_events d
        on d.event_type in ('approval.granted', 'approval.denied')
       and d.payload ->> 'approval' = r.payload ->> 'approval'
       and d.created_at >= r.created_at
     where r.event_type = 'approval.requested'
       and r.created_at >= ${cutoff}
       and r.payload ->> 'approval' is not null
     group by r.id, r.created_at, r.payload ->> 'approval'
  `);

  return [...rows].map((row) => ({
    approvalId: row.approval_id,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
  }));
}

/** The pairs, summarised. The endpoint's whole implementation. */
export async function readApprovalMetrics(
  database: Database,
  options: { days: number; timeZone: string; now?: () => Date },
): Promise<ApprovalMetrics> {
  const pairs = await readApprovalPairs(database, {
    days: options.days,
    ...(options.now ? { now: options.now } : {}),
  });
  return summariseApprovals(pairs, {
    days: options.days,
    timeZone: options.timeZone,
  });
}
