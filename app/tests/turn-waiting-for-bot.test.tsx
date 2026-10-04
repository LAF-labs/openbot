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
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  acted,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * A TURN WAITING FOR THE BOT SAYS SO, INSTEAD OF SAYING THE BOT IS THINKING.
 *
 * Found by a read-only review on 2026-10-02 and reproduced here before anything was changed: a
 * routine is running on the Bot, the person sends a message, and the server announces the turn
 * `queued` — it runs when the Bot is free. The window folded `queued` into "going" and drew what it
 * draws for a Bot that has the turn and has not spoken yet: "생각 중", for as long as the routine
 * took, with nothing true to read.
 *
 * EVERY TURN IS `queued` FOR A MOMENT. The engine announces it on accepting the turn and `running`
 * once it has the Bot and its thread, a few milliseconds later when the Bot is free — so the line
 * is said only of a turn that has stayed queued, and not flashed at the start of each one.
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
  (await import("../src/lib/use-lasting")).setLastingScale(SCALE);
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  // Back to the waits as written, for every file after this one.
  (await import("../src/lib/use-lasting")).setLastingScale();
  removeTurnStreams();
  await removeAppDom();
});

/*
 * THE WAIT IS THE PRODUCT'S, AND ITS CLOCK IS RUN AT A THIRD HERE (`setLastingScale`): every wait
 * below is the one this file was written with, divided by three, and so is the screen's — 667 ms
 * for its 2000 (`QUEUED_SAID_AFTER_MS`). The file waited out 5 s of real time before (measured
 * 2026-10-04). A "said" or "not said past the wait" is decided by the order two timers fire in; the
 * one "not yet" (a third of 300 ms) ends about half a second before the screen's deadline — 567 ms,
 * less whatever the mount spent after the turn was read as queued, which started the screen's wait.
 */
const SCALE = 1 / 3;
const scaled = (ms: number) => Math.round(ms * SCALE);

const WAITING = "Finishing another job first · this one is next";
const EARLIER: Message = {
  id: "q-earlier",
  role: "user",
  content: "오늘 날짜 알려줘",
};
const EARLIER_ANSWER: Message = {
  id: "a-earlier",
  role: "assistant",
  content: "오늘은 10월 2일이에요.",
};
const ASKED: Message = {
  id: "q-asked",
  role: "user",
  content: "경제 뉴스 알려줘",
};

/** What the transcript says under the conversation, and what a screen reader is told of it. */
const said = (host: HTMLElement) =>
  host.querySelector('[role="log"]')?.textContent ?? "";

async function conversation(channelId: string) {
  const server = turnServer({
    channelId,
    history: [EARLIER, EARLIER_ANSWER, ASKED],
    // A routine has the Bot: the turn was accepted and waits for it.
    turn: { id: "turn-0", status: "queued", asked: [ASKED.id] },
    turnMessages: [ASKED],
  });
  const view = await mountApp({
    path: `/channel/${channelId}`,
    api: server.api,
  });
  await view.waitFor(
    () => said(view.host).includes(String(ASKED.content)),
    "the question the turn is for",
    8000,
  );
  return { server, view };
}

describe("a turn the server says is queued", () => {
  test("says the Bot is finishing something else, where it used to say it was thinking", async () => {
    const { server, view } = await conversation("channel_turn-queued");
    // Past the moment every turn is queued for: this one is waiting for the Bot.
    await view.settle(scaled(2400));
    expect(said(view.host)).toContain(WAITING);
    expect(said(view.host)).not.toContain("Thinking");
    expect(ko[WAITING]).toBe(
      "다른 일을 먼저 마치는 중 · 끝나면 바로 이어서 해요",
    );
    // Stop still reaches a turn that has not started: the engine stops it where it waits.
    expect(
      view.host.querySelector('button[aria-label="Stop the Bot"]'),
    ).not.toBeNull();

    // The Bot is free and the turn has it: thinking, which is now true.
    await acted(() => server.announce("running"));
    await view.waitFor(
      () => said(view.host).includes("Thinking"),
      "the thinking line, once the turn is running",
      2000,
    );
    expect(said(view.host)).not.toContain(WAITING);
    server.close();
    await view.unmount();
  });

  test("says so again when the turn waits for the Bot in the middle, whatever its last row is", async () => {
    const { server, view } = await conversation("channel_turn-queued-again");
    await acted(() => server.announce("running"));
    await acted(() =>
      server.say([
        {
          id: "a-1",
          role: "assistant",
          content: "찾아보고 있어요.",
        } as Message,
      ]),
    );
    await view.waitFor(
      () => said(view.host).includes("찾아보고 있어요."),
      "what the Bot said before it had to wait",
      2000,
    );
    /*
     * The turn let go of the Bot to wait on the person, a routine took it meanwhile, and the turn
     * is queued behind it again — with the Bot's own words as the last thing in the conversation.
     */
    await acted(() => server.announce("queued"));
    await view.waitFor(
      () => said(view.host).includes(WAITING),
      "the line, for a turn queued again partway",
      6000,
    );
    await acted(() => server.announce("running"));
    await view.settle(50);
    expect(said(view.host)).not.toContain(WAITING);
    server.close();
    await view.unmount();
  });

  test("says nothing new of the moment every turn is queued for before it runs", async () => {
    const { server, view } = await conversation("channel_turn-queued-briefly");
    await view.settle(scaled(300));
    expect(said(view.host)).not.toContain(WAITING);
    await acted(() => server.announce("running"));
    // Past the wait the line is said after: the wait ended with the queue, and says nothing now.
    await view.settle(scaled(2400));
    expect(said(view.host)).not.toContain(WAITING);
    expect(said(view.host)).toContain("Thinking");
    server.close();
    await view.unmount();
  });
});
