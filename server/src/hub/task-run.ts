/**
 * One run of a task the company board gave this member's 라피 — on the routine's unattended run.
 *
 * NOT A SECOND RUNNER. A task is worked the way a routine is: `runUnattended`, on the one loop chat
 * and routines both run (`runner/turn-loop.ts`), with the toolkit routines are given
 * (`createUnattendedTools`: the same gateway, grants, policy and audit rows; no
 * `computer_request_help` or `computer_request_secret`, since nobody is at the screen), in the
 * routines' background browser and its lane, told it is a routine (`mode: "routine"`, so the head
 * of the prompt is a routine's, byte for byte), twelve steps and ten minutes. Nobody is asked
 * anything: an action that needs a person's yes is answered "waiting" at once, and the run is
 * reported `blocked` with the kind of action and where (`task-pickup.ts`).
 *
 * The chat turn engine (`turns/engine.ts`) is not used for it: its tools wait up to ten minutes on
 * a person for every question, and its run carries no mode, so a task there would be a
 * conversation the Bot believes somebody is watching.
 *
 * WHERE IT CAN BE READ. The task's own conversation, `task:<id>`, a project of the Bot's named after
 * the task (`channels/conversations.ts`, `taskConversation`): the task as it was given, as the
 * person's message, and every step the run took, filed when the run ends. The ledger row is opened
 * first and names that conversation, so the roster shows the Bot busy and a run the process died
 * under is reported against that conversation at the next boot (`reportInterruptedRuns`).
 */
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { AgentActor } from "../agents/profile-types";
import type { DeploymentAdmission } from "../auth/admission";
import { DEV_ACTOR } from "../auth/dev-actor";
import { taskConversation } from "../channels/conversations";
import type { AllowanceScope } from "../computer/standing-approvals";
import { topicOf } from "../computer/ask-topic";
import type { AskSubject } from "../computer/approvals";
import { laneOfBrowser } from "../computer/bot-id";
import type { ActionActor } from "../computer/gateway";
import type { Database } from "../db/client";
import { agentProfiles, lafThreadRuns, userRoles } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { ROUTINE_RUN_TIMEOUT_MS } from "../routines/run";
import type { BotLane } from "../runner/bot-lane";
import type { WorkInFlight } from "../runner/in-flight";
import type { RunLedger } from "../runner/run-ledger";
import { appendMessages } from "../runner/thread-store";
import { RunStopped } from "../runner/turn-loop";
import {
  type LoopAgent,
  runUnattended,
  type UnattendedToolkit,
} from "../runner/unattended";
import { createRunMeter } from "../telemetry/run-meter";
import { turnFailureOf } from "../turns/engine";
import type { RunBudget } from "./budget";
import type { TaskAsks } from "./task-asks";
import type { TaskRun, TaskRunOutcome, UnreportedRun } from "./task-pickup";
import type { HubTaskView } from "./wire";

/** The conversation a task is worked in. */
export const taskThreadOf = (taskId: string) => `task:${taskId}`;

/** A routine's step budget, and a task's. */
export const TASK_MAX_STEPS = 12;

export type TaskRunDeps = {
  database: Database;
  ledger: RunLedger;
  lane?: BotLane;
  work?: WorkInFlight;
  admission?: Pick<DeploymentAdmission, "admitsPerson">;
  resolveAgents: (
    actor: AgentActor,
  ) => Promise<Record<string, (LoopAgent & { threadId?: string }) | undefined>>;
  /** The routines' toolkit factory (`createUnattendedTools`). */
  tools: (
    botId: string,
    actor: ActionActor,
    where?: { browser: string },
  ) => Promise<UnattendedToolkit>;
  /**
   * The background browser the run's pages are in, and what its end does: the computer told the
   * run is over, and the browser let go of — a routine's end (`routines/run.ts`). Never throws.
   * Absent where there is no computer.
   */
  browser?: {
    name: string;
    ended: (botId: string, runKey: string, opened: boolean) => Promise<void>;
  };
  /** Whose 라피 this is. Absent: `deploymentBot`. */
  owner?: () => Promise<{ actor: AgentActor; botId: string } | null>;
  /**
   * The company's budget (`budget.ts`): a task's run is asked about before the Bot is, against the
   * workspace's day and the task's own, and what it cost is told after.
   */
  budget?: RunBudget;
  /**
   * Where a stop for a person's yes is kept (`task-asks.ts`), so "이 일감에서는 해도 돼" can be
   * granted from what the run actually met. Absent: the stop is noted on the board and nowhere else.
   */
  asks?: TaskAsks;
  timeoutMs?: number;
  maxSteps?: number;
};

/**
 * The deployment's person and their Bot: whose 라피 the board's `bot:<member>` is. One account per
 * deployment and one Bot per account (`docs/laf/deployment-model.md`); an account from before that
 * which kept several runs a task on the oldest.
 */
export async function deploymentBot(
  database: Database,
): Promise<{ actor: AgentActor; botId: string } | null> {
  const [bot] = await database
    .select({
      botId: agentProfiles.agentId,
      ownerId: agentProfiles.ownerUserId,
    })
    .from(agentProfiles)
    .where(
      and(
        isNull(agentProfiles.deletedAt),
        isNotNull(agentProfiles.ownerUserId),
      ),
    )
    .orderBy(asc(agentProfiles.createdAt), asc(agentProfiles.agentId))
    .limit(1);
  if (!bot?.ownerId) return null;
  const roles = await database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, bot.ownerId));
  return {
    actor: {
      id: bot.ownerId,
      role: roles.some((row) => row.role === "admin") ? "admin" : "user",
    },
    botId: bot.botId,
  };
}

/** What the person who gave the task wrote, as the Bot is handed it: the title, then the rest. */
export function taskInstruction(task: HubTaskView): string {
  const title = task.title.trim();
  const description = task.description?.trim() ?? "";
  return description ? `${title}\n\n${description}` : title;
}

/** The topic of a question nobody was there to answer: kind of action and where (`ask-topic.ts`). */
export { topicOf };

/** What a run stopped for a person on, read off the first outcome that said so. */
type Waiting =
  | {
      kind: "approval";
      topic: string;
      /** The stop's own rule, scope and subject, where the boundary named them. */
      ask: { rule: string; scope: AllowanceScope; subject: AskSubject } | null;
    }
  | { kind: "login" };

/** The rule, scope and subject a stop carried (`runner/unattended.ts`, `outcomeOfError`). */
function askOf(outcome: Record<string, unknown>): {
  rule: string;
  scope: AllowanceScope;
  subject: AskSubject;
} | null {
  const scope = outcome.scope as Partial<AllowanceScope> | undefined;
  const subject = outcome.subject as AskSubject | undefined;
  if (
    !scope ||
    (scope.kind !== "host" && scope.kind !== "file" && scope.kind !== "tool") ||
    typeof scope.value !== "string" ||
    !subject ||
    typeof subject !== "object"
  ) {
    return null;
  }
  return {
    rule: typeof outcome.rule === "string" ? outcome.rule : "",
    scope: { kind: scope.kind, value: scope.value },
    subject,
  };
}

/** The toolkit, with the first stop for a person noted on the way past. Nothing else changes. */
function watching(
  toolkit: UnattendedToolkit,
  noted: (waiting: Waiting) => void,
): UnattendedToolkit {
  return {
    ...toolkit,
    execute: async (name, args, call) => {
      const outcome = await toolkit.execute(name, args, call);
      if (outcome.awaitingApproval === true) {
        noted(
          outcome.code === "laf:login_not_saved"
            ? { kind: "login" }
            : {
                kind: "approval",
                topic: topicOf(outcome.subject),
                ask: askOf(outcome as Record<string, unknown>),
              },
        );
      }
      return outcome;
    },
  };
}

export function createTaskRun(deps: TaskRunDeps): TaskRun {
  const owner = deps.owner ?? (() => deploymentBot(deps.database));
  return async ({ task, runId, signal }): Promise<TaskRunOutcome> => {
    const who = await owner();
    if (!who) {
      return { kind: "failed", code: "laf:bot_not_found", steps: 0 };
    }
    const { actor, botId } = who;
    /*
     * NOBODY THE DEPLOYMENT NO LONGER ADMITS ACTS THROUGH A TASK — the rule a routine keeps
     * (`routines/run.ts`, `authorIsAdmitted`), and for the same reason: a lookup that fails counts
     * as no.
     */
    if (deps.admission) {
      const admitted = await deps.admission
        .admitsPerson(actor.id)
        .catch(() => false);
      if (!admitted) {
        return { kind: "failed", code: "laf:not_admitted", steps: 0 };
      }
    }
    const threadId = taskThreadOf(task.id);
    const conversation = await taskConversation(
      deps.database,
      actor,
      botId,
      threadId,
      task.title || task.id,
    );
    await deps.ledger.begin({
      runId,
      agentId: botId,
      userId: actor.id,
      threadId: conversation.threadId,
      origin: "chat",
      label: task.title || null,
    });

    const stopping = new AbortController();
    const cut = () => stopping.abort();
    if (signal.aborted) cut();
    else signal.addEventListener("abort", cut, { once: true });
    const done = deps.work?.track({
      kind: "chat",
      userId: actor.id,
      agentId: botId,
      threadId,
      stop: async () => {
        stopping.abort();
        return true;
      },
    });

    const asked: Message = {
      id: randomUUID(),
      role: "user",
      content: taskInstruction(task),
    };
    let target: LoopAgent | undefined;
    let waiting: Waiting | null = null;
    let outcome: TaskRunOutcome;
    const meter = createRunMeter();
    /*
     * THE COMPANY'S DAY, ASKED BEFORE THE BOT IS — the workspace's and this task's (`budget.ts`).
     * After the ledger row, so the refused run is in the task's conversation with its fact, and
     * before the lane and the model: a refused run sends nothing to the model.
     */
    const verdict = deps.budget
      ? await deps.budget.reserve({
          runId,
          scopes: [`task:${task.id}`],
          origin: "job",
        })
      : null;
    try {
      if (verdict && !verdict.go) {
        throw new BudgetRefused(verdict.code);
      }
      outcome = await inLane<TaskRunOutcome>(deps, botId, async () => {
        const agents = await deps.resolveAgents(actor);
        const agent = agents[botId];
        if (!agent) {
          return { kind: "failed", code: "laf:bot_not_found", steps: 0 };
        }
        target = agent;
        // The conversation's own id on every run, as a chat turn's: its context and its usage rows
        // are this conversation's, not a random one AG-UI would mint (`turns/engine.ts`).
        agent.threadId = threadId;
        const runKey = `task:${runId}`;
        const toolkit = await deps.tools(
          botId,
          // Who acts, and under which run: a question it raises is this run's.
          {
            id: actor.id,
            // The local actor is not a row in `users`, so it is named without claiming to be one.
            ...(actor.id === DEV_ACTOR.id ? {} : { userId: actor.id }),
            // And in which conversation: the task's project, so what it files goes in that
            // project's folder (`shared/file-scope.ts`). Without it the gateway takes the run for
            // the main conversation's, and its files outlive the project they were made for.
            threadId,
            runKey,
            runId,
            // The task it works: an allowance its person gave for this task answers here alone.
            boardTaskThreadId: threadId,
          },
          deps.browser ? { browser: deps.browser.name } : undefined,
        );
        try {
          const run = await runUnattended(agent, taskInstruction(task), {
            toolkit: watching(toolkit, (seen) => {
              waiting ??= seen;
            }),
            timeoutMs: deps.timeoutMs ?? ROUTINE_RUN_TIMEOUT_MS,
            maxSteps: deps.maxSteps ?? TASK_MAX_STEPS,
            mode: "routine",
            signal: stopping.signal,
            observe: meter.observe,
          });
          const steps = run.steps.length;
          const stoppedOn = waiting as Waiting | null;
          if (stoppedOn?.kind === "approval") {
            if (deps.asks && stoppedOn.ask) {
              // Kept so its person can answer it for this task. A write that fails loses the
              // button, not the run: the board is still told, and the next run stops again.
              await deps.asks
                .record({
                  taskId: task.id,
                  runId,
                  botId,
                  topic: stoppedOn.topic,
                  ...stoppedOn.ask,
                })
                .catch((error: unknown) => {
                  log.warn("task_ask_not_kept", {
                    task: task.id,
                    reason: describeFailure(error),
                  });
                });
            }
            return { kind: "approval", topic: stoppedOn.topic, steps };
          }
          if (stoppedOn?.kind === "login" || run.awaiting) {
            return { kind: "login", steps };
          }
          return { kind: "done", steps };
        } finally {
          await deps.browser
            ?.ended(botId, runKey, toolkit.browserOpened?.() !== false)
            .catch(() => undefined);
        }
      });
    } catch (error) {
      const steps =
        error && typeof error === "object" && "steps" in error
          ? ((error as { steps: unknown[] }).steps?.length ?? 0)
          : 0;
      if (error instanceof BudgetRefused) {
        outcome = { kind: "failed", code: error.code, steps: 0 };
      } else if (signal.aborted) outcome = { kind: "lost" };
      else if (error instanceof RunStopped || stopping.signal.aborted) {
        outcome = { kind: "stopped", steps };
      } else {
        outcome = {
          kind: "failed",
          code: turnFailureOf(error, threadId),
          steps,
        };
      }
    } finally {
      signal.removeEventListener("abort", cut);
      done?.();
      meter.end();
    }

    /*
     * The run's record, in its conversation: what was asked, and every step, whichever way it
     * ended. `runUnattended` set the asked message as the agent's first; what follows it is the
     * run's. A write that fails loses the transcript, not the run: the board is still told.
     */
    const ran: Message[] = target ? [...(target as LoopAgent).messages] : [];
    const filed = ran.length > 0 ? ran : [asked];
    await appendMessages(deps.database, threadId, filed, { runId }).catch(
      (error: unknown) => {
        log.error("task_messages_not_persisted", {
          thread: threadId,
          reason: describeFailure(error),
        });
      },
    );
    await deps.ledger
      .settle(runId, {
        status:
          outcome.kind === "failed"
            ? "error"
            : outcome.kind === "stopped" || outcome.kind === "lost"
              ? "stopped"
              : "done",
        error: outcome.kind === "failed" ? outcome.code : null,
        awaiting:
          outcome.kind === "approval" ||
          outcome.kind === "login" ||
          outcome.kind === "person",
        measure: meter.read(),
      })
      .catch((error: unknown) => {
        log.warn("task_run_not_settled", {
          run: runId,
          reason: describeFailure(error),
        });
      });
    // What it cost, to the hub's ledger through the outbox — also where the hub did not answer the
    // reservation. A refused run spent nothing and set nothing aside.
    if (deps.budget && verdict?.go) {
      await deps.budget.settle({ runId, actual: meter.read().costUsd });
    }
    return outcome;
  };
}

/** The company's day was spent before the run started: nothing was asked of the model. */
class BudgetRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BudgetRefused";
  }
}

/** In the lane of the browser the run's pages are in, or the Bot's where there is none. */
function inLane<T>(
  deps: TaskRunDeps,
  botId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!deps.lane) return work();
  return deps.lane.run(
    deps.browser ? laneOfBrowser(deps.browser.name) : botId,
    work,
  );
}

/**
 * A run of this task that finished here and that no note on the board names: the process died
 * between the run's end and the board's move, or the hub was away for both the move and the
 * release. Its outcome as far as the ledger kept it — the kind of person it waited for is not kept.
 * A run that never settled (`running`, or `unknown` after a restart) did not finish, and is not one.
 */
export function createUnreportedRuns(database: Database): UnreportedRun {
  return async ({ taskId, noted }) => {
    const [last] = await database
      .select({
        runId: lafThreadRuns.runId,
        status: lafThreadRuns.status,
        error: lafThreadRuns.error,
        ending: lafThreadRuns.ending,
      })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, taskThreadOf(taskId)))
      .orderBy(desc(lafThreadRuns.startedAt))
      .limit(1);
    if (!last || noted.has(last.runId)) return null;
    switch (last.status) {
      case "done":
        return {
          runId: last.runId,
          outcome:
            last.ending === "owner" ? { kind: "person" } : { kind: "done" },
        };
      case "error":
        return {
          runId: last.runId,
          outcome: { kind: "failed", code: last.error ?? "laf:turn_failed" },
        };
      default:
        return null;
    }
  };
}
