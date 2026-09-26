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
import {
  routineListResult,
  toolResultText,
} from "../../shared/prompt/tool-results.ko";
import type { AgentActor } from "../src/agents/profile-types";
import { createApprovalRegistry } from "../src/computer/approvals";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  type ComputerGateway,
} from "../src/computer/gateway";
import type { RoutineService } from "../src/routines/service";
import { createChatTools, routineAction } from "../src/turns/chat-tools";
import { createPersonAnswers } from "../src/turns/people";
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
      { question: "어느 쪽?" },
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
