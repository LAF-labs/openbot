import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import { ROUTINE_NEEDS_SAVED_LOGIN_KO } from "../../shared/prompt/mode/routine.ko";
import {
  ActionRefusedError,
  type ComputerGateway,
} from "../src/computer/gateway";
import {
  createUnattendedTools,
  type LoopAgent,
  runUnattended,
} from "../src/runner/unattended";

/**
 * What the unattended loop and its executor say when a call cannot be run, and what the run's
 * record says about it.
 *
 * MEASURED IN THE AUDIT (A2, 2026-09-10, rows 5 and 6): a routine answered a made-up tool with the
 * English "There is no tool called computer_fly.", turned broken JSON arguments into `{}` and ran
 * the tool with nothing — so the model read "the field is missing" about a field it had sent — and
 * refused a click without a ref with "A ref and its snapshotId are required." Every one of those
 * was read by a model whose prompt tells it to answer in Korean. They are facts from the one table
 * now, the same ones `agent-bot` answers inside a run.
 */

const actor = { id: "person-1", userId: "person-1" };

/**
 * A gateway nothing may reach. Every call here is refused before the executor would touch it, and
 * a refusal that did touch it would throw on the missing method and fail the test.
 */
const UNTOUCHED = {} as unknown as ComputerGateway;

/** A model that asks for one call — its arguments exactly as written — and then reports. */
function agentCalling(name: string, rawArguments: string): LoopAgent {
  const turns: Message[] = [
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name, arguments: rawArguments },
        },
      ],
    },
    { id: "a2", role: "assistant", content: "다시 하겠다." },
  ];
  let runs = 0;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      _parameters?: unknown,
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) {
      const turn = turns[runs];
      runs += 1;
      if (turn) agent.messages.push(turn);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: turn ? [turn] : [] };
    },
  };
  return agent as unknown as LoopAgent;
}

describe("a routine's looks at the page", () => {
  /*
   * The computer counts a look as the Bot's — the one that lets it act again after its tab went
   * from under it — only where the Bot's own loop says so (`shared/bots-look.ts`). A routine is one
   * of the two places that loop runs; a look it did not mark would be a person's, and a routine
   * whose sign-in window had closed itself could never act again.
   */
  test("are said to be the Bot's own", async () => {
    const looks: [string, unknown][] = [];
    const page = {
      title: "예시",
      url: "https://example.com/",
      text: "본문",
      truncated: false,
    };
    const gateway = {
      read: async (_bot: string, options?: { botsLook?: true }) => {
        looks.push(["read", options?.botsLook]);
        return page;
      },
      snapshot: async (_computer: string, caller?: { botsLook?: true }) => {
        looks.push(["snapshot", caller?.botsLook]);
        return { ...page, snapshotId: 1, elements: [], tabs: [] };
      },
      navigate: async (...asked: unknown[]) => {
        looks.push(["navigate", (asked[6] as { botsLook?: true })?.botsLook]);
        return page;
      },
    } as unknown as ComputerGateway;
    const toolkit = await createUnattendedTools({ gateway })("bot-1", actor);
    await toolkit.execute("computer_read", {});
    await toolkit.execute("computer_snapshot", {});
    await toolkit.execute("computer_navigate", { url: "https://example.com" });
    expect(looks).toEqual([
      ["read", true],
      ["snapshot", true],
      ["navigate", true],
    ]);
  });
});

describe("what the executor refuses on its own", () => {
  test("arguments that are not what the tool takes", async () => {
    const toolkit = await createUnattendedTools({ gateway: UNTOUCHED })(
      "bot-1",
      actor,
    );
    expect(await toolkit.execute("computer_click", { ref: "e1" })).toEqual({
      ok: false,
      code: "laf:tool_arguments_invalid",
      reason: toolResultText("laf:tool_arguments_invalid"),
    });
    expect(await toolkit.execute("computer_key", {})).toMatchObject({
      code: "laf:tool_arguments_invalid",
    });
  });

  test("a name it has no tool for", async () => {
    const toolkit = await createUnattendedTools({ gateway: UNTOUCHED })(
      "bot-1",
      actor,
    );
    expect(await toolkit.execute("computer_fly", {})).toEqual({
      ok: false,
      code: "laf:tool_unknown",
      reason: toolResultText("laf:tool_unknown"),
    });
  });

  test("arguments that are not JSON are answered with the fact and never executed", async () => {
    // A routine turned these into `{}` and ran the tool with nothing, so the model read "the field
    // is missing" about a field it had sent (audit A2, row 5).
    const executed: string[] = [];
    const agent = agentCalling("computer_click", '{"ref": "e1" oops');
    const result = await runUnattended(agent, "결제해 줘", {
      toolkit: {
        tools: [],
        execute: async (name) => {
          executed.push(name);
          return { ok: true };
        },
      },
      timeoutMs: 5_000,
      mode: "routine",
    });
    expect(executed).toEqual([]);
    const answer = agent.messages.find((message) => message.role === "tool");
    expect(JSON.parse(String(answer?.content))).toEqual({
      ok: false,
      code: "laf:tool_arguments_invalid",
      reason: toolResultText("laf:tool_arguments_invalid"),
    });
    expect(result.steps[0]?.calls).toEqual([
      { name: "computer_click", ok: false },
    ]);
  });
});

describe("what the run's record says about a call the Bot service answered", () => {
  test("a guard's fact is recorded as not done, and a lookup as done", async () => {
    // agent-bot answers some calls inside the run — a bridge lookup, and now a made-up tool name —
    // and the thread comes back with the call and its answer. Both used to be recorded as `ok`.
    const turns: Message[][] = [
      [
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "look",
              type: "function",
              function: { name: "tool_search", arguments: '{"query":"메일"}' },
            },
            {
              id: "fly",
              type: "function",
              function: { name: "computer_fly", arguments: "{}" },
            },
          ],
        },
        {
          id: "r1",
          role: "tool",
          toolCallId: "look",
          content: "찾은 도구: mcp__gmail__send_message",
        },
        {
          id: "r2",
          role: "tool",
          toolCallId: "fly",
          content: JSON.stringify({
            ok: false,
            code: "laf:tool_unknown",
            reason: toolResultText("laf:tool_unknown"),
          }),
        },
        { id: "a2", role: "assistant", content: "없는 도구였다." },
      ],
    ];
    let runs = 0;
    const agent = {
      messages: [] as Message[],
      setMessages(messages: Message[]) {
        agent.messages = [...messages];
      },
      addMessage(message: Message) {
        agent.messages.push(message);
      },
      async runAgent(
        _parameters?: unknown,
        subscriber?: { onRunFinishedEvent?: () => unknown },
      ) {
        const added = turns[runs] ?? [];
        runs += 1;
        agent.messages.push(...added);
        subscriber?.onRunFinishedEvent?.();
        return { result: undefined, newMessages: added };
      },
    };
    const result = await runUnattended(agent as unknown as LoopAgent, "메일", {
      toolkit: { tools: [], execute: async () => ({ ok: true }) },
      timeoutMs: 5_000,
      mode: "routine",
    });
    expect(result.steps[0]?.calls).toEqual([
      { name: "tool_search", ok: true },
      { name: "computer_fly", ok: false },
    ]);
  });
});

/*
 * A SAVED PASSWORD A PAGE SHOWS BACK, in a run nobody watches (2026-10-10, record §6). A routine
 * reads a site's page hours after the run that signed in to it, with nothing held by the Bot's
 * computer; what its browser tools hand the model is read for the passwords saved for that site
 * (`logins/shown.ts`), as a conversation's turn reads it. The value is made up for this test.
 */
describe("what a browser tool hands a routine, read for a saved password", () => {
  const SHOWN = "tr0ub4dor&3";
  const gateway = {
    read: async () => ({
      title: "내 정보",
      url: "https://shop.example/my",
      text: `비밀번호 확인: ${SHOWN}`,
      truncated: false,
    }),
    handedOver: (
      botId: string,
      run: { threadId?: string; toolCallId?: string },
      hidden: boolean,
    ) => {
      told.push([botId, run.threadId, hidden]);
    },
  } as unknown as ComputerGateway;
  /** What the gateway was told of each call handed over: whose, under which run, and whether a hit. */
  const told: Array<[string, string | undefined, boolean]> = [];
  const vault = (asked: string[][] = []) => ({
    // Nothing saved as far as the toolkit's own question goes: no sign-in tool is offered here.
    list: async () => [],
    passwordsAt: async (userId: string, addresses: readonly string[]) => {
      asked.push([userId, ...addresses]);
      return {
        shown: new Map([["https://shop.example", [SHOWN]]]),
        unreadable: [],
      };
    },
  });

  test("the password is not in it, and the mark is explained", async () => {
    const asked: string[][] = [];
    const toolkit = await createUnattendedTools({
      gateway,
      logins: vault(asked),
    })("bot-1", actor);
    const outcome = await toolkit.execute("computer_read", {});
    expect(outcome).toEqual({
      ok: true,
      title: "내 정보",
      url: "https://shop.example/my",
      text: "비밀번호 확인: [•••]",
      truncated: false,
      notes: [toolResultText("laf:value_hidden")],
    });
    expect(JSON.stringify(outcome)).not.toContain(SHOWN);
    // The vault of the person the routine runs as.
    expect(asked).toEqual([["person-1", "https://shop.example"]]);
  });

  /*
   * The page that showed it is on screen, and a window watching the same Bot keeps no picture
   * while it is — so the gateway is told, under the RUN'S OWN NAME, which is what the routine's
   * end takes the note back with (`routines/run.ts`, `ActionActor.runKey`).
   */
  test("the gateway is told of the call under the run's own name, and that it was a hit", async () => {
    told.length = 0;
    const toolkit = await createUnattendedTools({
      gateway,
      logins: vault(),
    })("bot-1", { ...actor, runKey: "routine:run-7" });
    await toolkit.execute("computer_read", {});
    expect(told).toEqual([["bot-1", "routine:run-7", true]]);
  });

  test("a vault that cannot be asked is a call that failed, never a page handed over unread", async () => {
    const toolkit = await createUnattendedTools({
      gateway,
      logins: {
        list: async () => [],
        passwordsAt: async () => {
          throw new Error("the database is away");
        },
      },
    })("bot-1", actor);
    const outcome = await toolkit.execute("computer_read", {});
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(SHOWN);
  });

  test("without a vault a page is handed over as it was read", async () => {
    const toolkit = await createUnattendedTools({ gateway })("bot-1", actor);
    expect(await toolkit.execute("computer_read", {})).toMatchObject({
      ok: true,
      text: `비밀번호 확인: ${SHOWN}`,
    });
  });
});

/*
 * A ROUTINE SIGNS IN WITH A SAVED LOGIN (2026-10-10, record §6, piece 2-6). The same tool name a
 * conversation asks a person with, in a routine's own words, offered only to a run of somebody who
 * saved a login — and answered by the vault or by nothing: no card is opened for a person who is
 * not there.
 */
describe("a sign-in in a run nobody is in front of", () => {
  const SAVED = [{ id: "login-1" }] as never[];
  const FIELDS = [
    { ref: "e1", label: "아이디" },
    { ref: "e2", label: "비밀번호" },
  ];
  const ARGS = { fields: FIELDS, snapshotId: 3 };
  /** A gateway that answers the request as scripted, and says what it was asked with. */
  const answering = (answer: Record<string, unknown> | (() => never)) => {
    const asked: unknown[][] = [];
    const gateway = {
      requestSecret: async (...args: unknown[]) => {
        asked.push(args);
        return typeof answer === "function" ? answer() : answer;
      },
      handedOver: () => undefined,
    } as unknown as ComputerGateway;
    return { gateway, asked };
  };
  const vault = (saved: never[] | (() => never) = SAVED) => ({
    list: async () => (typeof saved === "function" ? saved() : saved),
    passwordsAt: async () => ({ shown: new Map(), unreadable: [] }),
  });
  const offered = (toolkit: { tools: { name: string }[] }) =>
    toolkit.tools.filter((tool) => tool.name === "computer_request_secret");

  test("the way to sign in is offered to a run of somebody who saved a login, in a routine's words, and to nobody else", async () => {
    const { gateway } = answering({});
    const withOne = await createUnattendedTools({ gateway, logins: vault() })(
      "bot-1",
      actor,
    );
    expect(offered(withOne)).toHaveLength(1);
    const [tool] = offered(withOne) as { description?: string }[];
    // Not the conversation's words, which promise a person at a masked box.
    expect(tool?.description).toContain("화면 앞에 아무도 없어서");
    expect(tool?.description).not.toContain("가려진 상자");

    // Nothing saved, no vault, no computer, a vault that cannot be listed: not offered.
    const none = [
      createUnattendedTools({ gateway, logins: vault([]) }),
      createUnattendedTools({ gateway }),
      createUnattendedTools({ logins: vault() }),
      createUnattendedTools({
        gateway,
        logins: vault(() => {
          throw new Error("the database is away");
        }),
      }),
    ];
    for (const tools of none) {
      const toolkit = await tools("bot-1", actor);
      expect(offered(toolkit)).toEqual([]);
      // And a name a model remembers from a conversation is no tool of this run's.
      expect(
        await toolkit.execute("computer_request_secret", ARGS),
      ).toMatchObject({ ok: false, code: "laf:tool_unknown" });
    }
  });

  test("the vault's answer is told as it is to a conversation, and the gateway is told nobody is there", async () => {
    const { gateway, asked } = answering({
      loginFilled: { id: "login-1", fields: 2 },
    });
    const toolkit = await createUnattendedTools({ gateway, logins: vault() })(
      "bot-1",
      { ...actor, runKey: "routine:run-7" },
    );
    expect(await toolkit.execute("computer_request_secret", ARGS)).toEqual({
      ok: true,
      code: "laf:login_filled",
      result: toolResultText("laf:login_filled"),
    });
    expect(asked).toHaveLength(1);
    const [computerId, botId, as, input, , , options] = asked[0] ?? [];
    expect([computerId, botId]).toEqual(["bot-1", "bot-1"]);
    // Under the run's own name, which is what its end lets go of the values by.
    expect(as).toMatchObject({ id: "person-1", runKey: "routine:run-7" });
    expect(input).toEqual({ fields: FIELDS, snapshotId: 3 });
    expect(options).toEqual({ nobodyToAsk: true });
  });

  test("several saved logins are named back, and the one the Bot names is passed on", async () => {
    const logins = [
      { id: "login-1", label: "회사 계정" },
      { id: "login-2", label: "개인 계정" },
    ];
    const { gateway, asked } = answering({ loginChoice: logins });
    const toolkit = await createUnattendedTools({ gateway, logins: vault() })(
      "bot-1",
      actor,
    );
    expect(await toolkit.execute("computer_request_secret", ARGS)).toEqual({
      ok: true,
      code: "laf:login_choice",
      result: toolResultText("laf:login_choice"),
      logins,
    });
    await toolkit.execute("computer_request_secret", {
      ...ARGS,
      login: " login-2 ",
    });
    expect(asked[1]?.[3]).toEqual({
      fields: FIELDS,
      snapshotId: 3,
      login: "login-2",
    });
  });

  /*
   * NOTHING SAVED IS A RUN THAT WAITS ON ITS PERSON, not an ordinary failure: the loop hears the
   * two fields a question nobody answered carries, so the run is delivered even where the Bot
   * answered [SILENT] and ends with a line for the person — not the sentence the Bot was told.
   */
  test("where the vault does not answer, the Bot is told to stop and the run is one that waits, with a line for the person", async () => {
    const { gateway } = answering({ loginNotSaved: true });
    const toolkit = await createUnattendedTools({ gateway, logins: vault() })(
      "bot-1",
      actor,
    );
    const outcome = await toolkit.execute("computer_request_secret", ARGS);
    expect(outcome).toEqual({
      ok: false,
      code: "laf:login_not_saved",
      reason: toolResultText("laf:login_not_saved"),
      awaitingApproval: true,
      question: ROUTINE_NEEDS_SAVED_LOGIN_KO,
    });
    // Two different readers: the Bot is told what to do, the person what happened.
    expect(outcome.question).not.toBe(outcome.reason);
    expect(String(outcome.question)).not.toContain("멈춰라");
  });

  test("a card that is no card, and a rule's no, are answered as they are anywhere", async () => {
    const { gateway, asked } = answering(() => {
      throw new ActionRefusedError(
        'intent == "fill_login"',
        "laf:policy_denied",
      );
    });
    const toolkit = await createUnattendedTools({ gateway, logins: vault() })(
      "bot-1",
      actor,
    );
    expect(
      await toolkit.execute("computer_request_secret", { snapshotId: 3 }),
    ).toMatchObject({ ok: false, code: "laf:tool_arguments_invalid" });
    expect(
      await toolkit.execute("computer_request_secret", { fields: FIELDS }),
    ).toMatchObject({ ok: false, code: "laf:tool_arguments_invalid" });
    expect(asked).toEqual([]);
    expect(
      await toolkit.execute("computer_request_secret", ARGS),
    ).toMatchObject({ ok: false, refused: true, code: "laf:policy_denied" });
  });
});
