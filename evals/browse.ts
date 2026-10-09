/**
 * Browsing, measured on real sites — steps, tokens per step, dollars and seconds per task, and how
 * the model asked for its steps: one a reply, or several.
 *
 * The model pack (`run.ts`) answers every computer call with a canned page, which is right for
 * certifying a model and says nothing about what browsing costs. This runs THE PRODUCT'S LOOP
 * (`runTurnLoop`, the one a chat turn and a routine both run on) over the real pieces: `agent-bot`'s
 * `runAgent` in this process behind the composed prompt, every computer call through the server's
 * own gateway (`createComputerGateway`, the deployment's default policy) and the routine executor's
 * result shaping (`createUnattendedTools`), against a running `agent-computer`.
 *
 * It used to carry a loop of its own, written by hand: ask, execute each call, file, ask again. So
 * nothing the product's loop does applied inside it — the round-stop rule (`round-stop.ts`: several
 * browser steps in one reply stop where one of them stops), the answer for arguments that do not
 * parse, the budget's last turn, the step record. A measurement taken there was not a measurement
 * of the product, and the question this now answers — does the model batch its steps, and what
 * happens to a form when it does — could not be asked of it at all.
 *
 *   BOT_MODEL=xiaomi/mimo-v2.6-pro BROWSE_COMPUTER_URL=http://localhost:6801 \
 *   COMPUTER_TOKEN=… bun run eval:browse
 *
 * `BROWSE_TASKS=naver-weather,news` picks tasks; `BROWSE_RUNS=2` repeats each; `BROWSE_SKILLS=off`
 * leaves the built-in skills out of the prompt and the executor, for a before/after on them.
 * `BROWSE_INVITE=off` takes the base's paragraph inviting several steps in one reply back out of
 * the prompt (`withoutInvitation`, `browse-measure.ts`) — the arm the product's prompt was measured
 * against on 2026-10-05, kept for the day the question is asked again. `BROWSE_BOT` names the Bot
 * whose browser is driven (its tab is its own), and `BROWSE_REPORT_DIR` where the report is written.
 *
 * Success is judged by a pattern on the final answer plus the absence of a give-up, and every answer
 * is printed so a person reads them too: a pattern is a floor, not a verdict. A form is judged by
 * what the SITE says it received: sent once, every asked field as asked, nothing else filled.
 * Reports land in evals/reports/ (local only). Real sites change daily; compare arms run minutes
 * apart, not days.
 *
 * WHAT THIS DOES NOT MEASURE.
 *
 * - No high-risk reviewer. Production's gateway is handed one (`highRisk` in `server/src/main.ts`,
 *   `computer/high-risk.ts`): once a name, a telephone or an e-mail has been typed, a press is put
 *   to a judge that may stop to ask the person — on a radio or a checkbox too. The gateway here has
 *   the default policy and nothing else, so a form raises fewer questions than it would deployed.
 * - A chat's prompt and tool list over a routine's executor. The model is told it is in a
 *   conversation and offered the chat surface's tools, and `createUnattendedTools` carries them out:
 *   `computer_request_help`, `computer_request_secret` and the self tools answer `laf:tool_unknown`.
 * - The person. A form task's one question — the press on its send button — is answered yes by the
 *   eval, at once (`execute` in `runTask`). A person takes seconds or minutes; a routine has nobody,
 *   reads `laf:nobody_answered`, and its form is not sent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { runAgent } from "../agent-bot/src/index";
import { liveProvider } from "../agent-bot/src/provider";
import { shippedAskRuleOf } from "../shared/policy-rules";
import { resolveTimeZone } from "../shared/prompt";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
import { NOW_TOOL } from "../shared/tools/now";
import { SELF_TOOLS } from "../shared/tools/self";
import { SKILL_VIEW } from "../shared/tools/skills";
import { createApprovalRegistry } from "../server/src/computer/approvals";
import { createComputerClient } from "../server/src/computer/client";
import { DEFAULT_ACTION_POLICY } from "../server/src/computer/default-policy";
import { createComputerGateway } from "../server/src/computer/gateway";
import {
  type LoopAgent,
  type LoopExecutor,
  runTurnLoop,
  type TurnLoopOptions,
  UnattendedRunError,
  type UnattendedStep,
  unanswered,
} from "../server/src/runner/turn-loop";
import { createUnattendedTools } from "../server/src/runner/unattended";
import { createRunMeter } from "../server/src/telemetry/run-meter";
import { modelUsageOf } from "../server/src/usage/model-usage";
import {
  ANSWER_JUDGES,
  answerPasses,
  echoedForm,
  echoedSends,
  GAVE_UP,
  judgeForm,
  roundStats,
  roundsOf,
  withoutInvitation,
} from "./browse-measure";
import { clientMessagesOf, eventsOfSse } from "./lib";
import { EVAL_TIME_ZONE, systemMessageFor } from "./prompt";

type Task = { id: string; ask: string } & (
  | {
      /** What a right answer has to contain. */
      expects: RegExp | ((answer: string) => boolean);
      /**
       * Also fails an answer that says it could not. Only where `expects` is weak — a name, prose —
       * since a price or a temperature is its own proof, and "쿠팡은 막혀 있어 가격비교에서 찾았어요" with
       * a price in it is the right answer.
       */
      strict?: true;
    }
  | {
      /**
       * A form the task fills and sends, on a site that answers with what it received.
       *
       * `asked`: each name is a field of the form and each value what the ask says to put there.
       * The run passes when the form was sent once and the site's echo holds exactly these
       * (`judgeForm`, `browse-measure.ts`).
       *
       * `send`: the name on the button that sends it. A person asked for this form to be sent, so
       * the eval answers the boundary's question about THAT press as the person would, and no
       * other question — see `execute` in `runTask`.
       */
      form: { asked: Readonly<Record<string, string>>; send: string };
    }
);

export const TASKS: readonly Task[] = [
  {
    id: "naver-weather",
    ask: "네이버에서 서울 오늘 날씨 확인해서 지금 기온이랑 오늘 최저/최고 기온 알려 줘.",
    ...ANSWER_JUDGES["naver-weather"],
  },
  {
    id: "naver-search",
    ask: "네이버에서 '성수동 브런치 카페' 검색해서 나오는 가게 이름 세 개만 알려 줘.",
    ...ANSWER_JUDGES["naver-search"],
  },
  {
    id: "naver-shopping",
    ask: "네이버 쇼핑에서 '무선 마우스' 검색해서 상품 세 개를 가격이랑 같이 알려 줘.",
    ...ANSWER_JUDGES["naver-shopping"],
  },
  {
    id: "coupang",
    ask: "쿠팡에서 '생수 2L' 검색해서 맨 위 상품 이름이랑 가격 알려 줘.",
    ...ANSWER_JUDGES.coupang,
  },
  {
    id: "news",
    ask: "네이버 뉴스 경제 섹션에서 맨 위 기사 하나 열어서 세 줄로 요약해 줘.",
    ...ANSWER_JUDGES.news,
  },
  {
    id: "blog",
    ask: "네이버 블로그에서 '제주 흑돼지 맛집' 검색해서 첫 번째 글을 열고 추천한 가게 이름이랑 이유를 알려 줘.",
    ...ANSWER_JUDGES.blog,
  },
  /*
   * THE FORM THAT CAN SHOW BATCHING: six fields nothing about which depends on another, and a press
   * under them. httpbin's practice form answers its POST with a JSON echo of what arrived, so the
   * run is judged from the far end — the only place a value in the wrong field can be seen at all.
   * Every value is made up, and `example.com` is nobody's.
   *
   * Its button reads "Submit order", which the default policy stops to ask about
   * (`MONEY_WORD_RULE`); see `execute`.
   */
  {
    id: "httpbin-form",
    ask: "https://httpbin.org/forms/post 는 연습용 피자 주문 양식이야. 이렇게 채워서 제출해 줘. 이름(Customer name): 홍길동 / 전화(Telephone): 010-0000-0000 / 이메일(E-mail address): gildong@example.com / 크기(Pizza Size): Medium / 토핑(Pizza Toppings): Mushroom 하나만 / 배달 요청(Delivery instructions): 문 앞에 놓아 주세요 / 배달 시간(Preferred delivery time)은 비워 둬. 제출하면 사이트가 받은 값을 그대로 보여 주니까, 뭐라고 받았는지 알려 줘.",
    form: {
      asked: {
        custname: "홍길동",
        custtel: "010-0000-0000",
        custemail: "gildong@example.com",
        size: "medium",
        topping: "mushroom",
        comments: "문 앞에 놓아 주세요",
      },
      send: "Submit order",
    },
  },
];

const MODEL = process.env.BOT_MODEL?.trim() ?? "";
const COMPUTER_URL =
  process.env.BROWSE_COMPUTER_URL?.trim() || "http://localhost:6801";
const RUNS = Math.max(1, Number(process.env.BROWSE_RUNS ?? "1") || 1);
const SKILLS = process.env.BROWSE_SKILLS?.trim() !== "off";
const INVITE = process.env.BROWSE_INVITE?.trim() !== "off";
const LABEL =
  process.env.BROWSE_LABEL?.trim() ||
  `${SKILLS ? "skills" : "bare"}${INVITE ? "" : "-no-invite"}`;
const BOT_ID = process.env.BROWSE_BOT?.trim() || "browse_eval";
const REPORT_DIR = process.env.BROWSE_REPORT_DIR?.trim() || "evals/reports";
/** The loop's bound on a lost Bot: past it every call is answered `laf:tool_budget_spent`. */
const MAX_STEPS = 16;
const TASK_TIMEOUT_MS = 300_000;
/** Whoever the Bot works for, in this eval: the name on the gateway's calls and on its answers. */
const PERSON = { id: "eval-person" };
/**
 * Where a form run's tab is put before it starts, so the page a run ends on is this run's doing:
 * the echo is read off the tab afterwards, and the last run's echo would still be sitting there.
 */
const NEUTRAL_PAGE = "https://example.com/";

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

const client = createComputerClient({
  baseUrl: COMPUTER_URL,
  ...(process.env.COMPUTER_TOKEN ? { token: process.env.COMPUTER_TOKEN } : {}),
});

/** The skills a deployment ships, answered the way the store answers them — grant included. */
const skillStore = {
  offeredToModel: async () => ({ tools: [], skills: [] }),
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

/** The chat surface's list: every computer tool, the self tools, the clock, and skills when held. */
const tools = [
  ...COMPUTER_TOOLS,
  ...SELF_TOOLS,
  NOW_TOOL,
  // Always, as the surface offers it whether or not the Bot holds a skill (CLAUDE.md, rows 1–5).
  SKILL_VIEW,
] as unknown as TurnLoopOptions["tools"];

const composed = SKILLS
  ? systemMessageFor("chat", undefined, undefined, BUILT_IN_SKILLS)
  : systemMessageFor("chat");
/*
 * The product's prompt, or — `BROWSE_INVITE=off` — the same composed message with the paragraph
 * about several steps in one reply taken out of the base (`withoutInvitation`).
 */
const SYSTEM = INVITE
  ? composed
  : { ...composed, content: withoutInvitation(composed.content) };

type Messages = LoopAgent["messages"];
type LoopEvent = Parameters<NonNullable<TurnLoopOptions["observe"]>>[0];

/**
 * The Bot service, in this process, as the loop's agent.
 *
 * The product reaches `agent-bot` over HTTP through `@ag-ui/client`; here `runAgent` is called
 * directly with what that client would have posted, its stream is replayed to the loop's subscriber,
 * and the messages it produced are filed as the client files them (`clientMessagesOf` — the tool
 * calls under their reply, the answers the service gave inside the run, the reasoning a tool-call
 * turn carries). The hand-written loop built its own assistant message and dropped the last of those.
 */
function inProcessAgent(threadId: string): LoopAgent & { messages: Messages } {
  let cancel: (() => void) | undefined;
  const agent = {
    messages: [] as Messages,
    setMessages(messages: Messages) {
      agent.messages = [...messages];
    },
    addMessage(message: Messages[number]) {
      agent.messages.push(message);
    },
    /** The loop's deadline: the reader goes, and the service stops paying for the request. */
    abortRun() {
      cancel?.();
    },
    async runAgent(
      parameters?: {
        runId?: string;
        tools?: unknown;
        forwardedProps?: unknown;
      },
      subscriber?: {
        onEvent?: (seen: never) => unknown;
        onRunErrorEvent?: (seen: never) => unknown;
        onRunFinishedEvent?: (seen: never) => unknown;
      },
    ) {
      const response = await runAgent(
        {
          threadId,
          runId: parameters?.runId ?? `browse_${crypto.randomUUID()}`,
          messages: agent.messages,
          tools: parameters?.tools ?? [],
          context: [],
          state: {},
          forwardedProps: parameters?.forwardedProps ?? {},
        } as never,
        liveProvider,
      );
      let body = "";
      const reader = response.body?.getReader();
      if (reader) {
        cancel = () => void reader.cancel().catch(() => undefined);
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
        cancel = undefined;
      }
      const events = eventsOfSse(body);
      for (const event of events) {
        await subscriber?.onEvent?.({ event } as never);
        if (event.type === "RUN_ERROR") {
          await subscriber?.onRunErrorEvent?.({ event } as never);
        }
        if (event.type === "RUN_FINISHED") {
          await subscriber?.onRunFinishedEvent?.({ event } as never);
        }
      }
      const added = clientMessagesOf(events) as unknown as Messages;
      agent.messages.push(...added);
      return { result: undefined, newMessages: added };
    },
  };
  return agent as unknown as LoopAgent & { messages: Messages };
}

type Step = {
  prompt: number;
  cached: number;
  completion: number;
  cost: number;
  calls: string[];
  resultChars: number;
  /**
   * The start of each result, for reading a failure afterwards. Never a typed value: the computer
   * echoes none. A page that prints what it was sent — the echo a form task ends on — is read like
   * any page, and what it prints are this file's own made-up values.
   */
  results: string[];
  /** Model requests in this turn; zero when the provider reported no usage. */
  requests: number;
  /** Wall-clock milliseconds the model took for this turn, as the loop's own record has it. */
  ms: number;
};

const emptyStep = (): Step => ({
  prompt: 0,
  cached: 0,
  completion: 0,
  cost: 0,
  calls: [],
  resultChars: 0,
  results: [],
  requests: 0,
  ms: 0,
});

async function runTask(task: Task) {
  /*
   * A GATEWAY PER RUN. It holds the repeat counter (`computer/repeat.ts`), which is right for a
   * deployment and wrong across runs of an eval: the fifth run inside three minutes opens the same
   * address and types into the same refs as the four before it, and the default policy would stop
   * to ask whether the Bot is stuck. Each run is somebody's one task, so each starts uncounted.
   */
  const approvals = createApprovalRegistry();
  const gateway = createComputerGateway({
    client,
    auditStore: { insert: async () => undefined },
    policy: () => DEFAULT_ACTION_POLICY,
    approvals,
  });
  const toolkit = await createUnattendedTools({
    gateway,
    ...(SKILLS ? { pluginStore: skillStore as never } : {}),
  })(BOT_ID, PERSON);

  /** The questions the boundary raised, by the rule that raised each. */
  const asks: Record<string, number> = {};
  /** Of those, the ones the eval answered yes: the press on a form task's send button. */
  let asksAnswered = 0;
  /**
   * The routine executor, with the person a form task has — for one question.
   *
   * Nobody answers a routine's question, so a held step comes back `laf:nobody_answered` and the
   * run goes on without it — which the tasks judged by their answer keep, as they always ran. A
   * form task is somebody asking for this form to be SENT, and the default policy stops at its
   * button; in the product that is a card, and the person who asked says yes. So the yes is given
   * here, through the same registry the gateway asked in, and the call is sent again carrying it —
   * what chat's `governed` does after a person's answer (`turns/chat-tools.ts`).
   *
   * ONLY THAT QUESTION: the money-word rule, about the button the task names. It answered every
   * question once, and a Bot going round in a form — the repeat rule asking whether it is stuck —
   * would have been waved on by the eval and the run counted as clean. Any other question stays
   * unanswered, as a routine's does. Every question is counted either way.
   */
  const execute: LoopExecutor = async (name, args, call) => {
    const outcome = await toolkit.execute(name, args, call);
    if (outcome.awaitingApproval !== true) return outcome;
    const rule =
      shippedAskRuleOf(
        typeof outcome.rule === "string" ? outcome.rule : null,
      ) ?? "other";
    asks[rule] = (asks[rule] ?? 0) + 1;
    const pressed = (outcome.subject as { element?: { name?: unknown } })
      ?.element?.name;
    if (
      !("form" in task) ||
      rule !== "money_word" ||
      typeof pressed !== "string" ||
      pressed.trim().toLowerCase() !== task.form.send.toLowerCase() ||
      typeof outcome.approvalId !== "string"
    ) {
      return outcome;
    }
    asksAnswered += 1;
    const answered = await approvals.answer(
      outcome.approvalId,
      BOT_ID,
      PERSON.id,
      true,
    );
    if (!answered.ok) return outcome;
    return toolkit.execute(name, args, {
      ...call,
      approvalId: outcome.approvalId,
    });
  };

  /*
   * Kept, and part of the verdict: a form run whose tab could not be put on the neutral page may
   * still be standing on the run before's echo, and what is read off it afterwards proves nothing.
   */
  const startedClean =
    "form" in task
      ? (
          await toolkit.execute(
            "computer_navigate",
            { url: NEUTRAL_PAGE },
            { id: "browse_before" },
          )
        ).ok
      : true;

  const started = performance.now();
  const agent = inProcessAgent(`thread_browse_${task.id}_${started}`);
  agent.setMessages([
    SYSTEM,
    { id: `u_${task.id}`, role: "user", content: task.ask },
  ] as Messages);

  /*
   * ONE STEP PER TURN OF THE LOOP, THE TURN'S REQUESTS SUMMED INTO IT. A step used to be a usage
   * event, and a turn whose provider sent no usage (seen once on mimo, 2026-09-25) vanished from the
   * count while its tool call was pinned on the step before it. A turn's events arrive before the
   * loop says the step is back (`onStep`), and its tools' results after.
   */
  const steps: Step[] = [];
  let open: Step | null = null;
  const current = () => {
    open ??= emptyStep();
    return open;
  };
  /** The ledger's own reading of the run: requests, calls, tokens, dollars (`run-meter.ts`). */
  const meter = createRunMeter();
  /** Who served each request. OpenRouter routes one model over many, and not all batch alike. */
  const providers: Record<string, number> = {};
  const noteResult = (step: Step, content: string) => {
    step.resultChars += content.length;
    step.results.push(content.slice(0, 400));
  };
  const observe = (event: LoopEvent) => {
    meter.observe(event);
    const seen = event as unknown as {
      type: string;
      toolCallName?: string;
      content?: string;
    };
    if (seen.type === "TOOL_CALL_START") {
      current().calls.push(seen.toolCallName ?? "");
    }
    // A call the Bot service answered inside the run: its answer is part of what the turn read.
    if (seen.type === "TOOL_CALL_RESULT") {
      noteResult(current(), seen.content ?? "");
    }
    for (const usage of modelUsageOf([event])) {
      const step = current();
      step.prompt += usage.promptTokens;
      step.cached += usage.cachedPromptTokens ?? 0;
      step.completion += usage.completionTokens;
      step.cost += usage.costUsd ?? 0;
      step.requests += 1;
      const provider = usage.provider ?? "unnamed";
      providers[provider] = (providers[provider] ?? 0) + 1;
    }
  };

  let turns: UnattendedStep[] = [];
  let failure: string | null = null;
  try {
    ({ steps: turns } = await runTurnLoop(agent, {
      tools,
      execute,
      timeoutMs: TASK_TIMEOUT_MS,
      maxSteps: MAX_STEPS,
      forwardedProps: {
        // What production sends: no effort by default (see `evals/run.ts`).
        ...(process.env.EVAL_EFFORT ? { effort: process.env.EVAL_EFFORT } : {}),
        timeZone: resolveTimeZone(EVAL_TIME_ZONE),
      },
      runIdFor: (run) => `browse_${task.id}_${run + 1}_${Date.now()}`,
      observe,
      onStep: () => {
        steps.push(current());
        open = null;
      },
      onToolResult: (message) => {
        const last = steps.at(-1);
        if (last) noteResult(last, String(message.content));
      },
    }));
  } catch (error) {
    // The turns it did take are kept: a run that died on its ninth says how it got there.
    if (error instanceof UnattendedRunError) turns = error.steps;
    failure = error instanceof Error ? error.message : String(error);
  }
  meter.end();
  const wallMs = performance.now() - started;
  for (const [index, turn] of turns.entries()) {
    const step = steps[index];
    if (step) step.ms = turn.ms;
  }

  // The last thing the Bot said, as a routine's answer is read (`runUnattended`).
  const said = agent.messages
    .filter((message) => message.role === "assistant")
    .map((message) =>
      typeof message.content === "string" ? message.content.trim() : "",
    )
    .filter(Boolean);
  const answer = failure ? `ERROR ${failure}` : (said.at(-1) ?? "");

  const measured = meter.read();
  const rounds = roundsOf(agent.messages);
  const base = {
    task: task.id,
    answer,
    steps,
    wallMs,
    /** Requests the model answered, as the ledger's `model_requests` counts them. */
    modelRequests: measured.modelRequests,
    toolCalls: measured.toolCalls,
    retries: measured.retries,
    ...roundStats(rounds),
    /** Each reply's calls in the order written, and whether each went through. */
    roundCalls: rounds,
    /**
     * Calls the thread ends with no answer to. Zero, or the loop broke its own rule: a step that was
     * not reached is still answered, because a provider refuses a conversation with a call left open.
     */
    unansweredCalls: unanswered(agent.messages).length,
    asks,
    asksAnswered,
    providers,
    /** The answer says it could not — counted on every task, a failure only on a `strict` one. */
    gaveUp: GAVE_UP.test(answer),
  };

  if (!("form" in task)) {
    const passed = failure === null && answerPasses(task, answer);
    return { ...base, passed };
  }

  /*
   * WHAT THE SITE RECEIVED. Read off the tab once the run is over, through the same executor, and
   * judged with every send this run's own thread holds (`judgeForm`): one send, on a tab that
   * started clean, with every asked field as asked and no other field filled.
   */
  const page = await toolkit.execute(
    "computer_read",
    { whole: true },
    { id: "browse_echo" },
  );
  const verdict = judgeForm({
    startedClean,
    sends: echoedSends(agent.messages),
    page: echoedForm(page),
    asked: task.form.asked,
  });
  return {
    ...base,
    ...verdict,
    passed: failure === null && verdict.passed,
    startedClean,
  };
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
    const result = await runTask(task);
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
    const asked = Object.entries(result.asks)
      .map(([rule, count]) => `${rule} ${count}`)
      .join(", ");
    console.log(
      `     requests ${result.modelRequests} · calls/round ${result.callsPerRound.join(",") || "-"} · batched rounds ${result.batchedRounds} · not reached ${result.notReached} · early presses ${result.earlyPresses}${result.unansweredCalls ? ` · UNANSWERED ${result.unansweredCalls}` : ""} · asks ${asked || "none"}${result.asksAnswered ? ` (answered ${result.asksAnswered})` : ""} · ${Object.keys(result.providers).join(", ") || "no provider named"}`,
    );
    if ("wrongFields" in result) {
      console.log(
        `     ${result.startedClean ? "" : "TAB NOT CLEAN · "}${result.echoed ? "echo" : "NO ECHO"} · sends ${result.sends} · wrong fields ${result.wrongFields.length}${result.wrongFields.length ? ` (${result.wrongFields.join(", ")})` : ""}${result.unaskedFields.length ? ` · unasked ${result.unaskedFields.join(", ")}` : ""}`,
      );
    }
    console.log(`     ${result.answer.replace(/\s+/g, " ").slice(0, 280)}\n`);
  }
}

mkdirSync(REPORT_DIR, { recursive: true });
const file = `${REPORT_DIR}/browse-${LABEL}-${MODEL.replace(/[^a-z0-9.-]+/gi, "_")}-${Date.now()}.json`;
writeFileSync(
  file,
  JSON.stringify(
    { model: MODEL, label: LABEL, invite: INVITE, results },
    null,
    2,
  ),
);
console.log(`report: ${file}`);
