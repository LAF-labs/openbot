/**
 * 오늘: WHAT THE BOT DID TODAY, AS FACTS (`GET /api/agents/:agentId/day`).
 *
 * The Bot works all day — routines on a clock, browsing, things it learns — and until this, none of
 * it showed unless somebody scrolled the conversation for it. A routine that answered `[SILENT]`
 * showed nowhere at all, by design (`routines/deliver.ts`). Every one of those is already a row:
 * the ledger has each run (`laf_thread_runs`), the receipts say what a routine answered
 * (`laf_routine_runs`), the transcript says which message a run wrote and whether it browsed
 * (`laf_thread_messages`), and the memories carry when they were learned (`agent_memories`). This
 * reads them for one day and one Bot; nothing is written, and no table or index is added.
 *
 * FACTS, NEVER PROSE. The surface owns the words: a status, a label the person wrote, an id to
 * jump to. Nothing here is read into a prompt either — 오늘 costs the Bot no tokens.
 *
 * THE DAY IS THE PERSON'S. From 00:00 in their home zone (`account/whereabouts.ts`), else the
 * deployment's, on a VM that keeps UTC. At midnight the list empties, which is the point: yesterday's
 * work is in the conversation.
 *
 * A BROWSING TURN IS MANY RUNS. Every computer tool is carried out in the browser, which starts the
 * next run with the result (`runner/laf-runner.ts`, `handedToBrowser`), so one "예스24에서 찾아 줘" is
 * a dozen ledger rows. Only the first carries the person's words (`chatLabelOf`); the rest fold into
 * it here, so a person sees one row for one thing they asked.
 */
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  agentMemories,
  channelThreads,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
} from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { isSilentAnswer } from "../routines/deliver";
import { headOf } from "../runner/run-ledger";

export type DayRunStatus = "done" | "error" | "stopped" | "unknown" | "running";

export type BotDayItem =
  | {
      kind: "chat";
      runId: string;
      at: string;
      status: DayRunStatus;
      /** The start of what the person asked. Null for a turn that began before labels existed. */
      label: string | null;
      channelId: string | null;
      /** The Bot's first transcript row of the turn, as the transcript keys it. */
      messageId: string | null;
      /** The browsing task's last picture, served by `GET /channels/:id/frames/:toolCallId`. */
      frameToolCallId: string | null;
    }
  | {
      kind: "routine";
      runId: string;
      routineId: string | null;
      at: string;
      status: DayRunStatus;
      name: string;
      /** Answered `[SILENT]`: ran, found nothing new, and said nothing in the conversation. */
      silent: boolean;
      channelId: string | null;
      /** The delivered answer. Null when silent, failed, or not delivered yet. */
      messageId: string | null;
    }
  | { kind: "learned"; memoryId: string; at: string; head: string };

export type BotDay = {
  /** `YYYY-MM-DD` in `zone`. */
  day: string;
  zone: string;
  /** Newest first, at most `DAY_ITEM_LIMIT`. */
  items: BotDayItem[];
  more: boolean;
};

export const DAY_ITEM_LIMIT = 50;
/** How much of a memory a row shows: the list is for noticing, the notebook for reading. */
export const LEARNED_HEAD_LENGTH = 30;
/**
 * A ceiling on the runs one day's read walks. A browsing turn is a run per step, so the rows are
 * many more than the items; past this the oldest steps of the day are simply not folded.
 */
const RUN_READ_LIMIT = 2000;

/**
 * The instants a zone's calendar day starts and ends at, around `now`: `[start, end)`.
 *
 * Offsets are read from the zone database at the instant in question rather than assumed, and read
 * again at the guessed midnight, so a day that starts or ends on a summer-time change is still the
 * day the wall clock shows. (Seoul keeps no summer time; somebody abroad may.)
 */
export function zonedDayOf(
  now: Date,
  zone: string,
): { day: string; start: Date; end: Date } {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const wall = (at: Date) => {
    const parts = format.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((piece) => piece.type === type)?.value);
    return {
      year: part("year"),
      month: part("month"),
      day: part("day"),
      utc: Date.UTC(
        part("year"),
        part("month") - 1,
        part("day"),
        part("hour"),
        part("minute"),
        part("second"),
      ),
    };
  };
  const offsetAt = (at: number) =>
    wall(new Date(at)).utc - Math.floor(at / 1000) * 1000;
  const midnight = (year: number, month: number, day: number) => {
    const local = Date.UTC(year, month - 1, day);
    const guess = local - offsetAt(now.getTime());
    return new Date(local - offsetAt(guess));
  };
  const today = wall(now);
  const start = midnight(today.year, today.month, today.day);
  const end = midnight(today.year, today.month, today.day + 1);
  const day = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  return { day, start, end };
}

type RunRow = {
  runId: string;
  threadId: string | null;
  origin: string;
  label: string | null;
  status: DayRunStatus;
  startedAt: Date;
};

type MessageRow = {
  runId: string | null;
  seq: number;
  role: string | null;
  id: string | null;
  hasText: boolean;
  firstCallId: string | null;
  toolCallId: string | null;
  hasFrame: boolean;
};

/** One thing the person asked, and the runs a browser carried it through. */
type Turn = { head: RunRow; runs: RunRow[] };

export type DayReader = (input: {
  userId: string;
  agentId: string;
}) => Promise<BotDay>;

export function createDayReader(options: {
  database: Database;
  /** The person's home zone, or null when their device never said. */
  zoneOf: (userId: string) => Promise<string | null>;
  /** The deployment's zone, for a person whose device never said. */
  fallbackZone: string;
  now?: () => Date;
}): DayReader {
  const { database } = options;
  const now = options.now ?? (() => new Date());

  return async ({ userId, agentId }) => {
    const zone = (await options.zoneOf(userId)) ?? options.fallbackZone;
    const { day, start, end } = zonedDayOf(now(), zone);

    /*
     * EVERY READ IS SCOPED TO THE PERSON AND THE BOT. The route has already checked the Bot is theirs
     * to see; the ledger and the memories are still asked by both, because a read by Bot alone is
     * the shape that quietly becomes wrong the day two people share one.
     */
    const runs = (await database
      .select({
        runId: lafThreadRuns.runId,
        threadId: lafThreadRuns.threadId,
        origin: lafThreadRuns.origin,
        label: lafThreadRuns.label,
        status: lafThreadRuns.status,
        startedAt: lafThreadRuns.startedAt,
      })
      .from(lafThreadRuns)
      .where(
        and(
          eq(lafThreadRuns.userId, userId),
          eq(lafThreadRuns.agentId, agentId),
          inArray(lafThreadRuns.origin, ["chat", "routine"]),
          gte(lafThreadRuns.startedAt, start),
          lt(lafThreadRuns.startedAt, end),
        ),
      )
      .orderBy(asc(lafThreadRuns.startedAt))
      .limit(RUN_READ_LIMIT)) as RunRow[];

    const turns = foldTurns(runs.filter((run) => run.origin === "chat"));
    const routineRuns = runs.filter((run) => run.origin === "routine");

    const threadIds = [
      ...new Set(runs.flatMap((run) => (run.threadId ? [run.threadId] : []))),
    ];
    const runIds = runs.map((run) => run.runId);

    const [messages, channels, receipts, memories] = await Promise.all([
      threadIds.length > 0 && runIds.length > 0
        ? readMessages(database, threadIds, runIds)
        : Promise.resolve([] as MessageRow[]),
      threadIds.length > 0
        ? database
            .select({
              threadId: channelThreads.threadId,
              channelId: channelThreads.channelId,
            })
            .from(channelThreads)
            .where(
              and(
                eq(channelThreads.userId, userId),
                inArray(channelThreads.threadId, threadIds),
              ),
            )
        : Promise.resolve([]),
      routineRuns.length > 0
        ? database
            .select({
              id: lafRoutineRuns.id,
              routineId: lafRoutineRuns.routineId,
              ok: lafRoutineRuns.ok,
              answer: lafRoutineRuns.answer,
            })
            .from(lafRoutineRuns)
            .innerJoin(
              lafRoutines,
              eq(lafRoutines.id, lafRoutineRuns.routineId),
            )
            .where(
              and(
                inArray(
                  lafRoutineRuns.id,
                  routineRuns.map((run) => run.runId),
                ),
                eq(lafRoutines.agentId, agentId),
              ),
            )
        : Promise.resolve([]),
      database
        .select({
          id: agentMemories.id,
          content: agentMemories.content,
          createdAt: agentMemories.createdAt,
        })
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.agentId, agentId),
            eq(agentMemories.ownerUserId, userId),
            isNull(agentMemories.forgottenAt),
            gte(agentMemories.createdAt, start),
            lt(agentMemories.createdAt, end),
          ),
        ),
    ]);

    /*
     * A routine whose run has no receipt yet — still running, or from before the ledger and the
     * receipt shared an id — is found by the name it ran under, so the row can still open its card.
     */
    const unmatched = routineRuns.filter(
      (run) => !receipts.some((receipt) => receipt.id === run.runId),
    );
    const byName =
      unmatched.length > 0
        ? await database
            .select({ id: lafRoutines.id, name: lafRoutines.name })
            .from(lafRoutines)
            .where(
              and(
                eq(lafRoutines.agentId, agentId),
                eq(lafRoutines.createdById, userId),
              ),
            )
        : [];

    const channelOf = new Map(
      channels.map((row) => [row.threadId, row.channelId]),
    );
    const messagesOf = new Map<string, MessageRow[]>();
    for (const message of messages) {
      if (!message.runId) continue;
      const list = messagesOf.get(message.runId) ?? [];
      list.push(message);
      messagesOf.set(message.runId, list);
    }

    const items: BotDayItem[] = [];
    for (const turn of turns) {
      const written = turn.runs
        .flatMap((run) => messagesOf.get(run.runId) ?? [])
        .sort((a, b) => a.seq - b.seq);
      const last = turn.runs.at(-1) ?? turn.head;
      items.push({
        kind: "chat",
        runId: turn.head.runId,
        at: turn.head.startedAt.toISOString(),
        status: turn.runs.some((run) => run.status === "running")
          ? "running"
          : last.status,
        label: turn.head.label,
        channelId: turn.head.threadId
          ? (channelOf.get(turn.head.threadId) ?? null)
          : null,
        messageId: firstSaid(written),
        frameToolCallId:
          written.filter((row) => row.hasFrame && row.toolCallId).at(-1)
            ?.toolCallId ?? null,
      });
    }
    for (const run of routineRuns) {
      const receipt = receipts.find((row) => row.id === run.runId);
      const silent =
        receipt?.ok === true && isSilentAnswer(receipt.answer ?? "");
      const delivered = silent
        ? null
        : firstSaid(
            (messagesOf.get(run.runId) ?? []).sort((a, b) => a.seq - b.seq),
          );
      items.push({
        kind: "routine",
        runId: run.runId,
        routineId:
          receipt?.routineId ??
          byName.find((routine) => routine.name === run.label)?.id ??
          null,
        at: run.startedAt.toISOString(),
        status: run.status,
        name: run.label ?? "",
        silent,
        channelId: run.threadId ? (channelOf.get(run.threadId) ?? null) : null,
        messageId: delivered,
      });
    }
    for (const memory of memories) {
      items.push({
        kind: "learned",
        memoryId: memory.id,
        at: memory.createdAt.toISOString(),
        head: headOf(memory.content, LEARNED_HEAD_LENGTH) ?? "",
      });
    }

    items.sort((a, b) => b.at.localeCompare(a.at));
    return {
      day,
      zone,
      items: items.slice(0, DAY_ITEM_LIMIT),
      more: items.length > DAY_ITEM_LIMIT,
    };
  };
}

/**
 * Chat runs, oldest first, folded into the turns a person started.
 *
 * A run with the person's words starts a turn; one without is a browser step carrying the newest
 * turn on that thread. A step with no turn before it today — one carried over midnight — stands on
 * its own, unnamed, rather than being dropped: it is still work the Bot did today.
 */
export function foldTurns(runs: readonly RunRow[]): Turn[] {
  const turns: Turn[] = [];
  const open = new Map<string, Turn>();
  for (const run of runs) {
    const thread = run.threadId ?? "";
    const current = open.get(thread);
    if (run.label === null && current) {
      current.runs.push(run);
      continue;
    }
    const turn = { head: run, runs: [run] };
    turns.push(turn);
    open.set(thread, turn);
  }
  return turns;
}

/**
 * The first thing the Bot put in the transcript, keyed the way the transcript keys its rows
 * (`app/src/components/channels/chat-messages.ts`): an assistant message with words is its own id,
 * one that only calls a tool is drawn as that call — or as the browsing card named after it.
 */
function firstSaid(rows: readonly MessageRow[]): string | null {
  for (const row of rows) {
    if (row.role !== "assistant") continue;
    if (row.hasText && row.id) return row.id;
    if (row.firstCallId) return row.firstCallId;
  }
  return null;
}

/**
 * What the day's runs wrote, without the words or the pictures.
 *
 * Only the shape: the role, the id, whether there was text, the first call and whether a frame is
 * kept. On the thread primary key's prefix; `run_id` narrows within the Bot's own thread.
 */
async function readMessages(
  database: Database,
  threadIds: string[],
  runIds: string[],
): Promise<MessageRow[]> {
  const rows = await database
    .select({
      runId: lafThreadMessages.runId,
      seq: lafThreadMessages.seq,
      role: sql<string | null>`${lafThreadMessages.message} ->> 'role'`,
      id: sql<string | null>`${lafThreadMessages.message} ->> 'id'`,
      hasText: sql<boolean>`jsonb_typeof(${lafThreadMessages.message} -> 'content') = 'string' and length(${lafThreadMessages.message} ->> 'content') > 0`,
      firstCallId: sql<
        string | null
      >`${lafThreadMessages.message} -> 'toolCalls' -> 0 ->> 'id'`,
      toolCallId: sql<
        string | null
      >`${lafThreadMessages.message} ->> 'toolCallId'`,
      hasFrame: sql<boolean>`${lafThreadMessages.frame} is not null`,
    })
    .from(lafThreadMessages)
    .where(
      and(
        inArray(lafThreadMessages.threadId, threadIds),
        inArray(lafThreadMessages.runId, runIds),
      ),
    );
  return rows.map((row) => ({
    ...row,
    seq: Number(row.seq),
    hasText: row.hasText === true,
    hasFrame: row.hasFrame === true,
  }));
}

/** `GET /api/agents/:agentId/day`, mounted under `/api/agents` beside the profile routes. */
export function createDayRoutes(
  /** Whether this person may see this Bot at all: the profile store's own answer. */
  canSee: (actor: AppVariables["actor"], agentId: string) => Promise<boolean>,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  readDay: DayReader,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/:agentId/day", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    try {
      // The same answer `GET /:agentId` gives for a Bot this person cannot see.
      if (!(await canSee(context.var.actor, agentId))) {
        return context.json(
          { error: "laf:agent_not_found", code: "laf:agent_not_found" },
          404,
        );
      }
      return context.json(
        await readDay({ userId: context.var.actor.id, agentId }),
      );
    } catch (error) {
      log.error("bot_day_not_read", { reason: describeFailure(error) });
      return context.json(
        { error: "laf:day_unavailable", code: "laf:day_unavailable" },
        500,
      );
    }
  });
  return routes;
}
