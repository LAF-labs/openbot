import { describe, expect, test } from "bun:test";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../../shared/prompt";
import {
  createStandingExtractor,
  figuresQuoted,
  MIN_QUOTE_CHARS,
  quotedIn,
  type StandingHook,
} from "../src/agents/standing-facts";
import {
  type ConversationPersistence,
  createConversationStore,
  type PrepareInput,
} from "../src/context/conversations";
import type { StampedMessage } from "../src/context/day-close";
import { recentLines } from "../src/log";

/**
 * The day's close hands the owner's messages of the span to 수첩's night (`agents/standing-facts.ts`)
 * and the summary carries dated lines alone; the night failing does not fail the close; a quote
 * is the owner's only when one message holds it whole with every figure. The real store is in
 * `standing-notebook.integration.test.ts`; here the night is a stand-in that records what it is
 * handed.
 */

const ZONE = "Asia/Seoul";
/** 2026-09-24 09:30 in Seoul. */
const DAY1 = new Date("2026-09-24T00:30:00Z");
const at = (days: number, minutes = 0) =>
  new Date(DAY1.getTime() + days * 86_400_000 + minutes * 60_000);

const user = (id: string, content: string, when: Date): StampedMessage =>
  ({ id, role: "user", content, lafAt: when.toISOString() }) as never;
const answer = (id: string, content: string, when: Date): StampedMessage =>
  ({ id, role: "assistant", content, lafAt: when.toISOString() }) as never;

/** A day of talk long enough to clear the close floor, with one owner line that matters. */
function dayOfTalk(thread: StampedMessage[], day: number, said?: string) {
  for (let turn = 0; turn < 6; turn += 1) {
    const when = at(day, turn * 20);
    thread.push(
      user(
        `d${day}u${turn}`,
        turn === 2 && said ? said : `${day}일차 ${turn}번째 부탁`,
        when,
      ),
      answer(`d${day}a${turn}`, "주문을 확인했습니다. ".repeat(150), when),
    );
  }
}

const SAID = "정산 자료는 매달 5일까지 세무사님한테 넘겨야 해";
const FACT = "매출 정산 자료: 매달 5일까지 세무사님에게 넘김";

function input(thread: StampedMessage[], now: Date): PrepareInput {
  return {
    threadId: "thread_sn",
    botId: "bot_sn",
    mode: "chat",
    messages: thread.map(({ lafAt: _stamp, ...message }) => message) as never,
    key: { harness: "h1", model: "m", effort: "balanced", tools: "t1" },
    facts: contextFactsFor({
      mode: "chat",
      now,
      timeZone: ZONE,
      bot: { id: "bot_sn", name: "미소" },
      memories: [],
      person: { timeZone: ZONE, locale: "ko-KR" },
    }),
    system: (told) => systemPromptText("chat", contextLayerText(told)),
    now,
  };
}

/** A night that records what the close hands it, and fails when told to. */
function night(fail = false) {
  const asked: Array<Parameters<StandingHook>[0]> = [];
  const hook = async (request: Parameters<StandingHook>[0]) => {
    asked.push(request);
    if (fail) throw new Error("standing: refused");
    return {
      added: 0,
      duplicate: 0,
      unquoted: 0,
      refused: 0,
      forgotten: 0,
      full: 0,
    };
  };
  return { hook, asked };
}

function harness(options: {
  answers: string[];
  standing?: ReturnType<typeof night>["hook"];
  persistence?: ConversationPersistence;
  thread?: StampedMessage[];
}) {
  const thread: StampedMessage[] = options.thread ?? [];
  let clock = DAY1.getTime();
  let turn = 0;
  const store = createConversationStore({
    now: () => clock,
    ...(options.persistence ? { persistence: options.persistence } : {}),
    days: {
      summarize: async () => {
        const next =
          options.answers[Math.min(turn, options.answers.length - 1)];
        turn += 1;
        return next ?? "";
      },
      history: async () => thread,
      busy: async () => false,
      fallbackTimeZone: ZONE,
      ...(options.standing ? { standing: options.standing } : {}),
    },
  });
  return {
    store,
    thread,
    /** The owner's last message of `day`, then the night: the close is prepared on the tick. */
    night: async (day: number) => {
      clock = at(day, 200).getTime();
      store.prepare(input(thread, at(day, 200)));
      clock = at(day + 1, -480).getTime();
      await store.tick();
      await store.settled();
    },
    /** The next morning's request: what the frozen layer carries. */
    morning: async (day: number) => {
      thread.push(user(`d${day}morning`, "좋은 아침", at(day)));
      clock = at(day).getTime();
      const prepared = store.prepare(input(thread, at(day)));
      await store.settled();
      return prepared;
    },
  };
}

const logged = (event: string) =>
  recentLines
    .lines()
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === event);

describe("whether the quote is the owner's", () => {
  const messages = [
    { id: "u1", text: "한일포장 배송 조건 좀 확인해 줘" },
    { id: "u2", text: SAID },
    { id: "u3", text: "지은이는 화요일이랑 목요일만 나와" },
  ];

  test("found whole in one message, after whitespace and Unicode forms a model may alter", () => {
    expect(quotedIn(SAID, messages)?.id).toBe("u2");
    // Doubled spaces, a no-break space, full-width digits and a compatibility jamo: the same words.
    expect(
      quotedIn("정산  자료는 매달 ５일까지 세무사님한테", messages)?.id,
    ).toBe("u2");
    expect(quotedIn("지은이는 화요일이랑 목요일만 나와", messages)?.id).toBe(
      "u3",
    );
  });

  test("not found, spread over two messages, or a word changed: not the owner's", () => {
    expect(
      quotedIn("한일포장: 주문 시 선결제, 50,000원 이상 무료배송", messages),
    ).toBeNull();
    expect(quotedIn("세무사님한테 넘겨야 해 지은이는", messages)).toBeNull();
    expect(quotedIn("정산 자료는 매달 7일까지", messages)).toBeNull();
  });

  test("a phrase shorter than a statement is not evidence", () => {
    expect(MIN_QUOTE_CHARS).toBe(8);
    expect(quotedIn("한일포장 배송", messages)).toBeNull();
    expect(quotedIn("세무사님한테 넘겨야 해", messages)?.id).toBe("u2");
  });

  test("every figure the line states must be in the quote, as the forget rule reads a number", () => {
    // Codex's case: the request holds the supplier and the word, the page added the amount.
    expect(
      figuresQuoted(
        "한일포장: 50,000원 이상 무료배송",
        "한일포장 무료배송 조건 좀 확인해 줘",
      ),
    ).toBe(false);
    expect(
      figuresQuoted("유자: 1kg에 18,000원", "유자는 1kg에 18,000원에 받아"),
    ).toBe(true);
    expect(figuresQuoted("유자: 1kg에 18000원", "유자 1kg 18,000원")).toBe(
      true,
    );
    // The limit, pinned: 5만 원 said and 50,000원 written do not meet.
    expect(
      figuresQuoted("배송: 50,000원 이상 무료", "5만 원 이상 무료야"),
    ).toBe(false);
    // A short figure as a whole token: 5일 is not in 25일.
    expect(figuresQuoted("정산: 매달 5일까지", "매달 25일까지 넘겨")).toBe(
      false,
    );
    expect(figuresQuoted("정산: 매달 5일까지", SAID)).toBe(true);
  });
});

describe("the extractor's call", () => {
  const extractor = (content: string) => {
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    const extract = createStandingExtractor(
      {
        baseUrl: "https://model.example.test/v1",
        model: "z-ai/glm-5.3-flash",
        apiKey: async () => "k",
        fetch: (async (_url: unknown, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({ choices: [{ message: { content } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      },
      { timeoutMs: 5_000 },
    );
    return { extract, bodies };
  };

  test("sends the messages and the notebook by key, redacted, and reads the facts back", async () => {
    const { extract, bodies } = extractor(
      `\`\`\`json\n{"facts":[{"line":"${FACT}","quote":"${SAID}"},{"line":3}]}\n\`\`\``,
    );
    const facts = await extract({
      messages: [SAID],
      notebook: ["택배는 우체국을 쓴다.", "카드 1234-5678-1234-5678"],
    });
    expect(facts).toEqual([{ line: FACT, quote: SAID }]);
    const sent = JSON.parse(bodies[0]?.messages[1]?.content ?? "{}");
    expect(sent.messages).toEqual({ m0: SAID });
    expect(sent.notebook.n0).toBe("택배는 우체국을 쓴다.");
    expect(sent.notebook.n1).not.toContain("1234-5678");
  });

  test("an answer that is not a list of facts is a failure, never an empty success", async () => {
    const { extract } = extractor("오늘은 특별한 게 없었어요.");
    await expect(extract({ messages: [SAID], notebook: [] })).rejects.toThrow(
      "standing: unreadable",
    );
  });
});

describe("the close and the night", () => {
  test("hands the owner's messages of the span to 수첩, and the morning carries the summary's dated lines alone", async () => {
    const { hook, asked } = night();
    const h = harness({
      answers: ["- 9/24: 이 사람이 정산 자료는 매달 5일까지라고 함."],
      standing: hook,
    });
    dayOfTalk(h.thread, 0, SAID);
    await h.night(0);
    const morning = await h.morning(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.botId).toBe("bot_sn");
    expect(asked[0]?.threadId).toBe("thread_sn");
    // The span's owner messages, oldest first, with the one that said it among them — nothing else.
    expect(asked[0]?.owner.map((m) => m.id)).toEqual(
      Array.from({ length: 6 }, (_, turn) => `d0u${turn}`),
    );
    expect(asked[0]?.owner[2]).toEqual({
      id: "d0u2",
      threadId: "thread_sn",
      text: SAID,
    });
    expect(morning.system).toContain(
      "- 9/24: 이 사람이 정산 자료는 매달 5일까지라고 함.",
    );
    expect(morning.system).not.toContain(FACT);
  });

  test("the night failing does not fail the close: the summary stands, and the failure is logged without content", async () => {
    const { hook, asked } = night(true);
    const h = harness({
      answers: ["- 9/24: 정산 얘기."],
      standing: hook,
    });
    dayOfTalk(h.thread, 0, SAID);
    const before = logged("standing_failed").length;
    await h.night(0);
    const morning = await h.morning(1);
    expect(asked).toHaveLength(1);
    expect(morning.epoch.reason).toBe("day_boundary");
    expect(morning.system).toContain("- 9/24: 정산 얘기.");
    const failures = logged("standing_failed").slice(before);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ bot: "bot_sn" });
    expect(JSON.stringify(failures)).not.toContain("세무사");
    // Not tried again that night: the next tick finds the close made.
    expect(logged("day_closed").at(-1)).toMatchObject({ bot: "bot_sn" });
  });

  test("a summary that holds undated lines is carried as text, not read as a block", async () => {
    const rows = new Map<
      string,
      Parameters<ConversationPersistence["save"]>[0]
    >();
    const persistence: ConversationPersistence = {
      loadAll: async () => [...rows.values()],
      save: async (row) => {
        rows.set(row.threadId, structuredClone(row));
      },
    };
    // A close made under pull request 196's wording: a block after the dated lines.
    const withBlock = ["- 9/24: 문자 초안.", `- ${FACT}`].join("\n");
    const before = harness({ answers: [withBlock], persistence });
    dayOfTalk(before.thread, 0, SAID);
    await before.night(0);
    const old = await before.morning(1);
    expect(old.system).toContain(withBlock);

    // The server under this code takes the epoch over: the same text, whole, as the previous summary.
    const { hook, asked } = night();
    const after = harness({
      answers: ["- 9/24: 문자 초안.\n- 9/25: 택배 두 건."],
      persistence,
      standing: hook,
      thread: before.thread,
    });
    await after.store.load();
    const taken = await after.morning(1);
    expect(taken.system).toContain(withBlock);
    dayOfTalk(after.thread, 1);
    await after.night(1);
    const next = await after.morning(2);
    expect(asked).toHaveLength(1);
    expect(next.system).toContain("- 9/25: 택배 두 건.");
    expect(next.system).not.toContain(FACT);
  });
});
