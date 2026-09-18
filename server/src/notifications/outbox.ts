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
 * Two exceptions write inside somebody else's transaction and are offered to the doors only once it
 * has committed: a fleet notice (`recordFleetNotice`), and a routine's failure group
 * (`failure-groups.ts`), whose row is the one notification a run of identical failures is worth
 * and is edited, not repeated, as the failures go on (`offer`, `acknowledge`).
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
import { and, asc, desc, eq, gt, isNull, like, sql } from "drizzle-orm";
import type { DeploymentAdmission } from "../auth/admission";
import type { TurnFailureCode } from "../channels/turn-failures";
import type { AskSubject } from "../computer/approvals";
import type { Database } from "../db/client";
import { lafNotifications, type RoutinePauseReason } from "../db/schema";
import type { RunOrigin } from "../runner/run-ledger";
import type { DiagnosticsSummary } from "../support/diagnostics";
import {
  acknowledgeFailureGroup,
  type FailureGroupFacts,
} from "./failure-groups";

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
  /**
   * A Bot's routines were paused because their results piled up unread (`routines/unread.ts`).
   *
   * Neither blocked nor finished, and still worth telling: something the person set going has
   * stopped, and they did not press anything. Once per pause — the sweep writes one trail row for
   * it and the watch turns that into this (`from-audit.ts`) — and never through 알림톡, which has
   * no template for it and costs money per message. It points at the conversation where the
   * results are waiting, which is also where reading them starts the count again.
   */
  "routine.paused",
  /**
   * A person wrote to the people who run the product, from the 문의·의견 box.
   *
   * The odd one out twice over. It is addressed to the operator, not to the person, so it goes
   * through no door that reaches a person — only a door that says it takes support rows (see
   * `deliver`). And it is the person's own words, so it never appears in their list (see `list`):
   * "you wrote to us" is not a thing anybody needs interrupting about.
   */
  "support.feedback",
  /**
   * A person pressed 아쉬워요 under a Bot's answer and wrote why (`support/answer-ratings.ts`).
   *
   * The same odd one out as `support.feedback`, for the same two reasons: it is addressed to the
   * operator, so it goes through the support door alone, and it is the person's own words, so it
   * never appears in their list. Only a 아쉬워요 that carries a note is written here — a press with
   * nothing written is a count, and the fleet reads counts from the ratings table, not from alerts.
   */
  "support.answer_rating",
  /**
   * A person withdrew, and the fleet tool that destroys this VM when nobody is left must hear it.
   *
   * The other odd one out, and odder: it is addressed to NO person here — the person it is about
   * is deleted in the same transaction that writes it, which is why `user_id` may be null (migration
   * 0038) — and it is the one kind the outbox retries (`redeliver`). It is written INSIDE the
   * deletion's transaction, so no crash can separate the withdrawal from its notice, and it goes
   * through exactly one door, the fleet webhook's (`fleet/notify.ts`). It used to be one `fetch`
   * after the commit: a process that died in between, or a fleet down for the ten seconds that call
   * waited, lost the notice for good, and the VM of somebody who had left went on being billed
   * (audit A1-4).
   */
  "fleet.account_deleted",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Rows addressed to the operator rather than to the person. The prefix is the rule. */
export function isSupportKind(kind: string): boolean {
  return kind.startsWith("support.");
}

/** Rows addressed to the fleet tool. Retried until a door takes them; see `redeliver`. */
export function isFleetKind(kind: string): boolean {
  return kind.startsWith("fleet.");
}

/**
 * What a `fleet.account_deleted` row carries: the envelope `fleet/notify.ts` signs and sends.
 *
 * Counted inside the deletion's transaction, after the person's row went, so `remainingAccounts` is
 * the number the fleet acts on — zero destroys the machine — and never an address: `actor` is the
 * pseudonym the trail carries.
 */
export type FleetFacts = {
  event: "account.deleted";
  actor: string;
  remainingAccounts: number;
};

/**
 * What a `support.feedback` row carries, in facts — and, this once, the words too.
 *
 * `text` is the person's own message and rides in the row so the door can post it without a second
 * read; the row it duplicates lives in `laf_feedback` and outlives this one. The two screen facts
 * are present only when the person chose to attach them, and are the only two the box can send:
 * the path they were on and the last failure code that screen drew. Never a screenshot, never a
 * transcript — `support/routes.ts` keeps nothing else whatever the client sends.
 */
export type SupportFacts = {
  /** The `laf_feedback` row, which is the message; this row is only the telling. */
  feedbackId: string;
  text: string;
  route?: string;
  failureCode?: string;
  /**
   * How much diagnostic detail the row holds, when the person attached some: counts, and only
   * counts. The bundle names their Bots and runs, and it stays in `laf_feedback` on this VM.
   */
  diagnostics?: DiagnosticsSummary;
};

/**
 * What a `support.answer_rating` row carries: which answer, which Bot, and what the person wrote.
 *
 * The note is the person's own words and rides in the row for the same reason a 문의·의견 message
 * does — so the door can post it without a second read. The ANSWER does not, and there is no field
 * here it could ride in: `message_id` is how the operator finds it on the VM if they must, and the
 * words stay in `laf_thread_messages`. `botName` is the Bot's name when the rating was sent, since
 * an alert that said only `bot_3f9c…` would send the operator into the database to read one word.
 */
export type AnswerRatingFacts = {
  /** The `laf_answer_ratings` row, which is the rating; this row is only the telling. */
  ratingId: string;
  channelId: string;
  messageId: string;
  agentId: string;
  botName: string;
  /** One of `ANSWER_RATING_REASONS`, or null when the person chose none. */
  reason: string | null;
  note: string;
};

/**
 * What a `run.failed` row is about, in facts.
 *
 * The same rule as `subject`: the words belong to the surface. `label` is the routine's name — a
 * thing the person wrote, not a sentence — and `code` is one of the transcript's own failure codes
 * (`channels/turn-failures.ts`), so the notification and the red line under the message are two
 * readings of one fact rather than two opinions. `origin` says what kind of run it was, which is
 * what a webhook receiver needs to tell "the 07:30 briefing failed" from "a chat turn died".
 *
 * STORED IN THE SAME COLUMN AS `subject`, under `kind: "run"`. A `run.failed` row has no action to
 * describe and an approval row has no run to name, so the column holds whichever the row is about;
 * `factsOf` tells them apart by that discriminator, and a reader of the other field sees nothing.
 * `AskSubject` itself is not widened to carry this, because a run is not an action and the AlimTalk
 * door reads that type to say what is waiting — a run that failed is never waiting.
 */
export type RunFailureFacts = {
  origin: RunOrigin;
  /** What the run was doing, in words a person wrote: a routine's name. */
  label?: string;
  code: TurnFailureCode;
};

/**
 * What a `routine.paused` row is about, in facts: why, which routines, how many results were waiting
 * unread and since when. Stored in `subject` under `kind: "pause"`, the way a failed run's facts are
 * under `kind: "run"` — see `factsOf`. The words are the surface's.
 */
export type RoutinePauseFacts = {
  reason: RoutinePauseReason;
  routineIds: string[];
  /** How many routines were paused. */
  count: number;
  /** How many results were waiting unread when they were. */
  unread: number;
  /** When the oldest of those arrived, as an ISO string. */
  since: string;
};

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
  /** What the run was and how it ended, for a `run.failed` row. See {@link RunFailureFacts}. */
  run?: RunFailureFacts;
  /**
   * For a `run.failed` row that is a failure group: how many times, when last, and whether it is
   * acknowledged or closed. Beside `run` rather than inside it, so the facts every door has always
   * been sent about a run are exactly what they were. See `failure-groups.ts`.
   */
  group?: FailureGroupFacts;
  /** What the person wrote and where they were, for a `support.feedback` row. */
  support?: SupportFacts;
  /** Which answer fell short and why, for a `support.answer_rating` row. */
  rating?: AnswerRatingFacts;
  /** The withdrawal the fleet is told about, for a `fleet.*` row. See {@link FleetFacts}. */
  fleet?: FleetFacts;
  /** Which routines stopped and why, for a `routine.paused` row. See {@link RoutinePauseFacts}. */
  pause?: RoutinePauseFacts;
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
 *
 * `accepts` says which kinds this door is for. A door that does not say is a door to a PERSON —
 * the socket, the phone, the buzz webhook — and is offered everything except the support rows,
 * which are addressed to the operator, and the fleet rows, which are addressed to nobody here. The
 * default is written that way round so that the three doors that existed before there were support
 * rows did not each need a line saying "not those".
 */
export type NotificationAdapter = {
  name: string;
  deliver: (record: NotificationRecord) => Promise<boolean>;
  accepts?: (kind: NotificationKind) => boolean;
};

export type EnqueueInput = {
  kind: NotificationKind;
  /** Which Bot this is about. Empty for a support row, which is about nobody's Bot. */
  botId: string;
  userId: string;
  approvalId?: string;
  channelId?: string;
  subject?: AskSubject;
  run?: RunFailureFacts;
  support?: SupportFacts;
  rating?: AnswerRatingFacts;
  pause?: RoutinePauseFacts;
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
   * Write a fleet notice inside a transaction the caller owns, and offer it to nobody yet.
   *
   * THROWS, unlike `enqueue`, and that is the point: the caller is deleting a person, and a
   * withdrawal whose notice could not be written must roll back with it rather than commit into the
   * silence this row exists to end. Offered to its door by `redeliver`, once the caller has
   * committed — a notice for a deletion that then rolled back would destroy a VM somebody is on.
   */
  recordFleetNotice: (
    executor: Pick<Database, "insert">,
    facts: FleetFacts,
  ) => Promise<void>;
  /**
   * Offer every fleet row no door has taken yet to the doors that take it, and record who did.
   *
   * Called right after the transaction that wrote one, on a tick, and at boot — the last for a row a
   * process wrote and died before delivering. One at a time within the process (one API process per
   * VM, `docs/laf/deployment-model.md`), so two callers never send the same row twice. Person rows
   * are not retried: their retry is the in-app list, and a buzz hours late is noise.
   *
   * Never throws. Answers how many rows were taken this time.
   */
  redeliver: () => Promise<number>;
  /**
   * Offer a row written earlier, inside a transaction that has since committed, to the doors.
   *
   * The failure group's half of what `enqueue` does in one call: `failure-groups.ts` writes the row
   * inside the run's settlement, and the trail's watch offers it once the run is on the record
   * (`from-audit.ts`). Only a row no door has taken yet, so a second offer delivers nothing twice.
   * Never throws; null when there was nothing to offer.
   */
  offer: (id: string) => Promise<NotificationRecord | null>;
  /**
   * The person acknowledged a failure group: it goes quiet and stops waiting in their list.
   *
   * False when the row is not theirs, is not a group, or is gone. Pressing it twice is true twice.
   */
  acknowledge: (userId: string, id: string) => Promise<boolean>;
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
  /**
   * Who this deployment still lets act (`auth/admission.ts`). A row addressed to anybody else is
   * kept and offered to no door — see `deliver`. Optional in the TYPE for the suites that test the
   * doors alone; `main.ts` always passes it.
   */
  admission?: Pick<DeploymentAdmission, "admitsPerson">;
}): NotificationOutbox {
  const { database, admission } = input;
  const adapters = input.adapters ?? [];
  const now = input.now ?? (() => new Date());
  const log = input.log ?? ((message: string) => console.error(message));

  /**
   * Whether the person a row is addressed to may still be reached about this deployment.
   *
   * A person struck off the sign-in list cannot open a single thing a notification points at, and
   * their routines no longer run (`routines/run.ts`) — but a question, a boot's interrupted-run
   * report or a row written before the removal would still buzz their webhook and send 알림톡 to
   * the phone they connected (audit 2026-09-16, R1-04). A lookup that fails counts as no: a buzz
   * that could not be checked is the one that should not go out, and the row stays in the list.
   */
  const recipientAdmitted = async (userId: string): Promise<boolean> => {
    if (!admission) return true;
    return admission.admitsPerson(userId).catch(() => false);
  };

  const rowToRecord = (row: typeof lafNotifications.$inferSelect) =>
    ({
      id: row.id,
      // Read back as whatever the column holds. A kind this build does not know is still a row, and
      // the surface ignores what it cannot draw rather than the read failing.
      kind: row.kind as NotificationKind,
      botId: row.botId,
      // Empty for a `fleet.*` row, which is addressed to nobody here: no person door is ever offered
      // one (`accepts`), and `list` and `markSeen` match a real id, never this.
      userId: row.userId ?? "",
      ...(row.approvalId ? { approvalId: row.approvalId } : {}),
      ...(row.channelId ? { channelId: row.channelId } : {}),
      ...factsOf(row.subject),
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
    // A support or fleet row goes only to a door that asked for it; every other row goes to every
    // door that did not ask for anything. See `NotificationAdapter.accepts`.
    const toAPerson = !isSupportKind(record.kind) && !isFleetKind(record.kind);
    const doors = adapters.filter((adapter) =>
      adapter.accepts ? adapter.accepts(record.kind) : toAPerson,
    );
    if (doors.length === 0) return record;
    // Nobody the deployment no longer admits is reached through any door; the row is kept as written.
    if (toAPerson && !(await recipientAdmitted(record.userId))) return record;
    const outcomes = await Promise.allSettled(
      doors.map(async (adapter) => ({
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
       * nothing but this function — once, in the same call that inserted the row, or for a fleet
       * row from `redeliver`, which reaches only rows no door has taken and runs one at a time.
       * There is no second writer to lose an update to.
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

  /** The in-process queue `redeliver` runs on. See its note on why one at a time. */
  let redelivering: Promise<number> = Promise.resolve(0);

  const redeliverOnce = async (): Promise<number> => {
    const pending = await database
      .select()
      .from(lafNotifications)
      .where(
        and(
          like(lafNotifications.kind, "fleet.%"),
          isNull(lafNotifications.deliveredAt),
        ),
      )
      .orderBy(asc(lafNotifications.createdAt));
    let taken = 0;
    for (const row of pending) {
      const record = await deliver(rowToRecord(row));
      if (record.deliveredAt) taken += 1;
    }
    return taken;
  };

  return {
    recordFleetNotice: async (executor, facts) => {
      await executor.insert(lafNotifications).values({
        id: randomUUID(),
        kind: "fleet.account_deleted",
        // About no Bot and addressed to no person here; see the kind's note.
        botId: "",
        userId: null,
        subject: { kind: "fleet", ...facts },
        createdAt: now(),
      });
    },

    redeliver: () => {
      redelivering = redelivering.then(redeliverOnce).catch((error) => {
        log(`[outbox] fleet redelivery failed: ${message(error)}`);
        return 0;
      });
      return redelivering;
    },

    offer: async (id) => {
      try {
        const [row] = await database
          .select()
          .from(lafNotifications)
          .where(
            and(
              eq(lafNotifications.id, id),
              isNull(lafNotifications.deliveredAt),
            ),
          );
        if (!row) return null;
        return await deliver(rowToRecord(row));
      } catch (error) {
        log(`[outbox] could not offer ${id}: ${message(error)}`);
        return null;
      }
    },

    acknowledge: (userId, id) =>
      acknowledgeFailureGroup(database, { userId, id, at: now() }),

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
              : enqueueInput.run
                ? { subject: { kind: "run", ...enqueueInput.run } }
                : enqueueInput.support
                  ? { subject: { kind: "support", ...enqueueInput.support } }
                  : enqueueInput.rating
                    ? { subject: { kind: "rating", ...enqueueInput.rating } }
                    : enqueueInput.pause
                      ? { subject: { kind: "pause", ...enqueueInput.pause } }
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
            // The list is what is waiting for this person. Their own words to the operator are
            // not, and a row that stayed here would sit unseen until the thirty-day sweep.
            sql`${lafNotifications.kind} not like 'support.%'`,
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
    .where(
      and(
        // Except a fleet notice no door has taken yet: it is retried until one does, and dropping it
        // after thirty days of an unreachable fleet would be the lost withdrawal it exists to prevent.
        sql`${lafNotifications.createdAt} < ${cutoff} and not (${lafNotifications.kind} like 'fleet.%' and ${lafNotifications.deliveredAt} is null)`,
        /*
         * And except a failure group that failed again inside the window (`failure-groups.ts`). Its
         * row is how the next failure knows it is a repeat, and a routine broken for five weeks
         * would otherwise open a fresh group — a second red line, a second buzz, the acknowledgement
         * forgotten — on day thirty-one, for a failure nothing about had changed. A group goes
         * thirty days after its LAST failure, and its line in the conversation then reads as a
         * plain failure line again, which is what every such line read before groups existed.
         *
         * Compared as text: both sides are `toISOString()`, which sorts as it reads, and a cast
         * would let one malformed row fail the whole sweep.
         */
        sql`not (${lafNotifications.kind} = 'run.failed' and coalesce(${lafNotifications.subject} -> 'group' ->> 'lastAt', '') >= ${cutoff.toISOString()})`,
      ),
    )
    .returning({ id: lafNotifications.id });
  return removed.length;
}

/** The `subject` column, read back as whichever fact it holds. See `RunFailureFacts`. */
function factsOf(
  stored: unknown,
): Pick<
  NotificationRecord,
  "subject" | "run" | "group" | "support" | "rating" | "fleet" | "pause"
> {
  if (!stored || typeof stored !== "object") return {};
  const held = stored as Record<string, unknown>;
  if (held.kind === "run") {
    const { kind: _kind, group, ...facts } = held;
    return {
      run: facts as RunFailureFacts,
      ...(group && typeof group === "object"
        ? { group: group as FailureGroupFacts }
        : {}),
    };
  }
  if (held.kind === "support") {
    const { kind: _kind, ...facts } = held;
    return { support: facts as SupportFacts };
  }
  if (held.kind === "rating") {
    const { kind: _kind, ...facts } = held;
    return { rating: facts as AnswerRatingFacts };
  }
  if (held.kind === "fleet") {
    const { kind: _kind, ...facts } = held;
    return { fleet: facts as FleetFacts };
  }
  if (held.kind === "pause") {
    const { kind: _kind, ...facts } = held;
    return { pause: facts as RoutinePauseFacts };
  }
  return { subject: stored as AskSubject };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
