/**
 * What is left of the runner: the runs the last process died on.
 *
 * This class was the CopilotKit runtime's runner — the vendored in-memory one with its memory made
 * durable, every run that came through the run door (`POST /api/copilotkit/agent/:id/run`) teed
 * into Postgres as it streamed. That door was how a window drove a chat turn: the model asked for a
 * tool, the run ended, and the window carried the call out and started the next run with the
 * result. The server runs a chat turn itself since v0.5.7 (`turns/engine.ts`, which used none of
 * this), the window-driven path was removed from the app on 2026-10-05, and on 2026-10-06 the door
 * went with everything that was reached only through it: the tee, the step handed to a browser and
 * the wait on it, a second window's replay, the thread routes and their priming. Git has it.
 *
 * What every run path still needs is done here, once, at boot: a run the ledger still calls
 * `running` cannot still be going, because the process that ran it is the one that just died, and
 * somebody has to be told. It reads no messages.
 */
import { eq, inArray } from "drizzle-orm";
import { TURN_FAILURE_CODES } from "../channels/turn-failures";
import type { Database } from "../db/client";
import { channelThreads, lafThreadRuns } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { NotificationOutbox } from "../notifications/outbox";
import { RUN_ORIGINS } from "./run-ledger";

/**
 * A run the last process left open, as boot found it.
 *
 * Everything the ledger row knew about who and what, so that the process that reconciled it can
 * tell somebody — the row itself says only `unknown`, and a person whose 07:30 briefing died with
 * the server would otherwise learn that from its absence.
 */
export type InterruptedRun = {
  runId: string;
  threadId: string | null;
  agentId: string | null;
  userId: string | null;
  /**
   * As the column holds it, which includes the `room` and `handoff` a run from before 2026-09-24 can
   * carry — `RunOrigin` is what is written now, not everything that was.
   */
  origin: (typeof lafThreadRuns.$inferSelect)["origin"];
  /** A routine's name, for a run that was one. */
  label: string | null;
};

export class LafPostgresRunner {
  private constructor(
    /** What boot found still running. Read once by `reportInterruptedRuns`, never added to. */
    private readonly interrupted: readonly InterruptedRun[],
  ) {}

  /**
   * Async because boot adjudicates the runs the last process left open. It reads no messages.
   *
   * No audit store any more: the one row this class wrote there was a turn's `model.usage`, and it
   * is written at the seam every run shares now (`copilot.ts`). This runner only ever saw chat.
   * And no ledger or list of work in flight since 2026-10-06: both were for the runs that came
   * through the run door, and the ledger's rows are settled here by a plain update.
   */
  static async create(database: Database): Promise<LafPostgresRunner> {
    /*
     * Boot reconciliation: a run still `running` now cannot still be running,
     * because the process that ran it is the one that just died. Marked
     * `unknown` rather than `error` — nothing is known about how it ended,
     * and the digest names these as what they are: crash suspects.
     *
     * And a run still `waiting`: its step's question and its window's hold were in the memory of
     * the process that died, so nothing can carry it on now. Nothing writes `waiting` any more — it
     * was a step handed to a window — but a deployment upgraded from a build that did can hold one.
     */
    const reconciled = await database
      .update(lafThreadRuns)
      .set({ status: "unknown", finishedAt: new Date() })
      .where(inArray(lafThreadRuns.status, ["running", "waiting"]))
      .returning({
        runId: lafThreadRuns.runId,
        threadId: lafThreadRuns.threadId,
        agentId: lafThreadRuns.agentId,
        userId: lafThreadRuns.userId,
        origin: lafThreadRuns.origin,
        label: lafThreadRuns.label,
      });
    if (reconciled.length > 0) {
      log.warn("runs_reconciled", {
        count: reconciled.length,
        to: "unknown",
        note: "These runs were still `running` when the last process died; nothing is known about how they ended.",
      });
    }
    return new LafPostgresRunner(reconciled);
  }

  /**
   * The runs boot found open, for whoever can tell somebody about them.
   *
   * A getter rather than a notification from inside `create`, because the outbox does not exist
   * yet when the runner is built — it is made after the sockets and the partner doors it delivers
   * through — and reordering boot around a notification would put the tail before the dog.
   */
  interruptedAtBoot(): readonly InterruptedRun[] {
    return this.interrupted;
  }
}

/**
 * Tell the people whose runs the last process died on.
 *
 * Reconciling a run to `unknown` used to be the whole of it: a line in the boot log, read by an
 * operator, and nothing for the person whose question or whose 07:30 briefing it was. They found
 * out from the absence — an answer that never came, a morning with no report — which is the one
 * thing a restart must not do (launch plan 3-B: 재시작·끊김이 거짓말하지 않는다).
 *
 * One `run.failed` row per interrupted run that had a Bot and a person, carrying the same fact code
 * the transcript uses (`laf:turn_interrupted`) and, for a routine, its name. A routine's run is
 * first marked in the Bot's conversation through `markRoutine` — the same mark its own failure
 * path leaves (routines/deliver.ts) — so the person finds the red line where the briefing would
 * have been, and the notification points at that conversation. A chat turn already has the
 * person's own message in its thread; only the conversation's id is looked up for it.
 *
 * Called once, after the outbox exists, by whoever boots the process. Nothing here can throw into
 * boot: a mark or a row that fails is logged and the next run is still told about.
 */
export async function reportInterruptedRuns(input: {
  database: Database;
  runs: readonly InterruptedRun[];
  outbox: NotificationOutbox;
  /** Marks a routine's run as unfinished in the Bot's conversation. See routines/deliver.ts. */
  markRoutine?: (run: {
    agentId: string;
    userId: string;
    routineName: string;
    runId: string;
    at: Date;
  }) => Promise<{ channelId: string } | null>;
  now?: () => Date;
}): Promise<number> {
  const now = input.now ?? (() => new Date());
  let told = 0;
  for (const run of input.runs) {
    // A run with nobody to tell, or no Bot to name, is still reconciled; it is just not news.
    if (!run.agentId || !run.userId) continue;
    // Nor a room's turn or one Bot answering another, from the process before rooms were removed
    // (2026-09-24): the screen that would have shown it is gone, so there is nowhere to point.
    const origin = RUN_ORIGINS.find((known) => known === run.origin);
    if (!origin) continue;
    let channelId: string | undefined;
    if (run.origin === "routine" && run.label && input.markRoutine) {
      try {
        const marked = await input.markRoutine({
          agentId: run.agentId,
          userId: run.userId,
          routineName: run.label,
          runId: run.runId,
          at: now(),
        });
        channelId = marked?.channelId;
      } catch (error) {
        log.error("interrupted_routine_not_marked", {
          run: run.runId,
          reason: describeFailure(error),
        });
      }
    }
    if (!channelId && run.threadId) {
      try {
        const [owner] = await input.database
          .select({ channelId: channelThreads.channelId })
          .from(channelThreads)
          .where(eq(channelThreads.threadId, run.threadId))
          .limit(1);
        channelId = owner?.channelId;
      } catch (error) {
        log.error("interrupted_conversation_not_read", {
          run: run.runId,
          thread: run.threadId,
          reason: describeFailure(error),
        });
      }
    }
    const record = await input.outbox.enqueue({
      kind: "run.failed",
      botId: run.agentId,
      userId: run.userId,
      ...(channelId ? { channelId } : {}),
      run: {
        origin,
        /*
         * A routine's name only. A chat run carries a label too since 오늘 (the start of what the
         * person typed), and a notification's facts can leave for a partner channel or a webhook;
         * the person's own sentence is not a fact about the run worth sending there.
         */
        ...(run.origin === "routine" && run.label ? { label: run.label } : {}),
        code: TURN_FAILURE_CODES.interrupted,
      },
    });
    if (record) told += 1;
  }
  if (told > 0) {
    log.info("interrupted_runs_reported", { count: told, as: "run.failed" });
  }
  return told;
}
