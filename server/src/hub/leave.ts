/**
 * A VM leaving its company hub: the copies of the company's material left on this machine are
 * removed or blanked, once (lafi-dev-design §4, "떠나기"). What is removed is what the machine holds;
 * what the person already read is theirs, and nothing here says otherwise.
 *
 * WHEN: AT BOOT, WITH THE HUB LINES GONE AND `hub_cursor` STILL THERE. Detaching is laf-control's
 * (`laf hub detach`): it tells the hub the member left — from that moment the hub refuses this VM's
 * pass — then removes `LAF_HUB_URL`/`LAF_HUB_VM_KEY` from `.env` and restarts the server. The boot
 * that finds no lines and a cursor is the one moment certain to come after a detach, whoever ran it
 * and whether or not this server was up when it did. A door the detach path calls instead would
 * be a second door for a machine to knock on (none exists, and one is a credential to keep), it
 * would be skipped by a server that was down at that moment, and it would arrive after the hub
 * had already stopped answering this pass. The cursor is deleted last, so a leave cut short by a
 * crash runs again at the next boot; every step finds nothing the second time.
 *
 * THE FIVE STEPS (the design's numbering):
 *   1. the outbox and the cursor. There are no caches of team skills or confirmed team memory on
 *      this VM yet — the hub tools read live (`tools.ts`) — so there is nothing else to empty, and
 *      the two `.env` lines are laf-control's and already gone.
 *   2. every tool result the hub answered (`lafSource: "hub"`, `runner/thread-store.ts`) keeps its
 *      place and loses its words: `LEFT_COMPANY_RESULT`, which a later copy cannot write over
 *      (`keepLeftBlank`).
 *   3. the company's own conversations, `room:<id>` and `task:<id>` and the runs they handed work
 *      to, deleted whole: forgotten by the context store first, so nothing writes a row back, then
 *      their rows in `account/deletion.ts`'s order — messages, contexts, runs, the threads.
 *   4. notebook lines learned in one of those conversations are retired, and their words and their
 *      excerpt go with them: a retired line is still a row, and the row would still say it. So is
 *      a Bot's own line learned in a question of the person's that a hub tool answered — the line
 *      was written with the company's words in front of it, and nothing tells which of its words
 *      came from where. Not a line the person wrote or said is right: that one they have read.
 *   5. the browser signed out of the origins of the company's shared logins, and only those
 *      (`agent-computer` `POST /computers/cookies/forget`).
 * and then every kept conversation starts a new epoch, because its frozen layer names the hub's
 * two tools and the deferred tools are not in the epoch's key (`context/conversations.ts`).
 *
 * WHAT WAS WRITTEN FROM THE COMPANY'S WORDS GOES WITH THEM — the copies a model made, which the
 * person never read and the next model call would be handed again:
 *   - the day summary of every conversation a hub tool answered in, read off those answers whole
 *     (`context/day-close.ts` `transcriptOf`): a gap line over its days stands in its place, in the
 *     row and in the frozen layer that carries it, and a close prepared and not taken is dropped
 *     (`ConversationStore.forgetCompany`). Done before the rows below change, and found again the
 *     same way by a leave cut short and run at the next boot: the hub's mark stays on a result
 *     the leave blanked;
 *   - the retired notebook lines, out of every conversation's frozen layer, known facts and
 *     reminders, the same way;
 *   - the notepad of a routine whose runs called a hub tool (`laf_routine_runs.steps` keeps each
 *     call's real name): the cursor it carries to its next run was written from the answers.
 *     Receipts are kept to twenty, so a call older than those is not seen.
 * Not these, each for its reason: the Bot's answers, a routine's delivered answer and its 소식
 * posts, which the person was shown; the search index, which holds a person's and the Bot's words
 * only (migration 0065); compaction, which keeps decisions and no words (`context/compaction.ts`);
 * the nightly guidance and the standing facts, which read the dialogue and the owner's messages
 * and never a result (`dialogueOf`, `ownerMessagesOf`); the audit trail, which never holds a
 * successful result (`plugins/call.ts`) and a hub tool never reports a failure in its own words.
 */
import { type AnyColumn, inArray, like, or, sql } from "drizzle-orm";
import { drawnLine, isNotebookSlot } from "../../../shared/notebook";
import type { ConversationStore } from "../context/conversations";
import type { Database } from "../db/client";
import {
  agentMemories,
  channelThreads,
  computerStandingApprovals,
  hubCursor,
  hubOutbox,
  lafConversationContexts,
  lafRoutineNotepads,
  lafRoutineRuns,
  lafThreadMessages,
  lafThreadRuns,
} from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { HUB_TOOL_PREFIX, LEFT_COMPANY_RESULT } from "../runner/thread-store";

/** The company's own conversations: a room's, a task's — and the runs they hand work to. */
export const COMPANY_THREAD_PREFIXES = ["room:", "task:"] as const;

/** Who retired a notebook line, and why, when a leave did (`agent_memories.forgotten_by`). */
export const LEFT_COMPANY_BY = "company";
export const LEFT_COMPANY_REASON = "company_left";

/** How long the browser is given to sign out of the company's logins before boot goes on. */
export const FORGET_COOKIES_WAIT_MS = 30_000;

export type LeaveCounts = Record<string, number>;

export type CompanyLeave = {
  database: Database;
  conversations: Pick<
    ConversationStore,
    "drop" | "beginEpochEverywhere" | "forgetCompany"
  >;
  /**
   * The origins of the company's shared logins this person had. Asked once; an empty list asks
   * the browser nothing. See `main.ts` for where they come from today.
   */
  loginOrigins: () => Promise<readonly string[]>;
  /**
   * The browser's per-origin sign-out, absent where no computer is configured. Resolves to how
   * many cookies went; a failure leaves the cursor, so the next boot tries again.
   */
  forgetCookies?: (origins: readonly string[]) => Promise<number>;
};

const isCompanyThread = (column: AnyColumn) =>
  or(...COMPANY_THREAD_PREFIXES.map((prefix) => like(column, `${prefix}%`)));

/** Every company conversation this VM holds anything of, from every table that names one. */
async function companyThreads(database: Database): Promise<string[]> {
  const found = await Promise.all(
    [
      lafThreadMessages.threadId,
      lafConversationContexts.threadId,
      lafThreadRuns.threadId,
      channelThreads.threadId,
    ].map((column) =>
      database
        .selectDistinct({ threadId: column })
        .from(column.table)
        .where(isCompanyThread(column)),
    ),
  );
  return [
    ...new Set(
      found.flat().flatMap((row) => (row.threadId ? [row.threadId] : [])),
    ),
  ];
}

/** The conversations a hub tool answered in: the mark stays on a result a leave blanked. */
async function threadsTheHubAnswered(database: Database): Promise<string[]> {
  const rows = await database
    .selectDistinct({ threadId: lafThreadMessages.threadId })
    .from(lafThreadMessages)
    .where(sql`${lafThreadMessages.message} ->> 'lafSource' = 'hub'`);
  return rows.map((row) => row.threadId);
}

/**
 * Step 4's lines: learned in a company conversation, or a Bot's own unconfirmed line learned in a
 * question a hub tool answered — the person's message it cites, and a hub result after it before
 * their next one. Each until it is retired, blank and without its excerpt.
 */
function linesToRetire(database: Database) {
  const learnedFromHub = sql`${agentMemories.source} = 'bot' and ${agentMemories.confirmedAt} is null and exists (
    select 1 from ${lafThreadMessages} asked
    join ${lafThreadMessages} answered
      on answered.thread_id = asked.thread_id and answered.seq > asked.seq
    where asked.thread_id = ${agentMemories.evidenceThreadId}
      and asked.message ->> 'id' = ${agentMemories.evidenceMessageId}
      and answered.message ->> 'lafSource' = 'hub'
      and not exists (
        select 1 from ${lafThreadMessages} later
        where later.thread_id = asked.thread_id
          and later.seq > asked.seq and later.seq < answered.seq
          and later.message ->> 'role' = 'user'
      )
  )`;
  return database
    .select({
      id: agentMemories.id,
      content: agentMemories.content,
      slot: agentMemories.slot,
    })
    .from(agentMemories)
    .where(
      sql`(${isCompanyThread(agentMemories.evidenceThreadId)} or (${learnedFromHub})) and (${agentMemories.content} <> ${LEFT_COMPANY_RESULT} or ${agentMemories.evidenceExcerpt} is not null or ${agentMemories.forgottenAt} is null)`,
    );
}

/** Step 5, bounded: a browser that will not answer must not hold the server's boot. */
async function signOut(
  leave: CompanyLeave,
  counts: LeaveCounts,
): Promise<boolean> {
  const origins = [...new Set(await leave.loginOrigins())];
  counts.loginOrigins = origins.length;
  if (origins.length === 0) return true;
  if (!leave.forgetCookies) {
    // Nothing to address: no browser here, so no cookies of anybody's.
    return true;
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forgotten = await Promise.race([
      leave.forgetCookies(origins),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the browser did not answer")),
          FORGET_COOKIES_WAIT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    counts.cookies = forgotten;
    return true;
  } catch (error) {
    log.warn("hub_leave_cookies_kept", { reason: describeFailure(error) });
    return false;
  }
}

/**
 * Leave, now. Every step finds nothing the second time, so a leave run twice is a leave run once.
 * Resolves to how many of each thing went — counts only, never a name: the names are the company's.
 */
export async function leaveCompany(leave: CompanyLeave): Promise<{
  counts: LeaveCounts;
  /** False when the browser could not be signed out: the cursor stays, and the next boot retries. */
  done: boolean;
}> {
  const { database } = leave;
  const counts: LeaveCounts = {};

  const threads = await companyThreads(database);
  // Forgotten by the store before the rows go, so nothing it holds writes a row back.
  for (const threadId of threads) await leave.conversations.drop(threadId);

  /*
   * What the kept conversations drew from the company's words, before the rows change: both are
   * found the same way again by a leave run after a crash, and the lines' words are still there to
   * find in the frozen layers.
   */
  const retiring = await linesToRetire(database);
  const forgotten = await leave.conversations.forgetCompany({
    threads: await threadsTheHubAnswered(database),
    lines: retiring
      .filter((line) => line.content !== LEFT_COMPANY_RESULT)
      .map((line) =>
        drawnLine({
          content: line.content,
          slot: isNotebookSlot(line.slot) ? line.slot : null,
        }),
      ),
  });
  counts.summaries = forgotten.summaries;
  counts.drawnLines = forgotten.lines;

  await database.transaction(async (transaction) => {
    counts.outbox = (
      await transaction.delete(hubOutbox).returning({ id: hubOutbox.id })
    ).length;

    counts.hubResults = (
      await transaction
        .update(lafThreadMessages)
        .set({
          message: sql`jsonb_set(${lafThreadMessages.message}, '{content}', to_jsonb(${LEFT_COMPANY_RESULT}::text))`,
        })
        .where(
          sql`${lafThreadMessages.message} ->> 'lafSource' = 'hub' and ${lafThreadMessages.message} ->> 'content' is distinct from ${LEFT_COMPANY_RESULT}`,
        )
        .returning({ seq: lafThreadMessages.seq })
    ).length;

    counts.companyMessages = (
      await transaction
        .delete(lafThreadMessages)
        .where(isCompanyThread(lafThreadMessages.threadId))
        .returning({ seq: lafThreadMessages.seq })
    ).length;
    counts.companyContexts = (
      await transaction
        .delete(lafConversationContexts)
        .where(isCompanyThread(lafConversationContexts.threadId))
        .returning({ threadId: lafConversationContexts.threadId })
    ).length;
    counts.companyRuns = (
      await transaction
        .delete(lafThreadRuns)
        .where(isCompanyThread(lafThreadRuns.threadId))
        .returning({ runId: lafThreadRuns.runId })
    ).length;
    // A "for this conversation" allowance answers for nothing once its conversation is gone.
    counts.companyAllowances = (
      await transaction
        .delete(computerStandingApprovals)
        .where(isCompanyThread(computerStandingApprovals.threadId))
        .returning({ id: computerStandingApprovals.id })
    ).length;
    counts.companyThreads = (
      await transaction
        .delete(channelThreads)
        .where(isCompanyThread(channelThreads.threadId))
        .returning({ threadId: channelThreads.threadId })
    ).length;

    /*
     * Step 4. Retired the way the hourly curation retires a line — `forgotten_at`, who, why — and
     * blanked, because a retired line keeps its words for the audit's sake and these words are
     * the company's. Every such line, already retired or not, so no earlier retirement left them.
     */
    counts.notebookLines = retiring.length
      ? (
          await transaction
            .update(agentMemories)
            .set({
              forgottenAt: sql`coalesce(${agentMemories.forgottenAt}, now())`,
              forgottenBy: sql`coalesce(${agentMemories.forgottenBy}, ${LEFT_COMPANY_BY})`,
              forgetReason: sql`case when ${agentMemories.forgottenAt} is null then ${LEFT_COMPANY_REASON} else ${agentMemories.forgetReason} end`,
              content: LEFT_COMPANY_RESULT,
              evidenceExcerpt: null,
            })
            .where(
              inArray(
                agentMemories.id,
                retiring.map((line) => line.id),
              ),
            )
            .returning({ id: agentMemories.id })
        ).length
      : 0;

    /*
     * A routine's notepad, written by runs that read the hub. Emptied the way a person empties it
     * (`routines/notepad.ts` `clearNotepad`): the version moves, so nothing written against the
     * old one lands.
     */
    counts.routineNotepads = (
      await transaction
        .update(lafRoutineNotepads)
        .set({
          entries: [],
          version: sql`${lafRoutineNotepads.version} + 1`,
          writtenByRun: null,
          updatedAt: sql`now()`,
        })
        .where(
          sql`${lafRoutineNotepads.entries} <> '[]'::jsonb and ${lafRoutineNotepads.routineId} in (
            select ${lafRoutineRuns.routineId} from ${lafRoutineRuns}
            where jsonb_path_exists(${lafRoutineRuns.steps}, '$[*].calls[*] ? (@.name starts with $hub)', jsonb_build_object('hub', ${HUB_TOOL_PREFIX}::text))
          )`,
        )
        .returning({ routineId: lafRoutineNotepads.routineId })
    ).length;
  });

  const signedOut = await signOut(leave, counts);

  // Every kept conversation's frozen layer names the hub's tools; the next run of each draws it anew.
  counts.epochs =
    await leave.conversations.beginEpochEverywhere("company_left");

  if (signedOut) {
    await database.delete(hubCursor);
  }
  return { counts, done: signedOut };
}

/**
 * The boot's question: did this VM belong to a company it no longer has the lines for? Null when
 * there is nothing to do — attached now, or never attached.
 */
export async function leaveCompanyIfDetached(
  leave: CompanyLeave & { attached: boolean },
): Promise<{ counts: LeaveCounts; done: boolean } | null> {
  if (leave.attached) return null;
  const [cursor] = await leave.database
    .select({ hub: hubCursor.hub })
    .from(hubCursor);
  if (!cursor) return null;
  const result = await leaveCompany(leave);
  // Counts only: which company, which rooms and which files are the company's words.
  log.info("hub_left", { ...result.counts, done: result.done });
  return result;
}
