import { describe, expect, test } from "bun:test";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../../shared/prompt";
import type { Compactor } from "../src/context/compaction";
import {
  type ConversationPersistence,
  createConversationStore,
  type PrepareInput,
} from "../src/context/conversations";
import {
  boundedSummary,
  closePoint,
  type DaySummarizer,
  type StampedMessage,
  SUMMARY_MAX_CHARS,
  transcriptOf,
} from "../src/context/day-close";

/**
 * The day's close, measured where it matters: what the next request carries.
 *
 * A Bot keeps one lifelong conversation on screen; behind it, at the owner's local day boundary, the
 * days before become a summary in a new epoch's frozen layer and the request carries today alone
 * (`context/day-close.ts`). What is asserted: the close is prepared behind the conversation and
 * taken only by a person's new message; the cut never splits a call from its result; the summary
 * outlives later epochs; nothing is closed while the Bot is busy; and nothing anybody typed reaches
 * the summariser.
 */

const ZONE = "Asia/Seoul";
/** 2026-09-24 09:30 in Seoul. */
const DAY1 = new Date("2026-09-24T00:30:00Z");
const at = (days: number, minutes = 0) =>
  new Date(DAY1.getTime() + days * 86_400_000 + minutes * 60_000);

type Thread = StampedMessage[];

function user(id: string, content: string, when: Date): StampedMessage {
  return { id, role: "user", content, lafAt: when.toISOString() } as never;
}
function answer(id: string, content: string, when: Date): StampedMessage {
  return { id, role: "assistant", content, lafAt: when.toISOString() } as never;
}
function call(
  id: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  when: Date,
): StampedMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: callId,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
    lafAt: when.toISOString(),
  } as never;
}
function result(
  id: string,
  callId: string,
  content: string,
  when: Date,
): StampedMessage {
  return {
    id,
    role: "tool",
    toolCallId: callId,
    content,
    lafAt: when.toISOString(),
  } as never;
}

/** A day of talk long enough to be worth a close. */
function dayOfTalk(thread: Thread, day: number, needle = "") {
  for (let turn = 0; turn < 6; turn += 1) {
    const when = at(day, turn * 20);
    thread.push(
      user(`d${day}u${turn}`, `${day}일차 ${turn}번째 부탁 ${needle}`, when),
      answer(`d${day}a${turn}`, "주문을 확인했습니다. ".repeat(150), when),
    );
  }
}

/** What the middleware hands the store, minus the stamps the client never sends. */
function input(thread: Thread, now: Date, tools = "t1"): PrepareInput {
  const facts = contextFactsFor({
    mode: "chat",
    now,
    timeZone: ZONE,
    bot: { id: "bot_miso", name: "미소" },
    memories: ["택배는 우체국을 쓴다."],
    person: { timeZone: ZONE, locale: "ko-KR" },
  });
  return {
    threadId: "thread_miso",
    botId: "bot_miso",
    mode: "chat",
    messages: thread.map(({ lafAt: _stamp, ...message }) => message) as never,
    key: { harness: "h1", model: "m", effort: "balanced", tools },
    facts,
    system: (told) => systemPromptText("chat", contextLayerText(told)),
    now,
  };
}

function harness(
  options: {
    summarize?: DaySummarizer;
    busy?: () => boolean;
    compact?: Compactor;
    persistence?: ConversationPersistence;
  } = {},
) {
  const thread: Thread = [];
  let clock = DAY1.getTime();
  const asked: Array<Parameters<DaySummarizer>[0]> = [];
  const summarize: DaySummarizer =
    options.summarize ??
    (async (request) => {
      asked.push(request);
      return `- 요약 ${asked.length}`;
    });
  const store = createConversationStore({
    now: () => clock,
    ...(options.persistence ? { persistence: options.persistence } : {}),
    ...(options.compact
      ? { compaction: { thresholdTokens: 1_000_000, compact: options.compact } }
      : {}),
    days: {
      summarize: async (request) => {
        if (options.summarize) asked.push(request);
        return summarize(request);
      },
      history: async () => thread,
      busy: async () => options.busy?.() ?? false,
      fallbackTimeZone: ZONE,
    },
  });
  return {
    store,
    thread,
    asked,
    setClock: (when: Date) => {
      clock = when.getTime();
    },
    run: (now: Date, tools?: string) => {
      clock = now.getTime();
      return store.prepare(input(thread, now, tools));
    },
  };
}

describe("where a day's close cuts", () => {
  test("before the first message stamped today, and at the end when nothing is", () => {
    const thread: Thread = [];
    dayOfTalk(thread, 0);
    const night = closePoint(thread, {
      today: "2026-09-25 (금)",
      timeZone: ZONE,
      after: null,
    });
    expect(night?.through).toBe("d0a5");
    thread.push(user("d1u0", "좋은 아침", at(1)));
    const morning = closePoint(thread, {
      today: "2026-09-25 (금)",
      timeZone: ZONE,
      after: null,
    });
    expect(morning?.through).toBe("d0a5");
    expect(morning?.span.at(-1)?.id).toBe("d0a5");
  });

  test("never between a call and its result, and a call left without one goes with today", () => {
    const thread: Thread = [
      user("u0", "주문 봐줘", at(0)),
      call("c0", "call_0", "computer_read", {}, at(0, 1)),
      // The result arrived after midnight.
      result("t0", "call_0", '{"ok":true,"text":"주문 3건"}', at(1)),
      answer("a0", "3건입니다.", at(1, 1)),
    ];
    const point = closePoint(thread, {
      today: "2026-09-25 (금)",
      timeZone: ZONE,
      after: null,
    });
    expect(point?.through).toBe("u0");

    const stopped: Thread = [
      user("u0", "주문 봐줘", at(0)),
      answer("a0", "네.", at(0, 1)),
      call("c1", "call_1", "computer_click", {}, at(0, 2)),
    ];
    expect(
      closePoint(stopped, {
        today: "2026-09-25 (금)",
        timeZone: ZONE,
        after: null,
      })?.through,
    ).toBe("a0");
  });

  test("only after the last cut, and not at all when the thread lost it", () => {
    const thread: Thread = [];
    dayOfTalk(thread, 0);
    dayOfTalk(thread, 1);
    const point = closePoint(thread, {
      today: "2026-09-26 (토)",
      timeZone: ZONE,
      after: "d0a5",
    });
    expect(point?.span[0]?.id).toBe("d1u0");
    expect(
      closePoint(thread, {
        today: "2026-09-26 (토)",
        timeZone: ZONE,
        after: "gone",
      }),
    ).toBeNull();
  });
});

describe("what the summariser is shown", () => {
  test("nothing typed, nothing secret, and a line where each day begins", () => {
    const password = "hunter2-Secret!";
    const span: Thread = [
      user("u0", "쇼핑몰 로그인해줘", at(0)),
      call(
        "c0",
        "call_0",
        "computer_type",
        { ref: "e3", text: password },
        at(0, 1),
      ),
      result("t0", "call_0", '{"ok":true}', at(0, 1)),
      user("u1", "내 번호는 010-1234-5678이야", at(1)),
    ];
    const transcript = transcriptOf(span, ZONE);
    expect(JSON.stringify(transcript)).not.toContain(password);
    expect(transcript).not.toContain("010-1234-5678");
    expect(transcript).toContain("=== 2026-09-24 (목) ===");
    expect(transcript).toContain("=== 2026-09-25 (금) ===");
  });

  test("a photo the owner handed over is named, never shown", () => {
    const span: Thread = [
      {
        id: "u0",
        role: "user",
        content: [
          { type: "text", text: "이 영수증 합계 봐줘" },
          {
            type: "binary",
            mimeType: "image/jpeg",
            id: "0f8e2d4c-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
            filename: "영수증.jpg",
          },
        ],
        lafAt: at(0).toISOString(),
      } as never,
      answer("a0", "합계는 23,500원입니다.", at(0, 1)),
    ];
    const transcript = transcriptOf(span, ZONE);
    expect(transcript).toContain(
      "사장님: 이 영수증 합계 봐줘 [첨부 사진: 영수증.jpg]",
    );
    expect(transcript).not.toContain("0f8e2d4c");
  });

  test("a summary over its bound gives up its oldest lines, never the newest day", () => {
    const old = Array.from(
      { length: 200 },
      (_, n) => `- 9/${(n % 20) + 1}: 오래된 일 ${n}`,
    );
    const bounded = boundedSummary(
      [...old, "- 9/25: 한빛농산 유자 40박스"].join("\n"),
    );
    expect(bounded.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(bounded).toContain("한빛농산 유자 40박스");
    expect(bounded).not.toContain("오래된 일 0\n");
    expect(bounded.startsWith("- 9/")).toBe(true);
  });
});

describe("a day's close, prepared at night and taken in the morning", () => {
  test("the first message of the day carries today alone, on a summary, with no date reminder", async () => {
    const { store, thread, asked, run, setClock } = harness();
    dayOfTalk(thread, 0);
    const yesterday = run(at(0, 200));
    expect(yesterday.messages).toHaveLength(12);

    // The night: the day has turned and nothing is running.
    setClock(at(1, -480));
    expect(await store.tick()).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.previous).toBeNull();
    expect(asked[0]?.day).toBe("2026-09-25 (금)");

    thread.push(user("d1u0", "좋은 아침", at(1)));
    const morning = run(at(1));
    expect(morning.epoch.reason).toBe("day_boundary");
    expect(morning.epoch.fresh).toBe(true);
    expect(morning.messages.map((message) => message.id)).toEqual(["d1u0"]);
    expect(morning.messages[0]?.content).toBe("좋은 아침");
    expect(morning.system).toContain("오늘은 2026-09-25 (금)이다");
    expect(morning.system).toContain("- 요약 1");
    expect(morning.system).toContain("2026-09-25 전까지");

    // The same bytes for the rest of the day: the next step and the next message.
    thread.push(answer("d1a0", "좋은 아침입니다.", at(1, 1)));
    thread.push(user("d1u1", "오늘 할 일?", at(1, 5)));
    const later = run(at(1, 5));
    expect(later.system).toBe(morning.system);
    expect(later.epoch.id).toBe(morning.epoch.id);
    expect(later.messages.map((message) => message.id)).toEqual([
      "d1u0",
      "d1a0",
      "d1u1",
    ]);
  });

  test("a continuation step never takes the close; the person's next message does", async () => {
    const { store, thread, run, setClock } = harness();
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    await store.tick();

    // The last question of yesterday, carried on after midnight by the task's next step.
    thread.push(call("c9", "call_9", "computer_read", {}, at(1, -470)));
    thread.push(result("t9", "call_9", '{"ok":true}', at(1, -470)));
    const step = run(at(1, -469));
    expect(step.epoch.reason).not.toBe("day_boundary");
    expect(step.messages.length).toBeGreaterThan(12);

    thread.push(user("d1u0", "좋은 아침", at(1)));
    const morning = run(at(1));
    expect(morning.epoch.reason).toBe("day_boundary");
    expect(morning.messages.map((message) => message.id)).toEqual([
      "c9",
      "t9",
      "d1u0",
    ]);
  });

  test("not ready by the first message: the date reminder as before, and the next message takes it", async () => {
    const { store, thread, asked, run } = harness();
    dayOfTalk(thread, 0);
    run(at(0, 200));

    thread.push(user("d1u0", "좋은 아침", at(1)));
    const first = run(at(1));
    expect(first.epoch.reason).not.toBe("day_boundary");
    expect(first.messages.at(-1)?.content).toContain("날짜가 바뀌었다");

    // Behind the turn, once it is idle.
    thread.push(answer("d1a0", "좋은 아침입니다.", at(1, 1)));
    await store.closeNow("thread_miso");
    expect(asked).toHaveLength(1);

    thread.push(user("d1u1", "오늘 할 일?", at(1, 5)));
    const next = run(at(1, 5));
    expect(next.epoch.reason).toBe("day_boundary");
    expect(next.messages.map((message) => message.id)).toEqual([
      "d1u0",
      "d1a0",
      "d1u1",
    ]);
    // The first message keeps the reminder it was sent with; the next carries none.
    expect(next.messages[0]?.content).toContain("날짜가 바뀌었다");
    expect(next.messages[2]?.content).toBe("오늘 할 일?");
  });

  test("the summary outlives a later epoch, and the next close builds on it", async () => {
    const { store, thread, asked, run, setClock } = harness();
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    await store.tick();
    dayOfTalk(thread, 1);
    const morning = run(at(1, 100));
    expect(morning.epoch.reason).toBe("day_boundary");

    // The surface's tool list changes mid-day: a new epoch, the same cut.
    thread.push(user("d1u9", "하나 더", at(1, 200)));
    const retooled = run(at(1, 200), "t2");
    expect(retooled.epoch.reason).toBe("tools_changed");
    expect(retooled.system).toContain("- 요약 1");
    expect(retooled.messages[0]?.id).toBe("d1u0");

    setClock(at(2, -480));
    expect(await store.tick()).toBe(1);
    expect(asked[1]?.previous).toBe("- 요약 1");
    expect(asked[1]?.transcript).toContain("1일차");
    expect(asked[1]?.transcript).not.toContain("0일차");
  });

  test("nothing is closed while the Bot is running or waiting on its owner", async () => {
    let busy = true;
    const { store, thread, asked, run, setClock } = harness({
      busy: () => busy,
    });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    expect(await store.tick()).toBe(0);
    expect(asked).toHaveLength(0);
    busy = false;
    expect(await store.tick()).toBe(1);
  });

  test("not within two minutes of the last request, and not a day too short to be worth it", async () => {
    const { store, thread, asked, run, setClock } = harness();
    dayOfTalk(thread, 0);
    run(at(0, 200));
    store.recordUsage("thread_miso", { promptTokens: 1_000 }, at(1, -1));
    setClock(at(1, 0));
    expect(await store.tick()).toBe(0);
    setClock(at(1, 3));
    expect(await store.tick()).toBe(1);

    const short = harness();
    short.thread.push(user("u0", "안녕", at(0)), answer("a0", "네.", at(0)));
    short.run(at(0, 1));
    short.setClock(at(1, -480));
    expect(await short.store.tick()).toBe(0);
    expect(short.asked).toHaveLength(0);
    expect(asked).toHaveLength(1);
  });

  test("a summariser that fails leaves the conversation as it was", async () => {
    const { store, thread, run, setClock } = harness({
      summarize: async () => {
        throw new Error("summary: refused");
      },
    });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    expect(await store.tick()).toBe(0);
    thread.push(user("d1u0", "좋은 아침", at(1)));
    const morning = run(at(1));
    expect(morning.epoch.reason).not.toBe("day_boundary");
    expect(morning.messages).toHaveLength(13);
  });

  test("the existing compaction runs over the span first, and a dropped result never reaches the summariser", async () => {
    const judged: number[] = [];
    const { store, thread, asked, run, setClock } = harness({
      compact: async (messages) => {
        judged.push(messages.length);
        return { plan: { call_page: "drop_call" }, arm: "decisions" };
      },
    });
    thread.push(
      call("c0", "call_page", "computer_read", {}, at(0)),
      result(
        "t0",
        "call_page",
        JSON.stringify({ ok: true, text: "쓸모없는 페이지 본문" }),
        at(0),
      ),
    );
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    await store.tick();
    expect(judged).toEqual([14]);
    expect(asked[0]?.transcript).not.toContain("쓸모없는 페이지");
    expect(asked[0]?.transcript).toContain("0일차");
  });

  test("the cut is written with the epoch and a restart carries the same bytes", async () => {
    const rows = new Map<
      string,
      Parameters<ConversationPersistence["save"]>[0]
    >();
    const persistence: ConversationPersistence = {
      loadAll: async () =>
        [...rows.values()].map((row) => ({ ...row, agentId: row.agentId })),
      save: async (row) => {
        rows.set(row.threadId, structuredClone(row));
      },
    };
    const { store, thread, run, setClock } = harness({ persistence });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    await store.tick();
    thread.push(user("d1u0", "좋은 아침", at(1)));
    const morning = run(at(1));
    await store.settled();
    expect(rows.get("thread_miso")?.epoch.cut?.through).toBe("d0a5");

    const after = createConversationStore({
      persistence,
      now: () => at(1, 1).getTime(),
    });
    await after.load();
    const again = after.prepare(input(thread, at(1, 1)));
    expect(again.system).toBe(morning.system);
    expect(again.messages).toEqual(morning.messages);
  });
});
