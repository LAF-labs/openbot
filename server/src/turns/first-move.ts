/**
 * A turn's first step, taken before the Bot's model is asked.
 *
 * WHY. Asked "오늘 날씨 어때?", a Bot's model is asked twice: once to decide to call the weather
 * tool, once to write the answer from what came back. Measured on the local stack (2026-10-02,
 * muse-spark, `docs/laf/eval-pack.md` "The weather"): the first of those took 5.1 s and 8.9 s to
 * its first chunk — the second time with 99% of its prompt read from cache, so it is the model
 * reasoning and the endpoint's queue, not the prompt — while 기상청 itself took 1.2 s and the round
 * that writes the answer two. The first round decides something a much smaller question can decide.
 *
 * So, with the switch on (`FIRST_MOVE`, off unless it names a move): a decisions model — TypeSafe's
 * Jev, 0.24 s warm — is asked two yes-or-no questions about the person's message, and when both are
 * a clear yes the server makes the call itself, files it in the thread exactly as a call the Bot
 * made, and the Bot's model starts with the result in hand. One round instead of two.
 *
 * ONE MOVE, AND THE NARROWEST ONE: the weather for the person's own place. The call takes no
 * argument, so nothing the decisions model says becomes an argument — a place is the saved one or
 * the move is not made. A message that names another place is left to the Bot's model, which reads
 * a place out of a sentence well and a deterministic rule badly ("우산" is 광주 북구 우산동).
 *
 * WHAT LEAVES THE MACHINE, AND WHEN. Nothing unless the switch is on and Jev may be asked at all
 * (`JEV_ENABLED`, an OpenRouter endpoint). Then only a message that is short, is the person's one
 * message of the turn, and has a weather word in it — the words below, checked here first — and
 * that message goes redacted (`context/judge-redaction.ts`). The owner's yes to this is recorded
 * with the plan (`~/laf/docs/jev-adoption-review-2026-10-02.md` §3, §6); turning it on for a
 * customer is a separate step, because who is sent what is in the privacy policy.
 *
 * IT CAN ONLY ADD A READ. The one call it makes is read-only and goes through the turn's own
 * executor — the Bot's grant, the boundary, the audit row, as for any call. Anything short of a
 * clear yes, a slow answer or no answer makes no move, and the turn is exactly the turn it was.
 */
import { WEATHER_TOOL_NAME } from "../../../shared/tools/bridge";
import type { Whereabouts } from "../../../shared/whereabouts";
import { type AuditStore, auditRowLost, recordAuditEvent } from "../audit";
import type { Decision, DecisionQuestion } from "../computer/decision-call";
import { redactText } from "../context/judge-redaction";
import { log } from "../log";

/** The moves there are. A closed list: each is a tool, its arguments and the questions that earn it. */
export const FIRST_MOVES = ["weather"] as const;
export type FirstMoveKind = (typeof FIRST_MOVES)[number];

/** A call the server makes for the Bot before its model is asked. */
export type FirstMove = {
  kind: FirstMoveKind;
  tool: string;
  args: Record<string, unknown>;
  /** What the decisions model said, for the trail: probabilities, never words. */
  decided: Record<string, number>;
};

/**
 * Longer than this is not the kind of message a first move is for: a sentence that long is asking
 * for more than a lookup, and it is also more of somebody's words than this needs to send anywhere.
 */
export const FIRST_MOVE_MAX_CHARS = 60;

/**
 * The words that make a message worth asking about.
 *
 * Checked before anything is sent: a message with none of these is never shown to the decisions
 * model, which is both the cheaper answer and the one that keeps "every short message" from being
 * true. Wide on purpose — "우산 챙겨야 해?", "빨래 널어도 돼?" and "내일 뭐 입지" ask for the
 * forecast without the word 날씨 — and wrong often, which is what the second look is for.
 *
 * MEASURED on the labelled set (`evals/first-move-messages.json`, 76 messages that want the
 * forecast for the person's own place): the first list, written from the head, let 51 of them
 * through. This one is that list widened by what it had missed and no further — 비 and 눈 as words
 * of their own, the wind, the humidity, a typo of 날씨. What still does not pass is a plan with no
 * weather word in it at all ("토요일에 공원 피크닉 괜찮을까?"); catching those would mean sending
 * every short message, and the Bot's model answers them as it does today.
 */
const WEATHER_WORDS = new RegExp(
  [
    "날씨|날시|기온|온도|몇\\s*도|습도|일교차|체감|불쾌지수|영하|폭염|한파|강수|소나기|장마|우박|안개",
    // 비 and 눈 as words of their own: 비용, 준비, 눈치 and 눈물 are not the weather.
    "(?:^|[\\s,.?!])비(?:\\s|[가는도야]|와|오|온|올|옴|왔|맞|바람|소식)",
    "(?:^|[\\s,.?!])눈(?:\\s|[이은도]|와|오|온|올|옴|왔|쌓)",
    "비와|비오|눈와|눈오|바람",
    "우산|장화|우비|덥|더워|더울|더운|춥|추워|추울|추운|쌀쌀|따뜻|선선|맑|흐리|흐림|화창",
    "반팔|긴팔|패딩|외투|겉옷|뭐\\s*입|빨래|널어|세차|보일러|에어컨|날이",
    "weather|rain|umbrella|snow|forecast",
  ].join("|"),
  "i",
);

/** Whether a message has any of {@link WEATHER_WORDS}. Exported for the eval, which measures its recall. */
export function mentionsWeather(text: string): boolean {
  return WEATHER_WORDS.test(text);
}

/**
 * How sure the decisions model has to be, per question.
 *
 * MEASURED, NOT CHOSEN: `bun run eval:first-move` over messages labelled by somebody other than the
 * author of these questions (`evals/first-move-messages.json`, `docs/laf/eval-pack.md` "The first
 * move"). The bar is set for precision — a wrong move is a weather lookup nobody asked for, drawn
 * in the conversation as a step — and what it costs in recall is a turn that takes the two rounds
 * it takes today.
 */
export const FIRST_MOVE_BARS = { forecast: 0.7, ownPlace: 0.7 } as const;

/** How long the decision may take. Past it there is no move: the wait would be the saving. */
export const FIRST_MOVE_TIMEOUT_MS = 1_200;

/** The two questions. In English, like every judge's: the model they are measured on reads them best. */
export const FIRST_MOVE_QUESTIONS: Record<
  "forecast" | "ownPlace",
  DecisionQuestion
> = {
  forecast: {
    type: "noul",
    instructions:
      "`message` is one chat message a person sent to their assistant, usually in Korean. This is true when the person wants to know what the weather is now or will be over the coming few days — temperature, rain or snow, the sky, whether to take an umbrella, what to wear for the weather, whether the weather allows something they plan — or asks for something whose first step is to look at that forecast. It is false when weather words appear without the forecast being wanted: talk about weather that has already happened, a request to build, write or analyse something about weather, a temperature that is not the weather's (an oven, a fever, a room, a drink), an order or a product (an umbrella, a heater, a coat), a mood or a figure of speech. It is false for what a forecast of the next few days cannot answer: last year or last month, next month or a season, the climate, fine dust or yellow dust alone, a typhoon's path, tides, sunrise or sunset times.",
  },
  ownPlace: {
    type: "noul",
    instructions:
      "This is true when `message` names no specific place, or refers only to where the person is: here, my neighbourhood, near home, the shop, the office, outside. It is false when `message` names any specific place: a city, a district, a neighbourhood, a landmark, a mountain, a region or a country.",
  },
};

/** Why no move was made, or that one was — closed words, for a counter. */
export type FirstMoveVerdict =
  | "moved"
  | "not_one_message"
  | "too_long"
  | "no_weather_word"
  | "no_tool"
  | "no_place"
  | "budget_spent"
  | "no_answer"
  | "below_bar";

export type FirstMoveInput = {
  /** What the person sent this turn: their messages and any skill instruction put before them. */
  asked: readonly { role: string; content?: unknown }[];
  /** The names of the tools this turn offers the Bot. */
  toolNames: ReadonlySet<string>;
  /** Whether the person has a saved place — coordinates or words. */
  hasPlace: () => Promise<boolean>;
};

export type FirstMoveDeps = {
  /** The moves this deployment has switched on. Empty is off. */
  moves: readonly FirstMoveKind[];
  /** Jev, bounded and unretried. Null where Jev may not be asked: then nothing here ever moves. */
  ask:
    | ((ask: {
        state: object;
        questions: Record<string, DecisionQuestion>;
        timeoutMs: number;
      }) => Promise<Decision>)
    | null;
  /** A free trial's spent day: nothing is judged, as for every other judge. */
  budgetSpent?: () => Promise<boolean>;
};

const noulOf = (answer: unknown): number =>
  answer && typeof answer === "object" && "noul" in answer
    ? Number((answer as { noul: unknown }).noul)
    : 0;

/**
 * The state the decisions model is shown: the message, redacted and bounded, and nothing else.
 * Exported so a test can serialise it and look for what must not be in it.
 */
export function firstMoveStateOf(text: string): { message: string } {
  return { message: redactText(text).slice(0, FIRST_MOVE_MAX_CHARS * 2) };
}

/**
 * Whether this turn opens with a move, and which.
 *
 * The cheap refusals first, in the order that sends the least: the switch, the shape of what was
 * asked, its length, the words in it, whether the Bot holds the tool, whether there is a place to
 * answer for — and only then the question to somebody else.
 */
export function createFirstMove(deps: FirstMoveDeps) {
  const on = deps.moves.includes("weather") && deps.ask !== null;

  return async function firstMoveFor(
    input: FirstMoveInput,
  ): Promise<{ move: FirstMove | null; verdict: FirstMoveVerdict | "off" }> {
    if (!on || !deps.ask) return { move: null, verdict: "off" };
    const started = performance.now();
    const say = (
      verdict: FirstMoveVerdict,
      extra: Record<string, unknown> = {},
    ) => {
      // That a move was considered and how it ended — never the message, never a word of it.
      log.info("first_move", {
        verdict,
        ms: Math.round(performance.now() - started),
        ...extra,
      });
      return verdict;
    };

    const [only] = input.asked;
    if (
      input.asked.length !== 1 ||
      only?.role !== "user" ||
      typeof only.content !== "string"
    ) {
      // A skill's instruction before the message, or a file with it: not a plain short question.
      return { move: null, verdict: "not_one_message" };
    }
    const text = only.content.trim();
    if (text.length === 0 || text.length > FIRST_MOVE_MAX_CHARS) {
      return { move: null, verdict: "too_long" };
    }
    if (!mentionsWeather(text))
      return { move: null, verdict: "no_weather_word" };
    if (!input.toolNames.has(WEATHER_TOOL_NAME)) {
      return { move: null, verdict: say("no_tool") };
    }
    if (!(await input.hasPlace().catch(() => false))) {
      // The Bot asks where, as it does today; a call with no place would only be refused.
      return { move: null, verdict: say("no_place") };
    }
    if (await deps.budgetSpent?.().catch(() => false)) {
      return { move: null, verdict: say("budget_spent") };
    }

    const decided = await deps
      .ask({
        state: firstMoveStateOf(text),
        questions: FIRST_MOVE_QUESTIONS,
        timeoutMs: FIRST_MOVE_TIMEOUT_MS,
      })
      .catch(() => null);
    if (!decided?.ok) return { move: null, verdict: say("no_answer") };
    const forecast = noulOf(decided.answers.forecast);
    const ownPlace = noulOf(decided.answers.ownPlace);
    if (
      !(forecast >= FIRST_MOVE_BARS.forecast) ||
      !(ownPlace >= FIRST_MOVE_BARS.ownPlace)
    ) {
      return { move: null, verdict: say("below_bar") };
    }
    say("moved");
    return {
      move: {
        kind: "weather",
        tool: WEATHER_TOOL_NAME,
        args: {},
        decided: { forecast, ownPlace },
      },
      verdict: "moved",
    };
  };
}

export type FirstMoveFor = ReturnType<typeof createFirstMove>;

/**
 * The first move as the turn engine asks for it (`engine.ts`, `firstMove`): the decision, fed the
 * two facts it needs about this turn, and a row in the trail for a move it makes.
 *
 * Beside the decision rather than in `main.ts`, which only hands these three things to each other.
 */
export function firstMoveForTurns(deps: {
  decide: FirstMoveFor;
  whereaboutsOf: (
    userId: string,
  ) => Promise<Pick<Whereabouts, "place" | "coordinates">>;
  auditStore: AuditStore;
}) {
  return async (input: {
    owner: { id: string };
    botId: string;
    asked: readonly { role: string; content?: unknown }[];
    tools: readonly { name: string }[];
  }): Promise<FirstMove | null> => {
    const { move } = await deps.decide({
      asked: input.asked,
      toolNames: new Set(input.tools.map((tool) => tool.name)),
      hasPlace: async () => {
        const at = await deps.whereaboutsOf(input.owner.id);
        return Boolean(at.place?.trim()) || at.coordinates !== null;
      },
    });
    if (move) {
      // Not awaited: the trail must not be what the person waits on.
      void recordAuditEvent(deps.auditStore, {
        eventType: "turn.first_move",
        targetType: "agent",
        targetId: input.botId,
        actorUserId: input.owner.id,
        payload: {
          bot: input.botId,
          move: move.kind,
          tool: move.tool,
          decided: move.decided,
        },
      }).catch(auditRowLost("turn.first_move"));
    }
    return move;
  };
}
