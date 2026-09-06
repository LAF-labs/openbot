/**
 * The turns that ended without an answer, so a reload does not pretend they never happened.
 *
 * WHAT WAS ACTUALLY MISSING WAS THE READ, NOT THE WRITE. A turn that fails already leaves a durable
 * row: `laf_thread_runs` gets `status = 'error'` with the reason and the `run_id`, and the person's
 * own message in `laf_thread_messages` carries that same `run_id`. Measured on 2026-09-06 against a
 * Bot pointed at a dead port — the ledger row was there, complete, and nothing in the app ever
 * asked for it. So the person saw a red English sentence until they reloaded, and after the reload
 * their question sat alone with no answer and no sign that anything had gone wrong.
 *
 * Nothing new is written here. This joins what is already stored and answers one question: which
 * message got no reply, and what kind of failure it was.
 *
 * A FAILURE IS NOT A MESSAGE. It is deliberately not appended to the transcript, because the
 * transcript is handed back to the model on the next turn and a Bot would then read its own
 * obituary as something it had written. It travels beside the transcript instead, keyed by the id
 * of the message it followed.
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadMessages, lafThreadRuns } from "../db/schema";

/**
 * What kind of failure it was, as a fact rather than a sentence.
 *
 * The server does not send prose to the surface (see CLAUDE.md), and the reason it must not here is
 * concrete: the stored `error` is whatever threw — `"Unable to connect. Is the computer able to
 * access the url?"` for a dead endpoint — which is English, aimed at whoever runs the deployment,
 * and is the exact string that was appearing in red on a Korean screen. The surface owns the words;
 * this owns which of them applies.
 *
 * Separate codes rather than one, because the answers differ. A rate limit wants waiting; an
 * unreachable Bot wants trying again; a timeout wants asking for less. "Try again" in front of an
 * instant refusal is how a working product looks broken.
 */
export const TURN_FAILURE_CODES = {
  modelFailed: "laf:turn_model_failed",
  rateLimited: "laf:turn_rate_limited",
  refused: "laf:turn_refused",
  /** The Bot's stream went quiet and `stall-guard.ts` ended the turn for it. */
  stalled: "laf:turn_stalled",
  timedOut: "laf:turn_timed_out",
  /**
   * The process running it died — a restart, a crash — and boot found the run still open.
   *
   * Nothing is known about how it would have ended, and the code says exactly that much: not that
   * the model failed, not that anything refused, only that this run has no ending. It is what
   * `LafPostgresRunner.create` writes as `unknown` in the ledger, said in the transcript's terms.
   */
  interrupted: "laf:turn_interrupted",
  unknown: "laf:turn_failed",
  unreachable: "laf:turn_unreachable",
} as const;

export type TurnFailureCode =
  (typeof TURN_FAILURE_CODES)[keyof typeof TURN_FAILURE_CODES];

/** One question that got no answer: the message it was, and what went wrong after it. */
export type TurnFailure = {
  /** The id of the last message of the failed run — the person's own question, in practice. */
  messageId: string;
  code: TurnFailureCode;
  /** When the run gave up, ISO-8601. */
  at: string;
};

/**
 * A stored error string, reduced to one of the codes above.
 *
 * Substring matching on somebody else's prose is not a good way to learn anything, and it is used
 * here only because the ledger's `error` column is free text written by whatever threw — there is
 * no code column to read. Everything it cannot place becomes `unknown`, which the surface says as
 * "the answer did not arrive", and that is a true sentence about every failure in the set.
 */
export function classifyTurnFailure(error: string | null): TurnFailureCode {
  const said = (error ?? "").toLowerCase();
  if (!said.trim()) return TURN_FAILURE_CODES.unknown;

  // The deployment's own codes first: agent-bot already names these, and a name beats a guess.
  if (said.includes("laf:model_rate_limited")) {
    return TURN_FAILURE_CODES.rateLimited;
  }
  if (said.includes("laf:model_timed_out")) return TURN_FAILURE_CODES.timedOut;
  if (said.includes("laf:model_unavailable")) {
    return TURN_FAILURE_CODES.modelFailed;
  }
  if (said.includes("laf:model_failed")) return TURN_FAILURE_CODES.modelFailed;

  /*
   * The stall guard writes an English sentence into RUN_ERROR and carries
   * `code: "AGENT_STREAM_STALLED"` beside it. The sentence is what reaches the ledger, so the
   * sentence is what there is to match here — and it was reaching Korean screens verbatim.
   */
  if (
    said.includes("agent_stream_stalled") ||
    said.includes("stopped responding")
  ) {
    return TURN_FAILURE_CODES.stalled;
  }
  if (said.includes("429") || said.includes("rate limit")) {
    return TURN_FAILURE_CODES.rateLimited;
  }
  /*
   * "The run did not finish in time." is the routine deadline's own sentence
   * (`RunDeadline` in runner/unattended.ts) and "did not answer in time" the coworker call's
   * (`runAgentOnce`, the path a routine takes when it has no tools) — matched by name for the same
   * reason the stall guard's is: it is this deployment's prose, and a ten-minute routine that ran
   * out of time was reading as "no answer came back", which sends a person looking for a fault
   * that is not there.
   */
  if (
    said.includes("timed out") ||
    said.includes("timeout") ||
    said.includes("did not finish in time") ||
    said.includes("did not answer in time")
  ) {
    return TURN_FAILURE_CODES.timedOut;
  }
  /*
   * The measured one. A Bot whose endpoint is down throws "Unable to connect. Is the computer able
   * to access the url?"; a 404 on the AG-UI path and a refused TCP connection are the same fact to
   * the person sitting there — the Bot is not answering — and the same thing to do about it.
   */
  if (
    said.includes("unable to connect") ||
    said.includes("econnrefused") ||
    said.includes("enotfound") ||
    said.includes("fetch failed") ||
    said.includes("failed to fetch") ||
    said.includes("networkerror") ||
    said.includes("404")
  ) {
    return TURN_FAILURE_CODES.unreachable;
  }
  if (said.includes("401") || said.includes("403")) {
    return TURN_FAILURE_CODES.refused;
  }
  if (
    said.includes("500") ||
    said.includes("502") ||
    said.includes("503") ||
    said.includes("504")
  ) {
    return TURN_FAILURE_CODES.modelFailed;
  }
  return TURN_FAILURE_CODES.unknown;
}

/**
 * The failed turns in one thread, newest last, capped.
 *
 * `error` and `unknown`. `stopped` is a person pressing Stop, which is not a failure and must never
 * be drawn as one — telling somebody their Bot broke when they were the one who stopped it is worse
 * than saying nothing.
 *
 * `unknown` USED TO BE LEFT OUT, on the argument that a run reconciled at boot has no reason to
 * report. It has one: the person asked, the server restarted, and after the reload their question
 * sat alone as if nothing had happened — which is the shape of lie this fork's restart work exists
 * to remove (launch plan 3-B). A run with no ending is reported as interrupted, not as an error,
 * because the two want different things: one wants a look at the model, the other wants asking
 * again.
 *
 * The message a failure is keyed to is the LAST message of that run, which for a chat turn that
 * died before the Bot said anything is the person's own question. That is exactly the row the
 * surface needs to draw under. A routine's failure is keyed the same way, to the one message its
 * failure path leaves in the Bot's conversation — see `routines/deliver.ts`.
 */
export function createTurnFailureReader(database: Database) {
  return async (threadId: string, limit = 50): Promise<TurnFailure[]> => {
    const failed = await database
      .select({
        runId: lafThreadRuns.runId,
        status: lafThreadRuns.status,
        error: lafThreadRuns.error,
        finishedAt: lafThreadRuns.finishedAt,
      })
      .from(lafThreadRuns)
      .where(
        and(
          eq(lafThreadRuns.threadId, threadId),
          inArray(lafThreadRuns.status, ["error", "unknown"]),
        ),
      )
      .orderBy(desc(lafThreadRuns.finishedAt))
      .limit(limit);

    if (failed.length === 0) return [];

    const runIds = failed.map((run) => run.runId);
    /*
     * One row per run: the highest `seq` that run wrote. `distinct on` rather than a group-by and a
     * join back, because the message id lives in a jsonb field and re-joining on `(thread, seq)`
     * to fetch it is two statements for one answer.
     */
    const lastOfRun = await database
      .selectDistinctOn([lafThreadMessages.runId], {
        runId: lafThreadMessages.runId,
        messageId: sql<string>`${lafThreadMessages.message} ->> 'id'`,
      })
      .from(lafThreadMessages)
      .where(
        and(
          eq(lafThreadMessages.threadId, threadId),
          isNotNull(lafThreadMessages.runId),
          inArray(lafThreadMessages.runId, runIds),
        ),
      )
      .orderBy(desc(lafThreadMessages.runId), desc(lafThreadMessages.seq));

    const messageOfRun = new Map(
      lastOfRun.map((row) => [row.runId, row.messageId]),
    );

    const failures: TurnFailure[] = [];
    for (const run of failed) {
      const messageId = messageOfRun.get(run.runId);
      // A run that failed before it wrote anything has no message to draw under, and inventing a
      // place for it would put the line under somebody else's question.
      if (!messageId) continue;
      failures.push({
        at: (run.finishedAt ?? new Date()).toISOString(),
        code:
          run.status === "unknown"
            ? TURN_FAILURE_CODES.interrupted
            : classifyTurnFailure(run.error),
        messageId,
      });
    }
    return failures.reverse();
  };
}
