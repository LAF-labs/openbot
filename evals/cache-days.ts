/**
 * The `days` case of `eval:cache`: a week of one Bot's conversation, day by day, before and after
 * the day epochs (`server/src/context/day-close.ts`, one-bot-product-direction §4 item 3).
 *
 * THE CASE. Seven days on a simulated clock in the owner's zone. Each day: four person turns
 * (09:00, 11:00, 15:00, 19:00) and, after the second, one browsing step whose page result is a
 * whole page; every request is a real request through agent-bot's loop, with a scripted answer
 * appended so both arms carry the same conversation. Day 1 plants two needles the Bot never writes
 * to memory: a supplier delivery the owner states (한빛농산, 40 boxes, ₩23,000) and a refund reason
 * that only an order page held (파손). Day 5 asks for both, and the model's real answer is read.
 *
 * THE ARMS, each a fresh thread and the production store:
 *   lifelong  what shipped before: one epoch for life, the date as a reminder, the 30K threshold
 *             compaction (the existing decisions compactor) as the only relief
 *   daily     the same plus the day epochs: at 03:00 each night the store's own tick prepares the
 *             close (the existing compaction over the span, then the server model's summary), and
 *             the first message of the day takes it
 *
 * THE NIGHT IS MODELLED. The days pass in real minutes, so a provider would still hold yesterday's
 * prefix at "09:00" — which no real night does. Each arm's first tool carries a nonce that changes
 * every simulated day, so every first message of a day is cold in both arms, as it is in life.
 *
 * WHAT IS MEASURED: prompt tokens per request on day 7, the share read from cache (all requests,
 * and warm ones — not the first of a day), dollars per day (the close's own model calls priced in
 * for the daily arm, off the critical path but paid), the first message of each day's latency, and
 * the two needles.
 */

import { randomUUID } from "node:crypto";
import { runAgent } from "../agent-bot/src/index";
import {
  type CompletionProvider,
  liveProvider,
} from "../agent-bot/src/provider";
import {
  jevAsker,
  modelAsker,
  withFallback,
} from "../server/src/computer/decision-askers";
import { createCompactor } from "../server/src/context/compaction";
import { createConversationStore } from "../server/src/context/conversations";
import {
  createDaySummarizer,
  type StampedMessage,
} from "../server/src/context/day-close";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../shared/prompt";
import { HARNESS_VERSION } from "../shared/prompt/harness";
import { longPage } from "./fixtures";
import { eventsOfSse } from "./lib";
import {
  EVAL_BOT,
  EVAL_MEMORIES,
  EVAL_STANDING_ROLE,
  EVAL_TIME_ZONE,
} from "./prompt";

export const DAY_ARMS = ["lifelong", "daily"] as const;
export type DayArm = (typeof DAY_ARMS)[number];

type WireTool = { name: string; description: string; parameters?: unknown };

type Request = {
  day: number;
  label: string;
  firstOfDay: boolean;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  epochReason: string;
  problem: string | null;
};

type Close = {
  day: number;
  made: boolean;
  costUsd: number;
  ms: number;
};

export type DayArmMeasure = {
  arm: DayArm;
  requests: Request[];
  closes: Close[];
  needles: { supplier: boolean; refund: boolean; answers: string[] };
  day7PromptMean: number | null;
  cacheShare: number | null;
  warmCacheShare: number | null;
  costPerDay: number[];
  firstMessageLatencyMs: number[];
};

const DAYS = Math.max(
  5,
  Number.parseInt(process.env.EVAL_DAYS ?? "7", 10) || 7,
);
/** 2026-09-14, a Monday, 09:00 in Seoul. The eval's zone is the deployment's default. */
const START = new Date("2026-09-14T00:00:00Z");
const at = (day: number, hour: number, minute = 0) =>
  new Date(
    START.getTime() + day * 86_400_000 + ((hour - 9) * 60 + minute) * 60_000,
  );

const NEEDLE_SUPPLIER =
  "참, 다음 주 화요일에 거래처 한빛농산 김 대리가 유자 40박스 납품하러 온대. 단가는 박스당 23,000원으로 합의했어. 따로 적어 두진 말고 그냥 알고만 있어.";
const ASK_SUPPLIER =
  "며칠 전에 말한 거래처 납품 건 있잖아. 어느 거래처가 뭘 몇 박스, 단가 얼마에 가져온다고 했지? 기억나는 대로 한 줄로만 답해줘. 모르면 모른다고 해.";
const ASK_REFUND =
  "첫날 네가 봤던 20260046번 주문, 환불 사유가 뭐였지? 페이지 다시 열지 말고 기억나는 대로 한 줄로만. 모르면 모른다고 해.";

const TURNS = [
  "좋은 아침. 오늘 들어온 주문 몇 건인지 정리해줘.",
  "주문 관리 들어가서 아직 발송 안 된 주문 확인해줘.",
  "고객 문의 들어온 거 답장 초안 짧게 써줘.",
  "오늘 마감 전에 할 일 세 가지만 정리해줘.",
];

/** A Bot's answer of the length real ones run to. Scripted, so both arms carry the same bytes. */
function answerText(day: number, turn: number): string {
  const lines = [
    `${day + 1}일차 ${turn + 1}번째 요청 정리입니다.`,
    `오늘 들어온 주문은 ${12 + day}건이고, 그중 ${3 + (day % 3)}건은 아직 발송 전입니다.`,
    "발송 전 주문은 오후 네 시 택배 마감 전에 송장을 출력하면 오늘 안에 나갈 수 있습니다.",
    "고객 문의는 배송 일정 문의가 대부분이라, 주문번호와 예상 도착일을 넣은 짧은 답장을 권해 드립니다.",
    "재고는 유자청 500g이 조금 부족해 보여서 이번 주 안에 추가 발주를 검토하시면 좋겠습니다.",
    "그 밖의 주문은 결제 완료 상태이고, 특이사항이나 취소 요청은 없습니다.",
  ];
  return Array.from({ length: 3 }, () => lines.join(" ")).join("\n");
}

function orderPage(day: number): string {
  const detail =
    day === 0
      ? "\n주문번호 20260046 · 고객 박지영 · 유자청 500g 1개 · 15,000원 · 결제완료\n고객 요청사항: 선물 포장 부탁드려요\n환불 사유: 파손 (택배 상자 찌그러짐, 병 금 감)"
      : `\n주문번호 ${20260100 + day} · 결제완료 · 환불 사유: 없음`;
  return JSON.stringify({
    ok: true,
    url: `https://shop.example.test/admin/orders?day=${day}`,
    title: "미소상회 · 미발송 주문",
    text: `${longPage(day, `PO-${5000 + day}`)}${detail}`,
  });
}

type Ask = {
  text: string;
  promptTokens: number | null;
  cachedPromptTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  problem: string | null;
};

async function ask(
  threadId: string,
  messages: unknown[],
  tools: WireTool[],
  provider: CompletionProvider,
): Promise<Ask> {
  const started = performance.now();
  try {
    const response = await runAgent(
      {
        threadId,
        runId: `days_${randomUUID().slice(0, 8)}`,
        messages,
        tools,
        context: [],
        state: {},
        forwardedProps: {
          botId: EVAL_BOT.id,
          timeZone: EVAL_TIME_ZONE,
        },
      } as never,
      provider,
    );
    const events = eventsOfSse(
      await Promise.race([
        response.text(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("turn timed out")), 180_000),
        ),
      ]),
    );
    const usage = events.find(
      (event) => event.type === "CUSTOM" && event.name === "laf.model.usage",
    )?.value as Record<string, unknown> | undefined;
    const number = (key: string) =>
      typeof usage?.[key] === "number" ? (usage[key] as number) : null;
    const error = events.find((event) => event.type === "RUN_ERROR");
    /*
     * The prompt and the cache are the run's FIRST request's — the prefix the conversation arrived
     * with. The dollars are every request's: a model that looks something up inside the run pays
     * for that round too, and a day's cost must include it.
     */
    const spent = events
      .filter(
        (event) => event.type === "CUSTOM" && event.name === "laf.model.usage",
      )
      .map((event) => (event.value as Record<string, unknown>)?.costUsd)
      .filter((cost): cost is number => typeof cost === "number");
    return {
      text: events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta ?? "")
        .join(""),
      promptTokens: number("promptTokens"),
      cachedPromptTokens: number("cachedPromptTokens"),
      costUsd: spent.length
        ? spent.reduce((sum, cost) => sum + cost, 0)
        : number("costUsd"),
      latencyMs: Math.round(performance.now() - started),
      problem: error
        ? String(error.message ?? "RUN_ERROR")
        : usage
          ? null
          : "no usage event",
    };
  } catch (error) {
    return {
      text: "",
      promptTokens: null,
      cachedPromptTokens: null,
      costUsd: null,
      latencyMs: Math.round(performance.now() - started),
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A fetch that asks OpenRouter for its own price of each call and hands the dollars to `spent` —
 * the close's calls go through `askModel`, which reads tokens only.
 */
function pricedFetch(spent: (usd: number) => void): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let body = init?.body;
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (Array.isArray(parsed.messages)) {
          body = JSON.stringify({ ...parsed, usage: { include: true } });
        }
      } catch {
        // Not JSON: sent as it was.
      }
    }
    const response = await fetch(url, { ...init, ...(body ? { body } : {}) });
    try {
      const read = (await response.clone().json()) as {
        usage?: { cost?: unknown };
      };
      if (typeof read.usage?.cost === "number") spent(read.usage.cost);
    } catch {
      // Not JSON.
    }
    return response;
  }) as typeof fetch;
}

export async function measureDays(options: {
  arm: DayArm;
  model: string;
  tools: WireTool[];
  provider: string | null;
  key: string;
  baseUrl: string;
}): Promise<DayArmMeasure> {
  const { arm } = options;
  let clock = at(0, 9).getTime();
  let closeSpend = 0;
  const apiKey = async () => options.key;
  const serverModel = process.env.SERVER_MODEL?.trim() || "z-ai/glm-5.3-flash";
  const serverCall = {
    baseUrl: options.baseUrl,
    model: serverModel,
    apiKey,
    supportsEffort: process.env.SERVER_MODEL_EFFORT !== "false",
    fetch: pricedFetch((usd) => {
      closeSpend += usd;
    }),
  };
  // The production compactor: Jev, the server model behind it, the rule below both.
  const compactor = createCompactor({
    mode: "decisions",
    asker: withFallback(
      jevAsker(
        {
          baseUrl: "https://openrouter.ai/api",
          model: process.env.EVAL_JEV_MODEL ?? "typesafe/jev-1.13-20260917",
          apiKey,
          onUsage: (usage) => {
            closeSpend += usage.costUsd ?? 0;
          },
        },
        { timeoutMs: 20_000, purpose: "eval-days" },
      ),
      modelAsker(serverCall, { timeoutMs: 120_000 }),
    ),
    excerpts: true,
    onFallback: (reason) =>
      console.log(`    (${arm} compaction fell back: ${reason})`),
  });
  const thread: StampedMessage[] = [];
  const store = createConversationStore({
    now: () => clock,
    compaction: {
      thresholdTokens: 30_000,
      compact: compactor
        ? (messages) => compactor(messages)
        : async () => ({ plan: {}, arm: "latest-snapshot" }),
    },
    ...(arm === "daily"
      ? {
          days: {
            summarize: createDaySummarizer(serverCall, { timeoutMs: 120_000 }),
            history: async () => thread,
            busy: async () => false,
            fallbackTimeZone: EVAL_TIME_ZONE,
          },
        }
      : {}),
  });
  const threadId = `thread_days_${arm}_${randomUUID().slice(0, 8)}`;
  const pinned: CompletionProvider = (request, providerOptions) =>
    liveProvider(
      {
        ...request,
        ...(options.provider
          ? { provider: { only: [options.provider], allow_fallbacks: false } }
          : {}),
      } as typeof request,
      providerOptions,
    );

  const requests: Request[] = [];
  const closes: Close[] = [];
  const needleAnswers: string[] = [];

  let dayNonce = "";
  let offered = options.tools;
  const send = async (
    day: number,
    label: string,
    firstOfDay: boolean,
  ): Promise<Ask> => {
    const now = new Date(clock);
    const facts = contextFactsFor({
      mode: "chat",
      now,
      timeZone: EVAL_TIME_ZONE,
      bot: EVAL_BOT,
      standingRole: EVAL_STANDING_ROLE,
      memories: EVAL_MEMORIES,
      person: { timeZone: EVAL_TIME_ZONE, locale: "ko-KR" },
    });
    const prepared = store.prepare({
      threadId,
      botId: EVAL_BOT.id,
      mode: "chat",
      messages: thread.map(({ lafAt: _stamp, ...message }) => message) as never,
      key: {
        harness: HARNESS_VERSION,
        model: options.model,
        effort: "none",
        // The store's tools key stays: a new day is not a new tool list, in life or here.
        tools: "eval-days",
      },
      facts,
      system: (told) => systemPromptText("chat", contextLayerText(told)),
      now,
    });
    const measured = await ask(
      threadId,
      [
        { id: "laf-prompt:eval_bot", role: "system", content: prepared.system },
        ...prepared.messages,
      ],
      offered,
      pinned,
    );
    store.recordUsage(
      threadId,
      {
        ...(measured.costUsd !== null ? { costUsd: measured.costUsd } : {}),
        ...(measured.promptTokens !== null
          ? { promptTokens: measured.promptTokens }
          : {}),
      },
      now,
    );
    // The threshold compaction decides behind the request; here it lands before the next one.
    await store.settled();
    const request: Request = {
      day,
      label,
      firstOfDay,
      promptTokens: measured.promptTokens,
      cachedPromptTokens: measured.cachedPromptTokens,
      costUsd: measured.costUsd,
      latencyMs: measured.latencyMs,
      epochReason: prepared.epoch.reason,
      problem: measured.problem,
    };
    requests.push(request);
    console.log(
      `  ${arm.padEnd(8)} day ${day + 1} ${label.padEnd(10)}` +
        `  prompt ${String(request.promptTokens ?? "—").padStart(6)}` +
        `  cached ${String(request.cachedPromptTokens ?? "—").padStart(6)}` +
        `  $${request.costUsd?.toFixed(5) ?? "—"}` +
        `  ${String(request.latencyMs).padStart(6)}ms  ${request.epochReason}` +
        (request.problem ? `  · ${request.problem}` : ""),
    );
    return measured;
  };

  for (let day = 0; day < DAYS; day += 1) {
    // The night: a provider holds nothing from yesterday.
    dayNonce = randomUUID().slice(0, 8);
    offered = options.tools.map((tool, index) =>
      index === 0
        ? { ...tool, description: `${tool.description} [${dayNonce}]` }
        : tool,
    );
    if (day > 0 && arm === "daily") {
      clock = at(day, 3).getTime();
      closeSpend = 0;
      const started = performance.now();
      const made = (await store.tick()) > 0;
      closes.push({
        day,
        made,
        costUsd: closeSpend,
        ms: Math.round(performance.now() - started),
      });
      console.log(
        `  daily    day ${day + 1} close      ${made ? "made" : "not made"}  $${closeSpend.toFixed(5)}  ${Math.round(performance.now() - started)}ms`,
      );
    }
    const hours = [9, 11, 15, 19];
    for (let turn = 0; turn < TURNS.length; turn += 1) {
      clock = at(day, hours[turn] ?? 9).getTime();
      const stamp = new Date(clock).toISOString();
      let content = TURNS[turn] ?? "";
      if (day === 0 && turn === 2) content = NEEDLE_SUPPLIER;
      if (day === 4 && turn === 2) content = ASK_SUPPLIER;
      if (day === 4 && turn === 3) content = ASK_REFUND;
      thread.push({
        id: `d${day}u${turn}`,
        role: "user",
        content,
        lafAt: stamp,
      } as never);
      const measured = await send(day, `turn ${turn + 1}`, turn === 0);
      const needle = day === 4 && turn >= 2;
      if (needle) needleAnswers.push(measured.text);
      if (turn === 1) {
        // The browsing step: the page, then the model asked to carry on.
        const callId = `call_d${day}`;
        thread.push(
          {
            id: `d${day}c`,
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: callId,
                type: "function",
                function: {
                  name: "computer_read",
                  arguments: JSON.stringify({}),
                },
              },
            ],
            lafAt: stamp,
          } as never,
          {
            id: `d${day}t`,
            role: "tool",
            toolCallId: callId,
            content: orderPage(day),
            lafAt: stamp,
          } as never,
        );
        clock += 60_000;
        await send(day, "step", false);
      }
      thread.push({
        id: `d${day}a${turn}`,
        role: "assistant",
        content: needle
          ? measured.text || "모르겠습니다."
          : day === 0 && turn === 1
            ? "미발송 주문은 3건입니다. 20260046번 주문은 15,000원 결제 건이고, 나머지는 오늘 발송하시면 됩니다."
            : day === 0 && turn === 2
              ? "네, 알겠습니다."
              : answerText(day, turn),
        lafAt: stamp,
      } as never);
    }
  }

  const supplier = needleAnswers[0] ?? "";
  const refund = needleAnswers[1] ?? "";
  const last = requests.filter((request) => request.day === DAYS - 1);
  const prompts = last
    .map((request) => request.promptTokens)
    .filter((value): value is number => value !== null);
  const share = (rows: Request[]) => {
    const prompt = rows.reduce((sum, row) => sum + (row.promptTokens ?? 0), 0);
    const cached = rows.reduce(
      (sum, row) => sum + (row.cachedPromptTokens ?? 0),
      0,
    );
    return prompt > 0 ? cached / prompt : null;
  };
  const costPerDay = Array.from({ length: DAYS }, (_, day) => {
    const paid = requests
      .filter((request) => request.day === day)
      .reduce((sum, request) => sum + (request.costUsd ?? 0), 0);
    const close = closes.find((row) => row.day === day)?.costUsd ?? 0;
    return paid + close;
  });
  return {
    arm,
    requests,
    closes,
    needles: {
      supplier:
        /한빛/.test(supplier) &&
        /40/.test(supplier) &&
        /23,?000|2만\s?3천/.test(supplier),
      refund: /파손/.test(refund),
      answers: [supplier, refund],
    },
    day7PromptMean: prompts.length
      ? Math.round(
          prompts.reduce((sum, value) => sum + value, 0) / prompts.length,
        )
      : null,
    cacheShare: share(requests),
    warmCacheShare: share(requests.filter((request) => !request.firstOfDay)),
    costPerDay,
    firstMessageLatencyMs: requests
      .filter((request) => request.firstOfDay)
      .map((request) => request.latencyMs),
  };
}
