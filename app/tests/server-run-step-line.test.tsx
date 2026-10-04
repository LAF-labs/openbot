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
import { CARD_NOT_ASKED, ON_SCREEN } from "@shared/tools/gallery";
import { NOW_TOOL_NAME } from "@shared/tools/now";
import { MANAGE_ROUTINE, UPDATE_PROFILE } from "@shared/tools/self";
import { SKILL_VIEW } from "@shared/tools/skills";
import {
  stepFailureOf,
  TOOL_NOT_ALLOWED,
  toolErrorText,
  toolFailureText,
} from "@shared/tools/step-result";
import { withheldMark } from "@shared/tools/withheld";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { mount, unmountAll } from "./support/mount";
import {
  acted,
  BOT_ID,
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * THE LINE OF A STEP THIS WINDOW DID NOT RUN SAYS HOW THE STEP ENDED.
 *
 * `PluginTool` drew a step's failure, and the 보기 for a code a mail held, from what its own handler
 * had stored — and a turn the server owns never calls that handler, nor does a conversation read
 * back after a reload. Measured 2026-10-03 with this same conversation: a step whose result was the
 * service's error read "Reading a mail · Gmail" with no warning, and a step whose result held a
 * withheld code had no button. Every chat turn is the server's now, so that was every step.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  await unmountAll();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const TOOL = "mcp__gmail__read_message";
const POLICY_DENIED = TOOL_RESULT_KO["laf:policy_denied"] as string;
const SERVER_FAILED = TOOL_RESULT_KO["laf:tool_server_failed"] as string;
const MAIL = `제목: 인증번호 안내\n인증번호: ${withheldMark("code", "Ab12Cd34Ef56")}`;

/** One step and what the conversation kept as its result, with the Bot's sentence after it. */
const step = (id: string, result: string, name = TOOL): Message[] => [
  {
    id: `a-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  } as Message,
  { id: `t-${id}`, role: "tool", toolCallId: id, content: result } as Message,
  { id: `s-${id}`, role: "assistant", content: `${id} 다음 말` },
];

describe("how a failed step ended, read back from its result", () => {
  test("the service's own error, a refusal, a failure — and nothing for an answer", () => {
    expect(stepFailureOf(toolErrorText("quota exceeded"))).toEqual({
      kind: "error",
      text: "quota exceeded",
    });
    expect(stepFailureOf(POLICY_DENIED)).toEqual({
      kind: "refused",
      code: "laf:policy_denied",
    });
    expect(
      stepFailureOf(TOOL_RESULT_KO["laf:person_declined"] as string),
    ).toEqual({ kind: "refused", code: "laf:person_declined" });
    expect(stepFailureOf(SERVER_FAILED)).toEqual({
      kind: "failed",
      code: "laf:tool_server_failed",
    });
    expect(stepFailureOf(TOOL_RESULT_KO["laf:stopped"] as string)).toEqual({
      kind: "failed",
      code: "laf:stopped",
    });
    expect(stepFailureOf(TOOL_NOT_ALLOWED)).toEqual({
      kind: "refused",
      code: null,
    });
    // The deployment's own no: a tool this Bot was not given, a tool held for review — as a bare
    // fact and as the sentence the model was told. And what is nobody's no stays a failure.
    for (const code of ["laf:tool_not_granted", "laf:tool_needs_review"]) {
      expect(stepFailureOf(code)).toEqual({ kind: "refused", code });
      expect(stepFailureOf(TOOL_RESULT_KO[code] as string)).toEqual({
        kind: "refused",
        code,
      });
    }
    for (const code of [
      "laf:grant_withdrawn",
      "laf:tool_arguments_invalid",
      "laf:weather_place_outside",
    ]) {
      expect(stepFailureOf(code)).toEqual({ kind: "failed", code });
    }
    expect(stepFailureOf(UNANSWERED_RESULT)).toEqual({
      kind: "failed",
      code: null,
    });
    expect(
      stepFailureOf(JSON.stringify({ ok: false, code: "laf:tool_unknown" })),
    ).toEqual({ kind: "failed", code: "laf:tool_unknown" });
    expect(
      stepFailureOf(JSON.stringify({ ok: false, refused: true, reason: "no" })),
    ).toEqual({ kind: "refused", code: null });
    /*
     * A SERVICE'S OWN ANSWER CAN SAY `ok: false` TOO. Only an object written by this app — the
     * window's wrapper, the server's refusal with its `laf:` fact, its "an approval is being asked"
     * — is one of ours. A status a service sends as an ordinary answer read "did not work", or
     * "blocked" for a `refused: true` of its own, on a call that was made and answered (Codex on
     * pull request 52).
     */
    for (const answer of [
      { ok: false },
      { ok: false, error: "channel_not_found" },
      { refused: true, by: "the recipient" },
      { ok: false, items: [], next: null },
      { ok: false, code: "E_QUOTA", reason: "quota" },
    ]) {
      expect([answer, stepFailureOf(JSON.stringify(answer))]).toEqual([
        answer,
        null,
      ]);
    }
    expect(
      stepFailureOf(
        JSON.stringify({ ok: false, awaitingApproval: true, approvalId: "a1" }),
      ),
    ).toEqual({ kind: "failed", code: null });
    expect(stepFailureOf("Error: the handler threw")).toEqual({
      kind: "failed",
      code: null,
    });
    /*
     * ONLY SOMEBODY SAYING NO IS A REFUSAL. Pressed on the local stack, a weather call for a place
     * the forecast does not reach read "날씨 확인하기 — 차단됨" in red, and nobody had blocked
     * anything: every fact that is not a named refusal says only that the step did not work.
     */
    for (const code of [
      "laf:weather_place_outside",
      "laf:nobody_answered",
      "laf:tool_server_failed",
      "laf:not_connected",
    ]) {
      const sentence = TOOL_RESULT_KO[code];
      expect([code, typeof sentence]).toEqual([code, "string"]);
      expect([code, stepFailureOf(sentence as string)]).toEqual([
        code,
        { kind: "failed", code },
      ]);
      /*
       * AND THE SAME WHILE THE WINDOW THAT RAN THE CALL IS STILL OPEN. The handler's own outcome
       * said `refused` for every 403, so a line read 차단됨 until the page was reloaded and 실패
       * after it. The line is drawn from the text the handler answered with — the text the
       * conversation keeps — so there is one reading of it.
       */
      expect([
        code,
        stepFailureOf(
          toolFailureText({ refused: true, reason: sentence as string }),
        ),
      ]).toEqual([code, { kind: "failed", code }]);
    }
    // A reason with no fact in it says what the route said it was: a refusal, or not.
    for (const refused of [true, false]) {
      expect(
        stepFailureOf(
          toolFailureText({ refused, reason: "Something a route wrote." }),
        ),
      ).toEqual({ kind: refused ? "refused" : "failed", code: null });
    }
    expect(stepFailureOf("laf:some_new_fact")).toEqual({
      kind: "failed",
      code: "laf:some_new_fact",
    });
    for (const code of ["laf:no_rule_allows", "laf:declined_recently"]) {
      expect([code, stepFailureOf(TOOL_RESULT_KO[code] as string)]).toEqual([
        code,
        { kind: "refused", code },
      ]);
    }
    for (const answer of ["ok", MAIL, JSON.stringify({ ok: true })]) {
      expect([answer, stepFailureOf(answer)]).toEqual([answer, null]);
    }
  });
});

describe("a conversation whose steps the server ran", () => {
  async function rows(history: Message[]) {
    const channelId = "channel_server-run";
    const server = turnServer({ channelId, history });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: (request) => {
        // The Bot is granted the tool, so the line is drawn by the tool's own renderer.
        if (request.pathname.startsWith("/api/plugins/for/")) {
          return json({
            tools: [
              {
                ref: "gmail/read_message",
                toolName: TOOL,
                description: "Read a mail",
                inputSchema: { type: "object", properties: {} },
              },
            ],
            skills: [],
          });
        }
        return server.api(request);
      },
    });
    const log = () => view.host.querySelector<HTMLElement>('[role="log"]');
    const last = String(history.at(-1)?.content);
    await view.waitFor(
      () => log()?.textContent?.includes(last) === true,
      "the conversation",
      8000,
    );
    const row = (id: string) =>
      log()?.querySelector<HTMLElement>(`[data-message-id="${id}"]`) ?? null;
    /*
     * A FINISHED STEP IS NOT DRAWN UNTIL ITS RECORD IS OPENED, and the record is opened from the
     * answer's "more" (`answer-more.tsx`) — a menu, which does not open in the suite's process
     * (`support/steps-render.tsx` has why, and presses it in a process of its own). So here:
     *
     *  - WHAT THE CLOSED RECORD SAYS is read off the button itself. Its name and its colour are
     *    all the conversation says about how the steps behind it ended, and every finished answer
     *    in a conversation has the button, with a record or without.
     *  - WHICH STEPS ARE ON THE SCREEN ANYWAY is read before anything is opened: a step with a
     *    code on it is drawn without anybody pressing anything.
     *  - AND THE RECORD IS OPENED THE WAY ANOTHER SCREEN OPENS ONE, by sending the person to a row
     *    in it (`requestJump`): the lines read below are the ones a person sees having opened it.
     */
    const steps = history.flatMap((message) =>
      "toolCalls" in message && Array.isArray(message.toolCalls)
        ? message.toolCalls.map((call) => call.id)
        : [],
    );
    const records = [
      ...(log()?.querySelectorAll<HTMLButtonElement>(
        '[data-slot="answer-more"] button',
      ) ?? []),
    ].map((button) => ({
      name: button.getAttribute("aria-label"),
      isWarned: button.className.includes("text-warning"),
    }));
    const drawnUnopened = steps.filter((id) => row(id) !== null);
    const { requestJump } = await import("../src/lib/channels/jump");
    for (const id of steps) {
      if (row(id) !== null) continue;
      await acted(() => requestJump({ channelId, messageId: id }));
      await view.waitFor(() => row(id) !== null, `the record of ${id}`, 4000);
    }
    // The renderer is registered once the Bot's grants have been read.
    await view.waitFor(
      () => log()?.textContent?.includes("Gmail") === true,
      "the tool's own line",
      8000,
    );
    return {
      /** The "more" under each answer, as it stood over its closed record, in order. */
      records,
      /** The steps that were on the screen before any record was opened. */
      drawnUnopened,
      whole: () => log()?.textContent ?? "",
      read: (id: string) => {
        const drawn = row(id);
        return {
          text: drawn?.textContent ?? null,
          buttons: [...(drawn?.querySelectorAll("button") ?? [])].map(
            (button) => button.textContent,
          ),
          isWarned: drawn?.querySelector('[class*="text-warning"]') !== null,
          isRefused:
            drawn?.querySelector('[class*="text-destructive"]') !== null,
          opens: drawn?.querySelector("details") !== null,
        };
      },
      close: async () => {
        server.close();
        await view.unmount();
      },
    };
  }

  test("offers the 보기 for a code a mail held, and keeps the mail itself folded away", async () => {
    const drawn = await rows([
      { id: "q", role: "user", content: "인증번호 온 메일 읽어줘" },
      ...step("held", MAIL),
    ]);
    // On the screen without anybody opening anything: the person is waiting on the code.
    expect(drawn.drawnUnopened).toEqual(["held"]);
    expect(drawn.records).toEqual([{ name: "More", isWarned: false }]);
    const line = drawn.read("held");
    expect(line.buttons).toEqual(["Show me"]);
    expect(line.text).toContain(
      "This mail had a one-time code. Only you can see it.",
    );
    // The answer is the person's mail: not opened on the line of a call this window did not run.
    expect(line.opens).toBe(false);
    expect(line.text).not.toContain("인증번호 안내");
    expect(line.isWarned || line.isRefused).toBe(false);
    await drawn.close();
  });

  test("says a step did not work, with the service's own words behind the line", async () => {
    const drawn = await rows([
      { id: "q", role: "user", content: "메일 읽어줘" },
      ...step("broke", toolErrorText("quota exceeded")),
    ]);
    // Closed, the button over it says so: the step itself is not drawn.
    expect(drawn.drawnUnopened).toEqual([]);
    expect(drawn.records).toEqual([
      { name: "More. A step did not work", isWarned: true },
    ]);
    const line = drawn.read("broke");
    expect(line.text).toContain("Reading a mail, didn't work");
    expect(line.isWarned).toBe(true);
    expect(line.opens).toBe(true);
    expect(line.text).toContain("quota exceeded");
    await drawn.close();
  });

  /*
   * A mail tool that fails part-way has still read what it read: the server takes the code out and
   * keeps it before it looks at whether the call failed. The 보기 was left out for every failure,
   * and the error's words were drawn as they came — the mark and nothing to press (Codex on #52).
   */
  test("a step that did not work and still held a code offers the 보기, and never the mark", async () => {
    const drawn = await rows([
      { id: "q", role: "user", content: "인증번호 온 메일 읽어줘" },
      ...step("half", toolErrorText(`본문을 끝까지 읽지 못했다.\n${MAIL}`)),
    ]);
    const line = drawn.read("half");
    expect(line.text).toContain("Reading a mail, didn't work");
    expect(line.isWarned).toBe(true);
    expect(line.buttons).toEqual(["Show me"]);
    expect(line.text).toContain("본문을 끝까지 읽지 못했다.");
    // Neither the mark that stands for the code nor the code is anywhere on the row.
    expect(line.text).not.toContain("withheld");
    expect(line.text).not.toContain("Ab12Cd34Ef56");
    await drawn.close();
  });

  test("says a step was blocked in a person's words, and never in the sentence written for the model", async () => {
    const drawn = await rows([
      { id: "q", role: "user", content: "메일 읽어줘" },
      ...step("denied", POLICY_DENIED),
      ...step("down", SERVER_FAILED),
      ...step("fine", "메일 2통을 찾았어요."),
    ]);
    // One button an answer, and each says what the line behind it will: two did not work, one did.
    expect(drawn.records.map((record) => record.isWarned)).toEqual([
      true,
      true,
      false,
    ]);
    const denied = drawn.read("denied");
    expect(denied.text).toContain("Reading a mail, blocked");
    expect(denied.text).toContain("A rule refused it");
    expect(denied.isRefused).toBe(true);

    // No words for a person are kept for this fact: the line says it did not work, and where.
    const down = drawn.read("down");
    expect(down.text).toContain("Reading a mail, didn't work");
    expect(down.text).toContain("Gmail");
    expect(down.isWarned).toBe(true);

    // A step that worked reads as it always did.
    const fine = drawn.read("fine");
    expect(fine.text).toBe("Reading a mail·Gmail");
    expect(fine.isWarned || fine.isRefused || fine.opens).toBe(false);

    // What the model was told is an instruction to a Bot. None of it is under a person's eyes.
    for (const sentence of [POLICY_DENIED, SERVER_FAILED]) {
      expect(drawn.whole()).not.toContain(sentence);
    }
    await drawn.close();
  });
  /*
   * A TOOL THIS BOT NO LONGER HOLDS HAS NO RENDERER — and the commonest refusal of all is that the
   * tool was taken back between the Bot finding it and calling it. Read back after a reload, that
   * refusal was the transcript's plain line for a call it has no renderer for, which reads as a
   * thing that was done (Codex on #52). The plain line reads the kept result too.
   */
  test("a step of a tool the Bot no longer holds still says it was blocked, or did not work", async () => {
    const GONE = "mcp__calendar__add_event";
    const drawn = await rows([
      { id: "q", role: "user", content: "일정 넣어줘" },
      ...step("taken", "laf:tool_not_granted", GONE),
      ...step("broke", toolErrorText("quota exceeded"), GONE),
      ...step("went", "일정을 넣었어요.", GONE),
      // Something the granted tool draws, so the harness knows the renderers are registered.
      ...step("fine", "메일 2통을 찾았어요."),
    ]);
    expect(drawn.read("taken").isRefused).toBe(true);
    expect(drawn.read("broke").isWarned).toBe(true);
    const went = drawn.read("went");
    expect(went.isWarned || went.isRefused).toBe(false);
    await drawn.close();
  });

  /*
   * THE BUTTON AND THE LINE BEHIND IT SAY THE SAME THING. They were read by two functions: the
   * count by one that took any object saying `ok: false` for a failure, the line by one that takes
   * only this app's own. Carried onto the change that puts the steps away, a service's ordinary
   * answer made the button over the record say a step had not worked, in the warning's colour,
   * over a record in which the line said nothing of the kind.
   */
  test("a service's own answer that says `ok: false` is counted by nothing: not by the button, not by the line", async () => {
    const drawn = await rows([
      { id: "q", role: "user", content: "메일 읽어줘" },
      ...step(
        "status",
        JSON.stringify({ ok: false, error: "channel_not_found" }),
      ),
      ...step("no", JSON.stringify({ refused: true, by: "the recipient" })),
      // One of ours beside them, so the control is seen to count at all.
      ...step("ours", JSON.stringify({ ok: false, code: "laf:tool_unknown" })),
    ]);
    expect(drawn.records).toEqual([
      { name: "More", isWarned: false },
      { name: "More", isWarned: false },
      { name: "More. A step did not work", isWarned: true },
    ]);
    for (const id of ["status", "no"]) {
      const line = drawn.read(id);
      expect([id, line.text]).toEqual([id, "Reading a mail·Gmail"]);
      expect([id, line.isWarned || line.isRefused]).toEqual([id, false]);
    }
    expect(drawn.read("ours").isWarned).toBe(true);
    await drawn.close();
  });
});

/*
 * THE BOT'S OWN CALLS, AND THE CARDS IT PUTS UP, SAY HOW THEY ENDED TOO.
 *
 * Each of these lines was filled in by the handler the window ran: it knew the save had been
 * refused, and wrote "루틴을 저장하지 못했어요" for the renderer beside it to draw. A turn the server
 * carries out never ran that handler, so from v0.5.7 the renderer drew what it draws when it
 * knows nothing: a routine the server refused for a time of "8시" read "루틴을 저장했어요", a
 * profile it would not change read "자기 프로필을 바꿨어요", a skill the Bot does not hold read
 * "스킬을 읽음", and a card switched off since the Bot's list was read was drawn in the conversation
 * while the Bot was told it had not been shown. The window-driven path was deleted on 2026-10-05
 * and its tests with it — the only ones that had pinned the honest line — so the server's turn was
 * the only path, and nothing held it (review of pull request 83). They read the result the
 * conversation keeps, as the connected services' line above does.
 */
describe("the Bot's own calls, as the conversation keeps them", () => {
  const CARD = "custom_weekly_sales";
  const CARD_SAYS = "이번 주 매출 카드";

  /** A call by name with its arguments, the result kept for it, and the Bot's sentence after. */
  const called = (
    id: string,
    name: string,
    args: Record<string, unknown>,
    result: string,
  ): Message[] => [
    {
      id: `a-${id}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    } as Message,
    { id: `t-${id}`, role: "tool", toolCallId: id, content: result } as Message,
    { id: `s-${id}`, role: "assistant", content: `${id} 다음 말` },
  ];

  async function conversation(history: Message[]) {
    const channelId = "channel_own-calls";
    const server = turnServer({ channelId, history });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: (request) => {
        // A card authored in this deployment, which the Bot holds by the list this window read.
        if (request.pathname === "/api/sandboxed/published") {
          return json({
            components: [
              {
                name: CARD,
                html: `<p>${CARD_SAYS}</p>`,
                css: "",
                jsFunctions: "",
                argumentSchema: { type: "object", properties: {} },
              },
            ],
          });
        }
        if (request.pathname === `/api/components/for-agent/${BOT_ID}`) {
          return json({ components: [{ name: CARD, description: CARD_SAYS }] });
        }
        return server.api(request);
      },
    });
    const log = () => view.host.querySelector<HTMLElement>('[role="log"]');
    const last = String(history.at(-1)?.content);
    await view.waitFor(
      () => log()?.textContent?.includes(last) === true,
      "the conversation",
      8000,
    );
    // The card's renderer is registered once the published list and the grants have been read.
    await view.settle(300);
    const row = (id: string) =>
      log()?.querySelector<HTMLElement>(`[data-message-id="${id}"]`) ?? null;
    return {
      read: (id: string) => {
        const drawn = row(id);
        return {
          text: drawn?.textContent ?? null,
          isWarned: drawn?.querySelector('[class*="text-warning"]') !== null,
          refusal:
            drawn?.querySelector('[data-testid="component-refused"]')
              ?.textContent ?? null,
          /** The card itself: CopilotKit draws an authored card in a sandbox frame. */
          frames: drawn?.querySelectorAll("iframe").length ?? 0,
        };
      },
      close: async () => {
        server.close();
        await view.unmount();
      },
    };
  }

  const said = (code: string) => TOOL_RESULT_KO[code] as string;
  const asking: Message = { id: "q", role: "user", content: "해 줘" };

  test("a routine the server would not save says so, and one it saved says that", async () => {
    const create = {
      action: "create",
      name: "아침 브리핑",
      instruction: "오늘 할 일 알려줘",
      schedule: { kind: "daily", time: "8시" },
    };
    const drawn = await conversation([
      asking,
      ...called(
        "refused",
        MANAGE_ROUTINE.name,
        create,
        said("laf:routine_time_invalid"),
      ),
      ...called(
        "gone",
        MANAGE_ROUTINE.name,
        { action: "delete", routineId: "주간 정산" },
        said("laf:routine_deleted"),
      ),
    ]);
    const refused = drawn.read("refused");
    expect(refused.text).toContain("Could not save a routine");
    expect(refused.text).not.toContain("Saved a routine");
    expect(refused.isWarned).toBe(true);
    expect(ko["Could not save a routine"]).toBe("루틴을 저장하지 못했어요");
    // And a call that went through is not said to have failed: the reading is of each call's own.
    const gone = drawn.read("gone");
    expect(gone.text).toContain("Deleted a routine");
    expect(gone.isWarned).toBe(false);
    await drawn.close();
  });

  test("a refused edit, a list that could not be read and a delete of nothing each say what did not happen", async () => {
    const drawn = await conversation([
      asking,
      ...called(
        "edit",
        MANAGE_ROUTINE.name,
        {
          action: "update",
          routineId: "아침 브리핑",
          schedule: { kind: "daily", time: "8시" },
        },
        said("laf:routine_time_invalid"),
      ),
      ...called(
        "list",
        MANAGE_ROUTINE.name,
        { action: "list" },
        said("laf:routine_list_unavailable"),
      ),
      ...called(
        "delete",
        MANAGE_ROUTINE.name,
        { action: "delete", routineId: "없는 루틴" },
        said("laf:routine_name_unknown").replace("{list}", "(없음)"),
      ),
      // A pause is the switch alone, and answers with its own sentence: it went through.
      ...called(
        "pause",
        MANAGE_ROUTINE.name,
        { action: "update", routineId: "아침 브리핑", enabled: false },
        said("laf:routine_paused"),
      ),
    ]);
    // What main's `routine-tool-edit` held of the window's handler: the line is marked failed.
    for (const [id, words] of [
      ["edit", "Could not change a routine"],
      ["list", "Could not look at its routines"],
      ["delete", "Could not delete a routine"],
    ] as const) {
      const line = drawn.read(id);
      expect([id, line.text?.includes(words), line.isWarned]).toEqual([
        id,
        true,
        true,
      ]);
      expect([words, typeof ko[words]]).toEqual([words, "string"]);
    }
    const pause = drawn.read("pause");
    expect(pause.text).toContain("Changed a routine");
    expect(pause.isWarned).toBe(false);
    await drawn.close();
  });

  test("a profile the server would not change says so", async () => {
    const drawn = await conversation([
      asking,
      ...called(
        "refused",
        UPDATE_PROFILE.name,
        { name: "" },
        said("laf:profile_invalid"),
      ),
      ...called(
        "changed",
        UPDATE_PROFILE.name,
        { name: "초롱" },
        said("laf:profile_updated"),
      ),
    ]);
    const refused = drawn.read("refused");
    expect(refused.text).toContain("Could not update its own profile");
    expect(refused.text).not.toContain("Updated its own profile");
    expect(refused.isWarned).toBe(true);
    expect(ko["Could not update its own profile"]).toBe(
      "자기 프로필을 바꾸지 못했어요",
    );
    const changed = drawn.read("changed");
    expect(changed.text).toContain("Updated its own profile");
    expect(changed.isWarned).toBe(false);
    await drawn.close();
  });

  test("a skill the Bot does not hold is not said to have been read", async () => {
    const drawn = await conversation([
      asking,
      ...called(
        "refused",
        SKILL_VIEW.name,
        { name: "재고 정리" },
        JSON.stringify({
          ok: false,
          code: "laf:skill_not_granted",
          reason: said("laf:skill_not_granted"),
        }),
      ),
      ...called(
        "read",
        SKILL_VIEW.name,
        { name: "주간 보고" },
        JSON.stringify({
          ok: true,
          slug: "weekly-report",
          title: "주간 보고",
          summary: "",
          instructions: "표로 정리한다.",
        }),
      ),
    ]);
    const refused = drawn.read("refused");
    expect(refused.text).toContain("Could not read a skill");
    expect(refused.text).not.toContain("Read a skill");
    expect(refused.isWarned).toBe(true);
    expect(ko["Could not read a skill"]).toBe("스킬을 읽지 못함");
    const read = drawn.read("read");
    expect(read.text).toContain("Read a skill");
    expect(read.isWarned).toBe(false);
    // The body is the Bot's to read, not the line's to print.
    expect(read.text).not.toContain("표로 정리한다.");
    await drawn.close();
  });

  test("a look at the clock a stop cut short is not said to have been taken", async () => {
    const drawn = await conversation([
      asking,
      ...called(
        "cut",
        NOW_TOOL_NAME,
        {},
        JSON.stringify({ ok: false, code: "laf:stopped", stopped: true }),
      ),
      ...called(
        "seen",
        NOW_TOOL_NAME,
        {},
        JSON.stringify({ now: "2026-10-05T09:00:00+09:00" }),
      ),
    ]);
    const cut = drawn.read("cut");
    expect(cut.text).toContain("Could not check the time");
    expect(cut.isWarned).toBe(true);
    expect(ko["Could not check the time"]).toBe("시각을 확인하지 못함");
    const seen = drawn.read("seen");
    expect(seen.text).toBe("Checked the time");
    expect(seen.isWarned).toBe(false);
    await drawn.close();
  });

  /*
   * What `sandboxed-refusal.test.tsx` held for the window, on the turn the server carries out: the
   * card is offered from a list read once a minute, and whether the Bot may draw it is asked again
   * when it calls (`component` in `server/src/turns/chat-tools.ts`).
   */
  test("a card switched off since the list was read shows the refusal, not the card — and the one drawn before it stays drawn", async () => {
    const SWITCHED_OFF =
      "That card is switched off for this Bot. It can be turned back on from the admin screen";
    const drawn = await conversation([
      asking,
      ...called("shown", CARD, {}, ON_SCREEN),
      ...called("refused", CARD, {}, said("laf:component_withheld")),
      ...called("unasked", CARD, {}, CARD_NOT_ASKED),
    ]);
    expect(drawn.read("shown")).toMatchObject({ frames: 1, refusal: null });
    const refused = drawn.read("refused");
    expect(refused.refusal).toContain(SWITCHED_OFF);
    expect(ko[SWITCHED_OFF]).toBeTruthy();
    expect(refused.frames).toBe(0);
    // And a card nobody could be asked about is not drawn either: the Bot was told it was not.
    const unasked = drawn.read("unasked");
    expect(unasked.frames).toBe(0);
    expect(unasked.isWarned).toBe(true);
    await drawn.close();
  });
});

/*
 * THE GALLERY'S OWN CARDS, BY THE FUNCTION THEIR RENDERER IS. The gallery is found through Vite
 * (`import.meta.glob`), so under `bun test` no gallery card is registered and none can be mounted
 * through the route; what a call is drawn as is decided by `CardCall`, which is drawn here.
 */
describe("a gallery card's call", () => {
  async function drawnAs(result: string | undefined, isHeld = true) {
    const { createElement } = await import("react");
    const { CardCall } = await import("../src/lib/copilot/gallery-tools");
    const view = await mount(
      createElement(CardCall, {
        Component: () => createElement("p", { "data-card": "" }, "매출 카드"),
        args: {},
        isHeld,
        result,
        title: "Record",
      }),
    );
    return {
      card: view.host.querySelector("[data-card]") !== null,
      refusal:
        view.host.querySelector('[data-testid="component-refused"]')
          ?.textContent ?? null,
      text: view.host.textContent ?? "",
      isWarned: view.host.querySelector('[class*="text-warning"]') !== null,
    };
  }

  test("is the card while it is out and once it is on screen", async () => {
    expect((await drawnAs(undefined)).card).toBe(true);
    expect(
      (await drawnAs("The record is now on screen for the person.")).card,
    ).toBe(true);
    // As a window's runtime stored a sentence, in a conversation from before 2026-10-05.
    expect(
      (
        await drawnAs(
          JSON.stringify("The record is now on screen for the person."),
        )
      ).card,
    ).toBe(true);
  });

  test("is not the card when the Bot was told it was not shown", async () => {
    const withheld = await drawnAs(
      TOOL_RESULT_KO["laf:component_withheld"] as string,
    );
    expect(withheld.card).toBe(false);
    expect(withheld.refusal).toContain(
      "That card is switched off for this Bot",
    );
    // A data source the card was not allowed, said in the person's words for it.
    const noData = await drawnAs(
      TOOL_RESULT_KO["laf:function_not_granted"] as string,
    );
    expect(noData.card).toBe(false);
    expect(noData.refusal).toContain(
      "That card has not been allowed to read this data",
    );
    // Stopped before it was shown, never answered, or nobody to ask: a line that says it did not
    // work, with the card's own name — never the card.
    for (const result of [
      JSON.stringify({ ok: false, code: "laf:stopped", stopped: true }),
      UNANSWERED_RESULT,
      CARD_NOT_ASKED,
      JSON.stringify({ ok: false, code: "laf:tool_unknown" }),
    ]) {
      const ended = await drawnAs(result);
      expect([result, ended.card, ended.isWarned]).toEqual([
        result,
        false,
        true,
      ]);
      expect(ended.text).toContain("Record, didn't work");
    }
  });

  test("a card this Bot no longer holds is refused whatever its call said", async () => {
    const taken = await drawnAs(
      "The record is now on screen for the person.",
      false,
    );
    expect(taken.card).toBe(false);
    expect(taken.refusal).toContain("is not switched on for this Bot");
  });
});
