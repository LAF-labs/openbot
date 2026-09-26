import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { withOutboxWatch } from "../src/notifications/from-audit";
import type { NotificationOutbox } from "../src/notifications/outbox";
import { createDatabase } from "../src/db/client";
import {
  agents,
  lafRoutineRuns,
  lafRoutines,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createRoutineService } from "../src/routines/service";
import { createBotLane } from "../src/runner/bot-lane";
import { createWorkInFlight } from "../src/runner/in-flight";
import { createRunLedger } from "../src/runner/run-ledger";
import { TEST_POOL } from "./support/database";

/**
 * A routine stopped by `모두 멈추기`, and what its record says afterwards.
 *
 * A stop is not a failure, and the routine's whole failure path — the red line in the Bot's
 * conversation, the failure group, the `run.failed` notification — exists to tell somebody about a
 * run that went wrong behind their back. Pressing stop is the opposite of behind their back. So the
 * run is recorded as stopped everywhere it is recorded: the ledger (the roster clears, and the
 * conversation's failure reader draws nothing), the receipt (the routine's own history says 멈춤),
 * and the trail row, which says `stopped` and carries no failure code for the outbox to ring.
 *
 * And a routine that was waiting its turn behind the one that was stopped is stopped with it:
 * without that, "stop everything" ended one run and let the next one start a second later.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suffix = randomUUID().slice(0, 8);
const PERSON = { id: `routine-stop-${suffix}`, role: "user" as const };
const BOT_ID = `routine-stop-bot-${suffix}`;

beforeAll(async () => {
  await database.insert(users).values({
    id: PERSON.id,
    email: `${PERSON.id}@laf.test`,
    name: "루틴 멈춤 테스트",
  });
  await database.insert(agents).values({
    id: BOT_ID,
    name: "아침 비서",
    type: "remote_ag_ui",
    configuration: {},
  });
});

afterAll(async () => {
  // Only this file's rows: its routines, their receipts, its Bot's ledger rows, its person and Bot.
  const mine = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(eq(lafRoutines.createdById, PERSON.id));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, mine));
  await database
    .delete(lafRoutines)
    .where(eq(lafRoutines.createdById, PERSON.id));
  await database.delete(lafThreadRuns).where(eq(lafThreadRuns.agentId, BOT_ID));
  await database.delete(agents).where(eq(agents.id, BOT_ID));
  await database.delete(users).where(eq(users.id, PERSON.id));
  await database.$client.close();
});

/** A Bot still thinking until it is aborted, counting how often it was asked at all. */
function thinkingBot() {
  let asked = 0;
  let release: (() => void) | undefined;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent() {
      asked += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { result: undefined, newMessages: [] };
    },
    abortRun() {
      release?.();
    },
  };
  return { agent: agent as unknown as AbstractAgent, asked: () => asked };
}

async function until(ready: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

function harness(
  bot: AbstractAgent,
  lane = createBotLane(),
  /** False builds a service no stop can reach, so only the guards inside the run are exercised. */
  tracked = true,
) {
  const work = createWorkInFlight();
  const rows: AuditEventInput[] = [];
  const delivered: string[] = [];
  const marked: string[] = [];
  const service = createRoutineService({
    database,
    resolveAgents: async () => ({ [BOT_ID]: bot }),
    auditStore: { insert: async (row) => void rows.push(row) },
    ledger: createRunLedger(database),
    deliver: async (delivery) => {
      delivered.push(delivery.answer);
      return null;
    },
    deliverFailure: async (failure) => {
      marked.push(failure.routineName);
      return null;
    },
    tools: async () => ({ tools: [], execute: async () => ({ ok: true }) }),
    lane,
    ...(tracked ? { work } : {}),
  });
  return { service, work, rows, delivered, marked };
}

async function aRoutine(
  service: ReturnType<typeof harness>["service"],
  name: string,
) {
  return service.create(PERSON, {
    agentId: BOT_ID,
    name,
    instruction: "오늘 들어온 주문 정리해 줘",
    schedule: { kind: "interval", minutes: 60 },
  });
}

describe("a routine stopped by a person", () => {
  test("is listed as the person's work while it runs, and recorded as stopped — never as failed", async () => {
    const bot = thinkingBot();
    const { service, work, rows, delivered, marked } = harness(bot.agent);
    const routine = await aRoutine(service, "주문 정리");

    const running = service.runNow(PERSON, routine.id);
    await until(() => bot.asked() === 1, "the Bot to be asked");
    const going = work.of(PERSON.id);
    expect(going.map(({ kind, agentId }) => ({ kind, agentId }))).toEqual([
      { kind: "routine", agentId: BOT_ID },
    ]);

    expect(await going[0]?.stop()).toBe(true);
    await running;
    expect(work.of(PERSON.id)).toEqual([]);

    const [receipt] = await service.runs(PERSON, routine.id);
    expect(receipt).toMatchObject({ ok: false, error: "laf:run_stopped" });

    const ledger = await database
      .select({ status: lafThreadRuns.status, origin: lafThreadRuns.origin })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.agentId, BOT_ID));
    expect(ledger).toContainEqual({ status: "stopped", origin: "routine" });

    // No red line in the conversation and no answer delivered: nothing failed, nothing finished.
    expect(marked).toEqual([]);
    expect(delivered).toEqual([]);
    // The trail says stopped, with no failure code or group for the outbox to ring a bell over.
    const ran = rows.find((row) => row.eventType === "routine.ran");
    expect(ran?.payload).toMatchObject({ ok: false, stopped: true });
    expect(ran?.payload).not.toHaveProperty("failure");
    expect(ran?.payload).not.toHaveProperty("failureGroup");
  });

  test("one waiting its turn behind it is stopped with it, and its Bot is never asked", async () => {
    const lane = createBotLane();
    const bot = thinkingBot();
    const { service, work } = harness(bot.agent, lane);
    const first = await aRoutine(service, "첫 번째");
    const second = await aRoutine(service, "두 번째");

    const firstRun = service.runNow(PERSON, first.id);
    await until(() => bot.asked() === 1, "the first routine to be asked");
    // Queued on the same Bot's lane behind the first.
    const secondRun = service.runNow(PERSON, second.id);
    await until(() => work.of(PERSON.id).length === 2, "both to be listed");

    for (const entry of work.of(PERSON.id)) await entry.stop();
    await Promise.all([firstRun, secondRun]);

    expect(bot.asked()).toBe(1);
    const [secondReceipt] = await service.runs(PERSON, second.id);
    expect(secondReceipt).toMatchObject({
      ok: false,
      error: "laf:run_stopped",
    });
  });
});

/** A Bot that answers when it is let go, and says whether it was aborted instead. */
function answeringBot() {
  let asked = 0;
  let aborted = 0;
  const releases: Array<() => void> = [];
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      _input: unknown,
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) {
      asked += 1;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      agent.messages.push({
        id: randomUUID(),
        role: "assistant",
        content: "공급처에 발주 넣었어요.",
      } as Message);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [] };
    },
    abortRun() {
      aborted += 1;
      for (const release of releases.splice(0)) release();
    },
  };
  return {
    agent: agent as unknown as AbstractAgent,
    asked: () => asked,
    aborted: () => aborted,
    release: () => releases.shift()?.(),
  };
}

/** What the outbox watch makes of the trail rows: the only road from `routine.ran` to `run.failed`. */
async function notificationsFrom(rows: AuditEventInput[]) {
  const asked: string[] = [];
  const outbox = {
    enqueue: async (input: { kind: string }) => {
      asked.push(input.kind);
      return null;
    },
    offer: async (id: string) => {
      asked.push(`offer:${id}`);
      return null;
    },
  } as unknown as NotificationOutbox;
  const watched = withOutboxWatch({ insert: async () => undefined }, outbox);
  for (const row of rows) await watched.insert(row);
  return asked;
}

async function ledgerOf(runId: unknown) {
  const [row] = await database
    .select({ status: lafThreadRuns.status })
    .from(lafThreadRuns)
    .where(eq(lafThreadRuns.runId, String(runId)));
  return row?.status;
}

describe("a routine taken back while its run is out", () => {
  test("deleted while its Bot is working: the Bot is stopped, nothing is delivered, nobody is told it failed", async () => {
    const bot = answeringBot();
    const { service, rows, delivered, marked, work } = harness(bot.agent);
    const routine = await aRoutine(service, "발주");

    const running = service.runNow(PERSON, routine.id);
    await until(() => bot.asked() === 1, "the Bot to be asked");
    await service.remove(PERSON, routine.id);
    await running;

    expect(bot.aborted()).toBe(1);
    expect(work.of(PERSON.id)).toEqual([]);
    expect(delivered).toEqual([]);
    expect(marked).toEqual([]);
    const ran = rows.find((row) => row.eventType === "routine.ran");
    expect(ran?.payload).toMatchObject({
      ok: false,
      stopped: true,
      withdrawn: "gone",
    });
    expect(ran?.payload).not.toHaveProperty("failure");
    expect(await ledgerOf(ran?.payload.runId)).toBe("stopped");
    expect(await notificationsFrom(rows)).toEqual([]);
  });

  test("deleted mid-run where no stop reaches it: recorded as stopped, never as the model failing", async () => {
    // Before: the receipt failed its foreign key, the record rolled back, and the trail said
    // `failure: laf:turn_model_failed` — a run.failed notice for a routine the person had deleted.
    const bot = answeringBot();
    const { service, rows, delivered } = harness(
      bot.agent,
      createBotLane(),
      false,
    );
    const routine = await aRoutine(service, "발주");

    const running = service.runNow(PERSON, routine.id);
    await until(() => bot.asked() === 1, "the Bot to be asked");
    await service.remove(PERSON, routine.id);
    bot.release();
    await running;

    expect(bot.aborted()).toBe(0);
    // Its answer is for a routine nobody has any more.
    expect(delivered).toEqual([]);
    const ran = rows.find((row) => row.eventType === "routine.ran");
    expect(ran?.payload).toMatchObject({
      ok: false,
      stopped: true,
      withdrawn: "gone",
    });
    expect(ran?.payload).not.toHaveProperty("failure");
    expect(await ledgerOf(ran?.payload.runId)).toBe("stopped");
    expect(await notificationsFrom(rows)).toEqual([]);
  });

  test("switched off while queued behind another: its Bot is never asked, and its record says stopped", async () => {
    const bot = answeringBot();
    // Untracked, so what stops it is the read inside the lane and nothing else.
    const { service, rows } = harness(bot.agent, createBotLane(), false);
    const first = await aRoutine(service, "첫 번째");
    const second = await aRoutine(service, "두 번째");

    const firstRun = service.runNow(PERSON, first.id);
    await until(() => bot.asked() === 1, "the first routine to be asked");
    // The webhook, not Run now: an explicit Run now runs a routine that is switched off.
    const fired = await service.trigger(second.id, second.triggerToken);
    expect(fired.ran).toBe(true);
    await service.setEnabled(PERSON, second.id, false);
    bot.release();
    await firstRun;
    if (fired.ran) await fired.finished;

    expect(bot.asked()).toBe(1);
    const [receipt] = await service.runs(PERSON, second.id);
    expect(receipt).toMatchObject({ ok: false, error: "laf:run_stopped" });
    const ran = rows.find(
      (row) => row.eventType === "routine.ran" && row.targetId === second.id,
    );
    expect(ran?.payload).toMatchObject({
      ok: false,
      stopped: true,
      withdrawn: "off",
    });
    expect(await ledgerOf(ran?.payload.runId)).toBe("stopped");
    expect(await notificationsFrom(rows)).toEqual([]);
  });

  test("switched off while its Bot is working: stopped, the way 모두 멈추기 stops it", async () => {
    const bot = answeringBot();
    const { service, rows } = harness(bot.agent);
    const routine = await aRoutine(service, "주문 정리");

    const running = service.runNow(PERSON, routine.id);
    await until(() => bot.asked() === 1, "the Bot to be asked");
    await service.setEnabled(PERSON, routine.id, false);
    await running;

    expect(bot.aborted()).toBe(1);
    const [receipt] = await service.runs(PERSON, routine.id);
    expect(receipt).toMatchObject({ ok: false, error: "laf:run_stopped" });
    expect(
      rows.find((row) => row.eventType === "routine.ran")?.payload,
    ).toMatchObject({ ok: false, stopped: true });
  });

  test("Run now on a routine that is switched off still runs it: a person pressed the button", async () => {
    const bot = answeringBot();
    const { service, delivered } = harness(bot.agent);
    const routine = await aRoutine(service, "한 번만");
    await service.setEnabled(PERSON, routine.id, false);

    const running = service.runNow(PERSON, routine.id);
    await until(() => bot.asked() === 1, "the Bot to be asked");
    bot.release();
    await running;

    expect(delivered).toEqual(["공급처에 발주 넣었어요."]);
  });
});

