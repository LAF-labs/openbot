import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AbstractAgent } from "@ag-ui/client";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  lafNotifications,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createNotificationOutbox } from "../src/notifications/outbox";
import {
  appendToSoloConversation,
  createRoutineFailureDelivery,
} from "../src/routines/deliver";
import { createRoutineService } from "../src/routines/service";
import {
  LafPostgresRunner,
  reportInterruptedRuns,
} from "../src/runner/laf-runner";
import { createRunLedger } from "../src/runner/run-ledger";
import { messagesFor } from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * A routine's run is one record: killed at any instant, a restart finds a truthful state.
 *
 * Audit A1-1 (2026-09-10) killed the real service with SIGKILL the moment the answer had been
 * delivered and booted over the same database:
 *
 *   | after | messages                          | ledger  | receipts | trail | told          |
 *   | kill  | the answer                        | running | 0        | 0     | —             |
 *   | boot  | the answer + a failure mark under | unknown | 0        | 0     | run.failed    |
 *
 * — a 07:30 briefing that had arrived, reported as interrupted, red line and all. These kill a
 * real process (`support/routine-run-child.ts`) at the same seam and after the settlement, boot
 * the way `main.ts` does, and read every table the audit read.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("routine-settlement-kill-test"),
);
const ledger = createRunLedger(database);

const prefix = `settle-${randomUUID().slice(0, 8)}`;
const made = {
  users: [] as string[],
  agents: [] as string[],
  threads: [] as string[],
  channels: [] as string[],
};

afterEach(async () => {
  if (made.users.length > 0) {
    const theirs = database
      .select({ id: lafRoutines.id })
      .from(lafRoutines)
      .where(inArray(lafRoutines.createdById, made.users));
    await database
      .delete(lafRoutineRuns)
      .where(inArray(lafRoutineRuns.routineId, theirs));
    await database
      .delete(lafRoutines)
      .where(inArray(lafRoutines.createdById, made.users));
    await database
      .delete(lafNotifications)
      .where(inArray(lafNotifications.userId, made.users));
  }
  if (made.agents.length > 0) {
    await database
      .delete(lafThreadRuns)
      .where(inArray(lafThreadRuns.agentId, made.agents));
  }
  if (made.threads.length > 0) {
    await database
      .delete(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, made.threads));
  }
  if (made.channels.length > 0) {
    await database.delete(channels).where(inArray(channels.id, made.channels));
  }
  if (made.agents.length > 0) {
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, made.agents));
    await database.delete(agents).where(inArray(agents.id, made.agents));
  }
  if (made.users.length > 0) {
    await database.delete(users).where(inArray(users.id, made.users));
  }
  for (const list of Object.values(made)) list.splice(0);
});

afterAll(async () => {
  await database.$client.close();
});

const ANSWER = "**아침 보고** 오늘 할 일: 재고 확인, 리뷰 두 건 답장.";

/** A person, their Bot, their one conversation, and a routine on it. */
async function morningRoutine() {
  const id = `${prefix}-user-${randomUUID().slice(0, 8)}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Settle Tester" });
  made.users.push(id);
  const owner: AgentActor = { id, role: "user" };
  const profile = await profileStore.create(owner, {
    name: "아침봇",
    roleDescription: "Reports every morning.",
  });
  made.agents.push(profile.id);
  const channel = await channelStore.create(owner, [profile.id]);
  made.channels.push(channel.id);
  const [mapping] = await database
    .select({ threadId: channelThreads.threadId })
    .from(channelThreads)
    .where(eq(channelThreads.channelId, channel.id));
  if (!mapping) throw new Error("the conversation has no thread");
  made.threads.push(mapping.threadId);
  const routine = await createRoutineService({
    database,
    resolveAgents: async () => ({}),
  }).create(owner, {
    agentId: profile.id,
    name: "아침 보고",
    instruction: "오늘 할 일을 정리해 줘",
    schedule: { kind: "interval", minutes: 30 },
  });
  if (!routine) throw new Error("the routine was not created");
  return {
    owner,
    botId: profile.id,
    threadId: mapping.threadId,
    routineId: routine.id,
  };
}

/** Runs the routine in a process of its own and kills it where it is told to. */
async function runAndKill(
  fixture: Awaited<ReturnType<typeof morningRoutine>>,
  at: "delivered" | "committed",
) {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/routine-run-child.ts")],
    {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ROUTINE_ID: fixture.routineId,
        OWNER_ID: fixture.owner.id,
        BOT_ID: fixture.botId,
        ANSWER,
        KILL_AT: at,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const exit = await child.exited;
  const stderr = await new Response(child.stderr).text();
  // Killed, not finished: exit 3 would mean the seam was never reached and nothing was measured.
  expect({ exit, signal: child.signalCode, stderr: stderr.trim() }).toEqual({
    exit: 137,
    signal: "SIGKILL",
    stderr: "",
  });
}

/** Boot, as `main.ts` does it: reconcile the ledger, then tell the people it concerns. */
async function boot(botId: string) {
  const runner = await LafPostgresRunner.create(database, ledger);
  const told: string[] = [];
  const outbox = createNotificationOutbox({
    database,
    adapters: [
      {
        name: "watch",
        deliver: async (record) => {
          if (record.botId === botId) told.push(record.kind);
          return true;
        },
      },
    ],
    log: () => {},
  });
  await reportInterruptedRuns({
    database,
    runs: runner.interruptedAtBoot().filter((run) => run.agentId === botId),
    outbox,
    markRoutine: createRoutineFailureDelivery(database),
  });
  return told;
}

/** Every table the audit read, for one routine. */
async function ledgerOf(fixture: Awaited<ReturnType<typeof morningRoutine>>) {
  const messages = (await messagesFor(database, fixture.threadId)).map(
    (message) => String((message as { content?: unknown }).content ?? ""),
  );
  const runs = await database
    .select({ status: lafThreadRuns.status })
    .from(lafThreadRuns)
    .where(
      and(
        eq(lafThreadRuns.agentId, fixture.botId),
        eq(lafThreadRuns.origin, "routine"),
      ),
    );
  const receipts = await database
    .select({ ok: lafRoutineRuns.ok, answer: lafRoutineRuns.answer })
    .from(lafRoutineRuns)
    .where(eq(lafRoutineRuns.routineId, fixture.routineId));
  return {
    answers: messages.filter((content) => content.includes("오늘 할 일"))
      .length,
    marks: messages.filter((content) => content.trim() === "**아침 보고**")
      .length,
    ledger: runs.map((run) => run.status),
    receipts: receipts.map((receipt) => receipt.ok),
  };
}

describe("a routine killed while it settles", () => {
  test("killed right after the answer is written: nothing was delivered, and boot says interrupted", async () => {
    const fixture = await morningRoutine();
    await runAndKill(fixture, "delivered");

    // The instant after the kill: the answer never committed, so there is nothing to lie over.
    expect(await ledgerOf(fixture)).toEqual({
      answers: 0,
      marks: 0,
      ledger: ["running"],
      receipts: [],
    });

    const told = await boot(fixture.botId);
    expect(await ledgerOf(fixture)).toEqual({
      answers: 0,
      marks: 1,
      ledger: ["unknown"],
      receipts: [],
    });
    expect(told).toEqual(["run.failed"]);
  }, 30_000);

  test("killed after the settlement: the answer stands beside a finished run, and boot says nothing", async () => {
    const fixture = await morningRoutine();
    await runAndKill(fixture, "committed");

    const told = await boot(fixture.botId);
    expect(await ledgerOf(fixture)).toEqual({
      answers: 1,
      marks: 0,
      ledger: ["done"],
      receipts: [true],
    });
    expect(told).toEqual([]);
  }, 30_000);

  test("a settlement write that fails takes the answer back with it, and says the run failed", async () => {
    const fixture = await morningRoutine();
    const trail: Record<string, unknown>[] = [];
    const service = createRoutineService({
      database,
      resolveAgents: async () => ({
        [fixture.botId]: {
          setMessages() {},
          async runAgent() {
            return {
              result: undefined,
              newMessages: [
                { id: randomUUID(), role: "assistant", content: ANSWER },
              ],
            };
          },
        } as unknown as AbstractAgent,
      }),
      ledger,
      auditStore: {
        insert: async (event) => {
          trail.push(event.payload);
        },
      },
      // The answer is written inside the settlement, and then the settlement fails before commit.
      deliver: async (delivery, options) => {
        await appendToSoloConversation(options?.within ?? database, {
          agentId: delivery.agentId,
          userId: delivery.userId,
          heading: delivery.routineName,
          body: delivery.answer,
          at: delivery.at,
        });
        throw new Error("the receipt could not be written");
      },
    });

    await service.runNow(fixture.owner, fixture.routineId);

    expect(await ledgerOf(fixture)).toEqual({
      answers: 0,
      marks: 0,
      ledger: ["error"],
      receipts: [],
    });
    // Reported as the failure it became, so the person is told rather than left with silence.
    expect(trail).toEqual([
      expect.objectContaining({ ok: false, failure: "laf:turn_failed" }),
    ]);
  });
});
