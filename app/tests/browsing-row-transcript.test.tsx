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
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  acted,
  askedIn,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * A BROWSING TASK THAT IS OVER, IN THE CONVERSATION PEOPLE USE.
 *
 * `browsing-card-row.test.tsx` holds the row and the card it opens to. What only the conversation
 * can decide is held here, mounted, with the server's own history and a turn that is still going:
 * which tasks a person opened (kept for as long as the conversation is on screen, whatever arrives
 * above), that a row another screen sends them to is open when they get there, that 다시 해 보기 on
 * a row asks in this conversation, that a task being done is the card until its turn is over, and
 * that a task the Bot stopped after to ask for a hand keeps its card.
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

const ASKED: Message = {
  id: "q-weather",
  role: "user",
  content: "네이버에서 춘천 날씨 찾아줘",
};
const SEARCH = "https://search.naver.com/search.naver?query=춘천+날씨";

const called = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): Message =>
  ({
    id: `a-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: `call-${id}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  }) as Message;
const answered = (id: string, result: Record<string, unknown>): Message =>
  ({
    id: `t-${id}`,
    role: "tool",
    toolCallId: `call-${id}`,
    content: JSON.stringify(result),
  }) as Message;
const said = (id: string, text: string): Message => ({
  id,
  role: "assistant",
  content: text,
});

/** The Bot opened the search and read it: one task of two steps, with a sentence between them. */
const SEARCHED: Message[] = [
  called("1", "computer_navigate", { url: SEARCH }),
  answered("1", { ok: true, url: SEARCH, title: "춘천 날씨 : 네이버 검색" }),
  said("a-between", "검색 결과를 읽어 볼게요."),
  called("2", "computer_read"),
  answered("2", { ok: true, url: SEARCH, text: "맑음 19도" }),
];
const ANSWER = said("a-answer", "춘천은 지금 맑고 19도예요.");
/** Earlier talk, enough to put pages of the history above the newest one. */
const talk = (pairs: number): Message[] =>
  Array.from({ length: pairs }, (_, at) => [
    { id: `q-earlier-${at}`, role: "user", content: `질문 ${at}` } as Message,
    said(`a-earlier-${at}`, `답 ${at}`),
  ]).flat();

const log = (host: HTMLElement) => host.querySelector('[role="log"]');
/** The task's row in the transcript, by the id the scroller keys it with: its first call's. */
const taskRow = (host: HTMLElement) =>
  log(host)?.querySelector<HTMLElement>('[data-message-id="call-1"]') ?? null;
/** The button a task that is over folds by: its row, or the head of the card it opened to. */
const fold = (host: HTMLElement) =>
  taskRow(host)?.querySelector<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-controls])",
  ) ?? null;
const expanded = (host: HTMLElement) =>
  fold(host)?.getAttribute("aria-expanded") ?? null;
const textOf = (host: HTMLElement) => taskRow(host)?.textContent ?? "";

async function conversation(
  channelId: string,
  options: Omit<Parameters<typeof turnServer>[0], "channelId">,
) {
  const server = turnServer({ channelId, ...options });
  const view = await mountApp({
    path: `/channel/${channelId}`,
    api: server.api,
  });
  await view.waitFor(
    () => log(view.host)?.textContent?.includes(String(ASKED.content)) === true,
    "the conversation",
    8000,
  );
  return { server, view };
}

describe("a finished conversation with a browsing task", () => {
  test("draws it as one row; pressed, the card; pressed again, the row", async () => {
    const { server, view } = await conversation("channel_row-record", {
      history: [ASKED, ...SEARCHED, ANSWER],
    });
    await view.waitFor(() => fold(view.host) !== null, "the row", 4000);
    expect(expanded(view.host)).toBe("false");
    expect(fold(view.host)?.textContent).toBe("Naver · 춘천 날씨Finished");
    // One row: nothing of the card is drawn, and the answer is where it was.
    expect(textOf(view.host)).not.toContain("What it did");
    expect(taskRow(view.host)?.querySelectorAll("button")).toHaveLength(1);
    expect(log(view.host)?.textContent).toContain(String(ANSWER.content));

    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => expanded(view.host) === "true", "the card", 4000);
    expect(textOf(view.host)).toContain("What it did");
    expect(
      taskRow(view.host)?.querySelector("p.font-medium")?.textContent,
    ).toBe("춘천 날씨");

    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => expanded(view.host) === "false", "the row", 4000);
    expect(textOf(view.host)).not.toContain("What it did");
    server.close();
    await view.unmount();
  });

  test("a row another screen sends the person to is opened, and stays open", async () => {
    const channelId = "channel_row-jump";
    const { server, view } = await conversation(channelId, {
      history: [ASKED, ...SEARCHED, ANSWER],
    });
    await view.waitFor(() => fold(view.host) !== null, "the row", 4000);
    expect(expanded(view.host)).toBe("false");

    // 오늘 names the first thing the turn did: the task's own row.
    const { requestJump } = await import("../src/lib/channels/jump");
    await acted(() => requestJump({ channelId, messageId: "call-1" }));
    await view.waitFor(() => expanded(view.host) === "true", "the card", 4000);
    await view.waitFor(
      () => taskRow(view.host)?.getAttribute("data-jumped") === "true",
      "the row marked",
      4000,
    );
    expect(textOf(view.host)).toContain("What it did");

    // The jump is taken, and what it opened is the person's: it stays until they fold it.
    await view.settle(50);
    expect(expanded(view.host)).toBe("true");
    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => expanded(view.host) === "false", "the row", 4000);
    server.close();
    await view.unmount();
  });

  /*
   * A LATER STEP OF A TASK, OR A SENTENCE THE BOT SAID INSIDE IT, IS DRAWN BY THE TASK'S ROW. No row
   * carries its id, so a jump that named one was never taken — MEASURED 2026-10-04 on this very
   * history, before the row was looked for instead: the task's row was never marked, and the
   * conversation read every older page the server had (three more reads, from 17, 10 and 3)
   * looking for a row that is on no page. The jump is taken to the row that draws what it names.
   */
  test("a jump that names something inside a task is taken to the task's row, opened, and no older page is asked for", async () => {
    const channelId = "channel_row-inside";
    // A page of seven: the newest holds this turn whole, and the server has sixteen more above.
    const { server, view } = await conversation(channelId, {
      history: [...talk(8), ASKED, ...SEARCHED, ANSWER],
      historyPage: 7,
    });
    await view.waitFor(() => fold(view.host) !== null, "the row", 4000);
    expect(server.historyReads()).toBe(1);
    const { requestJump } = await import("../src/lib/channels/jump");

    for (const inside of ["call-2", "a-between"]) {
      await acted(() => requestJump({ channelId, messageId: inside }));
      await view.waitFor(
        () => expanded(view.host) === "true",
        `the card for ${inside}`,
        4000,
      );
      await view.waitFor(
        () => taskRow(view.host)?.getAttribute("data-jumped") === "true",
        `the row marked for ${inside}`,
        4000,
      );
      // Folded and unmarked again, for the next one.
      await view.click(fold(view.host) as HTMLButtonElement);
      await view.waitFor(() => expanded(view.host) === "false", "the row");
      await acted(() => taskRow(view.host)?.removeAttribute("data-jumped"));
    }
    // Long enough for a page to have been asked for and answered, had one been.
    await view.settle(300);
    expect(server.historyReads()).toBe(1);
    server.close();
    await view.unmount();
  });
});

/** Every row the transcript is drawing, by the id the scroller keys it with. */
const rowsDrawn = (host: HTMLElement) =>
  [
    ...(log(host)?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
  ].map((row) => row.dataset.messageId);
/**
 * Every task that is over, wherever it is: the buttons they fold by.
 *
 * NOT THE BUTTON THAT OPENS AN ANSWER'S MENU, which says whether it is open the same way: with the
 * answers' controls behind "more" (`answer-more.tsx`) every answer in the log has one, and counted
 * here a conversation with one task in it had two "folds". A menu's button says what it opens.
 */
const folds = (host: HTMLElement) => [
  ...(log(host)?.querySelectorAll<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-controls]):not([aria-haspopup])",
  ) ?? []),
];

describe("a task somebody opened", () => {
  /*
   * A TASK IS NAMED BY ITS FIRST STEP, AND A PAGE OF THE HISTORY CAN BEGIN IN THE MIDDLE OF ONE.
   * The page above then brings the steps before it: the same task under a new name, and its card
   * drawn anew. Remembered by the name it had, it would fold shut in front of the person reading.
   */
  test("stays open when the page above arrives with the steps before it", async () => {
    const channelId = "channel_row-page";
    // A page of four messages: the newest begins at the Bot's sentence between the two steps.
    const server = turnServer({
      channelId,
      history: [ASKED, ...SEARCHED, ANSWER],
      historyPage: 4,
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(() => folds(view.host).length === 1, "the row", 8000);
    expect(rowsDrawn(view.host)).toEqual(["a-between", "call-2", "a-answer"]);
    await view.click(folds(view.host)[0] as HTMLButtonElement);
    await view.waitFor(
      () => folds(view.host)[0]?.getAttribute("aria-expanded") === "true",
      "the card",
      4000,
    );

    const earlier = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Show earlier messages",
    );
    await view.click(earlier as HTMLButtonElement);
    // The task is whole now, named by its first step, and the sentence is inside it.
    await view.waitFor(
      () => rowsDrawn(view.host).includes("call-1"),
      "the page above",
      8000,
    );
    expect(rowsDrawn(view.host)).toEqual(["q-weather", "call-1", "a-answer"]);
    expect(folds(view.host)).toHaveLength(1);
    expect(folds(view.host)[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(textOf(view.host)).toContain("What it did");

    // And folded by its new head, it is not held open by the name it was opened under.
    await view.click(folds(view.host)[0] as HTMLButtonElement);
    await view.waitFor(() => expanded(view.host) === "false", "the row", 4000);
    server.close();
    await view.unmount();
  });
});

describe("a task that did not finish", () => {
  test("says so on its row, and 다시 해 보기 there asks the same thing again, in this conversation", async () => {
    const channelId = "channel_row-again";
    const { server, view } = await conversation(channelId, {
      history: [
        ASKED,
        called("1", "computer_navigate", { url: SEARCH }),
        answered("1", {
          ok: false,
          refused: true,
          code: "laf:computer_unreachable",
        }),
        said("a-answer", "지금은 브라우저를 열 수 없었어요."),
      ],
    });
    await view.waitFor(() => fold(view.host) !== null, "the row", 4000);
    expect(expanded(view.host)).toBe("false");
    expect(fold(view.host)?.textContent).toBe(
      "Naver · 춘천 날씨Couldn't finish",
    );
    expect(
      taskRow(view.host)?.querySelector("span.rounded-full")?.className,
    ).toContain("text-warning");

    const again = taskRow(view.host)?.querySelector<HTMLButtonElement>(
      'button[aria-label="Try it again"]',
    );
    expect(server.sends).toHaveLength(0);
    await view.click(again as HTMLButtonElement);
    await view.waitFor(() => server.sends.length === 1, "the send", 8000);
    expect(askedIn(server.sends[0]).map((message) => message.content)).toEqual([
      ASKED.content,
    ]);
    server.close();
    await view.unmount();
  });
});

describe("a turn that is still going", () => {
  test("draws the task as the card while it is done, and as the row once the turn is over", async () => {
    const channelId = "channel_row-going";
    const { server, view } = await conversation(channelId, {
      history: [ASKED],
      turn: { id: "turn-0", status: "running", asked: [ASKED.id] },
      turnMessages: [ASKED],
    });
    const writes = (messages: Message[]) => acted(() => server.say(messages));

    await writes([called("1", "computer_navigate", { url: SEARCH })]);
    await view.waitFor(() => taskRow(view.host) !== null, "the task", 4000);
    // Being done: the whole card, with nothing to fold it by.
    expect(expanded(view.host)).toBe(null);
    expect(textOf(view.host)).toContain("Working on it");
    expect(textOf(view.host)).toContain("What it did");

    // The answer being written after its last step does not end it: the turn does.
    await writes([...SEARCHED, ANSWER]);
    await view.waitFor(
      () =>
        log(view.host)?.textContent?.includes(String(ANSWER.content)) === true,
      "the answer",
      4000,
    );
    expect(expanded(view.host)).toBe(null);
    expect(textOf(view.host)).toContain("Working on it");

    await acted(() => server.announce("done"));
    await view.waitFor(() => expanded(view.host) === "false", "the row", 4000);
    expect(fold(view.host)?.textContent).toBe("Naver · 춘천 날씨Finished");
    expect(textOf(view.host)).not.toContain("What it did");
    server.close();
    await view.unmount();
  });

  test("keeps the card of a task the Bot stopped after to ask for a hand, until the request is answered", async () => {
    const channelId = "channel_row-handed";
    const { server, view } = await conversation(channelId, {
      history: [ASKED],
      turn: { id: "turn-0", status: "running", asked: [ASKED.id] },
      turnMessages: [ASKED],
    });
    const writes = (messages: Message[]) => acted(() => server.say(messages));
    const NEEDS_A_HAND = [
      ...SEARCHED,
      called("help", "computer_request_help", { reason: "로그인이 필요해요" }),
    ];

    await writes(NEEDS_A_HAND);
    await view.waitFor(
      () => textOf(view.host).includes("What it did"),
      "the card",
      4000,
    );
    // Over by its steps — the request ended it — and not over to the person: still the card.
    await view.settle(50);
    expect(expanded(view.host)).toBe(null);
    expect(textOf(view.host)).toContain("Finished");

    // Answered, the Bot goes on, and the task in front of the request is a row like any other.
    await writes([
      ...NEEDS_A_HAND,
      answered("help", { ok: true, code: "laf:control_returned" }),
    ]);
    await view.waitFor(() => expanded(view.host) === "false", "the row", 4000);
    expect(textOf(view.host)).not.toContain("What it did");
    server.close();
    await view.unmount();
  });
});
