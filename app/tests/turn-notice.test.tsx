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
  channelServer,
  type RunInput,
  sse,
  THREAD_ID,
} from "./support/channel-server";

/**
 * A HALF ANSWER SAYS IT IS HALF, ON THE SCREEN THE PERSON IS LOOKING AT.
 *
 * agent-bot says `laf.answer_truncated` (the model hit its length limit mid-sentence) and
 * `laf.empty_answer` (nothing came back, twice) as CUSTOM events on the run's own stream. From
 * `4e68b040` (2026-09-02) until 0.5.4 nothing drew them: the one listener, `useStoppedTurn`, was
 * mounted only by the `/bot` route that commit deleted, so a cut-off paragraph read as a finished one
 * and an empty turn as a Bot that ignored the question. The real channel route, stubbed at the
 * network edge; what is asserted is what the transcript shows.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const notice = '[data-testid="transcript-notice"]';

function answeringThen(words: string, custom: string) {
  return ({ runId }: RunInput) =>
    sse([
      { type: "RUN_STARTED", threadId: THREAD_ID, runId },
      ...(words
        ? [
            {
              type: "TEXT_MESSAGE_START",
              messageId: `msg_${runId}`,
              role: "assistant",
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: `msg_${runId}`,
              delta: words,
            },
            { type: "TEXT_MESSAGE_END", messageId: `msg_${runId}` },
          ]
        : []),
      // Usage rides the same channel and is nothing to a person.
      {
        type: "CUSTOM",
        name: "laf.model.usage",
        value: { promptTokens: 10 },
      },
      { type: "CUSTOM", name: custom, value: { botId: "agent_edge-bot" } },
      { type: "RUN_FINISHED", threadId: THREAD_ID, runId },
    ]);
}

async function ask(channelId: string, run: (input: RunInput) => Response) {
  const { stashFirstMessage } = await import(
    "../src/components/channels/transcript-messages"
  );
  stashFirstMessage(channelId, "메뉴 소개글 길게 써줘");
  const server = channelServer({ channelId, runs: [run] });
  return mountApp({ path: `/channel/${channelId}`, api: server.api });
}

describe("a turn that arrived but is not the whole answer", () => {
  test("a cut-off answer keeps its half and says it was cut off", async () => {
    const view = await ask(
      "channel_notice-truncated",
      answeringThen("저희 가게 대표 메뉴는", "laf.answer_truncated"),
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
    await view.unmount();
  });

  test("an empty answer says the Bot answered with nothing", async () => {
    const view = await ask(
      "channel_notice-empty",
      answeringThen("", "laf.empty_answer"),
    );
    await view.waitFor(
      () => view.host.querySelector(notice) !== null,
      "the empty-answer notice",
      8000,
    );
    expect(view.host.querySelector(notice)?.textContent).toBe(
      "The Bot thought about it and answered with nothing. Ask again.",
    );
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
