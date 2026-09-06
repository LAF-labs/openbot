/**
 * A restart does not lie. Launch plan 3-B (재시작·끊김이 거짓말하지 않는다).
 *
 * Three things a person was never told before this work: a routine that ended in RUN_ERROR or on
 * its deadline, a run the server restarted under, and a window that was missed — whether it was
 * caught up or let go. Each one is a chain of rows: the ledger, the mark in the conversation, the
 * outbox row and the doors that took it, the trail. A fake of any link would prove nothing about
 * the join the next link reads, so all of it runs against Postgres.
 *
 * MEASURED FIRST BY HAND, 2026-09-06: a routine driven against an endpoint that held its run open,
 * the API killed with SIGKILL mid-run and started again. Boot said "1 run(s) had no ending;
 * reconciled to unknown" and "1 interrupted run(s) reported as run.failed", the outbox held one
 * `run.failed` row with `laf:turn_interrupted` delivered through socket and webhook only, and
 * `GET /api/channels/:id/failures` keyed that code to the routine's heading in the transcript. These
 * tests pin the same chain so it cannot quietly come apart.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput } from "../src/audit";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import {
  createTurnFailureReader,
  TURN_FAILURE_CODES,
} from "../src/channels/turn-failures";
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
import { createAlimtalkAdapter } from "../src/notifications/alimtalk";
import { withOutboxWatch } from "../src/notifications/from-audit";
import {
  createNotificationOutbox,
  type NotificationAdapter,
  type NotificationRecord,
} from "../src/notifications/outbox";
import type { PartnerConnections } from "../src/plugins/partner-connections";
import { createRoutineFailureDelivery } from "../src/routines/deliver";
import {
  CATCH_UP_GRACE_MAX_MS,
  CATCH_UP_GRACE_MIN_MS,
  catchUpGraceMs,
  createRoutineService,
  type RoutineSchedule,
} from "../src/routines/service";
import {
  LafPostgresRunner,
  reportInterruptedRuns,
} from "../src/runner/laf-runner";
import { createRunLedger } from "../src/runner/run-ledger";
import { appendMessages, messagesFor } from "../src/runner/thread-store";
import type { LoopAgent, UnattendedToolkit } from "../src/runner/unattended";
import { TEST_POOL } from "./support/database";

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
  createThreadIdentity("restart-recovery-test"),
);
const ledger = createRunLedger(database);
const readFailures = createTurnFailureReader(database);

const prefix = `restart-${randomUUID().slice(0, 8)}`;
const userIds: string[] = [];
const agentIds: string[] = [];
const channelIds: string[] = [];
const threadIds: string[] = [];
const runIds: string[] = [];

// Scoped to what this file made, every time: the suite shares one database with every other file.
afterEach(async () => {
  if (runIds.length > 0) {
    await database
      .delete(lafThreadRuns)
      .where(inArray(lafThreadRuns.runId, runIds.splice(0)));
  }
  if (agentIds.length > 0) {
    // The service's own ledger rows carry no id this file saw; they carry the Bot.
    await database
      .delete(lafThreadRuns)
      .where(inArray(lafThreadRuns.agentId, agentIds));
  }
  if (userIds.length > 0) {
    const mine = database
      .select({ id: lafRoutines.id })
      .from(lafRoutines)
      .where(inArray(lafRoutines.createdById, userIds));
    await database
      .delete(lafRoutineRuns)
      .where(inArray(lafRoutineRuns.routineId, mine));
    await database
      .delete(lafRoutines)
      .where(inArray(lafRoutines.createdById, userIds));
    await database
      .delete(lafNotifications)
      .where(inArray(lafNotifications.userId, userIds));
  }
  for (const threadId of threadIds.splice(0)) {
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  for (const channelId of channelIds.splice(0)) {
    await database
      .delete(channelThreads)
      .where(eq(channelThreads.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of agentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of userIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

// --- fixtures ---------------------------------------------------------------------------------

async function createOwner(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID().slice(0, 8)}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Restart Tester" });
  userIds.push(id);
  return { id, role: "user" };
}

/** A person, their Bot, and the one conversation the two have — where a routine's answer lands. */
async function createBotWithConversation(owner: AgentActor) {
  const profile = await profileStore.create(owner, {
    name: "아침봇",
    title: "Coworker",
    roleDescription: "Reports every morning.",
    visibility: "private",
  });
  agentIds.push(profile.id);
  const channel = await channelStore.create(owner, [profile.id]);
  channelIds.push(channel.id);
  const [mapping] = await database
    .select({ threadId: channelThreads.threadId })
    .from(channelThreads)
    .where(eq(channelThreads.channelId, channel.id));
  if (!mapping) throw new Error("the conversation has no thread");
  threadIds.push(mapping.threadId);
  return {
    botId: profile.id,
    channelId: channel.id,
    threadId: mapping.threadId,
  };
}

/** A door that takes everything and says which rows it took. */
function door(name: string, took: string[]): NotificationAdapter {
  return {
    name,
    deliver: async (record) => {
      took.push(`${name}:${record.kind}`);
      return true;
    },
  };
}

/**
 * The AlimTalk door as deployed, with a key AND a partner store that counts how often it is asked.
 *
 * The rule under test is that a `run.failed` row never reaches a phone. The strongest form of it is
 * that the door does not even ask whose channel it would send through — a door that looked up the
 * connection and then declined would still be one refactor away from sending.
 */
function alimtalkThatCounts(asked: { count: number }) {
  const partners = {
    find: async () => {
      asked.count += 1;
      return null;
    },
    templatesFor: async () => [],
  } as unknown as PartnerConnections;
  return createAlimtalkAdapter({
    partners,
    environment: { LAF_ALIMTALK_API_KEY: "key:secret" },
    log: () => {},
  });
}

function outboxWithDoors() {
  const took: string[] = [];
  const asked = { count: 0 };
  const outbox = createNotificationOutbox({
    database,
    adapters: [
      door("socket", took),
      alimtalkThatCounts(asked),
      door("webhook", took),
    ],
  });
  return { outbox, took, asked };
}

/** The rows the outbox wrote for one person, once the fire-and-forget enqueue has landed. */
async function notificationsFor(
  userId: string,
  expected: number,
): Promise<(typeof lafNotifications.$inferSelect)[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await database
      .select()
      .from(lafNotifications)
      .where(eq(lafNotifications.userId, userId));
    if (rows.length >= expected || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * A Bot whose run ends one of two ways: it never finishes before the deadline, or the stream
 * reports RUN_ERROR with the given sentence. The shape `runUnattended` drives.
 */
function botThat(ending: { holdsMs: number } | { errors: string }): LoopAgent {
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      _parameters?: unknown,
      subscriber?: {
        onRunErrorEvent?: (payload: { event: { message: string } }) => unknown;
        onRunFinishedEvent?: () => unknown;
      },
    ) {
      if ("holdsMs" in ending) {
        await new Promise((resolve) => setTimeout(resolve, ending.holdsMs));
        subscriber?.onRunFinishedEvent?.();
        return { result: undefined, newMessages: [] };
      }
      subscriber?.onRunErrorEvent?.({ event: { message: ending.errors } });
      return { result: undefined, newMessages: [] };
    },
  };
  return agent as unknown as LoopAgent;
}

const NO_TOOLS = {
  tools: [],
  execute: async () => {
    throw new Error("this Bot has no tools");
  },
} as unknown as UnattendedToolkit;

function routineServiceFor(input: {
  botId: string;
  bot: LoopAgent;
  outbox: ReturnType<typeof createNotificationOutbox>;
  clock?: () => Date;
  runTimeoutMs?: number;
}) {
  const rows: AuditEventInput[] = [];
  const service = createRoutineService({
    database,
    resolveAgents: async () => ({
      [input.botId]: input.bot as unknown as AbstractAgent,
    }),
    // The trail with the outbox listening, exactly as index.ts wires it.
    auditStore: withOutboxWatch(
      {
        insert: async (event) => {
          rows.push(event);
        },
      },
      input.outbox,
    ),
    ledger,
    deliverFailure: createRoutineFailureDelivery(database),
    tools: async () => NO_TOOLS,
    ...(input.clock ? { now: input.clock } : {}),
    ...(input.runTimeoutMs ? { runTimeoutMs: input.runTimeoutMs } : {}),
  });
  return { service, rows };
}

// --- the tests --------------------------------------------------------------------------------

describe("the catch-up grace", () => {
  const minutes = (schedule: RoutineSchedule) =>
    catchUpGraceMs(schedule) / 60_000;

  test("is half the period, clamped to two minutes and two hours", () => {
    // The table in docs/laf/routines.md, pinned.
    expect(minutes({ kind: "interval", minutes: 5 })).toBe(2.5);
    expect(minutes({ kind: "interval", minutes: 30 })).toBe(15);
    expect(minutes({ kind: "interval", minutes: 60 })).toBe(30);
    expect(minutes({ kind: "interval", minutes: 300 })).toBe(120);
    expect(minutes({ kind: "daily", time: "07:30" })).toBe(120);
    // A floor under the arithmetic: an interval fast enough that half of it is under two minutes
    // still gets two — the fake below the minimum interval is deliberate, the function is pure.
    expect(minutes({ kind: "interval", minutes: 3 })).toBe(2);
    // A weekday-restricted routine is still a daily one for this purpose: a Monday-only routine
    // three days late is not "within half its period", it is a Thursday.
    expect(
      minutes({
        kind: "daily",
        time: "09:00",
        timeZone: "Asia/Seoul",
        days: [1],
      }),
    ).toBe(120);
    expect(CATCH_UP_GRACE_MIN_MS).toBe(2 * 60_000);
    expect(CATCH_UP_GRACE_MAX_MS).toBe(2 * 60 * 60_000);
  });

  test("a daily routine ninety minutes late runs once, three hours late waits for tomorrow", async () => {
    const owner = await createOwner();
    const { botId } = await createBotWithConversation(owner);
    let clock = new Date("2026-08-20T05:00:00Z");
    const { outbox } = outboxWithDoors();
    const { service, rows } = routineServiceFor({
      botId,
      bot: botThat({ errors: "no matter" }),
      outbox,
      clock: () => clock,
    });
    const routine = await service.create(owner, {
      agentId: botId,
      name: "아침 브리핑",
      instruction: "오늘 할 일 알려줘",
      schedule: { kind: "daily", time: "07:30" },
    });
    if (!routine) throw new Error("not created");

    // The server came back at nine: ninety minutes late, inside a daily routine's two-hour grace.
    clock = new Date("2026-08-20T09:00:00Z");
    expect(await service.tick()).toBe(1);
    expect(rows.map((row) => row.eventType)).toEqual([
      "routine.caught_up",
      "routine.ran",
    ]);
    expect(rows[0]?.payload).toMatchObject({
      lateByMinutes: 90,
      graceMinutes: 120,
      missed: "2026-08-20T07:30:00.000Z",
    });

    // The next morning it was off until half past ten: past the grace, let go, and armed for the
    // day after — never queued.
    rows.splice(0);
    clock = new Date("2026-08-21T10:31:00Z");
    expect(await service.tick()).toBe(0);
    expect(rows.map((row) => row.eventType)).toEqual([
      "routine.skipped_missed",
    ]);
    expect(rows[0]?.payload).toMatchObject({
      lateByMinutes: 181,
      graceMinutes: 120,
      missed: "2026-08-21T07:30:00.000Z",
      next: "2026-08-22T07:30:00.000Z",
    });
    const [row] = await database
      .select({ nextRunAt: lafRoutines.nextRunAt })
      .from(lafRoutines)
      .where(eq(lafRoutines.id, routine.id));
    expect(row?.nextRunAt?.toISOString()).toBe("2026-08-22T07:30:00.000Z");
  });
});

describe("a routine that does not finish", () => {
  test("hits its deadline: the conversation is marked, the transcript says why, and one run.failed row goes out through socket and webhook", async () => {
    const owner = await createOwner();
    const { botId, channelId, threadId } =
      await createBotWithConversation(owner);
    const { outbox, took, asked } = outboxWithDoors();
    const { service, rows } = routineServiceFor({
      botId,
      bot: botThat({ holdsMs: 400 }),
      outbox,
      runTimeoutMs: 60,
    });
    const routine = await service.create(owner, {
      agentId: botId,
      name: "아침 브리핑",
      instruction: "오늘 할 일 알려줘",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    await service.runNow(owner, routine.id);

    // The trail: one row, with everything the outbox needs and the failure as a code, not prose.
    const ran = rows.find((row) => row.eventType === "routine.ran");
    expect(ran?.payload).toMatchObject({
      ok: false,
      actor: owner.id,
      failure: TURN_FAILURE_CODES.timedOut,
      channelId,
    });
    expect(ran?.payload.runId).toBeString();

    // The conversation: the routine's heading and nothing else, from the Bot, keyed to the run.
    const messages = await messagesFor(database, threadId);
    const mark = messages.at(-1) as unknown as {
      id: string;
      role: string;
      content: string;
      lafAgentId?: string;
    };
    expect(mark.role).toBe("assistant");
    expect(mark.content).toBe("**아침 브리핑**");
    expect(mark.lafAgentId).toBe(botId);
    // No sentence in the transcript: the model must not read its own obituary on the next turn.
    expect(mark.content).not.toContain("time");

    // The failure line the surface draws: the same code, keyed to that mark.
    expect(await readFailures(threadId)).toEqual([
      expect.objectContaining({
        code: TURN_FAILURE_CODES.timedOut,
        messageId: mark.id,
      }),
    ]);

    // The unread dot: the roster row moved to the Bot.
    const [room] = await database
      .select({
        lastMessage: channels.lastMessage,
        lastMessageAgentId: channels.lastMessageAgentId,
      })
      .from(channels)
      .where(eq(channels.id, channelId));
    expect(room).toEqual({
      lastMessage: "아침 브리핑",
      lastMessageAgentId: botId,
    });

    // The outbox: one row, the facts of the run, through two doors and never the phone.
    const [notification] = await notificationsFor(owner.id, 1);
    expect(notification).toMatchObject({
      kind: "run.failed",
      botId,
      channelId,
      subject: {
        kind: "run",
        origin: "routine",
        label: "아침 브리핑",
        code: TURN_FAILURE_CODES.timedOut,
      },
    });
    expect(notification?.deliveredVia).toEqual(["socket", "webhook"]);
    expect(took).toEqual(["socket:run.failed", "webhook:run.failed"]);
    expect(asked.count).toBe(0);

    // And read back, the facts come out as `run`, not as an approval's `subject`.
    const [listed] = await outbox.list(owner.id);
    expect(listed?.run).toEqual({
      origin: "routine",
      label: "아침 브리핑",
      code: TURN_FAILURE_CODES.timedOut,
    });
    expect(listed?.subject).toBeUndefined();
  });

  test("ends in RUN_ERROR: the same chain, with the error's own code", async () => {
    const owner = await createOwner();
    const { botId, threadId } = await createBotWithConversation(owner);
    const { outbox } = outboxWithDoors();
    const { service, rows } = routineServiceFor({
      botId,
      bot: botThat({ errors: "fetch failed: ECONNREFUSED 127.0.0.1:4200" }),
      outbox,
    });
    const routine = await service.create(owner, {
      agentId: botId,
      name: "재고 확인",
      instruction: "떨어질 상품",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("not created");

    await service.runNow(owner, routine.id);

    const ran = rows.find((row) => row.eventType === "routine.ran");
    expect(ran?.payload).toMatchObject({
      ok: false,
      failure: TURN_FAILURE_CODES.unreachable,
    });
    const failures = await readFailures(threadId);
    expect(failures.map((failure) => failure.code)).toEqual([
      TURN_FAILURE_CODES.unreachable,
    ]);
    const [notification] = await notificationsFor(owner.id, 1);
    expect(notification?.subject).toMatchObject({
      kind: "run",
      label: "재고 확인",
      code: TURN_FAILURE_CODES.unreachable,
    });
    expect(notification?.deliveredVia).not.toContain("alimtalk");
  });
});

describe("a run the server restarted under", () => {
  test("is reconciled to unknown, marked, and reported as interrupted — never through the phone", async () => {
    const owner = await createOwner();
    const { botId, channelId, threadId } =
      await createBotWithConversation(owner);

    // What the last process left: a routine's run and a chat turn, both open, plus a run of
    // nobody's — a wake with no person behind it.
    const routineRun = await ledger.begin({
      agentId: botId,
      userId: owner.id,
      threadId,
      origin: "routine",
      label: "아침 브리핑",
    });
    const chatRun = await ledger.begin({
      agentId: botId,
      userId: owner.id,
      threadId,
      origin: "chat",
    });
    const orphanRun = await ledger.begin({
      agentId: botId,
      userId: null,
      origin: "wake",
    });
    runIds.push(routineRun, chatRun, orphanRun);
    const [question] = await appendMessages(
      database,
      threadId,
      [{ id: randomUUID(), role: "user", content: "오늘 매출 어때?" }],
      { runId: chatRun },
    );
    if (!question) throw new Error("the question was not stored");

    // Boot.
    const runner = await LafPostgresRunner.create(database, ledger);
    const found = runner
      .interruptedAtBoot()
      .filter((run) => runIds.includes(run.runId));
    expect(found.map((run) => run.origin).sort()).toEqual([
      "chat",
      "routine",
      "wake",
    ]);
    const reconciled = await database
      .select({ status: lafThreadRuns.status })
      .from(lafThreadRuns)
      .where(inArray(lafThreadRuns.runId, runIds));
    expect(reconciled.map((run) => run.status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);

    // Then, once the outbox exists, the people are told.
    const { outbox, took, asked } = outboxWithDoors();
    const told = await reportInterruptedRuns({
      database,
      runs: found,
      outbox,
      markRoutine: createRoutineFailureDelivery(database),
    });
    // Two: the orphan has nobody to tell and is not news.
    expect(told).toBe(2);

    const notifications = await notificationsFor(owner.id, 2);
    expect(notifications).toHaveLength(2);
    const byOrigin = Object.fromEntries(
      notifications.map((row) => [
        (row.subject as { origin: string }).origin,
        row,
      ]),
    );
    expect(byOrigin.routine).toMatchObject({
      kind: "run.failed",
      botId,
      channelId,
      subject: {
        kind: "run",
        origin: "routine",
        label: "아침 브리핑",
        code: TURN_FAILURE_CODES.interrupted,
      },
    });
    // A chat turn has no name to carry, and its conversation is found from the thread.
    expect(byOrigin.chat).toMatchObject({
      kind: "run.failed",
      botId,
      channelId,
      subject: {
        kind: "run",
        origin: "chat",
        code: TURN_FAILURE_CODES.interrupted,
      },
    });
    expect(byOrigin.chat?.subject).not.toHaveProperty("label");
    for (const row of notifications) {
      expect(row.deliveredVia).toEqual(["socket", "webhook"]);
    }
    expect(took).toHaveLength(4);
    expect(asked.count).toBe(0);

    // The transcript: the routine's mark under its name, the question left as it was, and the
    // failure line keyed to each — the same code, claiming nothing about why.
    const messages = (await messagesFor(database, threadId)) as unknown as {
      id: string;
      content: string;
    }[];
    const mark = messages.find(
      (message) => message.content === "**아침 브리핑**",
    );
    if (!mark) throw new Error("the routine's mark is not in the transcript");
    const failures = await readFailures(threadId);
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map((failure) => failure.code))).toEqual(
      new Set([TURN_FAILURE_CODES.interrupted]),
    );
    expect(new Set(failures.map((failure) => failure.messageId))).toEqual(
      new Set([mark.id, question.id]),
    );
  });

  test("boot with nothing open reports nobody", async () => {
    const { outbox, took } = outboxWithDoors();
    const told = await reportInterruptedRuns({ database, runs: [], outbox });
    expect(told).toBe(0);
    expect(took).toEqual([]);
  });
});

describe("the AlimTalk door and a failed run", () => {
  const A_FAILED_RUN: NotificationRecord = {
    id: "notification-run-failed",
    kind: "run.failed",
    botId: "bot-1",
    userId: "person-1",
    channelId: "channel-1",
    run: {
      origin: "routine",
      label: "아침 브리핑",
      code: TURN_FAILURE_CODES.timedOut,
    },
    createdAt: "2026-09-06T07:30:00.000Z",
    deliveredVia: [],
  };

  test("declines before asking whose channel it is, and says nothing about it", async () => {
    const asked = { count: 0 };
    const said: string[] = [];
    const partners = {
      find: async () => {
        asked.count += 1;
        return null;
      },
      templatesFor: async () => [],
    } as unknown as PartnerConnections;
    const adapter = createAlimtalkAdapter({
      partners,
      environment: { LAF_ALIMTALK_API_KEY: "key:secret" },
      log: (message) => said.push(message),
    });

    expect(await adapter.deliver(A_FAILED_RUN)).toBe(false);
    expect(
      await adapter.deliver({
        ...A_FAILED_RUN,
        run: { origin: "chat", code: TURN_FAILURE_CODES.interrupted },
      }),
    ).toBe(false);
    // Not a failure and not a log line: it is the rule about what deserves a buzz, working.
    expect(asked.count).toBe(0);
    expect(said).toEqual([]);
  });
});
