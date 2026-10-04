import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import { TOOL_RESULT_KO } from "@shared/prompt/tool-results.ko";
import { UNANSWERED_RESULT } from "@shared/task-ending";
import {
  stepDidNotWork,
  TOOL_NOT_ALLOWED,
  toolErrorText,
  toolFailureText,
} from "@shared/tools/step-result";
import {
  openStepRuns,
  stepRunsOf,
  stepsByAnswer,
  toVisibleChatItems,
  wholeFrom,
  withBrowsingTasks,
} from "../src/components/channels/chat-messages";
import { isFoldableStep } from "../src/components/channels/row-kinds";
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
  ASKED,
  answered,
  asked,
  called,
  done,
  MAIL_WITH_A_CODE,
  SERVICE_TOOL,
  said,
} from "./support/step-fixtures";
import type { Entry, Seen, StepsShown } from "./support/steps-render";
import {
  acted,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * STEPS OF WORK ARE NOT DRAWN IN THE CONVERSATION, AND THE ANSWER OPENS THE RECORD OF THEM.
 *
 * Measured on a trial deployment, 2026-10-03 (the owner's screenshot): "내 지메일에 비즈니스메일 온
 * 거 있나 보고 알려줘" left five grey lines stacked above the answer — 도구 찾는 중, 메일 찾기 ·
 * 지메일 twice, 메일 읽기 · 지메일 twice — a row each. They were folded to the newest, with a fold
 * beside it for the rest. The owner's word the next day was that the app still shows far too many
 * words, and the choice was "proposal A": a step is drawn while it is out, a finished turn is what
 * the Bot said, and the answer opens what was done for it — from an icon of its own at first, and
 * since the same day from the last row of the answer's "more" menu (`answer-more.tsx`), the second
 * of the two controls an answer has.
 *
 * The projection first (which rows are steps, which stay drawn, what each answer opens, where a
 * drawn window may begin), then the conversation people use, mounted, with the server's own
 * history and a turn that is still going.
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

const itemsOf = (messages: Message[]) =>
  withBrowsingTasks(toVisibleChatItems(messages));

/** Each step row: its id, the run it is in, and whether it is drawn while that run is closed. */
const placesOf = (messages: Message[]) => {
  const items = itemsOf(messages);
  return [...stepRunsOf(items)].map(([index, place]) => [
    items[index]?.id,
    place.runId,
    place.staysDrawn,
  ]);
};

/** What each answer opens, by the answer's id. */
const takenBy = (messages: Message[]) => {
  const items = itemsOf(messages);
  return Object.fromEntries(stepsByAnswer(items, stepRunsOf(items)));
};

describe("which rows are steps of work", () => {
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

  /*
   * A STEP ALONE IS A RUN TOO. While a run was two or more, a turn that took one step drew its line
   * as it always had — the one line the owner's screen had most of ("날씨 확인하기 · 기상청" above
   * every weather answer).
   */
  test("steps with nothing between them are one run, named by its first — and one alone is a run of one", () => {
    expect(
      placesOf([
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("3"),
        said("a", "한 통 와 있어요."),
      ]),
    ).toEqual([
      ["call-1", "call-1", false],
      ["call-2", "call-1", false],
      ["call-3", "call-1", false],
    ]);
    expect(placesOf([ASKED, ...done("1"), said("a", "없어요.")])).toEqual([
      ["call-1", "call-1", false],
    ]);
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
        asked("q-2", "그럼 답장도 써 줘"),
        ...done("6"),
        ...done("7"),
      ]).map(([id, runId]) => [id, runId]),
    ).toEqual([
      ["call-1", "call-1"],
      ["call-2", "call-1"],
      ["call-3", "call-3"],
      ["call-4", "call-3"],
      ["call-5", "call-5"],
      ["call-6", "call-6"],
      ["call-7", "call-6"],
    ]);
  });

  /*
   * WHAT A PERSON IS WAITED ON FOR IS DRAWN, WHOEVER OPENED WHAT. A step still out is the one line
   * of a turn at work, and a boundary's question is drawn on the line of the call that raised it;
   * the 보기 for a mail's one-time code is on the line of the call that read the mail. A model may
   * ask for two calls in one breath, and reads on after a mail — so neither need be the last step,
   * and not drawn, its card or its button would be drawn nowhere.
   */
  test("a step still out and a step holding something for the person stay drawn, in their run like any other", () => {
    // Two calls in one breath, the first perhaps waiting on its answer: both lines stay.
    expect(placesOf([ASKED, called("1"), called("2")])).toEqual([
      ["call-1", "call-1", true],
      ["call-2", "call-1", true],
    ]);
    // A turn at work: the step in hand, and nothing of the one before it.
    expect(placesOf([ASKED, ...done("1"), called("2")])).toEqual([
      ["call-1", "call-1", false],
      ["call-2", "call-1", true],
    ]);
    // The mail the code was in, read second of four: drawn, with the three around it put away.
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
      ["call-1", "call-1", false],
      ["call-2", "call-1", true],
      ["call-3", "call-1", false],
      ["call-4", "call-1", false],
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
      ["call-1", "call-1", false],
      ["call-2", "call-1", false],
    ]);
  });

  /*
   * A RUN IS OPEN WHILE IT HOLDS A ROW IT WAS OPENED BY. Named by its first row, a run keeps its
   * name while it grows at its end. It gets a new one when the page above arrives with the earlier
   * steps of the same run, and one remembered by name would close in front of its reader.
   */
  test("an open run stays open as it grows, at its end and at its head", () => {
    const openOf = (messages: Message[], opened: string[]) => {
      const items = itemsOf(messages);
      const runs = stepRunsOf(items);
      return [...openStepRuns(items, runs, new Set(opened))].map((runId) => [
        runId,
        [...runs]
          .filter(([, place]) => place.runId === runId)
          .map(([index]) => items[index]?.id),
      ]);
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
    // A row of some other run opens nothing here.
    expect(openOf([ASKED, ...newestPage], ["call-9"])).toEqual([]);
  });
});

describe("what an answer opens", () => {
  test("the first thing the Bot says after its steps takes them all, and what it says next takes none", () => {
    expect(
      takenBy([
        ASKED,
        ...done("1"),
        ...done("2"),
        said("a-answer", "두 통 와 있어요."),
        said("a-more", "답장도 써 드릴까요?"),
      ]),
    ).toEqual({
      "a-answer": { runIds: ["call-1"], rows: ["call-1", "call-2"], failed: 0 },
    });
    // Nothing done, nothing to open — and a card is not a step.
    expect(takenBy([ASKED, said("a-answer", "안녕하세요.")])).toEqual({});
    expect(
      takenBy([ASKED, ...done("card", "now"), said("a-answer", "세 시예요.")]),
    ).toEqual({});
  });

  /*
   * EVERY RUN SINCE THE BOT LAST SPOKE, WHATEVER WAS DRAWN BETWEEN THEM. A card ends a run — it is
   * drawn where it is, and the steps either side of it are not one stretch — but the answer was
   * written from all of them, and one control that opened half the record would be the fold that
   * read 이전 5단계 and drew two.
   */
  test("two runs with a card or a browsing task between them are one record, under the one answer", () => {
    expect(
      takenBy([
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("card", "now"),
        ...done("3"),
        ...done("page", "computer_navigate"),
        ...done("4"),
        said("a-answer", "다 봤어요."),
      ]),
    ).toEqual({
      "a-answer": {
        runIds: ["call-1", "call-3", "call-4"],
        rows: ["call-1", "call-2", "call-3", "call-4"],
        failed: 0,
      },
    });
  });

  test("a sentence between two stretches of work opens the one before it, and the answer the one after", () => {
    expect(
      takenBy([
        ASKED,
        ...done("1"),
        said("a-between", "두 통 더 볼게요."),
        ...done("2"),
        ...done("3"),
        said("a-answer", "세 통 와 있어요."),
      ]),
    ).toEqual({
      "a-between": { runIds: ["call-1"], rows: ["call-1"], failed: 0 },
      "a-answer": { runIds: ["call-2"], rows: ["call-2", "call-3"], failed: 0 },
    });
  });

  /*
   * A TURN THAT NEVER CAME TO AN ANSWER HAS NOTHING TO HANG ITS STEPS ON. They are not handed to
   * the next turn's answer, which was not written from them.
   */
  test("the person's next message drops what nothing took, and so does a turn still at work", () => {
    expect(
      takenBy([
        ASKED,
        ...done("1"),
        ...done("2"),
        asked("q-2", "아직이야?"),
        said("a-2", "지금 다시 볼게요."),
      ]),
    ).toEqual({});
    expect(takenBy([ASKED, ...done("1"), called("2")])).toEqual({});
  });

  test("a step that stays drawn is one of the steps the answer counts", () => {
    expect(
      takenBy([
        ASKED,
        ...done("1"),
        called("2"),
        answered("2", MAIL_WITH_A_CODE),
        ...done("3"),
        said("a-answer", "인증번호가 온 메일이 있어요."),
      ]),
    ).toEqual({
      "a-answer": {
        runIds: ["call-1"],
        rows: ["call-1", "call-2", "call-3"],
        failed: 0,
      },
    });
  });

  /*
   * NOTHING TO OPEN, NO CONTROL. One mail read, with a code in it, is on the screen already: a
   * button over it would be pressed and change nothing but its own name.
   */
  test("an answer whose every step is drawn anyway is given nothing to open", () => {
    expect(
      takenBy([
        ASKED,
        called("1"),
        answered("1", MAIL_WITH_A_CODE),
        said("a-answer", "인증번호가 온 메일이에요."),
      ]),
    ).toEqual({});
  });

  /*
   * A STEP THAT DID NOT WORK IS PUT AWAY LIKE ANY OTHER (the owner, 2026-10-04), AND COUNTED. Its
   * result is the text the model was told, and nothing beside it says how it ended — so the forms a
   * failure is written in are read back: the service's own error, this server's answer in the
   * service's place, an object of ours that says no. What the count is for is the control: where
   * one of the steps it opens did not work, it says so.
   */
  test("a step that did not work is not drawn either and is counted for its answer, in every form a failure is written in", () => {
    const failures = [
      toolErrorText("quota exceeded"),
      TOOL_NOT_ALLOWED,
      UNANSWERED_RESULT,
      TOOL_RESULT_KO["laf:person_declined"] as string,
      TOOL_RESULT_KO["laf:stopped"] as string,
      JSON.stringify({ ok: false, code: "laf:tool_unknown", reason: "…" }),
      // The window's own wrapper, and the server's "an approval is being asked".
      toolFailureText({ refused: true, reason: "A route's own sentence." }),
      JSON.stringify({ ok: false, awaitingApproval: true, approvalId: "a1" }),
      "Error: the handler threw",
    ];
    for (const result of failures) {
      expect([result.slice(0, 40), stepDidNotWork(result)]).toEqual([
        result.slice(0, 40),
        true,
      ]);
      // Second of four: not drawn, like the three that worked, and the answer is told of one.
      const turn = [
        ASKED,
        ...done("1"),
        called("2"),
        answered("2", result),
        ...done("3"),
        ...done("4"),
        said("a-answer", "두 번째는 안 됐어요."),
      ];
      expect(
        placesOf(turn).map(([id, , staysDrawn]) => [id, staysDrawn]),
      ).toEqual([
        ["call-1", false],
        ["call-2", false],
        ["call-3", false],
        ["call-4", false],
      ]);
      expect(takenBy(turn)).toEqual({
        "a-answer": {
          runIds: ["call-1"],
          rows: ["call-1", "call-2", "call-3", "call-4"],
          failed: 1,
        },
      });
      // The last step is counted like any other: none of them is drawn to say so itself.
      expect(
        takenBy([
          ASKED,
          ...done("1"),
          called("2"),
          answered("2", result),
          said("a-answer", "안 됐어요."),
        ])["a-answer"]?.failed,
      ).toBe(1);
    }
    // Every one that did not work, not whether one did.
    expect(
      takenBy([
        ASKED,
        called("1"),
        answered("1", TOOL_NOT_ALLOWED),
        ...done("2"),
        called("3"),
        answered("3", toolErrorText("quota exceeded")),
        said("a-answer", "둘은 안 됐어요."),
      ])["a-answer"]?.failed,
    ).toBe(2);
    // Every sentence the server answers with in a service's place is one of them.
    for (const [code, sentence] of Object.entries(TOOL_RESULT_KO)) {
      expect([code, stepDidNotWork(sentence)]).toEqual([code, true]);
    }
    /*
     * A service's own answer is not: prose, a list, an object that says it went well — and AN
     * OBJECT THAT SAYS IT DID NOT, where it is not one this app wrote. A status a service sends as
     * an ordinary answer was counted, and the line of that step, opened, said nothing had failed:
     * the count and the line are read by one function now (`stepFailureOf`; pull request 52).
     */
    for (const result of [
      "ok",
      "메일 2통을 찾았어요.",
      JSON.stringify({ ok: true, items: [] }),
      JSON.stringify([{ id: 1 }]),
      `${TOOL_RESULT_KO["laf:stopped"]} 라고 적힌 메일`,
      JSON.stringify({ pad: "x".repeat(5000), ok: false }),
      JSON.stringify({ ok: false, error: "channel_not_found" }),
      JSON.stringify({ refused: true }),
      JSON.stringify({ stopped: true, at: "the service's own queue" }),
    ]) {
      expect([result.slice(0, 40), stepDidNotWork(result)]).toEqual([
        result.slice(0, 40),
        false,
      ]);
      expect([
        result.slice(0, 40),
        takenBy([
          ASKED,
          called("1"),
          answered("1", result),
          said("a-answer", "찾아봤어요."),
        ])["a-answer"]?.failed,
      ]).toEqual([result.slice(0, 40), 0]);
    }
  });

  /*
   * AND EVERY WAY A CALL IS NOT CARRIED OUT IS WRITTEN IN ONE OF THOSE FORMS (review of pull
   * request 44, round 3). The window's own handler answered with the reason as it came: a 403 that
   * carries no fact is whatever sentence the route wrote, or this app's own fallback in the
   * reader's language — a refusal that read back as the service's answer.
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
      // A reason that is somebody else's object says nothing by itself: it is wrapped like prose.
      { refused: false, reason: JSON.stringify({ ok: false, error: "x" }) },
    ]) {
      const written = toolFailureText(failure);
      expect([failure.reason, stepDidNotWork(written)]).toEqual([
        failure.reason,
        true,
      ]);
      // The model is told the same reason, and whether it was a refusal.
      expect(JSON.parse(written)).toEqual({ ok: false, ...failure });
      // And read back, it is a step that did not work: counted for the answer that opens it.
      expect(
        takenBy([
          ASKED,
          called("1"),
          answered("1", written),
          ...done("2"),
          ...done("3"),
          said("a-answer", "첫 번째는 안 됐어요."),
        ]),
      ).toEqual({
        "a-answer": {
          runIds: ["call-1"],
          rows: ["call-1", "call-2", "call-3"],
          failed: 1,
        },
      });
    }
    // However long the reason: a wrapper too long to be parsed is known by how it begins (round 5).
    const long = toolFailureText({ refused: true, reason: "가".repeat(5000) });
    expect(long.length).toBeGreaterThan(4096);
    expect(stepDidNotWork(long)).toBe(true);
    expect(stepDidNotWork(`Error: ${"x".repeat(5000)}`)).toBe(true);
    // The server's own refusals are written the same way, `ok` first.
    expect(
      stepDidNotWork(
        JSON.stringify({ ok: false, code: "laf:x", reason: "y".repeat(5000) }),
      ),
    ).toBe(true);
    // A service's own long answer is still not read to find out — wherever it says `ok`.
    expect(
      stepDidNotWork(JSON.stringify({ items: ["z".repeat(5000)], ok: false })),
    ).toBe(false);
    // A fact the table has no sentence for is handed over as itself, and is one too.
    expect(stepDidNotWork("laf:some_new_fact")).toBe(true);
    expect(stepDidNotWork("laf: 로 시작하는 메일 제목")).toBe(false);
  });
});

/*
 * THE NUMBER A CONTROL NAMES IS WHAT PRESSING IT DRAWS, and only the rows a window holds can be
 * drawn. Cut inside a run, the fold of the time read 이전 5단계 and opened to the two the window
 * held (review of pull request 44, round 1). The answer is the control now, so the same holds
 * between an answer and every step it opens.
 */
describe("where a drawn window may begin", () => {
  const TURNS = [
    ASKED,
    ...done("1"),
    ...done("2"),
    ...done("card", "now"),
    ...done("3"),
    said("a-answer", "다 봤어요."),
    said("a-more", "답장도 써 드릴까요?"),
    asked("q-2", "응, 써 줘"),
    ...done("4"),
    asked("q-3", "아직이야?"),
  ];
  const beginsAt = (from: string) => {
    const items = itemsOf(TURNS);
    const cut = items.findIndex((item) => item.id === from);
    return items[wholeFrom(items, stepRunsOf(items), cut)]?.id;
  };

  test("never inside a run, nor between an answer and a step it opens", () => {
    expect(beginsAt("call-2")).toBe("call-1");
    // The second run of the same answer, the card between the two, and the answer itself.
    expect(beginsAt("call-3")).toBe("call-1");
    expect(beginsAt("call-card")).toBe("call-1");
    expect(beginsAt("a-answer")).toBe("call-1");
  });

  test("where it would have anywhere else: a first step, a sentence that takes none, the person's own message", () => {
    expect(beginsAt("call-1")).toBe("call-1");
    expect(beginsAt("a-more")).toBe("a-more");
    expect(beginsAt("q-asked")).toBe("q-asked");
    expect(beginsAt("q-2")).toBe("q-2");
    expect(beginsAt("call-4")).toBe("call-4");
    // The person's message begins a turn: the step before it, which no answer took, is not reached for.
    expect(beginsAt("q-3")).toBe("q-3");
  });
});

/*
 * THE CONVERSATION, MOUNTED. THE ANSWER'S MENU IS PRESSED IN A PROCESS OF ITS OWN.
 *
 * The record is opened from the last row of the answer's "more" menu, and in this process that
 * menu does not open: Base UI decides once whether there is a document, and a file before this one
 * had it decide there was none (`support/steps-render.tsx` has the measurement). So every
 * conversation whose record is pressed is mounted and pressed there — once, for all of them — and
 * each test here holds one of them to what the screen showed. What needs no press of the menu is
 * mounted here, further down.
 */
const names = (entries: readonly Entry[] | undefined) =>
  (entries ?? []).map((entry) => entry.name);
/** A row of the menu as it reads when nothing about it is out of the ordinary. */
const row = (name: string): Entry => ({
  name,
  role: "menuitem",
  checked: false,
  warns: false,
});

describe("the conversation, with the answer's menu pressed", () => {
  let shown: StepsShown = {};
  /** What one conversation showed. A scenario that stopped short fails the test that reads it. */
  const seen = (name: string): Seen => {
    const scenario = shown[name];
    if (!scenario) throw new Error(`the scenario "${name}" did not run`);
    if (scenario.error) {
      throw new Error(
        `"${name}" stopped: ${scenario.error}\n${JSON.stringify(scenario)}`,
      );
    }
    return scenario;
  };

  beforeAll(async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "support/steps-render.tsx")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("STEPS_RENDER "));
    if (status !== 0 || !line) {
      throw new Error(
        `the conversations were not pressed to the end (exit ${status}):\n${stderr.slice(-3000)}`,
      );
    }
    shown = JSON.parse(line.slice("STEPS_RENDER ".length)) as StepsShown;
  }, 180_000);

  describe("a finished conversation", () => {
    test("draws no step, and two controls under the answer; the record is the last row of its menu — pressed, every step of the turn; pressed again, none", () => {
      const { frames, menus, notes } = seen("record");
      expect(frames.closed).toEqual({
        rows: ["q-asked", "a-answer"],
        lines: 0,
        // Two, and no warning over steps that all worked.
        controls: { "a-answer": ["Copy this reply", "More"] },
        warned: [],
      });
      // Named for what it opens, and last: after what every answer's menu has.
      expect(menus.closed).toEqual([
        row("Quote in a reply"),
        row("What it did for this answer: 4 steps"),
      ]);

      // Where they happened: between the question and the answer.
      expect(frames.opened?.rows).toEqual([
        "q-asked",
        "call-1",
        "call-2",
        "call-3",
        "call-4",
        "a-answer",
      ]);
      expect(frames.opened?.lines).toBe(4);
      expect(names(menus.opened)).toEqual([
        "Quote in a reply",
        "Hide what it did",
      ]);

      expect(frames["put away"]).toEqual(frames.closed);
      expect(menus["put away"]).toEqual(menus.closed);
      // The answer is where it was throughout.
      expect(notes["the answer is where it was"]).toBe(true);
    });

    /*
     * THE ROW OF CONTROLS IS DRAWN WHILE THE POINTER IS OVER THE ANSWER, and the menu is drawn
     * somewhere else in the document. The pointer goes to the menu, and the button the menu hangs
     * from would fade out from under it — so the row is held up for as long as its menu is open.
     */
    test("the row of controls is held up while its menu is open, and let go when it closes", () => {
      const { notes } = seen("record");
      expect({
        before: notes["held up, before"],
        open: notes["held up, menu open"],
        closed: notes["held up, menu closed"],
      }).toEqual({ before: false, open: true, closed: false });
    });

    test("does not draw a step alone either, and a sentence the Bot spoke between opens only what came before it", () => {
      const { frames, menus } = seen("alone");
      expect(frames.closed?.lines).toBe(0);
      expect(frames.closed?.rows).toEqual(["q-asked", "a-between", "a-answer"]);
      expect(names(menus["between, closed"]).at(-1)).toBe(
        "What it did for this answer: 1 steps",
      );
      expect(names(menus["answer, closed"]).at(-1)).toBe(
        "What it did for this answer: 2 steps",
      );

      expect(frames["between opened"]?.rows).toEqual([
        "q-asked",
        "call-1",
        "a-between",
        "a-answer",
      ]);
      // Open under the one that was pressed, and still to be opened under the other.
      expect(names(menus["between, opened"]).at(-1)).toBe("Hide what it did");
      expect(names(menus["answer, still closed"]).at(-1)).toBe(
        "What it did for this answer: 2 steps",
      );
    });

    /*
     * NOTHING ELSE LEAVES THE CONVERSATION. A card, a file, the clock: each is a thing the Bot made
     * or said, drawn by name, and is where it was with the record closed and with it open.
     */
    test("leaves what is drawn by name where it was, and opens the runs either side of it together", () => {
      const { frames, menus } = seen("card");
      expect(frames.closed?.rows).toEqual(["q-asked", "call-card", "a-answer"]);
      expect(names(menus.closed).at(-1)).toBe(
        "What it did for this answer: 3 steps",
      );
      expect(frames.opened?.lines).toBe(3);
      expect(frames.opened?.rows).toEqual([
        "q-asked",
        "call-1",
        "call-2",
        "call-card",
        "call-3",
        "a-answer",
      ]);
      expect(names(menus.opened).at(-1)).toBe("Hide what it did");
    });
  });

  describe("a step with something on it for the person", () => {
    test("stays drawn with the steps around it put away: the mail a one-time code was in", () => {
      const { frames, menus } = seen("code");
      // The row of the call that read the mail is in the document, where its 보기 is drawn.
      expect(frames.closed?.lines).toBe(1);
      expect(frames.closed?.rows).toEqual(["q-asked", "call-2", "a-answer"]);
      // It is one of the four the answer names, and opening draws the other three around it.
      expect(names(menus.closed).at(-1)).toBe(
        "What it did for this answer: 4 steps",
      );
      expect(frames.opened?.lines).toBe(4);
      expect(frames["put away"]?.lines).toBe(1);
      expect(frames["put away"]?.rows).toEqual([
        "q-asked",
        "call-2",
        "a-answer",
      ]);
    });

    test("and where it is all the answer was written from, the menu has no row for it: there is nothing to open", () => {
      const { frames, menus } = seen("code alone");
      expect(frames.drawn?.rows).toEqual(["q-asked", "call-1", "a-answer"]);
      expect(menus.drawn).toEqual([row("Quote in a reply")]);
    });

    /*
     * A STEP THAT DID NOT WORK IS NOT ONE OF THEM (the owner, 2026-10-04). It used to stay drawn.
     * What keeps a failure from being hidden is the control it is behind: the "more" button's
     * colour and its name, and the row that opens the record, which says how many.
     */
    test("a step that did not work is not drawn, and the button it is behind says so in its colour and its name", () => {
      const { frames, menus } = seen("failed");
      expect(frames.closed).toEqual({
        rows: ["q-asked", "a-answer"],
        lines: 0,
        controls: {
          "a-answer": ["Copy this reply", "More. A step did not work"],
        },
        warned: ["a-answer"],
      });
      expect(menus.closed).toEqual([
        row("Quote in a reply"),
        {
          ...row("What it did for this answer: 4 steps, 1 did not work"),
          warns: true,
        },
      ]);
      // Opened, the step that did not work is there with the rest.
      expect(frames.opened?.rows.slice(1, 5)).toEqual([
        "call-1",
        "call-2",
        "call-3",
        "call-4",
      ]);
      // And the button goes on saying so: the failure is in the record, open or put away.
      expect(frames.opened?.warned).toEqual(["a-answer"]);
    });
  });

  describe("a row another screen sends the person to", () => {
    /*
     * 오늘, 만든 것 and 수첩 name a row and the transcript goes to it once it is in the document —
     * which a step that is over is not. The LAST step of a run is the one this used to leave alone:
     * it was the line that was drawn.
     */
    test("is opened to — the last step of a run too — and stays open", () => {
      const { frames, menus } = seen("jump");
      expect(frames.closed?.lines).toBe(0);
      expect(frames["after the jump"]?.lines).toBe(3);
      // The answer's own menu knows: the record it opens is open, and it is what closes it.
      expect(names(menus["after the jump"]).at(-1)).toBe("Hide what it did");
      expect(frames["put away"]?.lines).toBe(0);
    });

    /*
     * AN ANSWER'S RECORD IS OPEN WHEN ALL OF IT IS. A jump opens the run that holds the row and not
     * the one the other side of a card, so the answer's menu still offers to open — and opens the
     * rest — rather than offering to hide a record half of which was never shown.
     */
    test("opens the run it is in and not the rest of the record, which the answer's menu still opens", () => {
      const { frames, menus } = seen("jump to half");
      expect(frames["after the jump"]?.rows).toEqual([
        "q-asked",
        "call-card",
        "call-3",
        "a-answer",
      ]);
      expect(names(menus["after the jump"]).at(-1)).toBe(
        "What it did for this answer: 3 steps",
      );
      expect(frames.opened?.lines).toBe(3);
      expect(names(menus.opened).at(-1)).toBe("Hide what it did");
      expect(frames["put away"]?.lines).toBe(0);
    });

    test("opens nothing when it is drawn already: the steps around it were not asked for", () => {
      const { frames, menus } = seen("jump to a drawn row");
      expect(frames.closed?.lines).toBe(1);
      expect(frames["after the jump"]?.lines).toBe(1);
      expect(names(menus["after the jump"]).at(-1)).toBe(
        "What it did for this answer: 3 steps",
      );
    });
  });

  describe("a record at the edge of what is drawn", () => {
    /*
     * THE WINDOW IS FORTY ROWS, COUNTED OVER EVERY ROW — the ones not drawn too. Cut inside a run,
     * the fold read 이전 5단계 and opening it drew the two the window held, under a button that said
     * the record was open (review of pull request 44, round 1).
     */
    test("is whole: a window that would begin inside a run begins at its first step", () => {
      const { menus, notes } = seen("window");
      expect(names(menus.closed).at(-1)).toBe(
        "What it did for this answer: 6 steps",
      );
      expect(notes["first row, closed"]).toBe("a-answer");
      expect(notes["first seven rows, opened"]).toBe(
        "call-1 call-2 call-3 call-4 call-5 call-6 a-answer",
      );
    });

    /*
     * AND THE ANSWER IS THE CONTROL NOW. A window that began at the answer itself held none of the
     * steps it names: three steps, and a press that drew nothing under a row saying it was open.
     */
    test("and one that would begin at the answer begins at the first step that answer opens", () => {
      const { menus, notes } = seen("window at the answer");
      expect(notes["first row, closed"]).toBe("a-answer");
      expect(names(menus.closed).at(-1)).toBe(
        "What it did for this answer: 3 steps",
      );
      expect(notes["first four rows, opened"]).toBe(
        "call-1 call-2 call-3 a-answer",
      );
    });

    test("stays open when the page above arrives with the steps before it", () => {
      const { frames, menus } = seen("page");
      expect(names(menus["the newest page"]).at(-1)).toBe(
        "What it did for this answer: 2 steps",
      );
      // The window was pinned to the row it began at, the third step: now inside the run, so it
      // begins at the run's first step, and the run is open by the row it was opened by.
      expect(frames["the page above arrived"]?.rows).toEqual([
        "call-1",
        "call-2",
        "call-3",
        "call-4",
        "a-answer",
      ]);
      expect(names(menus["the page above arrived"]).at(-1)).toBe(
        "Hide what it did",
      );
      // Closed by any row of it: none drawn, and the count is the whole record's.
      expect(frames["put away"]?.lines).toBe(0);
      expect(names(menus["put away"]).at(-1)).toBe(
        "What it did for this answer: 4 steps",
      );
    });
  });

  describe("a turn that is still going", () => {
    test("shows the step that is out and none of the finished ones, and its answer opens them all", () => {
      const { frames, menus } = seen("going");
      // The one in hand is the only line, however many came before it; and no answer, no control.
      expect(frames["the first step out"]).toEqual({
        rows: ["q-asked", "call-1"],
        lines: 1,
        controls: {},
        warned: [],
      });
      expect(frames["the third step out"]).toEqual({
        rows: ["q-asked", "call-3"],
        lines: 1,
        controls: {},
        warned: [],
      });
      // The answer arrives: no step is left drawn, and the answer carries all three.
      expect(frames["the answer arrived"]?.rows).toEqual([
        "q-asked",
        "a-answer",
      ]);
      // The record is all its menu holds: an answer still being written is not quoted or rated.
      expect(menus["the answer arrived"]).toEqual([
        row("What it did for this answer: 3 steps"),
      ]);
      expect(frames.opened?.lines).toBe(3);
    });

    /*
     * THE PRESS IS ONE FUNCTION FOR AS LONG AS THE TRANSCRIPT IS MOUNTED, and a finished answer is
     * handed it once. After the answer under it has been written, chunk by chunk, the row still
     * does what it did: the function it was given is the same one, not a dead one.
     */
    test("a finished answer's record is still put away and opened after the answer under it was written", () => {
      const { frames } = seen("pressed while the next answer is written");
      expect(frames["the next answer written"]?.lines).toBe(2);
      // The one being written has 복사 and nothing else: no steps, and not yet to be quoted or rated.
      expect(frames["the next answer written"]?.controls).toEqual({
        "a-told": ["Copy this reply", "More"],
        "a-urgent": ["Copy this reply"],
      });
      expect(frames["put away"]?.lines).toBe(0);
      expect(frames["opened again"]?.lines).toBe(2);
    });
  });

  /*
   * WHAT THE MENU HOLDS, IN ORDER (the owner's "proposal A", 2026-10-04): 인용해 답하기, 좋아요,
   * 아쉬워요, and — where the answer has steps — the row that opens the record. An answer that can
   * be neither quoted nor rated has the record alone, and with no record has no menu.
   */
  describe("what an answer's menu holds", () => {
    const choice = (name: string, checked = false): Entry => ({
      name,
      role: "menuitemradio",
      checked,
      warns: false,
    });

    test("an answer with steps: quote, the two a rating is chosen from, and the record, last", () => {
      expect(seen("menus").menus["with steps"]).toEqual([
        row("Quote in a reply"),
        choice("Good answer"),
        choice("Could be better"),
        row("What it did for this answer: 2 steps"),
      ]);
    });

    test("an answer without: the first three", () => {
      expect(seen("menus").menus.without).toEqual([
        row("Quote in a reply"),
        choice("Good answer"),
        choice("Could be better"),
      ]);
    });

    test("an answer still being written, which can be neither quoted nor rated: the record alone — and with no record, no menu", () => {
      const { frames, menus } = seen("menus");
      expect(menus["being written, with steps"]).toEqual([
        row("What it did for this answer: 1 steps"),
      ]);
      expect(menus["being written, without"]).toEqual([]);
      // Two controls under each, and under the one with nothing to put in a menu, 복사 alone.
      expect(frames.drawn?.controls).toEqual({
        "a-steps": ["Copy this reply", "More"],
        "a-plain": ["Copy this reply", "More"],
        "a-writing": ["Copy this reply", "More"],
        "a-bare": ["Copy this reply"],
      });
    });

    test("좋아요 from the menu is what the thumb was: sent as nothing but itself, and drawn as chosen once the server has it", () => {
      const { frames, menus, notes } = seen("menus");
      expect(notes.put).toBe(JSON.stringify([{ rating: "up" }]));
      expect(menus.rated).toEqual([
        row("Quote in a reply"),
        choice("Good answer", true),
        choice("Could be better"),
      ]);
      // And still two controls: what the rating came to is said beside them, not with a third —
      // and the row is held up for as long as it is being said, wherever the pointer went.
      expect(frames.rated?.controls["a-plain"]).toEqual([
        "Copy this reply",
        "More",
      ]);
      expect(notes["held up while the rating is said"]).toBe(true);
    });
  });
});

const log = (host: HTMLElement) => host.querySelector('[role="log"]');
/** How many step lines of the stand-in tool the transcript is drawing. */
const linesDrawn = (host: HTMLElement) =>
  (log(host)?.textContent ?? "").split("Used a connected service").length - 1;
const rowsDrawn = (host: HTMLElement) =>
  [
    ...(log(host)?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
  ].map((row) => row.dataset.messageId);
/** The same, as one string: what a wait compares. */
const drawn = (host: HTMLElement) => rowsDrawn(host).join(" ");
/**
 * How many answers have a "more" under them. A number, never the element: a comparison that fails
 * is printed, and an element is printed by walking the document it is in — measured here, one
 * failed `toBeNull()` on a button kept the run busy for the ten minutes it was given, at 900 MB,
 * instead of failing.
 */
const moresDrawn = (host: HTMLElement) =>
  log(host)?.querySelectorAll('[data-slot="answer-more"] button').length ?? 0;

/*
 * WHAT NEEDS NO PRESS OF THE MENU IS MOUNTED HERE, in this process, as it always was.
 */
describe("a turn that ended on a step that is not drawn", () => {
  /*
   * THE LINE THAT SAYS A TURN DIED IS NOT A STEP. A turn that dies mid-task leaves its last row a
   * step's result, so the server keys the failure there and names the question beside it, and the
   * line is drawn after the last row that turn drew (`failurePlaces`) — a step that is over, which
   * is not drawn. The line is: a turn that failed on a step nobody can see has still failed.
   */
  test("still says that it failed", async () => {
    const channelId = "channel_steps-died";
    const server = turnServer({ channelId, history: [ASKED, ...done("1")] });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: (request: ApiRequest) =>
        request.pathname === `/api/channels/${channelId}/failures`
          ? json({
              failures: [
                {
                  messageId: "t-1",
                  askedId: ASKED.id,
                  code: "laf:turn_unreachable",
                  at: "2026-10-04T03:00:00.000Z",
                },
              ],
            })
          : server.api(request),
    });
    await view.waitFor(
      () =>
        log(view.host)?.querySelector('[data-testid="transcript-stopped"]') !==
        null,
      "the line that says the turn failed",
      8000,
    );
    expect(linesDrawn(view.host)).toBe(0);
    expect(rowsDrawn(view.host)).toEqual(["q-asked"]);
    server.close();
    await view.unmount();
  });
});

describe("a turn that is still going, watched", () => {
  /** A turn that has the Bot, and has drawn nothing but the question yet. */
  async function running(channelId: string) {
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
    return {
      server,
      view,
      writes: (messages: Message[]) => acted(() => server.say(messages)),
    };
  }

  /*
   * A STEP THAT IS PUT AWAY LEAVES NOTHING STANDING. The thinking line waits 1.2 s under a tail
   * that is still on the screen. Pressed on the running app with steps no longer drawn: the
   * weather's line went as its result arrived, and the end of the conversation was empty for
   * 1.2 s before "생각 중" — a Bot that has stalled looks exactly like that.
   */
  test("says it is thinking at once after a step that is put away", async () => {
    const { server, view, writes } = await running("channel_steps-thinking");
    await writes([called("1")]);
    await view.waitFor(() => linesDrawn(view.host) === 1, "the step");
    await writes([...done("1")]);
    await view.waitFor(() => linesDrawn(view.host) === 0, "the step gone");
    // Well inside the 1.2 s the line waits under a tail that is still drawn.
    await view.settle(200);
    expect(log(view.host)?.textContent).toContain("Thinking");
    server.close();
    await view.unmount();
  });

  /*
   * AN OPENED RECORD STANDS BY THE ANSWER IT WAS DONE FOR. The answer began a run of its own
   * whatever was above it, so with its record open it stood 28px under the step and the step 16px
   * under the person's message, ink to ink: the record nearer the question than the answer (looked
   * at in the running app, 2026-10-04). The first step under the person's message begins the
   * Bot's side, the steps of the record are a list under it, and the answer under them continues.
   */
  test("an answer stands by the steps drawn above it, and begins its run when none is", async () => {
    const channelId = "channel_steps-stand-by";
    const server = turnServer({
      channelId,
      history: [
        ASKED,
        ...done("1"),
        ...done("2"),
        said("a-answer", "한 통 왔어요."),
      ],
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => drawn(view.host) === "q-asked a-answer",
      "the answer",
      8000,
    );
    const spacing = (id: string) =>
      log(view.host)
        ?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
        ?.className.split(" ")
        .filter((name) => /^p[tby]-/.test(name))
        .join(" ");
    // Closed: nothing of the Bot's is above it, and it begins its run.
    expect(spacing("a-answer")).toBe("py-2 pt-5");

    const { requestJump } = await import("../src/lib/channels/jump");
    await acted(() => requestJump({ channelId, messageId: "call-1" }));
    await view.waitFor(
      () => drawn(view.host) === "q-asked call-1 call-2 a-answer",
      "the record opened",
      4000,
    );
    expect(["call-1", "call-2", "a-answer"].map(spacing)).toEqual([
      "py-0.5 pt-5",
      "py-0.5",
      "py-2",
    ]);

    server.close();
    await view.unmount();
  });

  test("a run opened part-way stays open as it grows: it is open by a row it holds", async () => {
    const channelId = "channel_steps-growing";
    const { server, view, writes } = await running(channelId);
    await writes([...done("1"), called("2")]);
    await view.waitFor(
      () => drawn(view.host) === "q-asked call-2",
      "the step in hand",
      4000,
    );

    const { requestJump } = await import("../src/lib/channels/jump");
    await acted(() => requestJump({ channelId, messageId: "call-1" }));
    await view.waitFor(
      () => drawn(view.host) === "q-asked call-1 call-2",
      "the run opened",
      4000,
    );
    await writes([...done("1"), ...done("2"), called("3")]);
    await view.waitFor(
      () => drawn(view.host) === "q-asked call-1 call-2 call-3",
      "the run, a step longer",
      4000,
    );

    server.close();
    await view.unmount();
  });

  /*
   * AN ANSWER BEING WRITTEN DRAWS NO FINISHED ROW AGAIN. The rows are memoised so that a finished
   * chart, a mail drawn as markdown, or an answer's own markdown is not drawn again with every
   * chunk of the sentence after it. The press that opens a record was once a function made new on
   * every render and handed to each run's newest line, which made every one of them a row whose
   * props had changed: counted, each was drawn once a chunk (Codex on pull request 44, round 9).
   * It is the answer that is handed it now, so it is the answer that is counted — with the steps
   * it opened, which are rows again once they are drawn.
   *
   * OPENED BY A JUMP HERE, NOT BY A PRESS: the press is a row of a menu that does not open in this
   * process. A jump opens the same run, and what is counted is what is drawn after that. That the
   * row still presses afterwards is held where it can be pressed (`steps-render.tsx`, "pressed
   * while the next answer is written").
   */
  test("does not draw a finished answer, or the steps it opened, again with each chunk of the answer after it", async () => {
    const channelId = "channel_steps-still";
    const ASKED_AGAIN = asked("q-again", "그 중에 급한 게 있어?");
    const history = [
      ASKED,
      ...done("1"),
      ...done("2"),
      said("a-told", "메일이 두 통 있어요."),
      ASKED_AGAIN,
    ];
    const server = turnServer({
      channelId,
      history,
      turn: { id: "turn-1", status: "running", asked: [ASKED_AGAIN.id] },
      turnMessages: history,
    });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () => moresDrawn(view.host) === 1,
      "the answer's controls",
      8000,
    );
    expect(linesDrawn(view.host)).toBe(0);

    // The stand-in tool has no renderer of its own, so each drawing of its row asks for its words;
    // and each drawing of the answer's menu asks for the name of the row that closes the record.
    const labels = await import("../src/lib/copilot/step-labels");
    const worded = spyOn(labels, "stepLineOf");
    const stepsDrawn = () =>
      worded.mock.calls.filter(([name]) => name === SERVICE_TOOL).length;
    const words = await import("../src/lib/i18n");
    const translated = spyOn(words, "t");
    const answersDrawn = () =>
      translated.mock.calls.filter(([key]) => key === "Hide what it did")
        .length;

    const { requestJump } = await import("../src/lib/channels/jump");
    await acted(() => requestJump({ channelId, messageId: "call-1" }));
    await view.waitFor(() => linesDrawn(view.host) === 2, "both steps", 4000);
    // Both counts count: opened, the answer asked for that name and each step for its words.
    expect(answersDrawn()).toBeGreaterThan(0);
    expect(stepsDrawn()).toBeGreaterThan(0);
    // Past the jump's own second look at the row (`JumpToRow`), so nothing of it is counted below.
    await view.settle(700);
    worded.mockClear();
    translated.mockClear();

    const writes = (text: string) =>
      acted(() => server.say([said("a-urgent", text)]));
    const CHUNKS = [
      "두 번째",
      "두 번째 메일이",
      "두 번째 메일이 오늘까지예요.",
    ];
    for (const text of CHUNKS) {
      await writes(text);
      await view.waitFor(
        () => log(view.host)?.textContent?.includes(text) === true,
        `the answer as far as "${text}"`,
        4000,
      );
    }
    expect(stepsDrawn()).toBe(0);
    expect(answersDrawn()).toBe(0);

    translated.mockRestore();
    worded.mockRestore();
    server.close();
    await view.unmount();
  });
});
