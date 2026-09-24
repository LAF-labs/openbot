/**
 * Prompt-cache alignment, measured — the eval pack's cache arm (agent-harness-design row 11).
 *
 * WHY. A provider serves a prompt from its cache for exactly as long as the front of it matches
 * the last request, and bills the rest in full. Until 2026-09-25 the system message was rebuilt on
 * every run with the minute as its last line, in front of the whole conversation, so a Bot's
 * lifelong conversation was billed again whenever the minute moved: measured on a week-old one
 * (~39K tokens, two minutes between messages), 0% served from cache on Wafer and 10% on Z.AI
 * (agent-harness-review §4.3). The harness now follows Claude Code — a frozen context layer per
 * epoch, changes as reminders on the person's message, the minute behind a `now` tool — and this
 * says, in the provider's own numbers, whether that holds.
 *
 * THE CASE: a week-old conversation. A synthetic week of chat and browsing (~39K tokens; the page
 * results past the newest four are cut by agent-bot exactly as in production), then
 * `EVAL_CACHE_TURNS` new person turns `EVAL_CACHE_GAP_MINUTES` apart on a simulated clock, one of
 * them the first message of a new day. Scripted, so both arms send the same conversation and
 * differ only in the harness:
 *
 *   legacy  what shipped until 2026-09-25: the system message rebuilt each run with the minute as
 *           its last line, and no session id
 *   epoch   production: `server/src/context/conversations.ts` freezes the layer, a new day
 *           arrives as a reminder, agent-bot sends the session header
 *
 * THE METHOD is the review's (§4): each arm is pinned to one provider (`EVAL_CACHE_PROVIDER`,
 * `provider.only` with no fallbacks) and carries a nonce in its first tool's description, so no arm
 * reads another's cache. The tools are the shared catalogue (the routine path's set), or the chat
 * surface's real list recorded to a JSON file (`EVAL_CACHE_TOOLS=path`).
 *
 *   bun run eval:cache                       same key / base URL / BOT_MODEL as eval:model
 *   EVAL_CACHE_TURNS=6 EVAL_CACHE_GAP_MINUTES=2 EVAL_CACHE_ARMS=legacy,epoch
 *   EVAL_CACHE_PROVIDER=z-ai                 an OpenRouter provider slug; unset lets it route
 *   EVAL_CACHE_HISTORY_CHARS=39000           how long the week was
 *
 * PASS: the epoch arm serves ≥ 95% of its prompt from cache on every turn after the first. A
 * measurement, not a gate — it calls a real model. Reports land in evals/reports/ (not committed).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { runAgent } from "../agent-bot/src/index";
import {
  type CompletionProvider,
  liveProvider,
} from "../agent-bot/src/provider";
import { createConversationStore } from "../server/src/context/conversations";
import {
  BASE_KO,
  contextFactsFor,
  contextLayerText,
  modeText,
  systemPromptText,
} from "../shared/prompt";
import { HARNESS_VERSION } from "../shared/prompt/harness";
import { zonedParts, zoneLabel } from "../shared/prompt/zone";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
import { SELF_TOOLS } from "../shared/tools/self";
import { SKILL_VIEW } from "../shared/tools/skills";
import { longPage } from "./fixtures";
import { eventsOfSse } from "./lib";
import {
  EVAL_BOT,
  EVAL_MEMORIES,
  EVAL_STANDING_ROLE,
  EVAL_TIME_ZONE,
} from "./prompt";

const ARMS = ["legacy", "epoch"] as const;
type Arm = (typeof ARMS)[number];

const MODEL = process.env.BOT_MODEL?.trim() ?? "";
const TURNS = Math.max(
  2,
  Number.parseInt(process.env.EVAL_CACHE_TURNS ?? "6", 10) || 6,
);
const GAP_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.EVAL_CACHE_GAP_MINUTES ?? "2", 10) || 2,
);
const HISTORY_CHARS = Math.max(
  4_000,
  Number.parseInt(process.env.EVAL_CACHE_HISTORY_CHARS ?? "39000", 10) ||
    39_000,
);
const PROVIDER = process.env.EVAL_CACHE_PROVIDER?.trim() || null;
const CHOSEN: readonly Arm[] = (process.env.EVAL_CACHE_ARMS ?? ARMS.join(","))
  .split(",")
  .map((name) => name.trim())
  .filter((name): name is Arm => (ARMS as readonly string[]).includes(name));
/** A reasoning model can sit before its first token; the product's own stall guard allows this order of patience. */
const TURN_TIMEOUT_MS = 180_000;
/** The share the epoch arm must read from cache after its first turn. */
const TARGET_SHARE = 0.95;

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

type WireTool = { name: string; description: string; parameters?: unknown };

/** The tools: a recorded chat surface list, or the shared catalogue the routine path sends. */
async function toolsOf(): Promise<WireTool[]> {
  const path = process.env.EVAL_CACHE_TOOLS?.trim();
  if (path) return (await Bun.file(path).json()) as WireTool[];
  return [...COMPUTER_TOOLS, ...SELF_TOOLS, SKILL_VIEW].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** One clock for the whole run: the week ends at START, the new turns follow it. */
const START = new Date();
/** Turn `n` (1-based) of the measured ones; the fourth crosses into the person's next day. */
function clockAt(turn: number): Date {
  const minutes = (turn - 1) * GAP_MINUTES;
  const base = new Date(START.getTime() + minutes * 60_000);
  if (turn < 4) return base;
  // Past the person's next midnight, keeping the gap between the rest.
  const { time } = zonedParts(START, EVAL_TIME_ZONE);
  const [hours, mins] = time.split(":").map(Number);
  const untilMidnight =
    (24 * 60 - ((hours ?? 0) * 60 + (mins ?? 0))) * 60_000 + 60_000;
  return new Date(base.getTime() + untilMidnight);
}

const pad = (text: string, chars: number) =>
  text.length >= chars
    ? text.slice(0, chars)
    : `${text} ${"주문과 재고를 확인하고 정리했습니다. 특이사항은 없습니다. ".repeat(Math.ceil((chars - text.length) / 34))}`.slice(
        0,
        chars,
      );

/**
 * A week of this Bot's one conversation: person turns, answers, and a browsing task a day whose
 * page results the harness cuts once they age. Deterministic, so every arm sends the same week.
 */
function weekOfHistory(): unknown[] {
  const messages: unknown[] = [];
  let chars = 0;
  for (let at = 0; chars < HISTORY_CHARS; at += 1) {
    const day = Math.floor(at / 6) + 1;
    const ask = `${day}일차 ${at + 1}번째 부탁: 오늘 들어온 주문 중 ${at + 3}번 주문 상태 확인하고 고객에게 보낼 안내 문구도 써줘.`;
    messages.push({ id: `h_u${at}`, role: "user", content: ask });
    chars += ask.length;
    if (at % 6 === 5) {
      const callId = `h_call${at}`;
      const page = JSON.stringify({
        ok: true,
        title: `${day}일차 주문 관리`,
        text: longPage(at, `PO-${2000 + at}`),
      });
      messages.push(
        {
          id: `h_a${at}`,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: callId,
              type: "function",
              function: {
                name: "computer_navigate",
                arguments: JSON.stringify({
                  url: `https://shop.example.test/orders/${at}`,
                }),
              },
            },
          ],
        },
        { id: `h_t${at}`, role: "tool", toolCallId: callId, content: page },
      );
      chars += 500;
    }
    const answer = pad(
      `${day}일차 ${at + 3}번 주문은 결제완료 상태이고 오늘 오후 발송 예정입니다. 고객 안내 문구: "주문해 주셔서 감사합니다. 오늘 발송해 드릴게요."`,
      640,
    );
    messages.push({ id: `h_s${at}`, role: "assistant", content: answer });
    chars += answer.length;
  }
  return messages;
}

const QUESTIONS = [
  "오늘 새 주문 몇 건이야?",
  "그중에 아직 발송 안 된 거 알려줘.",
  "고객 문의 답장 짧게 하나 써줘.",
  "좋은 아침. 오늘 할 일 세 가지만 정리해줘.",
  "첫 번째 거 좀 더 자세히.",
  "고마워. 오늘은 여기까지.",
];

/** The legacy arm's system message: the same words, with the minute as its last line. */
function legacyPrompt(now: Date): string {
  const facts = contextFactsFor({
    mode: "chat",
    now,
    timeZone: EVAL_TIME_ZONE,
    bot: EVAL_BOT,
    standingRole: EVAL_STANDING_ROLE,
    memories: EVAL_MEMORIES,
    person: { timeZone: EVAL_TIME_ZONE, locale: "ko-KR" },
  });
  const { date, weekday, time } = zonedParts(now, EVAL_TIME_ZONE);
  return [
    BASE_KO,
    contextLayerText(facts),
    modeText("chat"),
    `지금은 ${date} (${weekday}) ${time} ${zoneLabel(EVAL_TIME_ZONE)}다.`,
  ].join("\n\n");
}

type TurnMeasure = {
  turn: number;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  costUsd: number | null;
  provider: string | null;
  latencyMs: number;
  problem: string | null;
};

type ArmMeasure = {
  arm: Arm;
  turns: TurnMeasure[];
  /** Cached over prompt on turns 2+, which is what the target is about. */
  laterShare: number | null;
  laterCostPerRequest: number | null;
  laterMedianLatencyMs: number | null;
};

async function measureArm(
  arm: Arm,
  tools: WireTool[],
  history: unknown[],
): Promise<ArmMeasure> {
  // No arm reads another's cache: the nonce is in the first tool, the head of the prompt.
  const nonce = randomUUID().slice(0, 8);
  const offered = tools.map((tool, at) =>
    at === 0
      ? { ...tool, description: `${tool.description} [${nonce}]` }
      : tool,
  );
  const threadId = `thread_cache_${arm}_${nonce}`;
  const store = createConversationStore();
  const pinned: CompletionProvider = (request, options) =>
    liveProvider(
      {
        ...request,
        ...(PROVIDER
          ? { provider: { only: [PROVIDER], allow_fallbacks: false } }
          : {}),
      } as typeof request,
      {
        ...(options?.signal ? { signal: options.signal } : {}),
        // The legacy arm is what shipped: no session id.
        ...(arm === "epoch" && options?.headers
          ? { headers: options.headers }
          : {}),
      },
    );

  const conversation = [...history];
  const turns: TurnMeasure[] = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const now = clockAt(turn);
    conversation.push({
      id: `q${turn}`,
      role: "user",
      content: QUESTIONS[(turn - 1) % QUESTIONS.length],
    });
    const facts = contextFactsFor({
      mode: "chat",
      now,
      timeZone: EVAL_TIME_ZONE,
      bot: EVAL_BOT,
      standingRole: EVAL_STANDING_ROLE,
      memories: EVAL_MEMORIES,
      person: { timeZone: EVAL_TIME_ZONE, locale: "ko-KR" },
    });
    const prepared =
      arm === "epoch"
        ? store.prepare({
            threadId,
            botId: EVAL_BOT.id,
            mode: "chat",
            messages: conversation as never,
            key: {
              harness: HARNESS_VERSION,
              model: MODEL,
              effort: "balanced",
              tools: nonce,
            },
            facts,
            system: (told) => systemPromptText("chat", contextLayerText(told)),
            now,
          })
        : null;
    const system = prepared?.system ?? legacyPrompt(now);
    const messages = [
      { id: "laf-prompt:eval_bot", role: "system", content: system },
      ...(prepared?.messages ?? conversation),
    ];

    const started = performance.now();
    let measure: TurnMeasure;
    try {
      const response = await runAgent(
        {
          threadId,
          runId: `cache_${arm}_t${turn}_${Date.now()}`,
          messages,
          tools: offered,
          context: [],
          state: {},
          forwardedProps: {
            effort: process.env.EVAL_EFFORT ?? "balanced",
            botId: EVAL_BOT.id,
            timeZone: EVAL_TIME_ZONE,
          },
        } as never,
        pinned,
      );
      const body = await Promise.race([
        response.text(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("turn timed out")),
            TURN_TIMEOUT_MS,
          ),
        ),
      ]);
      const events = eventsOfSse(body);
      const usage = events.find(
        (event) => event.type === "CUSTOM" && event.name === "laf.model.usage",
      )?.value as Record<string, unknown> | undefined;
      const error = events.find((event) => event.type === "RUN_ERROR");
      const number = (key: string) =>
        typeof usage?.[key] === "number" ? (usage[key] as number) : null;
      measure = {
        turn,
        promptTokens: number("promptTokens"),
        cachedPromptTokens: number("cachedPromptTokens"),
        costUsd: number("costUsd"),
        provider: typeof usage?.provider === "string" ? usage.provider : null,
        latencyMs: Math.round(performance.now() - started),
        problem: error
          ? `RUN_ERROR: ${error.message ?? "unnamed"}`
          : usage
            ? null
            : "no usage event",
      };
    } catch (error) {
      measure = {
        turn,
        promptTokens: null,
        cachedPromptTokens: null,
        costUsd: null,
        provider: null,
        latencyMs: Math.round(performance.now() - started),
        problem: error instanceof Error ? error.message : String(error),
      };
    }
    turns.push(measure);
    console.log(
      `  ${arm.padEnd(7)} turn ${String(turn).padStart(2)}` +
        `  prompt ${String(measure.promptTokens ?? "—").padStart(6)}` +
        `  cached ${String(measure.cachedPromptTokens ?? "—").padStart(6)}` +
        `  $${measure.costUsd?.toFixed(5) ?? "—"}` +
        `  ${String(measure.latencyMs).padStart(6)}ms  ${measure.provider ?? ""}` +
        (measure.problem ? `  · ${measure.problem}` : ""),
    );
    // The scripted answer, so both arms carry the same history into the next turn.
    conversation.push({
      id: `r${turn}`,
      role: "assistant",
      content: "네, 확인해서 정리해 드릴게요.",
    });
  }

  const later = turns.filter(
    (turn) =>
      turn.turn > 1 &&
      turn.promptTokens !== null &&
      turn.cachedPromptTokens !== null,
  );
  const prompt = later.reduce((sum, turn) => sum + (turn.promptTokens ?? 0), 0);
  const cached = later.reduce(
    (sum, turn) => sum + (turn.cachedPromptTokens ?? 0),
    0,
  );
  const costs = later
    .map((turn) => turn.costUsd)
    .filter((cost): cost is number => cost !== null);
  const latencies = later.map((turn) => turn.latencyMs).sort((a, b) => a - b);
  return {
    arm,
    turns,
    laterShare: prompt > 0 ? cached / prompt : null,
    laterCostPerRequest: costs.length
      ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length
      : null,
    laterMedianLatencyMs: latencies.length
      ? (latencies[Math.floor(latencies.length / 2)] ?? null)
      : null,
  };
}

const tools = await toolsOf();
const history = weekOfHistory();
console.log(
  `\ncache alignment · model ${MODEL} · provider ${PROVIDER ?? "routed"} · ${tools.length} tools` +
    `\na week of history (${history.length} messages), then ${TURNS} turns ${GAP_MINUTES} min apart, the 4th on a new day\n`,
);

const arms: ArmMeasure[] = [];
for (const arm of CHOSEN) {
  arms.push(await measureArm(arm, tools, history));
}

console.log("\nturns 2+:");
for (const measured of arms) {
  console.log(
    `  ${measured.arm.padEnd(7)} ${measured.laterShare === null ? "cache not reported" : `${(measured.laterShare * 100).toFixed(1)}% from cache`}` +
      `  $${measured.laterCostPerRequest?.toFixed(5) ?? "—"}/request` +
      `  median ${measured.laterMedianLatencyMs ?? "—"}ms`,
  );
}

const epoch = arms.find((measured) => measured.arm === "epoch");
const pass =
  epoch === undefined ||
  (epoch.laterShare !== null && epoch.laterShare >= TARGET_SHARE);
const answered = arms.every((measured) =>
  measured.turns.every((turn) => turn.problem === null),
);
console.log(
  `\nverdict: ${pass && answered ? "PASS" : "FAIL"} (epoch arm ≥ ${TARGET_SHARE * 100}% from cache on turns 2+)`,
);

const report = {
  model: MODEL,
  provider: PROVIDER,
  harness: HARNESS_VERSION,
  baseUrl: process.env.OPENAI_BASE_URL
    ? new URL(process.env.OPENAI_BASE_URL).host
    : "api.openai.com",
  ranAt: new Date().toISOString(),
  turns: TURNS,
  gapMinutes: GAP_MINUTES,
  historyMessages: history.length,
  tools: tools.length,
  arms,
};
mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
const reportPath = new URL(
  `./reports/cache-${MODEL.replace(/[^a-zA-Z0-9.-]/g, "_")}-${report.ranAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url,
);
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: ${reportPath.pathname}\n`);
process.exit(pass && answered ? 0 : 1);
