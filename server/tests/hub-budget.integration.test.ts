import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { classifyTurnFailure } from "../src/channels/turn-failures";
import { createDatabase } from "../src/db/client";
import {
  agents,
  hubOutbox,
  lafRoutineRuns,
  lafRoutines,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createRunBudget } from "../src/hub/budget";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import { createHubOutbox } from "../src/hub/outbox";
import { createRoutineService } from "../src/routines/service";
import { createRunLedger } from "../src/runner/run-ledger";
import { TEST_POOL } from "./support/database";

/**
 * A routine on a VM that belongs to a company, through the service that fires it on the clock: the
 * company's budget asked before the Bot is, and what the run cost told after through the real
 * outbox. The hub is a script; the Bot is a script that counts what it is asked.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const ledger = createRunLedger(database);
const suite = randomUUID().slice(0, 8);
const AUTHOR = { id: `hub-budget-author-${suite}`, role: "user" as const };
const BOT = `hub-budget-bot-${suite}`;
const outboxRows: string[] = [];

beforeAll(async () => {
  await database.insert(agents).values({
    id: BOT,
    name: "라피",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database
    .insert(users)
    .values({ id: AUTHOR.id, email: `${AUTHOR.id}@laf.test`, name: "사장님" });
});

afterAll(async () => {
  const mine = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(eq(lafRoutines.createdById, AUTHOR.id));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, mine));
  await database
    .delete(lafRoutines)
    .where(eq(lafRoutines.createdById, AUTHOR.id));
  await database.delete(lafThreadRuns).where(eq(lafThreadRuns.agentId, BOT));
  if (outboxRows.length > 0) {
    await database.delete(hubOutbox).where(inArray(hubOutbox.id, outboxRows));
  }
  await database.delete(users).where(eq(users.id, AUTHOR.id));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.$client.end();
});

/** A Bot that answers in one turn and reports what the turn cost; `asked` counts its model calls. */
function countingBot() {
  const asked = { count: 0 };
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
      asked.count += 1;
      subscriber?.onEvent?.({
        event: {
          type: "CUSTOM",
          name: "laf.model.usage",
          value: { model: "scripted", promptTokens: 12, costUsd: 0.0071234567 },
        },
      });
      const said: Message = {
        id: `s-${randomUUID()}`,
        role: "assistant",
        content: "밤사이 주문 3건이에요.",
      };
      agent.messages.push(said);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [said] };
    },
  };
  return { agent, asked };
}

/** A hub answering each request from the test's function, keeping what it was asked. */
function scriptedHub(answer: (request: HubRequest) => HubAnswer<unknown>) {
  const seen: HubRequest[] = [];
  const http: HubHttp = {
    async request(request) {
      seen.push(request);
      return answer(request) as never;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  return { http, seen };
}

const took: HubAnswer<unknown> = { ok: true, status: 200, body: { ok: true } };
const down: HubAnswer<unknown> = {
  ok: false,
  status: null,
  code: "laf:hub_unreachable",
};
const spent: HubAnswer<unknown> = {
  ok: false,
  status: 409,
  code: "laf:budget_reached",
};

/** One routine, made and fired once on the clock, with whatever budget the test hands. */
async function fireOnce(
  extra: Partial<Parameters<typeof createRoutineService>[0]>,
) {
  const bot = countingBot();
  const rows: AuditEventInput[] = [];
  let clock = new Date("2026-10-17T22:00:00Z");
  const service = createRoutineService({
    database,
    ledger,
    resolveAgents: async () => ({ [BOT]: bot.agent as never }),
    auditStore: { insert: async (event) => void rows.push(event) },
    tools: async () => ({ tools: [], execute: async () => ({ ok: true }) }),
    now: () => clock,
    runTimeoutMs: 10_000,
    ...extra,
  });
  const routine = await service.create(AUTHOR, {
    agentId: BOT,
    name: `주문 요약 ${randomUUID().slice(0, 4)}`,
    instruction: "밤사이 들어온 주문을 요약해줘",
    schedule: { kind: "interval", minutes: 30 },
  });
  if (!routine) throw new Error("the routine was not created");
  clock = new Date("2026-10-17T22:31:00Z");
  expect(await service.tick()).toBe(1);
  const ran = rows.find((row) => row.eventType === "routine.ran");
  const [run] = await database
    .select({ error: lafThreadRuns.error, status: lafThreadRuns.status })
    .from(lafThreadRuns)
    .where(eq(lafThreadRuns.label, routine.name));
  return { asked: bot.asked, ran, run, routine };
}

describe("a routine on a company's VM", () => {
  test("the company's day spent: the Bot is never asked, and the run ends on the fact", async () => {
    const hub = scriptedHub((request) =>
      request.path === "/budget/reserve" ? spent : took,
    );
    const outbox = createHubOutbox({ database, http: hub.http });
    const fired = await fireOnce({
      budget: createRunBudget({ http: hub.http, outbox }),
    });

    expect(fired.asked.count).toBe(0);
    expect(fired.ran?.payload).toMatchObject({ ok: false });
    expect(fired.run).toEqual({ error: "laf:budget_reached", status: "error" });
    // What the conversation's failure line reads it as, which the surface says in Korean.
    expect(classifyTurnFailure(fired.run?.error ?? null)).toBe(
      "laf:turn_company_budget_reached",
    );
    // Asked once; nothing reserved, so nothing settled.
    expect(hub.seen.map((request) => request.path)).toEqual([
      "/budget/reserve",
    ]);
  });

  test("with room, it reserves against the workspace and its sub-Bot, runs, and settles what it cost — after a hub that was down comes back", async () => {
    let up = true;
    const hub = scriptedHub(() => (up ? took : down));
    const outbox = createHubOutbox({
      database,
      http: hub.http,
      sleep: async () => undefined,
    });
    const budget = createRunBudget({ http: hub.http, outbox });
    const fired = await fireOnce({
      budget: {
        reserve: (input) => budget.reserve(input),
        // The hub goes away between the run's start and its end.
        settle: async (input) => {
          up = false;
          await budget.settle(input);
        },
      },
      jobOf: async () => "job_morning",
    });

    expect(fired.asked.count).toBe(1);
    expect(fired.run?.status).toBe("done");
    const [reserve] = hub.seen;
    expect(reserve).toMatchObject({
      method: "POST",
      path: "/budget/reserve",
      body: { scopes: ["workspace", "job:job_morning"], amount: 0.2 },
      retry: false,
    });
    const runId = String(
      (reserve?.body as { runId?: string } | undefined)?.runId,
    );

    // The settle is a row first; the hub did not take it, so the row is kept.
    const [row] = await database
      .select()
      .from(hubOutbox)
      .where(eq(hubOutbox.runId, runId));
    if (!row) throw new Error("the settle was not kept");
    outboxRows.push(row.id);
    await outbox.sweep();
    const [kept] = await database
      .select()
      .from(hubOutbox)
      .where(eq(hubOutbox.id, row.id));
    expect(kept?.deliveredAt).toBeNull();
    expect(kept?.body).toEqual({ runId, actual: 0.007123 });

    // Back: the same row, the same key, delivered.
    up = true;
    const swept = await outbox.sweep();
    expect(swept.delivered).toBe(1);
    const settles = hub.seen.filter(
      (request) => request.path === "/budget/settle",
    );
    expect(settles.at(-1)).toMatchObject({
      idempotencyKey: row.id,
      body: { runId, actual: 0.007123 },
      run: runId,
    });
  });

  test("a hub that does not answer the reservation does not stop the run: asked once, run, settled", async () => {
    const hub = scriptedHub((request) =>
      request.path === "/budget/reserve" ? down : took,
    );
    const outbox = createHubOutbox({ database, http: hub.http });
    const fired = await fireOnce({
      budget: createRunBudget({ http: hub.http, outbox }),
    });
    expect(fired.asked.count).toBe(1);
    expect(fired.run?.status).toBe("done");
    expect(
      hub.seen.filter((request) => request.path === "/budget/reserve"),
    ).toHaveLength(1);
    const runId = String(
      (hub.seen[0]?.body as { runId?: string } | undefined)?.runId,
    );
    const [row] = await database
      .select()
      .from(hubOutbox)
      .where(eq(hubOutbox.runId, runId));
    if (row) outboxRows.push(row.id);
    // Offered the moment it was written; the sweep it started is the one awaited here.
    await outbox.sweep();
    const settled = hub.seen.find(
      (request) => request.path === "/budget/settle",
    );
    expect(settled?.body).toMatchObject({ actual: 0.007123 });
  });

  test("not attached to a company: runs as it always did", async () => {
    const fired = await fireOnce({});
    expect(fired.asked.count).toBe(1);
    expect(fired.run).toEqual({ error: null, status: "done" });
    expect(fired.ran?.payload).toMatchObject({ ok: true });
  });
});
