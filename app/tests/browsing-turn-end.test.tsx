import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiRequest,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  answering,
  BOT_ID,
  channelServer,
  type RunInput,
  sse,
  THREAD_ID,
} from "./support/channel-server";

/**
 * A TURN THAT USED THE BROWSER ENDS WHEN ITS LAST RUN DOES, NOT ITS FIRST.
 *
 * The Bot asks for a browser step, the run ends so this tab can take it, and the next run carries
 * the result — two runs inside one `runAgent`. The chat used to take the first RUN_FINISHED for the
 * turn's end and stop listening: MEASURED 2026-09-25 on a local stack, agent-bot killed after a
 * Naver search left the question with no line at all until a reload, and a browsing answer that
 * did arrive was never reported to the roster or marked read ("읽지 않음" above a reply the person
 * had watched arrive). The real channel route, stubbed at the network edge.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const QUESTION = "네이버에서 성수동 날씨 찾아줘";
const ANSWER = "성수동은 지금 비가 오고 19도예요.";

/** The first run: the Bot asks this tab to read the page, and the run ends to let it. */
const askingToRead = ({ runId }: RunInput) =>
  sse([
    { type: "RUN_STARTED", threadId: THREAD_ID, runId },
    {
      type: "TOOL_CALL_START",
      toolCallId: `call_${runId}`,
      toolCallName: "computer_read",
      parentMessageId: `msg_${runId}`,
    },
    { type: "TOOL_CALL_ARGS", toolCallId: `call_${runId}`, delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: `call_${runId}` },
    { type: "RUN_FINISHED", threadId: THREAD_ID, runId },
  ]);

async function browsingTurn(
  channelId: string,
  second: (input: RunInput) => Response,
) {
  const { stashFirstMessage } = await import(
    "../src/components/channels/transcript-messages"
  );
  stashFirstMessage(channelId, QUESTION);
  const server = channelServer({ channelId, runs: [askingToRead, second] });
  const reported: string[] = [];
  const api = (request: ApiRequest) => {
    if (request.pathname === `/api/computers/${BOT_ID}/read`) {
      return json({ ok: true, url: "https://weather.naver.com/", text: "비" });
    }
    if (
      request.pathname === `/api/channels/${channelId}/activity` &&
      request.method === "POST"
    ) {
      reported.push(String((request.body as { text?: unknown }).text));
    }
    return server.api(request);
  };
  const view = await mountApp({ path: `/channel/${channelId}`, api });
  return { server, view, reported };
}

describe("a turn that took a browser step", () => {
  test("a failure in the run after the step still says so", async () => {
    const { server, view } = await browsingTurn(
      "channel_browse-fails",
      ({ runId }) =>
        sse([
          { type: "RUN_STARTED", threadId: THREAD_ID, runId },
          { type: "RUN_ERROR", message: "laf:model_failed" },
        ]),
    );
    await view.waitFor(
      () => server.runs.length === 2,
      "the run that carries the step's result",
      8000,
    );
    await view.waitFor(
      () =>
        view.host.querySelector('[data-testid="transcript-stopped"]') !== null,
      "the failure line under the question",
      8000,
    );
    expect(
      view.host.querySelector('[data-testid="transcript-stopped"]')
        ?.textContent,
    ).toContain("The Bot could not reach its model.");
    await view.unmount();
  });

  test("the answer that arrives after the step is the turn's answer", async () => {
    const { server, view, reported } = await browsingTurn(
      "channel_browse-answers",
      answering(ANSWER),
    );
    await view.waitFor(
      () => server.runs.length === 2 && reported.length > 1,
      "the answer reported to the roster",
      8000,
    );
    // The question is reported when it is sent; the answer, once, when the turn is over.
    expect(reported).toEqual([QUESTION, ANSWER]);
    await view.unmount();
  });
});
