/**
 * DELETING A PROJECT: mark it, wait for what was writing into it, stop its turn, then remove
 * everything that names it (record §3, piece 4-5, 2026-10-10).
 *
 * A project is a conversation, and a conversation is written into from several doors — a turn, an
 * upload, a kept picture, a rating, a read mark — by any window the person has open. Removing its
 * rows while one of those is half-way is how a thread nobody has gets new messages, and how a file
 * lands in the Bot's folder for a row that can no longer be inserted. So the order is fixed:
 *
 *   1. MARK (`channels.deleting_at`, in Postgres). From here every write door refuses.
 *   2. WAIT for the writes that were already through a door when the mark was set.
 *   3. STOP the conversation's turn and wait until it has written its end.
 *   4. DELETE, in one transaction, by an explicit list of what names the conversation.
 *
 * ONE GATE FOR EVERY DOOR (`refuseWhileDeleting`). It is a middleware over the whole API, and it
 * finds the conversation in the path of the route that matched — any route, written today or next
 * month, whose path holds `:channelId` or `:threadId` and whose method writes. A door cannot forget
 * to ask, because no door asks. (`conversation-deleting.integration.test.ts` walks the server's
 * sources so a path that names a conversation by another word fails there.)
 *
 * THE GATE REGISTERS BEFORE IT READS THE MARK, AND THE DELETION MARKS BEFORE IT WAITS. That order
 * is what closes the gap, and either half alone does not: a request that read "not being deleted"
 * and only then registered could be missed by a deletion that looked in between. Registered first,
 * a request is either waited for (it was there when the deletion looked) or reads the mark (which
 * was committed before the deletion looked) and refuses itself.
 *
 * IN MEMORY, AND RIGHT TO BE: one API server process per deployment (`docs/laf/deployment-model.md`),
 * so "the requests in flight" is this process's own list. The mark is the part that must outlive
 * a restart, and it does — after one there are no requests in flight to wait for, the mark still
 * refuses new ones, and boot finishes what was cut short (`finishPending`).
 *
 * WHAT IS NOT REMOVED, AND WHY, is written beside `NAMES_A_CONVERSATION` below and in the record:
 * the audit trail (append-only), and the readable copies of the project's attachments in the Bot's
 * folder — nothing on the computer removes one file, and a project has no folder of its own until
 * piece 4-2's second part.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { AuditStore } from "../audit";
import type { Database } from "../db/client";
import {
  agentMemories,
  channelMemberships,
  channels,
  channelThreads,
  lafConversationContexts,
  lafNotifications,
  lafThreadMessages,
  lafThreadRuns,
} from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";

/** What a write door answers while its conversation is being deleted. A fact; the surface says it. */
export const PROJECT_DELETING = "laf:project_deleting";

/** How long a deletion waits for the writes that were in flight when it marked. */
export const WRITES_SETTLE_MS = 120_000;

/** The methods that read. Everything else is a write. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ConversationRef = { channelIds: string[]; threadIds: string[] };

/**
 * The conversations a request names, read from the path of every route that matched it: the value
 * standing where a route's pattern says `:channelId` or `:threadId`.
 */
export function conversationsNamed(
  patterns: readonly string[],
  pathname: string,
): ConversationRef {
  const said = pathname.split("/");
  const channelIds = new Set<string>();
  const threadIds = new Set<string>();
  for (const pattern of patterns) {
    pattern.split("/").forEach((part, index) => {
      const value = said[index];
      if (!value) return;
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        // Not an encoding: the characters themselves are the id asked for.
      }
      if (part === ":channelId") channelIds.add(decoded);
      if (part === ":threadId") threadIds.add(decoded);
    });
  }
  return { channelIds: [...channelIds], threadIds: [...threadIds] };
}

/**
 * The writes in flight, by the conversation they are into. A key is `channel:<id>` or
 * `thread:<id>`: a request names one or the other, and a deletion waits on both.
 */
export function createConversationWrites() {
  const inFlight = new Map<string, Set<Promise<void>>>();
  const keysOf = (ref: ConversationRef) => [
    ...ref.channelIds.map((id) => `channel:${id}`),
    ...ref.threadIds.map((id) => `thread:${id}`),
  ];
  return {
    /** A write has come through a door. Call what comes back when it has finished. */
    begin(ref: ConversationRef): () => void {
      let finish: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const keys = keysOf(ref);
      for (const key of keys) {
        const set = inFlight.get(key) ?? new Set();
        set.add(done);
        inFlight.set(key, set);
      }
      return () => {
        for (const key of keys) {
          const set = inFlight.get(key);
          set?.delete(done);
          if (set?.size === 0) inFlight.delete(key);
        }
        finish();
      };
    },
    /** Every write into these that is in flight NOW has finished — or the wait ran out. */
    async settled(
      ref: ConversationRef,
      withinMs = WRITES_SETTLE_MS,
    ): Promise<boolean> {
      const waiting = keysOf(ref).flatMap((key) => [
        ...(inFlight.get(key) ?? []),
      ]);
      if (waiting.length === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ranOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), withinMs);
      });
      const all = Promise.all(waiting).then(() => true as const);
      const outcome = await Promise.race([all, ranOut]);
      clearTimeout(timer);
      return outcome;
    },
  };
}

export type ConversationWrites = ReturnType<typeof createConversationWrites>;

/** Whether any of these conversations is marked: one read, by primary key and by the thread index. */
export async function anyBeingDeleted(
  database: Pick<Database, "select">,
  ref: ConversationRef,
): Promise<boolean> {
  if (ref.channelIds.length > 0) {
    const [marked] = await database
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          inArray(channels.id, ref.channelIds),
          isNotNull(channels.deletingAt),
        ),
      )
      .limit(1);
    if (marked) return true;
  }
  if (ref.threadIds.length > 0) {
    const [marked] = await database
      .select({ id: channels.id })
      .from(channelThreads)
      .innerJoin(channels, eq(channels.id, channelThreads.channelId))
      .where(
        and(
          inArray(channelThreads.threadId, ref.threadIds),
          isNotNull(channels.deletingAt),
        ),
      )
      .limit(1);
    if (marked) return true;
  }
  return false;
}

/**
 * The gate: over the whole API, before every route. A read passes; a write into a conversation is
 * counted as in flight for as long as its handler runs, and refused if the conversation is marked.
 */
export function refuseWhileDeleting(
  database: Pick<Database, "select">,
  writes: ConversationWrites,
): MiddlewareHandler {
  return async (context, next) => {
    if (READS.has(context.req.method)) return next();
    const ref = conversationsNamed(
      matchedRoutes(context).map((route) => route.path),
      new URL(context.req.url).pathname,
    );
    if (ref.channelIds.length === 0 && ref.threadIds.length === 0) {
      return next();
    }
    // Registered FIRST, then the mark is read: see the head of this file.
    const done = writes.begin(ref);
    try {
      if (await anyBeingDeleted(database, ref)) {
        return context.json(
          { error: PROJECT_DELETING, code: PROJECT_DELETING },
          409,
        );
      }
      await next();
    } finally {
      done();
    }
  };
}

/**
 * EVERY COLUMN THAT NAMES A CONVERSATION WITHOUT A FOREIGN KEY TO IT, and what a deletion does
 * with the row (record §3's table). What has a foreign key goes with the channel's row
 * (`channel_memberships`, `channel_agents`, `channel_threads`, `laf_answer_ratings`,
 * `laf_attachments`); a column here is text, and nothing but this list removes what it points at.
 *
 * THE TEST READS THE DATABASE'S OWN CATALOGUE AGAINST THIS (`conversation-deleting.integration
 * .test.ts`): a table added next month with a `thread_id` and no line here fails, instead of
 * leaving a deleted project's rows for a review to find one by one. The audit trail names a
 * conversation only inside a payload, has no such column, and is not touched: append-only, as in
 * migration 0047 — what was done stays said, under ids that resolve to nothing.
 */
export const NAMES_A_CONVERSATION: Readonly<
  Record<string, "deleted" | "ended" | "cleared">
> = {
  "laf_thread_messages.thread_id": "deleted",
  "laf_conversation_contexts.thread_id": "deleted",
  // The record's original is the audit trail; this is the ledger of what ran.
  "laf_thread_runs.thread_id": "deleted",
  // Left, it goes on being offered and opens a conversation that is not there.
  "laf_notifications.channel_id": "deleted",
  // Not deleted: the boundary's record has to say the allowance ended because the conversation did.
  "computer_standing_approvals.thread_id": "ended",
  // The memory is the Bot's and stays; where it was learned was this project's words.
  "agent_memories.evidence_thread_id": "cleared",
  // The thread's own row: it goes with its channel, by the foreign key on its other column.
  "channel_threads.thread_id": "deleted",
};

export type ProjectDeletionResult =
  | { ok: true; counts: Record<string, number> }
  | { ok: false; code: "laf:channel_not_found" | "laf:project_only" };

export type ProjectDeletion = {
  /** Delete a project this person is in. Asked again for one already marked, it finishes it. */
  delete(input: {
    userId: string;
    channelId: string;
  }): Promise<ProjectDeletionResult>;
  /** Boot: finish every deletion a restart cut short. Answers how many there were. */
  finishPending(): Promise<number>;
};

export function createProjectDeletion(dependencies: {
  database: Database;
  writes: ConversationWrites;
  /** Stop the conversation's turn and wait until it has written its end (`turns/engine.ts`). */
  stopThread: (threadId: string) => Promise<void>;
  /** Withdraw what was allowed "for this conversation" (`computer/standing-approvals.ts`). */
  endApprovals?: (threadId: string, actor: string) => Promise<unknown>;
  auditStore?: AuditStore;
}): ProjectDeletion {
  const { database, writes, stopThread, endApprovals, auditStore } =
    dependencies;

  /** Steps 2 to 4, for a channel already marked. `by` is absent when boot finishes one. */
  const finish = async (
    channelId: string,
    by: string | undefined,
  ): Promise<Record<string, number>> => {
    const held = await database
      .select({ threadId: channelThreads.threadId })
      .from(channelThreads)
      .where(eq(channelThreads.channelId, channelId));
    const threadIds = held.map((row) => row.threadId);

    const waited = await writes.settled({ channelIds: [channelId], threadIds });
    if (!waited) {
      // A write that never returns must not hold a person's deletion for ever; it is said.
      log.warn("project_deletion_writes_not_settled", { channel: channelId });
    }
    // After the writes: a send that was in flight has listed its turn by now, so this stops it.
    await Promise.all(
      threadIds.map((threadId) =>
        stopThread(threadId).catch((error: unknown) => {
          log.warn("project_deletion_turn_not_stopped", {
            channel: channelId,
            reason: describeFailure(error),
          });
        }),
      ),
    );
    for (const threadId of threadIds) {
      await endApprovals?.(threadId, by ?? "system").catch((error: unknown) => {
        log.warn("project_deletion_approvals_not_ended", {
          channel: channelId,
          reason: describeFailure(error),
        });
      });
    }

    const counts: Record<string, number> = {};
    await database.transaction(async (transaction) => {
      /*
       * BY AN EXPLICIT LIST OF THREAD IDS, never a predicate — the narrowing is the safety, as in
       * `account/deletion.ts`. And only for a channel that is still marked: a deletion finished
       * by another path in the meantime has nothing left to remove.
       */
      const [marked] = await transaction
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.id, channelId), isNotNull(channels.deletingAt)))
        .for("update");
      if (!marked) return;
      if (threadIds.length > 0) {
        counts.threadMessages = (
          await transaction
            .delete(lafThreadMessages)
            .where(inArray(lafThreadMessages.threadId, threadIds))
            .returning({ seq: lafThreadMessages.seq })
        ).length;
        counts.conversationContexts = (
          await transaction
            .delete(lafConversationContexts)
            .where(inArray(lafConversationContexts.threadId, threadIds))
            .returning({ threadId: lafConversationContexts.threadId })
        ).length;
        counts.threadRuns = (
          await transaction
            .delete(lafThreadRuns)
            .where(inArray(lafThreadRuns.threadId, threadIds))
            .returning({ threadId: lafThreadRuns.threadId })
        ).length;
        // All three, not the pointer alone: the excerpt is what the person said in the project.
        counts.memoryEvidence = (
          await transaction
            .update(agentMemories)
            .set({
              evidenceExcerpt: null,
              evidenceMessageId: null,
              evidenceThreadId: null,
            })
            .where(inArray(agentMemories.evidenceThreadId, threadIds))
            .returning({ id: agentMemories.id })
        ).length;
      }
      counts.notifications = (
        await transaction
          .delete(lafNotifications)
          .where(eq(lafNotifications.channelId, channelId))
          .returning({ id: lafNotifications.id })
      ).length;
      // Last: memberships, the Bot's link, the thread's row, ratings and attachments go with it.
      counts.channels = (
        await transaction
          .delete(channels)
          .where(eq(channels.id, channelId))
          .returning({ id: channels.id })
      ).length;
    });

    if (counts.channels) {
      await auditStore
        ?.insert({
          eventType: "project.deleted",
          targetType: "channel",
          targetId: channelId,
          ...(by ? { actorUserId: by } : {}),
          // Counts and whether boot finished it. Never the project's name: that is the person's words.
          payload: { counts, resumed: by === undefined, waited },
        })
        .catch((error: unknown) => {
          log.error("project_deletion_not_audited", {
            channel: channelId,
            reason: describeFailure(error),
          });
        });
    }
    return counts;
  };

  return {
    async delete({ userId, channelId }) {
      const [found] = await database
        .select({ id: channels.id, kind: channels.kind })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, userId),
          ),
        )
        .where(eq(channels.id, channelId))
        .limit(1);
      if (!found) return { ok: false, code: "laf:channel_not_found" };
      // The Bot's main conversation is the Bot's: it goes when the Bot does, and not from here.
      if (found.kind !== "project")
        return { ok: false, code: "laf:project_only" };

      // Kept if already set: when the deletion was first asked for is the fact.
      await database
        .update(channels)
        .set({ deletingAt: sql`coalesce(${channels.deletingAt}, now())` })
        .where(eq(channels.id, channelId));
      return { ok: true, counts: await finish(channelId, userId) };
    },

    async finishPending() {
      const pending = await database
        .select({ id: channels.id })
        .from(channels)
        .where(isNotNull(channels.deletingAt));
      for (const { id } of pending) {
        await finish(id, undefined).catch((error: unknown) => {
          log.error("project_deletion_not_finished", {
            channel: id,
            reason: describeFailure(error),
          });
        });
      }
      return pending.length;
    },
  };
}
