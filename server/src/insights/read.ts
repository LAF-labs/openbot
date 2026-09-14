/**
 * What `GET /api/admin/metrics/insights` answers: the counts laf-control's `laf insights` computes,
 * read by this VM from its own database.
 *
 * WHY THE VM SERVES THEM. The launch plan stops at the questions only customers can answer — which
 * kinds of work people pick, whether anybody answers an approval at night, how long a site login
 * lasts, where Bots get stuck, whether the caps are right, what a person costs, whether anybody
 * reads the help. laf-control reads those out of every VM (`core/insights-sql.ts`) over SSH and
 * psql, which works and needs a key to a shell on every customer's machine to do it. This is the
 * same nine sections over HTTPS, behind a read token (`routes.ts`), so the fleet can stop holding a
 * shell to count something.
 *
 * THE SAME JSON, FIELD FOR FIELD. Each section is the value laf-control's statement for it prints —
 * grouped cells as arrays, counts as numbers — so `core/insights.ts` reads this body with the
 * distrustful parser it already has, and the fleet's medians are still computed from raw cells
 * across VMs rather than averaged from medians that do not add. What this VM records that the SQL
 * there does not read yet rides as extra fields inside the section it belongs to (`onboarding`'s
 * presets and first-task chips, `support`'s help page); a reader that does not know them ignores
 * them, which is how that parser treats every field it does not name.
 *
 * §1-② OF THE FLEET'S OWN RULES HOLDS HERE WORD FOR WORD. These statements open the database that
 * holds people's conversations, so:
 *
 *  - no content column is named — a message, an answer, an instruction, a Bot's title or role, a
 *    routine's name, feedback's words, a label, an email;
 *  - free text that may carry a code (`laf_thread_runs.error`, an audit row's `failure`) is only
 *    matched against the code shape, and only the match leaves;
 *  - a page's host becomes a site id from the catalogue this deployment ships, or `other` — a
 *    customer's own shop domain never leaves;
 *  - a connector that is not first-party is `custom`, tool and all;
 *  - numbers per person carry no id.
 *
 * `server/tests/insights-read.integration.test.ts` plants content beside every counted row and
 * serialises the whole answer to prove none of it comes back.
 *
 * NULL IS NOT ZERO. Each section is its own statement in its own read-only transaction; one that
 * fails is `null` and the others still answer — the fleet says 못 읽음 for exactly that section,
 * which is the opposite reaction to a zero.
 */
import { type SQL, sql } from "drizzle-orm";
import { BUSINESS_SITES } from "../../../shared/sites/catalogue";
import { WORK_PATTERN_IDS } from "../agents/first-task";
import { MAX_BOTS_PER_COMPUTER } from "../computer/assignment";
import type { Database } from "../db/client";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { CATALOGUE } from "../plugins/catalogue";
import { ROUTINE_RUN_TIMEOUT_MS } from "../routines/run";
import { MAX_ROUTINES } from "../routines/store";
import { DEFAULT_MAX_STEPS } from "../runner/unattended";
import { CATALOGUE_KEY_SOURCE } from "./catalogue-key";
import {
  INSIGHT_SECTIONS,
  type InsightSection,
  type InsightsReport,
  MAX_FAILURE_SIGNATURES,
  MAX_PEOPLE_ROWS,
} from "./report";

/**
 * A run that met the step budget records `DEFAULT_MAX_STEPS + 1` model turns (steps 0…12) and then
 * one more with no tools on offer, so it can only answer (`runner/unattended.ts`). One that stopped
 * asking on its thirteenth turn records thirteen and never met the budget.
 */
const STEPS_WHEN_BUDGET_MET = DEFAULT_MAX_STEPS + 2;
const ROUTINE_RUN_TIMEOUT_SECONDS = ROUTINE_RUN_TIMEOUT_MS / 1000;

/** The one shape a code may take out of free text. */
const CODE_SOURCE = "laf:[a-z0-9_]{1,60}";
const WHOLE_CODE = `^${CODE_SOURCE}$`;

/** Nothing any of these statements should take longer than, on a VM somebody is using. */
const STATEMENT_TIMEOUT = "20s";

/** A closed list this file owns, as bound parameters — never text a VM or a person supplied. */
const listOf = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/**
 * Every host the site catalogue claims, in catalogue order, so a page on a host two sites could
 * claim goes to the first — the same order `siteForUrl` walks.
 */
function hostsValues(): SQL {
  const rows: SQL[] = [];
  let ordinal = 0;
  for (const site of BUSINESS_SITES) {
    for (const host of site.hosts) {
      ordinal += 1;
      rows.push(sql`(${ordinal}::int, ${site.id}::text, ${host}::text)`);
    }
  }
  return sql.join(rows, sql`, `);
}

/**
 * The statements, one per section, each returning ONE row with ONE text column holding the section.
 *
 * The window is bound, never interpolated; so is every list and every constant. The SQL is otherwise
 * laf-control's (`core/insights-sql.ts`, 2026-09-14), which is the point: two readers of the same
 * rows that disagree are a fleet that cannot tell which number is true.
 *
 * ONE DIFFERENCE, AND IT IS THE WINDOW'S OTHER END. Those statements count from `now() - N days`
 * with nothing above; these count `from ≤ t < to`, the two instants the answer echoes. Read at the
 * time of the request that is the same set of rows to the millisecond, and it is what makes the
 * echoed window true rather than approximately true — a row written while the nine statements run
 * one after another is in all of them or none. (Current state — live Bots, connections, per-person
 * caps — has no window and is read as it stands, as it is there.)
 */
export function insightStatements(options: {
  since: Date;
  to: Date;
  timeZone: string;
}): Record<InsightSection, SQL> {
  const { since, to, timeZone } = options;
  const patterns = listOf(WORK_PATTERN_IDS);
  const connectors = listOf(CATALOGUE.map((entry) => entry.key));
  const siteIds = listOf(BUSINESS_SITES.map((site) => site.id));

  const onboarding = sql`
    SELECT jsonb_build_object(
      'botsLive', (SELECT count(*) FROM agent_profiles WHERE deleted_at IS NULL AND owner_user_id IS NOT NULL),
      'botsCreated', (SELECT count(*) FROM agent_profiles WHERE owner_user_id IS NOT NULL AND created_at >= ${since} AND created_at < ${to}),
      'fromPreset', coalesce((
        SELECT jsonb_object_agg(preset_id, n)
          FROM (SELECT preset_id, count(*) AS n
                  FROM agent_profiles
                 WHERE owner_user_id IS NOT NULL AND created_at >= ${since} AND created_at < ${to} AND preset_id ~ ${CATALOGUE_KEY_SOURCE}
                 GROUP BY preset_id) keyed
      ), '{}'::jsonb),
      'firstTaskPresses', (SELECT count(*) FROM audit_events
                            WHERE event_type = 'onboarding.first_task_pressed' AND created_at >= ${since} AND created_at < ${to}),
      'botsWithFirstTask', (SELECT count(DISTINCT target_id) FROM audit_events
                             WHERE event_type = 'onboarding.first_task_pressed' AND created_at >= ${since} AND created_at < ${to}),
      'firstTasks', coalesce((
        SELECT jsonb_agg(jsonb_build_array(kind, pattern, via_kind, via_id, hint, n)
                         ORDER BY n DESC, kind, pattern, via_kind, via_id, hint)
          FROM (SELECT CASE WHEN payload->>'kind' IN ('ask', 'routine', 'connect') THEN payload->>'kind' ELSE 'other' END AS kind,
                       CASE WHEN payload->>'pattern' IS NULL THEN NULL
                            WHEN payload->>'pattern' IN (${patterns}) THEN payload->>'pattern' ELSE 'other' END AS pattern,
                       CASE WHEN jsonb_typeof(payload->'via') <> 'object' OR payload->'via' IS NULL THEN NULL
                            WHEN payload->'via'->>'kind' IN ('site', 'account') THEN payload->'via'->>'kind' ELSE 'other' END AS via_kind,
                       CASE WHEN jsonb_typeof(payload->'via') <> 'object' OR payload->'via' IS NULL THEN NULL
                            WHEN payload->'via'->>'kind' = 'site' AND payload->'via'->>'id' IN (${siteIds}) THEN payload->'via'->>'id'
                            WHEN payload->'via'->>'kind' = 'account' AND payload->'via'->>'id' IN (${connectors}) THEN payload->'via'->>'id'
                            ELSE 'other' END AS via_id,
                       CASE WHEN payload->>'hint' IS NULL THEN NULL
                            WHEN payload->>'hint' IN (${patterns}) THEN payload->>'hint' ELSE 'other' END AS hint,
                       count(*) AS n
                  FROM audit_events
                 WHERE event_type = 'onboarding.first_task_pressed' AND created_at >= ${since} AND created_at < ${to}
                 GROUP BY 1, 2, 3, 4, 5) pressed
      ), '[]'::jsonb)
    )::text AS value`;

  const routines = sql`
    SELECT (jsonb_build_object(
      'live', (SELECT count(*) FROM laf_routines WHERE enabled),
      'created', (SELECT count(*) FROM laf_routines WHERE created_at >= ${since} AND created_at < ${to}),
      'fromSuggestion', coalesce((
        SELECT jsonb_object_agg(suggestion_key, n)
          FROM (SELECT suggestion_key, count(*) AS n
                  FROM laf_routines
                 WHERE created_at >= ${since} AND created_at < ${to} AND suggestion_key ~ ${CATALOGUE_KEY_SOURCE}
                 GROUP BY suggestion_key) keyed
      ), '{}'::jsonb)
    ) || (
      SELECT jsonb_build_object(
        'runs', count(*),
        'ok', count(*) FILTER (WHERE payload->>'ok' = 'true'),
        'silent', count(*) FILTER (WHERE payload->>'ok' = 'true' AND payload->>'silent' = 'true'),
        'failed', count(*) FILTER (WHERE payload->>'ok' = 'false')
      )
        FROM audit_events
       WHERE event_type = 'routine.ran' AND created_at >= ${since} AND created_at < ${to}
    ))::text AS value`;

  // CASE, not AND: SQL promises no evaluation order inside a WHERE or a FILTER, and
  // jsonb_array_length on a scalar raises instead of answering.
  const limits = sql`
    SELECT ((
      SELECT jsonb_build_object('botsPerPersonMax', coalesce(max(n), 0),
                                'peopleAtBotCap', count(*) FILTER (WHERE n >= ${MAX_BOTS_PER_COMPUTER}::int))
        FROM (SELECT count(*) AS n FROM agent_profiles
               WHERE deleted_at IS NULL AND owner_user_id IS NOT NULL
               GROUP BY owner_user_id) bots
    ) || (
      SELECT jsonb_build_object('routinesPerPersonMax', coalesce(max(n), 0),
                                'peopleAtRoutineCap', count(*) FILTER (WHERE n >= ${MAX_ROUTINES}::int))
        FROM (SELECT count(*) AS n FROM laf_routines
               WHERE created_by_id IS NOT NULL
               GROUP BY created_by_id) authored
    ) || (
      SELECT jsonb_build_object(
        'routineRuns', count(*),
        'runsAtStepCap', count(*) FILTER (WHERE (CASE WHEN jsonb_typeof(steps) = 'array' THEN jsonb_array_length(steps) ELSE 0 END) >= ${STEPS_WHEN_BUDGET_MET}::int),
        'runsAtTimeCap', count(*) FILTER (WHERE finished_at IS NOT NULL
                                            AND finished_at - started_at >= make_interval(secs => ${ROUTINE_RUN_TIMEOUT_SECONDS}::double precision))
      )
        FROM laf_routine_runs
       WHERE started_at >= ${since} AND started_at < ${to}
    ))::text AS value`;

  /*
   * The product's own pairing (`notifications/approval-metrics.ts` readApprovalPairs), then GROUPED:
   * how many questions were asked in each local hour and answered in exactly this many whole
   * seconds. A count per value keeps the nearest-rank median exact across the fleet, which per-VM
   * medians cannot give. "Night" is the deployment's clock, `BOT_TIME_ZONE`, echoed in the window.
   */
  const approvals = sql`
    WITH pairs AS (
      SELECT r.created_at AS asked, min(d.created_at) AS decided
        FROM audit_events r
        LEFT JOIN audit_events d
          ON d.event_type IN ('approval.granted', 'approval.denied')
         AND d.payload->>'approval' = r.payload->>'approval'
         AND d.created_at >= r.created_at
       WHERE r.event_type = 'approval.requested'
         AND r.created_at >= ${since} AND r.created_at < ${to}
         AND r.payload->>'approval' IS NOT NULL
       GROUP BY r.id, r.created_at
    ), timed AS (
      SELECT extract(hour FROM asked AT TIME ZONE ${timeZone}::text)::int AS hour,
             CASE WHEN decided IS NULL THEN NULL
                  ELSE round(greatest(0, extract(epoch FROM (decided - asked))))::bigint END AS seconds
        FROM pairs
    )
    SELECT coalesce((
      SELECT jsonb_agg(jsonb_build_array(hour, seconds, n) ORDER BY hour, seconds)
        FROM (SELECT hour, seconds, count(*) AS n FROM timed GROUP BY hour, seconds) grouped
    ), '[]'::jsonb)::text AS value`;

  /*
   * Current state only — the product keeps no history of a login lapsing yet. The span is from the
   * first sign-in to the last sighting still signed in: for a row behind the wall, how long it was
   * PROVEN to last (a lower bound — `connected_at` is never rewritten, so a re-login stretches it).
   */
  const sites = sql`
    SELECT coalesce((
      SELECT jsonb_agg(jsonb_build_array(site_id, needs_login, days, n) ORDER BY site_id, needs_login, days)
        FROM (SELECT site_id, needs_login,
                     greatest(0, floor(extract(epoch FROM (last_seen_at - connected_at)) / 86400))::int AS days,
                     count(*) AS n
                FROM laf_site_connections
               WHERE site_id ~ ${CATALOGUE_KEY_SOURCE}
               GROUP BY 1, 2, 3) spans
    ), '[]'::jsonb)::text AS value`;

  // needs_reconnect exactly as the product decides it (plugins/connection-health.ts needsReconnect):
  // revoked or refresh_failed. vendor_down is the vendor's outage, not the person's to fix.
  const accounts = sql`
    SELECT coalesce((
      SELECT jsonb_agg(jsonb_build_array(server, needs_reconnect, days, n) ORDER BY server, needs_reconnect, days)
        FROM (SELECT CASE WHEN server_id IN (${connectors}) THEN server_id ELSE 'custom' END AS server,
                     coalesce(last_failure_code IN ('revoked', 'refresh_failed'), false) AS needs_reconnect,
                     CASE WHEN last_failure_code IN ('revoked', 'refresh_failed') AND last_failure_at IS NOT NULL
                          THEN greatest(0, floor(extract(epoch FROM (last_failure_at - connected_at)) / 86400))::int
                          ELSE NULL END AS days,
                     count(*) AS n
                FROM mcp_user_credentials
               GROUP BY 1, 2, 3) held
    ), '[]'::jsonb)::text AS value`;

  /*
   * Where Bots got stuck, as (source, code, tool, site). Routine failures come from `routine.ran`,
   * whose code the product already classified, so the ledger's routine rows are left out of `turn`
   * — the same failure must not be counted twice.
   */
  const failures = sql`
    WITH hosts(ord, site, host) AS (VALUES ${hostsValues()}),
    signals AS (
      SELECT 'computer' AS source,
             CASE WHEN event_type = 'computer.action_failed' THEN
                    CASE WHEN payload->>'failure' ~ ${WHOLE_CODE} THEN payload->>'failure'
                         WHEN payload->>'failure' LIKE 'database error%' THEN 'database_error'
                         ELSE 'uncoded' END
                  WHEN event_type = 'computer.action_repeated' THEN 'laf:action_repeated'
                  ELSE 'laf:element_not_in_snapshot' END AS code,
             CASE WHEN payload->>'action' ~ '^[a-z][a-z0-9_]{0,47}$' THEN payload->>'action' ELSE 'other' END AS tool,
             lower(substring(payload->>'page' from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)')) AS host
        FROM audit_events
       WHERE created_at >= ${since} AND created_at < ${to}
         AND (event_type IN ('computer.action_failed', 'computer.action_repeated')
              OR (event_type = 'computer.action_allowed' AND payload->>'element' = 'laf:element_not_in_snapshot'))
      UNION ALL
      SELECT 'connector',
             CASE WHEN payload->>'failure' ~ ${WHOLE_CODE} THEN payload->>'failure' ELSE 'vendor_error' END,
             CASE WHEN payload->>'server' IN (${connectors}) AND payload->>'tool' ~ '^[a-z][a-z0-9_]{0,63}$'
                    THEN (payload->>'server') || '.' || (payload->>'tool')
                  WHEN payload->>'server' IN (${connectors}) THEN payload->>'server'
                  ELSE 'custom' END,
             NULL
        FROM audit_events
       WHERE event_type = 'mcp.call_failed' AND created_at >= ${since} AND created_at < ${to}
      UNION ALL
      SELECT 'routine',
             CASE WHEN payload->>'failure' ~ ${WHOLE_CODE} THEN payload->>'failure' ELSE 'uncoded' END,
             'routine', NULL
        FROM audit_events
       WHERE event_type = 'routine.ran' AND payload->>'ok' = 'false' AND created_at >= ${since} AND created_at < ${to}
      UNION ALL
      SELECT 'stream', 'laf:agent_stalled', 'stream', NULL
        FROM audit_events
       WHERE event_type = 'agent.stream_stalled' AND created_at >= ${since} AND created_at < ${to}
      UNION ALL
      SELECT 'turn',
             coalesce(substring(error from ${CODE_SOURCE}::text),
                      CASE WHEN status = 'unknown' THEN 'laf:turn_interrupted' ELSE 'uncoded' END),
             origin::text, NULL
        FROM laf_thread_runs
       WHERE status IN ('error', 'unknown') AND origin <> 'routine' AND started_at >= ${since} AND started_at < ${to}
    ),
    placed AS (
      SELECT source, code, tool,
             CASE WHEN host IS NULL OR host = '' THEN NULL
                  ELSE coalesce((SELECT h.site FROM hosts h
                                  WHERE signals.host = h.host OR right(signals.host, length(h.host) + 1) = '.' || h.host
                                  ORDER BY h.ord LIMIT 1), 'other') END AS site
        FROM signals
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM placed),
      'top', coalesce((
        SELECT jsonb_agg(jsonb_build_array(source, code, tool, site, n) ORDER BY n DESC, source, code, tool, site)
          FROM (SELECT source, code, tool, site, count(*) AS n
                  FROM placed
                 GROUP BY 1, 2, 3, 4
                 ORDER BY n DESC, 1, 2, 3, 4
                 LIMIT ${MAX_FAILURE_SIGNATURES}::int) grouped
      ), '[]'::jsonb)
    )::text AS value`;

  const support = sql`
    SELECT jsonb_build_object(
      'feedback', count(*) FILTER (WHERE event_type = 'support.feedback_sent'),
      'withScreen', count(*) FILTER (WHERE event_type = 'support.feedback_sent' AND payload->>'withScreen' = 'true'),
      'helpOpened', count(*) FILTER (WHERE event_type = 'support.help_opened'),
      'helpReaders', count(DISTINCT actor_user_id) FILTER (WHERE event_type = 'support.help_opened'),
      'helpSections', coalesce((
        SELECT jsonb_object_agg(section, n)
          FROM (SELECT payload->>'section' AS section, count(*) AS n
                  FROM audit_events
                 WHERE event_type = 'support.help_opened' AND created_at >= ${since} AND created_at < ${to}
                   AND payload->>'section' ~ ${CATALOGUE_KEY_SOURCE}
                 GROUP BY 1) named
      ), '{}'::jsonb)
    )::text AS value
      FROM audit_events
     WHERE event_type IN ('support.feedback_sent', 'support.help_opened') AND created_at >= ${since} AND created_at < ${to}`;

  /*
   * Turns are runs STARTED in the window; tokens are `model.usage` rows WRITTEN in it, attributed to
   * a person through the run they belong to (whenever it started). Usage with no run behind it —
   * the server's own calls, the auto-review judge — is nobody's and is counted as `server`.
   */
  const people = sql`
    WITH usage AS (
      SELECT payload->>'runId' AS run_id,
             sum(CASE WHEN payload->>'totalTokens' ~ '^[0-9]{1,15}$' THEN (payload->>'totalTokens')::bigint ELSE 0 END) AS tokens
        FROM audit_events
       WHERE event_type = 'model.usage' AND created_at >= ${since} AND created_at < ${to}
       GROUP BY 1
    ), attributed AS (
      SELECT r.user_id, sum(u.tokens) AS tokens
        FROM usage u JOIN laf_thread_runs r ON r.run_id = u.run_id
       WHERE r.user_id IS NOT NULL
       GROUP BY r.user_id
    ), turns AS (
      SELECT user_id, count(*) AS turns
        FROM laf_thread_runs
       WHERE started_at >= ${since} AND started_at < ${to} AND user_id IS NOT NULL
       GROUP BY user_id
    ), per_person AS (
      SELECT coalesce(t.turns, 0) AS turns, coalesce(a.tokens, 0) AS tokens
        FROM turns t FULL JOIN attributed a ON a.user_id = t.user_id
    )
    SELECT jsonb_build_object(
      'accounts', (SELECT count(*) FROM users),
      'perPerson', coalesce((
        SELECT jsonb_agg(jsonb_build_array(turns, tokens) ORDER BY tokens DESC, turns DESC)
          FROM (SELECT turns, tokens FROM per_person ORDER BY tokens DESC, turns DESC LIMIT ${MAX_PEOPLE_ROWS}::int) ranked
      ), '[]'::jsonb),
      'turnsByOrigin', coalesce((
        SELECT jsonb_object_agg(origin, n)
          FROM (SELECT origin::text AS origin, count(*) AS n FROM laf_thread_runs
                 WHERE started_at >= ${since} AND started_at < ${to} GROUP BY 1) by_origin
      ), '{}'::jsonb),
      'tokensByOrigin', coalesce((
        SELECT jsonb_object_agg(origin, n)
          FROM (SELECT coalesce(r.origin::text, 'server') AS origin, sum(u.tokens) AS n
                  FROM usage u LEFT JOIN laf_thread_runs r ON r.run_id = u.run_id
                 GROUP BY 1) by_origin
      ), '{}'::jsonb)
    )::text AS value`;

  return {
    onboarding,
    routines,
    limits,
    approvals,
    sites,
    accounts,
    failures,
    support,
    people,
  };
}

/**
 * One section, in a transaction that cannot write and cannot run long enough to be felt by the
 * person using this VM. A failure is logged as a section and a database code — never the statement
 * or its parameters — and reads as null.
 */
async function readSection(
  database: Database,
  section: InsightSection,
  statement: SQL,
): Promise<unknown> {
  try {
    const rows = await database.transaction(
      async (transaction) => {
        await transaction.execute(
          sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`),
        );
        return transaction.execute<{ value: string | null }>(statement);
      },
      { accessMode: "read only" },
    );
    const value = [...rows][0]?.value;
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch (error) {
    log.warn("insights_section_unread", {
      section,
      reason: describeFailure(error),
    });
    return null;
  }
}

/**
 * Each section through its own statement, null where one could not answer.
 *
 * One after another rather than at once: nine concurrent statements would take nine of the pool's
 * connections from the person using the VM for the length of a fleet read nobody is waiting on.
 * Exported so a test can hand it a statement that fails and see the other eight still answer.
 */
export async function readInsightSections(
  database: Database,
  statements: Record<InsightSection, SQL>,
): Promise<Omit<InsightsReport, "window">> {
  const read: Record<string, unknown> = {};
  for (const section of INSIGHT_SECTIONS) {
    read[section] = await readSection(database, section, statements[section]);
  }
  return read as Omit<InsightsReport, "window">;
}

/** The nine sections over the `days` days that end now, and the window they were read over. */
export async function readInsights(
  database: Database,
  options: { days: number; timeZone: string; now?: () => Date },
): Promise<InsightsReport> {
  const to = options.now?.() ?? new Date();
  const since = new Date(to.getTime() - options.days * 86_400_000);
  const sections = await readInsightSections(
    database,
    insightStatements({ since, to, timeZone: options.timeZone }),
  );
  return {
    window: {
      days: options.days,
      from: since.toISOString(),
      to: to.toISOString(),
      nightTimeZone: options.timeZone,
    },
    ...sections,
  };
}
