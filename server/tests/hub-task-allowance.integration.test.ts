import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message, Tool } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { classifyTurnFailure } from "../src/channels/turn-failures";
import {
  type AskSubject,
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";
import type { ActionPolicy, PolicyDecision } from "../src/computer/policy";
import { settle } from "../src/computer/settle";
import {
  allowanceFor,
  createDatabaseStandingApprovalStore,
} from "../src/computer/standing-approvals";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  hubTaskAsks,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createRunBudget } from "../src/hub/budget";
import { createHubRoutes } from "../src/hub/routes";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import type { HubOutboxWrite } from "../src/hub/outbox";
import { allowForTask, createTaskAsks } from "../src/hub/task-asks";
import { createTaskPickup } from "../src/hub/task-pickup";
import { createTaskRun, taskThreadOf } from "../src/hub/task-run";
import { createRunLedger } from "../src/runner/run-ledger";
import type { LoopAgent, UnattendedToolkit } from "../src/runner/unattended";
import { fakeTaskHub } from "./support/fake-task-hub";
import { TEST_POOL } from "./support/database";

/**
 * THE ACCEPTANCE, against a real Postgres: a company board's tasks given to this member's 라피, run
 * by a scripted Bot through the real boundary step (`settle.ts`) with the real database allowance
 * store, on an in-memory hub that keeps #253's rules.
 *
 * - A task's run reaches an action the rule asks about: nobody is there, so it stops and the task
 *   is `blocked` with the topic.
 * - Its person says "이 일감에서는 해도 돼" (`allowForTask`): the allowance is made from the stop's own
 *   record, the board is told, and the next pickup of that task goes past the action and finishes.
 * - A sibling task meeting the same topic still stops: the yes was for one task.
 * - The company's day spent: a task's run never asks the model.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const ledger = createRunLedger(database);
const standing = createDatabaseStandingApprovalStore(database);
const asks = createTaskAsks(database);
const made = {
  people: [] as string[],
  bots: [] as string[],
  threads: [] as string[],
  tasks: [] as string[],
};

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, made.threads));
  await database
    .delete(lafThreadRuns)
    .where(inArray(lafThreadRuns.threadId, made.threads));
  await database
    .delete(hubTaskAsks)
    .where(inArray(hubTaskAsks.taskId, made.tasks));
  const owned = await database
    .select({ channelId: channelThreads.channelId })
    .from(channelThreads)
    .where(inArray(channelThreads.threadId, made.threads));
  if (owned.length > 0) {
    await database.delete(channels).where(
      inArray(
        channels.id,
        owned.map((row) => row.channelId),
      ),
    );
  }
  // The allowances cascade with the Bot.
  await database.delete(agents).where(inArray(agents.id, made.bots));
  await database.delete(users).where(inArray(users.id, made.people));
  await database.$client.close();
});

async function person() {
  const id = `u_allow_${randomUUID()}`;
  const bot = `agent_allow_${randomUUID()}`;
  made.people.push(id);
  made.bots.push(bot);
  await database.insert(users).values({
    id,
    email: `${id}@laf.test`,
    name: "기범",
    emailVerified: true,
  });
  await database.insert(agents).values({
    id: bot,
    name: "라피",
    type: "remote_ag_ui",
    configuration: { endpoint: "https://bot.example.test/ag-ui" },
  });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: id,
    roleDescription: "",
    avatarSeed: "seed",
  });
  return { actor: { id, role: "user" as const }, botId: bot };
}

function taskId() {
  const id = `t_${randomUUID()}`;
  made.tasks.push(id);
  made.threads.push(taskThreadOf(id));
  return id;
}

const RULE = 'contains(element.name, "주문")';
const ASKED: PolicyDecision = {
  allowed: false,
  matched: RULE,
  source: "ask",
  forward: false,
};
const POLICY: ActionPolicy = { deny: [], ask: [RULE], allow: ["true"] };
const ORDER: AskSubject = {
  kind: "browser",
  intent: "activate",
  host: "shop.example.test",
  path: "/order",
  element: { role: "button", name: "주문하기" },
  reason: "policy_ask",
};
const SCOPE = allowanceFor({
  tool: "computer_click",
  host: "shop.example.test",
});
const TOOLS: Tool[] = [
  {
    name: "computer_click",
    description: "click",
    parameters: { type: "object", properties: {} },
  },
];

/**
 * The browser's press, judged the way the gateway judges one (`gateway/govern.ts`): the real settle
 * step, with the run's own actor — so whatever the task's run names itself as is what the boundary
 * reads — and a question nobody is there to answer turned into the outcome the unattended toolkit
 * gives (`outcomeOfError`).
 */
function boundaryTools(pressed: string[]) {
  const approvals = createApprovalRegistry();
  return async (
    botId: string,
    actor: { id: string; runId?: string; boardTaskThreadId?: string },
  ): Promise<UnattendedToolkit> => ({
    tools: TOOLS,
    execute: async () => {
      const settled = await settle(
        {
          botId,
          actorId: actor.id,
          subject: ORDER,
          action: "computer_click",
          fingerprint: fingerprintOf({
            botId,
            toolName: "computer_click",
            ref: "e3",
            pageUrl: "https://shop.example.test/order",
          }),
          allowance: SCOPE,
          rule: RULE,
          target: { type: "computer", id: botId },
          ...(actor.runId ? { runId: actor.runId } : {}),
          ...(actor.boardTaskThreadId
            ? { boardTaskThreadId: actor.boardTaskThreadId }
            : {}),
          policyVerdict: ASKED,
        },
        { policy: () => POLICY, approvals, standing },
      );
      if (settled.outcome === "allowed") {
        pressed.push(actor.boardTaskThreadId ?? "");
        return { ok: true };
      }
      if (settled.outcome === "asked") {
        return {
          ok: false,
          awaitingApproval: true,
          approvalId: settled.approvalId,
          subject: settled.approval.subject,
          rule: settled.approval.rule,
          scope: settled.approval.scope,
          code: "laf:nobody_answered",
        };
      }
      return { ok: false, code: settled.code };
    },
  });
}

/** A fresh scripted Bot per run: press the order button, then say it is done. Counts model calls. */
function scriptedBots(botId: string, calls: { count: number }) {
  return async () => {
    let turn = 0;
    const agent = {
      messages: [] as Message[],
      threadId: undefined as string | undefined,
      setMessages(messages: Message[]) {
        agent.messages = [...messages];
      },
      addMessage(message: Message) {
        agent.messages.push(message);
      },
      async runAgent(
        _parameters?: unknown,
        subscriber?: {
          onEvent?: (input: { event: unknown }) => unknown;
          onRunFinishedEvent?: () => unknown;
        },
      ) {
        calls.count += 1;
        turn += 1;
        subscriber?.onEvent?.({
          event: {
            type: "CUSTOM",
            name: "laf.model.usage",
            value: { model: "scripted", promptTokens: 10, costUsd: 0.0125 },
          },
        });
        const said: Message[] =
          turn === 1
            ? [
                {
                  id: `a-${randomUUID()}`,
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    {
                      id: `c-${randomUUID()}`,
                      type: "function",
                      function: { name: "computer_click", arguments: "{}" },
                    },
                  ],
                },
              ]
            : [
                {
                  id: `s-${randomUUID()}`,
                  role: "assistant",
                  content: "주문을 넣었어요.",
                },
              ];
        agent.messages.push(...said);
        subscriber?.onRunFinishedEvent?.();
        return { result: undefined, newMessages: said };
      },
    };
    return {
      [botId]: agent as unknown as LoopAgent & { threadId?: string },
    };
  };
}

/** The outbox, delivering at once — the real one's row and retries are `hub-budget`'s to prove. */
function directOutbox(http: HubHttp) {
  const sent: HubOutboxWrite[] = [];
  return {
    sent,
    async enqueue(write: HubOutboxWrite) {
      sent.push(write);
      await http.request({
        method: write.method,
        path: write.path,
        ...(write.body ? { body: write.body } : {}),
        origin: write.origin,
      });
      return randomUUID();
    },
  };
}

const ME = "m_me";

describe("a board task stopped for a yes, and the yes for that task only", () => {
  test("approved, the next pickup finishes it; a sibling with the same topic still stops", async () => {
    const who = await person();
    const hub = fakeTaskHub();
    const http = hub.as(ME);
    const outbox = directOutbox(http);
    // The ledger's routes, answered "yes, there is room" — the budget's own refusals are below.
    const reserved: unknown[] = [];
    hub.intercepting((request: HubRequest) => {
      if (request.path === "/budget/reserve") {
        reserved.push(request.body);
        return {
          ok: true,
          status: 200,
          body: { ok: true },
        } as HubAnswer<never>;
      }
      if (request.path === "/budget/settle") {
        return {
          ok: true,
          status: 200,
          body: { ok: true },
        } as HubAnswer<never>;
      }
      return undefined;
    });
    const calls = { count: 0 };
    const pressed: string[] = [];
    const pickup = createTaskPickup({
      http,
      memberId: () => ME,
      run: createTaskRun({
        database,
        ledger,
        owner: async () => who,
        resolveAgents: scriptedBots(who.botId, calls),
        tools: boundaryTools(pressed) as never,
        asks,
        budget: createRunBudget({ http, outbox }),
      }),
    });

    const first = taskId();
    hub.add({ id: first, assignee: `bot:${ME}`, title: "재고 주문 넣어줘" });
    await pickup.scan();

    const stopped = hub.tasks.get(first);
    expect(stopped?.stage).toBe("blocked");
    expect(stopped?.notes.at(-1)?.text).toMatch(
      /^laf:task_needs_approval run:\S+ topic:browser\/activate@shop\.example\.test$/,
    );
    expect(pressed).toEqual([]);
    // The stop was kept on this VM with its rule and scope, for the button.
    const waiting = await asks.waiting(first);
    expect(waiting).toMatchObject({
      rule: RULE,
      scope: SCOPE,
      topic: "browser/activate@shop.example.test",
      botId: who.botId,
    });

    // The person's yes, on their own VM: the allowance, and the board told (`POST …/approvals`).
    const allowed = await allowForTask(
      { database, asks, standing, hub: { http, outbox } },
      who.actor,
      first,
    );
    expect(allowed).toMatchObject({
      ok: true,
      topic: "browser/activate@shop.example.test",
      board: "queued",
    });
    expect(hub.tasks.get(first)?.stage).toBe("todo");
    expect(
      hub.requests.filter((request) => request.path.endsWith("/approvals")),
    ).toMatchObject([
      {
        method: "POST",
        path: `/tasks/${first}/approvals`,
        body: { topic: "browser/activate@shop.example.test" },
        origin: "person",
        as: ME,
      },
    ]);
    expect(hub.tasks.get(first)?.notes.at(-1)).toEqual({
      by: `m:${ME}`,
      text: "laf:task_approval_granted topic:browser/activate@shop.example.test",
      runId: null,
    });
    // Nothing more waits on it: pressing again does nothing.
    expect(await asks.waiting(first)).toBeNull();

    // The next pickup goes past the press, and the Bot finishes: `review`.
    pickup.heard({ type: "task.changed", refId: first });
    await pickup.idle();
    expect(pressed).toEqual([taskThreadOf(first)]);
    expect(hub.tasks.get(first)?.stage).toBe("review");
    expect(hub.tasks.get(first)?.notes.at(-1)?.text).toMatch(
      /^laf:task_ran run:\S+ steps:\d+$/,
    );

    // A sibling task, the same button on the same site: asked again, blocked again.
    const sibling = taskId();
    hub.add({
      id: sibling,
      assignee: `bot:${ME}`,
      title: "다른 주문도 넣어줘",
    });
    pickup.heard({ type: "task.assigned", refId: sibling });
    await pickup.idle();
    expect(hub.tasks.get(sibling)?.stage).toBe("blocked");
    expect(hub.tasks.get(sibling)?.notes.at(-1)?.text).toContain(
      "topic:browser/activate@shop.example.test",
    );
    expect(pressed).toEqual([taskThreadOf(first)]);

    // Every run reserved against the workspace and its own task, and settled what it cost.
    expect(reserved).toHaveLength(3);
    expect(reserved[0]).toMatchObject({
      scopes: ["workspace", `task:${first}`],
      amount: 0.2,
    });
    const settles = outbox.sent.filter(
      (write) => write.path === "/budget/settle",
    );
    expect(settles).toHaveLength(3);
    // Two model turns at $0.0125 each run: the press, then the answer (a stopped run is told the
    // press waits on a person, and answers that).
    expect(settles.map((write) => write.body?.actual)).toEqual([
      0.025, 0.025, 0.025,
    ]);
  });

  test("a stop nobody answered closes when the task's next run ends some other way: the old button grants nothing", async () => {
    const who = await person();
    const hub = fakeTaskHub();
    const http = hub.as(ME);
    const outbox = directOutbox(http);
    // The first run meets the boundary and stops; the next one's page no longer asks (a person
    // did it by hand, say), and finishes.
    let pageAsks = true;
    const pickup = createTaskPickup({
      http,
      memberId: () => ME,
      run: createTaskRun({
        database,
        ledger,
        owner: async () => who,
        resolveAgents: scriptedBots(who.botId, { count: 0 }),
        tools: (async (botId: string, actor: { id: string }) =>
          pageAsks
            ? boundaryTools([])(botId, actor)
            : { tools: TOOLS, execute: async () => ({ ok: true }) }) as never,
        asks,
      }),
    });
    const id = taskId();
    hub.add({ id, assignee: `bot:${ME}`, title: "재고 주문 넣어줘" });
    await pickup.scan();
    expect(hub.tasks.get(id)?.stage).toBe("blocked");
    expect(await asks.waiting(id)).toMatchObject({
      topic: "browser/activate@shop.example.test",
    });

    // A person moves it back to to-do on the board themselves; its next run finishes.
    pageAsks = false;
    const blocked = hub.tasks.get(id);
    await hub.as("m_person").request({
      method: "PATCH",
      path: `/tasks/${id}`,
      body: { version: blocked?.version, stage: "todo" },
    });
    pickup.heard({ type: "task.changed", refId: id });
    await pickup.idle();
    expect(hub.tasks.get(id)?.stage).toBe("review");

    // Nothing waits any more: the old button grants no allowance and tells the board nothing.
    expect(await asks.waiting(id)).toBeNull();
    const pressed = await allowForTask(
      { database, asks, standing, hub: { http, outbox } },
      who.actor,
      id,
    );
    expect(pressed).toEqual({ ok: false, code: "laf:task_nothing_waiting" });
    expect(await standing.list(who.botId)).toEqual([]);
    expect(
      hub.requests.filter((request) => request.path.endsWith("/approvals")),
    ).toEqual([]);
    expect(hub.tasks.get(id)?.stage).toBe("review");
  });

  test("the company's day spent: the task's run never asks the model, and says why", async () => {
    const who = await person();
    const hub = fakeTaskHub();
    const http = hub.as(ME);
    const outbox = directOutbox(http);
    hub.intercepting((request: HubRequest) =>
      request.path === "/budget/reserve"
        ? ({
            ok: false,
            status: 409,
            code: "laf:budget_reached",
          } as HubAnswer<never>)
        : undefined,
    );
    const calls = { count: 0 };
    const pickup = createTaskPickup({
      http,
      memberId: () => ME,
      run: createTaskRun({
        database,
        ledger,
        owner: async () => who,
        resolveAgents: scriptedBots(who.botId, calls),
        tools: boundaryTools([]) as never,
        asks,
        budget: createRunBudget({ http, outbox }),
      }),
    });
    const id = taskId();
    hub.add({ id, assignee: `bot:${ME}` });
    await pickup.scan();

    expect(calls.count).toBe(0);
    expect(hub.tasks.get(id)?.stage).toBe("blocked");
    expect(hub.tasks.get(id)?.notes.at(-1)?.text).toMatch(
      /^laf:task_run_failed run:\S+ code:laf:budget_reached$/,
    );
    // Nothing reserved, nothing spent: no settle.
    expect(
      outbox.sent.filter((write) => write.path === "/budget/settle"),
    ).toEqual([]);
    // The task's conversation holds the run, ended on the fact the surface says in Korean.
    const [run] = await database
      .select({ error: lafThreadRuns.error, status: lafThreadRuns.status })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, taskThreadOf(id)));
    expect(run).toEqual({ error: "laf:budget_reached", status: "error" });
    expect(classifyTurnFailure(run?.error ?? null)).toBe(
      "laf:turn_company_budget_reached",
    );
  });

  test("a task a person already moved on is said as such; a hub that is away gets the yes later", async () => {
    const who = await person();
    const stop = (id: string) =>
      asks.record({
        taskId: id,
        runId: randomUUID(),
        botId: who.botId,
        rule: RULE,
        scope: SCOPE,
        subject: ORDER,
        topic: "browser/activate@shop.example.test",
      });
    const hub = fakeTaskHub();
    const http = hub.as(ME);
    const outbox = directOutbox(http);

    const moved = taskId();
    hub.add({ id: moved, assignee: `bot:${ME}`, stage: "review" });
    await stop(moved);
    expect(
      await allowForTask(
        { database, asks, standing, hub: { http, outbox } },
        who.actor,
        moved,
      ),
    ).toMatchObject({ ok: true, board: "not_blocked" });
    expect(hub.tasks.get(moved)?.stage).toBe("review");
    expect(outbox.sent).toEqual([]);

    const away = taskId();
    hub.add({
      id: away,
      assignee: `bot:${ME}`,
      stage: "blocked",
      blockedBy: ME,
    });
    await stop(away);
    let up = false;
    hub.intercepting(() =>
      up
        ? undefined
        : ({
            ok: false,
            status: null,
            code: "laf:hub_unreachable",
          } as HubAnswer<never>),
    );
    const queued = directOutbox({
      request: async (request) => {
        up = true;
        return http.request(request);
      },
      socket: http.socket,
    });
    expect(
      await allowForTask(
        { database, asks, standing, hub: { http, outbox: queued } },
        who.actor,
        away,
      ),
    ).toMatchObject({ ok: true, board: "queued" });
    expect(queued.sent).toMatchObject([
      {
        method: "POST",
        path: `/tasks/${away}/approvals`,
        body: { topic: "browser/activate@shop.example.test" },
      },
    ]);
    expect(hub.tasks.get(away)?.stage).toBe("todo");
  });

  test("a yes the hub applied but never answered is not applied again by the outbox's copy", async () => {
    const who = await person();
    const hub = fakeTaskHub();
    const board = hub.as(ME);
    // The hub's idempotency (`hub/src/idempotency.ts`): one key, one write, its answer replayed.
    const answered = new Map<string, HubAnswer<unknown>>();
    const once: HubHttp = {
      async request<T>(request: HubRequest) {
        const key = request.idempotencyKey;
        const kept = key ? answered.get(key) : undefined;
        if (kept) return kept as HubAnswer<T>;
        const answer = await board.request<T>(request);
        if (key) answered.set(key, answer);
        return answer;
      },
      socket: board.socket,
    };
    const id = taskId();
    hub.add({ id, assignee: `bot:${ME}`, stage: "blocked", blockedBy: ME });
    await asks.record({
      taskId: id,
      runId: randomUUID(),
      botId: who.botId,
      rule: RULE,
      scope: SCOPE,
      subject: ORDER,
      topic: "browser/activate@shop.example.test",
    });
    // The direct try lands and the answer is lost (the hub hangs past the timeout). In the
    // meantime the task runs again and blocks on something else.
    const direct: HubRequest[] = [];
    const hanging: HubHttp = {
      async request<T>(request: HubRequest) {
        direct.push(request);
        await once.request(request);
        const task = hub.tasks.get(id);
        if (task) {
          task.stage = "blocked";
          task.blockedBy = ME;
          task.notes.push({
            by: `bot:${ME}`,
            text: "laf:task_needs_approval run:r2 topic:browser/type@bank.example.test",
            runId: "r2",
          });
        }
        return {
          ok: false,
          status: null,
          code: "laf:hub_unreachable",
        } as HubAnswer<T>;
      },
      socket: board.socket,
    };
    // The outbox's copy, sent under the key its row carries — the given one, or a new one.
    const outbox = {
      sent: [] as HubOutboxWrite[],
      async enqueue(write: HubOutboxWrite) {
        outbox.sent.push(write);
        await once.request({
          method: write.method,
          path: write.path,
          ...(write.body ? { body: write.body } : {}),
          idempotencyKey: write.idempotencyKey ?? randomUUID(),
        });
        return randomUUID();
      },
    };
    expect(
      await allowForTask(
        { database, asks, standing, hub: { http: hanging, outbox } },
        who.actor,
        id,
      ),
    ).toMatchObject({ ok: true, board: "queued" });
    // Asked once, and the person waited one attempt at most.
    expect(direct).toHaveLength(1);
    expect(direct[0]?.retry).toBe(false);
    // The copy is the same write: the task blocked since stays blocked, its newest note its own.
    expect(outbox.sent[0]?.idempotencyKey).toBe(direct[0]?.idempotencyKey);
    expect(hub.tasks.get(id)?.stage).toBe("blocked");
    expect(hub.tasks.get(id)?.notes.at(-1)?.text).toContain(
      "topic:browser/type@bank.example.test",
    );
  });

  test("a task another member's 라피 blocked since is said as such, and not sent again", async () => {
    const who = await person();
    const hub = fakeTaskHub();
    const http = hub.as(ME);
    const outbox = directOutbox(http);
    const id = taskId();
    hub.add({
      id,
      assignee: "bot:m_other",
      stage: "blocked",
      blockedBy: "m_other",
    });
    await asks.record({
      taskId: id,
      runId: randomUUID(),
      botId: who.botId,
      rule: RULE,
      scope: SCOPE,
      subject: ORDER,
      topic: "browser/activate@shop.example.test",
    });
    expect(
      await allowForTask(
        { database, asks, standing, hub: { http, outbox } },
        who.actor,
        id,
      ),
    ).toMatchObject({ ok: true, board: "not_yours" });
    expect(hub.tasks.get(id)?.stage).toBe("blocked");
    expect(outbox.sent).toEqual([]);
  });

  test("somebody who does not own the Bot cannot say yes for it", async () => {
    const who = await person();
    const other = await person();
    const id = taskId();
    await asks.record({
      taskId: id,
      runId: randomUUID(),
      botId: who.botId,
      rule: RULE,
      scope: SCOPE,
      subject: ORDER,
      topic: "browser/activate@shop.example.test",
    });
    // The screen's read: the owner is told what waits; anybody else is told nothing waits.
    const read = async (actor: { id: string; role: "user" }) => {
      const doors = new Hono<{ Variables: AppVariables }>();
      doors.route(
        "/",
        createHubRoutes(
          undefined,
          async (context, next) => {
            context.set("actor", { ...actor, email: `${actor.id}@laf.test` });
            await next();
          },
          { tasks: { database, asks, standing } },
        ),
      );
      return (await doors.request(`/tasks/${id}/allowance`)).json();
    };
    expect(await read(who.actor)).toMatchObject({
      waiting: { topic: "browser/activate@shop.example.test" },
    });
    expect(await read(other.actor)).toEqual({ waiting: null });
    const bare = new Hono<{ Variables: AppVariables }>();
    bare.route(
      "/",
      createHubRoutes(undefined, async (_context, next) => next()),
    );
    expect((await bare.request(`/tasks/${id}/allowance`)).status).toBe(404);

    const refused = await allowForTask(
      { database, asks, standing },
      other.actor,
      id,
    );
    expect(refused).toEqual({ ok: false, code: "laf:task_not_yours" });
    expect(await standing.list(who.botId)).toEqual([]);
    const owned = await allowForTask(
      { database, asks, standing },
      who.actor,
      id,
    );
    expect(owned).toMatchObject({ ok: true, board: "unreachable" });
    const [row] = await standing.list(who.botId);
    expect(row).toMatchObject({
      tier: "board_task",
      threadId: taskThreadOf(id),
      taskId: "browser/activate@shop.example.test",
      grantedBy: who.actor.id,
    });
  });
});
