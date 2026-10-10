/**
 * What a free trial may spend in a day, and the judge that says whether today's is spent.
 *
 * THE COUNT IS THE ONE THE PRODUCT ALREADY KEEPS. Every model call this deployment makes lands as a
 * `model.usage` row in `audit_events` — a Bot's turn on any path (`copilot.ts`), the auto-review
 * judge and the server's other calls (`server-model-calls.ts`) — and nothing else sees the
 * provider's counts. So a day is those rows' `totalTokens`, summed, over the Seoul day `now` falls
 * in (self-serve contract §4.6, §10), read through `audit_events_type_created_at_idx`, which
 * migration 0026 already built for exactly this shape of question.
 *
 * SEOUL'S DAY, NOT THE HOST'S AND NOT `BOT_TIME_ZONE`'S. The sentence a refused person reads says
 * the allowance opens again "at midnight, Korean time", and the fleet ends a trial at 23:59:59 in
 * Seoul. A budget that reset on a VM's UTC midnight would reopen at nine in the morning, which is not
 * what anybody was told.
 *
 * JUDGED WHEN A RUN STARTS, AND ONLY THEN. A run already streaming is not stopped part-way: an answer
 * cut off at a token count is worse than one that goes a little over, and the trail does not know a
 * run's cost until the run reports it. So a day can overrun by what the runs in flight at the moment
 * it filled go on to spend — each bounded by agent-bot's per-question bounds (`MAX_QUESTION_STEPS`,
 * `MAX_QUESTION_COST_USD`). That ceiling is written down in docs/laf/data-lifecycle.md, as the
 * contract asks.
 *
 * IN DOLLARS WHERE THE TRIAL SAYS SO, IN TOKENS WHERE IT DOES NOT (2026-10-10, record §4, piece
 * 6-1). A token is not a price: measured on a development deployment over two weeks, 11.9 million
 * tokens of the Bot's turns on Muse Spark cost $0.31 and 0.22 million on DeepSeek cost $0.04 — six
 * and a half times as much per token — and the main conversation is about to hand work to
 * sub-agents on other models. Summed as tokens, a day on a dear model spends several times what
 * the day was meant to allow and a day on a cheap one is refused with most of it unspent. So a
 * trial may name its day in dollars (`LAF_DAILY_BUDGET_USD`), and then the judge sums what each
 * call COST — the provider's own figure on the row (`costUsd`). A trial that names only tokens is
 * judged exactly as it always was: the fleet writes the lines, and every live trial has four.
 *
 * A ROW WITH NO PRICE IS NOT FREE. A call whose provider did not say what it cost — an endpoint
 * that is not OpenRouter, or a row from before `askModel` read the figure — counts its tokens at
 * {@link UNPRICED_USD_PER_MILLION_TOKENS}. Free is the expensive reading, found on an invoice; and
 * the rate is the dearest the day was planned against, so on an endpoint that never reports a cost
 * a money budget is a token budget at that rate, and never no budget.
 *
 * A TRAIL THAT CANNOT BE READ IS NOT A REFUSAL. "Today's allowance is used up" is a sentence only a
 * count may say; saying it because a read failed would tell somebody a false thing about their own
 * use. The run goes ahead, the failure is logged, and the provider key's own daily limit is the
 * hard ceiling behind this one (contract A9).
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { AgentFetch } from "../channels/stall-guard";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { auditEvents } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";

/** The fact a refused run ends on, and a refused server call throws. The surface owns the words. */
export const DAILY_BUDGET_REACHED = "laf:daily_budget_reached";

/** The zone a trial's day is counted in. Not configurable: the sentence and the fleet both name it. */
export const BUDGET_TIME_ZONE = "Asia/Seoul";

const DAY_MS = 86_400_000;

const seoulDate = new Intl.DateTimeFormat("en-US", {
  timeZone: BUDGET_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

/**
 * The Seoul day `now` falls in, as the instants it starts and ends at: `[start, end)`.
 *
 * The zone's offset is read at `now` rather than written in as nine hours, so the arithmetic is the
 * zone database's and not a constant somebody has to trust. Seoul has kept no summer time since
 * 1988, which is what makes a day exactly twenty-four hours long here.
 */
export function seoulDayOf(now: Date): { start: Date; end: Date } {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(
      seoulDate.formatToParts(now).find((piece) => piece.type === type)?.value,
    );
  const wallClock = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  // What Seoul's wall clock reads, minus what time it actually is: the zone's offset, to the second.
  const offset = wallClock - Math.floor(now.getTime() / 1000) * 1000;
  const start = Date.UTC(part("year"), part("month") - 1, part("day")) - offset;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

/**
 * What a call with no price on its row is counted at, in dollars per million tokens: the dearest
 * rate the trial's day was planned against (self-serve contract, appendix B — a day that is all
 * output). Several times what the Bot's turns measured, on purpose: see "A ROW WITH NO PRICE".
 */
export const UNPRICED_USD_PER_MILLION_TOKENS = 0.5;

export type DailyBudget = {
  /** What a Seoul day may spend, in tokens, as `.env` said. */
  readonly tokens: number;
  /** What it may spend in dollars, where `.env` said — and then THIS is what the day is judged on. */
  readonly usd?: number;
  /** What today has spent so far, in tokens. Throws when the trail cannot be read. */
  usedToday: () => Promise<number>;
  /** What today has cost so far, in dollars. Throws when the trail cannot be read. */
  costToday: () => Promise<number>;
  /**
   * Whether today's count has reached the budget. Never throws: a trail that cannot be read is not
   * a refusal (see the note at the top).
   */
  reachedToday: () => Promise<boolean>;
};

export function createDailyBudget(input: {
  database: Database;
  tokens: number;
  usd?: number;
  now?: () => Date;
}): DailyBudget {
  const now = input.now ?? (() => new Date());

  /** The day's rows, summed both ways in one read: the count, and what it cost. */
  const today = async (): Promise<{ tokens: number; usd: number }> => {
    const { start, end } = seoulDayOf(now());
    const tokens = sql`case when ${auditEvents.payload} ->> 'totalTokens' ~ '^[0-9]{1,15}$' then (${auditEvents.payload} ->> 'totalTokens')::bigint else 0 end`;
    /*
     * A count that crossed a service boundary is not trusted to be a number: anything that is not
     * digits reads as nothing, the same rule the fleet's read sums these rows by (laf-control
     * `core/insights-sql.ts`), so a malformed row can neither fail the read nor subtract from the
     * day.
     */
    const [row] = await input.database
      .select({
        used: sql<string>`coalesce(sum(${tokens}), 0)::text`,
        /*
         * The provider's figure where the row has one — in the shape the fleet's read takes it
         * (laf-control `core/insights-sql.ts`): a plain decimal, which is what jsonb hands back
         * for any number, `1.2e-7` included. Otherwise the row's tokens at the unpriced rate.
         */
        cost: sql<string>`coalesce(sum(case when ${auditEvents.payload} ->> 'costUsd' ~ '^[0-9]{1,6}([.][0-9]{1,20})?$' then (${auditEvents.payload} ->> 'costUsd')::numeric else ${tokens} * ${UNPRICED_USD_PER_MILLION_TOKENS}::numeric / 1000000 end), 0)::text`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "model.usage"),
          gte(auditEvents.createdAt, start),
          lt(auditEvents.createdAt, end),
        ),
      );
    return { tokens: Number(row?.used ?? 0), usd: Number(row?.cost ?? 0) };
  };
  const usedToday = async () => (await today()).tokens;
  const costToday = async () => (await today()).usd;

  return {
    tokens: input.tokens,
    ...(input.usd === undefined ? {} : { usd: input.usd }),
    usedToday,
    costToday,
    reachedToday: async () => {
      try {
        // One or the other, never both: a trial that names dollars is judged on dollars alone.
        return input.usd === undefined
          ? (await usedToday()) >= input.tokens
          : (await costToday()) >= input.usd;
      } catch (error) {
        log.warn("daily_budget_unread", {
          reason: describeFailure(error),
          note: "Today's model usage could not be read, so nothing was refused on account of it.",
        });
        return false;
      }
    },
  };
}

/**
 * The judge a deployment is given: one for a trial, and none at all for anything else.
 *
 * None rather than one with an infinite budget, so a deployment that is not a trial asks the
 * database nothing on behalf of a limit it does not have, and a surface that reads "is there a
 * budget" cannot draw one that is not there.
 */
export function dailyBudgetFor(
  trial: DeploymentConfig["trial"],
  database: Database,
): DailyBudget | undefined {
  return trial
    ? createDailyBudget({
        database,
        tokens: trial.dailyTokenBudget,
        ...(trial.dailyBudgetUsd === undefined
          ? {}
          : { usd: trial.dailyBudgetUsd }),
      })
    : undefined;
}

const ENCODER = new TextEncoder();

/**
 * The one event a refused run gets, as a server-sent event, in place of the endpoint's stream.
 *
 * The same framing and the same event the stall guard ends a silent run with (`channels/stall-guard.ts`),
 * so nothing downstream had to learn a new one: AG-UI permits RUN_ERROR as a stream's first event,
 * both surfaces and the unattended loop already read it, and the ledger files its message.
 */
function refusedStream(): Response {
  const event = {
    type: "RUN_ERROR",
    message: DAILY_BUDGET_REACHED,
    code: DAILY_BUDGET_REACHED,
  };
  return new Response(ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * A Bot's fetch, with today judged before the request leaves.
 *
 * On a spent day the endpoint is never contacted — nothing is sent to the model and nothing is
 * spent — and the run receives one RUN_ERROR carrying {@link DAILY_BUDGET_REACHED}. Asked per call,
 * which is per run: a day that fills during a conversation refuses the next turn, not the one
 * streaming.
 */
export function withDailyBudget(
  budget: DailyBudget,
  inner: AgentFetch,
): AgentFetch {
  return async (url, requestInit) => {
    if (!(await budget.reachedToday())) return inner(url, requestInit);
    // A person's use, not a fault: said at info, for whoever wonders why a Bot answered nothing.
    log.info(
      "run_refused_daily_budget",
      budget.usd === undefined
        ? { budget: budget.tokens }
        : { usd: budget.usd },
    );
    return refusedStream();
  };
}

/**
 * A server-side model call refused on a spent day, as the refusal the HTTP boundary answers with.
 *
 * The shape `httpRefusalOf` reads (`failure-text.ts`): a `laf:` code and a status, so `app.ts`'s
 * error handler answers `{ code, retryLater }` whichever route let it through. 503 because the
 * refusal statuses a route may answer do not include 429, and `retryLater` because the day ends at
 * midnight: this is "not now", not "never".
 */
export class DailyBudgetReachedError extends Error {
  readonly code = DAILY_BUDGET_REACHED;
  readonly status = 503;
  readonly facts = { retryLater: true };

  constructor() {
    super(DAILY_BUDGET_REACHED);
    this.name = "DailyBudgetReachedError";
  }
}
