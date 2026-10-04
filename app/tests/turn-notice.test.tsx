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
  acted,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * A HALF ANSWER SAYS IT IS HALF, ON THE SCREEN THE PERSON IS LOOKING AT.
 *
 * agent-bot says `laf.answer_truncated` (the model hit its length limit mid-sentence) and
 * `laf.empty_answer` (nothing came back, twice) as CUSTOM events on the run's own stream. From
 * `4e68b040` (2026-09-02) until 0.5.4 nothing drew them: the one listener, `useStoppedTurn`, was
 * mounted only by the `/bot` route that commit deleted, so a cut-off paragraph read as a finished one
 * and an empty turn as a Bot that ignored the question.
 *
 * The real channel route, stubbed at the network edge; what is asserted is what the transcript
 * shows. The turn is the server's: the event reaches the window as a frame of the turn's stream
 * (`hub.event`), which the store keeps as the turn's notice (`turn-frames.test.ts` holds the store;
 * this holds the screen). It was written against the window that ran the turn itself, removed
 * 2026-10-05, and nothing mounted had held it for the turns people actually have.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const notice = '[data-testid="transcript-notice"]';

/**
 * The first message goes to the server, whose turn says `words` (or nothing), the token counts —
 * which ride the same channel and are nothing to a person — and then `custom`, and ends.
 */
async function ask(channelId: string, words: string, custom: string) {
  const { stashFirstMessage } = await import(
    "../src/components/channels/transcript-messages"
  );
  stashFirstMessage(channelId, "메뉴 소개글 길게 써줘");
  const server = turnServer({ channelId });
  const view = await mountApp({
    path: `/channel/${channelId}`,
    api: server.api,
  });
  await view.waitFor(
    () => server.sends.length === 1 && server.turn() !== null,
    "the question handed to the server",
    8000,
  );
  await acted(() => {
    server.announce("running");
    if (words) {
      server.say([{ id: "a-half", role: "assistant", content: words }]);
    }
    server.custom("laf.model.usage", { promptTokens: 10 });
    server.custom(custom, { botId: "agent_edge-bot" });
    server.announce("done");
  });
  return { view, server };
}

describe("a turn that arrived but is not the whole answer", () => {
  test("a cut-off answer keeps its half and says it was cut off", async () => {
    const { view, server } = await ask(
      "channel_notice-truncated",
      "저희 가게 대표 메뉴는",
      "laf.answer_truncated",
    );
    await view.waitFor(
      () => view.host.querySelector(notice) !== null,
      "the cut-off notice under the half answer",
      8000,
    );
    expect(view.host.querySelector(notice)?.textContent).toBe(
      "The answer was cut off before it finished. Ask the Bot to carry on.",
    );
    expect(view.host.textContent).toContain("저희 가게 대표 메뉴는");
    // Not a failure: nothing red, and no code on screen.
    expect(
      view.host.querySelector('[data-testid="transcript-stopped"]'),
    ).toBeNull();
    expect(view.host.textContent).not.toContain("laf.");
    server.close();
    await view.unmount();
  });

  test("an empty answer says the Bot answered with nothing", async () => {
    const { view, server } = await ask(
      "channel_notice-empty",
      "",
      "laf.empty_answer",
    );
    await view.waitFor(
      () => view.host.querySelector(notice) !== null,
      "the empty-answer notice",
      8000,
    );
    expect(view.host.querySelector(notice)?.textContent).toBe(
      "The Bot thought about it and answered with nothing. Ask again.",
    );
    server.close();
    await view.unmount();
  });

  test("both sentences have Korean", () => {
    expect(
      ko["The answer was cut off before it finished. Ask the Bot to carry on."],
    ).toBeDefined();
    expect(
      ko["The Bot thought about it and answered with nothing. Ask again."],
    ).toBeDefined();
  });
});
