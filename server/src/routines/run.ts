import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { runAgentOnce } from "../agents/coworker-call";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import { soloChannelFor } from "../channels/solo-channel";
import type { ActionActor } from "../computer/gateway";
import type { Database } from "../db/client";
import type { lafRoutines } from "../db/schema";
import type { BotLane } from "../runner/bot-lane";
import {
  runUnattended,
  UnattendedRunError,
  type UnattendedToolkit,
} from "../runner/unattended";
import { isSilentAnswer } from "./deliver";
import {
  draftOf,
  type NotepadDraft,
  readNotepad,
  withNotepad,
} from "./notepad";
import { lastReport } from "./receipts";
import { reportRun } from "./run-report";
import {
  type RunToSettle,
  type SettlementOptions,
  settleRun,
} from "./settlement";

/**
 * One run of a routine: the Bot asked, the answer settled, the trail told.
 *
 * The shape of a run is the same server-side run a coworker being asked gets (`runAgentOnce`), or
 * with tools the unattended loop (`runner/unattended.ts`), because they are the same act on a
 * different trigger. The order is the whole design: the ledger opens before anything else, the
 * record commits in one transaction (`settlement.ts`), the roster hears about it only after that
 * commit, and the trail row that rings a failure's bell comes last (`run-report.ts`).
 */

/**
 * How long a routine's run may take, tools included.
 *
 * Longer than a coworker answer: nobody is waiting on screen. And long enough for a reasoning
 * model, whose turns were measured at 50–75 seconds each — three minutes was four turns, and an
 * "open two pages and compare" routine was reaching the deadline on its way to the answer. This
 * is not the guard against a hung Bot: the stall watchdog (AGENT_STALL_TIMEOUT_MS) is, and it ends
 * a silent stream in a minute. This bounds a Bot that keeps working.
 */
export const ROUTINE_RUN_TIMEOUT_MS = 600_000;

/**
 * How much of the last run's answer rides into the next one.
 *
 * Enough for a morning briefing or a monitor's last verdict; short enough that a routine whose
 * answer is a wall of text cannot spend the whole window on its own past. Cut with a mark, like
 * every other bound in this deployment, so the model reads it as an excerpt rather than as
 * everything that was said.
 */
const CARRIED_ANSWER_MAX_CHARS = 1_500;

/**
 * What the Bot is told about the last time this routine ran.
 *
 * WHY THIS EXISTS. A routine is repeated work by definition, and a routine that cannot remember
 * repeating it is the failure the whole feature walks into: the 8am briefing reports Tuesday's
 * three orders again on Wednesday, the monitor announces the same outage every hour, and the
 * person learns to stop reading. The answers were already in `laf_routine_runs` — every run writes
 * one — and nothing was reading them back.
 *
 * The instruction stays the person's. This is appended after it, as context and not as an order,
 * because a standing instruction that quietly grew a paragraph nobody wrote is a routine that no
 * longer does what its author can see it doing.
 */
const carriedInstruction = (instruction: string, previous: string): string =>
  `${instruction}\n\nWhat you reported the last time this routine ran, so you can say what has changed and not repeat it:\n\n${previous}`;

export type RoutineRunOptions = SettlementOptions & {
  /** See `RoutineServiceOptions` in `service.ts` for each of these. */
  resolveAgents: (actor: AgentActor) => Promise<Record<string, AbstractAgent>>;
  auditStore?: AuditStore;
  tools?: (botId: string, actor: ActionActor) => Promise<UnattendedToolkit>;
  lane?: BotLane;
  runTimeoutMs: number;
};

type RoutineRow = typeof lafRoutines.$inferSelect;

/** What asking the Bot came to, before any of it is written down. */
type Attempt = Pick<
  RunToSettle,
  "ok" | "answer" | "failure" | "steps" | "notepad"
> & {
  /** The run stopped for a person. Such a run is never silent, whatever its first line says. */
  awaiting: boolean;
};

/** What runs a routine that has been claimed: the clock's, Run now's and the webhook's. */
export function createRoutineRun(
  options: RoutineRunOptions,
): (row: RoutineRow) => Promise<void> {
  /*
   * One unattended run per Bot at a time, through the lane every server-side path shares.
   *
   * The tick is sequential, but Run now is not the tick, a room turn is not either, and any two
   * of those can name the same Bot. With one shared computer, two tool loops on one Bot drive one
   * browser at once — each one's snapshot goes stale under the other, and a click meant for one
   * page lands on the other's. A queue private to this service would not have seen the room.
   */
  return (row) =>
    options.lane
      ? options.lane.run(row.agentId, () => executeNow(options, row))
      : executeNow(options, row);
}

async function executeNow(
  options: RoutineRunOptions,
  row: RoutineRow,
): Promise<void> {
  const startedAt = options.now();
  const runId = randomUUID();
  /*
   * The person the run is made as, and it can be missing.
   *
   * `created_by_id` became a real reference with `on delete set null`, because the ownership rule
   * (`ownership.ts`) says a routine outlives the person who typed it. What it cannot outlive is the
   * VISIBILITY that person had — the Bot roster is loaded with the creator's own, so a routine
   * with no creator has nobody to load it as, and running it under anybody else would let it
   * reach a private coworker its author could not. It stops instead, in the one place a person
   * reads a routine's history.
   */
  const author = row.createdById;
  const ledgerRunId = await openLedger(options, row, author);
  const attempt = await askTheBot(options, row, author);

  /*
   * Nothing to report, said the way the routine prompt asks for it.
   *
   * Decided here, once, so the conversation, the receipt and the audit row cannot disagree about
   * whether this run had anything to say: the answer is not delivered, the run is still recorded
   * with what the model wrote, and the audit row carries `silent: true`. A run that stopped for
   * a person is never silent — the marker would swallow the one line the person has to read.
   */
  const silent =
    attempt.ok && !attempt.awaiting && isSilentAnswer(attempt.answer);

  const settled = await settleRun(options, {
    row,
    runId,
    startedAt,
    author,
    ledgerRunId,
    ok: attempt.ok,
    answer: attempt.answer,
    failure: attempt.failure,
    steps: attempt.steps,
    silent,
    notepad: attempt.notepad,
  });

  // Committed, so the roster rows may move on every open tab. Never from inside the transaction.
  settled.delivered?.announce();
  settled.failedIn?.announce();

  await reportRun(options.auditStore, {
    row,
    author,
    ledgerRunId,
    silent,
    settled,
  });
}

/**
 * OPEN THE LEDGER FIRST, so the Bot reads as busy for the whole time it is busy.
 *
 * `laf_routine_runs` is written once, at the end, with both timestamps — a receipt, not a
 * record. While a routine ran there was nothing anywhere saying so, which is why the roster
 * could not show scheduled work in progress. This row exists from here to the settlement.
 *
 * The conversation the run belongs to is looked up before the ledger row is opened. A routine
 * used to open its row with no thread — "nobody typed it". But its answer goes into the Bot's own
 * conversation with its author, and so does the mark a failure leaves; the transcript's failure
 * line (`channels/turn-failures.ts`) joins the ledger to the thread by this column, so a row
 * without it is a failure the conversation can never show. Read once here rather than again in
 * the failure path, and resolved to null rather than thrown: a Bot with no conversation yet is a
 * routine that runs as it always did.
 */
async function openLedger(
  options: RoutineRunOptions,
  row: RoutineRow,
  author: string | null,
): Promise<string | null | undefined> {
  const conversation = author
    ? await soloChannelFor(options.database, author, row.agentId).catch(
        () => null,
      )
    : null;
  return options.ledger
    ?.begin({
      agentId: row.agentId,
      userId: row.createdById,
      threadId: conversation?.threadId ?? null,
      origin: "routine",
      label: row.name,
    })
    .catch(() => null);
}

/** The Bot, asked the routine's instruction as its author would see the roster. Never throws. */
async function askTheBot(
  options: RoutineRunOptions,
  row: RoutineRow,
  author: string | null,
): Promise<Attempt> {
  let notepad: NotepadDraft | null = null;
  try {
    if (!author) {
      throw new Error(
        "The person who created this routine no longer has an account.",
      );
    }
    const agents = await options.resolveAgents({
      id: author,
      role: row.createdByRole === "admin" ? "admin" : "user",
    });
    const target = agents[row.agentId];
    if (!target) {
      throw new Error(`The Bot "${row.agentId}" is no longer in the roster.`);
    }
    const instruction = await instructionFor(options.database, row);

    if (options.tools) {
      const actor: ActionActor = {
        id: author,
        // The local actor is not a row in `users`, so it is named without claiming to be one.
        ...(author === DEV_ACTOR.id ? {} : { userId: author }),
      };
      /*
       * The notepad, read here — inside the Bot's lane, not when the routine was claimed. Run now
       * and the clock can each claim the same routine and queue behind one another on the lane, and
       * the second run must read what the first one settled rather than what both saw at the claim.
       * A read that fails fails the run: a routine that cannot see where it left off must not run
       * as though it had never started.
       */
      notepad = draftOf(
        row.id,
        await readNotepad(options.database, row.id),
        options.now,
      );
      const toolkit = withNotepad(
        await options.tools(row.agentId, actor),
        notepad,
      );
      const run = await runUnattended(target, instruction, {
        toolkit,
        timeoutMs: options.runTimeoutMs,
        // Nobody is watching. What that means is said by `shared/prompt/mode/routine.ko.ts`,
        // composed by the same middleware every other run path goes through.
        mode: "routine",
        // And where this routine left off, as facts that middleware composes after the mode.
        notepad: notepad.read,
      });
      /*
       * A run that stopped because a person is needed is not a failure — the Bot did its job,
       * which was to find out — but the person has to be told, and a routine's answer is the one
       * place they will read it.
       */
      const answer = run.awaiting
        ? `${run.answer}\n\n⏸ ${run.awaiting}`.trim()
        : run.answer;
      const awaiting = Boolean(run.awaiting);
      return {
        ok: true,
        answer,
        failure: "",
        steps: run.steps,
        awaiting,
        notepad,
      };
    }
    /*
     * No tools, no notepad: this run is composed as a coworker's (`runAgentOnce`), is offered no
     * `routine_note` to write with, and is shown no notepad to read.
     */
    const answer = await runAgentOnce(
      target,
      instruction,
      options.runTimeoutMs,
    );
    return {
      ok: true,
      answer,
      failure: "",
      steps: null,
      awaiting: false,
      notepad: null,
    };
  } catch (error) {
    return {
      ok: false,
      answer: "",
      failure: error instanceof Error ? error.message : String(error),
      // A failed loop still took its turns; they are the record of how far it got.
      steps: error instanceof UnattendedRunError ? error.steps : null,
      awaiting: false,
      // Kept so the trail can say a failed run's writes were discarded — never so they are written.
      notepad,
    };
  }
}

/** The routine's instruction, with the last thing it reported carried after it when there is one. */
async function instructionFor(
  database: Database,
  row: RoutineRow,
): Promise<string> {
  const previous = await lastReport(database, row.id);
  if (!previous) return row.instruction;
  return carriedInstruction(
    row.instruction,
    previous.length > CARRIED_ANSWER_MAX_CHARS
      ? `${previous.slice(0, CARRIED_ANSWER_MAX_CHARS)}\n\n[truncated]`
      : previous,
  );
}
