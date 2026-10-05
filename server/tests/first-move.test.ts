import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WEATHER_TOOL_NAME } from "../../shared/tools/bridge";
import type { AuditEventInput } from "../src/audit";
import { sayFirstMove } from "../src/boot/announce";
import type { Decision } from "../src/computer/decision-call";
import {
  createFirstMove,
  FIRST_MOVE_BARS,
  FIRST_MOVE_MAX_CHARS,
  FIRST_MOVE_QUESTIONS,
  FIRST_MOVE_TIMEOUT_MS,
  FIRST_MOVE_WARM_UP_TIMEOUT_MS,
  firstMoveForTurns,
  firstMoveStateOf,
  mentionsWeather,
  warmFirstMove,
} from "../src/turns/first-move";

/**
 * A turn's first step, decided before the Bot's model is asked (`turns/first-move.ts`).
 *
 * What these hold it to is mostly what it must NOT do: ask anybody about a message it has no
 * business sending, move on anything short of a clear yes, or let a word of the decisions model's
 * answer become an argument. That it moves when it should is the eval's to measure, on messages
 * somebody else labelled (`evals/first-move.ts`).
 */

type Asked = {
  state: object;
  questions: Record<string, unknown>;
  timeoutMs: number;
};

/** A decisions model that answers what it is told to, and records what it was shown. */
function jev(
  answers: { forecast: number; ownPlace: number } | "down" | "throws",
) {
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
      answers: {
        forecast: { type: "noul", noul: answers.forecast },
        ownPlace: { type: "noul", noul: answers.ownPlace },
      },
    };
  };
  return { ask, asked };
}

const SURE = { forecast: 0.95, ownPlace: 0.92 };
const said = (content: unknown, role = "user") => [{ role, content }];
const withTool = new Set([WEATHER_TOOL_NAME, "computer_navigate"]);

const turn = (
  asked: readonly { role: string; content?: unknown }[],
  over: { toolNames?: ReadonlySet<string>; hasPlace?: boolean } = {},
) => ({
  asked,
  toolNames: over.toolNames ?? withTool,
  hasPlace: async () => over.hasPlace ?? true,
});

describe("the first move: when nobody is asked", () => {
  test("off is off: no move named, or no decisions model to ask", async () => {
    const model = jev(SURE);
    const noMoves = createFirstMove({ moves: [], ask: model.ask });
    expect(await noMoves(turn(said("오늘 날씨 어때?")))).toEqual({
      move: null,
      verdict: "off",
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

  test("a message with no weather word in it never leaves the machine", async () => {
    const model = jev(SURE);
    const decide = createFirstMove({ moves: ["weather"], ask: model.ask });
    for (const text of [
      "안녕",
      "메일 온 거 있어?",
      "오늘 일정 알려줘",
      "카드번호 4111 1111 1111 1111 로 결제해줘",
    ]) {
      expect((await decide(turn(said(text)))).verdict).toBe("no_weather_word");
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
    expect(model.asked[0]?.questions).toBe(FIRST_MOVE_QUESTIONS);
    expect(Object.keys(FIRST_MOVE_QUESTIONS)).toEqual(["forecast", "ownPlace"]);
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
        decided: SURE,
      },
    });
  });

  test("exactly the bar is a yes; a hair under either is not", async () => {
    const at = createFirstMove({
      moves: ["weather"],
      ask: jev({ ...FIRST_MOVE_BARS }).ask,
    });
    expect((await at(turn(said("비 와?")))).verdict).toBe("moved");
    for (const answers of [
      { forecast: FIRST_MOVE_BARS.forecast - 0.01, ownPlace: 0.99 },
      // Sure it is the forecast, not sure it is the person's own place: left to the Bot's model.
      { forecast: 0.99, ownPlace: FIRST_MOVE_BARS.ownPlace - 0.01 },
    ]) {
      const under = createFirstMove({
        moves: ["weather"],
        ask: jev(answers).ask,
      });
      expect(await under(turn(said("부산 날씨 어때?")))).toEqual({
        move: null,
        verdict: "below_bar",
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
  ) => {
    const model = jev(answers);
    const read: string[] = [];
    return {
      model,
      read,
      firstMove: firstMoveForTurns({
        decide: createFirstMove({ moves: ["weather"], ask: model.ask }),
        whereaboutsOf: async (userId) => {
          read.push(userId);
          return whereabouts;
        },
        auditStore,
      }),
    };
  };
  const input = (text: string) => ({
    owner: { id: "person-1" },
    botId: "bot-1",
    asked: said(text),
    tools: [{ name: WEATHER_TOOL_NAME }, { name: "computer_navigate" }],
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
          move: "weather",
          verdict: "below_bar",
          decided: { forecast: 0.4, ownPlace: 0.9 },
        },
      },
      {
        eventType: "turn.first_move_left",
        targetType: "agent",
        targetId: "bot-1",
        actorUserId: "person-1",
        payload: { bot: "bot-1", move: "weather", verdict: "no_answer" },
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
          decided: SURE,
        },
      },
    ]);
    const serialised = JSON.stringify(rows);
    for (const word of ["우리 동네", "우산", "챙길까", "춘천"]) {
      expect(serialised).not.toContain(word);
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

  test("a boot asks once, of a sentence nobody sent, and says how long it took", async () => {
    watching = spies();
    const model = jev(SURE);
    await warmFirstMove({ moves: ["weather"], ask: model.ask });
    expect(model.asked).toHaveLength(1);
    expect(model.asked[0]?.state).toEqual(firstMoveStateOf("오늘 날씨 어때?"));
    expect(model.asked[0]?.questions).toBe(FIRST_MOVE_QUESTIONS);
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
