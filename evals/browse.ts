/**
 * Browsing, measured on real Korean sites — steps, tokens per step, dollars and seconds per task.
 *
 * The model pack (`run.ts`) answers every computer call with a canned page, which is right for
 * certifying a model and says nothing about what browsing costs. This drives the same `agent-bot`
 * loop behind the same composed prompt, and executes every computer call for real: through the
 * server's own gateway (`createComputerGateway`, the deployment's default policy) and the routine
 * executor's result shaping (`createUnattendedTools`), against a running `agent-computer`. What the
 * model reads here is what a routine's model reads.
 *
 *   BOT_MODEL=xiaomi/mimo-v2.6-pro BROWSE_COMPUTER_URL=http://localhost:6801 \
 *   COMPUTER_TOKEN=… bun run eval:browse
 *
 * `BROWSE_TASKS=naver-weather,news` picks tasks; `BROWSE_RUNS=2` repeats each; `BROWSE_SKILLS=off`
 * leaves the built-in skills out of the prompt and the executor, for a before/after on them.
 *
 * Success is judged by a pattern on the final answer plus the absence of a give-up, and every answer
 * is printed so a person reads them too: a pattern is a floor, not a verdict. Reports land in
 * evals/reports/ (local only). Real sites change daily; compare arms run minutes apart, not days.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { runAgent } from "../agent-bot/src/index";
import { liveProvider } from "../agent-bot/src/provider";
import { resolveTimeZone } from "../shared/prompt";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
import { NOW_TOOL } from "../shared/tools/now";
import { SELF_TOOLS } from "../shared/tools/self";
import { SKILL_VIEW } from "../shared/tools/skills";
import { createComputerClient } from "../server/src/computer/client";
import { DEFAULT_ACTION_POLICY } from "../server/src/computer/default-policy";
import { createComputerGateway } from "../server/src/computer/gateway";
import { createUnattendedTools } from "../server/src/runner/unattended";
import { callsOf, eventsOfSse, resultsOf, textOf } from "./lib";
import { EVAL_TIME_ZONE, systemMessageFor } from "./prompt";

type Task = {
  id: string;
  ask: string;
  /** What a right answer has to contain. */
  expects: RegExp;
  /**
   * Also fails an answer that says it could not. Only where `expects` is weak — a name, prose — since
   * a price or a temperature is its own proof, and "쿠팡은 막혀 있어 가격비교에서 찾았어요" with a price
   * in it is the right answer.
   */
  strict?: true;
};

/** Phrases a Bot uses when it did not get the thing. A pass needs none of them. */
const GAVE_UP =
  /(확인하지 못|찾지 못|열리지 않|열 수 없|막혀|접근이 제한|차단|보이지 않았|가져오지 못|읽지 못|실패했)/;

export const TASKS: readonly Task[] = [
  {
    id: "naver-weather",
    ask: "네이버에서 서울 오늘 날씨 확인해서 지금 기온이랑 오늘 최저/최고 기온 알려 줘.",
    expects: /-?\d+(\.\d+)?\s*°|\d+\s*도/,
  },
  {
    id: "naver-search",
    ask: "네이버에서 '성수동 브런치 카페' 검색해서 나오는 가게 이름 세 개만 알려 줘.",
    expects: /[가-힣A-Za-z]{2,}/,
    strict: true,
  },
  {
    id: "naver-shopping",
    ask: "네이버 쇼핑에서 '무선 마우스' 검색해서 상품 세 개를 가격이랑 같이 알려 줘.",
    expects: /\d{1,3}(,\d{3})+\s*원|\d{4,}\s*원/,
  },
  {
    id: "coupang",
    ask: "쿠팡에서 '생수 2L' 검색해서 맨 위 상품 이름이랑 가격 알려 줘.",
    expects: /\d{1,3}(,\d{3})+\s*원|\d{4,}\s*원/,
  },
  {
    id: "news",
    ask: "네이버 뉴스 경제 섹션에서 맨 위 기사 하나 열어서 세 줄로 요약해 줘.",
    expects: /([가-힣]{2,}[^가-힣]+){12,}/,
    strict: true,
  },
  {
    id: "blog",
    ask: "네이버 블로그에서 '제주 흑돼지 맛집' 검색해서 첫 번째 글을 열고 추천한 가게 이름이랑 이유를 알려 줘.",
    expects: /([가-힣]{2,}[^가-힣]+){8,}/,
    strict: true,
  },
];

const MODEL = process.env.BOT_MODEL?.trim() ?? "";
const COMPUTER_URL =
  process.env.BROWSE_COMPUTER_URL?.trim() || "http://localhost:6801";
const RUNS = Math.max(1, Number(process.env.BROWSE_RUNS ?? "1") || 1);
const SKILLS = process.env.BROWSE_SKILLS?.trim() !== "off";
const LABEL = process.env.BROWSE_LABEL?.trim() || (SKILLS ? "skills" : "bare");
/** The routine's own bound, so a lost Bot costs what it would cost in the product and no more. */
const MAX_STEPS = 16;
const TASK_TIMEOUT_MS = 300_000;

const wanted = new Set(
  (process.env.BROWSE_TASKS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

if (!MODEL || !process.env.OPENAI_API_KEY) {
  console.error(
    "BOT_MODEL and OPENAI_API_KEY are required: this calls a real model.",
  );
  process.exit(1);
}

/*
 * Imported only when used, so this file also runs in a checkout from before the skills existed —
 * which is how the "before" arm of a comparison is run, on the same sites at the same hour.
 */
const BUILT_IN_SKILLS = SKILLS
  ? await (
      await import("../server/src/plugins/built-in-skills")
    ).readBuiltInSkills("tenant/laf")
  : [];

const botId = "browse_eval";
const gateway = createComputerGateway({
  client: createComputerClient({
    baseUrl: COMPUTER_URL,
    ...(process.env.COMPUTER_TOKEN
      ? { token: process.env.COMPUTER_TOKEN }
      : {}),
  }),
  auditStore: { insert: async () => undefined },
  policy: () => DEFAULT_ACTION_POLICY,
});

/** The skills a deployment ships, answered the way the store answers them — grant included. */
const skillStore = {
  listForAgent: async () => ({ tools: [], skills: [] }),
  callTool: async () => {
    throw new Error("no plugin tools in this eval");
  },
  viewSkill: async ({ slug }: { slug: string }) => {
    const skill = BUILT_IN_SKILLS.find(
      (entry) => entry.slug === slug.replace(/^\/+/, "").trim(),
    );
    return skill
      ? { allowed: true as const, skill }
      : { allowed: false as const, reason: "laf:skill_not_granted" };
  },
};

const toolkit = await createUnattendedTools({
  gateway,
  ...(SKILLS ? { pluginStore: skillStore as never } : {}),
})(botId, { id: "eval-person" });

/** The chat surface's list: every computer tool, the self tools, the clock, and skills when held. */
const tools = [
  ...COMPUTER_TOOLS,
  ...SELF_TOOLS,
  NOW_TOOL,
  // Always, as the surface offers it whether or not the Bot holds a skill (CLAUDE.md, rows 1–5).
  SKILL_VIEW,
];

type Step = {
  prompt: number;
  cached: number;
  completion: number;
  cost: number;
  calls: string[];
  resultChars: number;
  /** The start of each result, for reading a failure afterwards. Never a typed value: none is echoed. */
  results: string[];
  /** Model requests in this turn; zero when the provider reported no usage. */
  requests: number;
};

async function runTask(task: Task) {
  const started = performance.now();
  const system = systemMessageFor("chat");
  const messages: unknown[] = [
    SKILLS
      ? systemMessageFor("chat", undefined, undefined, BUILT_IN_SKILLS)
      : system,
    { id: `u_${task.id}`, role: "user", content: task.ask },
  ];
  const steps: Step[] = [];
  let answer = "";
  for (let turn = 1; turn <= MAX_STEPS; turn++) {
    const runId = `browse_${task.id}_${turn}_${Date.now()}`;
    const response = await runAgent(
      {
        threadId: `thread_browse_${task.id}_${started}`,
        runId,
        messages,
        tools,
        context: [],
        state: {},
        forwardedProps: {
          effort: process.env.EVAL_EFFORT ?? "balanced",
          timeZone: resolveTimeZone(EVAL_TIME_ZONE),
        },
      } as never,
      liveProvider,
    );
    const events = eventsOfSse(await response.text());
    /*
     * ONE STEP PER TURN, THE TURN'S REQUESTS SUMMED INTO IT. A step used to be a usage event, and a
     * turn whose provider sent no usage (seen once on mimo, 2026-09-25) vanished from the count while
     * its tool call was pinned on the step before it.
     */
    const step: Step = {
      prompt: 0,
      cached: 0,
      completion: 0,
      cost: 0,
      calls: [],
      resultChars: 0,
      results: [],
      requests: 0,
    };
    for (const event of events) {
      if (event.type !== "CUSTOM" || event.name !== "laf.model.usage") continue;
      const value = event.value ?? {};
      const n = (key: string) =>
        typeof value[key] === "number" ? (value[key] as number) : 0;
      step.prompt += n("promptTokens");
      step.cached += n("cachedPromptTokens");
      step.completion += n("completionTokens");
      step.cost += n("costUsd");
      step.requests += 1;
    }
    steps.push(step);
    const text = textOf(events);
    if (text.trim()) answer = text;
    const calls = callsOf(events);
    const answered = resultsOf(events);
    const open = calls.filter((call) => !answered.has(call.id));
    const last = step;
    last.calls = calls.map((call) => call.name);
    if (open.length === 0) break;
    messages.push({
      id: `a_${runId}`,
      role: "assistant",
      content: text,
      toolCalls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.rawArguments },
      })),
    });
    for (const call of calls) {
      const content =
        answered.get(call.id) ??
        JSON.stringify(
          await toolkit.execute(call.name, call.arguments ?? {}, {
            id: call.id,
          }),
        );
      if (last) {
        last.resultChars += content.length;
        last.results.push(content.slice(0, 400));
      }
      messages.push({
        id: `t_${call.id}`,
        role: "tool",
        toolCallId: call.id,
        content,
      });
    }
  }
  const wallMs = performance.now() - started;
  const passed =
    task.expects.test(answer) && !(task.strict && GAVE_UP.test(answer));
  return { task: task.id, passed, answer, steps, wallMs };
}

const selected = TASKS.filter(
  (task) => wanted.size === 0 || wanted.has(task.id),
);
const results: Awaited<ReturnType<typeof runTask>>[] = [];
console.log(
  `\nbrowse · ${MODEL} · ${LABEL} · ${selected.length} task(s) × ${RUNS} · computer ${COMPUTER_URL}\n`,
);
for (const task of selected) {
  for (let run = 1; run <= RUNS; run++) {
    const result = await Promise.race([
      runTask(task),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("task timed out")), TASK_TIMEOUT_MS),
      ),
    ]).catch((error: unknown) => ({
      task: task.id,
      passed: false,
      answer: `ERROR ${error instanceof Error ? error.message : String(error)}`,
      steps: [] as Step[],
      wallMs: TASK_TIMEOUT_MS,
    }));
    results.push(result);
    const prompt = result.steps.reduce((sum, step) => sum + step.prompt, 0);
    const cost = result.steps.reduce((sum, step) => sum + step.cost, 0);
    const perStep = result.steps.length
      ? Math.round(prompt / result.steps.length)
      : 0;
    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${task.id.padEnd(15)} steps ${String(result.steps.length).padStart(2)} · in/step ${String(perStep).padStart(6)} · $${cost.toFixed(4)} · ${(result.wallMs / 1000).toFixed(1)} s`,
    );
    console.log(
      `     ${result.steps.map((step) => `${step.calls.join("+") || "answer"}(${step.resultChars})`).join(" → ")}`,
    );
    console.log(`     ${result.answer.replace(/\s+/g, " ").slice(0, 280)}\n`);
  }
}

mkdirSync("evals/reports", { recursive: true });
const file = `evals/reports/browse-${LABEL}-${MODEL.replace(/[^a-z0-9.-]+/gi, "_")}-${Date.now()}.json`;
writeFileSync(
  file,
  JSON.stringify({ model: MODEL, label: LABEL, results }, null, 2),
);
console.log(`report: ${file}`);
