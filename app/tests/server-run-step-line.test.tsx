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
  stepFailureOf,
  TOOL_NOT_ALLOWED,
  toolErrorText,
  toolFailureText,
} from "@shared/tools/step-result";
import { withheldMark } from "@shared/tools/withheld";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
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
const step = (id: string, result: string): Message[] => [
  {
    id: `a-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      { id, type: "function", function: { name: TOOL, arguments: "{}" } },
    ],
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
    expect(stepFailureOf(JSON.stringify({ ok: false }))).toEqual({
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
    // The renderer is registered once the Bot's grants have been read.
    await view.waitFor(
      () => log()?.textContent?.includes("Gmail") === true,
      "the tool's own line",
      8000,
    );
    return {
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
    const line = drawn.read("broke");
    expect(line.text).toContain("Reading a mail, didn't work");
    expect(line.isWarned).toBe(true);
    expect(line.opens).toBe(true);
    expect(line.text).toContain("quota exceeded");
    await drawn.close();
  });

  test("says a step was blocked in a person's words, and never in the sentence written for the model", async () => {
    const drawn = await rows([
      { id: "q", role: "user", content: "메일 읽어줘" },
      ...step("denied", POLICY_DENIED),
      ...step("down", SERVER_FAILED),
      ...step("fine", "메일 2통을 찾았어요."),
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
});
