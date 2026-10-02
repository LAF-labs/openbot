/**
 * A chat turn's tools, carried out on the server (`turns/chat-tools.ts`).
 *
 * The window used to carry these out, and the model read what the window's handlers answered. The
 * server answers now, and must answer the same: the same envelope for a page, the same refusal for a
 * boundary, the same wait for a person — and a question held here, not in some window that may
 * close.
 */
import { describe, expect, test } from "bun:test";
import type { Tool } from "@ag-ui/client";
import { createControl } from "../../agent-computer/src/control";
import { PERSON_WAIT_MS } from "../../shared/person-wait";
import {
  routineListResult,
  toolResultText,
} from "../../shared/prompt/tool-results.ko";
import type { AgentActor } from "../src/agents/profile-types";
import { createApprovalRegistry } from "../src/computer/approvals";
import {
  ComputerUnavailableError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  type ComputerGateway,
} from "../src/computer/gateway";
import type { RoutineService } from "../src/routines/service";
import { createChatTools, routineAction } from "../src/turns/chat-tools";
import { createPersonAnswers } from "../src/turns/people";
import { LIST_GOALS } from "../../shared/tools/goals";
import { A_CLICK } from "./support/subjects";

const owner: AgentActor = { id: "owner-1", role: "user" };
const context = {
  botId: "bot-1",
  owner,
  threadId: "thread-1",
  runId: "run-1",
};
const call = (id = "call-1") => ({
  id,
  signal: new AbortController().signal,
});
const tool = (name: string): Tool => ({
  name,
  description: name,
  parameters: {},
});

describe("which tools a turn offers", () => {
  test("the window's list, cut to what this server can carry out", async () => {
    const toolkit = await createChatTools({
      gateway: {} as unknown as ComputerGateway,
      people: createPersonAnswers(),
    })(context, [
      tool("computer_navigate"),
      tool("computer_request_help"),
      tool("somebody_elses_tool"),
    ]);
    expect(toolkit.tools.map((offered) => offered.name)).toEqual([
      "computer_navigate",
      "computer_request_help",
    ]);
    expect(await toolkit.execute("somebody_elses_tool", {}, call())).toEqual({
      ok: false,
      code: "laf:tool_unknown",
      reason: toolResultText("laf:tool_unknown"),
    });
  });

  test("no computer, no computer tools — whatever the window offered", async () => {
    const toolkit = await createChatTools({ people: createPersonAnswers() })(
      context,
      [tool("computer_navigate")],
    );
    expect(toolkit.tools).toEqual([]);
  });
});

describe("a computer call, answered as the window answered it", () => {
  test("a page comes back as the page, cut to what the window kept", async () => {
    const gateway = {
      navigate: async () => ({
        title: "예시",
        url: "https://example.com/",
        text: "본문",
        truncated: false,
        loadMs: 12,
      }),
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
    })(context, [tool("computer_navigate")]);
    expect(
      await toolkit.execute(
        "computer_navigate",
        { url: "https://example.com" },
        call(),
      ),
    ).toEqual({
      ok: true,
      title: "예시",
      url: "https://example.com/",
      text: "본문",
      truncated: false,
    });
  });

  test("a boundary's no is a refusal with its rule, in the model's words", async () => {
    const gateway = {
      click: async () => {
        throw new ActionRefusedError("page.host == 'x'", "laf:policy_denied");
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
    })(context, [tool("computer_click")]);
    expect(
      await toolkit.execute(
        "computer_click",
        { ref: "e1", snapshotId: 1 },
        call(),
      ),
    ).toEqual({
      ok: false,
      code: "laf:policy_denied",
      reason: toolResultText("laf:policy_denied"),
      refused: true,
      rule: "page.host == 'x'",
    });
  });

  test("a question waits here for a person, and the call goes again with the answer on it", async () => {
    const approvals = createApprovalRegistry();
    const question = await approvals.request({
      botId: "bot-1",
      actor: owner.id,
      rule: "ask",
      subject: A_CLICK,
      fingerprint: "f",
      step: { threadId: "thread-1", toolCallId: "call-7" },
      target: { type: "computer", id: "bot-1" },
    });
    const presented: Array<string | undefined> = [];
    const gateway = {
      click: async (
        _computer: string,
        _bot: string,
        actor: { threadId?: string; toolCallId?: string },
        _target: unknown,
        _signal: unknown,
        approvalId?: string,
      ) => {
        presented.push(approvalId);
        // The call names its conversation and its step, so every window can draw the question.
        expect(actor).toMatchObject({
          threadId: "thread-1",
          toolCallId: "call-7",
        });
        if (!approvalId) throw new ActionNeedsApprovalError(question);
        return { action: "click", ok: true };
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      approvals,
      people: createPersonAnswers(),
    })(context, [tool("computer_click")]);
    const pending = toolkit.execute(
      "computer_click",
      { ref: "e1", snapshotId: 1 },
      call("call-7"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Held by the turn, so an older window does not carry the step on beside it.
    const [open] = await approvals.pending("bot-1");
    expect(open?.holder?.id).toBe("turn:run-1");
    await approvals.answer(question.id, "bot-1", owner.id, true);
    expect(await pending).toEqual({ ok: true, action: "click" });
    expect(presented).toEqual([undefined, question.id]);
  });

  test("a no from the person is the person's no", async () => {
    const approvals = createApprovalRegistry();
    const question = await approvals.request({
      botId: "bot-1",
      actor: owner.id,
      rule: "ask",
      subject: A_CLICK,
      fingerprint: "f2",
      target: { type: "computer", id: "bot-1" },
    });
    const gateway = {
      click: async () => {
        throw new ActionNeedsApprovalError(question);
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      approvals,
      people: createPersonAnswers(),
    })(context, [tool("computer_click")]);
    const pending = toolkit.execute(
      "computer_click",
      { ref: "e1", snapshotId: 1 },
      call(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await approvals.answer(question.id, "bot-1", owner.id, false);
    expect(await pending).toEqual({
      ok: false,
      code: "laf:person_declined",
      reason: toolResultText("laf:person_declined"),
      refused: true,
    });
  });

  test("a stop while waiting ends the wait and takes the question back", async () => {
    const approvals = createApprovalRegistry();
    const question = await approvals.request({
      botId: "bot-1",
      actor: owner.id,
      rule: "ask",
      subject: A_CLICK,
      fingerprint: "f3",
      target: { type: "computer", id: "bot-1" },
    });
    const gateway = {
      click: async () => {
        throw new ActionNeedsApprovalError(question);
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      approvals,
      people: createPersonAnswers(),
    })(context, [tool("computer_click")]);
    const stop = new AbortController();
    const pending = toolkit.execute(
      "computer_click",
      { ref: "e1", snapshotId: 1 },
      { id: "call-1", signal: stop.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    expect(await pending).toEqual({
      ok: false,
      code: "laf:stopped",
      reason: toolResultText("laf:stopped"),
      stopped: true,
    });
    expect(await approvals.pending("bot-1")).toEqual([]);
  });

  test("a help request waits until the wheel is back, or a person skips it", async () => {
    let control = { holder: "bot", requested: true };
    const gateway = {
      requestHelp: async () => control,
      control: async () => control,
    } as unknown as ComputerGateway;
    const people = createPersonAnswers();
    const toolkit = await createChatTools({
      gateway,
      people,
      controlPollMs: 10,
    })(context, [tool("computer_request_help")]);
    const handedBack = toolkit.execute(
      "computer_request_help",
      { reason: "로그인" },
      call("help-1"),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    control = { holder: "bot", requested: false };
    expect(await handedBack).toEqual({
      ok: true,
      code: "laf:control_returned",
      result: toolResultText("laf:control_returned"),
    });
    control = { holder: "bot", requested: true };
    const skipped = toolkit.execute(
      "computer_request_help",
      { reason: "로그인" },
      call("help-2"),
    );
    people.skip("help-2");
    expect(await skipped).toMatchObject({ code: "laf:help_skipped" });
  });

  describe("against the computer's own state, which lets an unanswered ask go", () => {
    /*
     * THE WAIT READS AN ASK THAT IS GONE AS AN ASK THAT WAS ANSWERED, and since 2026-10-02 the
     * computer lets go of one nobody answered (`REQUEST_TTL_MS`, upstream OpenBot #145 and #457).
     * Measured with that time set a minute short of this wait: these two answered
     * `laf:control_returned` and `laf:secret_entered`, about a person who never came.
     *
     * The real state machine behind the gateway, on a clock that runs the wait's ten minutes in
     * the second this test gives it, so every look the wait takes is a look at the ask as the
     * computer would hold it then. (A second, not less: the margin between the two numbers is a
     * fifth of it here, and a stall that long under a loaded run is not this code's failure.) The
     * edge itself — at exactly the wait's own time, where a look lands only now and then — is
     * pinned on the machine, in `agent-computer/tests/control.test.ts`.
     */
    const WAIT_MS = 1_000;
    const waitedOut = async (
      name: "computer_request_help" | "computer_request_secret",
      args: Record<string, unknown>,
    ) => {
      const started = Date.now();
      const control = createControl(() =>
        new Date(
          Date.parse("2026-10-02T03:00:00.000Z") +
            (Date.now() - started) * (PERSON_WAIT_MS / WAIT_MS),
        ).toISOString(),
      );
      const gateway = {
        requestHelp: async (
          _computer: string,
          _bot: string,
          _actor: unknown,
          reason: string,
        ) => control.requestHelp(reason),
        requestSecret: async (
          _computer: string,
          _bot: string,
          _actor: unknown,
          input: { label: string; ref: string; snapshotId: number },
        ) => control.requestSecret(input),
        control: async () => control.get(),
      } as unknown as ComputerGateway;
      const toolkit = await createChatTools({
        gateway,
        people: createPersonAnswers(),
        personWaitMs: WAIT_MS,
        controlPollMs: 20,
      })(context, [tool(name)]);
      return toolkit.execute(name, args, call(`${name}-unanswered`));
    };

    test("nobody taking the wheel is nobody taking the wheel", async () => {
      expect(
        await waitedOut("computer_request_help", { reason: "로그인" }),
      ).toEqual({
        ok: true,
        code: "laf:nobody_took_control",
        result: toolResultText("laf:nobody_took_control"),
      });
    });

    test("a value nobody typed is a value nobody typed", async () => {
      expect(
        await waitedOut("computer_request_secret", {
          label: "인증번호",
          ref: "e12",
          snapshotId: 4,
        }),
      ).toEqual({
        ok: true,
        code: "laf:secret_not_entered",
        result: toolResultText("laf:secret_not_entered"),
      });
    });
  });
});

describe("a wait on a person while the Bot is let go of", () => {
  const moved = {
    ...context,
    awaitPerson: async <T>(wait: () => Promise<T>) => ({
      value: await wait(),
      moved: true,
    }),
  };

  test("a yes given while a routine drove the Bot is not spent on a page that moved", async () => {
    // Review H1: the lane is let go of for the wait, and the page under the ref may be another.
    const approvals = createApprovalRegistry();
    const question = await approvals.request({
      botId: "bot-1",
      actor: owner.id,
      rule: "ask",
      subject: A_CLICK,
      fingerprint: "f-moved",
      target: { type: "computer", id: "bot-1" },
    });
    let clicks = 0;
    const gateway = {
      click: async () => {
        clicks += 1;
        throw new ActionNeedsApprovalError(question);
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      approvals,
      people: createPersonAnswers(),
    })(moved, [tool("computer_click")]);
    const pending = toolkit.execute(
      "computer_click",
      { ref: "e1", snapshotId: 1 },
      call(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await approvals.answer(question.id, "bot-1", owner.id, true);
    expect(await pending).toEqual({
      ok: false,
      code: "laf:stale_refs",
      reason: toolResultText("laf:stale_refs"),
      staleRefs: true,
    });
    expect(clicks).toBe(1);
  });

  test("a yes followed by 멈춤 while the Bot was taken back is not carried out (2026-09-27 code sprint)", async () => {
    const approvals = createApprovalRegistry();
    const question = await approvals.request({
      botId: "bot-1",
      actor: owner.id,
      rule: "ask",
      subject: A_CLICK,
      fingerprint: "f-stopped",
      target: { type: "computer", id: "bot-1" },
    });
    let clicks = 0;
    const gateway = {
      click: async () => {
        clicks += 1;
        throw new ActionNeedsApprovalError(question);
      },
    } as unknown as ComputerGateway;
    const stop = new AbortController();
    // The wait ends with a yes, and the stop wins the race for the lane before the Bot is back.
    const stoppedOnTheWayBack = {
      ...context,
      awaitPerson: async <T>(wait: () => Promise<T>) => {
        const value = await wait();
        stop.abort();
        return { value, moved: false };
      },
    };
    const toolkit = await createChatTools({
      gateway,
      approvals,
      people: createPersonAnswers(),
    })(stoppedOnTheWayBack, [tool("computer_click")]);
    const pending = toolkit.execute(
      "computer_click",
      { ref: "e1", snapshotId: 1 },
      { id: "call-stop", signal: stop.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await approvals.answer(question.id, "bot-1", owner.id, true);
    expect(await pending).toMatchObject({ ok: false, code: "laf:stopped" });
    expect(clicks).toBe(1);
  });

  test("an address is not the page: a navigation the person allowed still goes", async () => {
    const approvals = createApprovalRegistry();
    const question = await approvals.request({
      botId: "bot-1",
      actor: owner.id,
      rule: "ask",
      subject: A_CLICK,
      fingerprint: "f-nav",
      target: { type: "computer", id: "bot-1" },
    });
    const gateway = {
      navigate: async (
        _computer: string,
        _bot: string,
        _actor: unknown,
        _url: string,
        approvalId?: string,
      ) => {
        if (!approvalId) throw new ActionNeedsApprovalError(question);
        return {
          title: "토스",
          url: "https://toss.im/",
          text: "",
          truncated: false,
        };
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      approvals,
      people: createPersonAnswers(),
    })(moved, [tool("computer_navigate")]);
    const pending = toolkit.execute(
      "computer_navigate",
      { url: "https://toss.im" },
      call(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await approvals.answer(question.id, "bot-1", owner.id, true);
    expect(await pending).toMatchObject({ ok: true, url: "https://toss.im/" });
  });

  test("the wheel back after somebody else drove the Bot says to look again", async () => {
    const gateway = {
      requestHelp: async () => ({ holder: "bot", requested: true }),
      control: async () => ({ holder: "bot", requested: false }),
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      controlPollMs: 10,
    })(moved, [tool("computer_request_help")]);
    expect(
      await toolkit.execute(
        "computer_request_help",
        { reason: "로그인" },
        call(),
      ),
    ).toEqual({
      ok: true,
      code: "laf:control_returned",
      result: toolResultText("laf:control_returned"),
      notes: toolResultText("laf:stale_refs"),
    });
  });
});

describe("the arguments a route would refuse, refused here too", () => {
  test("a tab by a number that is not whole, and a file with no name", async () => {
    // Review L5: the routes check these (`computer/routes.ts`); the turn's door did not.
    const gateway = {} as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
    })(context, [tool("computer_switch_tab"), tool("computer_write_file")]);
    const invalid = {
      ok: false,
      code: "laf:tool_arguments_invalid",
      reason: toolResultText("laf:tool_arguments_invalid"),
    };
    expect(
      await toolkit.execute("computer_switch_tab", { index: 1.5 }, call()),
    ).toEqual(invalid);
    expect(
      await toolkit.execute(
        "computer_write_file",
        { path: "   ", contents: "x" },
        call(),
      ),
    ).toEqual(invalid);
  });

  test("a path is trimmed as the route trims it", async () => {
    const paths: unknown[] = [];
    const gateway = {
      listFiles: async (
        _computer: string,
        _bot: string,
        _actor: unknown,
        input: unknown,
      ) => {
        paths.push(input);
        return { entries: [] };
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
    })(context, [tool("computer_list_files")]);
    await toolkit.execute("computer_list_files", { path: " 영수증 " }, call());
    await toolkit.execute("computer_list_files", { path: "  " }, call());
    expect(paths).toEqual([{ path: "영수증" }, {}]);
  });
});

describe("a Bot's grants that could not be read", () => {
  test("keep the tools the last turn had, so the list does not drop and come back", async () => {
    // Review L3: a failed listing dropped the plugin tools for a turn and changed the epoch twice.
    let fail = false;
    const pluginStore = {
      listForAgent: async () => {
        if (fail) throw new Error("the database blinked");
        return {
          tools: [
            {
              ref: "mail/send",
              toolName: "mail_send",
              description: "send",
              inputSchema: {},
            },
          ],
          skills: [],
        };
      },
      callTool: async () => ({ text: "sent", isError: false }),
      viewSkill: async () => ({
        allowed: false,
        reason: "laf:skill_not_granted",
      }),
    } as unknown as Parameters<typeof createChatTools>[0]["pluginStore"];
    const tools = createChatTools({
      pluginStore,
      people: createPersonAnswers(),
    });
    const first = await tools(context, [tool("mail_send")]);
    fail = true;
    const second = await tools(context, [tool("mail_send")]);
    expect(first.tools.map((offered) => offered.name)).toEqual(["mail_send"]);
    expect(second.tools.map((offered) => offered.name)).toEqual(["mail_send"]);
    expect(await second.execute("mail_send", {}, call())).toBe("sent");
  });
});

describe("a connected tool that is in the schema: the web search", () => {
  const searchStore = {
    listForAgent: async () => ({
      tools: [
        {
          ref: "web-search/search",
          toolName: "mcp__web-search__search",
          description: "웹을 검색한다",
          inputSchema: { type: "object", properties: { queries: {} } },
        },
        {
          ref: "gmail/search_messages",
          toolName: "mcp__gmail__search_messages",
          description: "메일을 찾는다",
          inputSchema: { type: "object" },
        },
      ],
      skills: [],
    }),
    callTool: async () => ({ text: "{}", isError: false }),
    viewSkill: async () => ({
      allowed: false,
      reason: "laf:skill_not_granted",
    }),
  } as unknown as Parameters<typeof createChatTools>[0]["pluginStore"];

  test("is offered as the server knows it, whether or not the window had read its list yet", async () => {
    const tools = createChatTools({
      pluginStore: searchStore,
      people: createPersonAnswers(),
    });
    // A window that had not loaded its plugin list: it declared nothing of the kind.
    const early = await tools(context, [tool("skill_view")]);
    // The same window a message later, with a copy of its own — stale words and all.
    const later = await tools(context, [
      tool("skill_view"),
      {
        name: "mcp__web-search__search",
        description: "an older description",
        parameters: {},
      },
      tool("mcp__gmail__search_messages"),
    ]);
    const search = (toolkit: Awaited<ReturnType<typeof tools>>) =>
      toolkit.tools.find(
        (offered) => offered.name === "mcp__web-search__search",
      );
    // The head of the prompt is the same both times: the server's own definition.
    expect(search(early)).toEqual({
      name: "mcp__web-search__search",
      description: "웹을 검색한다",
      parameters: { type: "object", properties: { queries: {} } },
    });
    expect(search(later)).toEqual(search(early));
    // A tool behind the bridge is still the window's to declare: absent early, present later.
    expect(early.tools.map((offered) => offered.name)).toEqual([
      "skill_view",
      "mcp__web-search__search",
    ]);
    expect(later.tools.map((offered) => offered.name)).toEqual([
      "skill_view",
      "mcp__gmail__search_messages",
      "mcp__web-search__search",
    ]);
  });
});

describe("a card the Bot asks the person with", () => {
  test("its answer is the call's result, from whichever window pressed it", async () => {
    // Every window is told when a card starts waiting and when it stops (`waiting` frames).
    const told: string[] = [];
    const people = createPersonAnswers({
      onChange: (threadId) => told.push(threadId),
    });
    const components = {
      listForAgent: async () => [
        {
          name: "askChoice",
          title: "Choice",
          kind: "decision",
          description: "d",
        },
      ],
      decide: async () => ({ allowed: true as const, description: "d" }),
      mayCall: async () => true,
    };
    const toolkit = await createChatTools({ people, components })(context, [
      tool("askChoice"),
    ]);
    const pending = toolkit.execute(
      "askChoice",
      {
        title: "어느 쪽?",
        options: [
          { id: "a", label: "이쪽" },
          { id: "b", label: "저쪽" },
        ],
      },
      call("choice-1"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(people.awaiting("thread-1")).toEqual(["choice-1"]);
    // Another conversation cannot answer it.
    expect(people.answer("thread-2", "choice-1", { choice: "b" })).toBe(false);
    expect(people.answer("thread-1", "choice-1", { choice: "a" })).toBe(true);
    expect(await pending).toBe('{"choice":"a"}');
    expect(told).toEqual(["thread-1", "thread-1"]);
    expect(people.awaiting("thread-1")).toEqual([]);
  });

  /*
   * A QUESTION WITH NOTHING IN IT IS NOT ASKED. Pressed on the running app, 2026-10-03: the
   * fleet's model called `askChoice` with `{}`, and the turn waited on it — a card with no title
   * and no options saying 답을 기다려요, for the ten minutes a question may wait.
   */
  describe("a question with nothing in it", () => {
    const cards = {
      listForAgent: async () => [
        {
          name: "askChoice",
          title: "Choice",
          kind: "decision",
          description: "d",
        },
        {
          name: "askApproval",
          title: "Approval",
          kind: "decision",
          description: "d",
        },
      ],
      decide: async () => ({ allowed: true as const, description: "d" }),
      mayCall: async () => true,
    };
    const refused = {
      ok: false,
      code: "laf:tool_arguments_invalid",
    };
    const option = { id: "a", label: "이쪽" };

    for (const [name, args] of [
      ["askChoice", {}],
      ["askChoice", { title: "어느 쪽?" }],
      ["askChoice", { title: "어느 쪽?", options: [] }],
      ["askChoice", { title: "", options: [option] }],
      ["askChoice", { title: "어느 쪽?", options: [{ id: "a", label: "" }] }],
      ["askChoice", { title: "어느 쪽?", options: [{ label: "이쪽" }] }],
      ["askChoice", { title: "어느 쪽?", options: "이쪽, 저쪽" }],
      ["askChoice", { saves: "persona" }],
      ["askApproval", {}],
      ["askApproval", { title: "메일 보내기" }],
      ["askApproval", { title: "  ", summary: "이 메일을 보낼까요?" }],
    ] as const) {
      test(`is answered at once, and nobody is waited on: ${name} ${JSON.stringify(args)}`, async () => {
        const told: string[] = [];
        const people = createPersonAnswers({
          onChange: (threadId) => told.push(threadId),
        });
        const toolkit = await createChatTools({
          people,
          components: cards,
          // Long enough that a call which did wait would fail this test by its own time limit.
          personWaitMs: 60_000,
        })(context, [tool("askChoice"), tool("askApproval")]);
        const outcome = await toolkit.execute(name, args, call("empty-1"));
        expect(outcome).toMatchObject(refused);
        // No window was ever told a card was waiting.
        expect(told).toEqual([]);
        expect(people.awaiting("thread-1")).toEqual([]);
      });
    }

    test("leaves a row in the trail: which card, whose Bot, the fact — and nothing of the call", async () => {
      const rows: Record<string, unknown>[] = [];
      const toolkit = await createChatTools({
        people: createPersonAnswers(),
        components: cards,
        auditStore: {
          insert: async (event) => {
            rows.push(event as unknown as Record<string, unknown>);
          },
        },
      })(context, [tool("askChoice")]);
      await toolkit.execute(
        "askChoice",
        { summary: "비밀번호는 hunter2", options: [] },
        call("empty-2"),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventType: "component.refused",
        targetType: "component",
        targetId: "askChoice",
        payload: {
          actor: "owner-1",
          bot: "bot-1",
          reason: "laf:tool_arguments_invalid",
        },
      });
      expect(JSON.stringify(rows)).not.toContain("hunter2");
    });

    test("the same cards with a question in them are asked", async () => {
      const people = createPersonAnswers();
      const toolkit = await createChatTools({
        people,
        components: cards,
      })(context, [tool("askChoice"), tool("askApproval")]);
      const asked = [
        toolkit.execute(
          "askChoice",
          { title: "어느 쪽?", options: [option] },
          call("full-1"),
        ),
        // The persona question draws its own four: it needs no options of the Bot's.
        toolkit.execute(
          "askChoice",
          { title: "어떤 분이세요?", saves: "persona" },
          call("full-2"),
        ),
        toolkit.execute(
          "askApproval",
          { title: "메일 보내기", summary: "이 메일을 보낼까요?" },
          call("full-3"),
        ),
      ];
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(people.awaiting("thread-1").sort()).toEqual([
        "full-1",
        "full-2",
        "full-3",
      ]);
      for (const id of ["full-1", "full-2", "full-3"]) {
        people.answer("thread-1", id, { choice: "a" });
      }
      await Promise.all(asked);
    });
  });

  /*
   * askChoice with `saves: "persona"`: the Bot asks, the person's press writes. Muse-shape plan
   * §2.2 — "The Bot's call cannot write", and a Bot that mislabels the options changes nothing.
   */
  describe("a persona question", () => {
    const choiceCards = {
      listForAgent: async () => [
        {
          name: "askChoice",
          title: "Choice",
          kind: "decision",
          description: "d",
        },
      ],
      decide: async () => ({ allowed: true as const, description: "d" }),
      mayCall: async () => true,
    };
    const personaStore = () => {
      const saved: [string, string | null][] = [];
      return {
        saved,
        store: {
          savePersona: async (userId: string, persona: string | null) => {
            saved.push([userId, persona]);
            return persona as never;
          },
        },
      };
    };
    const crafted = {
      title: "어떤 분이세요?",
      saves: "persona",
      options: [{ id: "owner", label: "학생" }],
    };

    test("writes nothing when the Bot calls it, and the person's press writes", async () => {
      const people = createPersonAnswers();
      const { saved, store } = personaStore();
      const toolkit = await createChatTools({
        people,
        components: choiceCards,
        persona: store,
      })(context, [tool("askChoice")]);
      const pending = toolkit.execute("askChoice", crafted, call("p-1"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The call is on screen and waiting; nothing is written on the Bot's say-so.
      expect(saved).toEqual([]);
      expect(people.answer("thread-1", "p-1", { choice: "student" })).toBe(
        true,
      );
      expect(JSON.parse(String(await pending))).toEqual({
        choice: "student",
        saved: true,
      });
      expect(saved).toEqual([["owner-1", "student"]]);
    });

    test("a call nobody answered writes nothing", async () => {
      const { saved, store } = personaStore();
      const toolkit = await createChatTools({
        people: createPersonAnswers(),
        components: choiceCards,
        persona: store,
        personWaitMs: 30,
      })(context, [tool("askChoice")]);
      await toolkit.execute("askChoice", crafted, call("p-2"));
      expect(saved).toEqual([]);
    });

    test("an answer that is not one of the four writes nothing", async () => {
      const people = createPersonAnswers();
      const { saved, store } = personaStore();
      const toolkit = await createChatTools({
        people,
        components: choiceCards,
        persona: store,
      })(context, [tool("askChoice")]);
      const pending = toolkit.execute("askChoice", crafted, call("p-3"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      people.answer("thread-1", "p-3", { choice: "admin" });
      expect(await pending).toBe('{"choice":"admin"}');
      expect(saved).toEqual([]);
    });

    test("an ordinary choice never reaches the persona", async () => {
      const people = createPersonAnswers();
      const { saved, store } = personaStore();
      const toolkit = await createChatTools({
        people,
        components: choiceCards,
        persona: store,
      })(context, [tool("askChoice")]);
      const pending = toolkit.execute(
        "askChoice",
        { title: "어느 쪽?", options: [{ id: "student", label: "a" }] },
        call("p-4"),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      people.answer("thread-1", "p-4", { choice: "student" });
      expect(await pending).toBe('{"choice":"student"}');
      expect(saved).toEqual([]);
    });
  });

  test("a card on screen answers with its own sentence", async () => {
    const components = {
      listForAgent: async () => [
        { name: "showBarChart", title: "Bar", kind: "chart", description: "d" },
      ],
      decide: async () => ({ allowed: true as const, description: "d" }),
      mayCall: async () => true,
    };
    const toolkit = await createChatTools({
      people: createPersonAnswers(),
      components,
    })(context, [tool("showBarChart")]);
    expect(await toolkit.execute("showBarChart", {}, call())).toBe(
      "The bar chart is now on screen for the person.",
    );
  });
});

/**
 * A CONNECT CARD IS WAITED ON, AND ANSWERED FROM 연결 — NEVER FROM WHAT A WINDOW SAID.
 *
 * `showConnection` used to answer "the switches are on screen" and the turn ended; the person turned
 * one on and had to ask again. The call waits now, until a switch is on or the person says not now,
 * and the turn goes on with the connection's tools offered in it. What ends the wait is either a
 * window's answer or this turn's own look at 연결; what the Bot is told is always the look.
 */
describe("a connect card the turn waits on", () => {
  const connectCards = {
    listForAgent: async () => [
      {
        name: "showConnection",
        title: "Connect",
        kind: "decision",
        description: "d",
      },
    ],
    decide: async () => ({ allowed: true as const, description: "d" }),
    mayCall: async () => true,
  };
  /** 연결, as a test can turn it: which switches there are and which are on. */
  const switchboard = (rows: Record<string, boolean>) => {
    const state = { ...rows };
    return {
      state,
      read: async () =>
        Object.entries(state).map(([id, connected]) => ({ id, connected })),
    };
  };
  /** A plugin store whose Gmail tools exist once Gmail is on. */
  const pluginStoreOver = (state: Record<string, boolean>) =>
    ({
      listForAgent: async () => ({
        tools: state.gmail
          ? [
              {
                ref: "gmail/search_messages",
                toolName: "mcp__gmail__search_messages",
                description: "search",
                inputSchema: { type: "object" },
              },
            ]
          : [],
        skills: [],
      }),
      callTool: async () => ({ text: "3 messages", isError: false }),
      viewSkill: async () => ({
        allowed: false,
        reason: "laf:skill_not_granted",
      }),
    }) as unknown as Parameters<typeof createChatTools>[0]["pluginStore"];
  const answerOf = async (pending: Promise<unknown>) =>
    JSON.parse(String(await pending)) as Record<string, unknown>;

  test("a service this deployment does not have is said at once, with nothing to wait on", async () => {
    const people = createPersonAnswers();
    const board = switchboard({ gmail: false });
    const toolkit = await createChatTools({
      people,
      components: connectCards,
      connections: board.read,
    })(context, [tool("showConnection")]);
    const answer = await answerOf(
      toolkit.execute(
        "showConnection",
        { services: ["kakao-playmcp"] },
        call("c-0"),
      ),
    );
    expect(answer).toEqual({
      code: "laf:connection_not_offered",
      connected: [],
      notConnected: ["kakao-playmcp"],
      reason: toolResultText("laf:connection_not_offered"),
    });
    expect(people.awaiting("thread-1")).toEqual([]);
  });

  test("a deployment with no 연결 at all draws nothing and waits for nothing", async () => {
    const toolkit = await createChatTools({
      people: createPersonAnswers(),
      components: connectCards,
    })(context, [tool("showConnection")]);
    expect(
      (
        await answerOf(
          toolkit.execute(
            "showConnection",
            { services: ["gmail"] },
            call("c-00"),
          ),
        )
      ).code,
    ).toBe("laf:connection_not_offered");
  });

  test("switches that are all on already are said at once", async () => {
    const board = switchboard({ gmail: true });
    const toolkit = await createChatTools({
      people: createPersonAnswers(),
      components: connectCards,
      connections: board.read,
    })(context, [tool("showConnection")]);
    expect(
      await answerOf(
        toolkit.execute("showConnection", { services: ["gmail"] }, call("c-1")),
      ),
    ).toEqual({
      code: "laf:connection_on",
      connected: ["gmail"],
      notConnected: [],
      reason: toolResultText("laf:connection_on"),
    });
  });

  test("it waits, and 다음에 from a window is nothing connected", async () => {
    const people = createPersonAnswers();
    const board = switchboard({ gmail: false, "google-calendar": false });
    const toolkit = await createChatTools({
      people,
      components: connectCards,
      connections: board.read,
      connectionPollMs: 5_000,
    })(context, [tool("showConnection")]);
    const pending = toolkit.execute(
      "showConnection",
      { services: ["gmail", "google-calendar"] },
      call("c-2"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(people.awaiting("thread-1")).toEqual(["c-2"]);
    people.answer("thread-1", "c-2", { code: "laf:connection_off" });
    expect(await answerOf(pending)).toEqual({
      code: "laf:connection_off",
      connected: [],
      notConnected: ["gmail", "google-calendar"],
      reason: toolResultText("laf:connection_off"),
    });
    expect(people.awaiting("thread-1")).toEqual([]);
  });

  test("a window saying it is connected is not the fact: 연결 is read, and says no", async () => {
    const people = createPersonAnswers();
    const board = switchboard({ gmail: false });
    const toolkit = await createChatTools({
      people,
      components: connectCards,
      connections: board.read,
      connectionPollMs: 5_000,
    })(context, [tool("showConnection")]);
    const pending = toolkit.execute(
      "showConnection",
      { services: ["gmail"] },
      call("c-3"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    people.answer("thread-1", "c-3", {
      code: "laf:connection_on",
      connected: ["gmail"],
    });
    expect((await answerOf(pending)).code).toBe("laf:connection_off");
  });

  test("a switch turned on with no window open ends the wait, and its tools are this turn's", async () => {
    const people = createPersonAnswers();
    const board = switchboard({ gmail: false });
    const toolkit = await createChatTools({
      people,
      components: connectCards,
      connections: board.read,
      pluginStore: pluginStoreOver(board.state),
      connectionPollMs: 15,
    })(context, [tool("showConnection")]);
    // Drawn when the message arrived: Gmail was off, and its tool is not this turn's.
    expect(toolkit.tools.map((offered) => offered.name)).toEqual([
      "showConnection",
    ]);
    expect(
      await toolkit.execute("mcp__gmail__search_messages", {}, call("g-0")),
    ).toEqual({
      ok: false,
      code: "laf:tool_unknown",
      reason: toolResultText("laf:tool_unknown"),
    });

    const pending = toolkit.execute(
      "showConnection",
      { services: ["gmail"] },
      call("c-4"),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(people.awaiting("thread-1")).toEqual(["c-4"]);
    // The consent finished in the person's browser; no window of the app said anything.
    board.state.gmail = true;
    expect(await answerOf(pending)).toEqual({
      code: "laf:connection_on",
      connected: ["gmail"],
      notConnected: [],
      tools: ["mcp__gmail__search_messages"],
      reason: toolResultText("laf:connection_on"),
    });
    // Nobody is asked any more, and the tool is offered and carried out in this same turn.
    expect(people.awaiting("thread-1")).toEqual([]);
    expect(toolkit.tools.map((offered) => offered.name)).toEqual([
      "showConnection",
      "mcp__gmail__search_messages",
    ]);
    expect(
      await toolkit.execute("mcp__gmail__search_messages", {}, call("g-1")),
    ).toBe("3 messages");
  });

  test("one already on and one turned on: both are said, and only the wait's is news", async () => {
    const people = createPersonAnswers();
    const board = switchboard({ gmail: true, "google-calendar": false });
    const toolkit = await createChatTools({
      people,
      components: connectCards,
      connections: board.read,
      connectionPollMs: 15,
    })(context, [tool("showConnection")]);
    const pending = toolkit.execute(
      "showConnection",
      { services: ["gmail", "google-calendar", "notion"] },
      call("c-5"),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Gmail being on already did not end the wait: the calendar is what was missing.
    expect(people.awaiting("thread-1")).toEqual(["c-5"]);
    board.state["google-calendar"] = true;
    const answer = await answerOf(pending);
    expect(answer.code).toBe("laf:connection_on");
    expect(answer.connected).toEqual(["gmail", "google-calendar"]);
    // Notion is not on this deployment's 연결: offered by the Bot, never drawn, not connected.
    expect(answer.notConnected).toEqual(["notion"]);
  });

  test("nobody answers and nothing turns on: the wait ends as any unanswered question does", async () => {
    const board = switchboard({ gmail: false });
    const toolkit = await createChatTools({
      people: createPersonAnswers(),
      components: connectCards,
      connections: board.read,
      connectionPollMs: 10,
      personWaitMs: 40,
    })(context, [tool("showConnection")]);
    expect(
      await toolkit.execute(
        "showConnection",
        { services: ["gmail"] },
        call("c-6"),
      ),
    ).toBe(toolResultText("laf:nobody_answered"));
  });

  test("a stop ends the wait and the look", async () => {
    const people = createPersonAnswers();
    const board = switchboard({ gmail: false });
    let reads = 0;
    const toolkit = await createChatTools({
      people,
      components: connectCards,
      connections: async () => {
        reads += 1;
        return board.read();
      },
      connectionPollMs: 10,
    })(context, [tool("showConnection")]);
    const stop = new AbortController();
    const pending = toolkit.execute(
      "showConnection",
      { services: ["gmail"] },
      { id: "c-7", signal: stop.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 35));
    stop.abort();
    expect(await pending).toBe(toolResultText("laf:stopped"));
    expect(people.awaiting("thread-1")).toEqual([]);
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Nothing goes on asking 연결 once the turn was stopped.
    expect(reads).toBe(after);
  });
});

/*
 * A FILE CARD (phase 8, 2026-10-02). Every other card draws what its call handed it; this one draws
 * a file its call only named, so "it is on screen" is something the server has to look before it
 * says. A Bot told its file reached the person, about a file that was never written, is the product
 * lying to both of them — the card says gone, and the Bot goes on as though it had delivered.
 */
describe("a file card", () => {
  const fileCard = {
    listForAgent: async () => [
      { name: "showFile", title: "File", kind: "card", description: "d" },
    ],
    decide: async () => ({ allowed: true as const, description: "d" }),
    mayCall: async () => true,
  };
  const CONFIRMED =
    "The file card is on screen for the person, with its name, its size and a button to download it. Do not paste the file's contents into your answer again.";

  /** A computer whose folder holds `요약.md` and a folder `보고서`, refusing as the container does. */
  function folder() {
    const asked: Array<[string, string]> = [];
    const gateway = {
      fileFacts: async (botId: string, path: string) => {
        asked.push([botId, path]);
        if (path.split("/").includes("..")) {
          throw new WorkspaceRefusedError("laf:file_path_refused");
        }
        if (path === "보고서") {
          throw new WorkspaceRequestError("laf:file_wrong_kind");
        }
        if (path !== "요약.md") {
          throw new WorkspaceRequestError("laf:file_not_found");
        }
        return { path, kind: "file" as const, bytes: 12 };
      },
    } as unknown as ComputerGateway;
    return { gateway, asked };
  }

  /*
   * WRITTEN IS NOT HANDED OVER. Measured 2026-10-02 with the fleet's model, in a conversation with
   * a day behind it and the card in the schema: asked to make a CSV, the Bot wrote it and told the
   * person its name — "…csv에 담아뒀어요" — three times in three, a place they cannot reach. With
   * this sentence on the write's own answer: handed over four times in four, and a memo the Bot was
   * asked to keep for itself was left where it was.
   */
  test("a file that was written says the person has not been handed it, where a card could hand it", async () => {
    const written: unknown[] = [];
    const gateway = {
      writeFile: async (
        _computer: string,
        _bot: string,
        _actor: unknown,
        file: unknown,
      ) => {
        written.push(file);
        return { ok: true, path: "매출.csv", bytes: 60, appended: false };
      },
    } as unknown as ComputerGateway;
    const handOver = toolResultText("laf:file_saved_not_handed_over");
    // Asserted rather than assumed: an unknown code is answered with itself.
    expect(handOver).toContain("showFile");
    expect(handOver).not.toBe("laf:file_saved_not_handed_over");

    const withCard = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: fileCard,
    })(context, [tool("computer_write_file"), tool("showFile")]);
    expect(
      await withCard.execute(
        "computer_write_file",
        { path: "매출.csv", contents: "날짜,매출\n" },
        call(),
      ),
    ).toEqual({
      ok: true,
      path: "매출.csv",
      bytes: 60,
      appended: false,
      note: handOver,
    });

    // A turn whose window offered no such card is told nothing about a card it cannot draw.
    const withoutCard = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: fileCard,
    })(context, [tool("computer_write_file")]);
    expect(
      await withoutCard.execute(
        "computer_write_file",
        { path: "매출.csv", contents: "날짜,매출\n" },
        call(),
      ),
    ).toEqual({ ok: true, path: "매출.csv", bytes: 60, appended: false });
    expect(written).toHaveLength(2);
  });

  test("a write that was refused says only that it was refused", async () => {
    const gateway = {
      writeFile: async () => {
        throw new ActionRefusedError(
          "file.path == '매출.csv'",
          "laf:policy_denied",
        );
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: fileCard,
    })(context, [tool("computer_write_file"), tool("showFile")]);
    const refused = (await toolkit.execute(
      "computer_write_file",
      { path: "매출.csv", contents: "x" },
      call(),
    )) as Record<string, unknown>;
    expect(refused.ok).toBe(false);
    expect("note" in refused).toBe(false);
  });

  test("is confirmed for a file that is there, asked about as this Bot's", async () => {
    const { gateway, asked } = folder();
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: fileCard,
    })(context, [tool("showFile")]);

    expect(
      await toolkit.execute("showFile", { path: "  요약.md " }, call()),
    ).toBe(CONFIRMED);
    // The path as the card will ask for it: trimmed, and in the folder of the Bot whose turn it is.
    expect(asked).toEqual([["bot-1", "요약.md"]]);
  });

  test("is not confirmed for a file that is not: the Bot reads the computer's own fact", async () => {
    const { gateway } = folder();
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: fileCard,
    })(context, [tool("showFile")]);

    // An envelope, as `computer_read_file` answers the same path — and so not a sentence, which is
    // what 만든 것 takes for a card that reached the screen (`agents/made.ts`).
    expect(
      await toolkit.execute("showFile", { path: "없는.md" }, call()),
    ).toEqual({
      ok: false,
      code: "laf:file_not_found",
      reason: toolResultText("laf:file_not_found"),
    });
    expect(
      await toolkit.execute("showFile", { path: "보고서" }, call()),
    ).toEqual({
      ok: false,
      code: "laf:file_wrong_kind",
      reason: toolResultText("laf:file_wrong_kind"),
    });
    expect(
      await toolkit.execute("showFile", { path: "../.env" }, call()),
    ).toEqual({
      ok: false,
      code: "laf:file_path_refused",
      reason: toolResultText("laf:file_path_refused"),
      refused: true,
      rule: null,
    });
    // Each has words: a code the table lacks would reach the Bot as the identifier.
    for (const code of [
      "laf:file_not_found",
      "laf:file_wrong_kind",
      "laf:file_path_refused",
    ]) {
      expect(toolResultText(code)).not.toBe(code);
    }
  });

  test("with no path is the arguments' fault, and the computer is not asked", async () => {
    const { gateway, asked } = folder();
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: fileCard,
    })(context, [tool("showFile")]);

    for (const args of [{}, { path: "   " }, { path: 7 }]) {
      expect(await toolkit.execute("showFile", args, call())).toEqual({
        ok: false,
        code: "laf:tool_arguments_invalid",
        reason: toolResultText("laf:tool_arguments_invalid"),
      });
    }
    expect(asked).toEqual([]);
  });

  test("a computer that is away is said as that, never as the file being there or gone", async () => {
    const gateway = {
      fileFacts: async () => {
        throw new ComputerUnavailableError("laf:computer_unreachable");
      },
    } as unknown as ComputerGateway;
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: fileCard,
    })(context, [tool("showFile")]);

    expect(
      await toolkit.execute("showFile", { path: "요약.md" }, call()),
    ).toEqual({
      ok: false,
      code: "laf:computer_unreachable",
      reason: toolResultText("laf:computer_unreachable"),
    });
  });

  test("a card this Bot does not hold is refused before the file is looked for", async () => {
    const { gateway, asked } = folder();
    const toolkit = await createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: {
        ...fileCard,
        decide: async () => ({
          allowed: false as const,
          reason: "laf:component_withheld",
        }),
      },
    })(context, [tool("showFile")]);

    expect(await toolkit.execute("showFile", { path: "요약.md" }, call())).toBe(
      toolResultText("laf:component_withheld"),
    );
    expect(asked).toEqual([]);
  });

  test("is not offered where there is no computer, and so no folder", async () => {
    const toolkit = await createChatTools({
      people: createPersonAnswers(),
      components: {
        ...fileCard,
        listForAgent: async () => [
          { name: "showFile", title: "File", kind: "card", description: "d" },
          {
            name: "showNotice",
            title: "Notice",
            kind: "card",
            description: "d",
          },
        ],
      },
    })(context, [tool("showFile"), tool("showNotice")]);

    // The other cards are untouched: it is the file card that needs the folder.
    expect(toolkit.tools.map((offered) => offered.name)).toEqual([
      "showNotice",
    ]);
    expect(
      await toolkit.execute("showFile", { path: "요약.md" }, call()),
    ).toEqual({
      ok: false,
      code: "laf:tool_unknown",
      reason: toolResultText("laf:tool_unknown"),
    });
  });
});

describe("manage_routine, as the window's handler answered it", () => {
  const routine = {
    id: "r-1",
    agentId: "bot-1",
    name: "아침 날씨",
    instruction: "날씨 알려줘",
    enabled: true,
  };
  const service = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      list: async () => [routine, { ...routine, id: "r-2", agentId: "bot-2" }],
      create: async () => routine,
      update: async () => routine,
      remove: async () => undefined,
      setEnabled: async () => routine,
      ...overrides,
    }) as unknown as Pick<
      RoutineService,
      "create" | "list" | "update" | "remove" | "setEnabled"
    >;

  test("lists only this Bot's routines", async () => {
    expect(
      await routineAction(service(), owner, "bot-1", { action: "list" }),
    ).toBe(routineListResult("laf:routine_list", [routine]));
  });

  test("an update with nothing to change is said so, before anything is read", async () => {
    expect(
      await routineAction(service(), owner, "bot-1", {
        action: "update",
        routineId: "r-1",
      }),
    ).toBe(toolResultText("laf:routine_nothing_to_change"));
  });

  test("a name it does not know lists what it does", async () => {
    expect(
      await routineAction(service(), owner, "bot-1", {
        action: "delete",
        routineId: "없는 루틴",
      }),
    ).toBe(routineListResult("laf:routine_name_unknown", [routine]));
  });

  test("pausing by name", async () => {
    const toggled: boolean[] = [];
    expect(
      await routineAction(
        service({
          setEnabled: async (
            _actor: unknown,
            _id: string,
            enabled: boolean,
          ) => {
            toggled.push(enabled);
            return routine;
          },
        }),
        owner,
        "bot-1",
        { action: "update", routineId: "아침 날씨", enabled: false },
      ),
    ).toBe(toolResultText("laf:routine_paused"));
    expect(toggled).toEqual([false]);
  });
});

/*
 * A HANDLER THAT THROWS IS A STEP THAT FAILED, SAID AS A FACT. It used to be answered with the
 * string `Error: …` — and a string is what a tool that worked returns, so the step was recorded as
 * one that went through and the Bot was handed an English sentence with the error's own words in it
 * (refactoring review, 2026-10-02).
 */
describe("a tool whose own handler throws", () => {
  test("is answered as a failure, with a code and none of the error's words", async () => {
    const toolkit = await createChatTools({
      people: createPersonAnswers(),
      goals: {
        active: async () => {
          throw new Error(
            'Failed query: select * from "laf_goals" where "user_id" = $1 params: owner-1',
          );
        },
      } as never,
    })(context, [tool(LIST_GOALS)]);
    const outcome = await toolkit.execute(LIST_GOALS, {}, call());
    expect(outcome).toEqual({
      ok: false,
      code: "laf:tool_failed",
      reason: toolResultText("laf:tool_failed"),
    });
    // Nothing of what was thrown: a database's failure names its SQL and its parameters.
    expect(JSON.stringify(outcome)).not.toContain("laf_goals");
    expect(JSON.stringify(outcome)).not.toContain("owner-1");
    // And the sentence is one the table has, in the words a Bot reads.
    expect(toolResultText("laf:tool_failed")).toContain("실패");
  });
});
