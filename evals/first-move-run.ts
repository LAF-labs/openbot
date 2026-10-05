/**
 * The first move's eval, the half that asks: every labelled set (`first-move.ts`) against the real
 * decisions model, the way the product would ask it.
 *
 *   OPENAI_API_KEY=… OPENAI_BASE_URL=https://openrouter.ai/api/v1 bun run eval:first-move
 *
 * `EVAL_RUNS` (default 1) asks every message that many times; `EVAL_KINDS=calendar,mail` runs those
 * sets alone; `EVAL_SHOW=1` prints every message with its probabilities. The report lands in
 * evals/reports/ (local only). The messages are fixtures, so printing them is printing nobody's
 * words.
 */
import { mkdirSync } from "node:fs";
import {
  askDecision,
  type DecisionCall,
  decisionBaseUrlOf,
} from "../server/src/computer/decision-call";
import {
  FIRST_MOVE_MAX_CHARS,
  FIRST_MOVE_SPECS,
  FIRST_MOVE_TIMEOUT_MS,
  type FirstMoveKind,
  firstMoveStateOf,
  kindsMentioned,
  questionsFor,
  settleDecision,
} from "../server/src/turns/first-move";
import {
  type Bars,
  categoryOf,
  type EvalSet,
  isBorderline,
  type Labelled,
  moveOf,
  PRECISION_FLOOR,
  pct,
  quantile,
  type Row,
  SETS,
  tallyOf,
  verdictOf,
} from "./first-move";

const KEY = process.env.OPENAI_API_KEY ?? "";
const BASE = process.env.OPENAI_BASE_URL ?? "";
const MODEL = process.env.EVAL_JEV_MODEL ?? "typesafe/jev-1.13-20260917";
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? "1") || 1);
const SHOW = process.env.EVAL_SHOW === "1";
const ONLY = (process.env.EVAL_KINDS ?? "")
  .split(",")
  .map((kind) => kind.trim())
  .filter(Boolean);
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

let requests = 0;

async function judge(item: Labelled): Promise<Row> {
  const text = item.text.trim();
  const asked = text.length <= FIRST_MOVE_MAX_CHARS ? kindsMentioned(text) : [];
  if (asked.length === 0) {
    return { ...item, asked, decided: null, ms: null, noAnswer: false };
  }
  requests += 1;
  const decided = await askDecision(call, {
    purpose: "eval-first-move",
    state: firstMoveStateOf(text),
    questions: questionsFor(asked),
    timeoutMs: EVAL_TIMEOUT_MS,
  });
  if (!decided.ok) {
    return { ...item, asked, decided: null, ms: decided.ms, noAnswer: true };
  }
  return {
    ...item,
    asked,
    decided: settleDecision(asked, decided.answers).decided,
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

const probabilities = (row: Row) =>
  row.decided
    ? Object.entries(row.decided)
        .map(([name, p]) => `${name}=${p.toFixed(2)}`)
        .join(" ")
    : row.noAnswer
      ? "no answer"
      : "not sent";

const labelOf = (set: EvalSet, row: Row) =>
  `[${categoryOf(set, row)}${isBorderline(row) ? ", borderline" : ""}] ${row.note ?? ""}`;

async function measure(set: EvalSet) {
  const messages = JSON.parse(
    await Bun.file(new URL(`./${set.file}`, import.meta.url)).text(),
  ) as Labelled[];
  const spec = FIRST_MOVE_SPECS[set.kind];
  console.log(
    `\n━━ ${set.kind} · ${set.file} · ${messages.length} labelled messages × ${RUNS} run(s) · bars ${JSON.stringify(spec.bars)}\n`,
  );

  const runs: Row[][] = [];
  for (let run = 0; run < RUNS; run += 1) {
    runs.push(await all(messages, 4, judge));
  }
  const rows = runs.flat();
  const first = runs[0] ?? [];
  const count = (category: string) =>
    first.filter((row) => categoryOf(set, row) === category).length;
  console.log(
    `the set: ${count("wants")} want the move · ${count("near")} want the service with an argument · ${count("unwanted")} do not want it · ${count("both")} ask for this and something else · ${first.filter(isBorderline).length} marked borderline`,
  );

  /* ── the door before anything is sent ────────────────────────────────────────────────────── */
  const wanted = first.filter((row) => categoryOf(set, row) === "wants");
  const asksThis = (row: Row) => row.asked.includes(set.kind);
  const sentWanted = wanted.filter(asksThis);
  const sentThis = first.filter(asksThis);
  const sentAny = first.filter((row) => row.asked.length > 0);
  console.log("\nthe words checked before anything is sent");
  console.log(
    `  wanted the move: ${wanted.length} · of those asked about it: ${sentWanted.length} (${pct(sentWanted.length, wanted.length)})`,
  );
  console.log(
    `  asked about ${set.kind}: ${sentThis.length} of ${first.length} (${pct(sentThis.length, first.length)}) · sent for any kind: ${sentAny.length} — the rest never leave`,
  );
  for (const row of wanted.filter((row) => !asksThis(row))) {
    console.log(
      `    not asked${row.text.trim().length > FIRST_MOVE_MAX_CHARS ? " (too long)" : ""}: ${row.text}`,
    );
  }

  /* ── the decision, at the product's bars ─────────────────────────────────────────────────── */
  const at = tallyOf(set, rows);
  const verdict = verdictOf(set, at);
  console.log("\nat the product's bars");
  console.log(
    `  moved ${at.moved.length} · right ${at.right.length} · WRONG ${at.wrong.length} (precision ${pct(at.right.length, at.moved.length)})`,
  );
  console.log(
    `  of the wrong moves: ${at.wrongNear.length} for ${set.nearMiss}, ${at.wrongUnwanted.length} on a message that did not want it; ${at.wrongBorderline.length} of them on a message marked borderline`,
  );
  console.log(
    `  should have moved ${at.should.length} · missed ${at.missed.length} (recall ${pct(at.right.length, at.should.length)})`,
  );
  console.log(
    `  two kinds cleared, so no move: ${at.ambiguous.length} · another kind moved instead: ${at.movedAnother.length}`,
  );
  const once = <T extends Row>(list: readonly T[]) => {
    const seen = new Map<string, { row: T; times: number }>();
    for (const row of list) {
      const held = seen.get(row.text);
      if (held) held.times += 1;
      else seen.set(row.text, { row, times: 1 });
    }
    return [...seen.values()];
  };
  for (const { row, times } of once(at.wrong)) {
    console.log(
      `    WRONG ×${times}  ${probabilities(row)}  ${row.text}  ${labelOf(set, row)}`,
    );
  }
  for (const { row, times } of once(at.movedOnBoth)) {
    console.log(
      `    moved on a message that asked for more ×${times}  ${probabilities(row)}  ${row.text}`,
    );
  }
  for (const { row, times } of once(at.ambiguous)) {
    console.log(
      `    two kinds ×${times}  ${probabilities(row)}  ${row.text}  ${labelOf(set, row)}`,
    );
  }
  for (const { row, times } of once(at.movedAnother)) {
    console.log(
      `    ${String(moveOf(row))} moved ×${times}  ${probabilities(row)}  ${row.text}  ${labelOf(set, row)}`,
    );
  }
  for (const { row, times } of once(at.missed.filter(asksThis))) {
    console.log(
      `    missed ×${times}  ${probabilities(row)}  ${row.text}  ${row.note ?? ""}`,
    );
  }

  /* ── each question against its own label, on what was asked ──────────────────────────────── */
  const answered = rows.filter((row) => asksThis(row) && row.decided);
  const [first1, second] = Object.keys(spec.questions);
  const question = (name: string | undefined, field: string) => {
    if (!name) return;
    const bar = spec.bars[name] ?? 1;
    const yes = answered.filter((row) => (row.decided?.[name] ?? 0) >= bar);
    const label = (row: Row) => row[field] === true;
    const truePositive = yes.filter(label).length;
    const positives = answered.filter(label).length;
    console.log(
      `  ${name} (label ${field}): said yes ${yes.length} · right ${truePositive} (precision ${pct(truePositive, yes.length)}) · of ${positives} true, found ${pct(truePositive, positives)}`,
    );
  };
  console.log(
    "\neach question against its own label (messages asked about this kind and answered)",
  );
  question(first1, set.wanted);
  question(second, set.plain);

  /* ── other bars, for whoever moves them ──────────────────────────────────────────────────── */
  const levels = [0.5, 0.6, 0.7, 0.8, 0.9];
  console.log(
    `\nother bars (${first1} down, ${second} across; the other kinds at the product's): moved / wrong (wrong not marked borderline) / recall`,
  );
  console.log(
    `  ${"".padEnd(6)}${levels.map((b) => b.toFixed(1).padStart(22)).join("")}`,
  );
  for (const a of levels) {
    const cells = levels.map((b) => {
      const bars: Bars = {
        [set.kind]: { [first1 ?? ""]: a, [second ?? ""]: b },
      };
      const t = tallyOf(set, rows, bars);
      const clear = t.wrong.filter((row) => !isBorderline(row)).length;
      return `${t.moved.length}/${t.wrong.length}(${clear})/${pct(t.right.length, t.should.length)}`.padStart(
        22,
      );
    });
    console.log(`  ${a.toFixed(1).padEnd(6)}${cells.join("")}`);
  }

  /* ── how long it takes ───────────────────────────────────────────────────────────────────── */
  const timed = rows.filter((row) => row.asked.length > 0 && row.ms !== null);
  const times = timed.map((row) => row.ms ?? 0);
  const late = times.filter((ms) => ms > FIRST_MOVE_TIMEOUT_MS).length;
  const unanswered = rows.filter((row) => row.noAnswer).length;
  console.log("\nhow long the decision takes");
  console.log(
    `  ${times.length} requests · p50 ${quantile(times, 0.5)} ms · p90 ${quantile(times, 0.9)} ms · max ${Math.max(0, ...times)} ms · over the product's ${FIRST_MOVE_TIMEOUT_MS} ms: ${late} (${pct(late, times.length)}) · no answer: ${unanswered}`,
  );
  for (const kinds of [1, 2, 3]) {
    const of = timed
      .filter((row) => row.asked.length === kinds)
      .map((row) => row.ms ?? 0);
    if (of.length === 0) continue;
    console.log(
      `    with ${kinds} kind(s) in the request: ${of.length} · p50 ${quantile(of, 0.5)} ms · p90 ${quantile(of, 0.9)} ms · max ${Math.max(...of)} ms`,
    );
  }

  if (SHOW) {
    console.log("\nevery message");
    for (const row of first) {
      const move = moveOf(row);
      console.log(
        `  ${categoryOf(set, row).padEnd(8)} ${(move ?? "").padEnd(9)} ${probabilities(row)}  ${row.text}`,
      );
    }
  }

  console.log(
    `\nverdict for ${set.kind}: ${verdict.failed ? `FAIL — ${verdict.why.join("; ")}` : `PASS — precision ${pct(at.right.length, at.moved.length)} (floor ${100 * PRECISION_FLOOR}%), no wrong move on a message that clearly did not want it`}`,
  );

  return {
    kind: set.kind as FirstMoveKind,
    file: set.file,
    bars: spec.bars,
    messages: messages.length,
    wanted: wanted.length,
    askedWanted: sentWanted.length,
    asked: sentThis.length,
    moved: at.moved.length,
    right: at.right.length,
    wrong: at.wrong.length,
    wrongNear: at.wrongNear.length,
    wrongUnwanted: at.wrongUnwanted.length,
    wrongBorderline: at.wrongBorderline.length,
    missed: at.missed.length,
    ambiguous: at.ambiguous.length,
    p50Ms: quantile(times, 0.5),
    p90Ms: quantile(times, 0.9),
    maxMs: Math.max(0, ...times),
    failed: verdict.failed,
    why: verdict.why,
    rows: first,
  };
}

console.log(`\nfirst move · ${MODEL}`);
const measured = [];
for (const set of SETS) {
  if (ONLY.length > 0 && !ONLY.includes(set.kind)) continue;
  measured.push(await measure(set));
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
      requests,
      kinds: measured,
    },
    null,
    2,
  ),
);
console.log(`\n${requests} decision requests · report: ${file}`);

const failed = measured.filter((kind) => kind.failed);
console.log(
  `verdict: ${failed.length > 0 ? `FAIL (${failed.map((kind) => kind.kind).join(", ")})` : "PASS"}`,
);
process.exit(failed.length > 0 ? 1 : 0);
