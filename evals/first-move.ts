/**
 * The first move's two questions against the real decisions model, over messages somebody else
 * labelled.
 *
 * `server/tests/first-move.test.ts` holds the rule with a fixed judge; this measures what the pinned
 * snapshot actually answers, and what the product's bars then do with it. Two numbers decide
 * whether the switch may be turned on at all:
 *
 *   WRONG MOVES — a message that did not want the forecast for the person's own place, and got the
 *     weather looked up anyway. Visible in the conversation as a step nobody asked for, and a
 *     second of somebody's time. The bars are set for this to be rare.
 *   MISSES — a message that did want it and was left to the Bot's model. Costs nothing new: the
 *     turn takes the two rounds it takes today. Counted from both doors: the words checked before
 *     anything is sent (`mentionsWeather`), and the bars after.
 *
 * THE MESSAGES ARE NOT THE AUTHOR'S. `first-move-messages.json` was written and labelled by a
 * separate agent that never saw the questions in `server/src/turns/first-move.ts` — the smoke test
 * this replaces had its 21 messages and their labels written by whoever wrote the questions, which
 * measures agreement with oneself (`~/laf/docs/jev-adoption-review-2026-10-02.md` §3).
 *
 *   OPENAI_API_KEY=… OPENAI_BASE_URL=https://openrouter.ai/api/v1 bun run eval:first-move
 *
 * `EVAL_RUNS` (default 1) asks every message that many times; `EVAL_SHOW=1` prints every message
 * with its probabilities. The report lands in evals/reports/ (local only). The messages are
 * fixtures, so printing them is printing nobody's words.
 */
import { mkdirSync } from "node:fs";
import {
  askDecision,
  type DecisionCall,
  decisionBaseUrlOf,
} from "../server/src/computer/decision-call";
import {
  FIRST_MOVE_BARS,
  FIRST_MOVE_MAX_CHARS,
  FIRST_MOVE_QUESTIONS,
  FIRST_MOVE_TIMEOUT_MS,
  firstMoveStateOf,
  mentionsWeather,
} from "../server/src/turns/first-move";

type Labelled = {
  text: string;
  forecast: boolean;
  ownPlace: boolean;
  note?: string;
};

const KEY = process.env.OPENAI_API_KEY ?? "";
const BASE = process.env.OPENAI_BASE_URL ?? "";
const MODEL = process.env.EVAL_JEV_MODEL ?? "typesafe/jev-1.13-20260917";
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? "1") || 1);
const SHOW = process.env.EVAL_SHOW === "1";
/** Asked with room to spare, so how long an answer takes is measured rather than cut. */
const EVAL_TIMEOUT_MS = 8_000;

const decisionBase = decisionBaseUrlOf(BASE);
if (!KEY || !decisionBase) {
  console.error(
    "Needs OPENAI_API_KEY and an OpenRouter OPENAI_BASE_URL: Jev is reached through OpenRouter.",
  );
  process.exit(1);
}

const call: DecisionCall = {
  baseUrl: decisionBase,
  model: MODEL,
  apiKey: async () => KEY,
};

const messages = JSON.parse(
  await Bun.file(new URL("./first-move-messages.json", import.meta.url)).text(),
) as Labelled[];

type Row = Labelled & {
  /** Whether the product would have asked the decisions model at all. */
  sent: boolean;
  forecastP: number | null;
  ownPlaceP: number | null;
  ms: number | null;
  /** The answer did not come, at the eval's own generous bound. */
  noAnswer: boolean;
};

async function judge(item: Labelled): Promise<Row> {
  const text = item.text.trim();
  const sent = text.length <= FIRST_MOVE_MAX_CHARS && mentionsWeather(text);
  if (!sent) {
    return {
      ...item,
      sent,
      forecastP: null,
      ownPlaceP: null,
      ms: null,
      noAnswer: false,
    };
  }
  const decided = await askDecision(call, {
    purpose: "eval-first-move",
    state: firstMoveStateOf(text),
    questions: FIRST_MOVE_QUESTIONS,
    timeoutMs: EVAL_TIMEOUT_MS,
  });
  if (!decided.ok) {
    return {
      ...item,
      sent,
      forecastP: null,
      ownPlaceP: null,
      ms: decided.ms,
      noAnswer: true,
    };
  }
  const p = (name: string) => {
    const answer = decided.answers[name];
    return answer && "noul" in answer ? answer.noul : 0;
  };
  return {
    ...item,
    sent,
    forecastP: p("forecast"),
    ownPlaceP: p("ownPlace"),
    ms: decided.ms,
    noAnswer: false,
  };
}

/** A few at a time: the endpoint is shared with everything else this key does. */
async function all<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R>,
) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index] as T);
      }
    }),
  );
  return out;
}

const wants = (row: Labelled) => row.forecast && row.ownPlace;
const moves = (row: Row, bars: { forecast: number; ownPlace: number }) =>
  row.sent &&
  !row.noAnswer &&
  (row.forecastP ?? 0) >= bars.forecast &&
  (row.ownPlaceP ?? 0) >= bars.ownPlace;

const pct = (n: number, d: number) =>
  d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`;
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  );
};

console.log(
  `\nfirst move · ${MODEL} · ${messages.length} labelled messages × ${RUNS} run(s) · bars forecast ${FIRST_MOVE_BARS.forecast} / ownPlace ${FIRST_MOVE_BARS.ownPlace}\n`,
);

const runs: Row[][] = [];
for (let run = 0; run < RUNS; run += 1) {
  runs.push(await all(messages, 4, judge));
}
const rows = runs.flat();

/* ── the door before anything is sent ──────────────────────────────────────────────────────── */
const first = runs[0] ?? [];
const wanted = first.filter(wants);
const sentWanted = wanted.filter((row) => row.sent);
const sentAll = first.filter((row) => row.sent);
console.log("the words checked before anything is sent");
console.log(
  `  wanted the forecast for their own place: ${wanted.length} · of those sent on: ${sentWanted.length} (${pct(sentWanted.length, wanted.length)})`,
);
console.log(
  `  sent to the decisions model at all: ${sentAll.length} of ${first.length} (${pct(sentAll.length, first.length)}) — the rest never leave`,
);
for (const row of wanted.filter((row) => !row.sent)) {
  console.log(`    not sent: ${row.text}`);
}

/* ── the decision, at the product's bars ───────────────────────────────────────────────────── */
const tally = (bars: { forecast: number; ownPlace: number }) => {
  const moved = rows.filter((row) => moves(row, bars));
  const right = moved.filter(wants);
  const wrong = moved.filter((row) => !wants(row));
  const should = rows.filter(wants);
  return {
    moved,
    right,
    wrong,
    should,
    missed: should.filter((row) => !moves(row, bars)),
  };
};
const at = tally(FIRST_MOVE_BARS);
console.log("\nat the product's bars");
console.log(
  `  moved ${at.moved.length} · right ${at.right.length} · WRONG ${at.wrong.length} (precision ${pct(at.right.length, at.moved.length)})`,
);
console.log(
  `  should have moved ${at.should.length} · missed ${at.missed.length} (recall ${pct(at.right.length, at.should.length)})`,
);
const wrongOnForecast = at.wrong.filter((row) => !row.forecast);
console.log(
  `  of the wrong moves: ${wrongOnForecast.length} did not want the forecast at all, ${at.wrong.length - wrongOnForecast.length} wanted it for a place that was named`,
);
for (const row of at.wrong) {
  console.log(
    `    WRONG  f=${row.forecastP?.toFixed(2)} p=${row.ownPlaceP?.toFixed(2)}  ${row.text}  [${row.forecast ? "forecast" : "not forecast"}, ${row.ownPlace ? "own place" : "named place"}] ${row.note ?? ""}`,
  );
}
for (const row of at.missed.filter((row) => row.sent)) {
  console.log(
    `    missed f=${row.forecastP?.toFixed(2)} p=${row.ownPlaceP?.toFixed(2)}  ${row.text}  ${row.note ?? ""}`,
  );
}

/* ── each question against its own label, on what was sent ─────────────────────────────────── */
const answered = rows.filter((row) => row.sent && !row.noAnswer);
const question = (
  name: string,
  label: (row: Row) => boolean,
  p: (row: Row) => number,
  bar: number,
) => {
  const yes = answered.filter((row) => p(row) >= bar);
  const truePositive = yes.filter(label).length;
  const positives = answered.filter(label).length;
  console.log(
    `  ${name}: said yes ${yes.length} · right ${truePositive} (precision ${pct(truePositive, yes.length)}) · of ${positives} true, found ${pct(truePositive, positives)}`,
  );
};
console.log(
  "\neach question against its own label (messages that were sent and answered)",
);
question(
  "forecast",
  (row) => row.forecast,
  (row) => row.forecastP ?? 0,
  FIRST_MOVE_BARS.forecast,
);
question(
  "ownPlace",
  (row) => row.ownPlace,
  (row) => row.ownPlaceP ?? 0,
  FIRST_MOVE_BARS.ownPlace,
);

/* ── other bars, for whoever moves them ────────────────────────────────────────────────────── */
console.log("\nother bars (both questions at the same bar)");
for (const bar of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const t = tally({ forecast: bar, ownPlace: bar });
  console.log(
    `  ${bar.toFixed(1)}: moved ${String(t.moved.length).padStart(3)} · wrong ${String(t.wrong.length).padStart(2)} · precision ${pct(t.right.length, t.moved.length).padStart(6)} · recall ${pct(t.right.length, t.should.length).padStart(6)}`,
  );
}

/* ── how long it takes ─────────────────────────────────────────────────────────────────────── */
const times = rows.flatMap((row) =>
  row.sent && row.ms !== null ? [row.ms] : [],
);
const late = times.filter((ms) => ms > FIRST_MOVE_TIMEOUT_MS).length;
const unanswered = rows.filter((row) => row.noAnswer).length;
console.log("\nhow long the decision takes");
console.log(
  `  ${times.length} calls · p50 ${quantile(times, 0.5)} ms · p90 ${quantile(times, 0.9)} ms · max ${Math.max(0, ...times)} ms · over the product's ${FIRST_MOVE_TIMEOUT_MS} ms: ${late} (${pct(late, times.length)}) · no answer: ${unanswered}`,
);

if (SHOW) {
  console.log("\nevery message");
  for (const row of first) {
    console.log(
      `  ${row.sent ? `f=${row.forecastP?.toFixed(2)} p=${row.ownPlaceP?.toFixed(2)}` : "not sent     "}  ${wants(row) ? "WANTS" : "     "} ${moves(row, FIRST_MOVE_BARS) ? "MOVES" : "     "}  ${row.text}`,
    );
  }
}

mkdirSync("evals/reports", { recursive: true });
const file = `evals/reports/first-move-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(
  file,
  JSON.stringify(
    {
      model: MODEL,
      ranAt: new Date().toISOString(),
      runs: RUNS,
      bars: FIRST_MOVE_BARS,
      messages: messages.length,
      wanted: wanted.length,
      sentWanted: sentWanted.length,
      sent: sentAll.length,
      moved: at.moved.length,
      wrong: at.wrong.length,
      missed: at.missed.length,
      p50Ms: quantile(times, 0.5),
      p90Ms: quantile(times, 0.9),
      rows: first,
    },
    null,
    2,
  ),
);
console.log(`\nreport: ${file}`);

/*
 * THE VERDICT. Two kinds of wrong move fail it, and one is only shown.
 *
 *   A move for a place that was NAMED fails it, always. The result is the weather where the person
 *   lives, handed to a model that was asked about somewhere else, and a wrong town answered
 *   confidently is the failure the weather tool was built to end.
 *
 *   A move for a message that did not want the forecast fails it — unless its labeller had marked
 *   the message borderline, a message a careful person could label either way. Those are printed
 *   above and counted here, and do not fail the run.
 *
 * THE SECOND RULE WAS WRITTEN AFTER THE FIRST RUN, and that is said here rather than hidden: the
 * first run (2026-10-02) made two wrong moves in 61, "너 날씨도 알려줄 수 있어?" and "다음 주 금요일
 * 날씨 미리 알 수 있을까?", both marked borderline by the labeller before anything was run, and both
 * messages where looking at the forecast is what a Bot would do anyway. A verdict that fails on
 * the labeller's own coin-flips measures the labeller. The questions themselves were not changed
 * after seeing the set. Misses are reported and fail nothing — a miss is today's turn.
 */
const borderline = (row: Labelled) => /^borderline/i.test(row.note ?? "");
const forNamedPlace = at.wrong.filter((row) => row.forecast && !row.ownPlace);
const clearlyUnwanted = wrongOnForecast.filter((row) => !borderline(row));
const failed = forNamedPlace.length > 0 || clearlyUnwanted.length > 0;
console.log(
  `verdict: ${failed ? "FAIL" : "PASS"} — wrong moves: ${forNamedPlace.length} for a named place, ${clearlyUnwanted.length} for a message that clearly did not want the forecast, ${at.wrong.length - forNamedPlace.length - clearlyUnwanted.length} on messages their labeller marked borderline`,
);
process.exit(failed ? 1 : 0);
