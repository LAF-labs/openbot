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
import type { BaseEvent, Tool } from "@ag-ui/client";
import type { PromptMode, RoutineNote } from "../../../shared/prompt";
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
import { readFileInputOf } from "../computer/schema";
import { snapshotForModel } from "../computer/snapshot-lines";
import {
  PluginNeedsApprovalError,
  PluginRefusedError,
  type PluginStore,
} from "../plugins/store";
import {
  type LoopAgent,
  runTurnLoop,
  type ToolExecutor,
  type ToolOutcome,
  type UnattendedStep,
} from "./turn-loop";

/*
 * The loop, its record and its endings live in `turn-loop.ts` now, where chat runs on them too. They
 * are named from here as well because every routine path already imports them from here.
 */
export {
  type LoopAgent,
  RUN_STOPPED,
  RunStopped,
  type ToolExecutor,
  type ToolOutcome,
  UnattendedRunError,
  type UnattendedStep,
} from "./turn-loop";

export type UnattendedToolkit = {
  tools: Tool[];
  execute: ToolExecutor;
};

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
   * A routine is told nobody is watching. The WORDS are not passed in from here: they live in
   * `shared/prompt/mode`, composed by the one middleware every run path already goes through.
   */
  mode: Extract<PromptMode, "routine">;
  /**
   * Where a routine left off (`routines/notepad.ts`), forwarded beside the mode for the same reason
   * the mode is: the words it is said in are composed by the prompt middleware, and this loop only
   * carries the facts. The middleware draws it for a routine and for nothing else.
   */
  notepad?: readonly RoutineNote[];
  /**
   * When this run was meant for — the clock's window, or null for Run now — forwarded like the
   * notepad: the middleware appends it to the instruction as a reminder, with the time it started.
   */
  routineRun?: { scheduledFor: Date | null };
  /**
   * A person's stop — `모두 멈추기` (`stop-all.ts`) — for work nobody is watching.
   *
   * It cuts exactly where the deadline cuts, because it is the same cut on a person's word instead
   * of a clock's: the model's stream is aborted, the call in flight is abandoned down to the socket,
   * and nothing further is started. What already happened stays happened. The run ends in
   * {@link RunStopped}, which every caller records as a stop and never as a failure.
   */
  signal?: AbortSignal;
  /**
   * Every event of every step, for the run's meter (`telemetry/run-meter.ts`). The routine's ledger
   * row is one run however many times the model is asked, and each ask is an AG-UI run of its own
   * with its own id — so the steps are handed over here, where they are still the routine's.
   */
  observe?: (event: BaseEvent) => void;
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

/** Exported for the one reader that counts runs which met it (`insights/read.ts`, `limits`). */
export const DEFAULT_MAX_STEPS = 12;

/** A routine run's times as they travel on the run: an ISO instant, or null when not scheduled. */
export function routineForwarded(run: { scheduledFor: Date | null }): {
  scheduledFor: string | null;
} {
  return { scheduledFor: run.scheduledFor?.toISOString() ?? null };
}

export async function runUnattended(
  target: LoopAgent,
  instruction: string,
  options: UnattendedRunOptions,
): Promise<UnattendedRunResult> {
  target.setMessages([
    { id: randomUUID(), role: "user", content: instruction },
  ]);
  const { steps, awaiting } = await runTurnLoop(target, {
    tools: options.toolkit.tools,
    execute: options.toolkit.execute,
    timeoutMs: options.timeoutMs,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    // The mode travels as a forwarded prop, which is where the prompt middleware reads it.
    forwardedProps: {
      mode: options.mode,
      ...(options.notepad?.length ? { notepad: options.notepad } : {}),
      ...(options.routineRun
        ? { routine: routineForwarded(options.routineRun) }
        : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  });

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
      // What an outward call will send, for the same card. Only a tool call has one.
      ...(error instanceof PluginNeedsApprovalError && error.preview
        ? { preview: error.preview }
        : {}),
      rule: error.rule,
      // Carried so a room can offer the wider button too. Undefined where the question had no
      // derivable scope, which the room reads the same way the one-to-one card does.
      scope: error.scope,
      // And the middle one: "for this conversation", where the question came from one.
      threadId: error.threadId,
      // And "for this task", where the server knew which task the conversation is on.
      taskId: error.taskId,
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
  /*
   * The same rule as the surface's `computer-tools.tsx`: a message that IS a fact code is said in
   * Korean, anything else is passed through where a person can see it and object. Without this the
   * navigation-timeout fact reached a routine's model as `laf:page_timeout`, a symbol it has never
   * seen, while the chat path read a sentence.
   */
  const said = error instanceof Error ? error.message : "";
  const code = said.startsWith("laf:") ? said : undefined;
  return {
    ok: false,
    ...(code ? { code } : {}),
    reason: code ? toolResultText(code) : said || "That did not work.",
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

/*
 * The two refusals this executor makes on its own, as facts the model reads in Korean.
 *
 * They were English sentences — "A ref and its snapshotId are required.", "There is no tool
 * called X." — written here and read by a model whose prompt tells it to answer in Korean. The
 * words come from the one table every other refusal uses (`shared/prompt/tool-results.ko.ts`), and
 * the tool definition says what the arguments are; repeating that here would be a second author.
 */
const invalidArguments = (): ToolOutcome => ({
  ok: false,
  code: "laf:tool_arguments_invalid",
  reason: toolResultText("laf:tool_arguments_invalid"),
});
const unknownTool = (): ToolOutcome => ({
  ok: false,
  code: "laf:tool_unknown",
  reason: toolResultText("laf:tool_unknown"),
});

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
      /*
       * ALWAYS, wherever skills can be read at all. It used to be offered only to a Bot holding a
       * skill — every tool costs every turn — but the tools are the head of the prompt, so a tool
       * that appears the day a skill is granted re-bills everything behind it, and one that comes
       * and goes is a prefix that never settles (agent-harness-design row 5; Claude Code never adds
       * or removes a tool mid-session). Its description says to read only a skill the prompt lists,
       * and a Bot with none is answered `laf:skill_not_granted` by the store. Phase 2 puts the rare
       * tools behind a stub and a search instead.
       */
      ...(pluginStore
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
             * call for want of a connection that actually exists. A routine puts the person's id in
             * `actor.id`.
             */
            actorId: actor.id,
            // The same conversation the computer's tools carry, so a call to somebody else's
            // server is settled in the same terms as a click.
            ...(actor.threadId ? { threadId: actor.threadId } : {}),
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
          return unknownTool();
        }
        // The computer id is the Bot id, exactly as the acting routes pass it.
        const c = botId;
        // The run's deadline, on its way to the computer. See `ToolExecutor`.
        const signal = call?.signal;
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
                  signal,
                ),
              ),
            };
          case "computer_read":
            return {
              ok: true,
              ...withNotes(
                await gateway.read(botId, {
                  whole: args.whole === true,
                  ...(typeof args.from === "string" && args.from.trim()
                    ? { from: args.from.trim() }
                    : {}),
                }),
              ),
            };
          case "computer_snapshot":
            return {
              ok: true,
              ...snapshotForModel(
                withNotes(await gateway.snapshot(botId, { botId, actor })),
              ),
            };
          case "computer_switch_tab": {
            if (typeof args.index !== "number") {
              return invalidArguments();
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
              return invalidArguments();
            }
            return {
              ok: true,
              ...withNotes(
                await gateway.uploadFile(
                  c,
                  botId,
                  actor,
                  { ...target, path: args.path.trim() },
                  signal,
                  approvalId,
                ),
              ),
            };
          }
          case "computer_click": {
            const target = asRef(args);
            if (!target) return invalidArguments();
            return {
              ok: true,
              ...withNotes(
                await gateway.click(
                  c,
                  botId,
                  actor,
                  target,
                  signal,
                  approvalId,
                ),
              ),
            };
          }
          case "computer_type": {
            const target = asRef(args);
            if (!target || typeof args.text !== "string") {
              return invalidArguments();
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
                  signal,
                  approvalId,
                ),
              ),
            };
          }
          case "computer_key": {
            if (typeof args.key !== "string" || !args.key) {
              return invalidArguments();
            }
            return {
              ok: true,
              ...withNotes(
                await gateway.key(
                  c,
                  botId,
                  actor,
                  { key: args.key, ...(asRef(args) ?? {}) },
                  signal,
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
          case "computer_read_file": {
            const input = readFileInputOf(args);
            if (!input) return invalidArguments();
            return {
              ok: true,
              ...(await gateway.readFile(c, botId, actor, input, approvalId)),
            };
          }
          case "computer_write_file":
            if (
              typeof args.path !== "string" ||
              typeof args.contents !== "string"
            ) {
              return invalidArguments();
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
            return unknownTool();
        }
      } catch (error) {
        return outcomeOfError(error);
      }
    };

    return { tools, execute };
  };
}
