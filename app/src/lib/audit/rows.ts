import type { AuditEvent } from "./queries";

/**
 * NINE IDENTICAL ROWS ARE ONE FACT, AND THE TRAIL OPENS WITH THEM.
 *
 * Every boot writes `computer.policy_loaded` and `computer.isolation_loaded`, and a machine that
 * restarted nine times over a deploy puts eighteen rows at the top of the page — the first screenful
 * of a 365-day trail spent saying the same two things. Whatever a reader came to find is below the
 * fold before they have read anything.
 *
 * So consecutive events that WOULD DRAW THE SAME ROW become one row and a count. Not "the same
 * event type": the same row, signature-for-signature, including the decision, the rule and the
 * element. A refusal can therefore never be folded into the allows around it, which is the one
 * mistake a collapsing trail could make that would matter.
 *
 * The grouping is here rather than in the table because it is the part with an answer that can be
 * asserted — `audit-rows.test.ts` runs it over fabricated rows, which is not something a `<tbody>`
 * can be asked to do.
 */

/** One drawn row: the newest of a run of identical events, and how many there were. */
export type AuditRun = {
  /** The newest event of the run. Everything the row draws comes from this one. */
  event: AuditEvent;
  /** How many consecutive identical events it stands for. One for an ordinary row. */
  count: number;
  /** When the oldest of them happened, so a collapsed row can say over what span. */
  firstAt: string;
};

/** A day's worth of rows, under one heading. */
export type AuditDay = {
  /** `YYYY-MM-DD` in the reader's own time zone. Stable across re-renders, so it keys the group. */
  key: string;
  /** An instant inside that day, for the heading to format however the locale wants. */
  at: string;
  runs: AuditRun[];
};

/**
 * The day an event belongs to, as the person reading it experiences the day.
 *
 * Built from the local parts rather than sliced off the ISO string: the server writes UTC, and a
 * trail read in Seoul would otherwise put nine in the morning under the previous date — every row
 * before 09:00 KST filed under yesterday, silently, on the one screen whose job is when things
 * happened.
 */
export function dayKeyOf(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Everything about an event that reaches the screen, as one string.
 *
 * Two events collapse when this matches, so the list is the definition of "the same row" and has to
 * stay in step with what `admin/audit.tsx` actually draws. A field the table starts showing and this
 * function does not know about would let two visibly different rows fold into one — which is why
 * `audit-rows.test.ts` asserts the specific pairs that must never collapse rather than only the
 * pairs that must.
 */
export function signatureOf(event: AuditEvent): string {
  const payload = event.payload ?? {};
  const decision = (payload.decision ?? {}) as {
    allowed?: boolean;
    mode?: string;
    rule?: string | null;
    approvedBy?: string;
    carriedOut?: boolean;
  };
  const element = payload.element;
  return JSON.stringify([
    event.eventType,
    event.targetType,
    event.targetId ?? "",
    text(payload.action),
    text(payload.bot),
    text(payload.function),
    text(payload.file),
    text(payload.fingerprint),
    text(payload.page),
    typeof element === "object" && element !== null
      ? [
          text((element as { role?: unknown }).role),
          text((element as { name?: unknown }).name),
        ]
      : text(element),
    text(payload.reason),
    text(payload.failure),
    // A repeat row's whole content is its number; two of them saying 5 and 25 are not one row.
    typeof payload.count === "number" ? payload.count : "",
    decision.rule ?? "",
    text(decision.approvedBy),
    text(decision.mode),
    decision.allowed === undefined ? "" : decision.allowed,
    decision.carriedOut === undefined ? "" : decision.carriedOut,
    // The stall row's two numbers, which are the only reason to read it.
    typeof payload.silentForMs === "number" ? payload.silentForMs : "",
    typeof payload.chunks === "number" ? payload.chunks : "",
  ]);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The rows the table draws, newest first, in the order the API returned them.
 *
 * A run never crosses midnight. It would otherwise be filed under one day's heading while half of
 * it happened on another, and a heading that is wrong about the date is worse than nine rows.
 */
export function groupByDay(events: AuditEvent[]): AuditDay[] {
  const days: AuditDay[] = [];
  let day: AuditDay | null = null;
  let signature = "";

  for (const event of events) {
    const key = dayKeyOf(event.createdAt);
    if (!day || day.key !== key) {
      day = { key, at: event.createdAt, runs: [] };
      days.push(day);
      signature = "";
    }
    const next = signatureOf(event);
    const last = day.runs.at(-1);
    if (last && next === signature) {
      last.count += 1;
      // Newest first, so each further match is older: the run's start keeps moving backwards.
      last.firstAt = event.createdAt;
      continue;
    }
    day.runs.push({ event, count: 1, firstAt: event.createdAt });
    signature = next;
  }

  return days;
}
