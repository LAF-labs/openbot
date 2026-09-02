/**
 * One row per thing worth interrupting somebody about, and the doors that carry it.
 *
 * WHY THIS EXISTS. The buzz used to be a `fetch` inside the approval registry (see notify.ts): it
 * fired, it forgot, and nothing anywhere could answer "did that question ever reach a person". The
 * page worked out "a Bot is waiting" from the tab it happened to be raised in, so a question raised
 * by a routine at seven in the morning reached nothing at all. And the number §5.7 says this
 * product is judged by — how long an answer takes, at night — had nowhere to be counted from.
 *
 * ONE WRITER, SEVERAL DOORS. `enqueue` is the only thing that writes a row, and every way of
 * reaching a person is an adapter behind the same contract: the webhook, the page's own socket, and
 * the AlimTalk slot that is a stub by decision (§7-4, external lead time). A door that succeeds
 * writes its name into `delivered_via`; the first success stamps `delivered_at`. A door that fails
 * costs nothing, because the row is still there and the next door — or the in-app list on the next
 * page load — is another chance.
 *
 * WHAT IT IS NOT. It is not the audit trail and must never be read as one. The trail is append-only
 * and holds what happened; these rows are edited as they are delivered and seen, and the retention
 * tick deletes them after thirty days. The approvals KPI is computed from `approval.*` audit rows
 * for exactly that reason — see `approval-metrics.ts`.
 *
 * NOTHING HERE MAY THROW INTO ITS CALLER. Every caller is on a path that was doing something more
 * important than notifying somebody: opening a question, finishing a run, writing a trail row. A
 * notification that cannot be written is a person who is not told, which is bad; a notification
 * that fails the question it was about is worse. So `enqueue` swallows its own failures and returns
 * null, and every caller spells that out with `void`.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { AskSubject } from "../computer/approvals";
import type { Database } from "../db/client";
import { lafNotifications } from "../db/schema";

/**
 * The list of things worth interrupting somebody about.
 *
 * Two clauses, taken whole from the field rule this fork already wrote down (notify.ts): a Bot
 * BLOCKED on you is worth a buzz, and a Bot that FINISHED is worth one if you asked. Everything
 * else a Bot does while it works is not, which is why there is no `run.started` here and never will
 * be.
 *
 * `approval.expired` is the odd one and is deliberately not an interruption — nobody can answer a
 * question that has run out, so it is a row for the list and the trail rather than a buzz. The
 * surface makes that distinction; see `app/src/lib/notifications/outbox.ts`.
 */
export const NOTIFICATION_KINDS = [
  /** A boundary stopped and is waiting on a person. The leading case. */
  "approval.requested",
  /** Nobody answered in the ten minutes the question had. */
  "approval.expired",
  /** The Bot asked for help or for a secret: its own keyboard cannot get past this. */
  "run.needs_you",
  /** A routine or a room turn finished while nobody was connected to hear it. */
  "run.finished",
  /** A run ended without an answer. */
  "run.failed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.includes(value as NotificationKind);
}

/** A row of the outbox, as everything that reads one sees it. */
export type NotificationRecord = {
  id: string;
  kind: NotificationKind;
  botId: string;
  /** Who is being told. The person, not the Bot. */
  userId: string;
  approvalId?: string;
  channelId?: string;
  /** What the action was, in facts. The words belong to whichever surface says them. */
  subject?: AskSubject;
  createdAt: string;
  deliveredVia: string[];
  deliveredAt?: string;
  seenAt?: string;
};

/**
 * A way of reaching somebody.
 *
 * `name` goes into `delivered_via` verbatim, so it is part of the record and not a label: renaming
 * one rewrites history that has already been written. `deliver` answers whether this door actually
 * took it — NOT whether it tried. A door that logged "nobody is configured" and returned true would
 * make an undelivered notification indistinguishable from a delivered one, which is the whole
 * question this table exists to answer.
 */
export type NotificationAdapter = {
  name: string;
  deliver: (record: NotificationRecord) => Promise<boolean>;
};

export type EnqueueInput = {
  kind: NotificationKind;
  botId: string;
  userId: string;
  approvalId?: string;
  channelId?: string;
  subject?: AskSubject;
};

export type NotificationOutbox = {
  /**
   * Write one row and offer it to every door. Null when it could not be written at all.
   *
   * The returned record is the row AFTER delivery, so a caller (and a test) can see which doors
   * took it without a second read.
   */
  enqueue: (input: EnqueueInput) => Promise<NotificationRecord | null>;
  /**
   * This person's unseen rows, newest first, capped.
   *
   * Unseen rather than undelivered: a row the webhook took is still waiting for this person if they
   * have not looked at it, and the in-app door is where they look.
   */
  list: (
    userId: string,
    options?: { since?: string; limit?: number },
  ) => Promise<NotificationRecord[]>;
  /** One row, if it belongs to this person. False when it is somebody else's or already gone. */
  markSeen: (userId: string, id: string) => Promise<boolean>;
  /**
   * Answering the question marks everything about it seen, however many doors it went out through.
   *
   * Not scoped to a person on purpose: in this deployment the owner answers (approval-routes.ts),
   * and a row still saying "a Bot is waiting on you" after somebody has answered it is a lie the
   * surface would draw.
   */
  markSeenForApproval: (approvalId: string) => Promise<number>;
};

/** How many rows the in-app door will hand over at once. */
export const NOTIFICATION_PAGE_LIMIT = 50;

export function createNotificationOutbox(input: {
  database: Database;
  /** In the order they should be tried. Empty is legal and means the row is the only door. */
  adapters?: NotificationAdapter[];
  now?: () => Date;
  /** Where a failure to write goes. Injected so a test can read it. */
  log?: (message: string) => void;
}): NotificationOutbox {
  const { database } = input;
  const adapters = input.adapters ?? [];
  const now = input.now ?? (() => new Date());
  const log = input.log ?? ((message: string) => console.error(message));

  const rowToRecord = (row: typeof lafNotifications.$inferSelect) =>
    ({
      id: row.id,
      // Read back as whatever the column holds. A kind this build does not know is still a row, and
      // the surface ignores what it cannot draw rather than the read failing.
      kind: row.kind as NotificationKind,
      botId: row.botId,
      userId: row.userId,
      ...(row.approvalId ? { approvalId: row.approvalId } : {}),
      ...(row.channelId ? { channelId: row.channelId } : {}),
      ...(row.subject ? { subject: row.subject as AskSubject } : {}),
      createdAt: row.createdAt.toISOString(),
      deliveredVia: row.deliveredVia ?? [],
      ...(row.deliveredAt
        ? { deliveredAt: row.deliveredAt.toISOString() }
        : {}),
      ...(row.seenAt ? { seenAt: row.seenAt.toISOString() } : {}),
    }) satisfies NotificationRecord;

  /**
   * Offer one row to every door, then record what actually happened.
   *
   * The doors run together rather than in turn: they are independent, one of them is an HTTP call
   * to somebody else's server with a ten-second bound, and a slow webhook must not hold up the
   * socket frame that is going to a page in the same building. `allSettled`, because a door that
   * throws is a door that did not deliver and nothing more.
   */
  const deliver = async (
    record: NotificationRecord,
  ): Promise<NotificationRecord> => {
    if (adapters.length === 0) return record;
    const outcomes = await Promise.allSettled(
      adapters.map(async (adapter) => ({
        name: adapter.name,
        ok: await adapter.deliver(record),
      })),
    );
    const took = outcomes
      .filter(
        (
          outcome,
        ): outcome is PromiseFulfilledResult<{
          name: string;
          ok: boolean;
        }> => outcome.status === "fulfilled" && outcome.value.ok,
      )
      .map((outcome) => outcome.value.name);
    if (took.length === 0) return record;

    const deliveredVia = [...record.deliveredVia, ...took];
    const deliveredAt = record.deliveredAt ?? now().toISOString();
    try {
      /*
       * Read-modify-write rather than `array_cat`, and safe because of who writes this column:
       * nothing but this function, once, in the same call that inserted the row. There is no second
       * writer to lose an update to.
       */
      await database
        .update(lafNotifications)
        .set({ deliveredVia, deliveredAt: new Date(deliveredAt) })
        .where(eq(lafNotifications.id, record.id));
    } catch (error) {
      // The row is written and the doors have already taken it. Losing the bookkeeping is worth a
      // line in the log and nothing more; the person has been told either way.
      log(`[outbox] could not record delivery: ${message(error)}`);
      return record;
    }
    return { ...record, deliveredVia, deliveredAt };
  };

  return {
    enqueue: async (enqueueInput) => {
      let record: NotificationRecord;
      try {
        const [row] = await database
          .insert(lafNotifications)
          .values({
            id: randomUUID(),
            kind: enqueueInput.kind,
            botId: enqueueInput.botId,
            userId: enqueueInput.userId,
            ...(enqueueInput.approvalId
              ? { approvalId: enqueueInput.approvalId }
              : {}),
            ...(enqueueInput.channelId
              ? { channelId: enqueueInput.channelId }
              : {}),
            ...(enqueueInput.subject
              ? { subject: enqueueInput.subject as Record<string, unknown> }
              : {}),
            createdAt: now(),
          })
          .returning();
        if (!row) return null;
        record = rowToRecord(row);
      } catch (error) {
        // The commonest cause is a person who no longer exists (the foreign key), which is a row
        // nobody would ever have read. See the module note: this must not reach the caller.
        log(
          `[outbox] could not enqueue ${enqueueInput.kind}: ${message(error)}`,
        );
        return null;
      }
      try {
        return await deliver(record);
      } catch (error) {
        log(`[outbox] delivery failed for ${record.id}: ${message(error)}`);
        return record;
      }
    },

    list: async (userId, options = {}) => {
      const limit = Math.min(
        Math.max(options.limit ?? NOTIFICATION_PAGE_LIMIT, 1),
        NOTIFICATION_PAGE_LIMIT,
      );
      const since = options.since ? new Date(options.since) : undefined;
      const rows = await database
        .select()
        .from(lafNotifications)
        .where(
          and(
            eq(lafNotifications.userId, userId),
            isNull(lafNotifications.seenAt),
            // An unparseable `since` is ignored rather than refused: it is a client's bookmark, and
            // answering with everything is a worse day than answering with nothing.
            ...(since && !Number.isNaN(since.getTime())
              ? [gt(lafNotifications.createdAt, since)]
              : []),
          ),
        )
        .orderBy(desc(lafNotifications.createdAt))
        .limit(limit);
      return rows.map(rowToRecord);
    },

    markSeen: async (userId, id) => {
      const seen = await database
        .update(lafNotifications)
        .set({ seenAt: now() })
        .where(
          and(
            eq(lafNotifications.id, id),
            eq(lafNotifications.userId, userId),
            isNull(lafNotifications.seenAt),
          ),
        )
        .returning({ id: lafNotifications.id });
      return seen.length > 0;
    },

    markSeenForApproval: async (approvalId) => {
      const seen = await database
        .update(lafNotifications)
        .set({ seenAt: now() })
        .where(
          and(
            eq(lafNotifications.approvalId, approvalId),
            isNull(lafNotifications.seenAt),
          ),
        )
        .returning({ id: lafNotifications.id });
      return seen.length;
    },
  };
}

/**
 * Rows older than the cutoff, gone. Used by the retention tick and by nothing else.
 *
 * Here rather than in `account/retention.ts` so the table has one module that knows its columns,
 * and a plain DELETE because this is a queue: no trigger, no function, no ceremony. See the table's
 * own comment on why it is not the trail.
 */
export async function purgeNotificationsBefore(
  database: Database,
  cutoff: Date,
): Promise<number> {
  const removed = await database
    .delete(lafNotifications)
    .where(sql`${lafNotifications.createdAt} < ${cutoff}`)
    .returning({ id: lafNotifications.id });
  return removed.length;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
