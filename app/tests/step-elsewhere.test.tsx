import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";
import { CarryOnNotice } from "@/components/channels/carry-on-notice";
import { dayMark } from "@/lib/agents/day";
import { ELSEWHERE_AFTER_MS, turnStateOf } from "@/lib/copilot/step-watcher";
import { asksForPerson } from "@/lib/copilot/stranded-steps";
import { ko } from "@/lib/i18n-ko";
import { mount, unmountAll } from "./support/mount";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3113/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await unmountAll();
  await GlobalRegistrator.unregister();
});

/**
 * A STEP A CRASHED WINDOW TOOK, SAID AS WHAT IT IS (0.5.4 final QA).
 *
 * A window that crashes mid-step says nothing, so the server lists its step as out for the whole
 * ten minutes a step may legitimately take (a person deciding on 허용). Every other window read
 * that as a turn going on — no notice, nothing to press — and 오늘 said 사장님 차례 with no
 * question anywhere. The ten minutes stay; what the windows say about them changes.
 */

describe("a step out with another window", () => {
  test("is a turn going on while it is new, and elsewhere once it is far older than a step", () => {
    expect(
      turnStateOf({ running: false, waiting: true, waitingMs: 2_000 }),
    ).toEqual({
      goingOn: true,
      elsewhere: false,
    });
    expect(
      turnStateOf({
        running: false,
        waiting: true,
        waitingMs: ELSEWHERE_AFTER_MS,
      }),
    ).toEqual({ goingOn: true, elsewhere: true });
    // A run on the wire is going on here and now, however long a step was out before it.
    expect(
      turnStateOf({ running: true, waiting: true, waitingMs: 600_000 }),
    ).toEqual({ goingOn: true, elsewhere: false });
    // A server from before the number: going on, never elsewhere.
    expect(turnStateOf({ running: false, waiting: true })).toEqual({
      goingOn: true,
      elsewhere: false,
    });
    expect(turnStateOf({ running: false, waiting: false })).toEqual({
      goingOn: false,
      elsewhere: false,
    });
  });

  test("is said as another window's, with 이어서 하기", async () => {
    const view = await mount(
      createElement(CarryOnNotice, {
        stop: { reason: "window_closed", unanswered: ["call-1"] },
        checked: true,
        busy: false,
        elsewhere: true,
        onCarryOn: () => {},
      }),
    );
    const html = view.host.textContent ?? "";
    expect(html).toContain("This task was going on in another window.");
    expect(html).toContain("Carry on");
    expect(ko["This task was going on in another window."]).toBe(
      "다른 창에서 진행 중이었어요.",
    );
  });

  /*
   * A PERSON AT THE WHEEL IN THE OTHER WINDOW (a login, a code) is a step out for as long as they
   * take, with no approval on it: said as "went quiet", 이어서 하기 would start a second run under
   * them. And no step is called quiet before the computer's own longest action has run out.
   */
  test("is never a request for help, and never before the longest action could have ended", () => {
    const messages = [
      { id: "u1", role: "user", content: "네이버에 로그인해 줘" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-help",
            type: "function",
            function: { name: "computer_request_help", arguments: "{}" },
          },
          {
            id: "call-click",
            type: "function",
            function: { name: "computer_click", arguments: "{}" },
          },
        ],
      },
    ] as Parameters<typeof asksForPerson>[0];
    expect(asksForPerson(messages, ["call-help"])).toBe(true);
    expect(asksForPerson(messages, ["call-click"])).toBe(false);
    expect(asksForPerson(messages, [])).toBe(false);
    // The computer's navigation timeout is 30 s; a slow site must not read as a window gone quiet.
    expect(ELSEWHERE_AFTER_MS).toBeGreaterThanOrEqual(45_000);
  });

  test("reads 사장님 차례 in 오늘 only while a question is open", () => {
    expect(dayMark("waiting", null, true)?.text).toBe("Your turn");
    expect(dayMark("waiting", null, false)?.text).toBe("Working on it");
  });
});
