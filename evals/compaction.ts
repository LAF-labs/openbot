/**
 * Compaction, measured three (and more) ways against each other on a Korean conversation
 * (~/laf/docs/jev-oss-evaluation.md §4.1; agent-harness-design row 9).
 *
 * THE CASE: three days of one Bot's conversation — order lists opened again and again, element
 * snapshots, and order details — about 60K tokens. On day one the Bot read order 20260046's detail,
 * which holds its refund reason, and told the person only the amount. That is the evaluation's run
 * 6: the detail nobody restated. Days two and three read other orders, one with a different refund
 * reason (a distractor). The last messages before the compaction are the person coming back to the
 * 20260046 refund, so the goal a judge reads is the one that needs the detail.
 *
 * THE ARMS, each on a fresh thread and a nonce in the first tool (no arm reads another's cache):
 *   none             no compaction — the control
 *   latest-snapshot  the deterministic rule
 *   jev-blind        fast-jev-compaction as upstream ships it: results judged from `ok, N chars`
 *   jev-excerpt      ours: each result shown to Jev as a redacted excerpt
 *   model-excerpt    the same questions answered by the deployment's model (the switch's off side)
 *
 * WHAT IS MEASURED per arm: the prompt before and after; NEEDLE RECALL — asked, after compaction,
 * for 20260046's refund reason from the conversation, does the Bot say "파손"; the share read from
 * cache over the five requests after the compaction's cold one; dollars for the whole arm.
 *
 *   bun --env-file=.env evals/compaction.ts    EVAL_RUNS=2 EVAL_CACHE_PROVIDER=z-ai EVAL_ARMS=…
 *
 * Reports land in evals/reports/ (not committed). A measurement, not a gate.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { runAgent } from "../agent-bot/src/index";
import {
  type CompletionProvider,
  liveProvider,
} from "../agent-bot/src/provider";
import { jevAsker, modelAsker } from "../server/src/computer/decision-askers";
import {
  type Compactor,
  createCompactor,
} from "../server/src/context/compaction";
import { createConversationStore } from "../server/src/context/conversations";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../shared/prompt";
import { HARNESS_VERSION } from "../shared/prompt/harness";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
import { SELF_TOOLS } from "../shared/tools/self";
import { SKILL_VIEW } from "../shared/tools/skills";
import { type Msg, thread } from "./compaction-thread";
import { eventsOfSse } from "./lib";
import {
  EVAL_BOT,
  EVAL_MEMORIES,
  EVAL_STANDING_ROLE,
  EVAL_TIME_ZONE,
} from "./prompt";

const ALL_ARMS = [
  "none",
  "latest-snapshot",
  "jev-blind",
  "jev-excerpt",
  "model-excerpt",
] as const;
type Arm = (typeof ALL_ARMS)[number];

const MODEL = process.env.BOT_MODEL?.trim() ?? "";
const KEY = process.env.OPENAI_API_KEY ?? "";
const BASE = process.env.OPENAI_BASE_URL ?? "";
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? "2") || 2);
const PROVIDER = process.env.EVAL_CACHE_PROVIDER?.trim() || null;
const JEV_MODEL = process.env.EVAL_JEV_MODEL ?? "typesafe/jev-1.13-20260917";
const CHOSEN = (process.env.EVAL_ARMS ?? ALL_ARMS.join(","))
  .split(",")
  .map((arm) => arm.trim())
  .filter((arm): arm is Arm => (ALL_ARMS as readonly string[]).includes(arm));

if (!KEY || !MODEL) {
  console.error("Needs OPENAI_API_KEY and BOT_MODEL.");
  process.exit(1);
}

const NEEDLE_WORD = "파손";

const AFTER: string[] = [
  "20260046번 주문 환불 사유가 뭐였지? 페이지를 다시 열지 말고, 우리 대화에 있던 걸로 한 줄로만 답해줘. 모르면 모른다고 해.",
  "고마워.",
  "오늘 할 일 두 가지만 말해줘.",
  "좋아.",
  "그럼 이따 봐.",
];

type Turn = {
  label: string;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  costUsd: number | null;
  text: string;
  problem: string | null;
};

async function ask(
  threadId: string,
  messages: unknown[],
  tools: unknown[],
  provider: CompletionProvider,
  label: string,
): Promise<Turn> {
  try {
    const response = await runAgent(
      {
        threadId,
        runId: `compaction_${label}_${Date.now()}`,
        messages,
        tools,
        context: [],
        state: {},
        forwardedProps: {
          effort: "balanced",
          botId: EVAL_BOT.id,
          timeZone: EVAL_TIME_ZONE,
        },
      } as never,
      provider,
    );
    const events = eventsOfSse(await response.text());
    const usage = events.find(
      (event) => event.type === "CUSTOM" && event.name === "laf.model.usage",
    )?.value as Record<string, unknown> | undefined;
    const number = (key: string) =>
      typeof usage?.[key] === "number" ? (usage[key] as number) : null;
    const text = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta ?? "")
      .join("");
    const error = events.find((event) => event.type === "RUN_ERROR");
    return {
      label,
      promptTokens: number("promptTokens"),
      cachedPromptTokens: number("cachedPromptTokens"),
      costUsd: number("costUsd"),
      text,
      problem: error ? String(error.message) : null,
    };
  } catch (error) {
    return {
      label,
      promptTokens: null,
      cachedPromptTokens: null,
      costUsd: null,
      text: "",
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

const apiKey = async () => KEY;
const standIn = modelAsker(
  { baseUrl: BASE, model: MODEL, apiKey, supportsEffort: true },
  { timeoutMs: 120_000 },
);
const jev = jevAsker(
  { baseUrl: "https://openrouter.ai/api", model: JEV_MODEL, apiKey },
  { timeoutMs: 20_000, purpose: "eval-compaction" },
);

function compactorFor(arm: Arm): Compactor | null {
  if (arm === "none") return null;
  if (arm === "latest-snapshot") {
    return createCompactor({ mode: "latest-snapshot" });
  }
  return createCompactor({
    mode: "decisions",
    asker: arm === "model-excerpt" ? standIn : jev,
    excerpts: arm !== "jev-blind",
    onFallback: (reason) => console.log(`    (${arm} fell back: ${reason})`),
  });
}

type ArmResult = {
  arm: Arm;
  run: number;
  promptBefore: number | null;
  promptAfter: number | null;
  recalled: boolean;
  answer: string;
  laterShare: number | null;
  costUsd: number;
  compactMs: number;
  turns: Turn[];
};

async function measure(arm: Arm, run: number): Promise<ArmResult> {
  const nonce = randomUUID().slice(0, 8);
  const tools = [...COMPUTER_TOOLS, ...SELF_TOOLS, SKILL_VIEW].map(
    (tool, at) => ({
      name: tool.name,
      description:
        at === 0 ? `${tool.description} [${nonce}]` : tool.description,
      parameters: tool.parameters,
    }),
  );
  const threadId = `thread_compaction_${arm}_${nonce}`;
  const compact = compactorFor(arm);
  const store = createConversationStore(
    compact ? { compaction: { thresholdTokens: 1e12, compact } } : {},
  );
  const provider: CompletionProvider = (request, options) =>
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
  const conversation: Msg[] = thread();
  const send = (label: string) => {
    const prepared = store.prepare({
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
    });
    return ask(
      threadId,
      [
        { id: "laf-prompt:eval_bot", role: "system", content: prepared.system },
        ...prepared.messages,
      ],
      tools,
      provider,
      label,
    );
  };

  const turns: Turn[] = [];
  conversation.push({
    id: "u_pre",
    role: "user",
    content: "잠깐, 지금 몇 건 남았지?",
  });
  turns.push(await send("before"));
  conversation.push({
    id: "s_pre",
    role: "assistant",
    content: "확인해 볼게요.",
  });
  const compactStarted = performance.now();
  if (compact) await store.compactNow(threadId);
  const compactMs = Math.round(performance.now() - compactStarted);

  for (const [at, question] of AFTER.entries()) {
    conversation.push({ id: `u_after${at}`, role: "user", content: question });
    turns.push(await send(`after${at + 1}`));
    // The scripted reply keeps every arm's history the same after the question.
    conversation.push({
      id: `s_after${at}`,
      role: "assistant",
      content: "네.",
    });
  }
  const answer = turns[1]?.text ?? "";
  const later = turns
    .slice(2)
    .filter(
      (turn) => turn.promptTokens !== null && turn.cachedPromptTokens !== null,
    );
  const prompt = later.reduce((sum, turn) => sum + (turn.promptTokens ?? 0), 0);
  const cached = later.reduce(
    (sum, turn) => sum + (turn.cachedPromptTokens ?? 0),
    0,
  );
  return {
    arm,
    run,
    promptBefore: turns[0]?.promptTokens ?? null,
    promptAfter: turns[1]?.promptTokens ?? null,
    recalled: answer.includes(NEEDLE_WORD),
    answer: answer.slice(0, 200),
    laterShare: prompt > 0 ? cached / prompt : null,
    costUsd: turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
    compactMs,
    turns,
  };
}

console.log(
  `compaction · model ${MODEL} · provider ${PROVIDER ?? "routed"} · ${RUNS} runs · arms ${CHOSEN.join(", ")}`,
);
const results: ArmResult[] = [];
for (let run = 1; run <= RUNS; run += 1) {
  for (const arm of CHOSEN) {
    const result = await measure(arm, run);
    results.push(result);
    console.log(
      `  ${arm.padEnd(16)} run ${run}  prompt ${result.promptBefore ?? "—"} → ${result.promptAfter ?? "—"}` +
        `  needle ${result.recalled ? "RECALLED" : "lost"}  cache after ${result.laterShare === null ? "—" : `${(result.laterShare * 100).toFixed(1)}%`}` +
        `  $${result.costUsd.toFixed(5)}  compact ${result.compactMs}ms` +
        (result.turns.some((turn) => turn.problem)
          ? `  · ${result.turns.find((turn) => turn.problem)?.problem}`
          : ""),
    );
    console.log(`    answer: ${result.answer.replace(/\s+/g, " ")}`);
  }
}

console.log("\nby arm:");
for (const arm of CHOSEN) {
  const mine = results.filter((result) => result.arm === arm);
  const recalled = mine.filter((result) => result.recalled).length;
  const shares = mine
    .map((result) => result.laterShare)
    .filter((share): share is number => share !== null);
  const after = mine
    .map((result) => result.promptAfter)
    .filter((value): value is number => value !== null);
  console.log(
    `  ${arm.padEnd(16)} needle ${recalled}/${mine.length}` +
      `  prompt after ${after.length ? Math.round(after.reduce((a, b) => a + b, 0) / after.length) : "—"}` +
      `  cache after ${shares.length ? `${((shares.reduce((a, b) => a + b, 0) / shares.length) * 100).toFixed(1)}%` : "—"}` +
      `  $${(mine.reduce((sum, result) => sum + result.costUsd, 0) / mine.length).toFixed(5)}/arm-run`,
  );
}

const report = {
  ranAt: new Date().toISOString(),
  model: MODEL,
  provider: PROVIDER,
  jevModel: JEV_MODEL,
  runs: RUNS,
  results,
};
mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
const path = new URL(
  `./reports/compaction-${report.ranAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url,
);
await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: ${path.pathname}`);
process.exit(0);
