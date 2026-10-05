import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WEATHER_TOOL_NAME } from "../../shared/tools/bridge";
import type { AuditEventInput } from "../src/audit";
import { sayFirstMove } from "../src/boot/announce";
import type { Decision } from "../src/computer/decision-call";
import { catalogueEntry, classifyTool } from "../src/plugins/catalogue";
import { listTools as gmailTools } from "../src/plugins/gmail-rest";
import { listTools as calendarTools } from "../src/plugins/google-calendar-rest";
import { toolNameFor } from "../src/plugins/store";
import {
  CALENDAR_SERVER,
  CALENDAR_TOOL_NAME,
  createFirstMove,
  FIRST_MOVE_MAX_CHARS,
  FIRST_MOVE_SPECS,
  FIRST_MOVE_TIMEOUT_MS,
  FIRST_MOVE_WARM_UP_TIMEOUT_MS,
  FIRST_MOVES,
  firstMoveForTurns,
  firstMoveStateOf,
  kindsMentioned,
  MAIL_SERVER,
  MAIL_TOOL_NAME,
  mentionsWeather,
  questionsFor,
  settleDecision,
  warmFirstMove,
} from "../src/turns/first-move";

/**
 * A turn's first step, decided before the Bot's model is asked (`turns/first-move.ts`).
 *
 * What these hold it to is mostly what it must NOT do: ask anybody about a message it has no
 * business sending, move on anything short of a clear yes, move for a person who has not connected
 * the service or a Bot that does not hold the tool, move for two kinds at once, or let a word of
 * the decisions model's answer become an argument. That it moves when it should is the eval's to
 * measure, on messages somebody else labelled (`evals/first-move.ts`).
 */

type Asked = {
  state: object;
  questions: Record<string, unknown>;
  timeoutMs: number;
};

/** A decisions model that answers what it is told to, and records what it was shown. */
function jev(answers: Record<string, number> | "down" | "throws") {
  const asked: Asked[] = [];
  const ask = async (question: Asked): Promise<Decision> => {
    asked.push(question);
    if (answers === "throws") throw new Error("socket closed");
    if (answers === "down")
      return { ok: false, because: "took too long", ms: 1200 };
    return {
      ok: true,
      model: "typesafe/jev-test",
      ms: 240,
      answers: Object.fromEntries(
        Object.entries(answers).map(([name, noul]) => [
          name,
          { type: "noul" as const, noul },
        ]),
      ),
    };
  };
  return { ask, asked };
}

const WEATHER_BARS = FIRST_MOVE_SPECS.weather.bars as {
  forecast: number;
  ownPlace: number;
};
const WEATHER_QUESTIONS = FIRST_MOVE_SPECS.weather.questions;
const SURE = { forecast: 0.95, ownPlace: 0.92 };
/** Sure of every question of every kind: what a message asking for everything would get. */
const SURE_OF_ALL = {
  ...SURE,
  schedule: 0.96,
  today: 0.94,
  mail: 0.97,
  unfiltered: 0.93,
};
const said = (content: unknown, role = "user") => [{ role, content }];
const withTool = new Set([
  WEATHER_TOOL_NAME,
  CALENDAR_TOOL_NAME,
  MAIL_TOOL_NAME,
  "computer_navigate",
]);
const ALL = FIRST_MOVES;

const turn = (
  asked: readonly { role: string; content?: unknown }[],
  over: {
    toolNames?: ReadonlySet<string>;
    hasPlace?: boolean;
    connected?: readonly string[];
  } = {},
) => ({
  asked,
  toolNames: over.toolNames ?? withTool,
  hasPlace: async () => over.hasPlace ?? true,
  hasConnection: async (serverId: string) =>
    (over.connected ?? [CALENDAR_SERVER, MAIL_SERVER]).includes(serverId),
});

describe("the first move: when nobody is asked", () => {
  test("off is off: no move named, or no decisions model to ask", async () => {
    const model = jev(SURE);
    const noMoves = createFirstMove({ moves: [], ask: model.ask });
    expect(await noMoves(turn(said("오늘 날씨 어때?")))).toEqual({
      move: null,
      verdict: "off",
      asked: [],
    });
    const noJev = createFirstMove({ moves: ["weather"], ask: null });
    expect((await noJev(turn(said("오늘 날씨 어때?")))).verdict).toBe("off");
    expect(model.asked).toEqual([]);
  });

  test("only the person's one plain message: not a skill's instruction, not a file", async () => {
    const model = jev(SURE);
    const decide = createFirstMove({ moves: ["weather"], ask: model.ask });
    const shapes = [
      // A skill invoked from the composer puts its instruction before the person's words.
      [
        { role: "system", content: "아침브리핑 스킬…" },
        { role: "user", content: "오늘 날씨 어때?" },
      ],
      // A photo with a caption is content in parts.
      said([{ type: "text", text: "오늘 날씨 어때?" }]),
      said("오늘 날씨 어때?", "system"),
      [],
    ];
    for (const asked of shapes) {
      expect((await decide(turn(asked))).verdict).toBe("not_one_message");
    }
    expect(model.asked).toEqual([]);
  });

  test("a long message is not a lookup, and is not sent", async () => {
    const model = jev(SURE);
    const decide = createFirstMove({ moves: ["weather"], ask: model.ask });
    const long = `오늘 날씨 보고 ${"손님들께 보낼 안내 문구를 길게 ".repeat(6)}써 줘`;
    expect(long.length).toBeGreaterThan(FIRST_MOVE_MAX_CHARS);
    expect((await decide(turn(said(long)))).verdict).toBe("too_long");
    expect((await decide(turn(said("   ")))).verdict).toBe("too_long");
    expect(model.asked).toEqual([]);
  });

  test("a message with no word of a kind that is on never leaves the machine", async () => {
    const model = jev(SURE);
    const decide = createFirstMove({ moves: ["weather"], ask: model.ask });
    for (const text of [
      "안녕",
      "메일 온 거 있어?",
      "오늘 일정 알려줘",
      "카드번호 4111 1111 1111 1111 로 결제해줘",
    ]) {
      expect((await decide(turn(said(text)))).verdict).toBe("no_word");
    }
    expect(model.asked).toEqual([]);
    // Wide on purpose: the forecast is asked for without the word 날씨 more often than with it.
    for (const text of [
      "오늘 날씨 어때?",
      "우산 챙겨야 해?",
      "내일 비 와?",
      "비와?",
      "지금 몇 도야",
      "반팔 입어도 돼?",
      "밖에 추워?",
      "weather today?",
    ]) {
      expect(mentionsWeather(text)).toBe(true);
    }
  });

  test("no tool to call, no place to answer for, or a spent day: nobody is asked", async () => {
    const model = jev(SURE);
    const decide = createFirstMove({ moves: ["weather"], ask: model.ask });
    expect(
      (
        await decide(
          turn(said("오늘 날씨 어때?"), {
            toolNames: new Set(["computer_navigate"]),
          }),
        )
      ).verdict,
    ).toBe("no_tool");
    // The Bot asks where, as it does today; a call with no place would only be refused.
    expect(
      (await decide(turn(said("오늘 날씨 어때?"), { hasPlace: false })))
        .verdict,
    ).toBe("no_place");
    const spent = createFirstMove({
      moves: ["weather"],
      ask: model.ask,
      budgetSpent: async () => true,
    });
    expect((await spent(turn(said("오늘 날씨 어때?")))).verdict).toBe(
      "budget_spent",
    );
    expect(model.asked).toEqual([]);
  });
});

describe("the first move: what the decisions model is shown", () => {
  test("the message, redacted and bounded, and nothing else", async () => {
    const model = jev(SURE);
    const decide = createFirstMove({ moves: ["weather"], ask: model.ask });
    const secret = "sk-live-9f8e7d6c5b4a3f2e1d";
    const number = "010-2345-6789";
    await decide(turn(said(`날씨 어때? ${secret} ${number}`)));
    expect(model.asked).toHaveLength(1);
    const sent = JSON.stringify(model.asked[0]);
    expect(sent).not.toContain(secret);
    expect(sent).not.toContain(number);
    expect(model.asked[0]?.state).toEqual({
      message: "날씨 어때? [secret] [phone]",
    });
    // The two questions, and a bound short enough that waiting on it is not the saving spent.
    expect(model.asked[0]?.questions).toEqual(WEATHER_QUESTIONS);
    expect(Object.keys(WEATHER_QUESTIONS)).toEqual(["forecast", "ownPlace"]);
    expect(model.asked[0]?.timeoutMs).toBe(FIRST_MOVE_TIMEOUT_MS);
    expect(FIRST_MOVE_TIMEOUT_MS).toBeLessThanOrEqual(1_500);
    // The state is cut even if a caller hands it something longer than a turn would.
    expect(firstMoveStateOf("날씨 ".repeat(200)).message.length).toBe(
      FIRST_MOVE_MAX_CHARS * 2,
    );
  });
});

describe("the first move: when it moves", () => {
  test("a clear yes to both is the weather tool with no argument — nothing the model said is one", async () => {
    const model = jev(SURE);
    const decide = createFirstMove({ moves: ["weather"], ask: model.ask });
    expect(await decide(turn(said("  오늘 날씨 어때?  ")))).toEqual({
      verdict: "moved",
      move: {
        kind: "weather",
        tool: WEATHER_TOOL_NAME,
        args: {},
        asked: ["weather"],
        decided: SURE,
      },
      asked: ["weather"],
    });
  });

  test("exactly the bar is a yes; a hair under either is not", async () => {
    const at = createFirstMove({
      moves: ["weather"],
      ask: jev({ ...WEATHER_BARS }).ask,
    });
    expect((await at(turn(said("비 와?")))).verdict).toBe("moved");
    for (const answers of [
      { forecast: WEATHER_BARS.forecast - 0.01, ownPlace: 0.99 },
      // Sure it is the forecast, not sure it is the person's own place: left to the Bot's model.
      { forecast: 0.99, ownPlace: WEATHER_BARS.ownPlace - 0.01 },
    ]) {
      const under = createFirstMove({
        moves: ["weather"],
        ask: jev(answers).ask,
      });
      expect(await under(turn(said("부산 날씨 어때?")))).toEqual({
        move: null,
        verdict: "below_bar",
        asked: ["weather"],
        decided: answers,
      });
    }
  });

  test("no answer, a slow answer or a thrown one is no move", async () => {
    for (const kind of ["down", "throws"] as const) {
      const decide = createFirstMove({
        moves: ["weather"],
        ask: jev(kind).ask,
      });
      expect(await decide(turn(said("오늘 날씨 어때?")))).toEqual({
        move: null,
        verdict: "no_answer",
        asked: ["weather"],
      });
    }
    // An answer that is not a probability is not above any bar.
    const odd = createFirstMove({
      moves: ["weather"],
      ask: async () =>
        ({
          ok: true,
          model: "m",
          ms: 1,
          answers: { forecast: { noul: Number.NaN }, ownPlace: {} },
        }) as unknown as Decision,
    });
    expect((await odd(turn(said("오늘 날씨 어때?")))).verdict).toBe(
      "below_bar",
    );
  });
});

describe("the first move: the calendar's and the mail's", () => {
  test("the two tools are the catalogue's own, read-only, unguarded, and take the constants as arguments", async () => {
    expect(CALENDAR_TOOL_NAME).toBe(
      toolNameFor(`${CALENDAR_SERVER}/list_events`),
    );
    expect(MAIL_TOOL_NAME).toBe(toolNameFor(`${MAIL_SERVER}/search_messages`));
    const listed = {
      [CALENDAR_SERVER]: await calendarTools({ url: "" }),
      [MAIL_SERVER]: await gmailTools({ url: "" }),
    };
    for (const [server, tool, kind] of [
      [CALENDAR_SERVER, "list_events", "calendar"],
      [MAIL_SERVER, "search_messages", "mail"],
    ] as const) {
      const entry = catalogueEntry(server);
      expect(entry).not.toBeNull();
      // A move can only add a read: never a tool the catalogue calls a write or stops for a person.
      expect(classifyTool(entry, tool, true)).toBe("read");
      expect(entry?.writeTools ?? []).not.toContain(tool);
      expect(Object.keys(entry?.guardedTools ?? {})).not.toContain(tool);
      const schema = listed[server].find((one) => one.name === tool)
        ?.inputSchema as { properties?: Record<string, unknown> } | undefined;
      // Every argument of the move is one the tool takes; a renamed field fails here.
      for (const name of Object.keys(FIRST_MOVE_SPECS[kind].args)) {
        expect(Object.keys(schema?.properties ?? {})).toContain(name);
      }
    }
    // The mail's goes where one-time codes are withheld, because it is a mail-reading tool there.
    expect(catalogueEntry(MAIL_SERVER)?.mailReadingTools).toContain(
      "search_messages",
    );
    expect(FIRST_MOVE_SPECS.calendar.args).toEqual({ days: 1 });
    expect(FIRST_MOVE_SPECS.mail.args).toEqual({ query: "is:unread in:inbox" });
    // No question's name is shared: they ride in one request, where a shared name would be one answer.
    const names = FIRST_MOVES.flatMap((kind) =>
      Object.keys(FIRST_MOVE_SPECS[kind].questions),
    );
    expect(new Set(names).size).toBe(names.length);
    for (const kind of FIRST_MOVES) {
      expect(Object.keys(FIRST_MOVE_SPECS[kind].bars).sort()).toEqual(
        Object.keys(FIRST_MOVE_SPECS[kind].questions).sort(),
      );
    }
  });

  test("one request a message: only the kinds whose words it has, each with its own questions", async () => {
    const model = jev(SURE_OF_ALL);
    const decide = createFirstMove({ moves: ALL, ask: model.ask });
    await decide(turn(said("오늘 일정 뭐 있어?")));
    await decide(turn(said("안 읽은 메일 있어?")));
    await decide(turn(said("오늘 일정이랑 새 메일 알려줘")));
    await decide(turn(said("오늘 회의 있는데 비 와? 메일도 봐줘")));
    expect(model.asked.map((asked) => Object.keys(asked.questions))).toEqual([
      ["schedule", "today"],
      ["mail", "unfiltered"],
      ["schedule", "today", "mail", "unfiltered"],
      ["forecast", "ownPlace", "schedule", "today", "mail", "unfiltered"],
    ]);
    expect(kindsMentioned("오늘 일정이랑 새 메일 알려줘")).toEqual([
      "calendar",
      "mail",
    ]);
    // A kind this deployment took out is not asked about, whatever the message says.
    expect(kindsMentioned("새 메일 왔어?", ["weather", "calendar"])).toEqual(
      [],
    );
    const withoutMail = createFirstMove({
      moves: ["weather", "calendar"],
      ask: model.ask,
    });
    expect((await withoutMail(turn(said("새 메일 왔어?")))).verdict).toBe(
      "no_word",
    );
    expect(model.asked).toHaveLength(4);
    expect(questionsFor(["calendar"])).toEqual(
      FIRST_MOVE_SPECS.calendar.questions,
    );
  });

  test("a clear yes is today's calendar or the unread inbox — a constant, whatever the decisions model said", async () => {
    // An answer that carries words: none of them may reach the call.
    const talkative = async (): Promise<Decision> =>
      ({
        ok: true,
        model: "m",
        ms: 1,
        answers: {
          schedule: { noul: 0.99, days: 30, query: "from:boss@corp.kr" },
          today: { noul: 0.99, choice: "tomorrow" },
          mail: { noul: 0.99, query: "from:boss@corp.kr", max: 50 },
          unfiltered: { noul: 0.99 },
          query: "from:boss@corp.kr",
          days: 30,
        },
      }) as unknown as Decision;
    const decide = createFirstMove({ moves: ALL, ask: talkative });
    const calendar = await decide(turn(said("오늘 일정 뭐 있어?")));
    expect(calendar.move).toEqual({
      kind: "calendar",
      tool: CALENDAR_TOOL_NAME,
      args: { days: 1 },
      asked: ["calendar"],
      decided: { schedule: 0.99, today: 0.99 },
    });
    const mail = await decide(turn(said("김 부장님 메일 왔어?")));
    expect(mail.move).toEqual({
      kind: "mail",
      tool: MAIL_TOOL_NAME,
      args: { query: "is:unread in:inbox" },
      asked: ["mail"],
      decided: { mail: 0.99, unfiltered: 0.99 },
    });
    // No word of the message is in the call either.
    expect(JSON.stringify(mail.move?.args)).not.toContain("부장");
    // The arguments handed out are a copy: a caller that changed them would not change the next move's.
    (calendar.move?.args as Record<string, unknown>).days = 7;
    expect((await decide(turn(said("오늘 일정 뭐 있어?")))).move?.args).toEqual(
      {
        days: 1,
      },
    );
  });

  test("a hair under either bar is no move: tomorrow's schedule, a sender's mail", async () => {
    const bars = {
      ...FIRST_MOVE_SPECS.calendar.bars,
      ...FIRST_MOVE_SPECS.mail.bars,
    };
    const at = createFirstMove({ moves: ALL, ask: jev(bars).ask });
    expect((await at(turn(said("오늘 일정 뭐 있어?")))).verdict).toBe("moved");
    expect((await at(turn(said("새 메일 왔어?")))).verdict).toBe("moved");
    for (const [text, name] of [
      ["내일 일정 뭐 있어?", "today"],
      ["일정 잡아줘", "schedule"],
      ["세무사님 메일 왔어?", "unfiltered"],
      ["메일 보내줘", "mail"],
    ] as const) {
      const answers = { ...SURE_OF_ALL, [name]: (bars[name] ?? 1) - 0.01 };
      const under = createFirstMove({ moves: ALL, ask: jev(answers).ask });
      const settled = await under(turn(said(text)));
      expect([text, settled.verdict, settled.move]).toEqual([
        text,
        "below_bar",
        null,
      ]);
    }
  });

  test("without the connection, or without the Bot holding the tool, nobody is asked", async () => {
    const model = jev(SURE_OF_ALL);
    const decide = createFirstMove({ moves: ALL, ask: model.ask });
    // Nothing connected: the Bot offers to connect, as it does today.
    for (const text of ["오늘 일정 뭐 있어?", "새 메일 왔어?"]) {
      expect((await decide(turn(said(text), { connected: [] }))).verdict).toBe(
        "no_connection",
      );
    }
    // Connected, and this Bot was never given the tool: the grant is the Bot's, not the person's.
    for (const text of ["오늘 일정 뭐 있어?", "새 메일 왔어?"]) {
      expect(
        (
          await decide(
            turn(said(text), {
              toolNames: new Set([WEATHER_TOOL_NAME, "computer_navigate"]),
            }),
          )
        ).verdict,
      ).toBe("no_tool");
    }
    expect(model.asked).toEqual([]);
    // One of two kinds can be answered: that one alone is asked about, and alone can move.
    const half = await decide(
      turn(said("오늘 일정이랑 새 메일 알려줘"), {
        connected: [CALENDAR_SERVER],
      }),
    );
    expect(Object.keys(model.asked[0]?.questions ?? {})).toEqual([
      "schedule",
      "today",
    ]);
    expect([half.verdict, half.move?.kind, half.asked]).toEqual([
      "moved",
      "calendar",
      ["calendar"],
    ]);
    // A connection lookup that fails is no connection, not a move.
    const broken = await decide({
      ...turn(said("새 메일 왔어?")),
      hasConnection: async () => {
        throw new Error("database gone");
      },
    });
    expect(broken.verdict).toBe("no_connection");
  });

  test("two kinds clear their bars: the message asked for two things, and no move is made", async () => {
    const model = jev(SURE_OF_ALL);
    const decide = createFirstMove({ moves: ALL, ask: model.ask });
    expect(await decide(turn(said("오늘 일정이랑 새 메일 알려줘")))).toEqual({
      move: null,
      verdict: "ambiguous",
      asked: ["calendar", "mail"],
      decided: { schedule: 0.96, today: 0.94, mail: 0.97, unfiltered: 0.93 },
    });
    expect(model.asked).toHaveLength(1);
    // Only one of the two is sure: that one moves.
    const one = createFirstMove({
      moves: ALL,
      ask: jev({ ...SURE_OF_ALL, unfiltered: 0.1 }).ask,
    });
    expect(
      (await one(turn(said("오늘 일정 보고 김 대리 메일도 찾아줘")))).move
        ?.kind,
    ).toBe("calendar");
    expect(
      settleDecision(["weather", "calendar", "mail"], {
        forecast: { noul: 0.9 },
        ownPlace: { noul: 0.9 },
        schedule: { noul: 0.9 },
        today: { noul: 0.1 },
        mail: { noul: "yes" },
      }).cleared,
    ).toEqual(["weather"]);
  });
});

describe("the first move, as a turn asks for it", () => {
  const rows: AuditEventInput[] = [];
  const auditStore = {
    insert: async (event: AuditEventInput) => {
      rows.push(event);
    },
  };
  const forTurns = (
    whereabouts: {
      place: string | null;
      coordinates: { latitude: number; longitude: number } | null;
    },
    answers: Parameters<typeof jev>[0] = SURE,
    connections: readonly {
      serverId: string;
      health: { status: string };
    }[] = [
      { serverId: CALENDAR_SERVER, health: { status: "ok" } },
      { serverId: MAIL_SERVER, health: { status: "ok" } },
    ],
  ) => {
    const model = jev(answers);
    const read: string[] = [];
    const looked: string[] = [];
    return {
      model,
      read,
      looked,
      firstMove: firstMoveForTurns({
        decide: createFirstMove({ moves: ALL, ask: model.ask }),
        whereaboutsOf: async (userId) => {
          read.push(userId);
          return whereabouts;
        },
        connectionsOf: async (userId) => {
          looked.push(userId);
          return connections;
        },
        auditStore,
      }),
    };
  };
  const HOME = { place: "강원 춘천시", coordinates: null };
  const input = (text: string, tools = [...withTool]) => ({
    owner: { id: "person-1" },
    botId: "bot-1",
    asked: said(text),
    tools: tools.map((name) => ({ name })),
  });

  test("a saved place in words or from the device is a place; neither is none", async () => {
    const words = forTurns({ place: "강원 춘천시", coordinates: null });
    expect((await words.firstMove(input("오늘 날씨 어때?")))?.tool).toBe(
      WEATHER_TOOL_NAME,
    );
    expect(words.read).toEqual(["person-1"]);

    const device = forTurns({
      place: null,
      coordinates: { latitude: 37.88, longitude: 127.73 },
    });
    expect(await device.firstMove(input("오늘 날씨 어때?"))).not.toBeNull();

    const nowhere = forTurns({ place: "  ", coordinates: null });
    expect(await nowhere.firstMove(input("오늘 날씨 어때?"))).toBeNull();
    expect(nowhere.model.asked).toEqual([]);
  });

  test("a decision that left the step to the Bot leaves a row too — why, how sure, never the message; a message never asked about leaves none", async () => {
    rows.length = 0;
    const unsure = forTurns(
      { place: "강원 춘천시", coordinates: null },
      { forecast: 0.4, ownPlace: 0.9 },
    );
    const text = "우산 챙길까 말까 고민이네";
    expect(await unsure.firstMove(input(text))).toBeNull();
    const silent = forTurns(
      { place: "강원 춘천시", coordinates: null },
      "down",
    );
    expect(await silent.firstMove(input(text))).toBeNull();
    // No key to ask with: nothing was sent, so it is not a decision asked for either.
    const keyless = firstMoveForTurns({
      decide: createFirstMove({
        moves: ["weather"],
        ask: async () => ({ ok: false, because: "no credential", ms: 0 }),
      }),
      whereaboutsOf: async () => ({ place: "강원 춘천시", coordinates: null }),
      connectionsOf: async () => [],
      auditStore,
    });
    expect(await keyless(input(text))).toBeNull();
    // No weather word: nobody was asked, so there is nothing to count.
    const unasked = forTurns({ place: "강원 춘천시", coordinates: null });
    expect(await unasked.firstMove(input("안녕, 잘 지냈어?"))).toBeNull();
    expect(unasked.model.asked).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rows).toEqual([
      {
        eventType: "turn.first_move_left",
        targetType: "agent",
        targetId: "bot-1",
        actorUserId: "person-1",
        payload: {
          bot: "bot-1",
          asked: ["weather"],
          verdict: "below_bar",
          decided: { forecast: 0.4, ownPlace: 0.9 },
        },
      },
      {
        eventType: "turn.first_move_left",
        targetType: "agent",
        targetId: "bot-1",
        actorUserId: "person-1",
        payload: { bot: "bot-1", asked: ["weather"], verdict: "no_answer" },
      },
    ]);
    const serialised = JSON.stringify(rows);
    for (const word of ["우산", "챙길까", "고민", "춘천"]) {
      expect(serialised).not.toContain(word);
    }
  });

  test("a move leaves a row saying who decided — names and probabilities, never the message", async () => {
    rows.length = 0;
    const made = forTurns({ place: "강원 춘천시", coordinates: null });
    const text = "오늘 우리 동네 날씨 어때? 우산 챙길까";
    await made.firstMove(input(text));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rows).toEqual([
      {
        eventType: "turn.first_move",
        targetType: "agent",
        targetId: "bot-1",
        actorUserId: "person-1",
        payload: {
          bot: "bot-1",
          move: "weather",
          tool: WEATHER_TOOL_NAME,
          asked: ["weather"],
          decided: SURE,
        },
      },
    ]);
    const serialised = JSON.stringify(rows);
    for (const word of ["우리 동네", "우산", "챙길까", "춘천"]) {
      expect(serialised).not.toContain(word);
    }
  });

  test("a connection that stopped working is no connection; a weather question never reads them", async () => {
    rows.length = 0;
    const stale = forTurns(HOME, SURE_OF_ALL, [
      { serverId: CALENDAR_SERVER, health: { status: "needs_reconnect" } },
    ]);
    expect(await stale.firstMove(input("오늘 일정 뭐 있어?"))).toBeNull();
    expect(await stale.firstMove(input("새 메일 왔어?"))).toBeNull();
    expect(stale.model.asked).toEqual([]);
    const both = forTurns(HOME, SURE_OF_ALL);
    await both.firstMove(input("오늘 일정이랑 새 메일 알려줘"));
    // Two kinds, one reading of the person's connections.
    expect(both.looked).toEqual(["person-1"]);
    const weather = forTurns(HOME);
    await weather.firstMove(input("오늘 날씨 어때?"));
    expect(weather.looked).toEqual([]);
    // Connected, but this Bot holds neither tool: not asked, and nothing read.
    const ungranted = forTurns(HOME, SURE_OF_ALL);
    expect(
      await ungranted.firstMove(
        input("오늘 일정 뭐 있어?", [WEATHER_TOOL_NAME]),
      ),
    ).toBeNull();
    expect([ungranted.model.asked, ungranted.looked]).toEqual([[], []]);
  });

  test("the calendar's and the mail's rows say which kinds were asked about, and never the message", async () => {
    rows.length = 0;
    const text = "오늘 치과 예약이랑 세무사 메일 확인";
    const made = forTurns(HOME, { ...SURE_OF_ALL, unfiltered: 0.2 });
    expect((await made.firstMove(input(text)))?.args).toEqual({ days: 1 });
    const two = forTurns(HOME, SURE_OF_ALL);
    expect(await two.firstMove(input(text))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rows.map((row) => [row.eventType, row.payload])).toEqual([
      [
        "turn.first_move",
        {
          bot: "bot-1",
          move: "calendar",
          tool: CALENDAR_TOOL_NAME,
          asked: ["calendar", "mail"],
          decided: { schedule: 0.96, today: 0.94, mail: 0.97, unfiltered: 0.2 },
        },
      ],
      [
        "turn.first_move_left",
        {
          bot: "bot-1",
          asked: ["calendar", "mail"],
          verdict: "ambiguous",
          decided: {
            schedule: 0.96,
            today: 0.94,
            mail: 0.97,
            unfiltered: 0.93,
          },
        },
      ],
    ]);
    const serialised = JSON.stringify(rows);
    for (const word of ["치과", "예약", "세무사", "확인", "춘천"]) {
      expect(serialised).not.toContain(word);
    }
  });

  test("no log line holds a word of the message, whatever came of it", async () => {
    const lines: string[] = [];
    const keep = (line: unknown) => {
      lines.push(String(line));
    };
    const spies = [
      spyOn(console, "log").mockImplementation(keep),
      spyOn(console, "info").mockImplementation(keep),
      spyOn(console, "warn").mockImplementation(keep),
    ];
    const text = "오늘 치과 예약이랑 세무사 메일 확인";
    await forTurns(HOME, SURE_OF_ALL).firstMove(input(text));
    await forTurns(HOME, { ...SURE_OF_ALL, mail: 0 }).firstMove(input(text));
    await forTurns(HOME, "down").firstMove(input(text));
    await forTurns(HOME, SURE_OF_ALL, []).firstMove(input(text));
    for (const spy of spies) spy.mockRestore();
    const logged = lines.filter((line) => line.includes("first_move"));
    expect(logged.length).toBeGreaterThanOrEqual(4);
    for (const word of ["치과", "예약", "세무사", "확인"]) {
      expect(logged.join("\n")).not.toContain(word);
    }
  });
});

describe("the first move, said at boot", () => {
  const lines: Record<string, unknown>[] = [];
  const keep = (line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // Not one of the log's own lines.
    }
  };
  const spies = () => [
    spyOn(console, "log").mockImplementation(keep),
    spyOn(console, "info").mockImplementation(keep),
    spyOn(console, "warn").mockImplementation(keep),
  ];
  let watching: ReturnType<typeof spies> = [];
  afterEach(() => {
    for (const spy of watching) spy.mockRestore();
    watching = [];
    lines.length = 0;
  });
  const said = () =>
    lines.filter((line) => String(line.event).startsWith("first_move"));

  test("off says nothing; on and able says which move", () => {
    watching = spies();
    sayFirstMove({ moves: [], canDecide: true, weather: true, named: false });
    expect(said()).toEqual([]);
    sayFirstMove({
      moves: ["weather"],
      canDecide: true,
      weather: true,
      named: false,
    });
    expect(said().map((line) => [line.event, line.level, line.moves])).toEqual([
      ["first_move_on", "info", ["weather"]],
    ]);
  });

  test("on where it can do nothing is a warning that says so, and says which half is missing", () => {
    // A switch that is set and makes no move would leave an operator believing it does.
    watching = spies();
    sayFirstMove({
      moves: ["weather"],
      canDecide: false,
      weather: true,
      named: true,
    });
    sayFirstMove({
      moves: ["weather"],
      canDecide: true,
      weather: false,
      named: true,
    });
    expect(
      said().map((line) => [
        line.event,
        line.level,
        line.canDecide,
        line.weather,
      ]),
    ).toEqual([
      ["first_move_does_nothing", "warn", false, true],
      ["first_move_does_nothing", "warn", true, false],
    ]);
  });

  test("the default on where it can do nothing is said once and is not a warning", () => {
    // Nobody set anything: a deployment with no weather key must not warn at every boot.
    watching = spies();
    sayFirstMove({
      moves: ["weather"],
      canDecide: true,
      weather: false,
      named: false,
    });
    sayFirstMove({
      moves: ["weather"],
      canDecide: false,
      weather: true,
      named: false,
    });
    expect(
      said().map((line) => [
        line.event,
        line.level,
        line.canDecide,
        line.weather,
      ]),
    ).toEqual([
      ["first_move_idle", "info", true, false],
      ["first_move_idle", "info", false, true],
    ]);
  });

  test("the calendar's and the mail's are a person's to be able to make, and a boot says only that", () => {
    watching = spies();
    sayFirstMove({ moves: ALL, canDecide: true, weather: true, named: false });
    // No weather key, nobody set anything: the other two are still on, and the weather's is named unable.
    sayFirstMove({ moves: ALL, canDecide: true, weather: false, named: false });
    // Named, and one of the named cannot be made here: a warning, as for the weather alone.
    sayFirstMove({
      moves: ["weather", "calendar"],
      canDecide: true,
      weather: false,
      named: true,
    });
    // Named without the weather: no key is needed, so nothing is wrong.
    sayFirstMove({
      moves: ["calendar", "mail"],
      canDecide: true,
      weather: false,
      named: true,
    });
    sayFirstMove({ moves: ALL, canDecide: false, weather: true, named: false });
    expect(
      said().map((line) => [
        line.event,
        line.level,
        line.moves,
        line.perPerson,
        line.unable ?? null,
      ]),
    ).toEqual([
      ["first_move_on", "info", [...ALL], ["calendar", "mail"], null],
      [
        "first_move_on",
        "info",
        ["calendar", "mail"],
        ["calendar", "mail"],
        ["weather"],
      ],
      [
        "first_move_does_nothing",
        "warn",
        ["calendar"],
        ["calendar"],
        ["weather"],
      ],
      [
        "first_move_on",
        "info",
        ["calendar", "mail"],
        ["calendar", "mail"],
        null,
      ],
      ["first_move_idle", "info", [], [], [...ALL]],
    ]);
  });

  test("a boot warms the road for every kind that is on, with or without the weather's", async () => {
    watching = spies();
    const every = jev(SURE_OF_ALL);
    await warmFirstMove({ moves: ALL, ask: every.ask });
    expect(Object.keys(every.asked[0]?.questions ?? {})).toEqual([
      "forecast",
      "ownPlace",
      "schedule",
      "today",
      "mail",
      "unfiltered",
    ]);
    const some = jev(SURE_OF_ALL);
    await warmFirstMove({ moves: ["mail"], ask: some.ask });
    expect(some.asked).toHaveLength(1);
    expect(Object.keys(some.asked[0]?.questions ?? {})).toEqual([
      "mail",
      "unfiltered",
    ]);
    // Still the file's own sentence: nothing of a person's leaves at boot.
    expect(some.asked[0]?.state).toEqual(firstMoveStateOf("오늘 날씨 어때?"));
  });

  test("a boot asks once, of a sentence nobody sent, and says how long it took", async () => {
    watching = spies();
    const model = jev(SURE);
    await warmFirstMove({ moves: ["weather"], ask: model.ask });
    expect(model.asked).toHaveLength(1);
    expect(model.asked[0]?.state).toEqual(firstMoveStateOf("오늘 날씨 어때?"));
    expect(model.asked[0]?.questions).toEqual(WEATHER_QUESTIONS);
    // Longer than a person's bound: a boot's first decision is the slow one, and nobody waits on it.
    expect(model.asked[0]?.timeoutMs).toBe(FIRST_MOVE_WARM_UP_TIMEOUT_MS);
    expect(FIRST_MOVE_WARM_UP_TIMEOUT_MS).toBeGreaterThan(
      FIRST_MOVE_TIMEOUT_MS,
    );
    expect(said().map((line) => [line.event, line.answered])).toEqual([
      ["first_move_warmed", true],
    ]);
  });

  test("a boot asks nothing with the move off, with nobody to ask, or on a spent day, and a failure is only said", async () => {
    watching = spies();
    const off = jev(SURE);
    await warmFirstMove({ moves: [], ask: off.ask });
    await warmFirstMove({ moves: ["weather"], ask: null });
    const spent = jev(SURE);
    await warmFirstMove({
      moves: ["weather"],
      ask: spent.ask,
      budgetSpent: async () => true,
    });
    expect([off.asked, spent.asked]).toEqual([[], []]);
    expect(said()).toEqual([]);

    const broken = jev("throws");
    await warmFirstMove({ moves: ["weather"], ask: broken.ask });
    expect(said().map((line) => [line.event, line.answered])).toEqual([
      ["first_move_warmed", false],
    ]);
  });
});
