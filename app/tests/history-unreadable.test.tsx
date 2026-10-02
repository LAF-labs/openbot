import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  askedIn,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * A CONVERSATION WHOSE HISTORY COULD NOT BE READ SAYS SO, AND READS IT AGAIN.
 *
 * Found by a read-only review on 2026-10-02 and reproduced here before anything was changed: the
 * window reads the newest page once when it opens, and the moment people reopen the app is right
 * after the server restarted — when that one read is answered 503 by the front door. The store
 * marked the page unreadable and never read it again, and the screen never looked at the mark: an
 * empty conversation under the Bot's greeting, as though nothing had ever been said, until somebody
 * thought to reload the page.
 */

/*
 * At phone width, for the file after it: mounting the conversation leaves the window's width in
 * `lib/computer/screen-panel.ts` for the rest of the process (see `draft-to-composer.test.tsx`).
 */
beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
  (
    window as unknown as {
      happyDOM: { setWindowSize(size: { width: number }): void };
    }
  ).happyDOM.setWindowSize({ width: 375 });
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  localStorage.clear();
  const { forgetUnsentCache } = await import(
    "../src/components/channels/composer/outbox"
  );
  forgetUnsentCache();
});
setDefaultTimeout(20_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const EARLIER = {
  id: "q-earlier",
  role: "user" as const,
  content: "오늘 날짜 알려줘",
};
const EARLIER_ANSWER = {
  id: "a-earlier",
  role: "assistant" as const,
  content: "오늘은 10월 2일이에요.",
};
const failedNotice = '[data-read-state="failed"]';

const bubblesSaying = (host: HTMLElement, words: string) =>
  [
    ...host.querySelectorAll('[role="log"] [data-slot="bubble-content"]'),
  ].filter((bubble) => bubble.textContent?.trim() === words).length;

/**
 * How many there are, never the element: an assertion that fails holding a happy-dom element
 * prints the whole document it hangs from, and the run sits printing for minutes (measured).
 */
const count = (host: HTMLElement, selector: string) =>
  host.querySelectorAll(selector).length;
const greeting = '[data-greeting="head"]';

describe("a conversation opened while its history cannot be read", () => {
  test("says the conversation could not be loaded, with 다시 시도, instead of an empty one", async () => {
    const channelId = "channel_history-unreadable";
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
    });
    server.historyDown();
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    // The surface under test is the one whose turns the server owns: it asked the turn's doors.
    await view.waitFor(
      () => server.historyReads() > 0,
      "the first read of the history",
      8000,
    );
    await view.waitFor(
      () => view.host.querySelector(failedNotice) !== null,
      "the line saying the conversation could not be loaded",
      8000,
    );
    expect(view.host.querySelector(failedNotice)?.textContent).toContain(
      "Could not load this channel.",
    );
    expect(ko["Could not load this channel."]).toBe(
      "대화를 불러오지 못했어요.",
    );
    expect(ko["Try again"]).toBe("다시 시도");
    /*
     * Not the greeting: it is drawn where the conversation begins, and above a conversation that
     * could not be read it says nothing was ever said.
     */
    expect(count(view.host, greeting)).toBe(0);

    /*
     * Pressed between two of the window's own reads, so what arrives is the press's doing: after
     * the third read (at 0, 0.5 and 1.5 s) the next one by itself is two seconds away.
     */
    await view.waitFor(
      () => server.historyReads() >= 3,
      "the third read of the history",
      8000,
    );
    await view.waitFor(
      () => view.buttonNamed("Try again") !== undefined,
      "다시 시도, free to press",
      1000,
    );
    server.historyUp();
    await view.click(view.buttonNamed("Try again") as Element);
    await view.waitFor(
      () => bubblesSaying(view.host, EARLIER_ANSWER.content) === 1,
      "the conversation, read by the press",
      1000,
    );
    expect(server.historyReads()).toBe(4);
    expect(bubblesSaying(view.host, EARLIER.content)).toBe(1);
    expect(count(view.host, failedNotice)).toBe(0);
    expect(count(view.host, greeting)).toBe(1);
    server.close();
    await view.unmount();
  });

  test("reads it again by itself, so the conversation arrives without a press", async () => {
    const channelId = "channel_history-returns";
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
    });
    server.historyDown();
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => server.historyReads() > 0,
      "the first read of the history",
      8000,
    );
    // The server is back before the window's next look.
    server.historyUp();
    await view.waitFor(
      () => bubblesSaying(view.host, EARLIER_ANSWER.content) === 1,
      "the conversation, read again without anybody pressing anything",
      8000,
    );
    expect(count(view.host, failedNotice)).toBe(0);
    server.close();
    await view.unmount();
  });

  test("words kept on this device wait for the page, and are not spent on a server that is not there", async () => {
    const channelId = "channel_history-kept-words";
    const TYPED = "오늘 마감 체크리스트 써 줘";
    // What a tab that lost the server left behind (`composer/outbox.ts`), its one send by itself owed.
    localStorage.setItem(
      `laf:unsent:${channelId}`,
      JSON.stringify([
        {
          id: "q-typed",
          text: TYPED,
          instructions: [],
          at: "2026-10-02T10:23:00.000Z",
          autoTried: false,
        },
      ]),
    );
    const server = turnServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
    });
    server.historyDown();
    server.doorDown();
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => view.host.querySelector(failedNotice) !== null,
      "the line saying the conversation could not be loaded",
      8000,
    );
    await view.settle(300);
    /*
     * The page not being in used to count as the open being over, and the words went at once: into
     * the server that had just failed to answer, which spent the one send they get by themselves.
     */
    expect(server.sends).toHaveLength(0);
    expect(
      view.host.querySelector('[data-testid="transcript-unsent"]')?.textContent,
    ).toContain("It goes once by itself when the connection is back.");

    server.historyUp();
    server.doorUp();
    await view.waitFor(
      () => server.sends.length === 1,
      "the kept words, sent once the page is in",
      8000,
    );
    expect(askedIn(server.sends[0]).map((message) => message.id)).toEqual([
      "q-typed",
    ]);
    await view.waitFor(
      () => localStorage.getItem(`laf:unsent:${channelId}`) === null,
      "the device keeping nothing once the server has it",
      8000,
    );
    expect(bubblesSaying(view.host, TYPED)).toBe(1);
    server.close();
    await view.unmount();
  });
});
