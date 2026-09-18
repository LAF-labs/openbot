import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import { soloConversationOf } from "../channels/solo-channel";
import type { Database } from "../db/client";
import { auditEvents, channelMemberships, lafRoutines } from "../db/schema";

/**
 * Routines whose results pile up unread stop on their own.
 *
 * WHY. A routine that runs every morning while nobody opens the conversation it delivers into spends
 * the day's allowance and the deployment's model key on answers nobody reads — and the person cannot
 * notice, because the only trace of a routine going unread is the unread dot it leaves, which is the
 * thing they are not looking at. On a free trial that is the day's budget gone by breakfast.
 *
 * THE RULE, per Bot and per person: count the results that Bot's routines delivered into that
 * person's conversation with it since they last opened it. When there are at least
 * `UNREAD_PAUSE_DELIVERIES` of them and the oldest has waited `UNREAD_PAUSE_AFTER_MS`, the routines
 * that delivered them are paused, `paused_reason = 'unread'` says why, and the person is told once —
 * through the trail row this writes, which the outbox watch turns into a notification
 * (`notifications/from-audit.ts`), the way a failed run is told.
 *
 * WHAT COUNTS AS A DELIVERY is a `routine.ran` trail row that says `delivered: true` — written for a
 * run whose answer went into the conversation (`run-report.ts`), after the settlement that put it
 * there committed. A `[SILENT]` run and a failed run delivered nothing anybody could read — a failed
 * run is told the person by its own path — and neither says so.
 *
 * THE TRAIL, NOT THE RECEIPTS. The receipts beside each run are pruned to twenty a routine, and the
 * routine this rule matters most for is the one that reports every run: every half hour, twenty
 * receipts are ten hours, and its oldest unread result would never look a week old — the chattiest
 * routine would be the one that never stopped. The trail is the history of record and is kept for
 * `AUDIT_RETENTION_DAYS`; a deployment that keeps less than a week of it simply never pauses, which
 * is the side to fail on. Runs from before the trail said `delivered` are not counted either, so the
 * rule starts counting from the upgrade that taught it the word.
 *
 * WHICH ROUTINES. Only those the rule governs — on, and not told to keep running — are counted, and
 * only those that are part of the pile are paused:
 *
 *  - a routine the person marked 계속 돌리기 is never paused, and its results are not evidence
 *    against its siblings either: the person said those may pile up;
 *  - a routine on the same Bot that has delivered nothing unread keeps running — a monitor that says
 *    `[SILENT]` until something happens is the one routine whose next message matters most;
 *  - each routine is counted from when it was last switched back on (`resumed_at`) as well as from
 *    the read mark, so turning a paused routine back on is not undone by the pile that paused it,
 *    which is still unread, since switching a routine on is not reading its conversation.
 *
 * A Bot the person has no conversation with delivered nowhere, and reading it cannot be measured, so
 * it is left alone. A conversation never opened is counted from when it was made.
 *
 * WHEN. On the clock, for the Bots that have a routine due in that pass, before anything due is
 * claimed (`ticker.ts`): the pause lands at the moment it saves a run, and costs nothing on the ticks
 * where nothing is due. The UPDATE asks for `enabled` and not `keep_running`, so a second sweep — or a
 * person's switch landing in between — pauses nothing twice and writes no second trail row.
 */

/**
 * Three results, and the oldest a week old. Both, because either alone is wrong.
 *
 * Three alone would pause a daily briefing after a long weekend away, which is somebody resting,
 * not somebody who has stopped reading. A week alone would pause a weekly report the morning after
 * its first one went unread — one unread report is a Monday, not a habit. Together: a daily routine
 * stops after a week of nobody looking, and a weekly one after three reports nobody opened.
 */
export const UNREAD_PAUSE_DELIVERIES = 3;
export const UNREAD_PAUSE_AFTER_MS = 7 * 24 * 60 * 60_000;

/** One Bot's routines paused for one person, and the pile that paused them. */
export type UnreadPause = {
  agentId: string;
  /** The person whose conversation the results went unread in, and who is told. */
  userId: string;
  channelId: string;
  routineIds: string[];
  /** How many results were waiting unread. */
  unread: number;
  /** When the oldest of them arrived. */
  since: Date;
};

type Governed = {
  id: string;
  agentId: string;
  author: string;
  resumedAt: Date | null;
};

/**
 * Pause what has gone unread on these Bots, as of `now`. The pauses made; empty when none were.
 *
 * Never throws for one Bot's sake: a lookup that fails for one conversation leaves that Bot's
 * routines running — the safe side, since a routine left on is exactly what happened before — and
 * the others are still looked at.
 */
export async function pauseUnreadRoutines(input: {
  database: Database;
  now: Date;
  /** The Bots to look at: those with a routine due in this pass. */
  botIds: readonly string[];
  auditStore?: AuditStore;
  log?: (message: string) => void;
}): Promise<UnreadPause[]> {
  if (input.botIds.length === 0) return [];
  const governed = await governedRoutines(input.database, input.botIds);
  const pauses: UnreadPause[] = [];
  for (const group of byConversation(governed)) {
    try {
      const pause = await pauseIfUnread(input, group);
      if (pause) pauses.push(pause);
    } catch (error) {
      input.log?.(
        `[routines] could not look at unread results for ${group[0]?.agentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return pauses;
}

/** The routines on these Bots the rule may pause: on, with an author, and not told to keep running. */
async function governedRoutines(
  database: Database,
  botIds: readonly string[],
): Promise<Governed[]> {
  const rows = await database
    .select({
      id: lafRoutines.id,
      agentId: lafRoutines.agentId,
      author: lafRoutines.createdById,
      resumedAt: lafRoutines.resumedAt,
    })
    .from(lafRoutines)
    .where(
      and(
        inArray(lafRoutines.agentId, [...botIds]),
        eq(lafRoutines.enabled, true),
        eq(lafRoutines.keepRunning, false),
        isNotNull(lafRoutines.createdById),
      ),
    )
    .orderBy(asc(lafRoutines.createdAt), asc(lafRoutines.id));
  return rows.flatMap((row) =>
    row.author ? [{ ...row, author: row.author }] : [],
  );
}

/** The routines grouped by the conversation their results land in: one Bot, one author. */
function byConversation(routines: Governed[]): Governed[][] {
  const groups = new Map<string, Governed[]>();
  for (const routine of routines) {
    const key = JSON.stringify([routine.agentId, routine.author]);
    groups.set(key, [...(groups.get(key) ?? []), routine]);
  }
  return [...groups.values()];
}

async function pauseIfUnread(
  input: {
    database: Database;
    now: Date;
    auditStore?: AuditStore;
  },
  group: Governed[],
): Promise<UnreadPause | null> {
  const [first] = group;
  if (!first) return null;
  const { database, now } = input;
  const conversation = await soloConversationOf(
    database,
    first.author,
    first.agentId,
  );
  if (!conversation) return null;
  const readFrom = await readMark(
    database,
    conversation.channelId,
    first.author,
  );
  if (!readFrom) return null;

  const unread = await unreadDeliveries(database, group, readFrom);
  const oldest = unread[0];
  if (
    !oldest ||
    unread.length < UNREAD_PAUSE_DELIVERIES ||
    now.getTime() - oldest.at.getTime() < UNREAD_PAUSE_AFTER_MS
  ) {
    return null;
  }

  const pile = [...new Set(unread.map((delivery) => delivery.routineId))];
  const paused = await database
    .update(lafRoutines)
    .set({
      enabled: false,
      pausedReason: "unread",
      pausedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(lafRoutines.id, pile),
        eq(lafRoutines.enabled, true),
        eq(lafRoutines.keepRunning, false),
      ),
    )
    .returning({ id: lafRoutines.id });
  if (paused.length === 0) return null;

  const pause: UnreadPause = {
    agentId: first.agentId,
    userId: first.author,
    channelId: conversation.channelId,
    routineIds: pile.filter((id) => paused.some((row) => row.id === id)),
    unread: unread.length,
    since: oldest.at,
  };
  await recordPause(input.auditStore, pause);
  return pause;
}

/**
 * Where reading stopped: the person's read mark on the conversation, or — for one they have never
 * opened — when they joined it. Nothing before that can have been delivered to them there.
 */
async function readMark(
  database: Database,
  channelId: string,
  userId: string,
): Promise<Date | null> {
  const [membership] = await database
    .select({
      lastReadAt: channelMemberships.lastReadAt,
      createdAt: channelMemberships.createdAt,
    })
    .from(channelMemberships)
    .where(
      and(
        eq(channelMemberships.channelId, channelId),
        eq(channelMemberships.userId, userId),
      ),
    );
  if (!membership) return null;
  return membership.lastReadAt ?? membership.createdAt;
}

/** The results these routines delivered after the read mark, oldest first. See the module note. */
async function unreadDeliveries(
  database: Database,
  group: Governed[],
  readFrom: Date,
): Promise<Array<{ routineId: string; at: Date }>> {
  const runs = await database
    .select({ routineId: auditEvents.targetId, at: auditEvents.createdAt })
    .from(auditEvents)
    .where(
      and(
        // The index the trail is read by: (event_type, created_at).
        eq(auditEvents.eventType, "routine.ran"),
        gt(auditEvents.createdAt, readFrom),
        inArray(
          auditEvents.targetId,
          group.map((routine) => routine.id),
        ),
        sql`${auditEvents.payload} ->> 'delivered' = 'true'`,
      ),
    )
    .orderBy(asc(auditEvents.createdAt));
  const resumed = new Map(
    group.map((routine) => [routine.id, routine.resumedAt]),
  );
  return runs.flatMap(({ routineId, at }) => {
    if (!routineId) return [];
    const since = resumed.get(routineId);
    if (since && at.getTime() <= since.getTime()) return [];
    return [{ routineId, at }];
  });
}

/**
 * The trail row, which is also how the person hears of it: the outbox watch turns
 * `routine.paused_unread` into one `routine.paused` notification (`notifications/from-audit.ts`).
 *
 * After the pause and never instead of it — the pause is what saves the run, and a notice that could
 * not be written must not leave the routine running. Facts only: ids, counts and a time. The names
 * are on the rows, and the words are the surface's.
 */
async function recordPause(
  auditStore: AuditStore | undefined,
  pause: UnreadPause,
): Promise<void> {
  const [first] = pause.routineIds;
  if (!auditStore || !first) return;
  await auditStore
    .insert({
      eventType: "routine.paused_unread",
      targetType: "routine",
      targetId: first,
      // A fixture is not a person: named in the payload, never the actor (`auth/dev-actor.ts`).
      ...(pause.userId === DEV_ACTOR.id ? {} : { actorUserId: pause.userId }),
      payload: {
        agentId: pause.agentId,
        actor: pause.userId,
        channelId: pause.channelId,
        routineIds: pause.routineIds,
        count: pause.routineIds.length,
        unread: pause.unread,
        since: pause.since.toISOString(),
      },
    })
    .catch(() => {
      // The routines are paused either way; a trail row lost here is a notice lost, not a run.
    });
}
