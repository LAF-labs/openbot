import { describe, expect, test } from "bun:test";
import { recentLines } from "../src/log";
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
import { delegatedThreadOf } from "../src/turns/engine";
import {
  unsummarisedSummary,
  withGapsKept,
} from "../src/context/conversations";
import {
  boundedSummary,
  closePoint,
  type DaySummarizer,
  type StampedMessage,
  SUMMARY_MAX_CHARS,
  transcriptOf,
} from "../src/context/day-close";
import type { SummaryScrubber } from "../src/context/forget-scrub";

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
function input(
  thread: Thread,
  now: Date,
  tools = "t1",
  bot = "bot_miso",
): PrepareInput {
  const facts = contextFactsFor({
    mode: "chat",
    now,
    timeZone: ZONE,
    bot: { id: bot, name: "미소" },
    memories: ["택배는 우체국을 쓴다."],
    person: { timeZone: ZONE, locale: "ko-KR" },
  });
  return {
    threadId: "thread_miso",
    botId: bot,
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
    /** The Bot's id, when a test reads the log and must know its own lines from a neighbour's. */
    bot?: string;
    /** What the owner forgot on 수첩, and the scrub that takes it out of what the summariser wrote. */
    forgotten?: () => string[];
    scrub?: SummaryScrubber;
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
    ...(options.scrub ? { scrub: options.scrub } : {}),
    days: {
      summarize: async (request) => {
        if (options.summarize) asked.push(request);
        return summarize(request);
      },
      history: async () => thread,
      busy: async () => options.busy?.() ?? false,
      ...(options.forgotten
        ? { forgotten: async () => options.forgotten?.() ?? [] }
        : {}),
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
      return store.prepare(input(thread, now, tools, options.bot));
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

  test("a conversation that was dropped is not written back: not by the write in flight, the day's clock, or a compaction still being decided", async () => {
    /*
     * A project's deletion removes the row, and the write is an upsert: anything here that keeps
     * the conversation afterwards puts it back (review, 2026-10-10).
     */
    const rows = new Map<
      string,
      Parameters<ConversationPersistence["save"]>[0]
    >();
    const saved: string[] = [];
    const persistence: ConversationPersistence = {
      loadAll: async () => [...rows.values()],
      save: async (row) => {
        // A write takes a moment, as Postgres does.
        await new Promise((resolve) => setTimeout(resolve, 5));
        rows.set(row.threadId, structuredClone(row));
        saved.push(row.threadId);
      },
    };
    let decide: () => void = () => {};
    const deciding = new Promise<void>((resolve) => {
      decide = resolve;
    });
    const { store, thread, run, setClock } = harness({
      persistence,
      compact: async () => {
        await deciding;
        return { plan: { call_page: "drop_call" }, arm: "decisions" };
      },
    });
    thread.push(
      call("c0", "call_page", "computer_read", {}, at(0)),
      result(
        "t0",
        "call_page",
        JSON.stringify({
          ok: true,
          text: "쓸모없는 페이지 본문 ".repeat(4000),
        }),
        at(0),
      ),
    );
    dayOfTalk(thread, 0);
    run(at(0, 200));
    const compacting = store.compactNow("thread_miso");

    // The write the run asked for is still in flight: `drop` comes back only after it has landed.
    expect(saved).toEqual([]);
    await store.drop("thread_miso");
    expect(saved).toEqual(["thread_miso"]);
    // The deletion's transaction.
    rows.clear();

    // The compaction decides now, holding the conversation it was asked about.
    decide();
    await compacting;
    // And the day turns.
    setClock(at(1, -480));
    expect(await store.tick()).toBe(0);
    await store.forget("bot_miso", ["택배는 우체국을 쓴다."]);
    await store.settled();
    expect([...rows.keys()]).toEqual([]);
    expect(saved).toEqual(["thread_miso"]);
  });

  /*
   * A BROWSING RUN'S CONTEXT IS A THREAD OF ITS OWN. The delegated run is made on
   * `<thread>.browse` (`turns/engine.ts`), and the store keeps a context under that id as under
   * any other — so dropping the conversation leaves it, holding a deleted project's pages until
   * the unkept sweep six hours on. The deletion drops them together, one per kind of delegated
   * work (`channels/deleting.ts` `contextsOf`); this is the premise and the call it makes.
   */
  test("a delegated run's context is dropped by its own id, not with the conversation's", async () => {
    const { store, thread, run } = harness();
    dayOfTalk(thread, 0);
    run(at(0, 200));
    const browse = delegatedThreadOf("thread_miso");
    store.prepare({
      ...input(thread, at(0, 201)),
      threadId: browse,
      mode: "browse",
    });
    expect(store.peek(browse, [])).not.toBeNull();

    await store.drop("thread_miso");
    expect(store.peek("thread_miso", [])).toBeNull();
    expect(store.peek(browse, [])).not.toBeNull();

    await store.drop(browse);
    expect(store.peek(browse, [])).toBeNull();
    // Dropping a thread the store never saw is nothing.
    await store.drop(delegatedThreadOf("thread_nobody"));
  });
});

/**
 * A close that keeps failing. Measured in `eval:memory-days`' sixty-night walk (pull request 200):
 * two of twenty-four conversations stopped closing after one timed-out close and never started
 * again, because every later night's attempt carried the same summary and one more day of
 * transcript — larger each night, and nothing ever gave up — so the whole conversation was carried
 * behind the last summary, 176K–246K prompt tokens a question instead of 8K.
 */
describe("a close that keeps failing", () => {
  /** A summariser that answers the first `answers` times and then takes too long, forever. */
  function flaky(answers: number) {
    let calls = 0;
    const summarize: DaySummarizer = async () => {
      calls += 1;
      if (calls <= answers) return `- 요약 ${calls}`;
      throw new Error("summary: took too long");
    };
    return summarize;
  }
  /** This Bot's lines of one event, wherever they sit in the process-wide buffer. */
  const logged = (bot: string, event: string) =>
    recentLines
      .lines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.bot === bot && line.event === event);
  const morning = (thread: Thread, day: number, minutes = 0) => {
    thread.push(user(`d${day}u0`, "좋은 아침", at(day, minutes)));
  };

  test("each failure is counted, and the count and the time spent are in the log line", async () => {
    const bot = "bot_counted";
    const { store, thread, run, setClock } = harness({
      summarize: flaky(0),
      bot,
    });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    expect(await store.tick()).toBe(0);
    morning(thread, 1);
    run(at(1));
    setClock(at(2, -480));
    expect(await store.tick()).toBe(0);
    const failed = logged(bot, "day_close_failed");
    expect(failed.map((line) => line.failures)).toEqual([1, 2]);
    expect(failed.every((line) => typeof line.ms === "number")).toBe(true);
  });

  test("a retry sends no more than the attempt that failed: the oldest unclosed day alone, on the same summary", async () => {
    const { store, thread, asked, run, setClock } = harness({
      summarize: flaky(1),
    });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    expect(await store.tick()).toBe(1);
    morning(thread, 1);
    expect(run(at(1)).epoch.reason).toBe("day_boundary");
    for (const day of [1, 2]) {
      dayOfTalk(thread, day);
      run(at(day, 200));
      setClock(at(day + 1, -480));
      await store.tick();
    }
    expect(asked).toHaveLength(3);
    // Two days were unclosed; the retry was asked about the first of them, exactly as before.
    expect(asked[2]?.transcript).toBe(asked[1]?.transcript ?? "");
    expect(asked[1]?.previous).toBe("- 요약 1");
    expect(asked[2]?.previous).toBe("- 요약 1");
    expect(asked[2]?.transcript).toContain("1일차");
    expect(asked[2]?.transcript).not.toContain("2일차");
  });

  test("a retry under the close floor widens a day at a time, never past what the failed attempt sent, so a short day never leaves a close stuck", async () => {
    const { store, thread, asked, run, setClock } = harness({
      summarize: flaky(0),
    });
    // A day of two words, then a busy one: the first night has nothing worth closing.
    thread.push(user("d0u0", "안녕", at(0)), answer("d0a0", "네.", at(0, 1)));
    run(at(0, 2));
    setClock(at(1, -480));
    expect(await store.tick()).toBe(0);
    expect(asked).toHaveLength(0);
    // The night that closes them together fails; the nights after must still try.
    for (const day of [1, 2, 3]) {
      dayOfTalk(thread, day);
      run(at(day, 200));
      setClock(at(day + 1, -480));
      await store.tick();
    }
    expect(asked).toHaveLength(3);
    expect(asked[1]?.transcript).toBe(asked[0]?.transcript ?? "");
    expect(asked[2]?.transcript).toContain("안녕");
    expect(asked[2]?.transcript).toContain("1일차");
    expect(asked[2]?.transcript).not.toContain("2일차");
    dayOfTalk(thread, 4);
    run(at(4, 200));
    setClock(at(5, -480));
    expect(await store.tick()).toBe(1);
    morning(thread, 5);
    const first = run(at(5));
    expect(first.epoch.reason).toBe("day_boundary");
    expect(first.messages.map((message) => message.id)).toEqual(["d5u0"]);
  });

  test("the owner's messages through a morning are attempts, not failures: at most one failure counts a day", async () => {
    const bot = "bot_morning";
    const { store, thread, asked, run, setClock } = harness({
      summarize: flaky(0),
      bot,
    });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    await store.tick();
    // 09:30, 10:01, 10:32: each message a new look at the close, half an hour after the last.
    for (const [n, minutes] of [30, 61, 92].entries()) {
      thread.push(user(`d1u${n}`, `부탁 ${n}`, at(1, minutes)));
      run(at(1, minutes));
      setClock(at(1, minutes + 1));
      await store.tick();
    }
    expect(asked).toHaveLength(4);
    expect(
      logged(bot, "day_close_failed").map((line) => line.failures),
    ).toEqual([1, 1, 1, 1]);
    expect(logged(bot, "day_close_unsummarised")).toHaveLength(0);
    dayOfTalk(thread, 1);
    run(at(1, 300));
    setClock(at(2, -480));
    await store.tick();
    expect(logged(bot, "day_close_failed").at(-1)?.failures).toBe(2);
  });

  test("only the summariser's own failure counts: the database being down three nights is not three failures", async () => {
    const bot = "bot_dbdown";
    let nights = 0;
    const { store, thread, asked, run, setClock } = harness({
      summarize: flaky(0),
      bot,
      busy: () => {
        nights += 1;
        if (nights <= 3) throw new Error("db down");
        return false;
      },
    });
    for (const day of [0, 1, 2, 3]) {
      dayOfTalk(thread, day);
      run(at(day, 200));
      setClock(at(day + 1, -480));
      await store.tick();
    }
    // Three nights nothing was asked; the fourth asked, and that is the first failure.
    expect(asked).toHaveLength(1);
    expect(logged(bot, "day_close_unsummarised")).toHaveLength(0);
    expect(
      logged(bot, "day_close_failed").map((line) => line.failures),
    ).toEqual([0, 0, 0, 1]);
    morning(thread, 4);
    expect(run(at(4)).epoch.reason).not.toBe("day_boundary");
  });

  test("after three failed closes the day is closed without the summariser: the old summary carried, the days it does not cover named, and the morning carries today alone", async () => {
    const bot = "bot_fallback";
    const { store, thread, asked, run, setClock } = harness({
      summarize: flaky(1),
      bot,
    });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    expect(await store.tick()).toBe(1);
    for (const day of [1, 2, 3, 4]) {
      dayOfTalk(thread, day);
      run(at(day, 200));
      setClock(at(day + 1, -480));
      await store.tick();
    }
    // One answer, three failures, and the fourth night asked nothing of the summariser.
    expect(asked).toHaveLength(4);
    morning(thread, 5);
    const first = run(at(5));
    expect(first.epoch.reason).toBe("day_boundary");
    expect(first.messages.map((message) => message.id)).toEqual(["d5u0"]);
    // What the summariser wrote is carried as it was; what it never wrote is named, never invented.
    expect(first.system).toContain("- 요약 1");
    expect(first.system).toContain("- 9/25~9/28: ");
    expect(first.system).toContain("요약되지 않았다");
    expect(first.system).not.toContain("1일차");
    expect(first.system).not.toContain("48");
    const said = logged(bot, "day_close_unsummarised");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ messages: 48, days: 4, failures: 3 });
  });

  test("the night after, the summariser is asked again: on the carried summary, about today's day alone", async () => {
    const { store, thread, asked, run, setClock } = harness({
      summarize: flaky(0),
    });
    // Three failures, then the fourth night closes without the summariser.
    for (const day of [0, 1, 2, 3]) {
      dayOfTalk(thread, day);
      run(at(day, 200));
      setClock(at(day + 1, -480));
      await store.tick();
    }
    expect(asked).toHaveLength(3);
    morning(thread, 4);
    expect(run(at(4)).epoch.reason).toBe("day_boundary");
    dayOfTalk(thread, 4);
    run(at(4, 200));
    setClock(at(5, -480));
    await store.tick();
    expect(asked).toHaveLength(4);
    expect(asked[3]?.previous).toContain("요약되지 않았다");
    expect(asked[3]?.transcript).toContain("4일차");
    expect(asked[3]?.transcript).not.toContain("3일차");
  });

  test("a gap line the summariser leaves out of its rewrite is put back: the Bot keeps knowing what its summary does not hold", async () => {
    let calls = 0;
    const { store, thread, run, setClock } = harness({
      summarize: async () => {
        calls += 1;
        // Measured 2026-10-11 with the real summariser: told to carry `previous`, it rewrote the
        // summary without the line saying which days it never covered.
        if (calls <= 3) throw new Error("summary: took too long");
        return "- 9/29: 이 사람이 유자 40박스를 주문했다";
      },
    });
    for (const day of [0, 1, 2, 3]) {
      dayOfTalk(thread, day);
      run(at(day, 200));
      setClock(at(day + 1, -480));
      await store.tick();
    }
    morning(thread, 4);
    run(at(4));
    dayOfTalk(thread, 4);
    run(at(4, 200));
    setClock(at(5, -480));
    expect(await store.tick()).toBe(1);
    morning(thread, 5);
    const first = run(at(5));
    expect(first.epoch.reason).toBe("day_boundary");
    expect(first.system).toContain("유자 40박스");
    expect(first.system).toContain("- 9/24~9/27: ");
    expect(first.system).toContain("요약되지 않았다");
  });

  test("the count survives a restart and an unrelated new epoch, and goes with the close that succeeds", async () => {
    const rows = new Map<
      string,
      Parameters<ConversationPersistence["save"]>[0]
    >();
    const persistence: ConversationPersistence = {
      loadAll: async () => [...rows.values()],
      save: async (row) => {
        rows.set(row.threadId, row);
      },
    };
    const first = harness({ summarize: flaky(0), persistence });
    dayOfTalk(first.thread, 0);
    first.run(at(0, 200));
    first.setClock(at(1, -480));
    await first.store.tick();
    await first.store.settled();
    expect(rows.get("thread_miso")?.epoch).toMatchObject({
      closeFailures: 1,
      closeFailedDay: "2026-09-25",
    });
    // The surface's tool list changes: a new epoch, the same count.
    first.thread.push(user("d1u0", "좋은 아침", at(1)));
    expect(first.run(at(1), "t2").epoch.reason).toBe("tools_changed");
    await first.store.settled();
    expect(rows.get("thread_miso")?.epoch).toMatchObject({ closeFailures: 1 });

    // A restart: the next night is the second failure, not the first.
    let calls = 0;
    const second = harness({
      summarize: async () => {
        calls += 1;
        if (calls === 1) throw new Error("summary: took too long");
        return "- 요약 둘";
      },
      persistence,
    });
    second.thread.push(...first.thread);
    expect(await second.store.load()).toBe(1);
    dayOfTalk(second.thread, 1);
    second.run(at(1, 200), "t2");
    second.setClock(at(2, -480));
    await second.store.tick();
    await second.store.settled();
    expect(rows.get("thread_miso")?.epoch).toMatchObject({ closeFailures: 2 });
    expect(second.asked).toHaveLength(1);
    dayOfTalk(second.thread, 2);
    second.run(at(2, 200), "t2");
    second.setClock(at(3, -480));
    expect(await second.store.tick()).toBe(1);
    second.thread.push(user("d3u0", "좋은 아침", at(3)));
    const taken = second.run(at(3), "t2");
    expect(taken.epoch.reason).toBe("day_boundary");
    expect(taken.system).toContain("- 요약 둘");
    await second.store.settled();
    expect(rows.get("thread_miso")?.epoch).not.toHaveProperty("closeFailures");
  });

  test("a gap line is known by its dates, not its wording: a merged or reworded one is not put back beside the model's, a dropped one is", () => {
    const gap = (when: string) =>
      `- ${when}: 이 기간의 대화는 요약되지 않았다.`;
    const gaps = (text: string) =>
      text.split("\n").filter((line) => line.includes("요약되지 않았다"));
    const merged = withGapsKept(
      `${gap("9/25~9/28")}\n- 9/29: 유자 40박스`,
      `${gap("9/25~9/26")}\n${gap("9/27~9/28")}`,
      "2026-09-30",
    );
    expect(gaps(merged)).toEqual([gap("9/25~9/28")]);
    const reworded = withGapsKept(
      "- 9/25~9/26: 이틀 치 대화는 요약되지 않았다\n- 9/29: 유자 40박스",
      gap("9/25~9/26"),
      "2026-09-30",
    );
    expect(gaps(reworded)).toHaveLength(1);
    const dropped = withGapsKept(
      "- 9/29: 유자 40박스",
      `${gap("9/25~9/26")}\n- 9/27: 감 10박스`,
      "2026-09-30",
    );
    expect(dropped).toBe(`${gap("9/25~9/26")}\n- 9/29: 유자 40박스`);
  });

  test("a new gap line joins the one before it when the days touch, and stands apart when they do not", () => {
    const gap = (when: string) =>
      `- ${when}: 이 기간의 대화는 요약되지 않았다.`;
    const span: Thread = [
      user("u3", "셋째 날", at(3)),
      answer("a3", "네.", at(3, 1)),
      user("u4", "넷째 날", at(4)),
    ];
    const joined = unsummarisedSummary(
      `- 9/20: 유자 40박스\n${gap("9/25~9/26")}`,
      span,
      ZONE,
    );
    expect(joined.summary.split("\n")).toEqual([
      "- 9/20: 유자 40박스",
      expect.stringMatching(/^- 9\/25~9\/28: .*요약되지 않았다/),
    ]);
    expect(joined.days).toBe(2);
    const apart = unsummarisedSummary(gap("9/20~9/21"), span, ZONE);
    expect(apart.summary.split("\n").map((line) => line.slice(0, 12))).toEqual([
      "- 9/20~9/21:",
      "- 9/27~9/28:",
    ]);
  });

  test("a gap line put back survives a rewrite near the bound: the summary's oldest line pays, never the line saying what is missing", () => {
    const gap = "- 9/25~9/26: 이 기간의 대화는 요약되지 않았다.";
    // A rewrite within a gap line's length of the bound: the shape of a long conversation (#200:
    // 126 of 1,324 closes were at 2,700 or more).
    const lines: string[] = [];
    while (lines.join("\n").length < SUMMARY_MAX_CHARS - 10) {
      lines.push(`- 9/${(lines.length % 20) + 1}: 오래된 일 ${lines.length}`);
    }
    lines.push("- 9/29: 한빛농산 유자 40박스");
    const rewrite = boundedSummary(lines.join("\n"));
    expect(rewrite.length).toBeGreaterThan(SUMMARY_MAX_CHARS - gap.length);
    const kept = withGapsKept(rewrite, gap, "2026-09-30");
    expect(kept.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(kept.split("\n")[0]).toBe(gap);
    expect(kept).toContain("한빛농산 유자 40박스");
    // What paid for the line: the rewrite's oldest lines, whole, and no more than the line's length
    // plus the one line cut in the middle.
    const rest = kept.slice(gap.length + 1);
    expect(rewrite.endsWith(rest)).toBe(true);
    expect(rewrite.length - rest.length).toBeLessThan(gap.length + 1 + 20);
  });

  test.each([
    ["an en dash", "- 9/25–9/28: 이 기간의 대화는 요약되지 않았다."],
    ["a hyphen", "- 9/25-9/28: 이 기간의 대화는 요약되지 않았다."],
    ["the last day alone", "- 9/25~28: 이 기간의 대화는 요약되지 않았다."],
    ["a round bullet", "• 9/25~9/28: 이 기간의 대화는 요약되지 않았다."],
    ["a star bullet", "* 9/25~9/28: 이 기간의 대화는 요약되지 않았다."],
    ["a numbered line", "1. 9/25~9/28: 이 기간의 대화는 요약되지 않았다."],
    ["월 and 일", "- 9월 25일~9월 28일: 이 기간의 대화는 요약되지 않았다."],
    ["dots", "- 9.25~9.28: 이 기간의 대화는 요약되지 않았다."],
    ["ISO dates", "- 2026-09-25~2026-09-28: 이 기간의 대화는 요약되지 않았다."],
    ["no colon", "- 9/25~9/28 대화는 요약되지 않았다 (요약 없음)"],
    [
      "a word in between",
      "- 9/25~9/28: 이 기간의 대화는 따로 요약되지 않았다.",
    ],
    [
      "the earlier wording with a second sentence",
      "- 9/25~9/28: 이 기간의 대화는 요약되지 않았다. 그때 나눈 대화는 그대로 남아 있어 찾아볼 수 있다.",
    ],
  ])(
    "a gap line the summariser rewrote with %s is the same gap: not put back beside it",
    (_shape, line) => {
      const kept = withGapsKept(
        `${line}\n- 9/29: 유자 40박스`,
        "- 9/25~9/28: 이 기간의 대화는 요약되지 않았다.",
        "2026-09-30",
      );
      expect(kept.split("\n")).toEqual([line, "- 9/29: 유자 40박스"]);
    },
  );

  test("a line in the owner's words about something not summarised is no gap: kept as a line, and never widened over", () => {
    const report =
      "- 9/24: 이 사람이 상반기 보고서가 요약되지 않았다고 했다; 팀장이 다시 쓰라고 했다";
    const span: Thread = [
      user("u1", "첫째 날", at(1)),
      answer("a1", "네.", at(1, 1)),
      user("u4", "넷째 날", at(4)),
    ];
    const made = unsummarisedSummary(`- 요약 1\n${report}`, span, ZONE);
    expect(made.summary.split("\n")).toEqual([
      "- 요약 1",
      report,
      "- 9/25~9/28: 이 기간의 대화는 요약되지 않았다.",
    ]);
    // Nor put back when the rewrite leaves it out: that is the summariser's own call on a real line.
    expect(withGapsKept("- 요약 2", report, "2026-09-30")).toBe("- 요약 2");
    // Reported speech about the conversation itself is still the owner's line, not the server's.
    expect(
      withGapsKept(
        "- 요약 2",
        "- 9/24: 이 사람이 그날 대화가 요약되지 않았다고 했다",
        "2026-09-30",
      ),
    ).toBe("- 요약 2");
    // And something other than the conversation not being summarised is not the period's gap.
    const paper =
      "- 9/24: 상반기 보고서는 요약되지 않았다; 팀장이 다시 쓰라고 했다";
    expect(withGapsKept("- 요약 2", paper, "2026-09-30")).toBe("- 요약 2");
    expect(unsummarisedSummary(paper, span, ZONE).summary.split("\n")[0]).toBe(
      paper,
    );
  });

  test("the gap line is one sentence, the same for a span and for a day, with nothing after it", () => {
    const span: Thread = [
      user("u1", "첫째 날", at(1)),
      answer("a1", "네.", at(1, 1)),
      user("u4", "넷째 날", at(4)),
    ];
    expect(unsummarisedSummary(null, span, ZONE).summary).toBe(
      "- 9/25~9/28: 이 기간의 대화는 요약되지 않았다.",
    );
    expect(
      unsummarisedSummary("- 요약 1", span.slice(0, 2), ZONE).summary,
    ).toBe("- 요약 1\n- 9/25: 이 기간의 대화는 요약되지 않았다.");
  });

  test("the day after a bounded success: the frozen layer names the bounded day, the summariser was told it, and the rest closes in the daytime for the owner's next message", async () => {
    let calls = 0;
    const { store, thread, asked, run, setClock } = harness({
      summarize: async () => {
        calls += 1;
        if (calls === 1) throw new Error("summary: took too long");
        return `- 요약 ${calls}`;
      },
    });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    expect(await store.tick()).toBe(0);
    dayOfTalk(thread, 1);
    run(at(1, 200));
    setClock(at(2, -480));
    // The retry is bounded to 9/24 alone, and the close it makes is 9/25's, not today's.
    expect(await store.tick()).toBe(1);
    expect(asked[1]?.day.slice(0, 10)).toBe("2026-09-25");
    morning(thread, 2);
    const first = run(at(2));
    expect(first.epoch.reason).toBe("day_boundary");
    expect(first.system).toContain("2026-09-25 전까지");
    expect(first.messages.map((message) => message.id)).toEqual([
      ...Array.from({ length: 6 }, (_, n) => [`d1u${n}`, `d1a${n}`]).flat(),
      "d2u0",
    ]);
    // What remains, 9/25, is closed in the daytime — a close of today would wait for tomorrow.
    setClock(at(2, 10));
    expect(await store.tick()).toBe(1);
    expect(asked[2]?.day.slice(0, 10)).toBe("2026-09-26");
    expect(asked[2]?.previous).toBe("- 요약 2");
    thread.push(user("d2u1", "두 번째", at(2, 30)));
    const second = run(at(2, 30));
    expect(second.epoch.reason).toBe("day_boundary");
    expect(second.system).toContain("2026-09-26 전까지");
    expect(second.system).toContain("- 요약 3");
    expect(second.messages.map((message) => message.id)).toEqual([
      "d2u0",
      "d2u1",
    ]);
  });

  test("a scrub that throws after the summariser answered is not the summariser's failure: nothing is counted", async () => {
    const bot = "bot_scrub";
    const { store, thread, asked, run, setClock } = harness({
      bot,
      forgotten: () => ["유자 40박스"],
      scrub: async () => {
        throw new Error("judge down");
      },
    });
    dayOfTalk(thread, 0);
    run(at(0, 200));
    setClock(at(1, -480));
    expect(await store.tick()).toBe(0);
    expect(asked).toHaveLength(1);
    expect(
      logged(bot, "day_close_failed").map((line) => line.failures),
    ).toEqual([0]);
  });
});
