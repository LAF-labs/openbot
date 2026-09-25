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
 *
 * HOW IT ENDED IS THE CARD'S DECISION, NOT THE LEDGER'S ALONE (2026-09-25, UX review 0.5.4 item 2).
 * The ledger says `done` for a run that ended on a site's "Access Denied", or on a click that was
 * still waiting for the owner when the window went: the run finished, the task did not. So the turn's
 * browsing steps are read too — which calls it made and what each answered — and ended by the same
 * function the card uses (`shared/task-ending.ts`). The one `status` a row carries is then the same
 * word the card says. Only the facts cross: a code, never the page.
 *
 * WHAT IT LEARNED FOLDS INTO THE TURN THAT LEARNED IT. One message that taught the Bot three things was
 * four rows (UX review 0.5.4, item 12); a memory written while a turn was running is counted on that
 * turn's row, and only one learned outside any turn stands on its own.
 */
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  BROWSING_TOOL_NAMES,
  type EndingStep,
  endingOfSteps,
  factsOfObject,
  type ResultFacts,
  UNANSWERED_RESULT,
} from "../../../shared/task-ending";
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
      /**
       * Why it did not finish, as a code (`laf:page_timeout`, `laf:site_refused`), when the turn's
       * last browsing step says. Null otherwise: the surface says the word without a reason.
       */
      reason: string | null;
      /** Facts the Bot remembered during this turn, counted here instead of a row each. */
      learned: number;
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
      /** Facts the Bot remembered during this run. */
      learned: number;
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
  finishedAt?: Date | null;
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
  /** An assistant row's calls, in order: ids and tool names, never the arguments. */
  callIds: string[];
  callNames: string[];
  /** A tool row's result, reduced to facts in the database. */
  facts: ResultFacts | null;
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
        finishedAt: lafThreadRuns.finishedAt,
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

    /*
     * A call's answer, wherever it was written. A browser carries a step's result into the NEXT run,
     * and a step that never got one is answered with a placeholder at the start of the person's next
     * turn — so a turn's own runs do not hold all of its answers.
     */
    const answerOf = new Map<string, MessageRow>();
    for (const message of messages) {
      if (message.toolCallId) answerOf.set(message.toolCallId, message);
    }
    const learnedAt = memories.map((memory) => memory.createdAt.getTime());
    const counted = new Set<number>();
    const learnedDuring = (runsOf: readonly RunRow[]): number => {
      const from = runsOf[0]?.startedAt.getTime() ?? 0;
      const last = runsOf.at(-1);
      const to = runsOf.some((one) => one.status === "running")
        ? Number.POSITIVE_INFINITY
        : (last?.finishedAt ?? last?.startedAt ?? new Date(0)).getTime() +
          LEARNED_SLACK_MS;
      let count = 0;
      learnedAt.forEach((when, index) => {
        if (counted.has(index) || when < from || when > to) return;
        counted.add(index);
        count += 1;
      });
      return count;
    };

    const items: BotDayItem[] = [];
    for (const turn of turns) {
      const written = turn.runs
        .flatMap((run) => messagesOf.get(run.runId) ?? [])
        .sort((a, b) => a.seq - b.seq);
      const last = turn.runs.at(-1) ?? turn.head;
      const calls = written.flatMap((row) =>
        row.role === "assistant"
          ? row.callIds.map((id, index) => ({
              id,
              name: row.callNames[index] ?? "",
            }))
          : [],
      );
      const ended = endedAs(
        turn.runs.some((run) => run.status === "running")
          ? "running"
          : last.status,
        calls
          .filter((call) => BROWSING_TOOL_NAMES.has(call.name))
          .map(
            (call): EndingStep => ({
              name: call.name,
              facts: answerOf.get(call.id)?.facts ?? null,
            }),
          ),
      );
      /*
       * The picture of a call THIS turn made. Any framed row among the turn's runs used to do, and a
       * turn that never browsed showed the last turn's toss.im screen (UX review 0.5.4, item 4): the
       * earlier task's last answer had arrived with this turn's first run.
       */
      const framed = calls
        .filter((call) => answerOf.get(call.id)?.hasFrame === true)
        .at(-1);
      items.push({
        kind: "chat",
        runId: turn.head.runId,
        at: turn.head.startedAt.toISOString(),
        status: ended.status,
        reason: ended.reason,
        learned: learnedDuring(turn.runs),
        label: turn.head.label,
        channelId: turn.head.threadId
          ? (channelOf.get(turn.head.threadId) ?? null)
          : null,
        messageId: firstSaid(written),
        frameToolCallId: framed?.id ?? null,
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
        learned: learnedDuring([run]),
      });
    }
    memories.forEach((memory, index) => {
      if (counted.has(index)) return;
      items.push({
        kind: "learned",
        memoryId: memory.id,
        at: memory.createdAt.toISOString(),
        head: headOf(memory.content, LEARNED_HEAD_LENGTH) ?? "",
      });
    });

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
 * A memory is written by a tool inside a run, so it lands before the run's end; the slack is for a
 * ledger row whose end was stamped a moment before the write committed.
 */
const LEARNED_SLACK_MS = 2_000;

/**
 * The status a turn's row says, and why: the ledger's, unless the turn's browsing says otherwise.
 *
 * The ledger's word wins where it is already not `done` — stopped, failed, unknown or still running
 * say more than any step can. Where it says `done`, the last browsing task's ending decides: a step
 * that never got its answer is `stopped`, one that failed or a site that refused is `error`, with the
 * code for why.
 */
export function endedAs(
  ledger: DayRunStatus,
  steps: readonly EndingStep[],
): { status: DayRunStatus; reason: string | null } {
  if (ledger !== "done" || steps.length === 0) {
    return { status: ledger, reason: null };
  }
  const ending = endingOfSteps(steps);
  if (ending.kind === "stopped") return { status: "stopped", reason: null };
  if (ending.kind === "failed") return { status: "error", reason: ending.code };
  return { status: "done", reason: null };
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
      callIds: sql<
        unknown[] | null
      >`jsonb_path_query_array(${lafThreadMessages.message} -> 'toolCalls', '$[*].id')`,
      callNames: sql<
        unknown[] | null
      >`jsonb_path_query_array(${lafThreadMessages.message} -> 'toolCalls', '$[*].function.name')`,
      /*
       * A tool row's facts, read in the database so a page's text never leaves it. A result that is
       * not JSON — the placeholder for a call that got no answer, a thrown handler's "Error: …" — is
       * told apart by the placeholder's exact words and by its first characters.
       */
      unanswered: sql<boolean>`${lafThreadMessages.message} ->> 'content' = ${UNANSWERED_RESULT}`,
      thrown: sql<boolean>`left(${lafThreadMessages.message} ->> 'content', 6) = 'Error:'`,
      result: sql<Record<
        string,
        unknown
      > | null>`case when ${lafThreadMessages.message} ->> 'role' = 'tool' and pg_input_is_valid(${lafThreadMessages.message} ->> 'content', 'jsonb') and jsonb_typeof((${lafThreadMessages.message} ->> 'content')::jsonb) = 'object' then jsonb_build_object('ok', ((${lafThreadMessages.message} ->> 'content')::jsonb) -> 'ok', 'stopped', ((${lafThreadMessages.message} ->> 'content')::jsonb) -> 'stopped', 'refused', ((${lafThreadMessages.message} ->> 'content')::jsonb) -> 'refused', 'code', ((${lafThreadMessages.message} ->> 'content')::jsonb) -> 'code', 'httpStatus', ((${lafThreadMessages.message} ->> 'content')::jsonb) -> 'httpStatus') end`,
    })
    .from(lafThreadMessages)
    .where(
      and(
        inArray(lafThreadMessages.threadId, threadIds),
        inArray(lafThreadMessages.runId, runIds),
      ),
    );
  return rows.map(({ unanswered, thrown, result, ...row }) => ({
    ...row,
    seq: Number(row.seq),
    hasText: row.hasText === true,
    hasFrame: row.hasFrame === true,
    callIds: (row.callIds ?? []).filter(
      (id): id is string => typeof id === "string",
    ),
    callNames: (row.callNames ?? []).map((name) =>
      typeof name === "string" ? name : "",
    ),
    facts:
      row.role !== "tool"
        ? null
        : unanswered === true
          ? { unanswered: true }
          : result
            ? factsOfObject(result)
            : thrown === true
              ? { ok: false }
              : {},
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
