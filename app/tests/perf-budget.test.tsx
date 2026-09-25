import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";
import { mount, unmountAll } from "./support/mount";

/**
 * THE APP'S HALF OF "ENOUGH", AS SOMETHING THAT FAILS LOUDLY (performance audit 2026-09-25, §8).
 *
 * The audit's numbers are a 500-message conversation on a mid PC at 4× CPU: the transcript drawn and
 * interactive in under 1.5 s, and no task over 200 ms while a reply streams. Measured before the
 * transcript was windowed, on a loaded host: 6–42 s to draw, single tasks of 2.7–11 s, and the
 * first reply after opening froze the page for up to 2.3 s at a time. A browser at 4× is not something
 * the gate can run in seconds and without flakes, so this holds the two properties those numbers
 * came from, which are deterministic:
 *
 *  - OPENING draws a window of rows, not the conversation. Every row costs a markdown parse and a
 *    layout; the load time was the row count.
 *  - STREAMING redraws the message being written and nothing else. A chunk that redraws other
 *    rows costs their markdown again on every chunk of every reply.
 *
 * The server's half — forwarding a turn — is `server/tests/perf-budget.integration.test.ts`.
 */

/**
 * The transcript's module graph — markdown, KaTeX, the chart renderer — takes seconds to load on a
 * busy machine, and that is not what any test here is about. Loaded once, before the clock starts.
 */
let modules: {
  transcript: typeof import("../src/components/channels/chat-transcript");
  query: typeof import("@tanstack/react-query");
};

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const [transcript, query] = await Promise.all([
    import("../src/components/channels/chat-transcript"),
    import("@tanstack/react-query"),
  ]);
  modules = { transcript, query };
}, 60_000);

afterEach(unmountAll);

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const LENGTH = 500;

/** A long conversation of the shape the audit measured: questions, and answers in markdown. */
function conversation(): Message[] {
  return Array.from({ length: LENGTH }, (_, at) =>
    at % 2 === 0
      ? ({
          id: `u-${at}`,
          role: "user",
          content: `질문 ${at}: 이번 주 매장 상황 정리해 줘.`,
        } as Message)
      : ({
          id: `a-${at}`,
          role: "assistant",
          content: `### ${at}번째 정리\n\n- **매출**: 지난주보다 ${at % 23}% 늘었어요.\n- 단골손님께 \`가을 신메뉴\` 안내를 보내 보세요.`,
        } as Message),
  );
}

function transcript(channelId?: string) {
  const { ChatTranscript, TRANSCRIPT_WINDOW_ROWS } = modules.transcript;
  const { query } = modules;
  const client = new query.QueryClient();
  const draw = (messages: Message[], busy = false) =>
    createElement(
      query.QueryClientProvider,
      { client },
      createElement(ChatTranscript, {
        busy,
        messages,
        ...(channelId ? { channelId } : {}),
      }),
    );
  return { draw, windowRows: TRANSCRIPT_WINDOW_ROWS };
}

const rowsIn = (host: HTMLElement) =>
  [...host.querySelectorAll("[data-message-id]")].map((row) =>
    row.getAttribute("data-message-id"),
  );

describe("where the drawn window starts", () => {
  const ids = Array.from({ length: LENGTH }, (_, at) => `m-${at}`);

  test("at the newest rows, reaching back to an unread line that is near", () => {
    const { windowStart, TRANSCRIPT_WINDOW_ROWS } = modules.transcript;
    expect(windowStart(ids, null, null)).toBe(LENGTH - TRANSCRIPT_WINDOW_ROWS);
    // Missed a hundred rows: the line and everything after it is drawn.
    expect(windowStart(ids, null, "m-400")).toBe(400);
    // Missed four hundred: that is most of the conversation, so it opens on the newest.
    expect(windowStart(ids, null, "m-100")).toBe(
      LENGTH - TRANSCRIPT_WINDOW_ROWS,
    );
  });

  test("at the pinned row once there is one, so it never slides as rows arrive", () => {
    const { windowStart } = modules.transcript;
    expect(windowStart([...ids, "m-new"], "m-440", null)).toBe(440);
    // Where the reading stopped can arrive after the pin, and still reaches back.
    expect(windowStart(ids, "m-440", "m-420")).toBe(420);
    // A row 오늘 asked to be shown is drawn however far back it is.
    expect(windowStart(ids, "m-440", null, "m-12")).toBe(12);
    // A pin that no longer names a row (another conversation's) falls back to the newest.
    expect(windowStart(ids, "gone", null)).toBe(
      LENGTH - modules.transcript.TRANSCRIPT_WINDOW_ROWS,
    );
  });
});

describe("a 500-message conversation", () => {
  test("opens on a window of its newest rows, not on all of them", async () => {
    const { draw, windowRows } = transcript();
    const history = conversation();
    // Empty for a beat, as a conversation is while its history is fetched.
    const view = await mount(draw([]));
    await view.render(draw(history));
    await view.settle();

    const rows = rowsIn(view.host);
    expect(rows.length).toBe(windowRows);
    expect(windowRows).toBeLessThanOrEqual(80);
    expect(rows.at(-1)).toBe(`a-${LENGTH - 1}`);
    expect(rows[0]).toBe(history[LENGTH - windowRows]?.id);
  }, 30_000);

  test("draws a row 오늘 asked for however far back it is, and keeps it drawn", async () => {
    const { requestJump } = await import("../src/lib/channels/jump");
    const { draw } = transcript("channel-jump");
    const view = await mount(draw([]));
    const { act } = await import("react");
    await act(async () => {
      requestJump({ channelId: "channel-jump", messageId: "u-10" });
    });
    await view.render(draw(conversation()));
    await view.settle();
    expect(rowsIn(view.host)).toContain("u-10");

    // Taken, and the rows it drew stay: the window only grows.
    await view.render(draw(conversation()));
    await view.settle();
    expect(rowsIn(view.host)[0]).toBe("u-10");
  }, 30_000);

  test("draws the next page above when asked for it, and keeps the newest", async () => {
    const { draw, windowRows } = transcript();
    const view = await mount(draw([]));
    await view.render(draw(conversation()));
    await view.settle();

    const earlier = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Show earlier messages",
    );
    expect(earlier).toBeDefined();
    await view.press(earlier as Element);

    const rows = rowsIn(view.host);
    expect(rows.length).toBe(windowRows * 2);
    expect(rows.at(-1)).toBe(`a-${LENGTH - 1}`);
  }, 30_000);

  test("a streamed chunk redraws the message being written and no other row", async () => {
    const { draw, windowRows } = transcript();
    const history = [
      ...conversation(),
      { id: "u-new", role: "user", content: "오늘은?" } as Message,
    ];
    const view = await mount(draw([]));
    await view.render(draw(history));
    await view.settle();

    const reply =
      "오늘 매출은 **어제보다 12%** 많아요. 단골손님 재방문이 가장 큰 이유예요.";
    const said = (length: number): Message[] => [
      ...history,
      {
        id: "a-new",
        role: "assistant",
        content: reply.slice(0, length),
      } as Message,
    ];
    // The first chunk mounts the new row; every chunk after it is the steady state of a stream.
    // Settled past the opening cascade, whose fades are style changes on the newest rows.
    await view.render(draw(said(4), true));
    await view.settle(1_500);

    const touched = new Set<string>();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        const row = node?.closest("[data-message-id]");
        if (row) touched.add(row.getAttribute("data-message-id") ?? "");
      }
    });
    observer.observe(view.host, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    for (let length = 8; length <= reply.length; length += 8) {
      // A new array each time, as `ChannelChat` hands down (see its "use no memo").
      await view.render(draw(said(length), true));
    }
    await view.settle();
    observer.disconnect();

    expect([...touched]).toEqual(["a-new"]);
    // The window grew by the new reply and did not slide: nothing above it was taken away.
    expect(rowsIn(view.host).length).toBe(windowRows + 1);
  }, 30_000);
});
