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
  /** Bots created in the window from a preset, by the preset's catalogue key. */
  fromPreset: Record<string, number>;
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
};
