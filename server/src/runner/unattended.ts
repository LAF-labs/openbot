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
 * says so in its answer instead, which is the honest outcome. That exclusion is now a property of
 * the catalogue (`needsPerson`) rather than a hand-kept list here, so the prompt and the toolset
 * cannot disagree about it — which they did: the prompt told a routine to call a tool the routine
 * had never been given.
 */
import { randomUUID } from "node:crypto";
import type {
  AbstractAgent,
  AgentSubscriber,
  Message,
  Tool,
} from "@ag-ui/client";
import type { PromptMode } from "../../../shared/prompt";
import {
  noteTexts,
  toolResultText,
} from "../../../shared/prompt/tool-results.ko";
import { UNATTENDED_COMPUTER_TOOLS } from "../../../shared/tools/computer";
import { SKILL_VIEW } from "../../../shared/tools/skills";
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
  /**
   * The call being executed. A room needs its id: the browser draws the message under it.
   *
   * `approvalId` is an answer a person has ALREADY given, presented for the call it was given for.
   * The same contract the browser keeps (`withApproval` in `lib/copilot/computer-tools.tsx`) and
   * the acting routes keep: the id alone proves nothing, it is the id together with the fingerprint
   * of the call actually being made. Without it a retry after an approval raises a SECOND question
   * — measured, 400 ms after the person pressed Allow — and the grant is spent on nothing.
   */
  call?: { id: string; approvalId?: string },
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
   * Where this run is happening, forwarded to the endpoint so the prompt can be composed for it.
   *
   * A routine is told nobody is watching; a room turn is told how a room works. Same loop either
   * way, which is the point of one parameter rather than a second loop — but the WORDS are no
   * longer passed in from here. They live in `shared/prompt/mode`, composed by the one middleware
   * every run path already goes through, so a Bot cannot be told one thing in a room and another
   * in a routine by two files that never read each other.
   */
  mode: Extract<PromptMode, "room" | "routine">;
  /**
   * What the Bot remembers going in, placed between the situation note and the instruction.
   *
   * A routine has none: it is a standing order, not a conversation. A room turn carries the tail
   * of the Bot's own conversation with the person (`rooms/private-history.ts`), which is what lets
   * it answer "did you finish that?" in a room the way it would in private.
   */
  history?: Message[];
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
  /** How many of the last step's calls the Bot service answered itself. See `turn`. */
  let settledAhead = 0;

  target.setMessages([
    ...(options.history ?? []),
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
        // The mode travels as a forwarded prop, which is where the prompt middleware reads it.
        { tools, forwardedProps: { mode: options.mode } },
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
    /*
     * A CALL THE BOT SERVICE ANSWERED ITSELF. The bridge's lookups (`tool_search`,
     * `tool_describe` — `shared/tools/bridge.ts`) come back inside the same run with their result,
     * as a tool message the client files beside the call. They are through by definition, and
     * `unanswered` below will not hand them back — so they go FIRST in the record, and the open
     * calls after them sit at exactly the indexes `pending` will use. Without that split, the
     * send a Bot found through a lookup was marked against the lookup's slot.
     */
    const answeredInRun = new Set(
      added
        .filter((message) => message.role === "tool")
        .map((message) => (message as { toolCallId: string }).toolCallId),
    );
    const asked = added.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []) : [],
    );
    const settled = asked.filter((call) => answeredInRun.has(call.id));
    const open = asked.filter((call) => !answeredInRun.has(call.id));
    settledAhead = settled.length;
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
      calls: [
        ...settled.map((call) => ({
          name: call.function?.name ?? "",
          ok: true,
        })),
        ...open.map((call) => ({
          name: call.function?.name ?? "",
          ok: false,
        })),
      ],
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
    const call = steps.at(-1)?.calls[settledAhead + index];
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
          code: "laf:tool_budget_spent",
          reason: toolResultText("laf:tool_budget_spent"),
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
            code: "laf:run_over",
            reason: toolResultText("laf:run_over"),
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
      // The facts, for the room's card to say in Korean. It was the server's English sentence, which
      // a Korean-speaking member then read out into the room.
      subject: error.subject,
      rule: error.rule,
      // Carried so a room can offer the wider button too. Undefined where the question had no
      // derivable scope, which the room reads the same way the one-to-one card does.
      scope: error.scope,
      // And the middle one: "for this conversation", where the question came from one.
      threadId: error.threadId,
      expiresAt: error.expiresAt,
      code: "laf:nobody_answered",
      reason: toolResultText("laf:nobody_answered"),
    };
  }
  if (
    error instanceof ActionRefusedError ||
    error instanceof PluginRefusedError
  ) {
    /*
     * CODE IN, KOREAN OUT, THROUGH THE ONE TABLE.
     *
     * The message on both of these is a `laf:` fact now, not a sentence — the policy stopped writing
     * English the moment the surface started composing its own (§4-2). What the MODEL reads is the
     * Korean beside that code in `shared/prompt/tool-results.ko.ts`, which is the same table the
     * browser's tools read, so a refusal says the same thing to a Bot whether its turn is being
     * driven by a person's tab or by a routine at three in the morning.
     *
     * Anything without a code passes through unchanged, and visibly: a sentence from somewhere
     * upstream reaching a Bot is a regression, and swallowing it would hide the next one.
     *
     * `code` FIRST, THE MESSAGE ONLY AFTER IT. Reading the message alone is what shipped, and it
     * saw exactly the refusals whose message IS the code — the settle path's and the partner
     * tools'. Every refusal that carries a code BESIDE a sentence written for a person, which is
     * the whole connection layer (`laf:not_connected`, `laf:needs_reconnect`), fell through to
     * `error.message`: an English sentence, reaching a Korean-speaking person's Bot, from a class
     * that had the code in a field all along.
     */
    const code =
      error instanceof PluginRefusedError && error.code?.startsWith("laf:")
        ? error.code
        : error.message.startsWith("laf:")
          ? error.message
          : undefined;
    return {
      ok: false,
      refused: true,
      ...(code ? { code } : {}),
      reason: code ? toolResultText(code) : error.message,
      rule: error.rule,
    };
  }
  return {
    ok: false,
    reason: error instanceof Error ? error.message : "That did not work.",
  };
}

/**
 * The computer tools, from the one catalogue.
 *
 * Not "described in the same words the browser uses" any more — literally the same objects. The
 * words were copied here by hand and had already drifted: `computer_read_file` said the workspace
 * survives "between runs" here and "between conversations" in the browser, which is one Bot being
 * told two different things about the same folder depending on what started it.
 *
 * `needsPerson` is what the exclusion is made of. See the module comment.
 */
function computerTools(): Tool[] {
  return UNATTENDED_COMPUTER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

const asRef = (args: Record<string, unknown>) =>
  typeof args.ref === "string" && typeof args.snapshotId === "number"
    ? { ref: args.ref, snapshotId: args.snapshotId }
    : null;

/**
 * A computer result, with the facts the browser noticed put into words.
 *
 * The container ships `{code, message}` and knows no locale; the Korean a Bot reads is looked up
 * here, the same way a refusal's is. Without this a routine reads `laf:dialog` — a string it has
 * never seen — and goes on believing its click worked.
 */
const withNotes = <T extends Record<string, unknown>>(result: T) => {
  const said = noteTexts(result.notes);
  return said ? { ...result, notes: said } : result;
};

export type UnattendedToolsOptions = {
  /** Absent when no computer is configured; the Bot then runs with plugin tools only. */
  gateway?: ComputerGateway;
  pluginStore?: Pick<PluginStore, "listForAgent" | "callTool" | "viewSkill">;
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
      // Only where there is a skill to read. Every tool costs every turn, and a door with nothing
      // behind it is one the model will still try (CLAUDE.md, the footprint ladder).
      ...(granted.skills.length > 0
        ? [
            {
              name: SKILL_VIEW.name,
              description: SKILL_VIEW.description,
              parameters: SKILL_VIEW.parameters,
            },
          ]
        : []),
    ];

    const execute: ToolExecutor = async (name, args, call) => {
      // An answer already given, carried into the call it was given for. Undefined on a first try.
      const approvalId = call?.approvalId;
      try {
        const ref = pluginByName.get(name);
        if (ref !== undefined && pluginStore) {
          const result = await pluginStore.callTool({
            ref,
            args,
            botId,
            /*
             * The USER ID, not the label. A `user-oauth` server answers with the asker's own
             * grant, and the grant is keyed on `users.id` — a label here would refuse every such
             * call for want of a connection that actually exists. Rooms and routines both put the
             * person's id in `actor.id`.
             */
            actorId: actor.id,
            // The same conversation and the same delegation marker the computer's tools carry,
            // so a call to somebody else's server is settled in the same terms as a click.
            ...(actor.threadId ? { threadId: actor.threadId } : {}),
            ...(actor.delegated ? { delegated: actor.delegated } : {}),
            ...(approvalId ? { approvalId } : {}),
          });
          return { ok: !result.isError, text: result.text };
        }
        if (name === SKILL_VIEW.name && pluginStore) {
          // The store rechecks the grant and writes the `skill.viewed` row; this only asks.
          const viewed = await pluginStore.viewSkill({
            slug: String(args.name ?? ""),
            agentId: botId,
            actorId: actor.id,
          });
          if (!viewed.allowed) {
            return {
              ok: false,
              refused: true,
              code: viewed.reason,
              reason: toolResultText(viewed.reason),
            };
          }
          return { ok: true, ...viewed.skill };
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
              ...withNotes(
                await gateway.navigate(
                  c,
                  botId,
                  actor,
                  String(args.url ?? ""),
                  approvalId,
                ),
              ),
            };
          case "computer_read":
            return { ok: true, ...withNotes(await gateway.read(botId)) };
          case "computer_snapshot":
            return { ok: true, ...withNotes(await gateway.snapshot(botId)) };
          case "computer_switch_tab": {
            if (typeof args.index !== "number") {
              return { ok: false, reason: "A tab index is required." };
            }
            return {
              ok: true,
              ...withNotes(
                await gateway.switchTab(
                  c,
                  botId,
                  actor,
                  { index: args.index },
                  approvalId,
                ),
              ),
            };
          }
          case "computer_upload_file": {
            const target = asRef(args);
            if (!target || typeof args.path !== "string" || !args.path.trim()) {
              return {
                ok: false,
                reason: "A ref, its snapshotId and a file path are required.",
              };
            }
            return {
              ok: true,
              ...withNotes(
                await gateway.uploadFile(
                  c,
                  botId,
                  actor,
                  { ...target, path: args.path.trim() },
                  undefined,
                  approvalId,
                ),
              ),
            };
          }
          case "computer_click": {
            const target = asRef(args);
            if (!target)
              return {
                ok: false,
                reason: "A ref and its snapshotId are required.",
              };
            return {
              ok: true,
              ...withNotes(
                await gateway.click(
                  c,
                  botId,
                  actor,
                  target,
                  undefined,
                  approvalId,
                ),
              ),
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
              ...withNotes(
                await gateway.type(
                  c,
                  botId,
                  actor,
                  {
                    ...target,
                    text: args.text,
                    submit: args.submit === true,
                  },
                  undefined,
                  approvalId,
                ),
              ),
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
              ...withNotes(
                await gateway.key(
                  c,
                  botId,
                  actor,
                  { key: args.key, ...(asRef(args) ?? {}) },
                  undefined,
                  approvalId,
                ),
              ),
            };
          }
          case "computer_scroll":
            return {
              ok: true,
              ...withNotes(
                await gateway.scroll(
                  c,
                  botId,
                  actor,
                  {
                    ...(typeof args.deltaY === "number"
                      ? { deltaY: args.deltaY }
                      : {}),
                  },
                  approvalId,
                ),
              ),
            };
          case "computer_list_files":
            return {
              ok: true,
              ...(await gateway.listFiles(
                c,
                botId,
                actor,
                {
                  ...(typeof args.path === "string" ? { path: args.path } : {}),
                },
                approvalId,
              )),
            };
          case "computer_read_file":
            if (typeof args.path !== "string") {
              return { ok: false, reason: "A path is required." };
            }
            return {
              ok: true,
              ...(await gateway.readFile(
                c,
                botId,
                actor,
                { path: args.path },
                approvalId,
              )),
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
              ...(await gateway.writeFile(
                c,
                botId,
                actor,
                {
                  path: args.path,
                  contents: args.contents,
                  append: args.append === true,
                },
                approvalId,
              )),
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
