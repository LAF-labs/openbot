/**
 * The one loop a Bot's turn runs on when the server drives it: ask the model, carry out what it
 * asked for, file the results, ask again — until it stops asking or the budget runs out.
 *
 * It was `runUnattended`'s, written for a routine at six in the morning. A chat turn used to run
 * the same loop in the person's window instead — CopilotKit ran the model, the page executed the
 * tools and started the next run — which is why a long task died with the laptop lid. The window no
 * longer drives a turn (`turns/engine.ts`), so chat and routines run THIS loop, and differ only in
 * what they hand it: the thread and the toolkit, what rides on the run, and whether anybody is told
 * as it goes. See `unattended.ts` for the routine's side and `turns/engine.ts` for chat's.
 */
import { randomUUID } from "node:crypto";
import type { AbstractAgent, BaseEvent, Message, Tool } from "@ag-ui/client";
import { jsonObjectOf } from "../../../shared/json-object";
import { toolResultText } from "../../../shared/prompt/tool-results.ko";

/** What a tool hands back to the model. The same envelope the browser's handlers return. */
export type ToolOutcome = Record<string, unknown> & { ok: boolean };

/**
 * What a tool hands back, as the window's handlers did: an envelope, or a sentence. A sentence is
 * filed as it is and an envelope as JSON — CopilotKit's rule for a handler's return, kept so a Bot
 * reads the same result whichever side ran the call.
 */
export type LoopOutcome = ToolOutcome | string;

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

/** A chat toolkit's executor: the same call, answered as the window's handler answered it. */
export type LoopExecutor = (
  name: string,
  args: Record<string, unknown>,
  call: { id: string; signal: AbortSignal },
) => Promise<LoopOutcome>;

/**
 * The slice of an agent the loop needs. Named so a test can hand in a fake without subclassing a
 * class whose constructor wants a transport.
 */
export type LoopAgent = Pick<
  AbstractAgent,
  "runAgent" | "setMessages" | "addMessage" | "messages"
> & { abortRun?: () => void };

/** One turn of the model, for the record a routine keeps and an operator reads. */
export type UnattendedStep = {
  /** Wall-clock milliseconds the model took for this turn. */
  ms: number;
  /** Characters of prose the turn produced. Zero on a turn that only asked for tools. */
  text: number;
  /** The tools the turn asked for, and whether each one went through. */
  calls: Array<{ name: string; ok: boolean }>;
};

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

export class RunDeadline extends UnattendedRunError {
  constructor(steps: UnattendedStep[]) {
    super("The run did not finish in time.", steps);
    this.name = "RunDeadline";
  }
}

/** The fact a stopped run ends on — in the error, the ledger and a routine's receipt alike. */
export const RUN_STOPPED = "laf:run_stopped";

/**
 * A person stopped the run (`TurnLoopOptions.signal`).
 *
 * Not a failure, and kept apart from one by every caller that records the run: a routine's receipt
 * says it was stopped, and nobody is sent a notification about a stop they made themselves. The
 * message is the fact code, never a sentence: the surface owns the words.
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
 *
 * `reason` is what the Bot's stream said, unwrapped: a chat turn hands exactly that to the window,
 * which reads a failure code off it the way it read the RUN_ERROR it used to receive itself.
 */
export class RunFailed extends UnattendedRunError {
  constructor(
    readonly reason: string,
    steps: UnattendedStep[],
  ) {
    super(`The Bot stopped before it finished: ${reason}`, steps);
    this.name = "RunFailed";
  }
}

/** The tool calls in these messages that no tool message in them has answered yet. */
export function unanswered(messages: readonly Message[]) {
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

/**
 * An outcome as the model reads it: everything but the preview drawn for a person.
 *
 * The preview is the call's own arguments — a recipient, a mail body — cut for a card. The model
 * wrote them; echoed back into its context they are up to a thousand characters on every later
 * turn of the run, for nothing it can act on.
 */
function forTheModel({ preview: _forThePerson, ...said }: ToolOutcome) {
  return said;
}

/** A tool's outcome as the thread files it. See {@link LoopOutcome}. */
export function outcomeContent(outcome: LoopOutcome): string {
  return typeof outcome === "string"
    ? outcome
    : JSON.stringify(forTheModel(outcome));
}

export type TurnLoopOptions = {
  tools: Tool[];
  execute: LoopExecutor;
  /** The whole run, tools included. A loop that cannot end is the failure this bounds. */
  timeoutMs: number;
  /** How many times the model may come back asking for tools. */
  maxSteps: number;
  /** What rides on every run of the model: the prompt middleware reads the mode and the rest here. */
  forwardedProps: Record<string, unknown>;
  /**
   * The id each run of the model is made under, by its place in the loop — so what a run cost is
   * filed under something the ledger knows (`model.usage` rows carry it). Absent, AG-UI mints a
   * random one per run. Must differ per run: the Bot service names the messages a run writes after
   * its id (`agent-bot/src/turn.ts`), and two runs under one id would write over each other.
   */
  runIdFor?: (run: number) => string;
  /**
   * A person's stop. It cuts exactly where the deadline cuts, because it is the same cut on a
   * person's word instead of a clock's: the model's stream is aborted, the call in flight is
   * abandoned down to the socket, and nothing further is started. What already happened stays
   * happened. The run ends in {@link RunStopped}.
   */
  signal?: AbortSignal;
  /** Every event of every step, as it arrives. */
  observe?: (event: BaseEvent) => void;
  /** A tool's result, filed into the thread under its call. */
  onToolResult?: (
    message: Extract<Message, { role: "tool" }>,
    outcome: LoopOutcome,
  ) => void;
  /** A step of the model came back, before its tools are carried out. */
  onStep?: () => Promise<void> | void;
  /** A tool is about to be carried out. */
  onToolStart?: (call: { id: string; name: string }) => void;
};

export type TurnLoopResult = {
  steps: UnattendedStep[];
  /** The first question a tool stopped on because nobody was there to answer it. */
  awaiting: string | null;
};

/**
 * Run the loop over whatever the agent's thread already holds.
 *
 * Only the calls made during THIS loop are carried out. A thread handed in with an old call still
 * unanswered — a turn stopped last week — must not have that call run now, on a different page, for
 * a different question; the caller repairs such a thread before it gets here.
 */
export async function runTurnLoop(
  target: LoopAgent,
  options: TurnLoopOptions,
): Promise<TurnLoopResult> {
  const deadline = Date.now() + options.timeoutMs;
  const { maxSteps } = options;
  const steps: UnattendedStep[] = [];
  let awaiting: string | null = null;
  /** How many of the last step's calls the Bot service answered itself. See `turn`. */
  let settledAhead = 0;
  /** Where this loop's own messages begin. See the function's comment. */
  const from = target.messages.length;
  /** How many times the model has been asked in this loop. See `runIdFor`. */
  let runs = 0;

  /*
   * The deadline ABORTS, not just rejects. Racing a timer against the run and walking away left
   * the agent's stream open and a built-in Bot still generating after the routine had been marked
   * failed and its ledger row closed — cost and work continuing past the point anything reported
   * them. `abortRun` is AG-UI's own cancellation; the fake agent in tests has none, hence optional.
   *
   * AND THE TOOL CALL, not only the model. The same race walked away from a gateway call too, and
   * the call went on to completion: the click landed after the failure had been recorded and
   * reported. The run holds one controller; every executor call is handed its signal, and the
   * computer client honours it down to the socket.
   *
   * Each timer is cleared once its wait settles. Left armed, every wait of the run would fire at
   * the deadline — after the run had finished — and abort whatever the agent was doing by then.
   */
  const abort = new AbortController();
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

  const file = (call: { id: string }, outcome: LoopOutcome) => {
    const message = {
      id: randomUUID(),
      role: "tool" as const,
      toolCallId: call.id,
      content: outcomeContent(outcome),
    };
    target.addMessage(message);
    options.onToolResult?.(message, outcome);
  };

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
    const runId = options.runIdFor?.(runs);
    runs += 1;
    try {
      await withDeadline(
        target.runAgent(
          {
            tools,
            forwardedProps: options.forwardedProps,
            ...(runId ? { runId } : {}),
          },
          {
            onEvent: ({ event }) => {
              options.observe?.(event);
              return {};
            },
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
    } finally {
      // What the step said before it was cut is the Bot's, and a stop keeps it.
      await options.onStep?.();
    }
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
     * `shared/tools/bridge.ts`) come back inside the same run with their result, as a tool message
     * the client files beside the call. They are through by definition, and `unanswered` below will
     * not hand them back — so they go FIRST in the record, and the open calls after them sit at
     * exactly the indexes `pending` will use.
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
   * the FAILED one to succeeded and left the successful one marked failed. `pending` and
   * `step.calls` are built in the same order from the same messages, so the index is exact.
   */
  const record = (index: number, ok: boolean) => {
    const call = steps.at(-1)?.calls[settledAhead + index];
    if (call) call.ok = ok;
  };

  for (let step = 0; step <= maxSteps; step += 1) {
    await turn(options.tools);

    const pending = unanswered(target.messages.slice(from));
    if (pending.length === 0) break;

    /*
     * The last round, and the model is still asking. Answer every call with the same refusal
     * rather than leaving them dangling: a thread ending on an unanswered tool call is one the
     * provider rejects on the NEXT run, which would break the Bot's conversation, not just this one.
     */
    const outOfSteps = step === maxSteps;

    for (const [index, call] of pending.entries()) {
      let outcome: LoopOutcome;
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
        options.onToolStart?.({ id: call.id, name: call.name });
        outcome = await withDeadline(
          options.execute(call.name, args, {
            id: call.id,
            signal: abort.signal,
          }),
        );
      }
      record(index, typeof outcome === "string" ? true : outcome.ok);
      if (
        typeof outcome !== "string" &&
        outcome.awaitingApproval === true &&
        awaiting === null
      ) {
        awaiting = String(outcome.question ?? outcome.reason ?? "");
      }
      file(call, outcome);
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
      for (const call of unanswered(target.messages.slice(from))) {
        // Answered so the thread has no dangling call, but NOT recorded: nothing was attempted.
        file(call, {
          ok: false,
          code: "laf:run_over",
          reason: toolResultText("laf:run_over"),
        });
      }
    }
  }

  return { steps, awaiting };
}
