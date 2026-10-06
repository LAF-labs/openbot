/**
 * The shape of the `turns` section, apart from the statement that fills it (`turns.ts`).
 *
 * One section of ten until 2026-10-06: this was the shape `GET /api/admin/metrics/insights`
 * answered with, and that door went that day with its reader (`read.ts`) and the other nine
 * sections' shapes — no deployment was ever handed the token that mounted it, and the fleet reads
 * its counts over SSH with its own statements. What is left is what still has a reader: the
 * statement beside it, `scripts/eval-from-failures.ts`, and laf-control, which keeps a copy of the
 * statement and of this shape.
 *
 * Every field name is laf-control's (`core/insights.ts` `VmInsights`, and the statements in
 * `core/insights-sql.ts`), cell for cell: two readers of the same rows that disagree are a fleet
 * that cannot tell which number is true.
 */

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
  /*
   * THE WAIT AS THE PERSON HAS IT (2026-10-05). `firstAnswer` above stops at the model's first
   * output, which may be a tool call and may come long after a first move's step was drawn: it is
   * the wait neither to the first thing on the screen nor to the first word. The three below are
   * read off columns the turn's own meter fills (`telemetry/run-meter.ts`), and they are extra
   * fields inside the section — absent in an answer from a release before them, and ignored by a
   * reader that does not name them, as `people.cache` was while the VM answered with it.
   */
  /**
   * `(tenths of a second, how many)`: a conversation turn's message accepted → the first WORD of
   * its answer going out to the windows, on the run that opened it. Only turns that said one, and
   * not those that asked their person about an action before it — that wait is the person's, not
   * the Bot's (`insights/turns.ts` says exactly which, and what the row cannot tell).
   */
  firstWord?: Array<[number, number]>;
  /**
   * Conversation turns opened in the window: what `firstWord` could have had a cell for. The rest
   * said no word — failed, stopped or still at work — asked their person something first, or were
   * written before this was measured.
   */
  chatTurns?: number;
  /**
   * `kind → (turns the decisions model was asked about it, turns it moved)`, for every kind of
   * first move this build has, zeros included (`shared/first-move.ts`). A turn asked about two
   * kinds counts under both; it moves for one at most.
   */
  firstMoves?: Record<string, [number, number]>;
};
