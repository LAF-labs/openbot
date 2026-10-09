import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { withAccountStates } from "../../shared/tools/gallery";
import { withheldToolsText } from "../../shared/tools/paused";
import type { AgentStandingProfile } from "../src/copilot";
import { buildAgents } from "../src/copilot";
import {
  type ConversationStore,
  createConversationStore,
} from "../src/context/conversations";

/**
 * Epochs and reminders, measured where they matter: on the request the provider receives.
 *
 * The server's middleware and `agent-bot` wired together in one process, the way
 * `effort-on-the-wire.integration.test.ts` does it — the fake provider records exactly what an
 * OpenAI-compatible endpoint would have been sent. What is asserted is the thing the cache reads:
 * the tools and the system message byte for byte, and the history as a pure append, while the
 * clock moves, the day turns, the person moves and the Bot is renamed
 * (`~/laf/docs/agent-harness-design.md`, rows 1–4).
 */

type ProviderRequest = {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string } }>;
  reasoning_effort?: string;
};

type Message = { id: string; role: string; content: string };

afterEach(() => {
  setSystemTime();
});

/** 2026-09-24 00:30 UTC: 09:30 on Thursday in Seoul. */
const MORNING = new Date("2026-09-24T00:30:00Z");
const minutes = (count: number) => new Date(MORNING.getTime() + count * 60_000);

function profileOf(
  overrides: Partial<AgentStandingProfile> = {},
): AgentStandingProfile {
  return {
    id: "agent_miso",
    name: "미소",
    roleDescription: "",
    memories: ["택배는 우체국을 쓴다."],
    person: { timeZone: "Asia/Seoul", locale: "ko-KR", place: "서울 성동구" },
    ...overrides,
  };
}

/** The surface's tools, in the order it happened to mount them. */
const TOOLS = [
  { name: "remember", description: "기억한다", parameters: {} },
  { name: "computer_navigate", description: "연다", parameters: {} },
];

/**
 * One run of the conversation as the browser would send it, through a freshly built agent map —
 * production builds one per request — against one conversation store, which outlives them all.
 */
async function run(
  store: ConversationStore,
  history: Message[],
  options: {
    profile?: AgentStandingProfile;
    model?: string;
    /** Whether the deployment says its model takes an effort. Yes unless a case says otherwise. */
    supportsEffort?: boolean;
    forwardedProps?: Record<string, unknown>;
    threadId?: string;
    tools?: typeof TOOLS;
    /** The usage chunk the provider ends with, as OpenRouter sends it. */
    usage?: Record<string, unknown>;
    auditStore?: AuditStore;
  } = {},
): Promise<{ request: ProviderRequest; forwarded: Record<string, unknown> }> {
  process.env.OPENAI_API_KEY ??= "test-key";
  const { runAgent } = await import("../../agent-bot/src/index");
  let request: ProviderRequest = { messages: [] };
  let forwarded: Record<string, unknown> = {};
  const profile = options.profile ?? profileOf();
  const agents = buildAgents(
    [
      {
        id: profile.id,
        name: profile.name,
        type: "remote_ag_ui",
        endpoint: "http://agent-bot.internal/ag-ui",
        profile,
      },
    ],
    {
      provider: "openai",
      defaultModel: options.model ?? "z-ai/glm-5.3-flash",
      supportsEffort: options.supportsEffort ?? true,
    },
    {
      watch: () =>
        (async (_url: unknown, init?: { body?: unknown }) => {
          const input = JSON.parse(String(init?.body ?? "{}"));
          forwarded = input.forwardedProps;
          return runAgent(input, (async (sent: ProviderRequest) => {
            request = sent;
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  provider: "Z.AI",
                  choices: [
                    { delta: { content: "네." }, finish_reason: "stop" },
                  ],
                };
                if (options.usage) {
                  yield { provider: "Z.AI", choices: [], usage: options.usage };
                }
              },
            };
          }) as never);
        }) as never,
      stop: () => undefined,
    },
    "Asia/Seoul",
    undefined,
    {
      conversations: store,
      ...(options.auditStore ? { auditStore: options.auditStore } : {}),
    },
  );
  const agent = agents[profile.id];
  if (!agent) throw new Error("no agent was built");
  // The runtime restores the thread onto a fresh agent each request; the id is what persists.
  agent.threadId = options.threadId ?? "thread_miso";
  agent.setMessages(structuredClone(history) as never);
  await agent
    .runAgent({
      tools: options.tools ?? TOOLS,
      forwardedProps: options.forwardedProps ?? {},
    } as never)
    .catch(() => {});
  return { request, forwarded };
}

const system = (request: ProviderRequest) =>
  request.messages.find((message) => message.role === "system")?.content ?? "";

const lastUser = (request: ProviderRequest) =>
  request.messages.filter((message) => message.role === "user").at(-1)
    ?.content ?? "";

/** The conversation so far, as the browser holds it: what the person said and what the Bot said. */
function conversation(...said: string[]): Message[] {
  return said.flatMap((text, at) => [
    { id: `u${at}`, role: "user", content: text },
    ...(at < said.length - 1
      ? [{ id: `a${at}`, role: "assistant", content: "네." }]
      : []),
  ]);
}

describe("inside one epoch, the front of every request is the same bytes", () => {
  test("tools and system message identical, history a pure append — the minute moving", async () => {
    const store = createConversationStore();
    setSystemTime(minutes(0));
    const first = await run(store, conversation("안녕"));
    setSystemTime(minutes(7));
    const second = await run(store, conversation("안녕", "지금 뭐 해?"));
    setSystemTime(minutes(23));
    const third = await run(
      store,
      conversation("안녕", "지금 뭐 해?", "고마워"),
    );

    expect(JSON.stringify(second.request.tools)).toBe(
      JSON.stringify(first.request.tools),
    );
    expect(system(second.request)).toBe(system(first.request));
    expect(system(third.request)).toBe(system(first.request));
    // Every message the earlier request sent is sent again, unchanged, in the same place.
    expect(
      third.request.messages.slice(0, second.request.messages.length),
    ).toEqual(second.request.messages);
    // No minute anywhere in the prompt: that is the `now` tool's.
    expect(system(first.request)).not.toMatch(/\d{2}:\d{2}/);
    expect(system(first.request)).toContain("오늘은 2026-09-24 (목)");
  });

  /*
   * The effort is part of what an epoch is frozen against, so it has to be one value for the life
   * of the conversation (2026-10-08, docs/laf/redesign-2026-10.md §4): the deployment's fixed one,
   * or `none` where nothing is sent — never a Bot's own, which a press could move mid-conversation.
   */
  test("the epoch is keyed on the one fixed effort, or on none where none is sent", async () => {
    for (const [supportsEffort, effort] of [
      [true, "balanced"],
      [false, "none"],
    ] as const) {
      const store = createConversationStore();
      const prepare = spyOn(store, "prepare");
      await run(store, conversation("안녕"), { supportsEffort });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0]?.[0].key.effort).toBe(effort);
    }
  });

  test("tools in one sorted order, `now` among them, whatever order the surface mounted", async () => {
    const store = createConversationStore();
    const { request } = await run(store, conversation("안녕"));
    const names = (request.tools ?? []).map((tool) => tool.function.name);
    expect(names).toContain("now");
    expect(names).toEqual([...names].sort());
  });

  test("the person's zone and the question's dollars travel to agent-bot", async () => {
    const store = createConversationStore();
    const { forwarded } = await run(store, conversation("지금 몇 시야?"), {
      profile: profileOf({ person: { timeZone: "Asia/Dubai" } }),
    });
    expect(forwarded.timeZone).toBe("Asia/Dubai");
    expect(forwarded.question).toEqual({ costUsd: 0 });
    expect(forwarded.epoch).toMatchObject({ reason: "conversation_start" });
  });
});

describe("a change mid-epoch is a reminder on the person's new message", () => {
  test("A NEW DAY: the date arrives on the first message of the day, and stays where it landed", async () => {
    const store = createConversationStore();
    setSystemTime(minutes(0));
    const first = await run(store, conversation("안녕"));
    // 18 hours later: Friday morning in Seoul.
    setSystemTime(minutes(18 * 60));
    const nextDay = await run(store, conversation("안녕", "오늘 뭐 하지?"));

    expect(system(nextDay.request)).toBe(system(first.request));
    const said = lastUser(nextDay.request);
    expect(said.startsWith("오늘 뭐 하지?\n\n<알림>")).toBe(true);
    expect(said).toContain("날짜가 바뀌었다. 오늘은 2026-09-25 (금)이다.");
    expect(said.endsWith("</알림>")).toBe(true);

    // A step later, and the next message: the reminder is sent again word for word, once.
    setSystemTime(minutes(18 * 60 + 3));
    const later = await run(
      store,
      conversation("안녕", "오늘 뭐 하지?", "알았어"),
    );
    expect(
      later.request.messages.slice(0, nextDay.request.messages.length),
    ).toEqual(nextDay.request.messages);
    expect(lastUser(later.request)).toBe("알았어");
  });

  test("A PLACE CHANGE reaches the Bot at once, without touching the frozen layer", async () => {
    const store = createConversationStore();
    const first = await run(store, conversation("안녕"));
    const moved = await run(store, conversation("안녕", "날씨 어때?"), {
      profile: profileOf({
        person: {
          timeZone: "Asia/Seoul",
          locale: "ko-KR",
          place: "부산 해운대구",
        },
      }),
    });
    expect(system(moved.request)).toBe(system(first.request));
    expect(system(moved.request)).toContain("서울 성동구");
    expect(lastUser(moved.request)).toContain(
      "이 사람의 위치가 바뀌었다. 이 사람의 위치(가게나 주로 지내는 곳): 부산 해운대구.",
    );
  });

  test("a rename, and a memory the person wrote — but not one the Bot just wrote itself", async () => {
    const store = createConversationStore();
    await run(store, conversation("안녕"));
    const history: Message[] = [
      ...conversation("안녕", "월요일은 쉬어. 기억해"),
    ];
    const withCall = [
      ...history,
      {
        id: "a_remember",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_r",
            type: "function",
            function: {
              name: "remember",
              arguments: JSON.stringify({ fact: "월요일은 쉰다." }),
            },
          },
        ],
      } as unknown as Message,
      {
        id: "t_remember",
        role: "tool",
        content: '{"ok":true}',
        toolCallId: "call_r",
      } as unknown as Message,
      { id: "u_next", role: "user", content: "고마워, 다솜" },
    ];
    const next = await run(store, withCall, {
      profile: profileOf({
        name: "다솜",
        memories: [
          "택배는 우체국을 쓴다.",
          "월요일은 쉰다.",
          "단골은 김 사장님이다.",
        ],
      }),
    });
    const said = lastUser(next.request);
    expect(said).toContain("네 이름이 바뀌었다. 너는 이제 다솜이다.");
    expect(said).toContain("- 단골은 김 사장님이다.");
    // The Bot's own `remember` is in the conversation already; it is not told back to it.
    expect(said).not.toContain("월요일은 쉰다");
  });

  /*
   * "잊어" MEANS THE WORDS STOP REACHING THE MODEL — a reminder could not do that, since the frozen
   * layer would go on carrying them. A forgotten memory is a new epoch, and a reminder that once
   * announced it loses that line.
   */
  test("a memory the person had forgotten leaves the request entirely — a new epoch", async () => {
    const store = createConversationStore();
    await run(store, conversation("안녕"));
    // Somebody else's memory arrives mid-epoch, as a reminder…
    const told = await run(store, conversation("안녕", "그래"), {
      profile: profileOf({
        memories: ["택배는 우체국을 쓴다.", "단골은 김 사장님이다."],
      }),
    });
    expect(lastUser(told.request)).toContain("- 단골은 김 사장님이다.");
    // …and then the person has both forgotten.
    const forgot = await run(store, conversation("안녕", "그래", "고마워"), {
      profile: profileOf({ memories: [] }),
    });
    expect(forgot.forwarded.epoch).toMatchObject({
      reason: "memory_forgotten",
    });
    const everything = JSON.stringify(forgot.request.messages);
    expect(everything).not.toContain("택배는 우체국을 쓴다");
    expect(everything).not.toContain("단골은 김 사장님이다");
    expect(everything).not.toContain("새로 적힌 기억이다");
  });
});

describe("a new epoch, when the head of the prompt breaks anyway", () => {
  test("the model changing re-freezes the layer with what is true now", async () => {
    const store = createConversationStore();
    setSystemTime(minutes(0));
    const first = await run(store, conversation("안녕"));
    setSystemTime(minutes(18 * 60));
    const swapped = await run(store, conversation("안녕", "안녕"), {
      model: "another/model",
    });
    expect(system(swapped.request)).not.toBe(system(first.request));
    expect(system(swapped.request)).toContain("오늘은 2026-09-25 (금)");
    // Nothing to remind of: the new layer already says it.
    expect(lastUser(swapped.request)).toBe("안녕");
    expect(swapped.forwarded.epoch).toMatchObject({ reason: "model_changed" });
  });

  test("a tool appearing is a new epoch too — and says so", async () => {
    const store = createConversationStore();
    await run(store, conversation("안녕"));
    const { forwarded } = await run(store, conversation("안녕", "그래"), {
      tools: [
        ...TOOLS,
        { name: "skill_view", description: "스킬을 읽는다", parameters: {} },
      ],
    });
    expect(forwarded.epoch).toMatchObject({ reason: "tools_changed" });
  });

  /*
   * CONNECTING A SERVICE IS NOT A NEW EPOCH (agent-harness-design row 5). Its tools wait behind
   * the bridge, so the tool list — the head of the prompt — does not move; what is behind the
   * bridge is named in the context layer, and a change to it is a reminder on the person's next
   * message, the way Claude Code announces a deferred tool.
   */
  test("connecting a service keeps the head of the prompt and arrives as a reminder", async () => {
    const store = createConversationStore();
    const first = await run(store, conversation("안녕"));
    const connected = await run(store, conversation("안녕", "메일 보내줘"), {
      tools: [
        ...TOOLS,
        {
          name: "mcp__gmail__send_message",
          description: "메일을 보낸다. (gmail)",
          parameters: {},
        },
        { name: "showBarChart", description: "막대그래프", parameters: {} },
      ],
    });
    expect(JSON.stringify(connected.request.tools)).toBe(
      JSON.stringify(first.request.tools),
    );
    expect(system(connected.request)).toBe(system(first.request));
    expect(connected.forwarded.epoch).toMatchObject({
      reason: "conversation_start",
    });
    expect(lastUser(connected.request)).toContain("쓸 수 있는 도구가 바뀌었다");
    expect(lastUser(connected.request)).toContain(
      "- 지메일: mcp__gmail__send_message",
    );
    expect(lastUser(connected.request)).toContain(
      "- 화면에 띄우는 카드: showBarChart",
    );
  });

  /*
   * WHAT COULD STILL BE CONNECTED IS IN THE CONTEXT LAYER ONLY WHILE THERE IS SOMETHING (2026-10-05).
   * The turn writes a person's accounts on the connect card (`turns/chat-tools.ts`); this seam
   * reads the open ones off it and the layer ends on one sentence about connecting. With the last
   * account connected the sentence goes — as a reminder, like any change behind the bridge, never
   * as an epoch — and no provider is ever sent anybody's accounts.
   */
  test("the sentence about connecting rides only while an account is open, and its going is a reminder", async () => {
    const SAYS = "못 본다고 답하기 전에 tool_search로 한 번 찾는다";
    const withCard = (connected: boolean) =>
      [
        ...TOOLS,
        {
          name: "showConnection",
          description: "연결 스위치를 띄운다",
          parameters: withAccountStates({ type: "object", properties: {} }, [
            { key: "gmail", connected },
          ]),
        },
      ] as never;
    const store = createConversationStore();
    const open = await run(store, conversation("안녕"), {
      tools: withCard(false),
    });
    expect(system(open.request)).toContain(SAYS);
    expect(JSON.stringify(open.request)).not.toContain("x-accounts");

    const connected = await run(store, conversation("안녕", "그래"), {
      tools: withCard(true),
    });
    expect(JSON.stringify(connected.request.tools)).toBe(
      JSON.stringify(open.request.tools),
    );
    expect(system(connected.request)).toBe(system(open.request));
    expect(connected.forwarded.epoch).toMatchObject({
      reason: "conversation_start",
    });
    expect(lastUser(connected.request)).toContain("쓸 수 있는 도구가 바뀌었다");
    expect(lastUser(connected.request)).not.toContain(SAYS);

    // A conversation that begins with nothing left to connect never reads it.
    const settled = await run(createConversationStore(), conversation("안녕"), {
      tools: withCard(true),
    });
    expect(system(settled.request)).not.toContain(SAYS);
    expect(system(settled.request)).toContain(
      "- 화면에 띄우는 카드: showConnection",
    );
  });

  /*
   * HOW MANY TOOLS WAIT FOR REVIEW UNDER NO NAME IS IN THAT PARAGRAPH TOO (2026-10-06), and moves
   * the way everything in it moves. A tool that appeared after registration is offered under no
   * name, so it is in no tool list; the turn counts what it could not list and forwards the count
   * beside the tools (`shared/tools/paused.ts`), and this seam draws one line of it. The line is
   * there because that paragraph tells a Bot the names it lists are everything — pressed on the
   * real stack, a Bot asked for a tool in a toolbox whose tools all waited made no lookup and said
   * only that the tool was not in its list. Not a tool and not in the static layer: the head stays
   * the same bytes, a count that appears or changes is a reminder on the person's next message,
   * and no epoch opens for it — the epoch's key counts core tools, and this is none.
   */
  test("how many tools wait for review rides in the context layer: a reminder when the count appears or changes, the frozen layer at a conversation's start, a routine's too — and never an epoch, never a different head", async () => {
    const line = (count: number) =>
      withheldToolsText(`카카오(kakao-playmcp) ${count}개`);
    const waiting = (count: number) => ({
      toolsWithheld: [{ server: "kakao-playmcp", count }],
    });
    const said = [
      "안녕",
      "카카오에 담은 길찾기 써 줘",
      "그래",
      "하나 검토했어",
    ];
    const store = createConversationStore();
    const first = await run(store, conversation(...said.slice(0, 1)));
    expect(system(first.request)).not.toContain("검토를 기다리고");

    // The person fills 카카오's toolbox and connects again: two tools wait, under no name.
    const two = await run(store, conversation(...said.slice(0, 2)), {
      forwardedProps: waiting(2),
    });
    expect(JSON.stringify(two.request.tools)).toBe(
      JSON.stringify(first.request.tools),
    );
    expect(system(two.request)).toBe(system(first.request));
    expect(two.forwarded.epoch).toEqual(first.forwarded.epoch);
    expect(two.forwarded.epoch).toMatchObject({ reason: "conversation_start" });
    expect(lastUser(two.request)).toContain(
      `쓸 수 있는 도구가 바뀌었다. ${line(2)}`,
    );

    // Said once: with the same two still waiting, the next message carries nothing — and the
    // message that carried the reminder still does, where it landed.
    const still = await run(store, conversation(...said.slice(0, 3)), {
      forwardedProps: waiting(2),
    });
    expect(lastUser(still.request)).toBe("그래");
    expect(
      still.request.messages.slice(0, two.request.messages.length),
    ).toEqual(two.request.messages);
    expect(still.forwarded.epoch).toEqual(first.forwarded.epoch);

    // One is reviewed: the count changed, so the paragraph did, and that is a reminder again.
    const one = await run(store, conversation(...said), {
      forwardedProps: waiting(1),
    });
    expect(lastUser(one.request)).toContain(line(1));
    expect(lastUser(one.request)).not.toContain(line(2));
    expect(system(one.request)).toBe(system(first.request));
    expect(JSON.stringify(one.request.tools)).toBe(
      JSON.stringify(first.request.tools),
    );
    expect(one.forwarded.epoch).toEqual(first.forwarded.epoch);

    // The other too: nothing waits, and with nothing behind the bridge either the paragraph is gone.
    const none = await run(store, conversation(...said, "나머지도 검토했어"));
    expect(lastUser(none.request)).toContain("목록 밖의 도구는 이제 없다");
    expect(lastUser(none.request)).not.toContain("검토를 기다리고");
    expect(none.forwarded.epoch).toEqual(first.forwarded.epoch);
    // The count itself is no provider's to read: only the sentence drawn from it.
    expect(JSON.stringify([two.request, one.request])).not.toContain(
      "toolsWithheld",
    );

    /*
     * A CONVERSATION THAT BEGINS WHILE THEY WAIT reads the line in its frozen layer, and its first
     * message carries no reminder. This run has nothing behind the bridge at all — every tool of
     * the one connected service waits — so the line is that whole paragraph: the system message
     * is the one a conversation with nothing waiting gets, and this after it.
     */
    const begun = await run(createConversationStore(), conversation("안녕"), {
      forwardedProps: waiting(2),
    });
    expect(system(begun.request)).toBe(
      `${system(first.request)}\n\n${line(2)}`,
    );
    expect(JSON.stringify(begun.request.tools)).toBe(
      JSON.stringify(first.request.tools),
    );
    expect(lastUser(begun.request)).toBe("안녕");

    // And a routine's run, which nobody watches and which has no card to be told through.
    const routine = await run(
      createConversationStore(),
      [{ id: "instruction", role: "user", content: "카카오로 길 찾아 줘" }],
      {
        threadId: "routine_run_waiting",
        forwardedProps: {
          mode: "routine",
          routine: { scheduledFor: null },
          ...waiting(2),
        },
      },
    );
    expect(system(routine.request).endsWith(`\n\n${line(2)}`)).toBe(true);
    expect(system(routine.request)).toContain("화면 앞에는 아무도 없다");
  });

  test("the compaction hook starts one on the next run", async () => {
    const store = createConversationStore();
    await run(store, conversation("안녕"));
    store.beginEpoch("thread_miso", "compaction");
    const { forwarded } = await run(store, conversation("안녕", "그래"));
    expect(forwarded.epoch).toMatchObject({ reason: "compaction" });
  });
});

describe("a routine run knows when it was meant for", () => {
  test("its instruction carries the scheduled time and the start, in the person's zone", async () => {
    const store = createConversationStore();
    // Due 07:30 in Seoul; started 07:31.
    setSystemTime(new Date("2026-09-24T22:31:00Z"));
    const { request } = await run(
      store,
      [{ id: "instruction", role: "user", content: "오늘 주문 확인해줘" }],
      {
        threadId: "routine_run_1",
        forwardedProps: {
          mode: "routine",
          routine: { scheduledFor: "2026-09-24T22:30:00.000Z" },
        },
      },
    );
    const said = lastUser(request);
    expect(said).toContain(
      "이 루틴 실행은 07:30에 예약된 것이고, 2026-09-25 (금) 07:31 Asia/Seoul(KST)에 시작했다.",
    );
    expect(system(request)).toContain("오늘은 2026-09-25 (금)");
  });

  test("Run now says it was not scheduled", async () => {
    const store = createConversationStore();
    const { request } = await run(
      store,
      [{ id: "instruction", role: "user", content: "오늘 주문 확인해줘" }],
      {
        threadId: "routine_run_2",
        forwardedProps: { mode: "routine", routine: { scheduledFor: null } },
      },
    );
    expect(lastUser(request)).toContain("지금 바로 실행하라는 요청으로");
  });
});

describe("the cache hit rate, treated like uptime", () => {
  const usageRows = () => {
    const rows: AuditEventInput[] = [];
    const auditStore: AuditStore = {
      insert: async (event) => {
        rows.push(event);
      },
    };
    return { rows, auditStore };
  };

  test("every usage row names its epoch, why it began, the provider and the dollars", async () => {
    const store = createConversationStore();
    const { rows, auditStore } = usageRows();
    setSystemTime(minutes(0));
    await run(store, conversation("안녕"), {
      auditStore,
      usage: {
        prompt_tokens: 8000,
        completion_tokens: 10,
        total_tokens: 8010,
        cost: 0.0012,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    });
    setSystemTime(minutes(2));
    await run(store, conversation("안녕", "그래"), {
      auditStore,
      usage: {
        prompt_tokens: 8100,
        completion_tokens: 10,
        total_tokens: 8110,
        cost: 0.0003,
        prompt_tokens_details: { cached_tokens: 7936, cache_write_tokens: 0 },
      },
    });
    await Bun.sleep(0);
    const [first, second] = rows.map((row) => row.payload);
    expect(first).toMatchObject({
      provider: "Z.AI",
      costUsd: 0.0012,
      cachedPromptTokens: 0,
      uncachedPromptTokens: 8000,
      epochReason: "conversation_start",
      epochStart: true,
    });
    expect(second).toMatchObject({
      epochId: first?.epochId,
      epochStart: false,
      idleSeconds: 120,
      cachedPromptTokens: 7936,
    });
    expect(second).not.toHaveProperty("cacheLow");
  });

  test("a warm request in an established epoch that reads under half from cache is a break — logged", async () => {
    const store = createConversationStore();
    const { rows, auditStore } = usageRows();
    const warned = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const miss = {
        prompt_tokens: 20_000,
        completion_tokens: 10,
        total_tokens: 20_010,
        prompt_tokens_details: { cached_tokens: 1_024 },
      };
      setSystemTime(minutes(0));
      await run(store, conversation("안녕"), { auditStore, usage: miss });
      setSystemTime(minutes(3));
      await run(store, conversation("안녕", "그래"), {
        auditStore,
        usage: miss,
      });
      // After forty minutes the cache is cold for reasons that are nobody's bug.
      setSystemTime(minutes(40));
      await run(store, conversation("안녕", "그래", "또"), {
        auditStore,
        usage: miss,
      });
      await Bun.sleep(0);
      expect(rows.map((row) => row.payload.cacheLow ?? false)).toEqual([
        false,
        true,
        false,
      ]);
      const lines = warned.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("cache_hit_low"));
      expect(lines).toHaveLength(1);
      // Counts and ids — never what anybody said.
      expect(lines[0]).not.toContain("그래");
    } finally {
      warned.mockRestore();
    }
  });

  test("a question's dollars reach agent-bot, and a new question starts at zero", async () => {
    const store = createConversationStore();
    const costing = {
      prompt_tokens: 100,
      completion_tokens: 1,
      total_tokens: 101,
      cost: 0.004,
    };
    await run(store, conversation("찾아줘"), { usage: costing });
    // The same question, its next step.
    const step = await run(
      store,
      [
        ...conversation("찾아줘"),
        { id: "a_step", role: "assistant", content: "찾는 중" },
      ],
      { usage: costing },
    );
    expect(step.forwarded.question).toEqual({ costUsd: 0.004 });
    const next = await run(store, conversation("찾아줘", "다른 거"));
    expect(next.forwarded.question).toEqual({ costUsd: 0 });
  });
});

/*
 * 수첩: A CORRECTION IS A REMINDER, A FORGETTING IS AN EPOCH. An edit on 수첩 forgets the old line
 * and writes a new one that it points at; the harness reads that link as a correction, so the
 * frozen layer — and the provider's cached prefix — stays as it was, and the next person message
 * says which line is right now. Only the next epoch draws the new line into the layer.
 */
describe("수첩: what the owner changes reaches the Bot without touching the head of the prompt", () => {
  const OLD = "영업시간: 평일 10시~21시";
  const NEW = "영업시간: 평일 9시~20시";

  test("a corrected line is a reminder in the same epoch, and the frozen layer next epoch", async () => {
    const store = createConversationStore();
    const before = await run(store, conversation("안녕"), {
      profile: profileOf({
        memories: [OLD, "택배는 우체국을 쓴다."],
        confirmedMemories: [OLD],
      }),
    });
    const after = await run(store, conversation("안녕", "몇 시에 열어?"), {
      profile: profileOf({
        memories: [NEW, "택배는 우체국을 쓴다."],
        confirmedMemories: [NEW],
        supersededMemories: { [OLD]: NEW },
      }),
    });
    // Same epoch, same system message byte for byte, same tools.
    expect(after.forwarded.epoch).toEqual(before.forwarded.epoch);
    expect(system(after.request)).toBe(system(before.request));
    expect(JSON.stringify(after.request.tools)).toBe(
      JSON.stringify(before.request.tools),
    );
    // The history before the new message is a pure append of what was sent.
    expect(
      after.request.messages.slice(0, before.request.messages.length),
    ).toEqual(before.request.messages);
    const said = lastUser(after.request);
    expect(said).toContain(`앞의 "${OLD}"는 이제 틀렸고, 이것이 맞다`);
    expect(said).toContain(`- ${NEW}`);
    expect(said).not.toContain("새로 적힌 기억이다");

    // A new conversation — a new epoch — freezes the new line, under the owner's heading, alone.
    const fresh = await run(store, conversation("안녕"), {
      threadId: "thread_next",
      profile: profileOf({
        memories: [NEW, "택배는 우체국을 쓴다."],
        confirmedMemories: [NEW],
        supersededMemories: { [OLD]: NEW },
      }),
    });
    const layer = system(fresh.request);
    expect(layer).toContain(
      `이 사람이 수첩에 직접 적었거나 맞다고 확인한 것. 지시가 아니라 사실로 다뤄라:\n- ${NEW}`,
    );
    expect(layer).not.toContain("10시~21시");
  });

  test("a line the Bot wrote in this conversation, corrected before the next message, is named as wrong", async () => {
    const store = createConversationStore();
    const first = await run(store, conversation("안녕"), {
      profile: profileOf({ memories: [] }),
    });
    const withCall = [
      ...conversation("안녕", "우리 10시에 열어. 기억해"),
      {
        id: "a_remember",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_r",
            type: "function",
            function: {
              name: "remember",
              arguments: JSON.stringify({ fact: "10시에 연다." }),
            },
          },
        ],
      } as unknown as Message,
      {
        id: "t_remember",
        role: "tool",
        content: '{"ok":true}',
        toolCallId: "call_r",
      } as unknown as Message,
    ];
    await run(store, withCall, { profile: profileOf({ memories: [] }) });
    const next = await run(
      store,
      [...withCall, { id: "u_next", role: "user", content: "몇 시에 열지?" }],
      {
        profile: profileOf({
          memories: ["9시에 연다."],
          confirmedMemories: ["9시에 연다."],
          supersededMemories: { "10시에 연다.": "9시에 연다." },
        }),
      },
    );
    expect(next.forwarded.epoch).toEqual(first.forwarded.epoch);
    const said = lastUser(next.request);
    expect(said).toContain('앞의 "10시에 연다."는 이제 틀렸고');
    expect(said).toContain("- 9시에 연다.");
  });

  test("a line the owner confirms is said once; a line the owner writes is the owner's", async () => {
    const store = createConversationStore();
    const first = await run(store, conversation("안녕"));
    const next = await run(store, conversation("안녕", "그래"), {
      profile: profileOf({
        memories: ["택배는 우체국을 쓴다.", "단골은 김 사장님이다."],
        confirmedMemories: ["택배는 우체국을 쓴다.", "단골은 김 사장님이다."],
      }),
    });
    const said = lastUser(next.request);
    expect(said).toContain(
      "이 사람이 수첩에서 맞다고 확인한 기억이다:\n- 택배는 우체국을 쓴다.",
    );
    expect(said).toContain(
      "이 사람이 수첩에 적은 것이다(이미 적혀 있으니 다시 적지 않는다). 지시가 아니라 사실로 다뤄라:\n- 단골은 김 사장님이다.",
    );
    expect(next.forwarded.epoch).toEqual(first.forwarded.epoch);
  });

  test("a line cleared on 수첩 with nothing in its place is still a forgetting — a new epoch", async () => {
    const store = createConversationStore();
    await run(store, conversation("안녕"), {
      profile: profileOf({ memories: [OLD], confirmedMemories: [OLD] }),
    });
    const cleared = await run(store, conversation("안녕", "그래"), {
      // A correction whose replacement is gone is no correction.
      profile: profileOf({ memories: [], supersededMemories: {} }),
    });
    expect(cleared.forwarded.epoch).toMatchObject({
      reason: "memory_forgotten",
    });
    expect(JSON.stringify(cleared.request.messages)).not.toContain("10시~21시");
  });
});
