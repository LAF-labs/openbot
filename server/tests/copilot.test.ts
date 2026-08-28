import { describe, expect, spyOn, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import {
  buildAgents,
  builtInAgentConfiguration,
  createRequestAgents,
  registeredAgentFromRow,
  resolveRuntimeAgents,
  standingRoleMessage,
} from "../src/copilot";

// Every agent row now joins its profile, so the row a coworker is built from always names it.
const assistantRow = {
  id: "general-assistant",
  name: "General Assistant",
  type: "built_in" as const,
  title: "Everyday Work",
  roleDescription: "Help with everyday work.",
};
const riskRow = {
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  title: "Risk & Compliance",
  roleDescription: "Investigate policies and controls.",
};

describe("registered Copilot agents", () => {
  test("normalizes built-in and remote rows", () => {
    expect(
      registeredAgentFromRow({
        ...assistantRow,
        configuration: { systemPrompt: "Be helpful." },
      }),
    ).toEqual({
      id: "general-assistant",
      name: "General Assistant",
      type: "built_in",
      standing: standingRoleMessage(assistantRow).content,
      systemPrompt: "Be helpful.",
      // A row that does not carry one — anything reading agents without selecting the column —
      // lands on the same value the column defaults to, rather than on undefined.
      effort: "balanced",
    });
    expect(
      registeredAgentFromRow({
        ...riskRow,
        configuration: { endpoint: "http://risk.internal/ag-ui" },
      }),
    ).toEqual({
      id: "risk",
      name: "Risk",
      type: "remote_ag_ui",
      endpoint: "http://risk.internal/ag-ui",
      standingMessage: standingRoleMessage(riskRow),
      // A remote Bot carries it too, and that is the whole point: every Bot anybody creates is one.
      effort: "balanced",
    });
  });

  test("rejects malformed agent configurations", () => {
    const rows = [
      { ...assistantRow, configuration: {} },
      { ...assistantRow, configuration: null },
      { ...assistantRow, configuration: [] },
      { ...assistantRow, configuration: { systemPrompt: "   " } },
      { ...riskRow, configuration: { endpoint: "" } },
      { ...riskRow, configuration: { endpoint: "not a URL" } },
      { ...riskRow, configuration: { endpoint: "ftp://risk.internal/ag-ui" } },
    ] as const;

    for (const row of rows) {
      expect(registeredAgentFromRow(row)).toBeNull();
    }
  });

  test("trims built-in prompts and preserves valid remote endpoint strings", () => {
    expect(
      registeredAgentFromRow({
        ...assistantRow,
        configuration: { systemPrompt: "  Be helpful.  " },
      }),
    ).toMatchObject({ systemPrompt: "Be helpful." });
    expect(
      registeredAgentFromRow({
        ...riskRow,
        configuration: { endpoint: "https://risk.internal:443/ag-ui" },
      }),
    ).toMatchObject({ endpoint: "https://risk.internal:443/ag-ui" });
  });

  const assistant = {
    id: "general-assistant",
    name: "General Assistant",
    type: "built_in" as const,
    standing: "You are General Assistant, Everyday work.",
    systemPrompt: "Be helpful.",
    effort: "balanced" as const,
  };

  test("configures an OpenAI built-in agent", () => {
    expect(
      builtInAgentConfiguration(
        assistant,
        { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
        "openai-secret",
      ),
    ).toEqual({
      model: "openai/gpt-4.1",
      prompt: "You are General Assistant, Everyday work.\n\nBe helpful.",
      apiKey: "openai-secret",
      // `forceReasoning` too: without it the provider drops the effort for every model name it does
      // not recognise, which includes the one this product actually serves. See the wire test.
      providerOptions: {
        openai: { reasoningEffort: "medium", forceReasoning: true },
      },
    });
  });

  test("carries the Bot's own effort into the call", () => {
    // The three the schema names, in the words the provider uses. A person choosing between "low"
    // and "high" is being asked to reason about somebody's API, so the translation happens here.
    const effortOf = (effort: "quick" | "balanced" | "thorough") =>
      (
        builtInAgentConfiguration(
          { ...assistant, effort },
          { provider: "openai", defaultModel: "gpt-5", supportsEffort: true },
          "openai-secret",
        ) as { providerOptions?: { openai?: { reasoningEffort?: string } } }
      ).providerOptions?.openai?.reasoningEffort;

    expect(effortOf("quick")).toBe("low");
    expect(effortOf("balanced")).toBe("medium");
    expect(effortOf("thorough")).toBe("high");
  });

  test("sends nothing at all where the model takes no effort setting", () => {
    /*
     * The whole reason the flag exists. A model that does not reason answers a request carrying the
     * parameter with a 400 on some providers and silence on others, so a Bot somebody set to
     * "thorough" on a deployment running gpt-4.1 must send exactly what it sent before — not a
     * default effort, not an empty object, nothing.
     */
    expect(
      builtInAgentConfiguration(
        { ...assistant, effort: "thorough" },
        { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: false },
        "openai-secret",
      ),
    ).toEqual({
      model: "openai/gpt-4.1",
      prompt: "You are General Assistant, Everyday work.\n\nBe helpful.",
      apiKey: "openai-secret",
    });
  });

  test("fails an unavailable built-in agent through the AG-UI lifecycle", async () => {
    const agents = buildAgents(
      [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          standing: "You are General Assistant.",
          systemPrompt: "Be helpful.",
          effort: "balanced",
        },
      ],
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      null,
    );
    const agent = agents["general-assistant"];
    if (!agent) {
      throw new Error("Expected the built-in agent");
    }
    let lifecycleError: Error | undefined;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        agent.runAgent(undefined, {
          onRunFailed: ({ error }) => {
            lifecycleError = error;
          },
        }),
      ).rejects.toThrow("Add the package credential or set OPENAI_API_KEY");
    } finally {
      consoleError.mockRestore();
    }
    expect(lifecycleError?.message).toContain(
      "Add the package credential or set OPENAI_API_KEY",
    );
  });

  test("constructs built-in and remote agents together", () => {
    const agents = buildAgents(
      [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      "openai-secret",
    );

    expect(agents["general-assistant"]).toBeInstanceOf(BuiltInAgent);
    expect(agents.risk).toBeInstanceOf(HttpAgent);
  });

  /*
   * The watch goes on the fetch of a remote Bot and nowhere else.
   *
   * A built-in agent talks to a model provider through the AI SDK rather than over an AG-UI stream,
   * so there is no response body here to watch and nothing for the guard to be given. Asserting the
   * Bot's own name reaches it matters because that name is what the person is shown when its stream
   * goes quiet, and a guard handed the wrong one would say so convincingly.
   */
  test("hands a remote Bot's fetch to the stall guard, and a built-in Bot none", () => {
    const watched: { id: string; name: string }[] = [];
    const stallGuard = {
      watch: (bot: { id: string; name: string }) => {
        watched.push(bot);
        return async () => new Response(null);
      },
      stop: () => undefined,
    };

    const agents = buildAgents(
      [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      "openai-secret",
      stallGuard,
    );

    expect(watched).toEqual([{ id: "risk", name: "Risk" }]);
    expect(agents.risk).toBeInstanceOf(HttpAgent);
  });

  /*
   * Told apart by a sentinel, because nothing else tells them apart.
   *
   * @ag-ui/client fills `fetch` in with a wrapper of its own whenever the config does not carry one,
   * so a remote Bot always has a function there and asserting that it does asserts nothing at all.
   * The same registration is built twice, with a guard whose watch returns a fetch nothing else
   * could have produced and then without one, and the two are compared.
   */
  test("leaves a remote Bot's fetch alone when no timeout is configured", () => {
    const sentinel = async () => new Response(null);
    const registered = [
      {
        id: "risk",
        name: "Risk",
        type: "remote_ag_ui" as const,
        endpoint: "http://risk.internal/ag-ui",
      },
    ];
    const model = { provider: "openai" as const, defaultModel: "gpt-4.1" };

    const guarded = buildAgents(registered, model, null, {
      watch: () => sentinel,
      stop: () => undefined,
    }).risk;
    const unguarded = buildAgents(registered, model, null).risk;
    if (!(guarded instanceof HttpAgent) || !(unguarded instanceof HttpAgent)) {
      throw new Error("Expected the remote agent");
    }

    expect(guarded.fetch).toBe(sentinel);
    expect(unguarded.fetch).not.toBe(sentinel);
  });

  test("resolves fresh built-in agents and credentials for every request", async () => {
    const registered = [
      {
        id: "general-assistant",
        name: "General Assistant",
        type: "built_in" as const,
        systemPrompt: "Be helpful.",
      },
    ];
    let resolutionCount = 0;
    const resolveModelApiKey = async () => {
      resolutionCount += 1;
      return resolutionCount === 1 ? "first-secret" : null;
    };

    const first = await resolveRuntimeAgents(
      async () => registered,
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      resolveModelApiKey,
    );
    const second = await resolveRuntimeAgents(
      async () => registered,
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      resolveModelApiKey,
    );

    expect(first["general-assistant"]).not.toBe(second["general-assistant"]);
    expect(resolutionCount).toBe(2);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(second["general-assistant"]?.runAgent()).rejects.toThrow(
        "Add the package credential or set OPENAI_API_KEY",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("does not resolve model credentials for remote-only agents", async () => {
    let resolverInvoked = false;
    const agents = await resolveRuntimeAgents(
      async () => [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      async () => {
        resolverInvoked = true;
        throw new Error("corrupt model credential");
      },
    );

    expect(agents.risk).toBeInstanceOf(HttpAgent);
    expect(resolverInvoked).toBe(false);
  });
});

/**
 * A coworker's job is durable: it lives on the profile, not in the conversation. Every run of a
 * remote agent therefore carries a standing role message the person never has to retype, and the
 * runtime resolves which agents exist per request so one person's private coworker is not another's.
 */
describe("standing agent roles", () => {
  const profile = {
    id: "agent_expense",
    name: "Expense Manager",
    title: "Finance Operations",
    roleDescription:
      "Review receipts, categorize expenses, and prepare reimbursement reports.",
  };

  test("builds a stable, framework-neutral standing role message", () => {
    expect(standingRoleMessage(profile)).toEqual({
      id: "standing-role:agent_expense",
      role: "system",
      content: [
        "You are Expense Manager, Finance Operations.",
        "Review receipts, categorize expenses, and prepare reimbursement reports.",
        "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
      ].join("\n\n"),
    });
  });

  test("sends one standing role message ahead of the conversation", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const agents = buildAgents(
      [remoteAgent(endpoint.url)],
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      null,
    );

    const agent = agents.agent_expense;
    // A replayed thread already carries the standing message; it must not produce a second copy.
    agent?.setMessages([
      standingRoleMessage(profile),
      userMessage("Sort these."),
    ]);
    const result = await agent?.runAgent();

    const sent = endpoint.requests.at(-1);
    expect(sent?.messages).toEqual([
      standingRoleMessage(profile),
      userMessage("Sort these."),
    ]);
    expect(result?.newMessages?.at(-1)?.content).toBe("Categorized.");
  });

  test("keeps the standing role out of forwarded props and agent state", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const agents = buildAgents(
      [remoteAgent(endpoint.url)],
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      null,
    );

    const agent = agents.agent_expense;
    agent?.setMessages([userMessage("Sort these.")]);
    await agent?.runAgent();

    const sent = endpoint.requests.at(-1);
    expect(JSON.stringify(sent?.forwardedProps ?? {})).not.toContain(
      "standing-role",
    );
    expect(JSON.stringify(sent?.state ?? {})).not.toContain("standing-role");
  });

  test("resolves a deleted coworker as a tombstone that never reaches its endpoint", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const agents = buildAgents(
      [
        {
          id: "agent_expense",
          name: "Expense Manager",
          type: "unavailable",
          reason: "Expense Manager has been deleted.",
        },
      ],
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      null,
    );

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(agents.agent_expense?.runAgent()).rejects.toThrow(
        "Expense Manager has been deleted.",
      );
    } finally {
      consoleError.mockRestore();
    }
    // A tombstone exists so Intelligence can restore the thread, not so it can run.
    expect(agents.agent_expense).toBeDefined();
    expect(endpoint.requests).toEqual([]);
  });

  test("resolves agents per request from the requesting actor", async () => {
    const seen: { request?: Request; actors: unknown[] } = { actors: [] };
    const factory = createRequestAgents(
      async (request) => {
        seen.request = request;
        return { id: "user-7", role: "user" as const };
      },
      async (actor) => {
        seen.actors.push(actor);
        return [remoteAgent("http://coworker.internal/ag-ui")];
      },
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      async () => null,
    );

    const request = new Request("http://laf.test/api/copilotkit");
    const resolved = await factory({ request });

    expect(seen.request).toBe(request);
    expect(seen.actors).toEqual([{ id: "user-7", role: "user" }]);
    expect(resolved.agent_expense).toBeInstanceOf(HttpAgent);
  });

  test("rebuilds each agent from the loader so an edited role applies to the next run", async () => {
    let roleDescription = "Review receipts.";
    const factory = createRequestAgents(
      async () => ({ id: "user-7", role: "user" as const }),
      async () => [
        remoteAgent("http://coworker.internal/ag-ui", { roleDescription }),
      ],
      { provider: "openai", defaultModel: "gpt-4.1", supportsEffort: true },
      async () => null,
    );
    const request = new Request("http://laf.test/api/copilotkit");

    const before = await factory({ request });
    roleDescription = "Reconcile corporate card statements.";
    const after = await factory({ request });

    expect(before.agent_expense).not.toBe(after.agent_expense);
    expect(standingRoleMessage({ ...profile, roleDescription }).content).toBe(
      [
        "You are Expense Manager, Finance Operations.",
        "Reconcile corporate card statements.",
        "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
      ].join("\n\n"),
    );
  });

  function remoteAgent(
    endpoint: string,
    overrides: Partial<typeof profile> = {},
  ) {
    const resolved = { ...profile, ...overrides };
    return {
      id: resolved.id,
      name: resolved.name,
      type: "remote_ag_ui" as const,
      endpoint,
      standingMessage: standingRoleMessage(resolved),
    };
  }
});

function userMessage(content: string) {
  return { id: `user-${content}`, role: "user" as const, content };
}

/**
 * An AG-UI server that records what it was sent and answers with a complete run, so the standing
 * role can be asserted on the wire rather than on the object that was supposed to send it.
 */
function fakeAgUiEndpoint() {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const input = (await request.json()) as Record<string, unknown>;
      requests.push(input);
      const { threadId, runId } = input as { threadId: string; runId: string };
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "TEXT_MESSAGE_START", messageId: "reply-1", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "reply-1",
          delta: "Categorized.",
        },
        { type: "TEXT_MESSAGE_END", messageId: "reply-1" },
        { type: "RUN_FINISHED", threadId, runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  return {
    requests,
    url: `http://localhost:${server.port}/ag-ui`,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}

/**
 * That a remote Bot's run carries how hard it should think.
 *
 * THE CASE THAT WAS MISSED. `builtInAgentConfiguration` above is the path a package's own Bots take,
 * and it is the only path the setting reached when it shipped. Every Bot anybody creates is
 * `remote_ag_ui`, answered by this deployment's own `agent-bot`, so the setting reached nothing a
 * person would ever make — and reading it back off the profile said `thorough` the whole time.
 *
 * Driven through the agent's own fetch rather than by reaching into its middleware: what matters is
 * the request that leaves, and the middleware is an implementation detail that a version bump is
 * free to rename. The stall guard is the supported way to hand one in, and it is the same seam this
 * file already uses to prove a remote Bot is watched.
 */
describe("a remote Bot's run", () => {
  const risk = {
    id: "risk",
    name: "Risk",
    type: "remote_ag_ui" as const,
    endpoint: "http://risk.internal/ag-ui",
    standingMessage: standingRoleMessage(riskRow),
    effort: "thorough" as const,
  };

  /** Run one turn against a fetch that records, and hand back the body the endpoint would receive. */
  async function bodySentBy(
    agent: typeof risk,
    supportsEffort: boolean,
    props: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> = {};
    const recordingFetch = async (_url: unknown, init?: { body?: unknown }) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      // One RUN_FINISHED and nothing else: the request is the assertion, and a body the client can
      // parse keeps the failure out of the way of it.
      return new Response(
        `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: "t1", runId: "r1" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const agents = buildAgents(
      [agent],
      { provider: "openai", defaultModel: "laf-1", supportsEffort },
      null,
      { watch: () => recordingFetch as never },
    );
    /*
     * The client logs the stream it could not parse. It is caught and irrelevant — the request has
     * already been recorded — but a whole minified bundle printed into the suite's output three
     * times is how a real failure gets scrolled past, so it is silenced for the duration.
     */
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await (agents.risk as HttpAgent)
        .runAgent({
          // Not the Bot's own effort: what a caller forwarded, which must survive.
          forwardedProps: props,
          messages: [{ id: "m1", role: "user", content: "안녕" }],
        } as never)
        .catch(() => {});
    } finally {
      consoleError.mockRestore();
    }
    return sent;
  }

  test("carries the effort, in the product's own words", async () => {
    // `thorough`, not `high`: the two services that answer a Bot speak different APIs and each
    // translates its own. See the middleware's comment.
    const body = await bodySentBy(risk, true);
    expect(
      (body.forwardedProps as Record<string, unknown> | undefined)?.effort,
    ).toBe("thorough");
  });

  test("leaves what the caller forwarded alone", async () => {
    const forwarded = (await bodySentBy(risk, true, { threadName: "Q3" }))
      .forwardedProps as Record<string, unknown>;
    expect(forwarded.threadName).toBe("Q3");
    expect(forwarded.effort).toBe("thorough");
  });

  test("sends none where the deployment's model takes none", async () => {
    const forwarded = (await bodySentBy(risk, false)).forwardedProps as
      | Record<string, unknown>
      | undefined;
    expect(forwarded?.effort).toBeUndefined();
  });
});
