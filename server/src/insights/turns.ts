/**
 * The `turns` section of the fleet's read (`read.ts`), and the one reading of it into the numbers
 * the weekly report is for: how often the Bot got the owner's errand done, how long the first
 * answer took, how often it had to ask, why it did not finish, and what a day of it cost.
 *
 * THE STATEMENT READS ONLY WHAT `run-ledger.ts` WROTE FOR IT — numbers, the ending enum and codes
 * already matched to their shape — plus the run's origin, its person's id (counted, never returned)
 * and its clock. No `label`, no `error`: those two columns of the same rows hold a person's words
 * and a failure's text, and neither is named here. A code is matched to its shape again on the way
 * out, so a row written by some other hand still cannot carry a sentence into the answer.
 *
 * It is written to be pasted into laf-control's `core/insights-sql.ts` with the two bound instants
 * swapped for `now() - interval 'N days'` and `now()`, the way the other nine travel.
 */
import { type SQL, sql } from "drizzle-orm";
import { ENDING_CODE_SOURCE } from "../telemetry/run-ending";
import { MAX_UNFINISHED_TURNS, type TurnsInsight } from "./report";

export function turnsStatement(options: {
  since: Date;
  to: Date;
  timeZone: string;
}): SQL {
  const { since, to, timeZone } = options;
  return sql`
    WITH turns AS (
      SELECT o.run_id, o.origin::text AS origin, o.user_id, o.started_at, o.queued_ms, o.first_token_ms,
             agg.model_requests, agg.tool_calls, agg.retries, agg.asked, agg.granted,
             agg.cost, agg.prompt, agg.cached, agg.finished_at,
             last.status::text AS last_status, last.ending::text AS last_ending, last.ending_code AS last_code
        FROM laf_thread_runs o
        JOIN LATERAL (
          SELECT sum(r.model_requests) AS model_requests, sum(r.tool_calls) AS tool_calls,
                 sum(r.retries) AS retries, max(r.approvals_asked) AS asked,
                 max(r.approvals_granted) AS granted, sum(r.cost_usd) AS cost,
                 sum(r.prompt_tokens) AS prompt, sum(r.cached_tokens) AS cached,
                 max(r.finished_at) AS finished_at
            FROM laf_thread_runs r WHERE r.turn_id = o.run_id
        ) agg ON true
        JOIN LATERAL (
          SELECT r.status, r.ending, r.ending_code
            FROM laf_thread_runs r WHERE r.turn_id = o.run_id
           ORDER BY r.started_at DESC LIMIT 1
        ) last ON true
       WHERE o.turn_id = o.run_id AND o.started_at >= ${since} AND o.started_at < ${to}
    ), placed AS (
      SELECT *,
             CASE WHEN last_ending IS NOT NULL THEN last_ending
                  WHEN last_status = 'unknown' THEN 'unfinished' END AS ending,
             CASE WHEN last_ending IS NULL AND last_status = 'unknown' THEN 'laf:turn_interrupted'
                  WHEN last_code ~ ${ENDING_CODE_SOURCE} THEN last_code
                  ELSE 'laf:uncoded' END AS code
        FROM turns
    ), ended AS (
      SELECT * FROM placed WHERE ending IS NOT NULL
    )
    SELECT jsonb_build_object(
      'endings', jsonb_build_object(
        'finished', (SELECT count(*) FROM ended WHERE ending = 'finished'),
        'unfinished', (SELECT count(*) FROM ended WHERE ending = 'unfinished'),
        'stopped', (SELECT count(*) FROM ended WHERE ending = 'stopped'),
        'owner', (SELECT count(*) FROM ended WHERE ending = 'owner')),
      'inFlight', (SELECT count(*) FROM placed WHERE ending IS NULL),
      'byOrigin', coalesce((
        SELECT jsonb_object_agg(origin, jsonb_build_array(n, done))
          FROM (SELECT origin, count(*) AS n, count(*) FILTER (WHERE ending = 'finished') AS done
                  FROM ended GROUP BY 1) by_origin
      ), '{}'::jsonb),
      'firstAnswer', coalesce((
        SELECT jsonb_agg(jsonb_build_array(tenths, n) ORDER BY tenths)
          FROM (SELECT round((coalesce(queued_ms, 0) + first_token_ms) / 100.0)::int AS tenths, count(*) AS n
                  FROM placed
                 WHERE origin = 'chat' AND first_token_ms IS NOT NULL
                 GROUP BY 1) timed
      ), '[]'::jsonb),
      'approvals', jsonb_build_array(
        (SELECT coalesce(sum(asked), 0) FROM ended),
        (SELECT coalesce(sum(granted), 0) FROM ended)),
      'work', jsonb_build_object(
        'modelRequests', (SELECT coalesce(sum(model_requests), 0) FROM ended),
        'toolCalls', (SELECT coalesce(sum(tool_calls), 0) FROM ended),
        'retries', (SELECT coalesce(sum(retries), 0) FROM ended)),
      'reasons', coalesce((
        SELECT jsonb_agg(jsonb_build_array(ending, code, origin, n) ORDER BY n DESC, ending, code, origin)
          FROM (SELECT ending, code, origin, count(*) AS n
                  FROM ended WHERE ending IN ('unfinished', 'owner')
                 GROUP BY 1, 2, 3) grouped
      ), '[]'::jsonb),
      'cost', jsonb_build_object(
        'usd', (SELECT round(coalesce(sum(cost), 0)::numeric, 6) FROM ended),
        'owners', (SELECT count(DISTINCT user_id) FROM ended WHERE user_id IS NOT NULL),
        'ownerDays', (SELECT count(DISTINCT (user_id, (started_at AT TIME ZONE ${timeZone}::text)::date))
                        FROM ended WHERE user_id IS NOT NULL)),
      'cache', jsonb_build_array(
        (SELECT coalesce(sum(prompt), 0) FROM ended),
        (SELECT coalesce(sum(cached), 0) FROM ended)),
      'unfinished', coalesce((
        SELECT jsonb_agg(jsonb_build_array(day, origin, code, model_requests, tool_calls, asked, retries, seconds)
                         ORDER BY started_at DESC)
          FROM (SELECT to_char(started_at AT TIME ZONE ${timeZone}::text, 'YYYY-MM-DD') AS day,
                       origin, code, started_at,
                       coalesce(model_requests, 0) AS model_requests, coalesce(tool_calls, 0) AS tool_calls,
                       coalesce(asked, 0) AS asked, coalesce(retries, 0) AS retries,
                       round(greatest(0, extract(epoch FROM (coalesce(finished_at, started_at) - started_at))))::int AS seconds
                  FROM ended WHERE ending = 'unfinished'
                 ORDER BY started_at DESC
                 LIMIT ${MAX_UNFINISHED_TURNS}::int) listed
      ), '[]'::jsonb)
    )::text AS value`;
}

/** Nearest rank over `(value, how many)` cells, the way the fleet's approval medians are read. */
export function percentileOf(
  cells: ReadonlyArray<readonly [number, number]>,
  fraction: number,
): number | null {
  const sorted = [...cells].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * total));
  let seen = 0;
  for (const [value, n] of sorted) {
    seen += n;
    if (seen >= rank) return value;
  }
  return sorted.at(-1)?.[0] ?? null;
}

export type TurnsSummary = {
  /** Turns that ended, in any of the four ways. */
  ended: number;
  inFlight: number;
  /** 끝남 over every ended turn — a Stop the owner pressed counts against it, as it should. */
  successRate: number | null;
  /** Seconds, a conversation turn's first answer. */
  firstAnswerP50: number | null;
  firstAnswerP90: number | null;
  approvalsPerTask: number | null;
  /** `(code, how many)` of 못 끝냄 and 사장님 차례, most first. */
  topReasons: Array<[string, number]>;
  /** Dollars per person per calendar day of the window, active or not. */
  costPerOwnerDay: number | null;
  /** Of the prompt, the share read from the cache. */
  cacheShare: number | null;
};

const ratio = (part: number, whole: number) =>
  whole > 0 ? part / whole : null;

/** The section read into the weekly report's numbers, for one VM or for cells summed over many. */
export function summariseTurns(
  turns: TurnsInsight,
  windowDays: number,
): TurnsSummary {
  const { finished, unfinished, stopped, owner } = turns.endings;
  const ended = finished + unfinished + stopped + owner;
  const reasons = new Map<string, number>();
  for (const [, code, , n] of turns.reasons) {
    reasons.set(code, (reasons.get(code) ?? 0) + n);
  }
  const p50 = percentileOf(turns.firstAnswer, 0.5);
  const p90 = percentileOf(turns.firstAnswer, 0.9);
  return {
    ended,
    inFlight: turns.inFlight,
    successRate: ratio(finished, ended),
    firstAnswerP50: p50 === null ? null : p50 / 10,
    firstAnswerP90: p90 === null ? null : p90 / 10,
    approvalsPerTask: ratio(turns.approvals[0], ended),
    topReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    costPerOwnerDay:
      turns.cost.owners > 0 && windowDays > 0
        ? turns.cost.usd / turns.cost.owners / windowDays
        : null,
    cacheShare: ratio(turns.cache[1], turns.cache[0]),
  };
}
