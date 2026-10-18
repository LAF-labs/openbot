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
import { turnFailureOf } from "../turns/engine";
import type { TaskRun, TaskRunOutcome, UnreportedRun } from "./task-pickup";
import { HUB_TASK_CODES, type HubTaskView } from "./wire";

/** The conversation a task is worked in. */
export const taskThreadOf = (taskId: string) => `task:${taskId}`;

/**
 * Why a run the board took back is `stopped` in the ledger: it lost its claim — a person moved the
 * task, or the sweep freed it. A person's stop (`모두 멈추기`) is `stopped` with no code. The two
 * must be told apart after a restart: a stop is reported, a lost run is worked again.
 */
export const TASK_LOST = HUB_TASK_CODES.notHeld;

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

/**
 * The topic of a question nobody was there to answer: what kind of action, and where — the site, or
 * the connected service and its tool. Never the element's label, a path or the arguments: those are
 * the page's and the Bot's words, and the note leaves the VM for the whole company's board.
 */
export function topicOf(subject: unknown): string {
  const ask = subject as Partial<AskSubject> | null;
  if (!ask || typeof ask !== "object") return "action";
  const kind = typeof ask.kind === "string" ? ask.kind : "action";
  const intent = typeof ask.intent === "string" ? `/${ask.intent}` : "";
  const where =
    typeof ask.host === "string" && ask.host
      ? `@${ask.host}`
      : ask.tool && typeof ask.tool.server === "string"
        ? `@${ask.tool.server}/${ask.tool.name}`
        : "";
  return `${kind}${intent}${where}`.replace(/[^\p{L}\p{N}@/._:-]/gu, "");
}

/** What a run stopped for a person on, read off the first outcome that said so. */
type Waiting = { kind: "approval"; topic: string } | { kind: "login" };

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
            : { kind: "approval", topic: topicOf(outcome.subject) },
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
    try {
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
          });
          const steps = run.steps.length;
          const stoppedOn = waiting as Waiting | null;
          if (stoppedOn?.kind === "approval") {
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
      if (error instanceof RunStopped || stopping.signal.aborted) {
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
    }
    // The claim went while it ran: the board has moved on, however the run itself came out.
    if (signal.aborted) outcome = { kind: "lost" };

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
        error:
          outcome.kind === "failed"
            ? outcome.code
            : outcome.kind === "lost"
              ? TASK_LOST
              : null,
        awaiting:
          outcome.kind === "approval" ||
          outcome.kind === "login" ||
          outcome.kind === "person",
      })
      .catch((error: unknown) => {
        log.warn("task_run_not_settled", {
          run: runId,
          reason: describeFailure(error),
        });
      });
    return outcome;
  };
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
 * A person's stop is one, and is reported as a stop: run again, it would undo what a person stopped.
 * A run that never settled (`running`, or `unknown` after a restart) did not finish, and a run the
 * board took back (`TASK_LOST`) is the board's already; neither is one, and the task is worked.
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
      case "stopped":
        return last.error === TASK_LOST
          ? null
          : { runId: last.runId, outcome: { kind: "stopped" } };
      default:
        return null;
    }
  };
}

/**
 * The pickup's `refused`: a run whose move the board refused because the run no longer held the
 * task. It finished here, but the board had moved on — a person sent the task back while it ran —
 * so it is written down as lost, as one whose beat was refused is, and never reported later.
 */
export function createRefusedRuns(
  ledger: RunLedger,
): (runId: string) => Promise<void> {
  return (runId) =>
    ledger.settle(runId, { status: "stopped", error: TASK_LOST });
}
