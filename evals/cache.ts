/**
 * Prompt-cache alignment, measured — the A/B arm of the eval pack.
 *
 * WHY. A provider's prefix cache serves a prompt from the front for as long as it matches the last
 * request and charges the rest in full. `composePrompt` used to put the clock second ("지금은 …
 * 22:40 KST다."), so every minute the role, the memories and the mode behind it were paid for
 * again; it now puts the clock last (Hermes: stable → context → volatile, timestamp last). This
 * arm says by how much, in the provider's own numbers — `prompt_tokens_details.cached_tokens`,
 * which OpenRouter normalises across vendors and `agent-bot` forwards as `cachedPromptTokens`.
 *
 * WHAT IT RUNS. Ten turns of one browsing conversation, identical in every arm: each turn the
 * person asks for the next warehouse page, the transcript already holds the pages before it, and
 * the clock has moved a minute. The model's answers are neither judged nor kept — the transcript
 * is scripted, so the arms differ in exactly one thing, where the clock sits:
 *
 *   legacy-top     the clock second, as shipped until 2026-09, rebuilt from the same parts
 *   volatile-last  production: the clock is the last line of the system message
 *   clock-after    NOT production — the clock as its own system message AFTER the transcript, so
 *                  the whole history sits inside the cacheable prefix. Measured to price that step.
 *
 * Arms run one after another rather than interleaved: a cache is keyed on the prefix, so one arm
 * can feed the next only through what they share, which is BASE_KO alone.
 *
 *   bun run eval:cache        same OPENAI_API_KEY / OPENAI_BASE_URL / BOT_MODEL as eval:model
 *   EVAL_CACHE_TURNS=10       how many turns; EVAL_CACHE_ARMS=legacy-top,volatile-last to pick
 *
 * A measurement, not a verdict: it exits 0 whenever every turn answered. Reports land in
 * evals/reports/ (local only, not committed). Not part of the gate — it calls a real model.
 */

import { mkdirSync } from "node:fs";
import { runAgent } from "../agent-bot/src/index";
import { BASE_KO, composePrompt, nowLine } from "../shared/prompt";
import { longPage } from "./fixtures";
import { eventsOfSse, usageOf } from "./lib";
import {
  EVAL_BOT,
  EVAL_MEMORIES,
  EVAL_STANDING_ROLE,
  EVAL_TIME_ZONE,
} from "./prompt";
import { LIST_FILES, NAVIGATE, READ, SNAPSHOT } from "./tools";

const ARMS = ["legacy-top", "volatile-last", "clock-after"] as const;
type Arm = (typeof ARMS)[number];

const MODEL = process.env.BOT_MODEL?.trim() ?? "";
const TURNS = Math.max(
  2,
  Number.parseInt(process.env.EVAL_CACHE_TURNS ?? "10", 10) || 10,
);
const CHOSEN: readonly Arm[] = (process.env.EVAL_CACHE_ARMS ?? ARMS.join(","))
  .split(",")
  .map((name) => name.trim())
  .filter((name): name is Arm => (ARMS as readonly string[]).includes(name));
/** A reasoning model can sit before its first token; the product's own stall guard allows this order of patience. */
const TURN_TIMEOUT_MS = 180_000;

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "OPENAI_API_KEY is not set. This arm reads cache counts off a real provider; there is nothing to measure without one.",
  );
  process.exit(1);
}
if (!MODEL) {
  console.error(
    "BOT_MODEL is not set. Cache behaviour is the provider's, per model, so there is no default: BOT_MODEL=name bun run eval:cache.",
  );
  process.exit(1);
}
if (CHOSEN.length === 0) {
  console.error(`EVAL_CACHE_ARMS names no arm. Known: ${ARMS.join(", ")}.`);
  process.exit(1);
}

/** One clock for the whole run, read once, so every arm sees the same minutes in the same order. */
const START = new Date();
const clockAt = (turn: number) => new Date(START.getTime() + turn * 60_000);

/** The production system message for this minute — exactly what the server's middleware builds. */
function productionPrompt(now: Date): string {
  return composePrompt({
    mode: "chat",
    now,
    timeZone: EVAL_TIME_ZONE,
    bot: EVAL_BOT,
    standingRole: EVAL_STANDING_ROLE,
    memories: EVAL_MEMORIES,
  });
}

/**
 * The production prompt taken apart: the base, the part about this Bot, and the clock.
 *
 * Rebuilt from the composed text rather than from a second composer, so the legacy arm cannot
 * quietly measure different words. If `composePrompt` stops ending in the clock this throws
 * rather than measuring an arrangement that no longer exists.
 */
function partsOf(now: Date): { base: string; middle: string; clock: string } {
  const clock = nowLine(now, EVAL_TIME_ZONE);
  const fresh = productionPrompt(now);
  const tail = `\n\n${clock}`;
  if (!fresh.startsWith(BASE_KO) || !fresh.endsWith(tail)) {
    throw new Error(
      "composePrompt no longer has the shape evals/cache.ts takes apart; update the arms.",
    );
  }
  return {
    base: BASE_KO,
    middle: fresh.slice(BASE_KO.length, fresh.length - tail.length),
    clock,
  };
}

function systemPromptFor(arm: Arm, now: Date): string {
  const { base, middle, clock } = partsOf(now);
  if (arm === "legacy-top") return `${base}\n\n${clock}${middle}`;
  if (arm === "clock-after") return `${base}${middle}`;
  return productionPrompt(now);
}

const pageUrl = (step: number) => `https://warehouse.example.test/${step}`;
const orderNumber = (step: number) => `PO-${1000 + step}`;

/**
 * The conversation as the endpoint receives it on turn `turn`: the system message, every earlier
 * turn with its page, and the person's newest ask. Scripted, so the arms cannot drift apart on a
 * model's wording; the model's own answers on this run are discarded.
 */
function transcriptFor(arm: Arm, turn: number): unknown[] {
  const now = clockAt(turn);
  const messages: unknown[] = [
    {
      id: "laf-prompt:eval_bot",
      role: "system",
      content: systemPromptFor(arm, now),
    },
  ];
  const user = (step: number) => ({
    id: `u_${step}`,
    role: "user",
    content: `${step}번 창고 페이지 열어서 발주번호 확인해줘. ${pageUrl(step)}`,
  });
  for (let step = 1; step < turn; step += 1) {
    messages.push(
      user(step),
      {
        id: `a_${step}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: `call_${step}`,
            type: "function",
            function: {
              name: "computer_navigate",
              arguments: JSON.stringify({ url: pageUrl(step) }),
            },
          },
        ],
      },
      {
        id: `t_${step}`,
        role: "tool",
        toolCallId: `call_${step}`,
        content: JSON.stringify({
          ok: true,
          title: `${step}번 창고 페이지`,
          url: pageUrl(step),
          text: longPage(step, orderNumber(step)),
          truncated: false,
        }),
      },
      {
        id: `s_${step}`,
        role: "assistant",
        content: `${step}번 창고: 발주번호 ${orderNumber(step)}, 이상 없음.`,
      },
    );
  }
  messages.push(user(turn));
  if (arm === "clock-after") {
    messages.push({
      id: "laf-now:eval_bot",
      role: "system",
      content: nowLine(now, EVAL_TIME_ZONE),
    });
  }
  return messages;
}

type TurnMeasure = {
  turn: number;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  latencyMs: number;
  problem: string | null;
};

async function measureTurn(arm: Arm, turn: number): Promise<TurnMeasure> {
  const started = performance.now();
  try {
    const response = await runAgent({
      threadId: `thread_cache_${arm}`,
      runId: `cache_${arm}_t${turn}_${Date.now()}`,
      messages: transcriptFor(arm, turn),
      tools: [NAVIGATE, READ, SNAPSHOT, LIST_FILES],
      context: [],
      state: {},
      // The product's shape, as eval:model sends it.
      forwardedProps: { effort: process.env.EVAL_EFFORT ?? "balanced" },
    } as never);
    const body = await Promise.race([
      response.text(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("turn timed out")), TURN_TIMEOUT_MS),
      ),
    ]);
    const events = eventsOfSse(body);
    const usage = usageOf(events);
    const error = events.find((event) => event.type === "RUN_ERROR");
    return {
      turn,
      promptTokens: usage?.promptTokens ?? null,
      cachedPromptTokens: usage?.cachedPromptTokens ?? null,
      latencyMs: Math.round(performance.now() - started),
      problem: error
        ? `RUN_ERROR: ${error.message ?? "unnamed"}`
        : usage
          ? null
          : "no usage event",
    };
  } catch (error) {
    return {
      turn,
      promptTokens: null,
      cachedPromptTokens: null,
      latencyMs: Math.round(performance.now() - started),
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

type ArmMeasure = {
  arm: Arm;
  turns: TurnMeasure[];
  promptTokens: number;
  cachedPromptTokens: number | null;
  /** Cached over prompt, across every turn that reported both. Null where nothing was reported. */
  hitShare: number | null;
};

async function measureArm(arm: Arm): Promise<ArmMeasure> {
  const turns: TurnMeasure[] = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const measured = await measureTurn(arm, turn);
    turns.push(measured);
    console.log(
      `  ${arm.padEnd(14)} turn ${String(turn).padStart(2)}` +
        `  prompt ${String(measured.promptTokens ?? "—").padStart(6)}` +
        `  cached ${String(measured.cachedPromptTokens ?? "—").padStart(6)}` +
        `  ${String(measured.latencyMs).padStart(6)}ms` +
        (measured.problem ? `  · ${measured.problem}` : ""),
    );
  }
  const reported = turns.filter(
    (turn) => turn.promptTokens !== null && turn.cachedPromptTokens !== null,
  );
  const promptTokens = turns.reduce(
    (sum, turn) => sum + (turn.promptTokens ?? 0),
    0,
  );
  const cachedPromptTokens = reported.length
    ? reported.reduce((sum, turn) => sum + (turn.cachedPromptTokens ?? 0), 0)
    : null;
  const promptOfReported = reported.reduce(
    (sum, turn) => sum + (turn.promptTokens ?? 0),
    0,
  );
  return {
    arm,
    turns,
    promptTokens,
    cachedPromptTokens,
    hitShare:
      cachedPromptTokens !== null && promptOfReported > 0
        ? cachedPromptTokens / promptOfReported
        : null,
  };
}

console.log(
  `\ncache alignment · model ${MODEL} · ${TURNS} turns × ${CHOSEN.length} arm(s)` +
    `\nclock starts ${START.toISOString()} and moves a minute a turn\n`,
);

const arms: ArmMeasure[] = [];
for (const arm of CHOSEN) {
  arms.push(await measureArm(arm));
}

console.log("\nby arm:");
for (const measured of arms) {
  const share =
    measured.hitShare === null
      ? "cache counts not reported"
      : `${(measured.hitShare * 100).toFixed(1)}% served from cache`;
  console.log(
    `  ${measured.arm.padEnd(14)} prompt ${String(measured.promptTokens).padStart(7)}` +
      `  cached ${String(measured.cachedPromptTokens ?? "—").padStart(7)}  ${share}`,
  );
}

const answered = arms.every((measured) =>
  measured.turns.some((turn) => turn.problem === null),
);

const report = {
  model: MODEL,
  baseUrl: process.env.OPENAI_BASE_URL
    ? new URL(process.env.OPENAI_BASE_URL).host
    : "api.openai.com",
  ranAt: new Date().toISOString(),
  turns: TURNS,
  clockStart: START.toISOString(),
  timeZone: EVAL_TIME_ZONE,
  arms,
};
mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
const reportPath = new URL(
  `./reports/cache-${MODEL.replace(/[^a-zA-Z0-9.-]/g, "_")}-${report.ranAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url,
);
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nreport: ${reportPath.pathname}\n`);
process.exit(answered ? 0 : 1);
