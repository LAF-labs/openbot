import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { firstMoveCallId } from "@shared/first-move";
import { WEATHER_TOOL_NAME } from "@shared/tools/bridge";
import {
  stepRunsOf,
  stepsByAnswer,
  toVisibleChatItems,
  weatherCardsOf,
  withBrowsingTasks,
} from "../src/components/channels/chat-messages";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  ASKED,
  answered,
  asked,
  called,
  done,
  said,
} from "./support/step-fixtures";
import {
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * THE WEATHER CARD, IN THE CONVERSATION.
 *
 * The weather tool is a connected service's by its name, and a connected service's finished call
 * is a step of work: not drawn, opened from the answer it was done for (`stepRunsOf`). A weather
 * call that came back with data is not a step — it is the card the owner asked for (2026-10-04),
 * and it stays in the conversation where the call was made. One that came back with nothing is the
 * step it always was: put away, and counted as one that did not work.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const DATA = JSON.stringify({
  source: "기상청",
  place: "서울특별시 종로구",
  now: { temp: 17.2, humidity: 57, precip: "없음", wind: 1.2 },
  days: [
    {
      date: "2026-10-04",
      when: "오늘",
      min: 15,
      max: 24,
      am: "구름많음 30%",
      pm: "흐림 60%",
      precip: "없음",
    },
    {
      date: "2026-10-05",
      when: "내일",
      min: 13,
      max: 22,
      am: "맑음 0%",
      pm: "맑음 0%",
      precip: "없음",
    },
  ],
});
/** The same, for the place that was asked about when the first move fetched home. */
const ELSEWHERE = JSON.stringify({
  source: "기상청",
  place: "부산광역시 해운대구",
  now: { temp: 21.4, humidity: 61, precip: "없음", wind: 2.4 },
  days: [
    {
      date: "2026-10-04",
      when: "오늘",
      min: 18,
      max: 25,
      am: "맑음 0%",
      pm: "맑음 10%",
      precip: "없음",
    },
  ],
});
const REFUSED = "laf:weather_place_outside";
/** The tool's own partial answer, late in the evening: the next hours and nothing the card draws. */
const HOURS_ONLY = JSON.stringify({
  source: "기상청",
  place: "서울특별시 종로구",
  hours: [{ at: "22시", temp: 15, sky: "맑음", precip: "없음" }],
  unavailable: ["현재 관측", "날짜별 예보"],
});

const itemsOf = (messages: Message[]) =>
  withBrowsingTasks(toVisibleChatItems(messages));
const stepsOf = (messages: Message[]) => {
  const items = itemsOf(messages);
  const runs = stepRunsOf(items);
  return {
    steps: [...runs.keys()].map((index) => items[index]?.id),
    taken: Object.fromEntries(stepsByAnswer(items, runs)),
  };
};

describe("which weather calls are steps", () => {
  test("one that came back with data is a card: no step, and nothing for the answer to open", () => {
    expect(
      stepsOf([
        ASKED,
        called("w", WEATHER_TOOL_NAME),
        answered("w", DATA),
        said("a-answer", "지금은 선선해요."),
      ]),
    ).toEqual({ steps: [], taken: {} });
  });

  test("one still out, refused or failed is a step — and a card between two steps ends the run", () => {
    // Still out: the one line of a turn at work.
    expect(stepsOf([ASKED, called("w", WEATHER_TOOL_NAME)]).steps).toEqual([
      "call-w",
    ]);
    // Refused: put away, and counted for the answer as one that did not work.
    expect(
      stepsOf([
        ASKED,
        called("w", WEATHER_TOOL_NAME),
        answered("w", REFUSED),
        said("a-answer", "그곳은 예보가 닿지 않아요."),
      ]).taken,
    ).toEqual({
      "a-answer": { runIds: ["call-w"], rows: ["call-w"], failed: 1 },
    });
    /*
     * Data, and none of it the card's: no temperature now and no day. Known as a card by how the
     * answer begins, it was no step and no card — nothing on the screen (Codex on pull request
     * 62). It is a step that worked, opened from the answer like any other.
     */
    expect(
      stepsOf([
        ASKED,
        called("w", WEATHER_TOOL_NAME),
        answered("w", HOURS_ONLY),
        said("a-answer", "밤 열 시에는 15도예요."),
      ]).taken,
    ).toEqual({
      "a-answer": { runIds: ["call-w"], rows: ["call-w"], failed: 0 },
    });
    // A step, the card, a step: two runs of one, and the answer opens both.
    const mixed = stepsOf([
      ASKED,
      ...done("1"),
      called("w", WEATHER_TOOL_NAME),
      answered("w", DATA),
      ...done("2"),
      said("a-answer", "다 봤어요."),
    ]);
    expect(mixed.steps).toEqual(["call-1", "call-2"]);
    expect(mixed.taken).toEqual({
      "a-answer": {
        runIds: ["call-1", "call-2"],
        rows: ["call-1", "call-2"],
        failed: 0,
      },
    });
  });
});

/*
 * THE FIRST MOVE: the weather for where the person lives, fetched by the server before the Bot's
 * model is asked (`first-move.ts`), on a small model's word that the question is about there. When
 * that word was wrong the Bot asks again for the place that was meant, and both calls came back
 * with data — two cards, the first for a place nobody asked about (Codex on pull request 62).
 */
const MOVE = firstMoveCallId("1".repeat(32));
/** The move as the engine files it: an empty message that asks, with no argument, and the answer. */
const moved = (content: string): Message[] => [
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
  { id: "t-moved", role: "tool", toolCallId: MOVE, content } as Message,
];
const cardsOf = (messages: Message[]) => [...weatherCardsOf(itemsOf(messages))];

describe("a first move's answer", () => {
  test("is the card when the Bot answers from it", () => {
    const turn = [ASKED, ...moved(DATA), said("a-answer", "지금은 선선해요.")];
    expect(cardsOf(turn)).toEqual([MOVE]);
    expect(stepsOf(turn)).toEqual({ steps: [], taken: {} });
  });

  test("is a step once the Bot asks for the weather itself — the card is the one it asked for", () => {
    const turn = [
      ASKED,
      ...moved(DATA),
      called("w", WEATHER_TOOL_NAME),
      answered("w", ELSEWHERE),
      said("a-answer", "해운대는 내일 25도까지 올라가요."),
    ];
    expect(cardsOf(turn)).toEqual(["call-w"]);
    // Put away with the steps, and counted for the answer as one that worked.
    expect(stepsOf(turn)).toEqual({
      steps: [MOVE],
      taken: { "a-answer": { runIds: [MOVE], rows: [MOVE], failed: 0 } },
    });
  });

  test("is put away from the moment the Bot asks, and whatever comes of asking", () => {
    // Still out: the move is already a step, and the Bot's call is the line of a turn at work.
    const asking = [ASKED, ...moved(DATA), called("w", WEATHER_TOOL_NAME)];
    expect(cardsOf(asking)).toEqual([]);
    expect(stepsOf(asking).steps).toEqual([MOVE, "call-w"]);
    // Refused: no card at all. The Bot said the first was not the answer, and has no other.
    expect(
      cardsOf([
        ...asking,
        answered("w", REFUSED),
        said("a-answer", "그곳은 예보가 닿지 않아요."),
      ]),
    ).toEqual([]);
  });

  test("is not put away by a call in a later turn", () => {
    expect(
      cardsOf([
        ASKED,
        ...moved(DATA),
        said("a-answer", "지금은 선선해요."),
        asked("q-next", "부산은?"),
        called("w", WEATHER_TOOL_NAME),
        answered("w", ELSEWHERE),
        said("a-next", "부산은 더 따뜻해요."),
      ]),
    ).toEqual([MOVE, "call-w"]);
  });

  test("and two calls the Bot made itself are two places it was asked about: two cards", () => {
    expect(
      cardsOf([
        ASKED,
        called("1", WEATHER_TOOL_NAME),
        answered("1", DATA),
        called("2", WEATHER_TOOL_NAME),
        answered("2", ELSEWHERE),
        said("a-answer", "부산이 더 따뜻해요."),
      ]),
    ).toEqual(["call-1", "call-2"]);
  });
});

describe("a conversation with a weather call in it", () => {
  const log = (host: HTMLElement) => host.querySelector('[role="log"]');
  const rowsDrawn = (host: HTMLElement) =>
    [
      ...(log(host)?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
    ].map((row) => row.dataset.messageId);

  test("draws the card where the call was made, above the answer, with its source on it", async () => {
    const channelId = "channel_weather-card";
    const server = turnServer({
      channelId,
      history: [
        ASKED,
        called("w", WEATHER_TOOL_NAME),
        answered("w", DATA),
        said("a-answer", "지금은 선선하고, 오후에 흐려져요."),
      ],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () =>
        log(view.host)?.querySelector('[data-slot="weather-card"]') !== null &&
        log(view.host)?.textContent?.includes("오후에 흐려져요") === true,
      "the card and the answer",
      8000,
    );
    // The person's message, the card at the call's own row, the answer.
    expect(rowsDrawn(view.host)).toEqual(["q-asked", "call-w", "a-answer"]);
    const card = log(view.host)?.querySelector<HTMLElement>(
      '[data-message-id="call-w"] [data-slot="weather-card"]',
    );
    expect(card?.querySelector("[data-weather-now]")?.textContent).toBe("17°");
    expect(card?.querySelector("[data-weather-today]")?.textContent).toBe(
      "High 24° · Low 15°",
    );
    expect(card?.querySelectorAll("[data-weather-day]").length).toBe(2);
    expect(card?.querySelector("[data-weather-source]")?.textContent).toBe(
      "Source: Korea Meteorological Administration",
    );
    // The call's own line is not drawn beside its card.
    expect(
      log(view.host)?.querySelector('[data-message-id="call-w"]')?.textContent,
    ).not.toContain("Checking the weather");

    server.close();
    await view.unmount();
  });

  test("draws one card where a first move was put right: the place that was asked about", async () => {
    const channelId = "channel_weather-put-right";
    const server = turnServer({
      channelId,
      history: [
        ASKED,
        ...moved(DATA),
        called("w", WEATHER_TOOL_NAME),
        answered("w", ELSEWHERE),
        said("a-answer", "해운대는 내일 25도까지 올라가요."),
      ],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () =>
        log(view.host)?.querySelector('[data-slot="weather-card"]') !== null &&
        log(view.host)?.textContent?.includes("25도까지") === true,
      "the card and the answer",
      8000,
    );
    // The move's row is not drawn: it is a step, behind the answer's record.
    expect(rowsDrawn(view.host)).toEqual(["q-asked", "call-w", "a-answer"]);
    const cards = [
      ...(log(view.host)?.querySelectorAll<HTMLElement>(
        '[data-slot="weather-card"]',
      ) ?? []),
    ];
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Weather for 부산광역시 해운대구",
    ]);

    server.close();
    await view.unmount();
  });

  test("draws no card for a call that came back with nothing: it is put away like any step", async () => {
    const channelId = "channel_weather-refused";
    const server = turnServer({
      channelId,
      history: [
        ASKED,
        called("w", WEATHER_TOOL_NAME),
        answered("w", REFUSED),
        said("a-answer", "그곳은 예보가 닿지 않아요."),
      ],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () =>
        log(view.host)?.textContent?.includes("예보가 닿지 않아요") === true,
      "the answer",
      8000,
    );
    expect(rowsDrawn(view.host)).toEqual(["q-asked", "a-answer"]);
    expect(
      log(view.host)?.querySelectorAll('[data-slot="weather-card"]').length,
    ).toBe(0);

    server.close();
    await view.unmount();
  });
});
