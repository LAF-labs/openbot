import { describe, expect, test } from "bun:test";
import {
  applyCompaction,
  createCompactor,
  DROPPED_RESULT_HEAD,
  decisionPlan,
  droppedResultText,
  latestSnapshotPlan,
  mergePlans,
} from "../src/context/compaction";
import { createConversationStore } from "../src/context/conversations";
import type {
  JevAsker,
  JevQuestions,
} from "../src/context/vendor/fast-jev-compaction/index";
import { contextFactsFor, systemPromptText } from "../../shared/prompt";

/**
 * Compaction as a cache-safe fork (agent-harness-design row 9): decided once at a threshold,
 * stored, applied the same way to every request after — kept messages the same objects, byte for
 * byte; a dropped call gone with its result; a dropped result a fixed stub — and a new epoch on
 * the next run. And the blind drop the 2026-09-25 evaluation found, pinned: a result holding a
 * detail nobody restated is shown to the judge as a redacted excerpt, so a judge that decides on
 * what it is shown can keep it.
 */

type Msg = Record<string, unknown> & { id: string; role: string };

const user = (id: string, content: string): Msg => ({
  id,
  role: "user",
  content,
});
const said = (id: string, content: string): Msg => ({
  id,
  role: "assistant",
  content,
});
const call = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
  content = "",
): Msg => ({
  id: `a_${id}`,
  role: "assistant",
  content,
  toolCalls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const result = (id: string, content: string): Msg => ({
  id: `t_${id}`,
  role: "tool",
  toolCallId: id,
  content,
});

const page = (title: string, text: string, tab = 0) =>
  JSON.stringify({
    ok: true,
    url: `https://shop.example.test/${title}`,
    title,
    text,
    tabs: [
      { index: tab, title, url: "https://shop.example.test", active: true },
    ],
  });

/** The order detail that holds the needle: a refund reason the Bot never restated. */
const NEEDLE = "환불 사유: 포장 파손으로 재발송 요청";
const ORDER_PAGE = page(
  "주문 20260046",
  [
    "미소상회 주문 상세",
    ...Array.from({ length: 40 }, (_, at) => `${at + 1}. 배송 기록 확인 완료`),
    "주문번호 20260046 · 고객 박지영 · 유자청 500g 1개 · 15,000원",
    NEEDLE,
  ].join("\n"),
);

/** A week's worth: pages read and re-read, an order detail, typing into a login form. */
function thread(): Msg[] {
  return [
    user("u0", "주문 관리 좀 봐줘"),
    call("c1", "computer_navigate", {
      url: "https://shop.example.test/orders",
    }),
    result("c1", page("orders", "주문 목록 1쪽 ".repeat(200))),
    call("c2", "computer_snapshot"),
    result(
      "c2",
      JSON.stringify({
        ok: true,
        snapshotId: 1,
        elements: [
          { ref: "e1", role: "textbox", name: "아이디", value: "miso_owner" },
          { ref: "e2", role: "textbox", name: "비밀번호", type: "password" },
          { ref: "e3", role: "button", name: "로그인" },
        ],
        tabs: [{ index: 0, title: "t", url: "u", active: true }],
      }),
    ),
    call("c3", "computer_type", {
      ref: "e2",
      snapshotId: 1,
      text: "hunter2-secret-pw",
    }),
    result("c3", JSON.stringify({ ok: true })),
    call("c4", "computer_read"),
    result("c4", ORDER_PAGE),
    said("s1", "20260046번 주문은 15,000원 결제완료입니다."),
    user("u1", "고마워. 목록 다시 봐줘"),
    call("c5", "computer_navigate", {
      url: "https://shop.example.test/orders",
    }),
    result("c5", page("orders", "주문 목록 2쪽 ".repeat(200))),
    call("c6", "computer_snapshot"),
    result(
      "c6",
      JSON.stringify({
        ok: true,
        snapshotId: 2,
        elements: [{ ref: "e9", role: "link", name: "주문 20260047" }],
        tabs: [{ index: 0, title: "t", url: "u", active: true }],
      }),
    ),
    said("s2", "목록을 다시 열었습니다."),
    user("u2", "20260046 고객한테 보낼 환불 안내 답장 써줘. 사유도 넣어서."),
    said("s3", "네, 쓰겠습니다."),
    user("u3", "짧게."),
  ];
}

describe("applying a plan", () => {
  test("every message the plan does not name is the very object it was, byte for byte", () => {
    const messages = thread();
    const compacted = applyCompaction(messages as never, {
      c1: "drop_result",
      c3: "drop_call",
    });
    const untouched = new Set(
      ["c1", "c3"].flatMap((id) => [`a_${id}`, `t_${id}`]),
    );
    for (const message of messages) {
      if (untouched.has(message.id)) continue;
      expect(compacted).toContain(message as never);
    }
    expect(JSON.stringify(compacted.find((m) => m.id === "t_c4"))).toBe(
      JSON.stringify(messages.find((m) => m.id === "t_c4")),
    );
  });

  test("a dropped call goes with its result; no result is left without its call", () => {
    const compacted = applyCompaction(thread() as never, { c3: "drop_call" });
    const ids = compacted.map((message) => message.id);
    expect(ids).not.toContain("a_c3");
    expect(ids).not.toContain("t_c3");
  });

  test("a call dropped from a message with text keeps the text and the other calls", () => {
    const both: Msg = {
      id: "a_both",
      role: "assistant",
      content: "두 개 볼게요",
      toolCalls: [
        {
          id: "x",
          type: "function",
          function: { name: "computer_read", arguments: "{}" },
        },
        {
          id: "y",
          type: "function",
          function: { name: "now", arguments: "{}" },
        },
      ],
    };
    const [kept] = applyCompaction([both] as never, { x: "drop_call" });
    expect(kept).toMatchObject({ content: "두 개 볼게요" });
    expect(
      (kept as unknown as { toolCalls: Array<{ id: string }> }).toolCalls.map(
        (entry) => entry.id,
      ),
    ).toEqual(["y"]);
  });

  test("a dropped result keeps its call and becomes the same stub on every request", () => {
    const messages = thread();
    const once = applyCompaction(messages as never, { c1: "drop_result" });
    const twice = applyCompaction(messages as never, { c1: "drop_result" });
    const stub = once.find((m) => m.id === "t_c1") as { content: string };
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(stub.content).toBe(
      droppedResultText(String(messages.find((m) => m.id === "t_c1")?.content)),
    );
    expect(stub.content.length).toBeLessThan(DROPPED_RESULT_HEAD + 120);
    expect(once.map((m) => m.id)).toContain("a_c1");
  });

  test("a later decision adds to an earlier one and never un-drops", () => {
    expect(
      mergePlans(
        { a: "drop_call", b: "drop_result" },
        { a: "drop_result", c: "drop_call" },
      ),
    ).toEqual({ a: "drop_call", b: "drop_result", c: "drop_call" });
  });
});

describe("the deterministic rule: the newest snapshot per tab", () => {
  test("older page texts and element snapshots of a tab are emptied; the newest of each stays", () => {
    const plan = latestSnapshotPlan(thread() as never);
    // c1 and c4 are page texts on tab 0, superseded by c5; c2 is an element snapshot superseded by c6.
    expect(plan).toEqual({
      c1: "drop_result",
      c2: "drop_result",
      c4: "drop_result",
    });
  });

  test("another tab's snapshot is its own", () => {
    const messages = [
      user("u", "두 탭"),
      call("p1", "computer_navigate", { url: "a" }),
      result("p1", page("a", "첫 탭", 0)),
      call("sw", "computer_switch_tab", { index: 1 }),
      result("sw", JSON.stringify({ ok: true })),
      call("p2", "computer_read"),
      result("p2", page("b", "둘째 탭", 1)),
      ...Array.from({ length: 6 }, (_, at) => said(`pad${at}`, "…")),
    ];
    expect(latestSnapshotPlan(messages as never)).toEqual({});
  });

  test("nothing in the newest messages is touched", () => {
    const messages = thread();
    const plan = latestSnapshotPlan(messages as never, messages.length);
    expect(plan).toEqual({});
  });

  /*
   * THE BASELINE'S KNOWN COST, pinned so the eval's comparison is read correctly: an order detail
   * read on a tab that was later navigated away from is emptied, needle and all.
   */
  test("the baseline empties the order detail too, because a newer page came after it", () => {
    const compacted = applyCompaction(
      thread() as never,
      latestSnapshotPlan(thread() as never),
    );
    expect(JSON.stringify(compacted)).not.toContain(NEEDLE);
  });
});

/** A judge that decides only on what it is shown: it keeps a result whose line in the state mentions the goal's topic. */
function judgeOnWhatItSees(topic: string): {
  asker: JevAsker;
  states: unknown[];
} {
  const states: unknown[] = [];
  return {
    states,
    asker: {
      async ask(state, questions: JevQuestions) {
        states.push(state);
        const history = (state as { history: Array<{ tool_calls?: unknown }> })
          .history;
        const results = new Map<string, string>();
        for (const entry of history) {
          for (const tool of (entry.tool_calls ?? []) as Array<{
            id: string;
            result: string;
          }>) {
            if (typeof tool === "object") results.set(tool.id, tool.result);
          }
        }
        const answers: Record<string, { noul: number }> = {};
        for (const name of Object.keys(questions)) {
          const id = name.replace(/^(call|result)_/, "");
          const seen = results.get(id) ?? "";
          answers[name] = {
            noul: name.startsWith("call_")
              ? 0.2
              : seen.includes(topic)
                ? 0.9
                : 0.1,
          };
        }
        return { answers };
      },
    },
  };
}

describe("the blind drop, fixed: a result is shown to the judge as a redacted excerpt", () => {
  test("NEEDLE RECALL: blind, the order detail is dropped; with excerpts, it survives", async () => {
    const blind = judgeOnWhatItSees("환불");
    const blindPlan = await decisionPlan(thread() as never, blind.asker, {
      excerpts: false,
    });
    expect(
      JSON.stringify(applyCompaction(thread() as never, blindPlan.plan)),
    ).not.toContain(NEEDLE);

    const seeing = judgeOnWhatItSees("환불");
    const seeingPlan = await decisionPlan(thread() as never, seeing.asker, {
      excerpts: true,
    });
    expect(seeingPlan.plan.c4).toBeUndefined();
    expect(
      JSON.stringify(applyCompaction(thread() as never, seeingPlan.plan)),
    ).toContain(NEEDLE);
    // The needle reached the judge, deep in the page as it is: the excerpt's salient lines.
    expect(JSON.stringify(seeing.states)).toContain("환불 사유");
  });

  /*
   * NEVER RECORD WHAT SOMEBODY TYPED, applied to what leaves for a judge: the whole state, every
   * batch, serialised, and the typed password and the login's typed value are nowhere in it.
   */
  test("the state never carries a typed value, a secret field or a credential", async () => {
    const judge = judgeOnWhatItSees("환불");
    const messages = [
      ...thread(),
      user(
        "u9",
        "카드 4111 1111 1111 1111, 메일 kim@shop.kr, 키 sk-live_abcdefghijkl 로 해줘",
      ),
    ];
    await decisionPlan(messages as never, judge.asker, { excerpts: true });
    const sent = JSON.stringify(judge.states);
    expect(sent).not.toContain("hunter2-secret-pw");
    expect(sent).not.toContain("miso_owner");
    expect(sent).not.toContain("비밀번호");
    expect(sent).not.toContain("4111 1111 1111 1111");
    expect(sent).not.toContain("kim@shop.kr");
    expect(sent).not.toContain("sk-live_abcdefghijkl");
    // What the decision is about stays: the order number and the amount.
    expect(sent).toContain("20260046");
    expect(sent).toContain("15,000원");
  });

  test("a judge that cannot answer falls back to the deterministic rule", async () => {
    const reasons: string[] = [];
    const compactor = createCompactor({
      mode: "decisions",
      asker: {
        ask: async () => {
          throw new Error("jev: took too long");
        },
      },
      onFallback: (reason) => reasons.push(reason),
    });
    const outcome = await compactor?.(thread() as never);
    expect(outcome?.arm).toBe("fallback");
    expect(outcome?.plan).toEqual(latestSnapshotPlan(thread() as never));
    expect(reasons).toEqual(["jev: took too long"]);
  });
});

describe("in the conversation store: at the threshold, once, and a new epoch", () => {
  const now = new Date("2026-09-24T00:30:00Z");
  const facts = contextFactsFor({
    mode: "chat",
    now,
    bot: { id: "b", name: "미소" },
  });
  const prepare = (
    store: ReturnType<typeof createConversationStore>,
    messages: Msg[],
  ) =>
    store.prepare({
      threadId: "t1",
      botId: "b",
      mode: "chat",
      messages: messages as never,
      key: { harness: "h", model: "m", effort: "e", tools: "x" },
      facts,
      system: (told) => systemPromptText("chat", told.name),
      now,
    });

  test("under the threshold nothing is decided; over it, the next run is a new epoch without the dropped", async () => {
    let asked = 0;
    const store = createConversationStore({
      compaction: {
        thresholdTokens: 50_000,
        compact: async (messages) => {
          asked += 1;
          return { plan: latestSnapshotPlan(messages), arm: "latest-snapshot" };
        },
      },
    });
    const messages = thread();
    const first = prepare(store, messages);
    store.recordUsage("t1", { promptTokens: 20_000 });
    await store.settled();
    expect(asked).toBe(0);

    store.recordUsage("t1", { promptTokens: 61_000 });
    await store.settled();
    expect(asked).toBe(1);

    const after = prepare(store, messages);
    expect(after.epoch).toMatchObject({ reason: "compaction", fresh: true });
    // Emptied to its stub: its head survives, its body does not.
    expect(JSON.stringify(after.messages)).not.toContain(
      "주문 목록 1쪽 ".repeat(40),
    );
    expect(JSON.stringify(after.messages)).toContain("대화를 줄이느라");
    // The kept ones are the objects the run carried.
    const kept = after.messages.find((m) => m.id === "t_c5");
    expect(kept).toBe(messages.find((m) => m.id === "t_c5") as never);
    // And the next request of the epoch sends exactly what this one did: nothing is re-decided.
    const again = prepare(store, messages);
    expect(JSON.stringify(again.messages)).toBe(JSON.stringify(after.messages));
    expect(again.epoch.fresh).toBe(false);
    expect(first.epoch.reason).toBe("resumed");
  });

  test("a compaction that drops nothing new starts no epoch, and is not asked again until the prompt grows", async () => {
    let asked = 0;
    const store = createConversationStore({
      compaction: {
        thresholdTokens: 40_000,
        compact: async () => {
          asked += 1;
          return { plan: {}, arm: "latest-snapshot" };
        },
      },
    });
    prepare(store, thread());
    store.recordUsage("t1", { promptTokens: 45_000 });
    await store.settled();
    store.recordUsage("t1", { promptTokens: 46_000 });
    await store.settled();
    expect(asked).toBe(1);
    expect(prepare(store, thread()).epoch.fresh).toBe(false);
    store.recordUsage("t1", { promptTokens: 56_000 });
    await store.settled();
    expect(asked).toBe(2);
  });
});
