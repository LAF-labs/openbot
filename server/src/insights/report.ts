/**
 * The shape `GET /api/admin/metrics/insights` answers with, apart from the statements that fill it.
 *
 * Its own module so the route and `app.ts` can name the shape without importing what `read.ts`
 * needs to compute it — the routine runner's constants, the connector catalogue, the database.
 *
 * Every field name is laf-control's (`core/insights.ts` `VmInsights`, and the statements in
 * `core/insights-sql.ts`), cell for cell; see `read.ts` for why that is the whole point.
 */

export const INSIGHT_SECTIONS = [
  "onboarding",
  "routines",
  "limits",
  "approvals",
  "sites",
  "accounts",
  "failures",
  "support",
  "people",
  "turns",
] as const;
export type InsightSection = (typeof INSIGHT_SECTIONS)[number];

/** A year, because the trail is kept for one. */
export const MAX_INSIGHT_DAYS = 365;
/** laf-control's own default window. */
export const DEFAULT_INSIGHT_DAYS = 7;
/** How many failure signatures one VM returns; the rest stay counted in the total. */
export const MAX_FAILURE_SIGNATURES = 50;
/** How many people one VM returns turns and tokens for. A VM is one person and their staff. */
export const MAX_PEOPLE_ROWS = 50;

/** `(hour, seconds or null, how many)`: questions asked in this local hour, answered this fast. */
export type ApprovalCell = [number, number | null, number];
/** `(site or connector, needs a person, proven days or null, how many)`. */
export type SpanCell = [string, boolean, number | null, number];
/** `(source, code, tool, site or null, how many)`. */
export type FailureCell = [string, string, string, string | null, number];
/** `(kind, pattern, via kind, via id, the card's hint, how many)` — catalogue keys, never words. */
export type FirstTaskCell = [
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  number,
];

export type OnboardingInsight = {
  botsLive: number;
  botsCreated: number;
  /*
   * `fromPreset` — Bots made from each ready-made kind of work — was here until migration 0047
   * dropped `agent_profiles.preset_id` (2026-09-24). laf-control never named it, so no reader of
   * this body misses it.
   */
  /** First-task chips pressed in the window. */
  firstTaskPresses: number;
  /** How many Bots those presses were on. */
  botsWithFirstTask: number;
  firstTasks: FirstTaskCell[];
};

export type RoutinesInsight = {
  live: number;
  created: number;
  fromSuggestion: Record<string, number>;
  runs: number;
  ok: number;
  silent: number;
  failed: number;
};

export type LimitsInsight = {
  botsPerPersonMax: number;
  peopleAtBotCap: number;
  routinesPerPersonMax: number;
  peopleAtRoutineCap: number;
  routineRuns: number;
  runsAtStepCap: number;
  runsAtTimeCap: number;
};

export type FailuresInsight = { total: number; top: FailureCell[] };

export type SupportInsight = {
  feedback: number;
  withScreen: number;
  /** Visits to `/help` in the window, one row each. */
  helpOpened: number;
  /** How many people those visits were. */
  helpReaders: number;
  /** The visits whose address named a section, by the section's key. */
  helpSections: Record<string, number>;
  /**
   * Answers whose rating was last set to 좋아요 in the window, one per person per answer.
   *
   * By when it was LAST said, because a rating can be changed: somebody who pressed 아쉬워요 on
   * Monday and 좋아요 on Tuesday has one opinion of that answer, and it is Tuesday's.
   */
  answersUp: number;
  /** The same, for 아쉬워요. */
  answersDown: number;
  /**
   * The 아쉬워요 among those that named a reason from the list, by the reason's key. The rest of
   * `answersDown` named none.
   */
  downReasons: Record<string, number>;
};

export type PeopleInsight = {
  accounts: number;
  /** `(turns, tokens)` for each person who ran or spent anything, heaviest first, no id. */
  perPerson: Array<[number, number]>;
  turnsByOrigin: Record<string, number>;
  tokensByOrigin: Record<string, number>;
  /**
   * The prompt cache, over the Bots' own requests that reported a cache read (`read.ts`). An extra
   * field inside the section, which a reader that does not know it ignores.
   */
  cache?: CacheInsight;
};

export type CacheInsight = {
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  /** `(requests, promptTokens, cachedTokens)` in an established epoch on a warm cache. */
  established: [number, number, number];
  /** Requests flagged as a break: a warm, established request that read under half from cache. */
  lowHitRequests: number;
  costUsd: number;
  /** `(requests, promptTokens, cachedTokens)` per provider, named or `other`. */
  byProvider: Record<string, [number, number, number]>;
};

/** How many unfinished turns one VM lists for eval stubs; the rest stay counted in `endings`. */
export const MAX_UNFINISHED_TURNS = 50;

/**
 * `(local day, origin, code, model requests, tool calls, approvals asked, retries, seconds)` — one
 * turn that ended 못 끝냄, as the skeleton of an eval scenario (`scripts/eval-from-failures.ts`).
 * No id and no word: the day is the deployment's clock's, the code a `laf:` code or `laf:uncoded`.
 */
export type UnfinishedTurnCell = [
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Whether the Bot got the owner's errands done, a turn at a time (P3, 2026-09-26).
 *
 * A TURN is what the owner asked for once, however many runs a browser split it into
 * (`laf_thread_runs.turn_id`); a routine's run and a wake are a turn each. Only turns opened since
 * this was measured are here — older rows have no turn and no ending, and counting them by
 * `status` would call every step a window ran a task of its own.
 *
 * Counts and cells, like the rest of the report: the rate and the percentiles are the reader's to
 * compute, across VMs, from cells that add (`insights/turns.ts` `summariseTurns` does it for one).
 */
export type TurnsInsight = {
  /** Turns that have ended, by how: 끝남, 못 끝냄, 멈춤, 사장님 차례. */
  endings: {
    finished: number;
    unfinished: number;
    stopped: number;
    owner: number;
  };
  /** Turns whose step was still with a window when read. In no ending, and in no rate. */
  inFlight: number;
  /** `origin → (ended turns, finished)`. */
  byOrigin: Record<string, [number, number]>;
  /**
   * `(tenths of a second, how many)`: a conversation turn's accepted → the model's first text or
   * tool call, on the run that opened it. Conversation only; nobody waits on a routine's first word.
   */
  firstAnswer: Array<[number, number]>;
  /** `(asked, granted)` over the ended turns. */
  approvals: [number, number];
  /** Requests the model answered, tool calls it made, and requests the Bot's service sent again. */
  work: { modelRequests: number; toolCalls: number; retries: number };
  /** `(ending, code, origin, how many)` for turns that ended 못 끝냄 or 사장님 차례, most first. */
  reasons: Array<[string, string, string, number]>;
  /**
   * What the ended turns cost as the provider billed them, how many people ran them, and on how
   * many (person, local day) pairs. The Bot's own requests only: the server's calls are no turn's.
   */
  cost: { usd: number; owners: number; ownerDays: number };
  /** `(prompt tokens, of them read from the cache)` over the ended turns. */
  cache: [number, number];
  /** The window's 못 끝냄 turns, newest first, at most {@link MAX_UNFINISHED_TURNS}. */
  unfinished: UnfinishedTurnCell[];
};

/** Each section, or null where its statement could not answer. Null is not zero. */
export type InsightsReport = {
  window: { days: number; from: string; to: string; nightTimeZone: string };
  onboarding: OnboardingInsight | null;
  routines: RoutinesInsight | null;
  limits: LimitsInsight | null;
  approvals: ApprovalCell[] | null;
  sites: SpanCell[] | null;
  accounts: SpanCell[] | null;
  failures: FailuresInsight | null;
  support: SupportInsight | null;
  people: PeopleInsight | null;
  turns: TurnsInsight | null;
};
