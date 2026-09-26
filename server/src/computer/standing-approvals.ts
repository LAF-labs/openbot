/**
 * "Do not ask me about this again", and exactly how much of it that covers.
 *
 * `approvals.ts` next door is one yes for one action: ten minutes wide, bound to a hash of the very
 * thing a person was shown, single use. That is what consent looks like, and it is the wrong shape
 * for a Bot that works all day. A person who has told the same Bot four times that it may read the
 * weather site is not consenting on the fourth press; they are clearing an obstacle. The docstring
 * on the approval card says it plainly — an ask rule that gets reflexively approved is worse than no
 * rule at all, because it produces a record of consent nobody actually gave. So this exists to let
 * somebody answer the wider question once, deliberately, and see what they answered.
 *
 * THE SCOPE IS THE WHOLE DESIGN. A standing allowance cannot be bound to a fingerprint — a ref
 * belongs to one snapshot and the next render invents a new one, so such an allowance would match
 * nothing and the button would be a lie. It is bound instead to the coarsest thing a person can hold
 * in their head and check afterwards: this host, this file, or this tool. That is a real widening of
 * the boundary, and three things pay for it:
 *
 *   the surface prints the scope on the button, so the widening is what was agreed to rather than
 *   what was inferred;
 *   the row keeps who granted it, when, and what the Bot was about to do at the time;
 *   `deny` never gets here. Only an `ask` can be answered this way, so nothing a deployment has
 *   forbidden can be un-forbidden by somebody pressing a button at the end of a long task.
 *
 * The rule is part of the key, so rewriting the boundary asks again. A different rule stopping the
 * same action is a different question, and consent to one is not consent to the other.
 *
 * THE MIDDLE ANSWER (2026-09-06). "This once" and "always" were the only two, and they are a day
 * apart in weight: somebody clearing an obstacle for one afternoon either pressed Allow twenty
 * times or stood the boundary down for good. So an allowance can also be bound to the conversation
 * the question came from — the thread — and to a clock, a day. It is the same row with two more
 * columns, listed and withdrawn in the same place, recorded under the same event, and it answers
 * for nothing outside its thread: a Bot doing the same thing in a room or on a schedule is asked.
 *
 * TWO MORE WIDTHS (2026-09-26, the Muse security package): "이 일 동안" and "오늘 하루". The first is
 * narrower than the conversation — the task the person set, which ends at their next message — and
 * the second is a clock with no conversation at all, running out at midnight where the person is.
 * Four answers between "this once" and "for good", each one a sentence a person can check against
 * the list afterwards, and each one's end enforced here rather than by the card that offered it.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { type MessageContent, textOf } from "../../../shared/message-content";
import type { Database } from "../db/client";
import { lafThreadMessages } from "../db/schema";
import { computerStandingApprovals } from "../db/schema/computer";
import type { AskSubject } from "./approvals";

/**
 * What an allowance covers, in the terms the person granting it is shown.
 *
 * Three kinds and no more, because a fourth would be a kind nobody can predict from the sentence on
 * the button. `host` is every action on one site, `file` is one path, `tool` is one tool by name.
 */
export type AllowanceScope = {
  kind: "host" | "file" | "tool";
  value: string;
};

/**
 * The scope an action falls under, from the same fields the policy was given.
 *
 * Ordered by how specific each is, most specific first — a call that names a file is about that
 * file whatever page happened to be open, and one that names neither a file nor a host is about
 * nothing but itself.
 *
 * A FILE IS ONE FILE, deliberately, and it is the narrow end of a trade. A Bot writing twenty
 * reports asks twenty times, which is worse than it sounds until you consider the alternative: one
 * question about one file buying permission to write any file at all is not a widening anybody
 * pressing that button would have predicted. Somebody who genuinely wants the broader thing has the
 * broader tool — an `allow` rule in the policy — and this is a convenience for a repeated identical
 * question, not a policy editor with one button.
 *
 * `tool` is the fallback rather than a case, and it is what a call to somebody else's server always
 * lands on: an MCP tool has no host and no path, only a name. Note what that means for a tool that
 * writes: the approval it replaces was bound to the arguments, and this one is not. It is the widest
 * grant this module can produce and the sentence on the button says so.
 */
export function allowanceFor(subject: {
  /** The tool's name, or for a call to another server, the reference that identifies it. */
  tool: string;
  host?: string | undefined;
  filePath?: string | undefined;
}): AllowanceScope {
  const filePath = subject.filePath?.trim();
  if (filePath) return { kind: "file", value: filePath };
  const host = subject.host?.trim();
  if (host) return { kind: "host", value: host };
  return { kind: "tool", value: subject.tool };
}

/** The scope as one string, which is what the row is keyed on. */
export function scopeKeyOf(scope: AllowanceScope): string {
  return `${scope.kind}=${scope.value}`;
}

/**
 * How long an answer of "and not again" is meant to last.
 *
 * `always` is the standing kind: every conversation, until somebody takes it back. `thread` is the
 * middle answer, bound to the conversation the question was raised in and to a clock. It exists
 * because the two answers a card used to offer were a day apart in weight — "this once" and "for
 * good" — and a person clearing an obstacle for one afternoon had nothing honest to press.
 *
 * `task` is narrower than `thread`: the job the person set with their newest message in that
 * conversation, ending when they write the next one (and after {@link TASK_ALLOWANCE_TTL_MS} at the
 * latest). `day` is wider than `thread` and bound to nothing but the clock: every conversation and
 * every routine, until midnight in the Bot's time zone.
 */
export type AllowanceTier = "always" | "thread" | "task" | "day";

/** Every tier, widest first — the order `find` prefers them in. */
export const ALLOWANCE_TIERS: readonly AllowanceTier[] = [
  "always",
  "day",
  "thread",
  "task",
];

/**
 * How long a task-bound allowance stands at most, when the person never writes again.
 *
 * Six hours: longer than any job a person watches a Bot do, short enough that a conversation
 * somebody walked away from at lunch does not carry "이 일 동안" into the evening. The person's next
 * message ends it sooner, which is the usual end.
 */
export const TASK_ALLOWANCE_TTL_MS = 6 * 60 * 60_000;

/**
 * The next midnight in `timeZone` after `at`, as an instant.
 *
 * "오늘 하루" is the person's day, not twenty-four hours: an answer given at 23:50 in Seoul lasts ten
 * minutes, and the list says so. Computed from the zone's own offset at that midnight, twice, so a
 * zone whose offset changes that night still lands on its own 00:00.
 */
export function endOfDayIn(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(at));
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const midnightAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day") + 1,
  );
  let guess = midnightAsUtc - offsetIn(timeZone, midnightAsUtc);
  guess = midnightAsUtc - offsetIn(timeZone, guess);
  return guess;
}

/** How far ahead of UTC `timeZone` is at `at`, in milliseconds. */
function offsetIn(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * How long a conversation-bound allowance stands on its own.
 *
 * A day, because a conversation here has no end of its own: a thread stays open for as long as the
 * channel exists, so "for this conversation" bound only to the thread would be "always, for this
 * channel". The clock is what makes the sentence on the button true. Whichever comes first — the
 * thread going away or the day running out — ends it.
 */
export const THREAD_ALLOWANCE_TTL_MS = 24 * 60 * 60_000;

export type StandingApproval = {
  id: string;
  botId: string;
  /** The expression that asked. Empty when the floor asked rather than a written rule. */
  rule: string;
  scope: string;
  scopeKind: AllowanceScope["kind"];
  scopeValue: string;
  tier: AllowanceTier;
  /** The conversation it answers for. Present exactly when the tier is `thread` or `task`. */
  threadId?: string;
  /** The person's message whose task it answers for. Present exactly when the tier is `task`. */
  taskId?: string;
  /** When it stops standing on its own. Present for every tier but `always`. */
  expiresAt?: string;
  /**
   * What the Bot was about to do when they granted it, in facts.
   *
   * Absent on rows granted before the sentence became a subject (migration 0026), and the surface
   * says what it can from the scope alone rather than inventing one.
   */
  subject?: AskSubject;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
  revokedBy?: string;
};

export type StandingGrant = {
  botId: string;
  rule: string;
  scope: AllowanceScope;
  /** The action that raised the question they answered with "always". */
  subject: AskSubject;
  grantedBy: string;
  /** Absent is `always`, which is what every grant was before the middle answer existed. */
  tier?: AllowanceTier;
  /**
   * The conversation a `thread` or `task` grant is bound to. Required for those tiers and ignored
   * otherwise.
   *
   * Read off the approval's own record by the answering route, never off the request: a body that
   * could name a thread could bind an allowance to a conversation the person was not looking at.
   */
  threadId?: string;
  /** The task a `task` grant is bound to, off the approval's record like the thread. */
  taskId?: string;
};

/** Where an action is happening, for the store to decide which allowances answer for it. */
export type AllowanceLookup = {
  /** The conversation the action was raised from. Absent for work outside any — a routine. */
  threadId?: string | undefined;
  /**
   * The task that conversation is on now: the person's newest message in it. Read by the server
   * ({@link StandingApprovalStore.currentTask}), never taken from the request.
   */
  taskId?: string | undefined;
};

export type StandingApprovalStore = {
  /**
   * The live allowance covering this action, or null.
   *
   * On the hot path of every asked action, before a question is opened. Null is the answer for a
   * revoked one, which is what makes revoking mean anything.
   */
  find: (
    botId: string,
    rule: string,
    scope: string,
    /**
     * Where the action is happening. A standing allowance answers wherever it is; a
     * conversation-bound one answers only in its own thread and only until its clock runs out, so
     * an action raised from nowhere in particular — a routine — is answered by the standing kind
     * alone.
     */
    where?: AllowanceLookup,
  ) => Promise<StandingApproval | null>;
  /**
   * Grant one, or hand back the one that already stands.
   *
   * Idempotent, because two tabs showing the same question both offer the button and a person may
   * well press both. A second row would be one a later revoke does not remove.
   */
  grant: (input: StandingGrant) => Promise<StandingApproval>;
  /** Everything still standing, newest first. One Bot's, or every Bot's when none is named. */
  list: (botId?: string) => Promise<StandingApproval[]>;
  /**
   * Withdraw one. Null when it was not standing — already withdrawn, or never granted here.
   *
   * The row stays and is marked, because withdrawing an allowance is itself a decision about a
   * boundary and a row that vanishes takes the record of ever having granted it along too.
   */
  revoke: (id: string, actor: string) => Promise<StandingApproval | null>;
  /**
   * The conversation is over: withdraw everything bound to it, and say what was withdrawn.
   *
   * Marked rather than deleted, like `revoke`, and under the actor that ended the conversation, so
   * the trail can say that the allowance stopped because the thread did rather than because
   * somebody changed their mind about it.
   */
  endThread: (threadId: string, actor: string) => Promise<StandingApproval[]>;
  /**
   * Which task a conversation is on now — the id of the person's newest message in it — or
   * undefined when it has none this store can see.
   *
   * What makes "이 일 동안" end: the task a question was raised under is read here when it is
   * asked, and an allowance for it answers only while this still returns the same id. Absent on a
   * store that cannot know, which then simply never offers the answer.
   */
  currentTask?: (threadId: string) => Promise<string | undefined>;
};

type Bound = {
  tier: AllowanceTier;
  threadId: string | undefined;
  taskId: string | undefined;
  expiresAt: number | undefined;
};

/**
 * The tier, the thread and the task a grant is asking for, checked against each other, and when
 * it runs out.
 *
 * A `thread` grant with no thread would be a row that no lookup can ever match — an allowance that
 * exists, is listed, and answers for nothing — so it is refused here rather than recorded, and a
 * `task` grant with no task the same. The answering route reads both off the approval, which lacks
 * them when the question was raised from outside any conversation; the card does not offer the
 * buttons then, and this is the check behind the card.
 */
function boundTo(input: StandingGrant, at: number, timeZone: string): Bound {
  const tier = input.tier ?? "always";
  if (tier === "always") {
    return {
      tier,
      threadId: undefined,
      taskId: undefined,
      expiresAt: undefined,
    };
  }
  if (tier === "day") {
    return {
      tier,
      threadId: undefined,
      taskId: undefined,
      expiresAt: endOfDayIn(timeZone, at),
    };
  }
  const threadId = input.threadId?.trim();
  if (!threadId) {
    throw new Error(
      "an allowance for this conversation needs to know which conversation",
    );
  }
  if (tier === "thread") {
    return {
      tier,
      threadId,
      taskId: undefined,
      expiresAt: at + THREAD_ALLOWANCE_TTL_MS,
    };
  }
  const taskId = input.taskId?.trim();
  if (!taskId) {
    throw new Error("an allowance for this task needs to know which task");
  }
  return { tier, threadId, taskId, expiresAt: at + TASK_ALLOWANCE_TTL_MS };
}

/** Where an allowance's own binding says it answers: the lookup must name the same conversation and task. */
function answersWhere(
  row: Pick<StandingApproval, "tier" | "threadId" | "taskId">,
  where: AllowanceLookup,
): boolean {
  if (row.tier === "always" || row.tier === "day") return true;
  if (!where.threadId || row.threadId !== where.threadId) return false;
  if (row.tier === "thread") return true;
  return where.taskId !== undefined && row.taskId === where.taskId;
}

/** The widest of several live allowances, which is the one a reader expects on the rows it covers. */
function widest<T extends { tier: AllowanceTier }>(rows: T[]): T | undefined {
  for (const tier of ALLOWANCE_TIERS) {
    const row = rows.find((entry) => entry.tier === tier);
    if (row) return row;
  }
  return undefined;
}

/** The zone a day-long answer ends in when the caller does not say: the product's own default. */
const FALLBACK_TIME_ZONE = "Asia/Seoul";

/**
 * The store, in memory. FOR TESTS ONLY — nothing wires this.
 *
 * It survives the deletion of the approval and repeat Maps' database twins (decision §7-1) because
 * it is the mirror image of them: those were a database copy of state that belongs in memory, and
 * this is a memory copy of state that belongs in the database. It exists so a test about a boundary
 * can run without one — `computer-gateway.test.ts` and `approval-routes.test.ts` both inject it —
 * and `standing-approvals.integration.test.ts` holds the two to one contract so the one nobody
 * ships cannot be the only one that works.
 *
 * A deployment runs the database store below, because an allowance whose whole purpose is to
 * outlive the turn must outlive the process too.
 */
export function createStandingApprovalStore(
  options: {
    now?: () => number;
    /** Where "오늘 하루" ends. Absent: Seoul, the product's default. */
    timeZone?: string;
    /** The task a conversation is on now. Absent: no task is ever known, so none is offered. */
    currentTask?: (threadId: string) => Promise<string | undefined>;
  } = {},
): StandingApprovalStore {
  const now = options.now ?? (() => Date.now());
  const timeZone = options.timeZone ?? FALLBACK_TIME_ZONE;
  const rows = new Map<string, StandingApproval>();

  /** Still standing: not withdrawn, and not past its own clock where it has one. */
  const standing = (row: StandingApproval) =>
    row.revokedAt === undefined &&
    (row.expiresAt === undefined || Date.parse(row.expiresAt) > now());

  /** The live row under exactly this binding. */
  const holding = (
    input: { botId: string; rule: string; scope: string },
    bound: Pick<Bound, "tier" | "threadId" | "taskId">,
  ) =>
    [...rows.values()].find(
      (row) =>
        row.botId === input.botId &&
        row.rule === input.rule &&
        row.scope === input.scope &&
        row.tier === bound.tier &&
        row.threadId === bound.threadId &&
        row.taskId === bound.taskId &&
        standing(row),
    );

  const withdraw = (row: StandingApproval, actor: string) => {
    const revoked: StandingApproval = {
      ...row,
      revokedAt: new Date(now()).toISOString(),
      revokedBy: actor,
    };
    rows.set(row.id, revoked);
    return revoked;
  };

  const store: StandingApprovalStore = {
    find: async (botId, rule, scope, where = {}) =>
      widest(
        [...rows.values()].filter(
          (row) =>
            row.botId === botId &&
            row.rule === rule &&
            row.scope === scope &&
            standing(row) &&
            answersWhere(row, where),
        ),
      ) ?? null,

    grant: async (input) => {
      const scope = scopeKeyOf(input.scope);
      const at = now();
      const bound = boundTo(input, at, timeZone);
      const already = holding({ ...input, scope }, bound);
      if (already) return already;
      const granted: StandingApproval = {
        id: randomUUID(),
        botId: input.botId,
        rule: input.rule,
        scope,
        scopeKind: input.scope.kind,
        scopeValue: input.scope.value,
        tier: bound.tier,
        ...(bound.threadId ? { threadId: bound.threadId } : {}),
        ...(bound.taskId ? { taskId: bound.taskId } : {}),
        ...(bound.expiresAt === undefined
          ? {}
          : { expiresAt: new Date(bound.expiresAt).toISOString() }),
        subject: input.subject,
        grantedBy: input.grantedBy,
        grantedAt: new Date(at).toISOString(),
      };
      rows.set(granted.id, granted);
      return granted;
    },

    list: async (botId) =>
      withCurrentTasks(
        [...rows.values()]
          .filter(
            (row) =>
              standing(row) && (botId === undefined || row.botId === botId),
          )
          .sort((left, right) => right.grantedAt.localeCompare(left.grantedAt)),
        options.currentTask,
      ),

    revoke: async (id, actor) => {
      const row = rows.get(id);
      if (!row || row.revokedAt !== undefined) return null;
      return withdraw(row, actor);
    },

    endThread: async (threadId, actor) =>
      [...rows.values()]
        .filter(
          (row) => row.threadId === threadId && row.revokedAt === undefined,
        )
        .map((row) => withdraw(row, actor)),

    ...(options.currentTask ? { currentTask: options.currentTask } : {}),
  };
  return store;
}

/**
 * The live rows, less the task-bound ones whose task is over.
 *
 * A task allowance's clock is its outer bound; what usually ends it is the person writing again,
 * which no clock can see. `find` never matches one of those — it is handed the current task — so the
 * list must not show one as standing either: a list that says "이 일 동안" about a job that finished
 * an hour ago is a boundary describing itself wrongly. One read per conversation, not per row.
 */
async function withCurrentTasks(
  rows: StandingApproval[],
  currentTask: ((threadId: string) => Promise<string | undefined>) | undefined,
): Promise<StandingApproval[]> {
  const threads = new Set(
    rows
      .filter((row) => row.tier === "task" && row.threadId)
      .map((row) => row.threadId as string),
  );
  if (threads.size === 0) return rows;
  const current = new Map<string, string | undefined>();
  for (const threadId of threads) {
    current.set(threadId, await currentTask?.(threadId));
  }
  return rows.filter(
    (row) =>
      row.tier !== "task" ||
      (row.threadId !== undefined &&
        row.taskId !== undefined &&
        current.get(row.threadId) === row.taskId),
  );
}

/**
 * The person's newest message in a conversation, by its id: the task that conversation is on.
 *
 * Every run hands the whole history back and `appendMessages` writes each message once, at the
 * start of the run whose input first carries it — so the person's message is in the table before
 * the Bot does anything about it, and a browser step carried on by a fresh run (`waiting`, then the
 * next run) adds no person's message and leaves the task where it was. Measured shape, not assumed:
 * `runner/laf-runner.ts` appends in `startRun` and again in `finishRun`, both idempotent by id.
 */
export async function currentTaskIn(
  database: Database,
  threadId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ id: sql<string | null>`${lafThreadMessages.message} ->> 'id'` })
    .from(lafThreadMessages)
    .where(
      and(
        eq(lafThreadMessages.threadId, threadId),
        sql`${lafThreadMessages.message} ->> 'role' = 'user'`,
      ),
    )
    .orderBy(desc(lafThreadMessages.seq))
    .limit(1);
  return row?.id ?? undefined;
}

/**
 * What the person asked for in their newest message in a conversation, as text: the task the
 * high-risk check weighs a submission against ("is this data leaving for a reason the task gives?").
 * Empty when there is no conversation — a routine — or nothing the store can read.
 */
export async function ownerTaskTextIn(
  database: Database,
  threadId: string | undefined,
): Promise<string> {
  if (!threadId) return "";
  const [row] = await database
    .select({ message: lafThreadMessages.message })
    .from(lafThreadMessages)
    .where(
      and(
        eq(lafThreadMessages.threadId, threadId),
        sql`${lafThreadMessages.message} ->> 'role' = 'user'`,
      ),
    )
    .orderBy(desc(lafThreadMessages.seq))
    .limit(1);
  const content = (row?.message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" || Array.isArray(content)
    ? textOf(content as MessageContent)
    : "";
}

/**
 * The same store, where a restart can still see it.
 *
 * The one a deployment runs. An allowance held in a Map is withdrawn by a deploy without anybody
 * saying so, and quietly returning everybody to being asked is precisely the state this feature
 * exists to get them out of — so the Map is for tests and this is for people.
 *
 * `grant` inserts and lets the partial unique index decide the race, then reads back: two tabs
 * pressing the button at the same moment produce one live row, and both are told about that one.
 * `revoke` is `UPDATE ... WHERE revoked_at IS NULL`, so a second press is told there was nothing
 * left to withdraw rather than overwriting who withdrew it and when. Two tabs, not two servers:
 * one process serves both requests and they are still two transactions.
 */
export function createDatabaseStandingApprovalStore(
  database: Database,
  options: {
    now?: () => number;
    /** Where "오늘 하루" ends: the Bot's time zone (`BOT_TIME_ZONE`). Absent: Seoul. */
    timeZone?: string;
  } = {},
): StandingApprovalStore {
  const now = options.now ?? (() => Date.now());
  const timeZone = options.timeZone ?? FALLBACK_TIME_ZONE;
  const currentTask = (threadId: string) => currentTaskIn(database, threadId);

  const asStanding = (
    row: typeof computerStandingApprovals.$inferSelect,
  ): StandingApproval => ({
    id: row.id,
    botId: row.botId,
    rule: row.rule,
    scope: row.scope,
    // Written by `grant` from an `AllowanceScope`, so the column only ever holds one of the three.
    scopeKind: row.scopeKind as AllowanceScope["kind"],
    scopeValue: row.scopeValue,
    // Written by `grant` from an `AllowanceTier`; 0056 backfilled the rows from before it.
    tier: row.tier as AllowanceTier,
    ...(row.threadId === null ? {} : { threadId: row.threadId }),
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    ...(row.expiresAt === null
      ? {}
      : { expiresAt: row.expiresAt.toISOString() }),
    ...(row.subject ? { subject: row.subject } : {}),
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt.toISOString(),
    ...(row.revokedAt === null
      ? {}
      : { revokedAt: row.revokedAt.toISOString() }),
    ...(row.revokedBy === null ? {} : { revokedBy: row.revokedBy }),
  });

  /** Still standing: not withdrawn, and not past its own clock where it has one. */
  const standing = () =>
    and(
      isNull(computerStandingApprovals.revokedAt),
      or(
        isNull(computerStandingApprovals.expiresAt),
        gt(computerStandingApprovals.expiresAt, new Date(now())),
      ),
    );

  const find = async (
    botId: string,
    rule: string,
    scope: string,
    where: AllowanceLookup = {},
  ) => {
    const rows = await database
      .select()
      .from(computerStandingApprovals)
      .where(
        and(
          eq(computerStandingApprovals.botId, botId),
          eq(computerStandingApprovals.rule, rule),
          eq(computerStandingApprovals.scope, scope),
          where.threadId
            ? or(
                isNull(computerStandingApprovals.threadId),
                eq(computerStandingApprovals.threadId, where.threadId),
              )
            : isNull(computerStandingApprovals.threadId),
          standing(),
        ),
      );
    // The binding checked in code as well as in SQL, by the same function the Map uses, so the two
    // stores cannot disagree about which task a row answers for.
    const row = widest(
      rows.map(asStanding).filter((entry) => answersWhere(entry, where)),
    );
    return row ?? null;
  };

  /**
   * The live row under this exact binding, expired or not.
   *
   * `find` will not return an expired row and the unique index does not read `expires_at`, so an
   * allowance whose clock has run out still holds its slot until somebody withdraws it. `grant`
   * needs to see that row to retire it.
   */
  const holding = async (
    botId: string,
    rule: string,
    scope: string,
    bound: Pick<Bound, "tier" | "threadId" | "taskId">,
  ) => {
    const [row] = await database
      .select()
      .from(computerStandingApprovals)
      .where(
        and(
          eq(computerStandingApprovals.botId, botId),
          eq(computerStandingApprovals.rule, rule),
          eq(computerStandingApprovals.scope, scope),
          eq(computerStandingApprovals.tier, bound.tier),
          bound.threadId
            ? eq(computerStandingApprovals.threadId, bound.threadId)
            : isNull(computerStandingApprovals.threadId),
          bound.taskId
            ? eq(computerStandingApprovals.taskId, bound.taskId)
            : isNull(computerStandingApprovals.taskId),
          isNull(computerStandingApprovals.revokedAt),
        ),
      )
      .limit(1);
    return row;
  };

  const grant: StandingApprovalStore["grant"] = async (input) => {
    const scope = scopeKeyOf(input.scope);
    const at = now();
    const bound = boundTo(input, at, timeZone);
    const [inserted] = await database
      .insert(computerStandingApprovals)
      .values({
        id: randomUUID(),
        botId: input.botId,
        rule: input.rule,
        scope,
        scopeKind: input.scope.kind,
        scopeValue: input.scope.value,
        tier: bound.tier,
        threadId: bound.threadId ?? null,
        taskId: bound.taskId ?? null,
        expiresAt:
          bound.expiresAt === undefined ? null : new Date(bound.expiresAt),
        subject: input.subject,
        grantedBy: input.grantedBy,
        grantedAt: new Date(at),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return asStanding(inserted);
    /*
     * Lost the race, or it already stood: either way the answer is the row that is standing now.
     *
     * Looked up under the same binding that was inserted, and a wider row is NOT accepted as the
     * answer to a narrower grant: the person pressed the narrower button, and handing back the wider
     * row would report that they had pressed another one.
     */
    const row = await holding(input.botId, input.rule, scope, bound);
    if (!row) throw new Error("the allowance could not be recorded");
    if (row.expiresAt !== null && row.expiresAt <= new Date(now())) {
      // Run out but still holding the slot. Retired under the person granting anew, once, and the
      // fresh grant they asked for is recorded in its place.
      await database
        .update(computerStandingApprovals)
        .set({ revokedAt: new Date(now()), revokedBy: input.grantedBy })
        .where(eq(computerStandingApprovals.id, row.id));
      return grant(input);
    }
    return asStanding(row);
  };

  return {
    find,

    grant,

    list: async (botId) => {
      const where = botId
        ? and(standing(), eq(computerStandingApprovals.botId, botId))
        : standing();
      const rows = await database
        .select()
        .from(computerStandingApprovals)
        .where(where)
        .orderBy(desc(computerStandingApprovals.grantedAt));
      return withCurrentTasks(rows.map(asStanding), currentTask);
    },

    revoke: async (id, actor) => {
      const [row] = await database
        .update(computerStandingApprovals)
        .set({ revokedAt: new Date(now()), revokedBy: actor })
        .where(
          and(
            eq(computerStandingApprovals.id, id),
            isNull(computerStandingApprovals.revokedAt),
          ),
        )
        .returning();
      return row ? asStanding(row) : null;
    },

    endThread: async (threadId, actor) => {
      const rows = await database
        .update(computerStandingApprovals)
        .set({ revokedAt: new Date(now()), revokedBy: actor })
        .where(
          and(
            eq(computerStandingApprovals.threadId, threadId),
            isNull(computerStandingApprovals.revokedAt),
          ),
        )
        .returning();
      return rows.map(asStanding);
    },

    currentTask,
  };
}
