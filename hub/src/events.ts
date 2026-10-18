import { sql } from "drizzle-orm";
import {
  HUB_SYNC_LIMIT,
  type HubEvent,
  type HubEventType,
} from "../../shared/hub/protocol";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubEvents } from "./db/schema";

/**
 * One key for every transaction that writes an event. Arbitrary, fixed, and used for nothing else.
 *
 * WHY EVENTS ARE WRITTEN ONE TRANSACTION AT A TIME. `seq` comes from a sequence, and a sequence
 * hands out numbers at insert, not at commit. Two writers can take 7 and 8, and 8 can commit
 * first: a VM that reads "everything after 6" at that moment gets 8, moves its cursor to 8, and
 * never sees 7. Taking this lock before the insert means the transaction that took 7 commits (or
 * rolls back) before any other can take 8, so every number at or below the newest committed one
 * is final. The cost is that event-writing transactions queue behind each other; they are short
 * and a hub's write rate is people's, not machines'.
 */
export const EVENT_WRITE_LOCK = 7_200_001;

export type EmitInput = {
  type: HubEventType;
  refId?: string | null;
  actor?: string | null;
  /** Null or absent: every member. Otherwise only these member ids. */
  visibleTo?: readonly string[] | null;
};

/** Writes one event inside the caller's transaction. Listeners hear of it after the commit. */
export async function emitEvent(
  tx: HubTransaction,
  input: EmitInput,
): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(${EVENT_WRITE_LOCK})`);
  const [row] = await tx
    .insert(hubEvents)
    .values({
      type: input.type,
      refId: input.refId ?? null,
      actor: input.actor ?? null,
      visibleTo: input.visibleTo ? [...input.visibleTo] : null,
    })
    .returning({ seq: hubEvents.seq });
  if (!row) throw new Error("hub_events insert returned nothing");
  return row.seq;
}

/** The newest committed event number, or 0 on a hub with none. */
export async function headSeq(
  database: HubDatabase | HubTransaction,
): Promise<number> {
  const rows = await database.execute<{ head: string | null }>(
    sql`select max(seq)::text as head from hub_events`,
  );
  return Number(rows[0]?.head ?? 0);
}

export type EventPage = { events: HubEvent[]; seq: number; more: boolean };

/**
 * The events after `since` that `member` may see, oldest first, at most `limit`.
 *
 * The head is read first and the page is cut at it. Under the write lock above every number at or
 * below a committed head is final, so returning the head as the cursor skips nothing — and it moves
 * the cursor past events this member may not see, which are then never scanned for them again.
 * When the page is full the cursor is the last event listed instead, and `more` says to ask again.
 */
export async function eventsSince(
  database: HubDatabase,
  member: string,
  since: number,
  limit = HUB_SYNC_LIMIT,
): Promise<EventPage> {
  const head = await headSeq(database);
  if (head <= since)
    return { events: [], seq: Math.max(since, head), more: false };
  const rows = await database.execute<{
    seq: string;
    type: string;
    ref_id: string | null;
    actor: string | null;
    at: Date | string;
  }>(sql`
    select seq::text as seq, type, ref_id, actor, at
      from hub_events
     where seq > ${since}
       and seq <= ${head}
       and (visible_to is null or ${member} = any(visible_to))
     order by seq
     limit ${limit}
  `);
  const events = rows.map(
    (row): HubEvent => ({
      seq: Number(row.seq),
      type: row.type,
      refId: row.ref_id,
      actor: row.actor,
      at: new Date(row.at).toISOString(),
    }),
  );
  const full = events.length === limit;
  const last = events.at(-1);
  return {
    events,
    seq: full && last ? last.seq : head,
    more: full,
  };
}

/**
 * Who is listening, in memory, because the hub is one process (`docs/laf/deployment-model.md`
 * says why that is a decision for a person's VM; the hub is built the same way). Nothing here has
 * to survive a restart: a VM whose socket dropped reconnects with its cursor and is caught up from
 * the table.
 *
 * A listener is poked, not handed the event. It reads what is new for its member from the table,
 * the same query `/sync` runs — so what a socket delivers and what a catch-up delivers cannot
 * disagree, and an event that a slower commit would have put out of order is read in order.
 */
export type Listener = {
  member: string;
  /** The hash of the pass the socket was opened with. */
  passHash: string;
  poke(): void;
  close(code: number, reason: string): void;
  /** Close the socket when its pass stops working. */
  expireAt(until: Date): void;
};

export function createListeners() {
  const listeners = new Set<Listener>();
  return {
    add(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Called after a commit that wrote an event. */
    pokeAll(): void {
      for (const listener of listeners) listener.poke();
    },
    /**
     * A pass was rotated: every socket opened with it is closed when its grace ends. Not at once —
     * the VM is still switching to the new pass, and a socket closed now would reconnect with the
     * old one (valid for the grace) and need this timer anyway.
     */
    expirePass(
      member: string,
      rotation: { current: string; graced: string; until: Date },
      code: number,
      reason: string,
    ): void {
      for (const listener of listeners) {
        if (listener.member !== member) continue;
        if (listener.passHash === rotation.graced) {
          listener.expireAt(rotation.until);
        } else if (listener.passHash !== rotation.current) {
          // A pass the row no longer holds at all — the grace hash a second rotation displaced.
          // HTTP refuses it from this commit on, so its socket goes now, not at its old timer.
          listener.close(code, reason);
        }
      }
    },
    /** A member who left, or whose pass changed, keeps no socket open on the old pass. */
    closeMember(member: string, code: number, reason: string): void {
      for (const listener of listeners) {
        if (listener.member === member) listener.close(code, reason);
      }
    },
    /** At shutdown: a VM told "going away" reconnects to the next process with its cursor. */
    closeAll(code: number, reason: string): void {
      for (const listener of listeners) listener.close(code, reason);
    },
    get size(): number {
      return listeners.size;
    },
  };
}

export type Listeners = ReturnType<typeof createListeners>;
