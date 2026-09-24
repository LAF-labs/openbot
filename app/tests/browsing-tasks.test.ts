import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  openBrowsingTask,
  toVisibleChatItems,
  withBrowsingTasks,
} from "../src/components/channels/chat-messages";
import {
  type BrowsingStep,
  doingNow,
  endingOf,
  pictureStepOf,
  sitesOf,
  stepLine,
} from "../src/lib/computer/browsing";
import {
  dismissTask,
  forgetBrowsingNow,
  isInUse,
  LINGER_MS,
  markPageGone,
  publishOpenTask,
  readBrowsingNow,
} from "../src/lib/computer/browsing-now";
import { skipHelp, takeSkip } from "../src/lib/computer/help-skips";

/**
 * A BOT'S BROWSING, AS THE CONVERSATION DRAWS IT: ONE CARD PER TASK, AND NOTHING THAT OPENS ITSELF.
 *
 * The owner's complaint was a screen that opened every time the Bot browsed, would not stay closed,
 * and left an empty box when the Bot closed its page. What replaced it is decided here, in pure
 * functions: which calls make one task, which task is still open, what the banner says, and which
 * call the task's last picture is kept on.
 */

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;

/** An assistant message carrying calls, and the results that answered them. */
function calls(
  ...made: { name: string; args?: Record<string, unknown>; result?: unknown }[]
): Message[] {
  const withIds = made.map((call) => ({ ...call, id: id("call") }));
  const assistant = {
    id: id("assistant"),
    role: "assistant",
    content: "",
    toolCalls: withIds.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    })),
  } as Message;
  const results = withIds
    .filter((call) => call.result !== undefined)
    .map(
      (call) =>
        ({
          id: id("tool"),
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(call.result),
        }) as Message,
    );
  return [assistant, ...results];
}

const said = (role: "user" | "assistant", text: string): Message =>
  ({ id: id(role), role, content: text }) as Message;

const itemsOf = (messages: Message[]) =>
  withBrowsingTasks(toVisibleChatItems(messages));

afterEach(() => {
  forgetBrowsingNow();
});

describe("which calls make one task", () => {
  test("browser calls in a row are one card, whatever messages they came in", () => {
    const items = itemsOf([
      said("user", "네이버에서 오늘 날씨 확인해 줘"),
      ...calls({
        name: "computer_navigate",
        args: { url: "https://naver.com" },
        result: { ok: true, url: "https://www.naver.com/" },
      }),
      ...calls({
        name: "computer_snapshot",
        result: { ok: true, elements: [1, 2] },
      }),
      ...calls({
        name: "computer_click",
        args: { ref: "e3" },
        result: { ok: true },
      }),
      said("assistant", "오늘 서울은 맑아요."),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["text", "browse", "text"]);
    const task = items[1];
    expect(task?.kind === "browse" ? task.steps.length : 0).toBe(3);
  });

  test("what the Bot says between two stretches of browsing splits them into two tasks", () => {
    const items = itemsOf([
      ...calls({
        name: "computer_navigate",
        args: { url: "https://a.example" },
        result: { ok: true },
      }),
      said("assistant", "첫 페이지를 봤어요. 다음으로 갈게요."),
      ...calls({
        name: "computer_navigate",
        args: { url: "https://b.example" },
        result: { ok: true },
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "browse",
      "text",
      "browse",
    ]);
  });

  test("a request for a person is a card of its own and ends the task before it", () => {
    const items = itemsOf([
      ...calls(
        {
          name: "computer_navigate",
          args: { url: "https://nid.naver.com/login" },
          result: { ok: true },
        },
        { name: "computer_request_help", args: { reason: "로그인해 주세요" } },
      ),
    ]);
    expect(
      items.map((item) =>
        item.kind === "tool" ? item.toolCall.function.name : item.kind,
      ),
    ).toEqual(["browse", "computer_request_help"]);
  });

  test("the workspace's file calls are not browsing, and stay lines of their own", () => {
    const items = itemsOf([
      ...calls({
        name: "computer_write_file",
        args: { path: "a.txt" },
        result: { ok: true },
      }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["tool"]);
  });

  test("a task keeps its first call's id while it grows, so its card keeps its place", () => {
    const first = calls({
      name: "computer_navigate",
      args: { url: "https://a.example" },
    });
    const before = itemsOf(first);
    const after = itemsOf([...first, ...calls({ name: "computer_snapshot" })]);
    expect(before[0]?.id).toBe(after[0]?.id);
  });
});

describe("which task is still open", () => {
  const browsing = () =>
    itemsOf([
      said("user", "날씨"),
      ...calls({
        name: "computer_navigate",
        args: { url: "https://weather.example" },
        result: { ok: true },
      }),
    ]);

  test("the last thing in a running turn, and nothing once the turn is over", () => {
    expect(openBrowsingTask(browsing(), true)?.kind).toBe("browse");
    expect(openBrowsingTask(browsing(), false)).toBeNull();
  });

  test("anything after it means the Bot moved on", () => {
    const items = [...browsing(), ...itemsOf([said("assistant", "맑아요")])];
    expect(openBrowsingTask(items, true)).toBeNull();
  });
});

const step = (
  name: string,
  args: Record<string, unknown> = {},
  result?: unknown,
): BrowsingStep => ({
  id: id("step"),
  name,
  args: JSON.stringify(args),
  ...(result === undefined ? {} : { result: JSON.stringify(result) }),
});

describe("what the card and the banner say", () => {
  test("the sites are where the pages ended up, once each, without www", () => {
    expect(
      sitesOf([
        step(
          "computer_navigate",
          { url: "https://naver.com" },
          { ok: true, url: "https://www.naver.com/" },
        ),
        step("computer_click", { ref: "e1" }, { ok: true }),
        step(
          "computer_navigate",
          { url: "https://weather.naver.com/today" },
          { ok: true, url: "https://weather.naver.com/today" },
        ),
        step("computer_navigate", { url: "https://naver.com/again" }),
      ]),
    ).toEqual(["naver.com", "weather.naver.com"]);
  });

  test("a line never carries what was typed, only where it went", () => {
    const line = stepLine(
      step(
        "computer_type",
        { ref: "e7", text: "hunter2-비밀번호", snapshotId: 3 },
        { ok: true, element: { role: "textbox", name: "비밀번호" } },
      ),
    );
    expect(JSON.stringify(line)).not.toContain("hunter2");
    expect(line.detail).toBe("비밀번호");
  });

  test("the banner says the step that is running, or that the Bot is deciding", () => {
    const running = [
      step("computer_navigate", { url: "https://weather.naver.com" }),
    ];
    expect(doingNow(running)).toContain("weather.naver.com");
    const between = [
      step("computer_navigate", { url: "https://a.example" }, { ok: true }),
    ];
    expect(doingNow(between)).not.toContain("a.example");
    expect(doingNow(between)).toBeTruthy();
  });

  test("how a task ended is read from its last step", () => {
    const done = [step("computer_navigate", {}, { ok: true })];
    expect(endingOf(done, true)).toBe("running");
    expect(endingOf(done, false)).toBe("done");
    expect(
      endingOf(
        [step("computer_click", {}, { ok: false, stopped: true })],
        false,
      ),
    ).toBe("stopped");
    expect(
      endingOf(
        [step("computer_click", {}, { ok: false, refused: true })],
        false,
      ),
    ).toBe("blocked");
    // A call the run never answered: the person stopped it mid-action.
    expect(endingOf([step("computer_click")], false)).toBe("stopped");
  });

  test("the picture goes on the last call that has a result", () => {
    const answered = step("computer_navigate", {}, { ok: true });
    expect(pictureStepOf([answered, step("computer_click")])).toBe(answered.id);
    expect(pictureStepOf([step("computer_click")])).toBeNull();
  });
});

describe("what the rest of the screen hears", () => {
  const task = {
    botId: "bot-1",
    taskId: "call-1",
    sites: ["naver.com"],
    doing: "페이지 읽는 중",
  };

  test("in use while a task is open, and for a moment after it ends", async () => {
    publishOpenTask(task);
    expect(isInUse(readBrowsingNow(), "bot-1")).toBe(true);
    publishOpenTask(null);
    // Not off the instant it ends: the header's mark would blink between a step and the reply.
    expect(isInUse(readBrowsingNow(), "bot-1")).toBe(true);
    await Bun.sleep(LINGER_MS + 100);
    expect(isInUse(readBrowsingNow(), "bot-1")).toBe(false);
  });

  test("a banner put away stays away for that task only", () => {
    publishOpenTask(task);
    dismissTask("call-1");
    expect(readBrowsingNow().dismissed.has("call-1")).toBe(true);
    publishOpenTask({ ...task, taskId: "call-2" });
    expect(readBrowsingNow().dismissed.has("call-2")).toBe(false);
  });

  test("a page found gone is forgotten when the Bot starts another task", () => {
    markPageGone("bot-1");
    expect(readBrowsingNow().pageGoneFor).toBe("bot-1");
    publishOpenTask(task);
    expect(readBrowsingNow().pageGoneFor).toBeNull();
  });

  test("the same task said twice is not news", () => {
    publishOpenTask(task);
    const first = readBrowsingNow();
    publishOpenTask({ ...task, sites: [...task.sites] });
    expect(readBrowsingNow()).toBe(first);
  });
});

describe("skipping a request for help", () => {
  test("answers that one request, once", () => {
    skipHelp("call-help");
    expect(takeSkip("call-other")).toBe(false);
    expect(takeSkip("call-help")).toBe(true);
    expect(takeSkip("call-help")).toBe(false);
    expect(takeSkip(undefined)).toBe(false);
  });
});
