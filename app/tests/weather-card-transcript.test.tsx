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
import { WEATHER_TOOL_NAME } from "@shared/tools/bridge";
import {
  stepRunsOf,
  stepsByAnswer,
  toVisibleChatItems,
  withBrowsingTasks,
} from "../src/components/channels/chat-messages";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { ASKED, answered, called, done, said } from "./support/step-fixtures";
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
      min: 15,
      max: 24,
      am: "구름많음 30%",
      pm: "흐림 60%",
      precip: "없음",
    },
    {
      date: "2026-10-05",
      min: 13,
      max: 22,
      am: "맑음 0%",
      pm: "맑음 0%",
      precip: "없음",
    },
  ],
});
const REFUSED = "laf:weather_place_outside";

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
