import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { SITE_REFUSED, UNANSWERED_RESULT } from "@shared/task-ending";
import { siteNameOf } from "@/components/computer/task-title";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import {
  cutOffOf,
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

  /*
   * MEASURED 2026-09-24 (UI/UX audit, item 1): the model this deployment runs says a line before
   * nearly every call, and each line used to cut the task — ten cards for one 바로구매 on 예스24.
   * Captured the same day on this stack: "서울, 부산, 제주 날씨" drew two cards with the Bot's
   * "서울 확인 완료, 제주 확인 완료. 부산 결과가 잘려서 다시 열어…" between them.
   */
  test("one turn is one card: what the Bot says between its calls goes inside it", () => {
    const items = itemsOf([
      said("user", "서울, 부산 날씨 알려줘"),
      said("assistant", "서울부터 열어 볼게요."),
      ...calls({
        name: "computer_navigate",
        args: { url: "https://search.naver.com/?query=서울날씨" },
        result: { ok: true },
      }),
      said("assistant", "서울 확인했어요. 부산으로 갈게요."),
      ...calls({
        name: "computer_navigate",
        args: { url: "https://search.naver.com/?query=부산날씨" },
        result: { ok: true },
      }),
      ...calls({ name: "computer_read", result: { ok: true } }),
      said("assistant", "부산은 맑아요."),
      ...calls({ name: "computer_snapshot", result: { ok: true } }),
      said("assistant", "서울 22도, 부산 24도예요."),
    ]);
    // The question, the first sentence, ONE card, the answer.
    expect(items.map((item) => item.kind)).toEqual([
      "text",
      "text",
      "browse",
      "text",
    ]);
    const task = items[2];
    if (task?.kind !== "browse") throw new Error("no card");
    expect(task.steps).toHaveLength(4);
    expect(task.asked).toBe("서울, 부산 날씨 알려줘");
    // Each line kept, and kept where it was said: before the second step, and before the fourth.
    expect(task.notes.map((note) => [note.text, note.after])).toEqual([
      ["서울 확인했어요. 부산으로 갈게요.", 1],
      ["부산은 맑아요.", 3],
    ]);
    expect(items.at(-1)).toMatchObject({ text: "서울 22도, 부산 24도예요." });
  });

  test("a sentence after the card stays a bubble until another call claims it", () => {
    const first = [
      said("user", "날씨"),
      ...calls({
        name: "computer_navigate",
        args: { url: "https://a.example" },
        result: { ok: true },
      }),
      said("assistant", "첫 페이지를 봤어요. 다음으로 갈게요."),
    ];
    // Until the next call it may be the answer, and the answer is a bubble.
    expect(itemsOf(first).map((item) => item.kind)).toEqual([
      "text",
      "browse",
      "text",
    ]);
    const later = itemsOf([
      ...first,
      ...calls({
        name: "computer_navigate",
        args: { url: "https://b.example" },
        result: { ok: true },
      }),
    ]);
    expect(later.map((item) => item.kind)).toEqual(["text", "browse"]);
    // And the card is the same card: its identity, its key and its place do not move.
    expect(later[1]?.id).toBe(itemsOf(first)[1]?.id);
  });

  test("the person's next message is a new turn, and a new card", () => {
    const items = itemsOf([
      said("user", "예스24에서 소년이 온다 찾아줘"),
      ...calls({
        name: "computer_navigate",
        args: { url: "https://yes24.com" },
        result: { ok: true },
      }),
      said("assistant", "찾았어요."),
      said("user", "가격도 봐 줘"),
      ...calls({ name: "computer_read", result: { ok: true } }),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "text",
      "browse",
      "text",
      "text",
      "browse",
    ]);
    const second = items[4];
    expect(second?.kind === "browse" ? second.asked : null).toBe(
      "가격도 봐 줘",
    );
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

  test("the Bot's own words after it keep it open, so the banner does not blink at every line", () => {
    const items = itemsOf([
      said("user", "날씨"),
      ...calls({
        name: "computer_navigate",
        args: { url: "https://weather.example" },
        result: { ok: true },
      }),
      said("assistant", "읽어 볼게요"),
    ]);
    expect(openBrowsingTask(items, true)?.kind).toBe("browse");
    expect(openBrowsingTask(items, false)).toBeNull();
  });

  test("a request for a person after it means the Bot moved on", () => {
    const items = itemsOf([
      said("user", "로그인해서 봐 줘"),
      ...calls(
        {
          name: "computer_navigate",
          args: { url: "https://nid.naver.com/login" },
          result: { ok: true },
        },
        { name: "computer_request_help", args: { reason: "로그인해 주세요" } },
      ),
    ]);
    expect(openBrowsingTask(items, true)).toBeNull();
  });
});

/*
 * MEASURED 2026-09-25 (0.5.4 final QA): Stop pressed while the Bot was thinking between two steps
 * left the card reading 끝남 — its last step had worked — while 오늘 read the ledger and said 멈춤.
 */
describe("a task its turn was cut off in", () => {
  const navigated = () =>
    calls({
      name: "computer_navigate",
      args: { url: "https://news.naver.com" },
      result: { ok: true },
    });

  test("is stopped when nothing came after it, and failed when the turn left a failure", () => {
    const items = itemsOf([said("user", "뉴스"), ...navigated()]);
    const card = items.findIndex((item) => item.kind === "browse");
    const quiet = { busy: false, failed: false };
    expect(cutOffOf(items, card, quiet)).toBe("stopped");
    expect(cutOffOf(items, card, { ...quiet, failed: true })).toBe("failed");
    const task = items[card];
    if (task?.kind !== "browse") throw new Error("no card");
    expect(endingOf(task.steps, false)).toEqual({ kind: "done" });
    expect(endingOf(task.steps, false, "stopped")).toEqual({ kind: "stopped" });
    expect(endingOf(task.steps, false, "failed")).toEqual({
      kind: "failed",
      code: null,
    });
  });

  test("is cut off when the person's next message came straight after it", () => {
    const items = itemsOf([
      said("user", "뉴스"),
      ...navigated(),
      said("user", "멈추고 이걸로: 날씨"),
    ]);
    const card = items.findIndex((item) => item.kind === "browse");
    expect(cutOffOf(items, card, { busy: false, failed: false })).toBe(
      "stopped",
    );
  });

  test("is not, once the Bot said what it came to, nor while the turn is running", () => {
    const answered = itemsOf([
      said("user", "뉴스"),
      ...navigated(),
      said("assistant", "기사 세 개예요."),
    ]);
    const card = answered.findIndex((item) => item.kind === "browse");
    expect(cutOffOf(answered, card, { busy: false, failed: false })).toBeNull();
    const running = itemsOf([said("user", "뉴스"), ...navigated()]);
    expect(
      cutOffOf(
        running,
        running.findIndex((item) => item.kind === "browse"),
        { busy: true, failed: false },
      ),
    ).toBeNull();
  });

  test("a step that failed keeps its own ending", () => {
    const task = step(
      "computer_navigate",
      { url: "https://x.example" },
      {
        ok: false,
        code: "laf:navigation_failed",
      },
    );
    expect(endingOf([task], false, "stopped")).toEqual({
      kind: "failed",
      code: "laf:navigation_failed",
    });
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
    // The site as people call it, like the card title — not the host (0.5.3 audit, item 13).
    expect(doingNow(running)).toContain(siteNameOf("weather.naver.com"));
    expect(doingNow(running)).not.toContain("weather.naver.com");
    const between = [
      step("computer_navigate", { url: "https://a.example" }, { ok: true }),
    ];
    expect(doingNow(between)).not.toContain("a.example");
    expect(doingNow(between)).toBeTruthy();
  });

  test("how a task ended is read from its last step", () => {
    const done = [step("computer_navigate", {}, { ok: true })];
    expect(endingOf(done, true)).toEqual({ kind: "running" });
    expect(endingOf(done, false)).toEqual({ kind: "done" });
    expect(
      endingOf(
        [step("computer_click", {}, { ok: false, stopped: true })],
        false,
      ),
    ).toEqual({ kind: "stopped" });
    // A refusal, and the browser being down, are 못 끝냄 with why — never the owner's 멈춤.
    expect(
      endingOf(
        [
          step(
            "computer_click",
            {},
            { ok: false, refused: true, code: "laf:person_declined" },
          ),
        ],
        false,
      ),
    ).toEqual({ kind: "failed", code: "laf:person_declined" });
    expect(
      endingOf(
        [
          step(
            "computer_navigate",
            {},
            { ok: false, code: "laf:computer_unreachable" },
          ),
        ],
        false,
      ),
    ).toEqual({ kind: "failed", code: "laf:computer_unreachable" });
    // A call the run never answered: the person stopped it mid-action.
    expect(endingOf([step("computer_click")], false)).toEqual({
      kind: "stopped",
    });
  });

  test("a reload cannot turn 멈춤 into 끝남: the placeholder answer is the same stop", () => {
    // UX review 0.5.4, item 2: 멈춤 in one load and 끝남 in the next, for a task that never got its
    // answer. Before the next turn the app answers the call with a placeholder; it is still a stop.
    const unanswered = step("computer_click");
    const repaired: BrowsingStep = {
      ...unanswered,
      result: UNANSWERED_RESULT,
    };
    expect(endingOf([unanswered], false)).toEqual({ kind: "stopped" });
    expect(endingOf([repaired], false)).toEqual({ kind: "stopped" });
    const [placeholder] = repairUnansweredToolCalls([
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: unanswered.id,
            type: "function",
            function: { name: "computer_click", arguments: "{}" },
          },
        ],
      },
    ] as Message[]).slice(1);
    expect(
      endingOf(
        [
          {
            ...unanswered,
            result: (placeholder as { content: string }).content,
          },
        ],
        false,
      ),
    ).toEqual({ kind: "stopped" });
  });

  test("a site that answered with a refusal page is 못 끝냄, until the Bot lands somewhere else", () => {
    // Coupang's "Access Denied" was a navigation that worked, and the card said 끝남.
    const refused = step(
      "computer_navigate",
      { url: "https://www.coupang.com" },
      { ok: true, url: "https://www.coupang.com", httpStatus: 403 },
    );
    const readIt = step("computer_snapshot", {}, { ok: true, count: 0 });
    expect(endingOf([refused, readIt], false)).toEqual({
      kind: "failed",
      code: SITE_REFUSED,
    });
    const elsewhere = step(
      "computer_navigate",
      { url: "https://www.naver.com" },
      { ok: true, url: "https://www.naver.com" },
    );
    expect(endingOf([refused, readIt, elsewhere], false)).toEqual({
      kind: "done",
    });
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
