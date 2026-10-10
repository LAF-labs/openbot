/**
 * WHAT A CALL TO A CONNECTED SERVICE SAYS TO THE BOT WHEN IT IS NOT CARRIED OUT — on the path that
 * carries it out.
 *
 * A window made these calls until 2026-10-05, over `/api/plugins/call`, and what it told the model
 * about a refusal or a failure was held by six tests of the window's own function. The server makes
 * the call now, inside the turn (`turns/chat-tools.ts`, `plugin` and `pluginFailure`), and nothing
 * held the same facts there: no test handed that code a refusal, a vendor's failure or a question.
 * The window's function is gone and its tests with it; the facts are the product's, so they are
 * held here, where they are true.
 *
 * What the Bot is told is always one of the table's sentences (`shared/prompt/tool-results.ko.ts`)
 * for a fact of ours — never the English an error carries for a log, and never a vendor's own
 * text — because what it is told is what it will say to the person.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type { Tool } from "@ag-ui/client";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import {
  stepFailureOf,
  TOOL_NOT_ALLOWED,
  toolErrorText,
} from "../../shared/tools/step-result";
import type { AgentActor } from "../src/agents/profile-types";
import type {
  ApprovalRegistry,
  PendingApproval,
} from "../src/computer/approvals";
import { McpServerError } from "../src/plugins/mcp";
import {
  BotNotDrivableError,
  CatalogueEntryUnknownError,
  PluginNeedsApprovalError,
  PluginRefusedError,
} from "../src/plugins/store";
import { createChatTools } from "../src/turns/chat-tools";
import { createPersonAnswers } from "../src/turns/people";
import { A_TOOL_CALL } from "./support/subjects";

const owner: AgentActor = { id: "owner-1", role: "user" };
const context = {
  botId: "bot-1",
  owner,
  threadId: "thread-1",
  runId: "run-1",
};

const REF = "google-sheets/append_sheet_row";
const TOOL: Tool = {
  name: "mcp__google-sheets__append_sheet_row",
  description: "표에 한 줄을 더한다",
  parameters: {},
};
const ARGS = { sheet: "9월 정산", row: ["유자청", 15000] };

type Sent = Record<string, unknown>;
type Registry = Pick<ApprovalRegistry, "hold" | "withdraw">;

/** A turn that was offered the one tool, with the store's `callTool` answered by the test. */
async function turn(
  callTool: (sent: Sent, sentBefore: number) => Promise<unknown>,
  approvals?: Registry,
) {
  const sent: Sent[] = [];
  const pluginStore = {
    offeredToModel: async () => ({
      tools: [
        {
          ref: REF,
          toolName: TOOL.name,
          description: TOOL.description,
          inputSchema: {},
        },
      ],
      skills: [],
    }),
    callTool: async (input: Sent) => {
      sent.push(input);
      return callTool(input, sent.length - 1);
    },
    viewSkill: async () => ({
      allowed: false,
      reason: "laf:skill_not_granted",
    }),
  } as unknown as Parameters<typeof createChatTools>[0]["pluginStore"];
  const toolkit = await createChatTools({
    pluginStore,
    people: createPersonAnswers(),
    ...(approvals ? { approvals } : {}),
  })(context, [TOOL]);
  return {
    sent,
    call: (signal: AbortSignal = new AbortController().signal) =>
      toolkit.execute(TOOL.name, ARGS, { id: "call-1", signal }),
  };
}

/** The store refusing or failing the call outright. */
const throwing = (error: unknown) => async () => {
  throw error;
};

/** The question the boundary raised about the call. */
const ASKED: PendingApproval = {
  id: "approval-1",
  botId: "bot-1",
  actor: "owner-1",
  rule: "laf:external",
  subject: A_TOOL_CALL,
  target: { type: "plugin_tool", id: REF },
  fingerprint: "the-call-as-it-was-asked-about",
  requestedAt: "2026-10-06T00:00:00.000Z",
  expiresAt: "2026-10-06T00:10:00.000Z",
};

/** The store asking a person first, until the call arrives with that question's answer on it. */
const askingFirst =
  (answer: () => Promise<unknown>) =>
  async (sent: Sent, sentBefore: number) => {
    if (sentBefore === 0 || sent.approvalId !== ASKED.id) {
      throw new PluginNeedsApprovalError(ASKED);
    }
    return answer();
  };

/** A registry whose question is found as the test says it is, every time it is looked at. */
function registry(found: () => ReturnType<Registry["hold"]>) {
  const asked: { id: string; botId: string; holder: string }[] = [];
  const withdrawn: string[] = [];
  const approvals: Registry = {
    hold: async (id, botId, holder) => {
      asked.push({ id, botId, holder });
      return found();
    },
    withdraw: async (id) => {
      withdrawn.push(id);
      return undefined;
    },
  };
  return { approvals, asked, withdrawn };
}
const answered = (granted: boolean) => async () =>
  ({
    ok: true,
    holding: true,
    approval: { ...ASKED, granted },
  }) as const;

/** The log's own lines, kept off the test's output: a failed call is said to an operator too. */
function quietly<T>(
  work: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((level) =>
    spyOn(console, level).mockImplementation((line: unknown) => {
      lines.push(String(line));
    }),
  );
  return work()
    .then((value) => ({ value, lines }))
    .finally(() => {
      for (const spy of spies) spy.mockRestore();
    });
}

describe("a call that was carried out", () => {
  test("is the service's own answer, and its own error is marked as one", async () => {
    const fine = await turn(async () => ({
      text: "3행을 더했다",
      isError: false,
    }));
    expect(await fine.call()).toBe("3행을 더했다");
    // What the store is handed: the call as the Bot made it, as this Bot, for this person, on this
    // line of this conversation — and as a step of this turn's run, which a question about it is
    // counted under.
    expect(fine.sent).toEqual([
      {
        ref: REF,
        args: ARGS,
        botId: "bot-1",
        actorId: "owner-1",
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "call-1",
        actorIsAdmin: false,
        drawnOn: "conversation",
      },
    ]);

    const complaining = await turn(async () => ({
      text: "quota exceeded",
      isError: true,
    }));
    const said = await complaining.call();
    expect(said).toBe(toolErrorText("quota exceeded"));
    // The service answered: its words are kept, and the line says it was the service's error.
    expect(stepFailureOf(said as string)).toEqual({
      kind: "error",
      text: "quota exceeded",
    });
  });
});

describe("a call the deployment refused", () => {
  /*
   * The window read `code` before `error` for this: a connection's refusal carries the fact in its
   * code and an English sentence for the log beside it, and for a while a Korean-speaking person's
   * Bot was reading the English out. Here the error is the store's own, and its code is what is
   * said.
   */
  test("reaches the Bot as the words for its fact, never the sentence the error carries", async () => {
    const refused = await turn(
      throwing(
        new PluginRefusedError(
          "You have not connected your Google Sheets account.",
          null,
          "laf:not_connected",
        ),
      ),
    );
    const said = await refused.call();
    expect(said).toBe(toolResultText("laf:not_connected"));
    expect(said).not.toContain("You have not connected");
    // Asked once: a refusal is final, and the same call sent again would be refused the same way.
    expect(refused.sent).toHaveLength(1);
  });

  test("a lapsed connection is the Korean for connecting again", async () => {
    const lapsed = await turn(
      throwing(
        new PluginRefusedError(
          "Your Google Sheets connection has stopped working.",
          null,
          "laf:needs_reconnect",
        ),
      ),
    );
    const said = (await lapsed.call()) as string;
    expect(said).toBe(toolResultText("laf:needs_reconnect"));
    // And that Korean says the one thing that helps.
    expect(said).toContain("설정 › 연결");
    // Nobody said no: an account to connect again is a step that did not work, not a refusal.
    expect(stepFailureOf(said)).toEqual({
      kind: "failed",
      code: "laf:needs_reconnect",
    });
  });

  test("the boundary's own no, a server that is gone, a definition held for review and a Bot that is not this person's are each their own words", async () => {
    for (const [error, code, kind] of [
      [
        new PluginRefusedError(
          "laf:policy_denied",
          "deny.write",
          "laf:policy_denied",
        ),
        "laf:policy_denied",
        "refused",
      ],
      [
        new CatalogueEntryUnknownError("notion"),
        "laf:server_unknown",
        "failed",
      ],
      [
        new PluginRefusedError(
          "'append_sheet_row' changed its definition since it was approved.",
          null,
          "laf:tool_needs_review",
        ),
        "laf:tool_needs_review",
        "refused",
      ],
      [new BotNotDrivableError(), "laf:bot_not_found", "failed"],
    ] as const) {
      const said = (await (await turn(throwing(error))).call()) as string;
      expect([code, said]).toEqual([code, toolResultText(code)]);
      // The table has words for every one of them: none is handed over as a bare `laf:` code.
      expect([code, said.startsWith("laf:")]).toEqual([code, false]);
      expect([code, stepFailureOf(said)]).toEqual([code, { kind, code }]);
    }
  });

  /*
   * THE WINDOW DID THE OPPOSITE, AND THIS IS THE SERVER'S ANSWER. A refusal that carried no fact
   * of ours was passed to the model as whatever sentence it came with, "because an English sentence
   * from somewhere upstream is a regression worth seeing". The server does not hand the Bot a
   * sentence nobody here wrote: it says the tool is not allowed here, which the transcript reads as
   * a refusal.
   */
  test("a refusal with no fact of ours says only that the tool is not allowed here", async () => {
    const said = await (
      await turn(
        throwing(
          new PluginRefusedError(
            "Something upstream wrote this.",
            null,
            "not_one_of_ours",
          ),
        ),
      )
    ).call();
    expect(said).toBe(TOOL_NOT_ALLOWED);
    expect(stepFailureOf(said as string)).toEqual({
      kind: "refused",
      code: null,
    });
  });
});

describe("a call the service's server failed", () => {
  test("is a failure, in the Bot's words for one — never the vendor's text, and not a refusal", async () => {
    for (const error of [
      new McpServerError(
        "Google Sheets API has not been used in project 123 before or it is disabled.",
        403,
      ),
      new Error("socket hang up"),
      "not even an error",
    ]) {
      const failed = await turn(throwing(error));
      const { value: said, lines } = await quietly(() => failed.call());
      expect(said).toBe(toolResultText("laf:tool_server_failed"));
      expect(said).not.toContain("Google Sheets API");
      // A boundary did not stop it; somebody else's software broke.
      expect(stepFailureOf(said as string)).toEqual({
        kind: "failed",
        code: "laf:tool_server_failed",
      });
      // An operator is told which tool, once. The arguments are not in the line.
      const told = lines.filter((line) => line.includes("plugin_call_failed"));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(REF);
      expect(told[0]).not.toContain("유자청");
    }
  });
});

describe("a call a person is asked about first", () => {
  test("answered yes: the identical call is sent once more with the answer on it, and its answer is the result", async () => {
    const { approvals, asked } = registry(answered(true));
    const asking = await turn(
      askingFirst(async () => ({ text: "한 줄을 더했다", isError: false })),
      approvals,
    );
    expect(await asking.call()).toBe("한 줄을 더했다");
    // The question is held by the turn, by its run, for this Bot.
    expect(asked).toEqual([
      { id: "approval-1", botId: "bot-1", holder: "turn:run-1" },
    ]);
    // Twice, and the second differs from the first by the approval alone: the answer is bound to
    // a fingerprint of the call, arguments included.
    expect(asking.sent).toHaveLength(2);
    expect(asking.sent[0]).not.toHaveProperty("approvalId");
    expect(asking.sent[1]).toEqual({
      ...asking.sent[0],
      approvalId: "approval-1",
    });
  });

  test("answered no: the Bot is told a person declined, and the call is not sent again", async () => {
    const { approvals } = registry(answered(false));
    const asking = await turn(
      askingFirst(async () => ({ text: "한 줄을 더했다", isError: false })),
      approvals,
    );
    const said = (await asking.call()) as string;
    expect(said).toBe(toolResultText("laf:person_declined"));
    expect(stepFailureOf(said)).toEqual({
      kind: "refused",
      code: "laf:person_declined",
    });
    expect(asking.sent).toHaveLength(1);
  });

  test("nobody answers: the Bot is told so, and the call is not sent again", async () => {
    // The question ran out and was swept: holding it answers that nothing is open.
    const gone = registry(async () => ({ ok: false }) as const);
    const asking = await turn(
      askingFirst(async () => ({ text: "한 줄을 더했다", isError: false })),
      gone.approvals,
    );
    const said = (await asking.call()) as string;
    expect(said).toBe(toolResultText("laf:nobody_answered"));
    expect(stepFailureOf(said)).toEqual({
      kind: "failed",
      code: "laf:nobody_answered",
    });
    expect(asking.sent).toHaveLength(1);

    // And the same with no registry at all: there is nobody to ask.
    const nowhere = await turn(
      askingFirst(async () => ({ text: "한 줄을 더했다", isError: false })),
    );
    expect(await nowhere.call()).toBe(toolResultText("laf:nobody_answered"));
    expect(nowhere.sent).toHaveLength(1);
  });

  /*
   * A yes that did not fit the call. Looping on it would hold the turn open until its deadline
   * instead of telling the Bot something it can act on, so a question raised on the retry is said,
   * not waited on a second time.
   */
  test("a yes the call still stops on: the Bot is told the answer did not fit, and nothing is asked again", async () => {
    const { approvals, asked } = registry(answered(true));
    const asking = await turn(async () => {
      throw new PluginNeedsApprovalError(ASKED);
    }, approvals);
    expect(await asking.call()).toBe(
      toolResultText("laf:approval_did_not_fit"),
    );
    expect(asking.sent).toHaveLength(2);
    expect(asked).toHaveLength(1);
  });

  test("a yes, and then the call is refused or fails: said like any other refusal or failure", async () => {
    const { approvals } = registry(answered(true));
    const refusedAfter = await turn(async (_sent, sentBefore) => {
      if (sentBefore === 0) throw new PluginNeedsApprovalError(ASKED);
      throw new PluginRefusedError(
        "laf:policy_denied",
        null,
        "laf:policy_denied",
      );
    }, approvals);
    expect(await refusedAfter.call()).toBe(toolResultText("laf:policy_denied"));

    const failedAfter = await turn(async (_sent, sentBefore) => {
      if (sentBefore === 0) throw new PluginNeedsApprovalError(ASKED);
      throw new McpServerError("upstream connect error", 502);
    }, approvals);
    const { value } = await quietly(() => failedAfter.call());
    expect(value).toBe(toolResultText("laf:tool_server_failed"));
  });

  test("stopped while the person decides: the question is withdrawn and the Bot is told it was stopped", async () => {
    const stop = new AbortController();
    const { approvals, withdrawn } = registry(async () => {
      // 멈춤 pressed while the card is up, before anybody answered it.
      stop.abort();
      return { ok: true, holding: true, approval: ASKED } as const;
    });
    const asking = await turn(
      askingFirst(async () => ({ text: "한 줄을 더했다", isError: false })),
      approvals,
    );
    expect(await asking.call(stop.signal)).toBe(toolResultText("laf:stopped"));
    expect(withdrawn).toEqual(["approval-1"]);
    expect(asking.sent).toHaveLength(1);
  });

  test("a yes and a stop together: the yes is not carried out", async () => {
    const stop = new AbortController();
    const { approvals } = registry(async () => {
      stop.abort();
      return {
        ok: true,
        holding: true,
        approval: { ...ASKED, granted: true },
      } as const;
    });
    const asking = await turn(
      askingFirst(async () => ({ text: "한 줄을 더했다", isError: false })),
      approvals,
    );
    expect(await asking.call(stop.signal)).toBe(toolResultText("laf:stopped"));
    expect(asking.sent).toHaveLength(1);
  });
});
