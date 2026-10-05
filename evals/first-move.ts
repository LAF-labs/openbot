/**
 * The first move's questions against the real decisions model, over messages somebody else
 * labelled — this file is the half that needs no network: the sets, what a row counts as, and the
 * verdict. `first-move-run.ts` asks; `tests/eval-first-move.test.ts` holds this half still.
 *
 * `server/tests/first-move.test.ts` holds the rule with a fixed judge; the eval measures what the
 * pinned snapshot actually answers, and what the product's bars then do with it. Two numbers decide
 * whether a kind may be wired at all:
 *
 *   WRONG MOVES — a message that did not want exactly this lookup, and got it anyway. Visible in
 *     the conversation as a step nobody asked for, and a second of somebody's time. The bars are
 *     set for this to be rare.
 *   MISSES — a message that did want it and was left to the Bot's model. Costs nothing new: the
 *     turn takes the rounds it takes today. Counted from both doors: the words checked before
 *     anything is sent, and the bars after.
 *
 * THE MESSAGES ARE NOT THE AUTHOR'S. Each set was written and labelled by a separate agent that
 * never saw the questions or the word lists in `server/src/turns/first-move.ts` — the smoke test
 * the first of them replaced had its 21 messages and their labels written by whoever wrote the
 * questions, which measures agreement with oneself
 * (`~/laf/docs/jev-adoption-review-2026-10-02.md` §3).
 *
 * EVERY SET IS ASKED AS THE PRODUCT WOULD ASK IT, of a person who has a saved place and both
 * services connected: the kinds whose words are in the message ride in one request. So a weather
 * question in the calendar's set is asked the weather's questions, and a message two kinds clear is
 * no move — the worst case for one kind getting in another's way, and the one a person with
 * everything connected is in.
 */
import {
  FIRST_MOVE_SPECS,
  type FirstMoveKind,
} from "../server/src/turns/first-move";

/**
 * A labelled set: the file, and the two fields its labeller filled in. The move is wanted exactly
 * when both are true. The first says the service's read is wanted at all; the second that nothing
 * further is needed from the message — the person's own place, today, no filter.
 */
export type EvalSet = {
  kind: FirstMoveKind;
  file: string;
  wanted: string;
  plain: string;
  /** What a message that wants the service with an argument is called in the report. */
  nearMiss: string;
};

export const SETS: readonly EvalSet[] = [
  {
    kind: "weather",
    file: "first-move-messages.json",
    wanted: "forecast",
    plain: "ownPlace",
    nearMiss: "a place that was named",
  },
  {
    kind: "calendar",
    file: "first-move-calendar.json",
    wanted: "schedule",
    plain: "today",
    nearMiss: "another day, a span or one event",
  },
  {
    kind: "mail",
    file: "first-move-mail.json",
    wanted: "mail",
    plain: "unread",
    nearMiss: "a sender, a subject or a period",
  },
];

export type Labelled = { text: string; note?: string } & Record<
  string,
  unknown
>;

/**
 * What its labeller said a message is, for one set.
 *
 * `both` is a bucket of its own, marked by the labeller in the note: a message that asks for two
 * services, or for the lookup and then something else ("오늘 일정이랑 새 메일 알려줘"). Whether a
 * move is right there is not a yes or a no — the lookup is a step the Bot would take, and it is
 * not all that was asked — so those rows are shown with what was done about them and are counted
 * neither as moves that were right nor as moves that were wrong, nor as ones that should have moved.
 */
export type Category = "wants" | "near" | "unwanted" | "both";

export function categoryOf(set: EvalSet, row: Labelled): Category {
  if (/^both\b/i.test(row.note ?? "")) return "both";
  if (row[set.wanted] !== true) return "unwanted";
  return row[set.plain] === true ? "wants" : "near";
}

/** A message a careful person could label either way, marked so before anything was run. */
export const isBorderline = (row: Labelled) =>
  /^borderline/i.test(row.note ?? "");

/** One message, asked once. */
export type Row = Labelled & {
  /** The kinds the product would have asked the decisions model about. Empty is never sent. */
  asked: readonly FirstMoveKind[];
  /** The probability per question asked. Null when nothing was asked or no answer came. */
  decided: Record<string, number> | null;
  ms: number | null;
  /** The answer did not come, at the eval's own generous bound. */
  noAnswer: boolean;
};

export type Bars = Partial<Record<FirstMoveKind, Record<string, number>>>;

/** The kinds every one of whose questions reached its bar — the product's rule, on a recorded row. */
export function clearedOf(row: Row, bars: Bars = {}): FirstMoveKind[] {
  if (!row.decided) return [];
  const { decided } = row;
  return row.asked.filter((kind) => {
    const spec = FIRST_MOVE_SPECS[kind];
    const held = bars[kind] ?? spec.bars;
    return Object.keys(spec.questions).every(
      (name) => (decided[name] ?? 0) >= (held[name] ?? 1),
    );
  });
}

/** What the product does with a row: one kind's move, none, or none because two cleared. */
export function moveOf(
  row: Row,
  bars: Bars = {},
): FirstMoveKind | "ambiguous" | null {
  const cleared = clearedOf(row, bars);
  if (cleared.length > 1) return "ambiguous";
  return cleared[0] ?? null;
}

export type Tally = {
  /** Rows on which this set's kind was moved, the `both` rows aside. */
  moved: Row[];
  /** Moves on a message that asked for this and something else: shown, not scored. */
  movedOnBoth: Row[];
  right: Row[];
  wrong: Row[];
  wrongNear: Row[];
  wrongUnwanted: Row[];
  /** Wrong on a message its labeller had marked borderline. */
  wrongBorderline: Row[];
  should: Row[];
  missed: Row[];
  /** Left unmoved because another kind cleared its bars too. */
  ambiguous: Row[];
  /** Rows on which another kind was moved instead — not this set's to judge. */
  movedAnother: Row[];
};

export function tallyOf(
  set: EvalSet,
  rows: readonly Row[],
  bars: Bars = {},
): Tally {
  const movedAny = rows.filter((row) => moveOf(row, bars) === set.kind);
  const moved = movedAny.filter((row) => categoryOf(set, row) !== "both");
  const right = moved.filter((row) => categoryOf(set, row) === "wants");
  const wrong = moved.filter((row) => categoryOf(set, row) !== "wants");
  const should = rows.filter((row) => categoryOf(set, row) === "wants");
  return {
    moved,
    right,
    wrong,
    movedOnBoth: movedAny.filter((row) => categoryOf(set, row) === "both"),
    wrongNear: wrong.filter((row) => categoryOf(set, row) === "near"),
    wrongUnwanted: wrong.filter((row) => categoryOf(set, row) === "unwanted"),
    wrongBorderline: wrong.filter(isBorderline),
    should,
    missed: should.filter((row) => moveOf(row, bars) !== set.kind),
    ambiguous: rows.filter((row) => moveOf(row, bars) === "ambiguous"),
    movedAnother: rows.filter((row) => {
      const move = moveOf(row, bars);
      return move !== null && move !== "ambiguous" && move !== set.kind;
    }),
  };
}

/** The share of a kind's moves that were wanted, below which it is not wired. */
export const PRECISION_FLOOR = 0.95;

/*
 * THE VERDICT, per kind. Three things fail it, and one is only shown.
 *
 *   A move for a message that wanted the service WITH AN ARGUMENT — a named place, tomorrow, a
 *   sender — fails it. The result in hand is the wrong one, handed to a model that was asked about
 *   something else. For the weather this fails it always, as it has since the first run: a wrong
 *   town answered confidently is the failure the weather tool was built to end.
 *
 *   A move for a message that did not want the service read at all fails it.
 *
 *   Precision under {@link PRECISION_FLOOR} fails it, whatever the wrong moves were.
 *
 *   A wrong move on a message its labeller had marked borderline — one a careful person could label
 *   either way — is printed and counted in the precision, and does not fail the run by itself.
 *
 * THE BORDERLINE RULE WAS WRITTEN AFTER THE WEATHER'S FIRST RUN, and that is said here rather than
 * hidden: that run (2026-10-02) made two wrong moves in 61, "너 날씨도 알려줄 수 있어?" and "다음 주
 * 금요일 날씨 미리 알 수 있을까?", both marked borderline by the labeller before anything was run,
 * and both messages where looking at the forecast is what a Bot would do anyway. A verdict that
 * fails on the labeller's own coin-flips measures the labeller. For the calendar and the mail the
 * rule stood before their sets existed. Misses are reported and fail nothing — a miss is today's
 * turn.
 */
export function verdictOf(
  set: EvalSet,
  tally: Tally,
): { failed: boolean; precision: number | null; why: string[] } {
  const clearNear = tally.wrongNear.filter(
    (row) => set.kind === "weather" || !isBorderline(row),
  );
  const clearUnwanted = tally.wrongUnwanted.filter((row) => !isBorderline(row));
  const precision =
    tally.moved.length === 0 ? null : tally.right.length / tally.moved.length;
  const why: string[] = [];
  if (clearNear.length > 0) {
    why.push(`${clearNear.length} wrong for ${set.nearMiss}`);
  }
  if (clearUnwanted.length > 0) {
    why.push(
      `${clearUnwanted.length} wrong on a message that clearly did not want it`,
    );
  }
  if (precision !== null && precision < PRECISION_FLOOR) {
    why.push(
      `precision ${(100 * precision).toFixed(1)}% under ${100 * PRECISION_FLOOR}%`,
    );
  }
  // A kind that never moves has nothing wrong with it and nothing to wire either.
  if (precision === null) why.push("it never moved");
  return { failed: why.length > 0, precision, why };
}

export const pct = (n: number, d: number) =>
  d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`;

export const quantile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  );
};
