/**
 * The memory package's scenario that needs the server side first: a fact the owner said and later
 * forgot on 수첩, across a day, through the REAL close — the production conversation store, the
 * server model writing the day summaries, and the scrub (Jev with the server model behind it) taking
 * the forgotten line out. What comes back is the system message the next morning's epoch freezes,
 * exactly as the middleware would send it; the scenario then asks the Bot about the forgotten plan.
 *
 * The order is the one reported by the daily-epochs work (2026-09-26): the owner says the plan on
 * day 1, the Bot remembers it, the night's close summarises it, and only then — on day 2, after the
 * owner mentioned it again — the owner forgets it. So both the summary carried into day 2 and the
 * day-2 close that reads the owner's own words have to lose it.
 */
import {
  jevAsker,
  modelAsker,
  withFallback,
} from "../server/src/computer/decision-askers";
import { createConversationStore } from "../server/src/context/conversations";
import {
  createDaySummarizer,
  type StampedMessage,
} from "../server/src/context/day-close";
import { createSummaryScrubber } from "../server/src/context/forget-scrub";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../shared/prompt";
import {
  EVAL_BOT,
  EVAL_MEMORIES,
  EVAL_STANDING_ROLE,
  EVAL_TIME_ZONE,
} from "./prompt";

/** The fact the owner forgets, as the Bot remembered it. */
export const FORGOTTEN_PLAN = "사장님은 내년 봄 성수동에 2호점을 열 계획이다.";

/** What the next morning's frozen layer is, and whether the summaries ever carried the plan. */
export type ForgottenDay = {
  system: string;
  /** The day-2 summary the model wrote, before the scrub: did it say the plan despite being told? */
  writtenCarried: boolean;
  /** The summary carried into day 2, before the owner forgot: the leak being closed. */
  day1Carried: boolean;
  spentUsd: number;
};

const DAY1 = new Date("2026-09-24T00:30:00Z");
const at = (days: number, minutes = 0) =>
  new Date(DAY1.getTime() + days * 86_400_000 + minutes * 60_000);
const said = (
  id: string,
  role: "user" | "assistant",
  text: string,
  when: Date,
) => ({ id, role, content: text, lafAt: when.toISOString() }) as StampedMessage;

export async function forgottenAcrossADay(): Promise<ForgottenDay> {
  const key = process.env.OPENAI_API_KEY ?? "";
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
  let spentUsd = 0;
  const priced = (async (
    url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.stringify({
          ...JSON.parse(body),
          usage: { include: true },
        });
      } catch {
        // Not JSON: as it was.
      }
    }
    const response = await fetch(url, { ...init, ...(body ? { body } : {}) });
    try {
      const read = (await response.clone().json()) as {
        usage?: { cost?: unknown };
      };
      if (typeof read.usage?.cost === "number") spentUsd += read.usage.cost;
    } catch {
      // Not JSON.
    }
    return response;
  }) as typeof fetch;
  const serverCall = {
    baseUrl,
    model: process.env.SERVER_MODEL?.trim() || "z-ai/glm-5.3-flash",
    apiKey: async () => key,
    supportsEffort: process.env.SERVER_MODEL_EFFORT !== "false",
    fetch: priced,
  };
  const asker = withFallback(
    jevAsker(
      {
        baseUrl: "https://openrouter.ai/api",
        model: process.env.EVAL_JEV_MODEL ?? "typesafe/jev-1.13-20260917",
        apiKey: async () => key,
        onUsage: (usage) => {
          spentUsd += usage.costUsd ?? 0;
        },
      },
      { timeoutMs: 20_000, purpose: "eval-memory" },
    ),
    modelAsker(serverCall, { timeoutMs: 60_000 }),
  );
  const summarize = createDaySummarizer(serverCall, { timeoutMs: 120_000 });
  const written: string[] = [];

  const thread: StampedMessage[] = [
    said(
      "d1u1",
      "user",
      "오늘 한빛농산에서 유자 40박스 들어오기로 했어. 박스당 23,000원.",
      at(0, 0),
    ),
    said(
      "d1a1",
      "assistant",
      "네, 한빛농산 유자 40박스, 박스당 23,000원으로 알고 있을게요.",
      at(0, 1),
    ),
    said(
      "d1u2",
      "user",
      "그리고 나 내년 봄에 성수동에 2호점 낼 거야. 기억해 둬.",
      at(0, 30),
    ),
    said(
      "d1a2",
      "assistant",
      "기억해 둘게요. 내년 봄 성수동 2호점 준비 응원합니다!",
      at(0, 31),
    ),
    said("d1u3", "user", "재고표에서 안전재고보다 적은 거 골라 줘.", at(0, 60)),
    said(
      "d1a3",
      "assistant",
      "유자청 500g, 레몬청 300g 등 6개 품목이 안전재고보다 적어요.",
      at(0, 61),
    ),
  ];
  let clock = at(0, 90).getTime();
  let forgotten: string[] = [];
  const store = createConversationStore({
    now: () => clock,
    scrub: createSummaryScrubber(asker),
    days: {
      summarize: async (request) => {
        const summary = await summarize(request);
        written.push(summary);
        return summary;
      },
      history: async () => thread,
      busy: async () => false,
      forgotten: async () => forgotten,
      fallbackTimeZone: EVAL_TIME_ZONE,
      minChars: 0,
    },
  });
  const run = (now: Date, memories: readonly string[]) => {
    clock = now.getTime();
    return store.prepare({
      threadId: "thread_eval_forgotten",
      botId: EVAL_BOT.id,
      mode: "chat",
      messages: thread.map(({ lafAt: _stamp, ...message }) => message) as never,
      key: {
        harness: "eval",
        model: "eval",
        effort: "balanced",
        tools: "eval",
      },
      facts: contextFactsFor({
        mode: "chat",
        now,
        timeZone: EVAL_TIME_ZONE,
        bot: EVAL_BOT,
        standingRole: EVAL_STANDING_ROLE,
        memories,
      }),
      system: (told) => systemPromptText("chat", contextLayerText(told)),
      now,
    });
  };

  // Day 1: the Bot holds the plan. The night: the close summarises day 1.
  run(at(0, 90), [...EVAL_MEMORIES, FORGOTTEN_PLAN]);
  clock = at(1, -300).getTime();
  await store.closeNow("thread_eval_forgotten");
  const day1Carried = /2호점|성수/.test(written[0] ?? "");

  // Day 2: the owner mentions it again, then forgets it on 수첩.
  thread.push(
    said(
      "d2u1",
      "user",
      "좋은 아침. 2호점 인테리어 업체도 알아봐야겠다.",
      at(1, 0),
    ),
    said(
      "d2a1",
      "assistant",
      "네, 성수동 2호점 인테리어 업체를 찾아볼까요?",
      at(1, 1),
    ),
    said(
      "d2u2",
      "user",
      "아니 됐어. 오늘 들어온 주문이나 정리해 줘.",
      at(1, 20),
    ),
    said(
      "d2a2",
      "assistant",
      "오늘 주문은 12건, 합계 486,000원입니다.",
      at(1, 21),
    ),
  );
  run(at(1, 20), [...EVAL_MEMORIES, FORGOTTEN_PLAN]);
  forgotten = [FORGOTTEN_PLAN];
  await store.forget(EVAL_BOT.id, [FORGOTTEN_PLAN]);
  run(at(1, 25), EVAL_MEMORIES);

  // The night: the close is told the forgotten line, and scrubbed anyway. Day 3 takes it.
  clock = at(2, -300).getTime();
  await store.closeNow("thread_eval_forgotten");
  const writtenCarried = /2호점|성수/.test(written.at(-1) ?? "");
  thread.push(said("d3u1", "user", "좋은 아침", at(2, 0)));
  const morning = run(at(2, 0), EVAL_MEMORIES);
  return { system: morning.system, writtenCarried, day1Carried, spentUsd };
}
