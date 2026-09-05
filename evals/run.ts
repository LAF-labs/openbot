/**
 * The model eval pack — the gate a candidate model passes before it may answer Bots.
 *
 * Drives the REAL `agent-bot` code: its message translation, its context budget and
 * its streaming loop, against whatever model the environment names — behind the REAL
 * composed prompt and the REAL tool catalogue (`./prompt.ts`, `../shared/tools`).
 * What is being certified is "this model works in this product", so nothing here
 * reimplements the product's path to the model; a synthetic harness would certify a
 * product that does not exist.
 *
 * The prompt is the server's now, not the service's: `agent-bot` carries none of its
 * own, so an eval that sent no system message would be measuring a Bot with no
 * instructions. The report records a hash of the prompt and of the catalogue,
 * because the ritual's rule is that editing either INSIDE a verdict starts a new
 * verdict — see docs/laf/eval-pack.md.
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
import { measureSchema, REALISTIC_TOOLSET, savingOf } from "./deferral";
import { SHOP_PAGE_TEXT, SHOP_PAGE_TITLE } from "./fixtures";
import {
  callsOf,
  eventsOfSse,
  resultsOf,
  type StreamEvent,
  usagesOf,
} from "./lib";
import {
  CATALOGUE_HASH,
  EVAL_NOW,
  EVAL_TIME_ZONE,
  PROMPT_HASH,
  systemMessageFor,
} from "./prompt";
import { SCENARIOS, streamProblems, turnText } from "./scenarios";

/**
 * The candidate. No default: this file exists to certify one named model, and a fallback here is a
 * report that says PASS about a model nobody asked about.
 */
const MODEL = process.env.BOT_MODEL?.trim() ?? "";
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

if (!MODEL) {
  console.error(
    "BOT_MODEL is not set. The eval certifies the model it is given by name, so there is no default to fall back to: BOT_MODEL=candidate/name bun run eval:model.",
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
  /*
   * A REAL PAGE, not `{ ok: true }`.
   *
   * Navigation used to be answered with a bare success and reading with an empty string, so the
   * one thing the prompt insists on — answer from what came back, never send the person to go and
   * look — was never once exercised. A model can pass an eval like that and still be unable to
   * read a Korean order table, which is the first job this product has.
   */
  if (name === "computer_navigate" || name === "computer_read") {
    return JSON.stringify({
      ok: true,
      title: SHOP_PAGE_TITLE,
      url: "https://shop.example.test/orders",
      text: SHOP_PAGE_TEXT,
      truncated: false,
    });
  }
  if (name === "computer_snapshot")
    return JSON.stringify({ snapshotId: 1, elements: [] });
  return JSON.stringify({ ok: true });
}

/** How many client-loop continuations a scenario may spend before it must have answered. */
const MAX_TURNS = 4;

/**
 * The deferral arm's override: the product's whole schema instead of the scenario's own list, with
 * the bridge on or off. Absent, a scenario runs exactly as it always has.
 */
type Arm = { tools: readonly unknown[]; deferral: boolean };

async function runOnce(
  scenario: (typeof SCENARIOS)[number],
  attempt: number,
  arm?: Arm,
) {
  const started = performance.now();
  /*
   * The composed prompt first, exactly where the server's middleware puts it. Rebuilt per attempt
   * from one fixed clock (`EVAL_NOW`), so a run that straddles midnight does not judge one date
   * against a prompt carrying another.
   */
  const messages: unknown[] = [systemMessageFor("chat"), ...scenario.messages];
  const allEvents: StreamEvent[] = [];
  let totalTokens: number | null = null;
  let promptTokens: number | null = null;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const runId = `eval_${scenario.id}_${attempt}_t${turn}_${Date.now()}`;
    const response = await runAgent({
      threadId: `thread_eval_${scenario.id}_${attempt}`,
      runId,
      messages,
      tools: arm?.tools ?? scenario.tools,
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
      forwardedProps: {
        effort: process.env.EVAL_EFFORT ?? "balanced",
        // The measurement arm only. Production never sends it; the default is the bridge.
        ...(arm && !arm.deferral ? { toolDeferral: "off" } : {}),
      },
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
    // Summed over the run's rounds: a run that looked a tool up made two or three requests.
    const usage = usagesOf(events);
    if (usage.requests > 0) {
      totalTokens = (totalTokens ?? 0) + usage.totalTokens;
      promptTokens = (promptTokens ?? 0) + usage.promptTokens;
    }

    /*
     * THE PRODUCT'S BREAK CONDITION, WHICH IS NOT "IT SAID SOMETHING".
     *
     * This used to stop as soon as a turn produced any prose, so a model that says "네, 열어
     *볼게요" while calling `computer_navigate` was judged on the sentence before the page had
     * been read — measured: `todays-orders-without-a-date` failed one run in three for exactly
     * that, on an answer the product would have gone on to complete. In the real loop a tool call
     * ends the RUN, not the turn: the surface executes it and starts another with the result. So
     * the loop continues while the model is still asking for tools, and MAX_TURNS is the bound.
     */
    const calls = callsOf(events);
    /*
     * Only the calls nobody has answered end the run on the surface's side. A bridge lookup
     * arrives already answered (TOOL_CALL_RESULT), and the client files that answer rather than
     * executing anything — so a run whose calls were all lookups is over, the way it would be in
     * the product.
     */
    const answered = resultsOf(events);
    if (!calls.some((call) => !answered.has(call.id))) break;

    // The run ended on tool calls — continue the client loop, the answered ones as answered and
    // the rest with stub results, under the ids the wire gave them.
    messages.push({
      id: `a_${runId}`,
      role: "assistant",
      content: "",
      toolCalls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.rawArguments },
      })),
    });
    for (const call of calls) {
      messages.push({
        id: `t_${call.id}`,
        role: "tool",
        toolCallId: call.id,
        content: answered.get(call.id) ?? stubResult(call.name),
      });
    }
  }

  const latencyMs = performance.now() - started;
  return { events: allEvents, latencyMs, totalTokens, promptTokens };
}

const outcomes: ScenarioOutcome[] = [];
console.log(
  `\neval pack · model ${MODEL} · ${SCENARIOS.length} scenarios × ${RUNS} run(s)` +
    `\nprompt ${PROMPT_HASH} · catalogue ${CATALOGUE_HASH}\n`,
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

/*
 * THE DEFERRAL ARM. A measurement, not a verdict: the same scenarios behind the product's whole
 * schema (`./deferral`), once with the bridge and once without, so the report says what the
 * bridge costs and saves ON THIS MODEL rather than quoting Hermes's 288 runs. The static half —
 * bytes and characters — is printed always; the model half is one more request per scenario per
 * arm, and EVAL_DEFERRAL=0 skips it.
 */
type ArmOutcome = {
  promptTokens: number | null;
  requests: number;
  pass: boolean;
};
type ArmRow = { id: string; withoutBridge: ArmOutcome; withBridge: ArmOutcome };

const schema = measureSchema(REALISTIC_TOOLSET);
console.log(
  `\ndeferral · ${schema.tools} tools, ${schema.deferred} behind the bridge` +
    `\n  schema ${schema.bytes} B → ${schema.bytesDeferred} B (${savingOf(schema.bytes, schema.bytesDeferred)})` +
    ` · ${schema.chars} → ${schema.charsDeferred} chars (${savingOf(schema.chars, schema.charsDeferred)})` +
    ` · bridge ${schema.bytesBridge} B`,
);

const armRows: ArmRow[] = [];
if (process.env.EVAL_DEFERRAL !== "0") {
  const measureArm = async (
    scenario: (typeof SCENARIOS)[number],
    deferral: boolean,
  ): Promise<ArmOutcome> => {
    try {
      const { events, promptTokens } = await runOnce(scenario, 1, {
        tools: REALISTIC_TOOLSET,
        deferral,
      });
      const judged = scenario.check({
        text: turnText(events),
        calls: callsOf(events),
        events,
      });
      return {
        promptTokens,
        requests: usagesOf(events).requests,
        pass: judged.pass && streamProblems(events).length === 0,
      };
    } catch {
      return { promptTokens: null, requests: 0, pass: false };
    }
  };
  const tokens = (arm: ArmOutcome) =>
    arm.promptTokens === null ? "—" : String(arm.promptTokens);
  const mark = (arm: ArmOutcome) => (arm.pass ? "✓" : "✗");

  console.log(
    "  prompt tokens, without → with the bridge (pass without/with):",
  );
  for (const scenario of SCENARIOS) {
    const withoutBridge = await measureArm(scenario, false);
    const withBridge = await measureArm(scenario, true);
    armRows.push({ id: scenario.id, withoutBridge, withBridge });
    const delta =
      withoutBridge.promptTokens && withBridge.promptTokens !== null
        ? savingOf(withoutBridge.promptTokens, withBridge.promptTokens)
        : "—";
    console.log(
      `  ${scenario.id.padEnd(32)} ${tokens(withoutBridge).padStart(6)} → ${tokens(withBridge).padStart(6)}` +
        ` (${delta}, ${withoutBridge.requests}→${withBridge.requests} req)  ${mark(withoutBridge)}/${mark(withBridge)}`,
    );
  }
}

const report = {
  model: MODEL,
  baseUrl: process.env.OPENAI_BASE_URL
    ? new URL(process.env.OPENAI_BASE_URL).host
    : "api.openai.com",
  ranAt: new Date().toISOString(),
  runsPerScenario: RUNS,
  /*
   * What this verdict was ABOUT. Two runs of the same model with different numbers here are two
   * verdicts, not two samples of one — which is the thing that went wrong on 2026-09-01, when
   * three runs eleven minutes apart carried three different prompts and were read as n=3.
   */
  promptHash: PROMPT_HASH,
  catalogueHash: CATALOGUE_HASH,
  promptClock: { now: EVAL_NOW.toISOString(), timeZone: EVAL_TIME_ZONE },
  verdict: allPassed ? "pass" : "fail",
  scenarios: outcomes,
  // What the bridge is worth on this model. Empty rows mean the model half was skipped.
  deferral: { schema, rows: armRows },
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
