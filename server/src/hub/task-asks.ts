/**
 * "이 일감에서는 해도 돼": a person letting one board task past the one kind of action it stopped on.
 *
 * WHERE THE YES IS JUDGED. On this VM, by the boundary, and nowhere else (lafi-dev-design §7): a
 * task's run reaches an action that asks, nobody is at the screen, so it stops and the task goes to
 * `blocked` with the topic — the kind of action and where. The stop's facts are kept here
 * (`hub_task_asks`). When the person presses the button on the task's conversation, the grant is
 * made FROM THAT ROW — its rule, its scope, its subject, its topic — as a `board_task` standing
 * allowance bound to the task's conversation and the topic (`computer/standing-approvals.ts`). The
 * next run of that task meets the same rule on the same scope and topic, and `settle.ts` lets it
 * past; any other task, any other topic, any `deny`, and any deployment that switched allowances off
 * (`settleWithoutAsking`) are asked or refused exactly as before.
 *
 * WHAT THE HUB HEARS. `POST /tasks/:id/approvals {topic}`: the task goes back to `todo` with the
 * member's note `laf:task_approval_granted topic:<topic>`, and the hub says `task.approval_granted`
 * — who, what kind of action (the same facts the stop's note already put on the board), when. No
 * value, no rule, no page. A hub that is away hears it through the outbox when it is back.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { HUB_FACTS } from "../../../shared/hub/protocol";
import type { AgentActor } from "../agents/profile-types";
import { type AuditStore, auditRowLost, recordAuditEvent } from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { AskSubject } from "../computer/approvals";
import type {
  AllowanceScope,
  StandingApprovalStore,
} from "../computer/standing-approvals";
import type { Database } from "../db/client";
import { agentProfiles, hubTaskAsks } from "../db/schema";
import { log } from "../log";
import type { HubHttp } from "./http";
import type { HubOutbox } from "./outbox";
import { taskThreadOf } from "./task-run";
import {
  HUB_TASK_APPROVAL_PATH,
  HUB_TASK_NOT_BLOCKED,
  HUB_TASK_NOT_YOURS,
  taskApprovalBody,
} from "./wire";

/** A stop for a person's yes, as the run that met it saw it. */
export type TaskAsk = {
  taskId: string;
  runId: string;
  botId: string;
  rule: string;
  scope: AllowanceScope;
  subject: AskSubject;
  topic: string;
};

export type TaskAsks = {
  /** The task's newest stop, in place of any before it. A stop answered before is open again. */
  record(ask: TaskAsk): Promise<void>;
  /** The stop still waiting on a person, or null — none, or answered. */
  waiting(taskId: string): Promise<(TaskAsk & { askedAt: string }) | null>;
  /** The task's next run ended without stopping on a yes: the stop waiting from before is closed. */
  close(taskId: string): Promise<void>;
};

const SCOPE_KINDS: ReadonlySet<string> = new Set(["host", "file", "tool"]);

export function createTaskAsks(database: Database): TaskAsks {
  return {
    async record(ask) {
      const row = {
        runId: ask.runId,
        botId: ask.botId,
        rule: ask.rule,
        scopeKind: ask.scope.kind,
        scopeValue: ask.scope.value,
        subject: ask.subject,
        topic: ask.topic,
        askedAt: new Date(),
        grantedAt: null,
        grantedBy: null,
      };
      await database
        .insert(hubTaskAsks)
        .values({ taskId: ask.taskId, ...row })
        .onConflictDoUpdate({ target: hubTaskAsks.taskId, set: row });
    },

    async close(taskId) {
      // Only one still waiting: an answered one is the record of a yes somebody gave.
      await database
        .delete(hubTaskAsks)
        .where(
          and(eq(hubTaskAsks.taskId, taskId), isNull(hubTaskAsks.grantedAt)),
        );
    },

    async waiting(taskId) {
      const [row] = await database
        .select()
        .from(hubTaskAsks)
        .where(
          and(eq(hubTaskAsks.taskId, taskId), isNull(hubTaskAsks.grantedAt)),
        )
        .limit(1);
      // A stop with no subject was never recorded (`task-run.ts`); a row without one is not offered.
      if (!row?.subject || !SCOPE_KINDS.has(row.scopeKind)) return null;
      return {
        taskId: row.taskId,
        runId: row.runId,
        botId: row.botId,
        rule: row.rule,
        scope: {
          kind: row.scopeKind as AllowanceScope["kind"],
          value: row.scopeValue,
        },
        subject: row.subject,
        topic: row.topic,
        askedAt: row.askedAt.toISOString(),
      };
    },
  };
}

/** Whether this person may answer for the Bot: its owner, or the deployment's administrator. */
export async function ownsBot(
  database: Database,
  actor: AgentActor,
  botId: string,
): Promise<boolean> {
  if (actor.role === "admin") return true;
  const [owner] = await database
    .select({ ownerUserId: agentProfiles.ownerUserId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, botId))
    .limit(1);
  return owner?.ownerUserId === actor.id;
}

/** Why the button did nothing. The surface owns the words. */
export const TASK_ALLOW_CODES = {
  /** Nothing waits on a yes for this task: never stopped, or already answered. */
  nothingWaiting: "laf:task_nothing_waiting",
  /** The stop was this deployment's other Bot's, and this person does not own it. */
  notYours: "laf:task_not_yours",
} as const;

type BoardOutcome = "queued" | "not_blocked" | "not_yours" | "unreachable";

export type AllowTaskResult =
  | {
      ok: true;
      topic: string;
      allowance: string;
      /**
       * What became of the board: the task back in `todo`, or that move on its way through the
       * outbox (`queued`); a task a person had already moved (`not_blocked`); a task blocked since
       * by another member's 라피, whose yes it waits for now (`not_yours`); or a board that did not
       * take it and will not (`unreachable`: no hub, or the hub refused it).
       */
      board: BoardOutcome;
    }
  | { ok: false; code: string };

/**
 * The person's yes for one task: the allowance, its audit row, and the board told.
 *
 * Nothing in it comes from the request but the task's id and who is asking: the rule, the scope,
 * the subject and the topic are the stop's own (`hub_task_asks`), and the conversation it is bound
 * to is the task's (`task:<id>`).
 */
export async function allowForTask(
  deps: {
    database: Database;
    asks: TaskAsks;
    standing: StandingApprovalStore;
    auditStore?: AuditStore;
    hub?: { http: HubHttp; outbox: Pick<HubOutbox, "enqueue"> };
  },
  actor: AgentActor & { email?: string },
  taskId: string,
): Promise<AllowTaskResult> {
  const ask = await deps.asks.waiting(taskId);
  if (!ask) return { ok: false, code: TASK_ALLOW_CODES.nothingWaiting };
  if (!(await ownsBot(deps.database, actor, ask.botId))) {
    return { ok: false, code: TASK_ALLOW_CODES.notYours };
  }

  const granted = await deps.standing.grant({
    botId: ask.botId,
    rule: ask.rule,
    scope: ask.scope,
    subject: ask.subject,
    grantedBy: actor.id,
    tier: "board_task",
    threadId: taskThreadOf(taskId),
    taskId: ask.topic,
  });
  await deps.database
    .update(hubTaskAsks)
    .set({ grantedAt: new Date(), grantedBy: actor.id })
    .where(and(eq(hubTaskAsks.taskId, taskId), isNull(hubTaskAsks.grantedAt)));
  if (deps.auditStore) {
    await recordAuditEvent(deps.auditStore, {
      eventType: "approval.standing_granted",
      targetType: "bot",
      targetId: granted.botId,
      ...(actor.id === DEV_ACTOR.id ? {} : { actorUserId: actor.id }),
      payload: {
        bot: granted.botId,
        actor: actor.id,
        allowance: granted.id,
        rule: granted.rule,
        scope: granted.scope,
        scopeKind: granted.scopeKind,
        scopeValue: granted.scopeValue,
        tier: granted.tier,
        thread: granted.threadId,
        topic: ask.topic,
        boardTask: taskId,
        run: ask.runId,
        ...(granted.expiresAt ? { expiresAt: granted.expiresAt } : {}),
        ...(granted.subject ? { subject: granted.subject } : {}),
        grantedBy: granted.grantedBy,
      },
    }).catch(auditRowLost("approval.standing_granted"));
  }

  const board = deps.hub
    ? await tellTheBoard(deps.hub, taskId, ask.topic)
    : "unreachable";
  return { ok: true, topic: ask.topic, allowance: granted.id, board };
}

/**
 * The task back to waiting, with the member's one note (`POST /tasks/:id/approvals`). Never throws:
 * the yes already stands on this VM.
 *
 * Asked directly, once, so a task a person already moved on is said as such
 * (`laf:task_not_blocked`) and the person waits five seconds at most. A hub that does not answer
 * gets the same request through the outbox, which offers it until the hub takes it — UNDER THE SAME
 * KEY: a direct try the hub applied and whose answer was lost is answered again, not applied again
 * to a task that may have been blocked since on something else.
 */
async function tellTheBoard(
  hub: { http: HubHttp; outbox: Pick<HubOutbox, "enqueue"> },
  taskId: string,
  topic: string,
): Promise<BoardOutcome> {
  try {
    const request = {
      method: "POST" as const,
      path: HUB_TASK_APPROVAL_PATH(taskId),
      body: taskApprovalBody({ topic }),
      origin: "person" as const,
    };
    const idempotencyKey = `approval-${randomUUID()}`;
    const answer = await hub.http.request({
      ...request,
      idempotencyKey,
      retry: false,
    });
    if (answer.ok) return "queued";
    if (answer.code === HUB_TASK_NOT_BLOCKED) return "not_blocked";
    if (answer.code === HUB_TASK_NOT_YOURS) return "not_yours";
    if (answer.code === HUB_FACTS.unreachable) {
      await hub.outbox.enqueue({ ...request, idempotencyKey });
      return "queued";
    }
    log.warn("hub_task_allow_not_told", { task: taskId, code: answer.code });
    return "unreachable";
  } catch (error) {
    log.warn("hub_task_allow_not_told", {
      task: taskId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return "unreachable";
  }
}
