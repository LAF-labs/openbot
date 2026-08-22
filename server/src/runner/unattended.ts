/**
 * A Bot running with nobody watching — and with its tools.
 *
 * Every tool this product has is registered in the browser: CopilotKit hands the model a tool, the
 * model asks for it, the run ENDS, the browser executes it and starts another run carrying the
 * answer. That is the right shape for a conversation and the wrong one for six in the morning,
 * when there is no browser. So `runAgentOnce` ran "with no tools in the room" — and a routine that
 * can only think, never look, answers "check whether the supplier posted new prices" with confident
 * fiction.
 *
 * This is the same loop the browser runs, moved to the server and written by hand: offer the tools,
 * run, execute whatever the model asked for through the SAME gateway and plugin store the browser
 * calls — the policy, the grants, the audit row and the approval registry are all underneath those,
 * so nothing here can do what a person's own tab could not — append the results, run again. Until
 * the model stops asking, or the budget runs out.
 *
 * What is deliberately NOT offered: `computer_request_help` and `computer_request_secret`. Both
 * exist to hand the wheel to a person at the screen, and there is no screen. A run that needs one
 * says so in its answer instead, which is the honest outcome.
 */
import { randomUUID } from "node:crypto";
import type {
  AbstractAgent,
  AgentSubscriber,
  Message,
  Tool,
} from "@ag-ui/client";
import {
  type ActionActor,
  ActionNeedsApprovalError,
  ActionRefusedError,
  type ComputerGateway,
} from "../computer/gateway";
import {
  PluginNeedsApprovalError,
  PluginRefusedError,
  type PluginStore,
} from "../plugins/store";

/** What a tool hands back to the model. The same envelope the browser's handlers return. */
export type ToolOutcome = Record<string, unknown> & { ok: boolean };

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  /** The call being executed. A room needs its id: the browser draws the message under it. */
  call?: { id: string },
) => Promise<ToolOutcome>;

export type UnattendedToolkit = {
  tools: Tool[];
  execute: ToolExecutor;
};

/**
 * The slice of an agent the loop needs. Named so a test can hand in a fake without subclassing a
 * class whose constructor wants a transport.
 */
export type LoopAgent = Pick<
  AbstractAgent,
  "runAgent" | "setMessages" | "addMessage" | "messages"
> & { abortRun?: () => void };

export type UnattendedRunOptions = {
  toolkit: UnattendedToolkit;
  /** The whole run, tools included. A loop that cannot end is the failure this bounds. */
  timeoutMs: number;
  /**
   * How many times the model may come back asking for tools. Twelve is generous for "open a
   * page, read it, save a note" and short of a Bot clicking around a site until the timeout.
   */
  maxSteps?: number;
  /**
   * What the run is told about its situation, ahead of the instruction.
   *
   * A routine gets `UNATTENDED_NOTE` — nobody is watching, do not wait for anyone. A room turn gets
   * something else entirely: who is in the room and how to talk in it. Same loop either way, which
   * is the point of the parameter rather than a second loop.
   */
  preamble?: string;
  /**
   * Somebody watching the model's events as they arrive.
   *
   * A room turn relays them to the browser so a person sees the Bot typing. Merged UNDER the loop's
   * own two handlers on purpose: the loop reads `onRunErrorEvent` and `onRunFinishedEvent` to tell
   * a stream that failed from one that simply ended, and a watcher that shadowed either would take
   * that away silently.
   */
  watch?: AgentSubscriber;
};

/** One turn of the model, for the record a routine keeps and an operator reads. */
export type UnattendedStep = {
  /** Wall-clock milliseconds the model took for this turn. */
  ms: number;
  /** Characters of prose the turn produced. Zero on a turn that only asked for tools. */
  text: number;
  /** The tools the turn asked for, and whether each one went through. */
  calls: Array<{ name: string; ok: boolean }>;
};

export type UnattendedRunResult = {
  /**
   * What the Bot said on its LAST turn — the answer, not the narration. A model that says "let me
   * check" before every tool call would otherwise deliver three "let me check"s ahead of the
   * sentence that was asked for. A last turn that said nothing (a refused tool call, say) falls
   * back to the last thing it did say, so a run that spoke at all never delivers blank.
   */
  answer: string;
  /** The turns, in order. The shape of the run: how many, how long, what each asked for. */
  steps: UnattendedStep[];
  /** The run stopped because something needs a person, and this is what. */
  awaiting: string | null;
};

const DEFAULT_MAX_STEPS = 12;

/**
 * Told to the model once, up front. It changes what a good answer is: a Bot that would normally
 * ask "shall I sign in for you?" has nobody to ask, and should say that rather than wait.
 */
const UNATTENDED_NOTE =
  "This run is unattended: it was started by a schedule, and nobody is watching the screen. " +
  "Use your tools to actually look things up rather than guessing. If something needs a " +
  "person — a sign-in, a code, an approval — say exactly what in your answer and stop; do not " +
  "wait for them and do not try another way round it.";

/**
 * A run that did not get to an answer, carrying the turns it did take.
 *
 * The routine's record keeps those turns whichever way the run ended; a failure that threw them
 * away would leave "Failed" with no account of how far the Bot got.
 */
export class UnattendedRunError extends Error {
  constructor(
    message: string,
    public readonly steps: UnattendedStep[],
  ) {
    super(message);
    this.name = "UnattendedRunError";
  }
}

class RunDeadline extends UnattendedRunError {
  constructor(steps: UnattendedStep[]) {
    super("The run did not finish in time.", steps);
    this.name = "RunDeadline";
  }
}

/**
 * The Bot's stream ended with RUN_ERROR — its provider failed, or the stall watchdog gave up on it.
 *
 * `runAgent` RESOLVES on that event: AG-UI treats RUN_ERROR as a message about the run, not a
 * failure of the call, and hands it to a subscriber. Without reading it the loop saw a turn that
 * simply ended, found no tool calls pending, and returned whatever prose had arrived before the
 * cut — half a sentence, delivered as a finished answer with `ok: true` on the record. A run the
 * Bot did not finish is a failed run, and the person reads the reason, not the fragment.
 */
class RunFailed extends UnattendedRunError {
  constructor(message: string, steps: UnattendedStep[]) {
    super(`The Bot stopped before it finished: ${message}`, steps);
    this.name = "RunFailed";
  }
}

/** The tool calls in the agent's thread that no tool message has answered yet. */
function unanswered(messages: Message[]) {
  const answered = new Set(
    messages
      .filter((message) => message.role === "tool")
      .map((message) => (message as { toolCallId: string }).toolCallId),
  );
  const pending: Array<{ id: string; name: string; args: string }> = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!answered.has(call.id) && call.function?.name) {
        pending.push({
          id: call.id,
          name: call.function.name,
          args: call.function.arguments ?? "{}",
        });
      }
    }
  }
  return pending;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function runUnattended(
  target: LoopAgent,
  instruction: string,
  options: UnattendedRunOptions,
): Promise<UnattendedRunResult> {
  const deadline = Date.now() + options.timeoutMs;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const steps: UnattendedStep[] = [];
  let awaiting: string | null = null;

  target.setMessages([
    {
      id: randomUUID(),
      role: "system",
      content: options.preamble ?? UNATTENDED_NOTE,
    },
    { id: randomUUID(), role: "user", content: instruction },
  ]);

  /*
   * The deadline ABORTS, not just rejects. Racing a timer against the run and walking away left
   * the agent's stream open and a built-in Bot still generating after the routine had been marked
   * failed and its ledger row closed — cost and work continuing past the point anything reported
   * them. `abortRun` is AG-UI's own cancellation; the fake agent in tests has none, hence optional.
   *
   * Each timer is cleared once its wait settles. Left armed, every wait of the run would fire at
   * the deadline — after the run had finished — and abort whatever the agent was doing by then.
   */
  const withDeadline = <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          target.abortRun?.();
          reject(new RunDeadline(steps));
        },
        Math.max(0, deadline - Date.now()),
      );
      timer.unref?.();
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
  };

  /**
   * One turn of the model, watched.
   *
   * The subscriber is how a RUN_ERROR reaches this loop at all; see `RunFailed`. The step record
   * is taken from the messages the turn added, which is also what the next turn's `unanswered`
   * reads, so the record and the loop cannot disagree about what the model asked for.
   */
  const turn = async (tools: Tool[]): Promise<void> => {
    const startedAt = Date.now();
    let failure: string | null = null;
    let finished = false;
    const before = target.messages.length;
    await withDeadline(
      target.runAgent(
        { tools },
        {
          ...options.watch,
          onRunErrorEvent: ({ event }) => {
            failure = event.message || "no reason was given";
            return {};
          },
          onRunFinishedEvent: () => {
            finished = true;
            return {};
          },
        },
      ),
    );
    /*
     * A stream that just ENDS — the connection dropped, a proxy's idle limit closed it, the
     * process behind it died — carries no RUN_ERROR to read. `runAgent` resolves on that too, and
     * the prose that had arrived by then looks exactly like a short answer. Only RUN_FINISHED
     * says the model meant to stop there.
     */
    if (failure === null && !finished) {
      failure = "its stream ended before the run finished";
    }
    const added = target.messages.slice(before);
    steps.push({
      ms: Date.now() - startedAt,
      text: added
        .filter((message) => message.role === "assistant")
        .reduce(
          (total, message) =>
            total +
            (typeof message.content === "string" ? message.content.length : 0),
          0,
        ),
      calls: added.flatMap((message) =>
        message.role === "assistant"
          ? (message.toolCalls ?? []).map((call) => ({
              name: call.function?.name ?? "",
              ok: false,
            }))
          : [],
      ),
    });
    if (failure !== null) throw new RunFailed(failure, steps);
  };

  /**
   * Mark the outcome of the call at `index` in the turn that just ran.
   *
   * BY INDEX, NOT BY NAME. Matching on the name found the first unresolved call with that name, so
   * a model asking for `computer_navigate` twice — the first failing, the second succeeding — set
   * the FAILED one to succeeded and left the successful one marked failed. The operator's run
   * history then said the wrong page had loaded. `pending` and `step.calls` are built in the same
   * order from the same messages, so the index is exact.
   */
  const record = (index: number, ok: boolean) => {
    const call = steps.at(-1)?.calls[index];
    if (call) call.ok = ok;
  };

  for (let step = 0; step <= maxSteps; step += 1) {
    await turn(options.toolkit.tools);

    const pending = unanswered(target.messages);
    if (pending.length === 0) break;

    /*
     * The last round, and the model is still asking. Answer every call with the same refusal
     * rather than leaving them dangling: a thread ending on an unanswered tool call is one the
     * provider rejects on the NEXT run, which would break the Bot's conversation, not just this one.
     */
    const outOfSteps = step === maxSteps;

    for (const [index, call] of pending.entries()) {
      let outcome: ToolOutcome;
      if (outOfSteps) {
        outcome = {
          ok: false,
          reason:
            "This run has used up its tool budget. Answer with what you have found so far.",
        };
      } else {
        outcome = await withDeadline(
          options.toolkit.execute(call.name, parseArgs(call.args), {
            id: call.id,
          }),
        );
      }
      record(index, outcome.ok);
      if (outcome.awaitingApproval === true && awaiting === null) {
        awaiting = String(outcome.question ?? outcome.reason ?? "");
      }
      target.addMessage({
        id: randomUUID(),
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(outcome),
      });
    }

    /*
     * The budget round told the model to answer with what it has. It has to be RUN for that to
     * happen: ending the loop here left the refusals as the last thing in the thread and the
     * promised answer never written. One more turn, with no tools on offer, so it can only speak.
     */
    if (outOfSteps) {
      await turn([]);
      /*
       * A model offered no tools can still emit a tool call — some do, out of habit. Those get the
       * same refusal and are never executed: the invariant that every call in the thread has an
       * answer holds all the way to the last message, whatever the model did with its last turn.
       */
      for (const call of unanswered(target.messages)) {
        // Answered so the thread has no dangling call, but NOT recorded: nothing was attempted.
        target.addMessage({
          id: randomUUID(),
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({
            ok: false,
            reason: "This run is over. Nothing more will be executed.",
          }),
        });
      }
    }
  }

  const said = target.messages
    .filter((message) => message.role === "assistant")
    .map((message) =>
      typeof message.content === "string" ? message.content.trim() : "",
    )
    .filter(Boolean);
  const answer = said.at(-1) ?? "";

  return { answer, steps, awaiting };
}

/* ------------------------------------------------------------------------------------------ */
/* The toolkit: the browser's tools, executed here.                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * The same envelope the browser hands the model when a gateway call does not go through.
 *
 * A refusal is final and says which rule; a question is a pause with the words a person would be
 * shown. Collapsing the two is the mistake the gateway's own error types exist to prevent, and a
 * model told "refused" for an ask-rule would learn to give up on exactly the actions the
 * deployment was willing to permit.
 */
export function outcomeOfError(error: unknown): ToolOutcome {
  if (
    error instanceof ActionNeedsApprovalError ||
    error instanceof PluginNeedsApprovalError
  ) {
    return {
      ok: false,
      awaitingApproval: true,
      approvalId: error.approvalId,
      question: error.question,
      rule: error.rule,
      reason:
        "A person has to allow that, and nobody is here right now. The request is waiting for " +
        "them. Say what you were waiting for and stop.",
    };
  }
  if (
    error instanceof ActionRefusedError ||
    error instanceof PluginRefusedError
  ) {
    return {
      ok: false,
      refused: true,
      reason: error.message,
      rule: error.rule,
    };
  }
  return {
    ok: false,
    reason: error instanceof Error ? error.message : "That did not work.",
  };
}

const REF_PARAMS = {
  ref: {
    type: "string",
    description: "Ref of the element, from your most recent snapshot",
  },
  snapshotId: {
    type: "number",
    description: "The snapshotId that ref came from",
  },
} as const;

/**
 * The computer tools, described in the same words the browser uses.
 *
 * The descriptions are the model-facing contract and they were tuned in the browser's
 * registrations; a second set of words here would drift, and a Bot would then behave differently
 * at six in the morning than it does at noon for no reason anybody could point to.
 */
function computerTools(): Tool[] {
  return [
    {
      name: "computer_navigate",
      description:
        "Open a web page on your own computer. Use this when asked to look at, visit, open or " +
        "check a website. Returns the page title and its readable text, so answer from what comes " +
        "back rather than telling the person to go and look.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full web address to open, including https://",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "computer_read",
      description:
        "Read the page currently open on your computer, without opening anything. Use this after " +
        "you have navigated or acted, to see what the page says now.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "computer_snapshot",
      description:
        "List the things on the current page you can act on: fields, buttons, links and " +
        "checkboxes, each with a ref, its label and its current value. Call this BEFORE clicking " +
        "or typing, and use the refs it returns. Always send back the snapshotId it gives you.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "computer_click",
      description:
        "Click something on the page: a button, a link, a checkbox or a radio option. Give the " +
        "ref from your most recent snapshot and the snapshotId it came from.",
      parameters: {
        type: "object",
        properties: REF_PARAMS,
        required: ["ref", "snapshotId"],
      },
    },
    {
      name: "computer_type",
      description:
        "Enter text into a field on the page. Give the ref of the field from your most recent " +
        "snapshot and the snapshotId it came from. This replaces whatever the field already " +
        "contains.",
      parameters: {
        type: "object",
        properties: {
          ...REF_PARAMS,
          text: { type: "string", description: "The text to enter" },
          submit: {
            type: "boolean",
            description:
              "Press Enter after typing, to submit a single-field form",
          },
        },
        required: ["ref", "snapshotId", "text"],
      },
    },
    {
      name: "computer_key",
      description:
        "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular " +
        "field is focused.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Key name, such as Enter, Tab or Escape",
          },
          ref: {
            type: "string",
            description: "Optional ref to press the key on",
          },
          snapshotId: {
            type: "number",
            description:
              "The snapshotId the ref came from, required if ref is given",
          },
        },
        required: ["key"],
      },
    },
    {
      name: "computer_scroll",
      description:
        "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
      parameters: {
        type: "object",
        properties: {
          deltaY: {
            type: "number",
            description: "Pixels to scroll; positive is down. Defaults to 600.",
          },
        },
      },
    },
    {
      name: "computer_list_files",
      description:
        "List what is in your workspace: every file and folder you have saved, with sizes. Call " +
        "this FIRST before reading a file whose exact name you are not sure of. Never guess a " +
        "filename.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional folder to list. Omit for the whole workspace.",
          },
        },
      },
    },
    {
      name: "computer_read_file",
      description:
        "Read a file you saved earlier in your own workspace. Paths are relative to your " +
        "workspace, such as notes.md or reports/august.csv. Your workspace survives between runs, " +
        "so use this to pick up notes you made before.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to your workspace, such as notes.md",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "computer_write_file",
      description:
        "Save a file in your own workspace so you still have it later. Paths are relative to " +
        "your workspace and folders are created as needed. Set append to true to add to the end " +
        "of an existing file rather than replacing it. Text only.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to your workspace, such as reports/august.csv",
          },
          contents: { type: "string", description: "The text to save" },
          append: {
            type: "boolean",
            description: "Add to the end of the file instead of replacing it",
          },
        },
        required: ["path", "contents"],
      },
    },
  ];
}

const asRef = (args: Record<string, unknown>) =>
  typeof args.ref === "string" && typeof args.snapshotId === "number"
    ? { ref: args.ref, snapshotId: args.snapshotId }
    : null;

export type UnattendedToolsOptions = {
  /** Absent when no computer is configured; the Bot then runs with plugin tools only. */
  gateway?: ComputerGateway;
  pluginStore?: Pick<PluginStore, "listForAgent" | "callTool">;
};

/**
 * Everything a given Bot may use right now, on behalf of a given person.
 *
 * Assembled per run rather than at boot, for the same reason the browser re-reads its grants: a
 * plugin granted a moment ago applies to the next run, and one revoked mid-week stops.
 */
export function createUnattendedTools(options: UnattendedToolsOptions) {
  return async (
    botId: string,
    actor: ActionActor,
    /** Who to write on the plugin audit row. The browser sends the person's email. */
    actorLabel: string,
  ): Promise<UnattendedToolkit> => {
    const { gateway, pluginStore } = options;
    const granted = pluginStore
      ? await pluginStore.listForAgent(botId)
      : { tools: [], skills: [] };

    const pluginByName = new Map(
      granted.tools.map((tool) => [tool.toolName, tool.ref] as const),
    );

    const tools: Tool[] = [
      ...(gateway ? computerTools() : []),
      ...granted.tools.map((tool) => ({
        name: tool.toolName,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    ];

    const execute: ToolExecutor = async (name, args) => {
      try {
        const ref = pluginByName.get(name);
        if (ref !== undefined && pluginStore) {
          const result = await pluginStore.callTool({
            ref,
            args,
            botId,
            actorId: actorLabel,
          });
          return { ok: !result.isError, text: result.text };
        }
        if (!gateway) {
          return { ok: false, reason: `There is no tool called ${name}.` };
        }
        // The computer id is the Bot id, exactly as the acting routes pass it.
        const c = botId;
        switch (name) {
          case "computer_navigate":
            return {
              ok: true,
              ...(await gateway.navigate(
                c,
                botId,
                actor,
                String(args.url ?? ""),
              )),
            };
          case "computer_read":
            return { ok: true, ...(await gateway.read(botId)) };
          case "computer_snapshot":
            return { ok: true, ...(await gateway.snapshot(botId)) };
          case "computer_click": {
            const target = asRef(args);
            if (!target)
              return {
                ok: false,
                reason: "A ref and its snapshotId are required.",
              };
            return {
              ok: true,
              ...(await gateway.click(c, botId, actor, target)),
            };
          }
          case "computer_type": {
            const target = asRef(args);
            if (!target || typeof args.text !== "string") {
              return {
                ok: false,
                reason: "A ref, its snapshotId and the text are required.",
              };
            }
            return {
              ok: true,
              ...(await gateway.type(c, botId, actor, {
                ...target,
                text: args.text,
                submit: args.submit === true,
              })),
            };
          }
          case "computer_key": {
            if (typeof args.key !== "string" || !args.key) {
              return {
                ok: false,
                reason: "A key name is required, such as Enter or Tab.",
              };
            }
            return {
              ok: true,
              ...(await gateway.key(c, botId, actor, {
                key: args.key,
                ...(asRef(args) ?? {}),
              })),
            };
          }
          case "computer_scroll":
            return {
              ok: true,
              ...(await gateway.scroll(c, botId, actor, {
                ...(typeof args.deltaY === "number"
                  ? { deltaY: args.deltaY }
                  : {}),
              })),
            };
          case "computer_list_files":
            return {
              ok: true,
              ...(await gateway.listFiles(c, botId, actor, {
                ...(typeof args.path === "string" ? { path: args.path } : {}),
              })),
            };
          case "computer_read_file":
            if (typeof args.path !== "string") {
              return { ok: false, reason: "A path is required." };
            }
            return {
              ok: true,
              ...(await gateway.readFile(c, botId, actor, { path: args.path })),
            };
          case "computer_write_file":
            if (
              typeof args.path !== "string" ||
              typeof args.contents !== "string"
            ) {
              return {
                ok: false,
                reason: "A path and the contents are required.",
              };
            }
            return {
              ok: true,
              ...(await gateway.writeFile(c, botId, actor, {
                path: args.path,
                contents: args.contents,
                append: args.append === true,
              })),
            };
          default:
            return { ok: false, reason: `There is no tool called ${name}.` };
        }
      } catch (error) {
        return outcomeOfError(error);
      }
    };

    return { tools, execute };
  };
}

export type UnattendedTools = ReturnType<typeof createUnattendedTools>;
