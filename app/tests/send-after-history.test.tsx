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
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { answering, channelServer } from "./support/channel-server";

/**
 * A MESSAGE SENT AS SOON AS A CONVERSATION OPENS GOES OUT WITH THE THREAD BEHIND IT.
 *
 * MEASURED 2026-09-26 on a local stack: a server with no run of the thread in memory — every thread
 * after a restart — and a history read that took 3 s. The message sent the moment the composer was
 * there went out as a run of one message, and the history was merged in behind it afterwards, so
 * the next run sent the thread out of order: the provider's cached prefix broken, and the Bot
 * handed a conversation whose newest line came first. A turn now waits for the history the join
 * restores, as the first message of a new conversation already did for a moment.
 */

beforeAll(async () => {
  await installAppDom();
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
});
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const EARLIER = { id: "q-earlier", role: "user", content: "오늘 날짜 알려줘" };
const EARLIER_ANSWER = {
  id: "a-earlier",
  role: "assistant",
  content: "오늘은 9월 24일이에요.",
};
const TYPED = "마감 체크리스트 써 줘";

describe("a turn sent before the thread's history has arrived", () => {
  test("waits for it, and goes out after what the thread already held", async () => {
    const { stashFirstMessage } = await import(
      "../src/components/channels/transcript-messages"
    );
    const channelId = "channel_history-first";
    stashFirstMessage(channelId, TYPED);
    const server = channelServer({
      channelId,
      history: [EARLIER, EARLIER_ANSWER],
      runs: [answering("불 끄고 문 잠그세요.")],
    });
    // Slower than every backstop a turn had before this: 1.5 s for the join, 5 s for the grants.
    const HISTORY_MS = 2_500;
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: (request) =>
        request.pathname.endsWith("/messages")
          ? new Promise<Response>((resolve) =>
              setTimeout(() => {
                const answer = server.api(request);
                if (answer) resolve(answer);
              }, HISTORY_MS),
            )
          : server.api(request),
    });
    await view.waitFor(
      () => server.runs.length === 1,
      "the turn to go out",
      12_000,
    );
    expect(server.runs[0]?.messages.map((message) => message.id)).toEqual([
      "q-earlier",
      "a-earlier",
      expect.any(String),
    ]);
    expect(server.runs[0]?.messages.at(-1)?.content).toBe(TYPED);
    await view.unmount();
  });
});
