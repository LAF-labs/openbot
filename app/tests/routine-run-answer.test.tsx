import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createElement } from "react";
import { mount, unmountAll } from "./support/mount";

/**
 * A ROUTINE'S RUN, IN ITS HISTORY, READS THE WAY IT READ IN THE CONVERSATION.
 *
 * Measured 2026-09-27: the first morning briefing, pressed with 지금 실행, arrived in the conversation
 * under a bold heading and in the routine's history as `**9월 27일 (일) 아침 브리핑**`. Rendered here
 * through the real lazy renderer rather than by reading the source, because the failure was in
 * what reached the screen.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(unmountAll);

const BRIEFING =
  "**9월 27일 (일) 아침 브리핑**\n\n가게 위치를 몰라 날씨는 못 봤어요.\n\n- 오늘 날씨";

/** The lazy renderer resolves over a few ticks; wait until it has replaced its fallback. */
async function renderedAnswer(
  settle: (ms?: number) => Promise<void>,
  host: HTMLElement,
) {
  for (let tries = 0; tries < 100; tries++) {
    if (host.querySelector("li")) break;
    await settle(20);
  }
  return host;
}

describe("a routine run's answer", () => {
  test("a finished run's answer is drawn as prose, not as its markdown source", async () => {
    const { RunAnswer } = await import("../src/components/routines/run-answer");
    const mounted = await mount(
      createElement(RunAnswer, {
        outcome: { label: "성공", tone: "done", text: BRIEFING },
      }),
    );
    const host = await renderedAnswer(mounted.settle, mounted.host);

    expect(host.textContent).toContain("9월 27일 (일) 아침 브리핑");
    expect(host.textContent).not.toContain("**");
    // The list the Bot wrote is a list, which only a renderer makes.
    expect(host.querySelector("li")?.textContent).toBe("오늘 날씨");
    // Never inside a paragraph of its own: the renderer brings block elements.
    expect(host.querySelector("p p, p div, p ul")).toBeNull();
  });

  test("a failed run's sentence is this surface's own words, printed as they are", async () => {
    const { RunAnswer } = await import("../src/components/routines/run-answer");
    const sentence = "끝내지 못했어요. *잠시 뒤* 다시 해 볼게요.";
    const mounted = await mount(
      createElement(RunAnswer, {
        outcome: { label: "실패", tone: "failed", text: sentence },
      }),
    );
    await mounted.settle(60);

    expect(mounted.host.textContent).toBe(sentence);
    expect(mounted.host.querySelector("em")).toBeNull();
  });
});
