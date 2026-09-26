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
import type { AbstractAgent, Message, Tool } from "@ag-ui/client";
import { jsonObjectOf } from "../../../shared/json-object";
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

/** What a tool hands back to the model. The same envelope the browser's handlers return. */
export type ToolOutcome = Record<string, unknown> & { ok: boolean };

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  /**
   * The call being executed.
   *
   * `approvalId` is an answer a person has ALREADY given, presented for the call it was given for.
   * The same contract the browser keeps (`withApproval` in `lib/copilot/computer-tools.tsx`) and
   * the acting routes keep: the id alone proves nothing, it is the id together with the fingerprint
   * of the call actually being made. Without it a retry after an approval raises a SECOND question
   * — measured, 400 ms after the person pressed Allow — and the grant is spent on nothing.
   *
   * `signal` is aborted when the run's deadline passes. It reaches the computer (`computer/client.ts`):
   * a call that has not left yet does not leave, and one in flight is abandoned at the socket. Without
   * it the deadline only rejected and walked away, and the click it walked away from landed after the
   * run had been marked failed and the person told (audit A2 §2, 2026-09-10).
   */
  call?: { id: string; approvalId?: string; signal?: AbortSignal },
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
  /**
   * The run met a question only a person can answer: the fact, and never the words.
   *
   * It was the words, taken from the refusal envelope's `reason` — which is the sentence written FOR
   * THE MODEL ("…말하고 멈춰라. 다른 길로 돌아가지 마라.") — and the routine appended it to the
   * answer the person read, and the next run read it back as what it had reported (review
   * 2026-09-26). The question itself reaches the person through the approval registry and its
   * notification; what the run carries is only that it stopped for one.
   */
  awaiting: AwaitingCode | null;
};

/** Why a run stopped for a person. One kind today: a boundary asked, and nobody could answer. */
export const AWAITING_APPROVAL = "laf:awaiting_approval";
export type AwaitingCode = typeof AWAITING_APPROVAL;

/** Exported for the one reader that counts runs which met it (`insights/read.ts`, `limits`). */
export const DEFAULT_MAX_STEPS = 12;

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

/** The fact a stopped run ends on — in the error, the ledger and a routine's receipt alike. */
export const RUN_STOPPED = "laf:run_stopped";

/**
 * A person stopped the run (`UnattendedRunOptions.signal`).
 *
 * Not a failure, and kept apart from one by every caller that records the run: a routine's receipt
 * says it was stopped, a room does not count the member as unable to answer, and nobody is sent a
 * notification about a stop they made themselves. The message is the fact code, never a sentence:
 * the surface owns the words.
 */
export class RunStopped extends UnattendedRunError {
  constructor(steps: UnattendedStep[]) {
    super(RUN_STOPPED, steps);
    this.name = "RunStopped";
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

/**
 * A call's arguments, or null when they are not a JSON object.
 *
 * Null rather than `{}`. Broken arguments used to become an empty object and the tool ran with
 * nothing, so the model read "the field is missing" about a field it had sent, and sent it the same
 * broken way again (audit A2, row 5). `agent-bot` answers these inside the run before they get here;
 * this is the same answer for anything that does not.
 */
function parseArgs(raw: string): Record<string, unknown> | null {
  return jsonObjectOf(raw || "{}");
}

/**
 * Whether a call the Bot service answered itself went through, read off the answer it filed.
 *
 * A lookup's answer is prose and went through by definition. A guard's answer is the same envelope
 * every refusal has — `{"ok": false, "code": …}` — and recording it as done would put a tool that
 * was never run into the run history as a success.
 */
function answeredOk(content: unknown): boolean {
  if (typeof content !== "string") return true;
  try {
    const parsed: unknown = JSON.parse(content);
    return !(
      parsed &&
      typeof parsed === "object" &&
      (parsed as { ok?: unknown }).ok === false
    );
  } catch {
    return true;
  }
}

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
  const deadline = Date.now() + options.timeoutMs;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const steps: UnattendedStep[] = [];
  let awaiting: AwaitingCode | null = null;
  /** How many of the last step's calls the Bot service answered itself. See `turn`. */
  let settledAhead = 0;

  target.setMessages([
    { id: randomUUID(), role: "user", content: instruction },
  ]);

  /*
   * The deadline ABORTS, not just rejects. Racing a timer against the run and walking away left
   * the agent's stream open and a built-in Bot still generating after the routine had been marked
   * failed and its ledger row closed — cost and work continuing past the point anything reported
   * them. `abortRun` is AG-UI's own cancellation; the fake agent in tests has none, hence optional.
   *
   * AND THE TOOL CALL, not only the model. The same race walked away from a gateway call too, and
   * the call went on to completion: the click landed after the failure had been recorded and
   * reported. On a slow site the last action of a run can be a payment or a send, and a side
   * effect arriving after "failed" is the worst order there is short of acting unasked. The run
   * holds one controller; every executor call is handed its signal, and the computer client
   * honours it down to the socket.
   *
   * Each timer is cleared once its wait settles. Left armed, every wait of the run would fire at
   * the deadline — after the run had finished — and abort whatever the agent was doing by then.
   */
  const abort = new AbortController();
  /**
   * A person's stop, made the way the deadline's cut is made. The model's stream is aborted as well
   * as the calls, because a stop that only walked away would leave a Bot generating — and a person
   * who pressed stop to make it stop is owed that it did.
   */
  const stopped = (): RunStopped => {
    abort.abort();
    target.abortRun?.();
    return new RunStopped(steps);
  };
  const withDeadline = <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onStop: (() => void) | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          abort.abort();
          target.abortRun?.();
          reject(new RunDeadline(steps));
        },
        Math.max(0, deadline - Date.now()),
      );
      timer.unref?.();
      if (options.signal) {
        onStop = () => reject(stopped());
        if (options.signal.aborted) onStop();
        else options.signal.addEventListener("abort", onStop, { once: true });
      }
    });
    return Promise.race([promise, expiry]).finally(() => {
      clearTimeout(timer);
      if (onStop) options.signal?.removeEventListener("abort", onStop);
    });
  };
  // Stopped before it began — queued behind another run on the same Bot, say — asks nothing.
  if (options.signal?.aborted) throw stopped();

  /**
   * One turn of the model, watched.
   *
   * The subscriber is how a RUN_ERROR reaches this loop at all; see `RunFailed`. The step record
   * is taken from the messages the turn added, which is also what the next turn's `unanswered`
   * reads, so the record and the loop cannot disagree about what the model asked for.
   */
  const turn = async (tools: Tool[]): Promise<void> => {
    // Before the model is asked, not after: a stop that came in during a tool call starts nothing.
    if (options.signal?.aborted) throw stopped();
    const startedAt = Date.now();
    let failure: string | null = null;
    let finished = false;
    const before = target.messages.length;
    await withDeadline(
      target.runAgent(
        // The mode travels as a forwarded prop, which is where the prompt middleware reads it.
        {
          tools,
          forwardedProps: {
            mode: options.mode,
            ...(options.notepad?.length ? { notepad: options.notepad } : {}),
            ...(options.routineRun
              ? { routine: routineForwarded(options.routineRun) }
              : {}),
          },
        },
        {
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
     * `shared/tools/bridge.ts`) come back inside the same run with their result,
     * as a tool message the client files beside the call. They are through by definition, and
     * `unanswered` below will not hand them back — so they go FIRST in the record, and the open
     * calls after them sit at exactly the indexes `pending` will use. Without that split, the
     * send a Bot found through a lookup was marked against the lookup's slot.
     */
    const answeredInRun = new Map(
      added
        .filter((message) => message.role === "tool")
        .map((message) => [
          (message as { toolCallId: string }).toolCallId,
          answeredOk(message.content),
        ]),
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
          ok: answeredInRun.get(call.id) === true,
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
      const args = parseArgs(call.args);
      if (outOfSteps) {
        outcome = {
          ok: false,
          code: "laf:tool_budget_spent",
          reason: toolResultText("laf:tool_budget_spent"),
        };
      } else if (args === null) {
        outcome = {
          ok: false,
          code: "laf:tool_arguments_invalid",
          reason: toolResultText("laf:tool_arguments_invalid"),
        };
      } else {
        /*
         * Not started once the deadline has passed. Its timer lives only while something is being
         * waited on, so a deadline that fell between two waits has aborted nothing yet — and a call
         * started now would reach the computer before the timer below got the chance.
         */
        if (Date.now() >= deadline) {
          abort.abort();
          target.abortRun?.();
          throw new RunDeadline(steps);
        }
        // The same for a stop that landed between two waits: the next call must not leave.
        if (options.signal?.aborted) throw stopped();
        outcome = await withDeadline(
          options.toolkit.execute(call.name, args, {
            id: call.id,
            signal: abort.signal,
          }),
        );
      }
      record(index, outcome.ok);
      if (outcome.awaitingApproval === true) awaiting = AWAITING_APPROVAL;
      target.addMessage({
        id: randomUUID(),
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(forTheModel(outcome)),
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
 * An outcome as the model reads it: everything but the preview drawn for a person.
 *
 * The preview is the call's own arguments — a recipient, a mail body — cut for a card. The model
 * wrote them; echoed back into its context they are up to a thousand characters on every later
 * turn of the run, for nothing it can act on. The room's relay reads the outcome before this does,
 * so the card still gets it.
 */
function forTheModel({ preview: _forThePerson, ...said }: ToolOutcome) {
  return said;
}

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
