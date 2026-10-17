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
 * WHAT THE HUB HEARS. The task goes back to `todo` with one note from the member:
 * `laf:task_approval_granted topic:<topic>` — who (the note's author, `m:<member>`), what (the
 * topic, the same facts the stop's note already put on the board), when (the note's time). No value,
 * no rule, no page. Through the outbox, so a hub that is away hears it when it is back; with the
 * version just read, so a person's edit made in between wins and the note is not forced over it.
 */
import { and, eq, isNull } from "drizzle-orm";
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
  HUB_TASK_PATHS,
  readTaskDetail,
  taskApprovalGrantedBody,
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

export type AllowTaskResult =
  | {
      ok: true;
      topic: string;
      allowance: string;
      /**
       * What became of the board: the move on its way through the outbox (`queued`), a task a
       * person had already moved (`not_blocked`), or a hub that could not be read (`unreachable`).
       */
      board: "queued" | "not_blocked" | "unreachable";
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

/** The task back to waiting, with the member's one note. Never throws: the yes already stands. */
async function tellTheBoard(
  hub: { http: HubHttp; outbox: Pick<HubOutbox, "enqueue"> },
  taskId: string,
  topic: string,
): Promise<"queued" | "not_blocked" | "unreachable"> {
  try {
    const read = await hub.http.request({
      path: HUB_TASK_PATHS.task(taskId),
      retry: false,
    });
    const detail = read.ok ? readTaskDetail(read.body) : null;
    if (!detail) return "unreachable";
    // A person moved it already — to `todo`, to `done` — and that is theirs to have decided.
    if (detail.task.stage !== "blocked") return "not_blocked";
    await hub.outbox.enqueue({
      method: "PATCH",
      path: HUB_TASK_PATHS.move(taskId),
      body: taskApprovalGrantedBody({ version: detail.task.version, topic }),
      origin: "person",
    });
    return "queued";
  } catch (error) {
    log.warn("hub_task_allow_not_told", {
      task: taskId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return "unreachable";
  }
}
