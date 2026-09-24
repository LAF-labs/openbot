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
 * WHICH MESSAGES THE TRANSCRIPT'S SCROLLER MAY ANCHOR ON.
 *
 * Measured 2026-09-24: after a reload, the first tool card of the next turn threw the view back to
 * the first message of the conversation (`scrollTop` 2616 → 2). The scroller scrolls to any anchor it
 * has not handled when the list's children change and their count does not — the "생각하는 중" line
 * going out as the card comes in is exactly that — and it had never handled the user messages the
 * history was restored with. The fix keeps the history from being anchors at all; this pins that,
 * because the jump itself is layout and `bun test` has none. What was seen in the browser, before and
 * after, is in the commit.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(unmountAll);

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const said = (id: string, role: "user" | "assistant", content: string) =>
  ({ id, role, content }) as Message;

const history = [
  said("u1", "user", "첫 질문"),
  said("a1", "assistant", "첫 답"),
  said("u2", "user", "둘째 질문"),
  said("a2", "assistant", "둘째 답"),
];

describe("the anchor decider", () => {
  test("anchors nothing the transcript opened with, and the message sent after it settled", async () => {
    const { createAnchorDecider } = await import(
      "../src/components/channels/chat-transcript"
    );
    const anchors = createAnchorDecider();
    // The restored history, newest user message included: never an anchor.
    expect(anchors.isAnchor("u2", true, true)).toBe(false);
    anchors.settle();
    // A send: a person's message, first seen as the newest item.
    expect(anchors.isAnchor("u3", true, true)).toBe(true);
    // Older stored history merged in later lands above what is on screen, never as the newest.
    expect(anchors.isAnchor("u0", true, false)).toBe(false);
    // A Bot's message is never one.
    expect(anchors.isAnchor("a3", false, true)).toBe(false);
    // Frozen: the answer does not change once the message is no longer the newest.
    expect(anchors.isAnchor("u3", true, false)).toBe(true);
    expect(anchors.isAnchor("u2", true, true)).toBe(false);
  });
});

describe("the transcript's rows", () => {
  test("mark only the message sent while it was open as the scroller's anchor", async () => {
    const [{ ChatTranscript }, { QueryClient, QueryClientProvider }] =
      await Promise.all([
        import("../src/components/channels/chat-transcript"),
        import("@tanstack/react-query"),
      ]);
    const client = new QueryClient();
    const draw = (messages: Message[]) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(ChatTranscript, { messages }),
      );
    const anchored = () =>
      [...view.host.querySelectorAll('[data-scroll-anchor="true"]')].map(
        (row) => row.getAttribute("data-message-id"),
      );

    // Empty for a beat, as a conversation is while its history is fetched.
    const view = await mount(draw([]));
    await view.render(draw(history));
    await view.settle();
    expect(
      view.host.querySelectorAll('[data-scroll-anchor="false"]').length,
    ).toBe(4);
    expect(anchored()).toEqual([]);

    // The person sends one.
    const sent = said("u3", "user", "셋째 질문");
    await view.render(draw([...history, sent]));
    await view.settle();
    expect(anchored()).toEqual(["u3"]);

    // The stored history merges in older messages above, and the Bot answers below.
    await view.render(
      draw([
        said("u0", "user", "예전 질문"),
        said("a0", "assistant", "예전 답"),
        ...history,
        sent,
        said("a3", "assistant", "셋째 답"),
      ]),
    );
    await view.settle();
    expect(anchored()).toEqual(["u3"]);
  });
});
