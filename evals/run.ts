/**
 * The model eval pack — the gate a candidate model passes before it may answer Bots.
 *
 * Drives the REAL `agent-bot` code: its system prompt, its message translation and
 * its streaming loop, against whatever model the environment names. What is being
 * certified is "this model works in this product", so nothing here reimplements the
 * product's path to the model; a synthetic harness would certify a product that
 * does not exist.
 *
 *   OPENAI_API_KEY=…  OPENAI_BASE_URL=…  BOT_MODEL=candidate/name  bun run eval:model
 *
 * `EVAL_RUNS=3` runs every scenario three times — the setting for a real swap
 * decision, since one clean pass of a flaky model is how a flaky model ships.
 * The verdict is strict: every scenario, every run, plus a well-formed stream.
 * Reports land in evals/reports/ (local only, not committed).
 */

import { mkdirSync } from "node:fs";
import { runAgent } from "../agent-bot/src/index";
import { callsOf, eventsOfSse, type StreamEvent, usageOf } from "./lib";
import { SCENARIOS, streamProblems, turnText } from "./scenarios";

const MODEL = process.env.BOT_MODEL ?? "gpt-5.5";
const RUNS = Math.max(
  1,
  Number.parseInt(process.env.EVAL_RUNS ?? "1", 10) || 1,
);
/** A reasoning model can sit before its first token; the product's own stall guard allows this order of patience. */
const SCENARIO_TIMEOUT_MS = 180_000;

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "OPENAI_API_KEY is not set. The eval calls a real model; there is nothing to certify without one.",
  );
  process.exit(1);
}

type ScenarioOutcome = {
  id: string;
  dimension: string;
  passes: number;
  runs: number;
  notes: string[];
  averageLatencyMs: number;
  averageTotalTokens: number | null;
};

/**
 * A canned answer for a tool the model chose to use on the way.
 *
 * The product's loop runs on the client: a tool call ends the run, the surface
 * executes it and starts the next one with the result appended. A model that
 * checks its (empty) workspace before summarizing receipts is behaving, not
 * failing — so the harness answers with the emptiest truthful result and lets
 * the turn continue, the way the surface would.
 */
function stubResult(name: string): string {
  if (name === "computer_list_files")
    return JSON.stringify({ entries: [], note: "the workspace is empty" });
  if (name === "computer_read")
    return JSON.stringify({ title: "", text: "", truncated: false });
  if (name === "computer_snapshot")
    return JSON.stringify({ snapshotId: 1, elements: [] });
  return JSON.stringify({ ok: true });
}

/** How many client-loop continuations a scenario may spend before it must have answered. */
const MAX_TURNS = 3;

async function runOnce(scenario: (typeof SCENARIOS)[number], attempt: number) {
  const started = performance.now();
  const messages: unknown[] = [...scenario.messages];
  const allEvents: StreamEvent[] = [];
  let totalTokens: number | null = null;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const runId = `eval_${scenario.id}_${attempt}_t${turn}_${Date.now()}`;
    const response = await runAgent({
      threadId: `thread_eval_${scenario.id}_${attempt}`,
      runId,
      messages,
      tools: scenario.tools,
      context: [],
      state: {},
      /*
       * THE PRODUCT'S SHAPE, NOT AN EMPTY ONE. Every Bot a person creates carries an effort and
       * its default is `balanced` (coworker schema), which agent-bot turns into a reasoning
       * setting on the wire. An eval that sent nothing was certifying a run no customer has:
       * caught the day glm-5.3-flash was judged, when the Korean-arithmetic scenarios failed on
       * the empty shape — a verdict about a run that does not exist in the product. Until the eval
       * sends what production sends, "the model cannot do the work" and "the eval was not running
       * the product" are indistinguishable. EVAL_EFFORT overrides for comparisons.
       */
      forwardedProps: { effort: process.env.EVAL_EFFORT ?? "balanced" },
    } as never);
    const body = await Promise.race([
      response.text(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("scenario timed out")),
          SCENARIO_TIMEOUT_MS,
        ),
      ),
    ]);
    const events = eventsOfSse(body);
    allEvents.push(...events);
    const usage = usageOf(events);
    if (usage) totalTokens = (totalTokens ?? 0) + usage.totalTokens;

    // The run ended with words: the turn is finished, judge it.
    const calls = callsOf(events);
    if (calls.length === 0 || turnText(events).trim().length > 0) break;

    // The run ended on tool calls alone — continue the client loop with stub results.
    messages.push({
      id: `a_${runId}`,
      role: "assistant",
      content: "",
      toolCalls: calls.map((call, index) => ({
        id: `call_${runId}_${index}`,
        type: "function",
        function: { name: call.name, arguments: call.rawArguments },
      })),
    });
    calls.forEach((call, index) => {
      messages.push({
        id: `t_${runId}_${index}`,
        role: "tool",
        toolCallId: `call_${runId}_${index}`,
        content: stubResult(call.name),
      });
    });
  }

  const latencyMs = performance.now() - started;
  return { events: allEvents, latencyMs, totalTokens };
}

const outcomes: ScenarioOutcome[] = [];
console.log(
  `\neval pack · model ${MODEL} · ${SCENARIOS.length} scenarios × ${RUNS} run(s)\n`,
);

for (const scenario of SCENARIOS) {
  let passes = 0;
  const notes = new Set<string>();
  const latencies: number[] = [];
  const tokens: number[] = [];

  for (let attempt = 1; attempt <= RUNS; attempt++) {
    try {
      const { events, latencyMs, totalTokens } = await runOnce(
        scenario,
        attempt,
      );
      latencies.push(latencyMs);
      if (totalTokens !== null) tokens.push(totalTokens);

      const wire = streamProblems(events);
      const judged = scenario.check({
        text: turnText(events),
        calls: callsOf(events),
        events,
      });
      const failures = [...judged.notes, ...wire.map((p) => `wire: ${p}`)];
      if (judged.pass && wire.length === 0) {
        passes++;
      } else {
        for (const note of failures) notes.add(note);
      }
    } catch (error) {
      notes.add(
        `run ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const outcome: ScenarioOutcome = {
    id: scenario.id,
    dimension: scenario.dimension,
    passes,
    runs: RUNS,
    notes: [...notes],
    averageLatencyMs: Math.round(
      latencies.reduce((sum, v) => sum + v, 0) / Math.max(1, latencies.length),
    ),
    averageTotalTokens: tokens.length
      ? Math.round(tokens.reduce((sum, v) => sum + v, 0) / tokens.length)
      : null,
  };
  outcomes.push(outcome);

  const mark = passes === RUNS ? "✓" : "✗";
  console.log(
    `${mark} ${scenario.id.padEnd(32)} ${String(passes)}/${RUNS}` +
      `  ${String(outcome.averageLatencyMs).padStart(6)}ms` +
      `  ${outcome.averageTotalTokens ?? "—"} tok` +
      (outcome.notes.length ? `\n    · ${outcome.notes.join("\n    · ")}` : ""),
  );
}

const allPassed = outcomes.every((o) => o.passes === o.runs);
const byDimension = new Map<string, { passed: number; total: number }>();
for (const o of outcomes) {
  const entry = byDimension.get(o.dimension) ?? { passed: 0, total: 0 };
  entry.passed += o.passes;
  entry.total += o.runs;
  byDimension.set(o.dimension, entry);
}

console.log("\nby dimension:");
for (const [dimension, { passed, total }] of byDimension) {
  console.log(`  ${dimension.padEnd(14)} ${passed}/${total}`);
}

const report = {
  model: MODEL,
  baseUrl: process.env.OPENAI_BASE_URL
    ? new URL(process.env.OPENAI_BASE_URL).host
    : "api.openai.com",
  ranAt: new Date().toISOString(),
  runsPerScenario: RUNS,
  verdict: allPassed ? "pass" : "fail",
  scenarios: outcomes,
};
mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
const reportPath = new URL(
  `./reports/${MODEL.replace(/[^a-zA-Z0-9.-]/g, "_")}-${report.ranAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url,
);
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `\nverdict: ${report.verdict.toUpperCase()} · report: ${reportPath.pathname}\n`,
);
process.exit(allPassed ? 0 : 1);
