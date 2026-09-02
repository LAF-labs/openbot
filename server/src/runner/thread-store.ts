/**
 * The one conversation store: every message this deployment holds is written here and read here.
 *
 * There used to be three writers and two disciplines on one jsonb array. `laf-runner.ts` rewrote
 * the whole array from an in-memory mirror merged with the client's copy; `rooms/transcript.ts` and
 * `routines/deliver.ts` appended with `jsonb || jsonb`. An append that landed between the runner's
 * read and its overwrite was simply gone, the mirror the overwrite was built from had to be glued
 * back into step after every append (`adoptSnapshot`), a turn cost a rewrite of the entire
 * conversation, and boot read every thread's full history into memory. Three message type
 * definitions said the same thing three times.
 *
 * So: one row per message, one function that writes them, and readers that all come through here.
 *
 * WHY AN ADVISORY LOCK AND NOT `SELECT max(seq) … FOR UPDATE`. `FOR UPDATE` locks rows, and the
 * case that has to be safe is the one with no rows to lock — two writers appending the first
 * message of a thread at the same instant. (Postgres also refuses `FOR UPDATE` next to an
 * aggregate outright.) Locking the thread's last row would leave a brand-new thread unguarded, and
 * both writers would claim seq 1: one of them takes a primary-key violation, which is a delivery
 * lost to a crash rather than to a race — no better. `pg_advisory_xact_lock` locks the THREAD, a
 * thing that exists before its first message does, and releases at commit whether that commit
 * comes from here or from the caller's own transaction. It costs one round trip and it is the same
 * mechanism the seat count uses for the same reason.
 */
import type { Message } from "@ag-ui/client";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadMessages } from "../db/schema";

/**
 * A message as this store holds it: AG-UI's shape plus the two things AG-UI cannot carry.
 *
 * `lafAt` is when the message was first seen and `lafAgentId` is which Bot said it. Neither can
 * ride AG-UI's own message type — every message schema is zod `strip`, so a key the client attaches
 * is deleted before a run reaches the server, and `/threads/:id/messages` rebuilds each message
 * from a fixed whitelist on the way back out. They survive because this column is jsonb and the
 * read path casts rather than validates. Stamping on the server is also the only way the two sides
 * of a conversation share one clock.
 *
 * This is the ONLY definition. There were three (`StampedMessage` twice, `StoredMessage` once).
 */
export type StoredMessage = Message & {
  lafAt?: string;
  lafAgentId?: string;
};

/**
 * Anything that can run a statement: the pool, or a transaction already open around it.
 *
 * `transaction` is in the list because the append has to hold a lock across two statements, and a
 * caller who is already inside a transaction (the room's post, which bumps the turn epoch in the
 * same breath) must not have a second one opened underneath it.
 */
export type Executor = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "execute" | "transaction"
>;

export type AppendOptions = {
  /** The run that produced these, where one did. */
  runId?: string | null;
  /** When they arrived. Only used for messages this append is the first to see. */
  at?: Date;
};

/**
 * One stored message, healed if it arrived double-encoded.
 *
 * Rows written before the driver's array handling was understood hold a jsonb STRING containing
 * the JSON rather than the JSON. Returning `null` for those would render an old conversation as an
 * empty one — the read swallowing the bug rather than the write being fixed — so the string is
 * parsed. This is the one parser; `parseMessages` in the runner used to be a private copy of it.
 */
export function parseMessage(stored: unknown): StoredMessage | null {
  if (typeof stored === "string") {
    try {
      return parseMessage(JSON.parse(stored));
    } catch {
      return null;
    }
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return null;
  }
  return typeof (stored as { id?: unknown }).id === "string"
    ? (stored as StoredMessage)
    : null;
}

/** The stamps a thread already carries, so an append can preserve them. */
export function stampsOf(messages: readonly Message[]): Map<string, string> {
  const times = new Map<string, string>();
  for (const message of messages) {
    const at = (message as StoredMessage).lafAt;
    if (typeof at === "string") times.set(message.id, at);
  }
  return times;
}

/** The speakers a thread already carries, for the same reason `stampsOf` exists. */
export function speakersOf(messages: readonly Message[]): Map<string, string> {
  const speakers = new Map<string, string>();
  for (const message of messages) {
    const by = (message as StoredMessage).lafAgentId;
    if (typeof by === "string") speakers.set(message.id, by);
  }
  return speakers;
}

/**
 * Merge stamps onto a message list, FIRST SEEN WINS.
 *
 * Each run's input carries the whole history back, unstamped, so re-stamping on every save would
 * march every message in a conversation forward to the time of its most recent turn. The stamps
 * already stored are the record; `fallback` is only for messages that have none.
 */
export function stamp(
  messages: readonly Message[],
  known: ReadonlyMap<string, string>,
  /**
   * Every id this thread already held, stamped or not.
   *
   * The distinction matters exactly once per thread: the first save after stamping shipped. Those
   * messages are known to the store and carry no time, because nobody was recording one when they
   * were said — and `fallback` would then declare that the whole back history happened at the
   * instant of the next reply. A conversation with no separators is a conversation whose timing we
   * do not know; one with wrong separators is a record that lies.
   */
  seen: ReadonlySet<string>,
  fallback: string,
): StoredMessage[] {
  return messages.map((message) => {
    const existing = (message as StoredMessage).lafAt ?? known.get(message.id);
    if (existing) return { ...message, lafAt: existing };
    if (seen.has(message.id)) return { ...message };
    return { ...message, lafAt: fallback };
  });
}

/**
 * Merge speakers onto a message list, FIRST WRITER WINS and NO FALLBACK.
 *
 * The absence of a fallback is the difference from `stamp`, and it is deliberate. A time can be
 * approximated — "we first saw this now" is true even if it was said earlier. A speaker cannot: a
 * message whose Bot nobody recorded belongs to no particular Bot, and filling it in with whoever
 * happens to be running would put one colleague's words under another's name for the life of the
 * conversation. Unattributed is the honest state, and the transcript knows how to draw it.
 */
export function attribute(
  messages: readonly Message[],
  known: ReadonlyMap<string, string>,
): StoredMessage[] {
  return messages.map((message) => {
    const existing =
      (message as StoredMessage).lafAgentId ?? known.get(message.id);
    return existing ? { ...message, lafAgentId: existing } : { ...message };
  });
}

/**
 * A stable rendering of a message, for deciding whether a row would actually change.
 *
 * Key order is not stable across the paths a message takes — one copy is built from a stream, the
 * next arrives through the client and back through zod — so a plain `JSON.stringify` comparison
 * would report every message as changed on every turn and turn each turn into a rewrite of the
 * whole conversation, which is the cost this table exists to remove.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, held]) => held !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A class id for `pg_advisory_xact_lock`, so this lock cannot be confused with another one.
 *
 * Postgres advisory locks live in one flat namespace across the whole database; the two-argument
 * form is how unrelated subsystems stay out of each other's way.
 */
const LOCK_CLASS = 0x1af7;

/**
 * Write messages into a thread. The one writer — runner, room and routine delivery alike.
 *
 * A message the thread already holds is NOT appended again: every run hands the whole history back
 * as its input, so the common case is that most of what arrives is already here. It is updated in
 * place when the incoming copy differs, which is the case the runner depends on — an assistant turn
 * is stored from its text events without the tool calls it also made, and those arrive with the
 * next run's input carrying the same message id. The row keeps its `seq` and its `at`, so a richer
 * copy never reorders a conversation or restamps it.
 *
 * Returns the thread as it now stands, in order.
 */
export async function appendMessages(
  executor: Executor,
  threadId: string,
  incoming: readonly Message[],
  options: AppendOptions = {},
): Promise<StoredMessage[]> {
  if (incoming.length === 0) return messagesFor(executor, threadId);
  const at = options.at ?? new Date();
  const runId = options.runId ?? null;

  return executor.transaction(async (transaction) => {
    /*
     * The thread, locked before it is read. `hashtext` is stable and collisions only cost two
     * unrelated threads a moment of waiting; the constant class id keeps this lock apart from
     * every other advisory lock this deployment takes.
     */
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(${threadId}))`,
    );

    const held = await transaction
      .select({
        seq: lafThreadMessages.seq,
        message: lafThreadMessages.message,
      })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId))
      .orderBy(asc(lafThreadMessages.seq));

    const stored = new Map<string, { seq: number; message: StoredMessage }>();
    for (const row of held) {
      const message = parseMessage(row.message);
      if (message) stored.set(message.id, { seq: row.seq, message });
    }

    const known = stampsOf([...stored.values()].map((row) => row.message));
    const speakers = speakersOf([...stored.values()].map((row) => row.message));
    const merged = attribute(
      stamp(incoming, known, new Set(stored.keys()), at.toISOString()),
      speakers,
    );

    /*
     * Counted off `held` rather than off `stored`, so a row this module could not parse still holds
     * its number. Reusing a `seq` a broken row occupies would take the primary key down with it.
     */
    let next = held.reduce((highest, row) => Math.max(highest, row.seq), 0);
    const fresh = new Map<string, typeof lafThreadMessages.$inferInsert>();
    for (const message of merged) {
      // A batch can name the same message twice — the caller's history, plus a reply the run just
      // rebuilt. The second one is an edit of the first, never a second row.
      const waiting = fresh.get(message.id);
      if (waiting) {
        waiting.message = message as unknown as Record<string, unknown>;
        continue;
      }
      const previous = stored.get(message.id);
      if (!previous) {
        next += 1;
        fresh.set(message.id, {
          threadId,
          seq: next,
          message: message as unknown as Record<string, unknown>,
          at,
          runId,
        });
        continue;
      }
      if (canonical(previous.message) === canonical(message)) continue;
      await transaction
        .update(lafThreadMessages)
        .set({ message: message as unknown as Record<string, unknown> })
        .where(
          and(
            eq(lafThreadMessages.threadId, threadId),
            eq(lafThreadMessages.seq, previous.seq),
          ),
        );
      stored.set(message.id, { seq: previous.seq, message });
    }
    if (fresh.size > 0) {
      await transaction.insert(lafThreadMessages).values([...fresh.values()]);
      for (const [id, row] of fresh) {
        stored.set(id, {
          seq: row.seq,
          message: row.message as unknown as StoredMessage,
        });
      }
    }

    return [...stored.values()]
      .sort((left, right) => left.seq - right.seq)
      .map((row) => row.message);
  });
}

/** Every message in a thread, in order. Empty for a thread nothing has been written to. */
export async function messagesFor(
  executor: Executor,
  threadId: string,
): Promise<StoredMessage[]> {
  const rows = await executor
    .select({ message: lafThreadMessages.message })
    .from(lafThreadMessages)
    .where(eq(lafThreadMessages.threadId, threadId))
    .orderBy(asc(lafThreadMessages.seq));
  return rows.flatMap((row) => {
    const message = parseMessage(row.message);
    return message ? [message] : [];
  });
}

/** The same, for several threads at once, keyed by thread. */
export async function messagesForAll(
  executor: Executor,
  threadIds: readonly string[],
): Promise<Map<string, StoredMessage[]>> {
  const found = new Map<string, StoredMessage[]>();
  if (threadIds.length === 0) return found;
  const rows = await executor
    .select({
      threadId: lafThreadMessages.threadId,
      message: lafThreadMessages.message,
    })
    .from(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, [...threadIds]))
    .orderBy(asc(lafThreadMessages.threadId), asc(lafThreadMessages.seq));
  for (const row of rows) {
    const message = parseMessage(row.message);
    if (!message) continue;
    const held = found.get(row.threadId);
    if (held) held.push(message);
    else found.set(row.threadId, [message]);
  }
  return found;
}

/** Message id to ISO-8601, for every message in the thread that carries a stamp. */
export type MessageTimes = Record<string, string>;

/** Message id to the id of the Bot that said it, for every message that carries one. */
export type MessageSpeakers = Record<string, string>;

export type ThreadMarks = { times: MessageTimes; speakers: MessageSpeakers };

/**
 * When each message was first seen and which Bot said it — the stamps only, not the messages.
 *
 * Read out of the jsonb rather than off the `at` column on purpose. `at` is when the ROW was
 * written, and the rows the 0026 backfill created know only when their snapshot was last saved;
 * drawing the transcript's separators from that would have this product invent times for
 * conversations it never timed. A message with no stamp is skipped, which makes the transcript
 * draw one fewer separator — the honest outcome.
 */
export function createMessageMarkReader(database: Database) {
  return async (threadId: string): Promise<ThreadMarks> => {
    const rows = await database
      .select({
        id: sql<string | null>`${lafThreadMessages.message} ->> 'id'`,
        at: sql<string | null>`${lafThreadMessages.message} ->> 'lafAt'`,
        by: sql<string | null>`${lafThreadMessages.message} ->> 'lafAgentId'`,
      })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId))
      .orderBy(asc(lafThreadMessages.seq));

    const times: MessageTimes = {};
    const speakers: MessageSpeakers = {};
    for (const row of rows) {
      if (!row.id) continue;
      if (row.at) times[row.id] = row.at;
      if (row.by) speakers[row.id] = row.by;
    }
    return { times, speakers };
  };
}

/** What `listThreads` needs, without reading a single message body. */
export type ThreadSummary = {
  threadId: string;
  /** The Bot the last attributed message in the thread belongs to, or null when none is. */
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Every thread this deployment holds, as a summary.
 *
 * One aggregate over the row times — no message bodies cross the wire. This is what replaced boot
 * reading every thread's full history into memory, and it is read for the one route that asks for
 * a thread list rather than at startup.
 */
export async function threadSummaries(
  executor: Executor,
): Promise<ThreadSummary[]> {
  const rows = await executor
    .select({
      threadId: lafThreadMessages.threadId,
      createdAt: sql<Date>`min(${lafThreadMessages.at})`,
      updatedAt: sql<Date>`max(${lafThreadMessages.at})`,
      agentId: sql<
        string | null
      >`(array_agg(${lafThreadMessages.message} ->> 'lafAgentId' order by ${lafThreadMessages.seq} desc) filter (where ${lafThreadMessages.message} ->> 'lafAgentId' is not null))[1]`,
    })
    .from(lafThreadMessages)
    .groupBy(lafThreadMessages.threadId);
  return rows.map((row) => ({
    threadId: row.threadId,
    agentId: row.agentId,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }));
}
