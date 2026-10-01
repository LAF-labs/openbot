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
