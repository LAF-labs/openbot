import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { TOOL_RESULT_KO } from "@shared/prompt/tool-results.ko";
import { UNANSWERED_RESULT } from "@shared/task-ending";
import {
  stepDidNotWork,
  TOOL_NOT_ALLOWED,
  toolErrorText,
  toolFailureText,
} from "@shared/tools/step-result";
import { withheldMark } from "@shared/tools/withheld";
import {
  isFoldableStep,
  openStepRuns,
  rowsOfStepRun,
  stepRunsOf,
  toVisibleChatItems,
  withBrowsingTasks,
} from "../src/components/channels/chat-messages";
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
 * STEP LINES, ONE TO A RUN.
 *
 * Measured on a trial deployment, 2026-10-03 (the owner's screenshot): "내 지메일에 비즈니스메일 온
 * 거 있나 보고 알려줘" left five grey lines stacked above the answer — 도구 찾는 중, 메일 찾기 ·
 * 지메일 twice, 메일 읽기 · 지메일 twice — a row each. The owner's rule: one line that shows the
 * newest, and the whole record when it is opened.
 *
 * The projection first (which lines are a run), then the conversation people use, mounted, with the
 * server's own history and a turn that is still going.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const ASKED: Message = {
  id: "q-asked",
  role: "user",
  content: "내 메일에 온 것 있나 보고 알려줘",
};
/** A connected service's tool this app has no words for: its line reads "Used a connected service". */
const SERVICE_TOOL = "mcp__orders__look_up";
const called = (id: string, name = SERVICE_TOOL): Message =>
  ({
    id: `a-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: `call-${id}`,
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  }) as Message;
const answered = (id: string, content = "ok"): Message =>
  ({
    id: `t-${id}`,
    role: "tool",
    toolCallId: `call-${id}`,
    content,
  }) as Message;
/** A mail's text as the Bot was given it: the one-time code taken out, a mark where it was. */
const MAIL_WITH_A_CODE = `제목: 인증번호 안내\n인증번호: ${withheldMark("code", "Ab12Cd34Ef56")}`;
const said = (id: string, text: string): Message => ({
  id,
  role: "assistant",
  content: text,
});
/** A step and its result, as the record holds a finished one. */
const done = (id: string, name?: string): Message[] => [
  called(id, name),
  answered(id),
];

const placesOf = (messages: Message[]) => {
  const items = withBrowsingTasks(toVisibleChatItems(messages));
  return [...stepRunsOf(items)].map(([index, place]) => [
    items[index]?.id,
    place.runId,
    place.size,
    place.isNewest,
  ]);
};

describe("which lines are a run", () => {
  test("a connected service's tool and the Bot's two ways to a tool; nothing that draws a card", () => {
    for (const name of [
      "mcp__gmail__search_messages",
      "mcp__web-search__search",
      "tool_search",
      "tool_call",
    ]) {
      expect([name, isFoldableStep(name)]).toEqual([name, true]);
    }
    for (const name of [
      "askChoice",
      "now",
      "remember",
      "computer_navigate",
      "look_up_orders",
    ]) {
      expect([name, isFoldableStep(name)]).toEqual([name, false]);
    }
  });

  test("two or more lines with nothing between them are one run, named by its first", () => {
    expect(
      placesOf([
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("3"),
        said("a", "한 통 와 있어요."),
      ]),
    ).toEqual([
      ["call-1", "call-1", 3, false],
      ["call-2", "call-1", 3, false],
      ["call-3", "call-1", 3, true],
    ]);
  });

  test("a line alone is not a run, and a run still going ends at the step that is out", () => {
    expect(placesOf([ASKED, ...done("1"), said("a", "없어요.")])).toEqual([]);
    expect(placesOf([ASKED, ...done("1"), called("2")])).toEqual([
      ["call-1", "call-1", 2, false],
      ["call-2", "call-1", 2, true],
    ]);
  });

  /*
   * WHAT A PERSON IS WAITED ON FOR IS NEVER BEHIND A FOLD. A boundary's question is drawn on the
   * line of the call that raised it, and the 보기 for a mail's one-time code on the line of the call
   * that read the mail. A model may ask for two calls in one breath, and reads on after a mail — so
   * neither line need be the newest, and folded, its card or its button would be drawn nowhere.
   */
  test("a step still out and a step holding something for the person each end their run, drawn", () => {
    // Two calls in one breath, the first perhaps waiting on its answer: both lines stay.
    expect(placesOf([ASKED, called("1"), called("2")])).toEqual([]);
    expect(placesOf([ASKED, ...done("1"), called("2"), called("3")])).toEqual([
      ["call-1", "call-1", 2, false],
      ["call-2", "call-1", 2, true],
    ]);
    // The mail the code was in, read second of four: its line is the newest of the first run.
    expect(
      placesOf([
        ASKED,
        ...done("1"),
        called("2"),
        answered("2", MAIL_WITH_A_CODE),
        ...done("3"),
        ...done("4"),
      ]),
    ).toEqual([
      ["call-1", "call-1", 2, false],
      ["call-2", "call-1", 2, true],
      ["call-3", "call-3", 2, false],
      ["call-4", "call-3", 2, true],
    ]);
    // Text that only looks like the start of a mark is an ordinary result.
    expect(
      placesOf([
        ASKED,
        called("1"),
        answered("1", "[[withheld:nothing]] 라고 적힌 메일"),
        ...done("2"),
      ]),
    ).toEqual([
      ["call-1", "call-1", 2, false],
      ["call-2", "call-1", 2, true],
    ]);
  });

  /*
   * A STEP THAT DID NOT WORK IS SOMETHING FOR THE PERSON TOO (review, round 2). Its result is the
   * text the model was told, and nothing beside it says how it ended — so the forms a failure is
   * written in are read back: the service's own error, this server's answer in the service's
   * place, an object of ours that says no.
   */
  test("a step that did not work ends its run, drawn, in every form a failure is written in", () => {
    const failures = [
      toolErrorText("quota exceeded"),
      TOOL_NOT_ALLOWED,
      UNANSWERED_RESULT,
      TOOL_RESULT_KO["laf:person_declined"] as string,
      TOOL_RESULT_KO["laf:stopped"] as string,
      JSON.stringify({ ok: false, code: "laf:tool_unknown", reason: "…" }),
      JSON.stringify({ refused: true }),
      "Error: the handler threw",
    ];
    for (const result of failures) {
      expect([result.slice(0, 40), stepDidNotWork(result)]).toEqual([
        result.slice(0, 40),
        true,
      ]);
      // Second of four: the newest of the first run, and the two after it are a run of their own.
      expect(
        placesOf([
          ASKED,
          ...done("1"),
          called("2"),
          answered("2", result),
          ...done("3"),
          ...done("4"),
        ]).map(([id, , , isNewest]) => [id, isNewest]),
      ).toEqual([
        ["call-1", false],
        ["call-2", true],
        ["call-3", false],
        ["call-4", true],
      ]);
    }
    // Every sentence the server answers with in a service's place is one of them.
    for (const [code, sentence] of Object.entries(TOOL_RESULT_KO)) {
      expect([code, stepDidNotWork(sentence)]).toEqual([code, true]);
    }
    // A service's own answer is not: prose, a list, an object that says it went well — and one too
    // long to be an object of ours is not read to find out.
    for (const result of [
      "ok",
      "메일 2통을 찾았어요.",
      JSON.stringify({ ok: true, items: [] }),
      JSON.stringify([{ id: 1 }]),
      `${TOOL_RESULT_KO["laf:stopped"]} 라고 적힌 메일`,
      JSON.stringify({ ok: false, pad: "x".repeat(5000) }),
    ]) {
      expect([result.slice(0, 40), stepDidNotWork(result)]).toEqual([
        result.slice(0, 40),
        false,
      ]);
    }
  });

  /*
   * AND EVERY WAY A CALL IS NOT CARRIED OUT IS WRITTEN IN ONE OF THOSE FORMS (review, round 3). The
   * window's own handler answered with the reason as it came: a 403 that carries no fact is
   * whatever sentence the route wrote, or this app's own fallback in the reader's language — a
   * refusal that read back as the service's answer.
   */
  test("a reason that does not say so itself is wrapped in a form that does, and one that does is left alone", () => {
    const sentence = TOOL_RESULT_KO["laf:policy_denied"] as string;
    expect(toolFailureText({ refused: true, reason: sentence })).toBe(sentence);
    expect(toolFailureText({ refused: true, reason: TOOL_NOT_ALLOWED })).toBe(
      TOOL_NOT_ALLOWED,
    );
    for (const failure of [
      {
        refused: true,
        reason: "You have not connected your Google Sheets account",
      },
      { refused: true, reason: "이 도구는 여기서 쓸 수 없어요." },
      { refused: false, reason: "The server did not answer." },
      { refused: false, reason: "" },
    ]) {
      const written = toolFailureText(failure);
      expect([failure.reason, stepDidNotWork(written)]).toEqual([
        failure.reason,
        true,
      ]);
      // The model is told the same reason, and whether it was a refusal.
      expect(JSON.parse(written)).toEqual({ ok: false, ...failure });
      expect(
        placesOf([
          ASKED,
          called("1"),
          answered("1", written),
          ...done("2"),
          ...done("3"),
        ]).map(([id]) => id),
      ).toEqual(["call-2", "call-3"]);
    }
    // A fact the table has no sentence for is handed over as itself, and is one too.
    expect(stepDidNotWork("laf:some_new_fact")).toBe(true);
    expect(stepDidNotWork("laf: 로 시작하는 메일 제목")).toBe(false);
  });

  /*
   * A RUN IS OPEN WHILE IT HOLDS A ROW IT WAS OPENED BY. Named by its first line, a run keeps its
   * name while it grows at its end. It gets a new one when the page above arrives with the earlier
   * steps of the same run, and one remembered by name would fold shut in front of its reader.
   */
  test("an open run stays open as it grows, at its end and at its head", () => {
    const openOf = (messages: Message[], opened: string[]) => {
      const items = withBrowsingTasks(toVisibleChatItems(messages));
      const runs = stepRunsOf(items);
      const open = [...openStepRuns(items, runs, new Set(opened))];
      return open.map((runId) => [runId, rowsOfStepRun(items, runs, runId)]);
    };
    const newestPage = [...done("3"), ...done("4")];
    expect(openOf([ASKED, ...newestPage], [])).toEqual([]);
    expect(openOf([ASKED, ...newestPage], ["call-3"])).toEqual([
      ["call-3", ["call-3", "call-4"]],
    ]);
    // A step more at its end: the same run, by the same name.
    expect(openOf([ASKED, ...newestPage, called("5")], ["call-3"])).toEqual([
      ["call-3", ["call-3", "call-4", "call-5"]],
    ]);
    // The page above arrives: the same run under a new name, open by the row it was opened by.
    expect(
      openOf([ASKED, ...done("1"), ...done("2"), ...newestPage], ["call-3"]),
    ).toEqual([["call-1", ["call-1", "call-2", "call-3", "call-4"]]]);
    // A row of some other run opens nothing here, and a run nobody named has no rows.
    expect(openOf([ASKED, ...newestPage], ["call-9"])).toEqual([]);
    const items = withBrowsingTasks(toVisibleChatItems([ASKED, ...newestPage]));
    expect(rowsOfStepRun(items, stepRunsOf(items), "call-9")).toEqual([]);
  });

  test("the Bot's own sentence, a card and the person's next message each end a run", () => {
    expect(
      placesOf([
        ASKED,
        ...done("1"),
        ...done("2"),
        said("between", "두 통 더 볼게요."),
        ...done("3"),
        ...done("4"),
        ...done("card", "now"),
        ...done("5"),
        { id: "q-2", role: "user", content: "그럼 답장도 써 줘" },
        ...done("6"),
        ...done("7"),
      ]),
    ).toEqual([
      ["call-1", "call-1", 2, false],
      ["call-2", "call-1", 2, true],
      ["call-3", "call-3", 2, false],
      ["call-4", "call-3", 2, true],
      ["call-6", "call-6", 2, false],
      ["call-7", "call-6", 2, true],
    ]);
  });
});

const log = (host: HTMLElement) => host.querySelector('[role="log"]');
/** How many step lines of the stand-in tool the transcript is drawing. */
const linesDrawn = (host: HTMLElement) =>
  (log(host)?.textContent ?? "").split("Used a connected service").length - 1;
const folds = (host: HTMLElement) => [
  ...(log(host)?.querySelectorAll<HTMLButtonElement>("button[aria-expanded]") ??
    []),
];
const fold = (host: HTMLElement) => folds(host)[0] ?? null;

async function conversation(channelId: string, history: Message[]) {
  const server = turnServer({ channelId, history });
  const view = await mountApp({
    path: `/channel/${channelId}`,
    api: server.api,
  });
  await view.waitFor(
    () => log(view.host)?.textContent?.includes(String(ASKED.content)) === true,
    "the conversation",
    8000,
  );
  return { server, view };
}

describe("a finished conversation with a run of steps", () => {
  test("draws the newest line and a fold for the rest; opened, the whole record; closed again, one", async () => {
    const { server, view } = await conversation("channel_fold-record", [
      ASKED,
      ...done("1"),
      ...done("2"),
      ...done("3"),
      ...done("4"),
      said("a-answer", "비즈니스 메일 한 통 와 있어요."),
    ]);
    await view.waitFor(() => fold(view.host) !== null, "the fold", 4000);
    expect(linesDrawn(view.host)).toBe(1);
    expect(fold(view.host)?.textContent).toBe("3 earlier steps");
    expect(fold(view.host)?.getAttribute("aria-expanded")).toBe("false");

    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => linesDrawn(view.host) === 4, "every line", 4000);
    expect(fold(view.host)?.textContent).toBe("Hide earlier steps");
    expect(fold(view.host)?.getAttribute("aria-expanded")).toBe("true");

    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => linesDrawn(view.host) === 1, "one line", 4000);
    // The answer is where it was throughout.
    expect(log(view.host)?.textContent).toContain(
      "비즈니스 메일 한 통 와 있어요.",
    );
    server.close();
    await view.unmount();
  });

  test("leaves a line alone as it was, and lines the Bot spoke between as two", async () => {
    const { server, view } = await conversation("channel_fold-alone", [
      ASKED,
      ...done("1"),
      said("a-between", "한 통 더 볼게요."),
      ...done("2"),
      said("a-answer", "두 통 와 있어요."),
    ]);
    await view.waitFor(() => linesDrawn(view.host) === 2, "both lines", 4000);
    expect(fold(view.host)).toBeNull();
    server.close();
    await view.unmount();
  });
});

/** Rows of talk after a run, enough to put the run at the top of the drawn window. */
const talk = (pairs: number): Message[] =>
  Array.from({ length: pairs }, (_, at) => [
    { id: `q-later-${at}`, role: "user", content: `질문 ${at}` } as Message,
    said(`a-later-${at}`, `답 ${at}`),
  ]).flat();
const rowsDrawn = (host: HTMLElement) =>
  [
    ...(log(host)?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
  ].map((row) => row.dataset.messageId);

describe("a run at the edge of what is drawn", () => {
  /*
   * THE WINDOW IS FORTY ROWS, COUNTED OVER EVERY ROW — the folded ones too. Cut inside a run, the
   * fold read 이전 5단계 and opening it drew the two the window held, under a button that said the
   * record was open (review, round 1).
   */
  test("is whole: a window that would begin inside a run begins at its first line", async () => {
    const history = [
      ASKED,
      ...done("1"),
      ...done("2"),
      ...done("3"),
      ...done("4"),
      ...done("5"),
      ...done("6"),
      said("a-answer", "여섯 번 찾아봤어요."),
      // Forty-four rows in all: the newest forty begin at the fourth step.
      ...talk(18),
    ];
    const channelId = "channel_fold-window";
    const server = turnServer({ channelId, history });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    // The question the run answers is above the window; the newest row is what says it arrived.
    await view.waitFor(
      () => log(view.host)?.textContent?.includes("답 17") === true,
      "the conversation",
      8000,
    );
    await view.waitFor(() => fold(view.host) !== null, "the fold", 4000);
    expect(fold(view.host)?.textContent).toBe("5 earlier steps");
    expect(rowsDrawn(view.host)[0]).toBe("call-6");

    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => linesDrawn(view.host) === 6, "every line", 4000);
    expect(rowsDrawn(view.host).slice(0, 7)).toEqual([
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "call-5",
      "call-6",
      "a-answer",
    ]);
    server.close();
    await view.unmount();
  });

  test("stays open when the page above arrives with the steps before it", async () => {
    const channelId = "channel_fold-page";
    const history = [
      ASKED,
      ...done("1"),
      ...done("2"),
      ...done("3"),
      ...done("4"),
      said("a-answer", "네 번 찾아봤어요."),
    ];
    // A page of five messages: the newest holds the last two steps and the answer.
    const server = turnServer({ channelId, history, historyPage: 5 });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(() => fold(view.host) !== null, "the fold", 8000);
    expect(fold(view.host)?.textContent).toBe("1 earlier steps");
    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => linesDrawn(view.host) === 2, "both lines", 4000);

    const earlier = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Show earlier messages",
    );
    await view.click(earlier as HTMLButtonElement);
    // The window was pinned to the row it began at, the third step: now inside the run, so it
    // begins at the run's first line, and the run is open by the row it was opened by.
    await view.waitFor(() => linesDrawn(view.host) === 4, "all four", 8000);
    expect(fold(view.host)?.getAttribute("aria-expanded")).toBe("true");
    expect(fold(view.host)?.textContent).toBe("Hide earlier steps");
    expect(rowsDrawn(view.host)).toEqual([
      "call-1",
      "call-2",
      "call-3",
      "call-4",
      "a-answer",
    ]);
    // Closed by any row of it: one line again, and the count is the whole run's.
    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => linesDrawn(view.host) === 1, "one line", 4000);
    expect(fold(view.host)?.textContent).toBe("3 earlier steps");
    server.close();
    await view.unmount();
  });
});

describe("a line with something on it for the person", () => {
  test("stays drawn with steps after it: the mail a code was in, and the newest, a fold beside each", async () => {
    const { server, view } = await conversation("channel_fold-code", [
      ASKED,
      ...done("1"),
      called("2"),
      answered("2", MAIL_WITH_A_CODE),
      ...done("3"),
      ...done("4"),
      said("a-answer", "인증번호가 온 메일이 있어요."),
    ]);
    await view.waitFor(() => folds(view.host).length === 2, "two folds", 4000);
    expect(linesDrawn(view.host)).toBe(2);
    expect(folds(view.host).map((button) => button.textContent)).toEqual([
      "1 earlier steps",
      "1 earlier steps",
    ]);
    // The row of the call that read the mail is in the document, where its 보기 is drawn.
    expect(
      log(view.host)?.querySelector('[data-message-id="call-2"]'),
    ).not.toBeNull();
    expect(
      log(view.host)?.querySelector('[data-message-id="call-1"]'),
    ).toBeNull();
    server.close();
    await view.unmount();
  });

  test("stays drawn when it did not work: the step a service refused, with the ones after it folded behind their own", async () => {
    const { server, view } = await conversation("channel_fold-failed", [
      ASKED,
      ...done("1"),
      called("2"),
      answered("2", toolErrorText("quota exceeded")),
      ...done("3"),
      ...done("4"),
      said("a-answer", "두 번째는 안 됐어요."),
    ]);
    await view.waitFor(() => folds(view.host).length === 2, "two folds", 4000);
    expect(rowsDrawn(view.host).slice(1, 3)).toEqual(["call-2", "call-4"]);
    expect(linesDrawn(view.host)).toBe(2);
    server.close();
    await view.unmount();
  });

  test("a row another screen sends the person to is opened to, and stays open", async () => {
    const channelId = "channel_fold-jump";
    const { server, view } = await conversation(channelId, [
      ASKED,
      ...done("1"),
      ...done("2"),
      ...done("3"),
      said("a-answer", "세 번 찾아봤어요."),
    ]);
    await view.waitFor(() => fold(view.host) !== null, "the fold", 4000);
    expect(linesDrawn(view.host)).toBe(1);

    const { requestJump } = await import("../src/lib/channels/jump");
    await acted(() => requestJump({ channelId, messageId: "call-1" }));
    await view.waitFor(() => linesDrawn(view.host) === 3, "every line", 4000);
    await view.waitFor(
      () =>
        log(view.host)
          ?.querySelector('[data-message-id="call-1"]')
          ?.getAttribute("data-jumped") === "true",
      "the row marked",
      4000,
    );
    expect(fold(view.host)?.getAttribute("aria-expanded")).toBe("true");
    server.close();
    await view.unmount();
  });
});

describe("a turn that is still going", () => {
  test("shows the step that is out, with the ones before it behind the fold as they pile up", async () => {
    const channelId = "channel_fold-going";
    const server = turnServer({
      channelId,
      history: [ASKED],
      turn: { id: "turn-0", status: "running", asked: [ASKED.id] },
      turnMessages: [ASKED],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () =>
        log(view.host)?.textContent?.includes(String(ASKED.content)) === true,
      "the question the turn is for",
      8000,
    );
    const writes = (messages: Message[]) => acted(() => server.say(messages));

    await writes([called("1")]);
    await view.waitFor(() => linesDrawn(view.host) === 1, "the first step");
    expect(fold(view.host)).toBeNull();

    await writes([...done("1"), called("2")]);
    await view.waitFor(() => fold(view.host) !== null, "the fold", 4000);
    expect(linesDrawn(view.host)).toBe(1);
    expect(fold(view.host)?.textContent).toBe("1 earlier steps");

    // Opened mid-task, it stays open as the run grows: the run is named by its first line.
    await view.click(fold(view.host) as HTMLButtonElement);
    await view.waitFor(() => linesDrawn(view.host) === 2, "both lines", 4000);
    await writes([...done("1"), ...done("2"), called("3")]);
    await view.waitFor(() => linesDrawn(view.host) === 3, "all three", 4000);
    expect(fold(view.host)?.getAttribute("aria-expanded")).toBe("true");

    server.close();
    await view.unmount();
  });
});
