import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { firstMoveCallId } from "@shared/first-move";
import { WEATHER_TOOL_NAME } from "@shared/tools/bridge";
import {
  arrivedBelow,
  isHandedToThePerson,
  stepRunsOf,
  stepsByAnswer,
  toVisibleChatItems,
  withBrowsingTasks,
} from "../src/components/channels/chat-messages";
import {
  CARDS,
  type CardEntry,
  cardDrawnFor,
  isFoldableStep,
  rowKindsOf,
} from "../src/components/channels/row-kinds";
import { WeatherCard } from "../src/components/weather/weather-card";
import {
  ASKED,
  answered,
  asked,
  called,
  done,
  MAIL_WITH_A_CODE,
  said,
} from "./support/step-fixtures";

/**
 * WHAT EACH ROW OF THE CONVERSATION IS, ASKED ONCE (`rowKindsOf`).
 *
 * The weather card had to be planted in three places — the steps, the row that draws it, the count
 * of arrivals — and the third was missed until a review found it (pull request 62, round 8). These
 * hold the projection that replaced the three: one conversation with every kind of row in it, and
 * one entry more in the list of cards, which is the whole of what the next card costs.
 */

const itemsOf = (messages: Message[]) =>
  withBrowsingTasks(toVisibleChatItems(messages));

/** Each row's id beside what it is. */
const kindsOf = (messages: Message[], cards?: readonly CardEntry[]) => {
  const items = itemsOf(messages);
  const kinds = rowKindsOf(items, cards);
  return items.map((item, index) => [item.id, kinds[index]]);
};

const DATA = JSON.stringify({
  source: "기상청",
  place: "부산광역시 해운대구",
  now: { temp: 21.4 },
  days: [{ date: "2026-10-04", when: "오늘", min: 18, max: 25 }],
});

/** The weather for home, fetched before the Bot was asked, and then put right by the Bot. */
const MOVE = firstMoveCallId("2".repeat(32));
const moved: Message[] = [
  {
    id: "a-moved",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: MOVE,
        type: "function",
        function: { name: WEATHER_TOOL_NAME, arguments: "{}" },
      },
    ],
  } as Message,
  { id: "t-moved", role: "tool", toolCallId: MOVE, content: DATA } as Message,
];

/** Three turns, and between them every kind of row there is. */
const CONVERSATION: Message[] = [
  // The weather, asked about a place that is not home: the first move is put right.
  asked("q-weather", "내일 부산 해운대 날씨 어때?"),
  ...moved,
  called("w", WEATHER_TOOL_NAME),
  answered("w", DATA),
  said("a-weather", "해운대는 25도까지 올라가요."),
  // Mail: two steps, one with a code on it, the clock, a question, a chart.
  ASKED,
  ...done("1"),
  called("2", "tool_call"),
  answered("2", MAIL_WITH_A_CODE),
  ...done("now", "now"),
  ...done("ask", "askChoice"),
  ...done("chart", "showBarChart"),
  said("a-mail", "한 통 와 있어요."),
  // A purchase in the browser, stopped on a request for a hand that nobody has answered.
  asked("q-buy", "예스24에서 바로구매 해 줘"),
  ...done("nav", "computer_navigate"),
  said("a-note", "로그인이 필요해요."),
  called("help", "computer_request_help"),
];

describe("one conversation, every row", () => {
  test("is told what it is", () => {
    expect(kindsOf(CONVERSATION)).toEqual([
      ["q-weather", { kind: "person" }],
      // Asked again after: the step it was before there were cards.
      [MOVE, { kind: "step", runId: MOVE, staysDrawn: false }],
      ["call-w", { kind: "card", card: "weather" }],
      ["a-weather", { kind: "answer" }],
      ["q-asked", { kind: "person" }],
      ["call-1", { kind: "step", runId: "call-1", staysDrawn: false }],
      // The code is on its line: drawn whether or not the run is open.
      ["call-2", { kind: "step", runId: "call-1", staysDrawn: true }],
      ["call-now", { kind: "line" }],
      ["call-ask", { kind: "card", card: "decision" }],
      ["call-chart", { kind: "card", card: "shown" }],
      ["a-mail", { kind: "answer" }],
      ["q-buy", { kind: "person" }],
      ["call-nav", { kind: "browse", isHandedOver: true }],
      ["a-note", { kind: "answer" }],
      ["call-help", { kind: "card", card: "asks" }],
    ]);
  });

  test("and everything that folds, opens or counts reads it", () => {
    const items = itemsOf(CONVERSATION);
    const kinds = rowKindsOf(items);
    const runs = stepRunsOf(items, kinds);
    expect([...runs.keys()].map((index) => items[index]?.id)).toEqual([
      MOVE,
      "call-1",
      "call-2",
    ]);
    expect(Object.fromEntries(stepsByAnswer(items, runs))).toEqual({
      "a-weather": { runIds: [MOVE], rows: [MOVE], failed: 0 },
      "a-mail": {
        runIds: ["call-1"],
        rows: ["call-1", "call-2"],
        failed: 0,
      },
    });
    // From the person's last message: the note and the request for a hand.
    expect(arrivedBelow(items, "q-buy", kinds)).toBe(2);
    // From the first: the weather card, its answer, the question, the chart, the answer, and those.
    expect(arrivedBelow(items, "q-weather", kinds)).toBe(7);
    const task = items.findIndex((item) => item.id === "call-nav");
    expect(isHandedToThePerson(items, task, kinds)).toBe(true);
  });

  test("the weather card is drawn from its own entry", () => {
    expect(cardDrawnFor(WEATHER_TOOL_NAME)).toBe(WeatherCard);
    // The gallery's cards are drawn by the renderers registered for their names.
    expect(cardDrawnFor("askChoice")).toBeNull();
  });
});

describe("the list of cards", () => {
  test("names a call once", () => {
    const names = CARDS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /*
   * A CARD BY ITS NAME ALONE IS NO STEP BY ITS NAME. The list is asked first, so such a name would
   * be a card all the same — but the steps used to be found by name before there was a list, and
   * every card that was a card by name was nowhere near them. Only an entry that looks at the
   * answer shares a name with the steps: the weather's, a step until its answer is the card.
   */
  test("shares a name with the steps only where it looks at the answer", () => {
    expect(
      CARDS.filter((entry) => isFoldableStep(entry.name)).map(
        (entry) => entry.card,
      ),
    ).toEqual(["weather"]);
    expect(
      CARDS.filter((entry) => isFoldableStep(entry.name)).every(
        (entry) => entry.isCard !== undefined,
      ),
    ).toBe(true);
  });
});

/*
 * THE NEXT CARD IS ONE ENTRY. A share price, by a connected service's tool — a step by its name,
 * exactly the weather's shape. With the entry, the same call is at once drawn as the card, out of
 * the steps, and an arrival; and an answer that is not the card leaves it the step it was.
 */
describe("one more entry", () => {
  const QUOTE = "mcp__stocks__get_quote";
  function QuoteCard({ result }: { result: string }) {
    return result;
  }
  const quote: CardEntry = {
    name: QUOTE,
    card: "quote",
    isCard: (result) => result.startsWith('{"price"'),
    Drawn: QuoteCard,
  };
  const withQuote = [...CARDS, quote];
  const turn = (result: string) => [
    ASKED,
    called("q", QUOTE),
    answered("q", result),
    said("a-quote", "지금 503,854원이에요."),
  ];
  const read = (messages: Message[], cards: readonly CardEntry[]) => {
    const items = itemsOf(messages);
    const kinds = rowKindsOf(items, cards);
    const runs = stepRunsOf(items, kinds);
    return {
      kind: kinds[1],
      steps: [...runs.keys()].map((index) => items[index]?.id),
      taken: Object.fromEntries(stepsByAnswer(items, runs)),
      arrived: arrivedBelow(items, "q-asked", kinds),
      drawn: cardDrawnFor(QUOTE, cards),
    };
  };

  test("without it, the call is a step", () => {
    expect(read(turn('{"price":503854}'), CARDS)).toEqual({
      kind: { kind: "step", runId: "call-q", staysDrawn: false },
      steps: ["call-q"],
      taken: {
        "a-quote": { runIds: ["call-q"], rows: ["call-q"], failed: 0 },
      },
      arrived: 1,
      drawn: null,
    });
  });

  test("with it, the same call is a card to draw, no step, and an arrival", () => {
    expect(read(turn('{"price":503854}'), withQuote)).toEqual({
      kind: { kind: "card", card: "quote" },
      steps: [],
      taken: {},
      arrived: 2,
      drawn: QuoteCard,
    });
  });

  test("and an answer that is not the card leaves it a step", () => {
    expect(read(turn("laf:quote_unavailable"), withQuote)).toMatchObject({
      kind: { kind: "step", runId: "call-q", staysDrawn: false },
      steps: ["call-q"],
      arrived: 1,
    });
  });
});
