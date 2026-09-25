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
 * THE CASE: a week-old conversation. A synthetic week of chat and browsing (~39K characters of chat
 * and six pages; ~64K tokens now that no result is cut after the fact — compaction, not measured
 * here, is what relieves that at the server's threshold), then
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
 *   EVAL_CACHE_CASES=days                    a week day by day, before and after the day epochs
 *   EVAL_DAYS_ARMS=lifelong,daily EVAL_DAYS=7 (see ./cache-days.ts)
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
import { createResultSpill } from "../server/src/computer/spillover";
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
import {
  DAY_ARMS,
  type DayArm,
  type DayArmMeasure,
  measureDays,
} from "./cache-days";
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
/**
 * Which cases run: the week-old conversation (`EVAL_CACHE_ARMS` picks its arms) and the browsing
 * task. `EVAL_CACHE_CASES=browsing` with `EVAL_CACHE_ARMS=` runs the browsing task alone.
 */
const CASES = (process.env.EVAL_CACHE_CASES ?? "week,browsing")
  .split(",")
  .map((name) => name.trim());
/**
 * Whether the browsing task's history carries each tool call's reasoning, as production's does since
 * 2026-09-25 (`agent-bot/src/reasoning.ts`). `EVAL_CACHE_REASONING=off` is the history before that,
 * for measuring what carrying it costs.
 */
const CARRY_REASONING = process.env.EVAL_CACHE_REASONING !== "off";
/** The share the browsing task must read from cache after its first request (harness phase 2). */
const BROWSING_TARGET_SHARE = 0.9;
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
if (CASES.includes("week") && CHOSEN.length === 0) {
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
  /**
   * The reasoning the run attached to its tool-call turn (`agent-bot/src/reasoning.ts`), which the
   * client files on that turn's message. Not in the report: it is the model's thought.
   */
  carried?: string | null;
};

type ArmMeasure = {
  arm: Arm | "browsing";
  turns: TurnMeasure[];
  /** Cached over prompt on turns 2+, which is what the target is about. */
  laterShare: number | null;
  laterCostPerRequest: number | null;
  laterMedianLatencyMs: number | null;
  /**
   * Cached tokens over the PREVIOUS request's whole prompt, turns 2+: how much of what the provider
   * already had was read back. The share above also counts each step's new tool result as a miss,
   * which no harness can cache; this is the harness's own number (≈100% when nothing is rewritten).
   */
  prefixReuse: number | null;
  /** Every request of the arm, the cold first one included. */
  totalCostUsd: number;
};

/** One request through the real agent-bot loop, read back as the provider's usage. */
async function requestOnce(input: {
  turn: number;
  threadId: string;
  runId: string;
  messages: unknown[];
  tools: WireTool[];
  provider: CompletionProvider;
}): Promise<TurnMeasure> {
  const { turn } = input;
  const started = performance.now();
  try {
    const response = await runAgent(
      {
        threadId: input.threadId,
        runId: input.runId,
        messages: input.messages,
        tools: input.tools,
        context: [],
        state: {},
        forwardedProps: {
          effort: process.env.EVAL_EFFORT ?? "balanced",
          botId: EVAL_BOT.id,
          timeZone: EVAL_TIME_ZONE,
        },
      } as never,
      input.provider,
    );
    const body = await Promise.race([
      response.text(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("turn timed out")), TURN_TIMEOUT_MS),
      ),
    ]);
    const events = eventsOfSse(body);
    // The run's FIRST request: the prefix measured is the one the conversation arrived with.
    const usage = events.find(
      (event) => event.type === "CUSTOM" && event.name === "laf.model.usage",
    )?.value as Record<string, unknown> | undefined;
    const error = events.find((event) => event.type === "RUN_ERROR");
    const number = (key: string) =>
      typeof usage?.[key] === "number" ? (usage[key] as number) : null;
    return {
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
      carried:
        events.find((event) => event.type === "REASONING_ENCRYPTED_VALUE")
          ?.encryptedValue ?? null,
    };
  } catch (error) {
    return {
      turn,
      promptTokens: null,
      cachedPromptTokens: null,
      costUsd: null,
      provider: null,
      latencyMs: Math.round(performance.now() - started),
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

function printTurn(label: string, measure: TurnMeasure) {
  console.log(
    `  ${label.padEnd(8)} turn ${String(measure.turn).padStart(2)}` +
      `  prompt ${String(measure.promptTokens ?? "—").padStart(6)}` +
      `  cached ${String(measure.cachedPromptTokens ?? "—").padStart(6)}` +
      `  $${measure.costUsd?.toFixed(5) ?? "—"}` +
      `  ${String(measure.latencyMs).padStart(6)}ms  ${measure.provider ?? ""}` +
      (measure.problem ? `  · ${measure.problem}` : ""),
  );
}

/** See `ArmMeasure.prefixReuse`. */
function prefixReuseOf(turns: readonly TurnMeasure[]): number | null {
  let cached = 0;
  let before = 0;
  for (let at = 1; at < turns.length; at += 1) {
    const previous = turns[at - 1]?.promptTokens;
    const read = turns[at]?.cachedPromptTokens;
    if (typeof previous !== "number" || typeof read !== "number") continue;
    cached += read;
    before += previous;
  }
  return before > 0 ? Math.min(1, cached / before) : null;
}

/** Turns 2+ summed: the share read from cache, the dollars per request, the median latency. */
function laterOf(turns: readonly TurnMeasure[]) {
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
  const costs = turns
    .filter((turn) => turn.turn > 1)
    .map((turn) => turn.costUsd)
    .filter((cost): cost is number => cost !== null);
  const latencies = later.map((turn) => turn.latencyMs).sort((a, b) => a - b);
  return {
    laterShare: prompt > 0 ? cached / prompt : null,
    laterCostPerRequest: costs.length
      ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length
      : null,
    laterMedianLatencyMs: latencies.length
      ? (latencies[Math.floor(latencies.length / 2)] ?? null)
      : null,
    totalCostUsd: turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
    prefixReuse: prefixReuseOf(turns),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The browsing task                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * One question that takes ten steps in the Bot's browser, scripted.
 *
 * WHY SCRIPTED. The real-stack measurement of 2026-09-25 (docs/laf/eval-pack.md) drove the app with
 * a headless browser and read 59.1% from cache after the first request, and named the cause: every
 * step, the server's result filing (`computer/spillover.ts`) and agent-bot's cut of older results
 * rewrote a tool result the provider had already cached. That is a property of the harness, not of
 * which page the model chose to open, so the calls here are fixed and only the model's REQUEST is
 * measured: after each step the model is asked to continue, its reply is dropped, and the script's
 * next call and result are appended. Every run of this case sends the same conversation, and before
 * and after a harness change differ only in what the harness does to it.
 *
 * The results pass through exactly what production passes them through: the server's filing (with
 * a computer that files instantly, so the "preview from the next run" path is taken as soon as it
 * would be in production) and the conversation store's epoch, then agent-bot.
 */
const BROWSING_QUESTION =
  "주문 관리 들어가서 아직 발송 안 된 주문 확인하고, 20260046번 주문 상세 보고 고객 요청사항이랑 환불 사유 있는지 알려줘.";

function elementsPage(step: number): string {
  const elements = Array.from({ length: 48 }, (_, at) => ({
    ref: `e${at + 1}`,
    role: at % 5 === 0 ? "button" : at % 3 === 0 ? "textbox" : "link",
    name: `${step}단계 ${at % 5 === 0 ? "주문 상세 보기" : at % 3 === 0 ? "검색어 입력" : `주문 ${20260040 + at}`}`,
  }));
  return JSON.stringify({
    ok: true,
    snapshotId: step,
    url: "https://shop.example.test/admin/orders",
    title: "미소상회 · 주문 관리",
    elements,
    truncated: false,
    tabs: [
      {
        index: 0,
        title: "미소상회 · 주문 관리",
        url: "https://shop.example.test/admin/orders",
        active: true,
      },
    ],
  });
}

function pageResult(step: number, title: string, needle = ""): string {
  return JSON.stringify({
    ok: true,
    url: `https://shop.example.test/admin/orders/${step}`,
    title,
    text: `${longPage(step, `PO-${3000 + step}`)}${needle ? `\n${needle}` : ""}`,
  });
}

/** The ten steps: each call as the model would have written it, and what the computer said. */
function browsingSteps(): Array<{
  name: string;
  args: Record<string, unknown>;
  result: string;
}> {
  const detail =
    "주문번호 20260046 · 고객 박지영 · 유자청 500g 1개 · 15,000원 · 결제완료\n고객 요청사항: 선물 포장 부탁드려요\n환불 사유: 없음";
  return [
    {
      name: "computer_navigate",
      args: { url: "https://shop.example.test/admin/orders" },
      result: pageResult(1, "미소상회 · 주문 관리"),
    },
    { name: "computer_snapshot", args: {}, result: elementsPage(2) },
    {
      name: "computer_click",
      args: { ref: "e6", snapshotId: 2 },
      result: JSON.stringify({
        ok: true,
        url: "https://shop.example.test/admin/orders?status=unshipped",
      }),
    },
    {
      name: "computer_read",
      args: {},
      result: pageResult(4, "미발송 주문"),
    },
    { name: "computer_snapshot", args: {}, result: elementsPage(5) },
    {
      name: "computer_click",
      args: { ref: "e11", snapshotId: 5 },
      result: JSON.stringify({
        ok: true,
        url: "https://shop.example.test/admin/orders/20260046",
      }),
    },
    {
      name: "computer_read",
      args: {},
      result: pageResult(7, "주문 20260046", detail),
    },
    {
      name: "computer_scroll",
      args: { deltaY: 600 },
      result: JSON.stringify({ ok: true }),
    },
    {
      name: "computer_read",
      args: {},
      result: pageResult(9, "주문 20260046 (아래)"),
    },
    { name: "computer_snapshot", args: {}, result: elementsPage(10) },
  ];
}

async function measureBrowsing(tools: WireTool[]): Promise<ArmMeasure> {
  const nonce = randomUUID().slice(0, 8);
  const offered = tools.map((tool, at) =>
    at === 0
      ? { ...tool, description: `${tool.description} [${nonce}]` }
      : tool,
  );
  const threadId = `thread_cache_browsing_${nonce}`;
  const store = createConversationStore();
  // A computer that files at once: production's filing lands long before the next step's run.
  const spill = createResultSpill({
    forBot: () => ({
      writeFile: async (input) => ({
        path: input.path,
        bytes: input.contents.length,
        appended: false,
      }),
    }),
  });
  const pinned: CompletionProvider = (request, options) =>
    liveProvider(
      {
        ...request,
        ...(PROVIDER
          ? { provider: { only: [PROVIDER], allow_fallbacks: false } }
          : {}),
      } as typeof request,
      options,
    );

  const now = new Date();
  const facts = contextFactsFor({
    mode: "chat",
    now,
    timeZone: EVAL_TIME_ZONE,
    bot: EVAL_BOT,
    standingRole: EVAL_STANDING_ROLE,
    memories: EVAL_MEMORIES,
    person: { timeZone: EVAL_TIME_ZONE, locale: "ko-KR" },
  });
  const conversation: Array<Record<string, unknown>> = [
    { id: "b_q", role: "user", content: BROWSING_QUESTION },
  ];
  const turns: TurnMeasure[] = [];
  const steps = browsingSteps();
  /*
   * The reasoning the last request's tool call carried, filed on the next scripted step as the
   * client files it on the call it produced — so the history grows by what production's does. The
   * script's call is not always the call the model made; the thought is the model's own either way,
   * and what is measured is whether a thought in the history keeps the prefix whole.
   */
  let carried: string | null = null;
  for (let at = 0; at < steps.length; at += 1) {
    const step = steps[at];
    if (!step) break;
    const callId = `call_b${at}_${nonce}`;
    conversation.push(
      {
        id: `b_a${at}`,
        role: "assistant",
        content: "",
        ...(carried && CARRY_REASONING ? { encryptedValue: carried } : {}),
        toolCalls: [
          {
            id: callId,
            type: "function",
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          },
        ],
      },
      {
        id: `b_t${at}`,
        role: "tool",
        toolCallId: callId,
        content: step.result,
      },
    );
    // The server's seam, as `copilot.ts` runs it: results filed, then the epoch.
    const filed = conversation.map((message) =>
      message.role === "tool"
        ? {
            ...message,
            content: spill.forModel(
              EVAL_BOT.id,
              String(message.toolCallId),
              String(message.content),
            ),
          }
        : message,
    );
    const prepared = store.prepare({
      threadId,
      botId: EVAL_BOT.id,
      mode: "chat",
      messages: filed as never,
      key: {
        harness: HARNESS_VERSION,
        model: MODEL,
        effort: "balanced",
        tools: nonce,
      },
      facts,
      system: (told) => systemPromptText("chat", contextLayerText(told)),
      now,
    });
    const measure = await requestOnce({
      turn: at + 1,
      threadId,
      runId: `cache_browsing_s${at}_${Date.now()}`,
      messages: [
        { id: "laf-prompt:eval_bot", role: "system", content: prepared.system },
        ...prepared.messages,
      ],
      tools: offered,
      provider: pinned,
    });
    turns.push(measure);
    printTurn("browsing", measure);
    carried = measure.carried ?? null;
    await spill.settled();
  }
  return { arm: "browsing", turns, ...laterOf(turns) };
}

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

    const measure = await requestOnce({
      turn,
      threadId,
      runId: `cache_${arm}_t${turn}_${Date.now()}`,
      messages,
      tools: offered,
      provider: pinned,
    });
    turns.push(measure);
    printTurn(arm, measure);
    // The scripted answer, so both arms carry the same history into the next turn.
    conversation.push({
      id: `r${turn}`,
      role: "assistant",
      content: "네, 확인해서 정리해 드릴게요.",
    });
  }

  return { arm, turns, ...laterOf(turns) };
}

const tools = await toolsOf();

const dayArms: DayArmMeasure[] = [];
if (CASES.includes("days")) {
  const chosen = (process.env.EVAL_DAYS_ARMS ?? DAY_ARMS.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter((name): name is DayArm =>
      (DAY_ARMS as readonly string[]).includes(name),
    );
  console.log(
    `\ndays · model ${MODEL} · provider ${PROVIDER ?? "routed"} · ${tools.length} tools · arms ${chosen.join(", ")}\n`,
  );
  for (const arm of chosen) {
    dayArms.push(
      await measureDays({
        arm,
        model: MODEL,
        tools,
        provider: PROVIDER,
        key: process.env.OPENAI_API_KEY ?? "",
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1",
      }),
    );
  }
  console.log("\ndays:");
  for (const measured of dayArms) {
    const pct = (value: number | null) =>
      value === null ? "—" : `${(value * 100).toFixed(1)}%`;
    const firsts = measured.firstMessageLatencyMs
      .slice(1)
      .sort((a, b) => a - b);
    console.log(
      `  ${measured.arm.padEnd(8)} day-7 prompt ${measured.day7PromptMean ?? "—"}` +
        `  cache ${pct(measured.cacheShare)} (warm ${pct(measured.warmCacheShare)})` +
        `  $/day ${measured.costPerDay.map((cost) => cost.toFixed(4)).join(" ")}` +
        `  first-of-day median ${firsts[Math.floor(firsts.length / 2)] ?? "—"}ms` +
        `  needles supplier ${measured.needles.supplier ? "kept" : "LOST"} refund ${measured.needles.refund ? "kept" : "LOST"}`,
    );
  }
}
const history = weekOfHistory();
console.log(
  `\ncache alignment · model ${MODEL} · provider ${PROVIDER ?? "routed"} · ${tools.length} tools` +
    `\na week of history (${history.length} messages), then ${TURNS} turns ${GAP_MINUTES} min apart, the 4th on a new day\n`,
);

const arms: ArmMeasure[] = [];
for (const arm of CASES.includes("week") ? CHOSEN : []) {
  arms.push(await measureArm(arm, tools, history));
}
if (CASES.includes("browsing")) {
  console.log(
    `\nbrowsing: one question, ${browsingSteps().length} steps, each request measured\n`,
  );
  arms.push(await measureBrowsing(tools));
}

console.log("\nturns 2+:");
for (const measured of arms) {
  console.log(
    `  ${measured.arm.padEnd(8)} ${measured.laterShare === null ? "cache not reported" : `${(measured.laterShare * 100).toFixed(1)}% from cache`}` +
      `  $${measured.laterCostPerRequest?.toFixed(5) ?? "—"}/request` +
      `  $${measured.totalCostUsd.toFixed(5)} in all` +
      `  prefix reuse ${measured.prefixReuse === null ? "—" : `${(measured.prefixReuse * 100).toFixed(1)}%`}` +
      `  median ${measured.laterMedianLatencyMs ?? "—"}ms`,
  );
}

const daily = dayArms.find((measured) => measured.arm === "daily");
const daysPass =
  daily === undefined ||
  (daily.needles.supplier &&
    daily.needles.refund &&
    daily.requests.every((request) => request.problem === null));
const epoch = arms.find((measured) => measured.arm === "epoch");
const browsing = arms.find((measured) => measured.arm === "browsing");
const pass =
  daysPass &&
  (epoch === undefined ||
    (epoch.laterShare !== null && epoch.laterShare >= TARGET_SHARE)) &&
  (browsing === undefined ||
    (browsing.laterShare !== null &&
      browsing.laterShare >= BROWSING_TARGET_SHARE));
const answered = arms.every((measured) =>
  measured.turns.every((turn) => turn.problem === null),
);
console.log(
  `\nverdict: ${pass && answered ? "PASS" : "FAIL"} (epoch arm ≥ ${TARGET_SHARE * 100}%, browsing ≥ ${BROWSING_TARGET_SHARE * 100}% from cache on requests 2+)`,
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
  browsingCarriesReasoning: CARRY_REASONING,
  tools: tools.length,
  arms,
  days: dayArms,
};
mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
const reportPath = new URL(
  `./reports/cache-${MODEL.replace(/[^a-zA-Z0-9.-]/g, "_")}-${report.ranAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url,
);
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: ${reportPath.pathname}\n`);
process.exit(pass && answered ? 0 : 1);
