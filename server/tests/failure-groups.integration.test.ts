/**
 * A routine failing the same way every hour is one line and one notification, not one an hour.
 *
 * What a 사장님 saw before this: a routine checking reviews every hour, the provider refusing, and
 * by the evening ten headings in the Bot's conversation with ten red lines under them and ten
 * `run.failed` buzzes — the same sentence each time. Measured on a running server and agent-bot
 * against a provider answering every request with 429: ten runs, ten `run.failed` rows, ten marks.
 *
 * The chain is the real one — the ticker, the unattended loop, the settlement's transaction, the
 * trail with the outbox listening, the doors, the failure reader the transcript draws from — with
 * only the Bot scripted, because every link reads what the one before it wrote in Postgres and a
 * fake of any of them would prove nothing about the join. "A restart" is a second, fresh set of
 * all of those over the same database: nothing a process holds in memory survives it, which is
 * exactly what a restart is.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, Message } from "@ag-ui/client";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput } from "../src/audit";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import {
  createTurnFailureReader,
  TURN_FAILURE_CODES,
  type TurnFailureCode,
} from "../src/channels/turn-failures";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  lafNotifications,
  lafRoutineNotepads,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createAlimtalkAdapter } from "../src/notifications/alimtalk";
import {
  countRepeatedFailure,
  type FailureGroupFacts,
  openFailureGroup,
  routineFailureSignature,
} from "../src/notifications/failure-groups";
import { withOutboxWatch } from "../src/notifications/from-audit";
import {
  createNotificationOutbox,
  type NotificationAdapter,
  purgeNotificationsBefore,
} from "../src/notifications/outbox";
import { solapiSettings } from "../src/plugins/alimtalk/solapi";
import type { PartnerConnections } from "../src/plugins/partner-connections";
import {
  createRoutineDelivery,
  createRoutineFailureDelivery,
} from "../src/routines/deliver";
import { createRoutineService } from "../src/routines/service";
import { createRunLedger } from "../src/runner/run-ledger";
import { messagesFor } from "../src/runner/thread-store";
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
  createThreadIdentity("failure-groups-test"),
);
const ledger = createRunLedger(database);
const readFailures = createTurnFailureReader(database);

const prefix = `groups-${randomUUID().slice(0, 8)}`;
const made = {
  users: [] as string[],
  agents: [] as string[],
  channels: [] as string[],
  threads: [] as string[],
};

// Scoped to what this file made, every time: the suite shares one database with every other file.
afterEach(async () => {
  if (made.users.length > 0) {
    const theirs = database
      .select({ id: lafRoutines.id })
      .from(lafRoutines)
      .where(inArray(lafRoutines.createdById, made.users));
    await database
      .delete(lafRoutineNotepads)
      .where(inArray(lafRoutineNotepads.routineId, theirs));
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
    await database
      .delete(channelThreads)
      .where(inArray(channelThreads.channelId, made.channels));
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

// --- fixtures ---------------------------------------------------------------------------------

const ROUTINE = "리뷰 확인";
const MARK = `**${ROUTINE}**`;
const HOUR = 60 * 60 * 1000;

/**
 * What the Bot does on its next run: the provider's refusal as agent-bot reports it, or an answer —
 * after a first turn that writes `notes` to the routine's notepad, when there are notes.
 */
type Reply = ({ errors: string } | { answers: string }) & {
  notes?: Record<string, unknown>;
};
/** The run's script, and the notepad each run was shown, in the order the runs happened. */
type Plan = { reply: Reply; shown: unknown[] };
const REFUSED: Reply = { errors: "laf:model_rate_limited" };
const TIMED_OUT: Reply = { errors: "laf:model_timed_out" };
const ANSWERED: Reply = { answers: "새 리뷰 두 건: 별점 5, 별점 4." };

/** A person, their Bot, their one conversation, and an hourly routine on it. */
async function hourlyRoutine() {
  const id = `${prefix}-user-${randomUUID().slice(0, 8)}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Groups Tester" });
  made.users.push(id);
  const owner: AgentActor = { id, role: "user" };
  const profile = await profileStore.create(owner, {
    name: "리뷰봇",
    title: "Coworker",
    roleDescription: "Checks reviews every hour.",
    visibility: "private",
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

  const plan: Plan = { reply: REFUSED, shown: [] };
  const clock = { now: new Date("2026-09-14T00:00:00Z") };
  const first = boot({ botId: profile.id, plan, clock });
  const routine = await first.service.create(owner, {
    agentId: profile.id,
    name: ROUTINE,
    instruction: "새 리뷰가 있으면 알려줘",
    schedule: { kind: "interval", minutes: 60 },
  });
  if (!routine) throw new Error("the routine was not created");
  return {
    owner,
    botId: profile.id,
    channelId: channel.id,
    threadId: mapping.threadId,
    routineId: routine.id,
    plan,
    clock,
    first,
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

/** The AlimTalk door as deployed, counting how often it even asks whose channel it would use. */
function alimtalkThatCounts(asked: { count: number }) {
  return createAlimtalkAdapter({
    partners: {
      find: async () => {
        asked.count += 1;
        return null;
      },
      templatesFor: async () => [],
    } as unknown as PartnerConnections,
    settings: solapiSettings({ LAF_ALIMTALK_API_KEY: "key:secret" }),
    log: () => {},
  });
}

/** A scripted Bot, the shape `runUnattended` drives: it refuses or it answers, as the plan says. */
function scriptedBot(plan: Plan): LoopAgent {
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      parameters?: { forwardedProps?: { notepad?: unknown } },
      subscriber?: {
        onRunErrorEvent?: (payload: { event: { message: string } }) => unknown;
        onRunFinishedEvent?: () => unknown;
      },
    ) {
      const reply = plan.reply;
      // A run's first turn is the one whose thread ends on the routine's instruction.
      const firstTurn = agent.messages.at(-1)?.role === "user";
      if (firstTurn) {
        // What the loop forwarded, which is what the prompt middleware would have drawn.
        plan.shown.push(parameters?.forwardedProps?.notepad ?? null);
      }
      if (firstTurn && reply.notes) {
        // The only way a run writes its notepad: a `routine_note` call the loop executes.
        agent.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: randomUUID(),
              type: "function",
              function: {
                name: "routine_note",
                arguments: JSON.stringify(reply.notes),
              },
            },
          ],
        });
        subscriber?.onRunFinishedEvent?.();
      } else if ("errors" in reply) {
        subscriber?.onRunErrorEvent?.({ event: { message: reply.errors } });
      } else {
        agent.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: reply.answers,
        });
        subscriber?.onRunFinishedEvent?.();
      }
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

/**
 * One server process's worth of the chain: its own outbox and doors, its own trail watch, its own
 * routine service. Called again over the same database, it is a restart.
 */
function boot(input: { botId: string; plan: Plan; clock: { now: Date } }) {
  const took: string[] = [];
  const asked = { count: 0 };
  const trail: AuditEventInput[] = [];
  const outbox = createNotificationOutbox({
    database,
    adapters: [
      door("socket", took),
      alimtalkThatCounts(asked),
      door("webhook", took),
    ],
    log: () => {},
    now: () => input.clock.now,
  });
  const service = createRoutineService({
    database,
    resolveAgents: async () => ({
      [input.botId]: scriptedBot(input.plan) as unknown as AbstractAgent,
    }),
    // The trail with the outbox listening, as `main.ts` wires it.
    auditStore: withOutboxWatch(
      { insert: async (event) => void trail.push(event) },
      outbox,
    ),
    ledger,
    deliver: createRoutineDelivery(database),
    deliverFailure: createRoutineFailureDelivery(database),
    tools: async () => NO_TOOLS,
    now: () => input.clock.now,
  });
  return { service, outbox, took, asked, trail };
}

type Fixture = Awaited<ReturnType<typeof hourlyRoutine>>;
type Process = ReturnType<typeof boot>;

/** The next hour's run, on the ticker, answered the way `reply` says. */
async function nextHour(fixture: Fixture, on: Process, reply: Reply) {
  fixture.plan.reply = reply;
  fixture.clock.now = new Date(fixture.clock.now.getTime() + HOUR);
  expect(await on.service.tick()).toBe(1);
}

/** The doors are offered a row after the trail insert returns; wait for them, not for a guess. */
async function doorsTook(on: Process, expected: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (on.took.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // And a moment more, so a door that took one row too many is caught rather than outrun.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return on.took;
}

/** Every `run.failed` row this person has, oldest first, with its group read out. */
async function groupsOf(fixture: Fixture) {
  const rows = await database
    .select()
    .from(lafNotifications)
    .where(
      and(
        eq(lafNotifications.userId, fixture.owner.id),
        eq(lafNotifications.kind, "run.failed"),
      ),
    )
    .orderBy(asc(lafNotifications.createdAt));
  return rows.map((row) => {
    const subject = row.subject as {
      code: string;
      group?: FailureGroupFacts;
    };
    return {
      id: row.id,
      code: subject.code,
      group: subject.group,
      deliveredVia: row.deliveredVia,
      seen: row.seenAt !== null,
    };
  });
}

/** How many times the routine's heading was written into the conversation. */
async function marksIn(fixture: Fixture): Promise<number> {
  const messages = (await messagesFor(
    database,
    fixture.threadId,
  )) as unknown as {
    content?: unknown;
  }[];
  return messages.filter((message) => message.content === MARK).length;
}

const at = (fixture: Fixture) => fixture.clock.now.toISOString();

/** The payload of the last `routine.ran` row this process wrote. */
const lastRan = (on: Process) =>
  on.trail.filter((row) => row.eventType === "routine.ran").at(-1)?.payload;

/** The watermark a run notes when it has handled the reviews up to `lastId`. */
const handledUpTo = (lastId: string) => ({
  action: "watermark",
  key: "new_reviews",
  lastId,
});

/** A notepad an earlier recorded run left, written the way a settlement writes one. */
async function leftOffAt(fixture: Fixture, lastId: string) {
  await database.insert(lafRoutineNotepads).values({
    routineId: fixture.routineId,
    entries: [
      {
        key: "new_reviews",
        kind: "watermark",
        lastId,
        at: "2026-09-13T22:00:00.000Z",
      },
    ],
    version: 1,
    writtenByRun: "an-earlier-run",
  });
}

async function storedNotepad(fixture: Fixture) {
  const [row] = await database
    .select()
    .from(lafRoutineNotepads)
    .where(eq(lafRoutineNotepads.routineId, fixture.routineId));
  return row;
}

// --- the tests --------------------------------------------------------------------------------

describe("a routine failing the same way every hour", () => {
  test("ten identical failures are one notification, one mark, and one line that says ten", async () => {
    const fixture = await hourlyRoutine();
    const { first } = fixture;

    await nextHour(fixture, first, REFUSED);
    const firstAt = at(fixture);
    for (let hour = 2; hour <= 10; hour += 1) {
      await nextHour(fixture, first, REFUSED);
    }

    // One row, through the two doors that reach a person, once — and never the phone.
    expect(await doorsTook(first, 2)).toEqual([
      "socket:run.failed",
      "webhook:run.failed",
    ]);
    expect(first.asked.count).toBe(0);
    const groups = await groupsOf(fixture);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      code: TURN_FAILURE_CODES.rateLimited,
      deliveredVia: ["socket", "webhook"],
      group: {
        scope: `routine:${fixture.routineId}`,
        target: "",
        count: 10,
        firstAt,
        lastAt: at(fixture),
      },
    });
    expect(groups[0]?.group?.closedAt).toBeUndefined();

    // One heading in the conversation, and the one red line under it carries the count.
    expect(await marksIn(fixture)).toBe(1);
    const lines = await readFailures(fixture.threadId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      code: TURN_FAILURE_CODES.rateLimited,
      group: {
        id: groups[0]?.id,
        count: 10,
        lastAt: at(fixture),
        acknowledged: false,
        closed: false,
      },
    });

    // Every run is still on the record — ten receipts, ten trail rows — and the trail says which
    // one opened the group and which were counted into it.
    const receipts = await database
      .select({ ok: lafRoutineRuns.ok })
      .from(lafRoutineRuns)
      .where(eq(lafRoutineRuns.routineId, fixture.routineId));
    expect(receipts.map((receipt) => receipt.ok)).toEqual(
      Array.from({ length: 10 }, () => false),
    );
    const ran = first.trail.filter((row) => row.eventType === "routine.ran");
    expect(ran.map((row) => row.payload.failureGroup)).toEqual([
      { id: groups[0]?.id, count: 1, opened: true },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: groups[0]?.id,
        count: index + 2,
        opened: false,
      })),
    ]);
    // Only the failure that left the mark names the conversation it is in.
    expect(ran.filter((row) => row.payload.channelId).length).toBe(1);
  });

  test("a success closes the group, and the next failure is news again", async () => {
    const fixture = await hourlyRoutine();
    const { first } = fixture;

    for (let hour = 1; hour <= 3; hour += 1) {
      await nextHour(fixture, first, REFUSED);
    }
    await nextHour(fixture, first, ANSWERED);
    const closedAt = at(fixture);
    await nextHour(fixture, first, REFUSED);

    expect(await doorsTook(first, 4)).toEqual([
      "socket:run.failed",
      "webhook:run.failed",
      "socket:run.failed",
      "webhook:run.failed",
    ]);
    const groups = await groupsOf(fixture);
    expect(groups.map((one) => one.group?.count)).toEqual([3, 1]);
    expect(groups[0]?.group?.closedAt).toBe(closedAt);
    expect(groups[1]?.group?.closedAt).toBeUndefined();

    // Two marks, the answer between them, and a line under each: the closed one no longer news.
    expect(await marksIn(fixture)).toBe(2);
    const lines = await readFailures(fixture.threadId);
    expect(
      lines.map((line) => [line.group?.count, line.group?.closed]),
    ).toEqual([
      [3, true],
      [1, false],
    ]);
  });

  test("a different code on the same routine is a group of its own, and the first stays counted", async () => {
    const fixture = await hourlyRoutine();
    const { first } = fixture;

    await nextHour(fixture, first, REFUSED);
    await nextHour(fixture, first, REFUSED);
    await nextHour(fixture, first, TIMED_OUT);
    await nextHour(fixture, first, TIMED_OUT);
    // And back: the refusal's group is still open — nothing succeeded — so this is its third.
    await nextHour(fixture, first, REFUSED);

    expect(await doorsTook(first, 4)).toHaveLength(4);
    const groups = await groupsOf(fixture);
    expect(groups.map((one) => [one.code, one.group?.count])).toEqual([
      [TURN_FAILURE_CODES.rateLimited, 3],
      [TURN_FAILURE_CODES.timedOut, 2],
    ]);
    expect(await marksIn(fixture)).toBe(2);
    expect(
      (await readFailures(fixture.threadId)).map((line) => [
        line.code,
        line.group?.count,
      ]),
    ).toEqual([
      [TURN_FAILURE_CODES.rateLimited, 3],
      [TURN_FAILURE_CODES.timedOut, 2],
    ]);
  });

  test("acknowledging a group silences it through every repeat, until a success", async () => {
    const fixture = await hourlyRoutine();
    const { first, owner } = fixture;

    await nextHour(fixture, first, REFUSED);
    await nextHour(fixture, first, REFUSED);
    const [group] = await groupsOf(fixture);
    if (!group) throw new Error("no group was opened");
    expect((await first.outbox.list(owner.id)).map((one) => one.id)).toEqual([
      group.id,
    ]);

    // Somebody else cannot acknowledge it, and the person themselves can — twice, harmlessly.
    expect(await first.outbox.acknowledge(`${owner.id}-other`, group.id)).toBe(
      false,
    );
    const acknowledgedAt = at(fixture);
    expect(await first.outbox.acknowledge(owner.id, group.id)).toBe(true);
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 1000);
    expect(await first.outbox.acknowledge(owner.id, group.id)).toBe(true);

    // It is no longer waiting in their list, and its line says it was acknowledged.
    expect(await first.outbox.list(owner.id)).toEqual([]);
    expect((await readFailures(fixture.threadId))[0]?.group).toMatchObject({
      acknowledged: true,
      count: 2,
    });

    for (let hour = 1; hour <= 3; hour += 1) {
      await nextHour(fixture, first, REFUSED);
    }
    const [quiet] = await groupsOf(fixture);
    expect(quiet?.group).toMatchObject({ count: 5, acknowledgedAt });
    expect(quiet?.seen).toBe(true);
    expect(await marksIn(fixture)).toBe(1);
    expect(await first.outbox.list(owner.id)).toEqual([]);
    expect(await doorsTook(first, 2)).toHaveLength(2);

    // A success in between, and the same failure is a new group: told once, not acknowledged.
    await nextHour(fixture, first, ANSWERED);
    await nextHour(fixture, first, REFUSED);
    expect(await doorsTook(first, 4)).toHaveLength(4);
    const groups = await groupsOf(fixture);
    expect(
      groups.map((one) => [
        one.group?.count,
        Boolean(one.group?.acknowledgedAt),
        Boolean(one.group?.closedAt),
      ]),
    ).toEqual([
      [5, true, true],
      [1, false, false],
    ]);
    expect(await marksIn(fixture)).toBe(2);
  });

  test("a restart in the middle keeps the group: it is in the database, not in a process", async () => {
    const fixture = await hourlyRoutine();
    const { first } = fixture;

    for (let hour = 1; hour <= 5; hour += 1) {
      await nextHour(fixture, first, REFUSED);
    }
    expect(await doorsTook(first, 2)).toHaveLength(2);

    // A new process: a fresh outbox, fresh doors, a fresh trail watch, a fresh routine service.
    const second = boot({
      botId: fixture.botId,
      plan: fixture.plan,
      clock: fixture.clock,
    });
    for (let hour = 6; hour <= 10; hour += 1) {
      await nextHour(fixture, second, REFUSED);
    }

    // The second process told nobody anything: every one of its failures was a repeat.
    expect(await doorsTook(second, 0)).toEqual([]);
    expect(second.asked.count).toBe(0);
    const groups = await groupsOf(fixture);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.group?.count).toBe(10);
    expect(await marksIn(fixture)).toBe(1);
    expect(
      (await readFailures(fixture.threadId)).map((line) => line.group?.count),
    ).toEqual([10]);
  });
});

describe("the notepad and the failure group, settled by the same record", () => {
  /*
   * Both are "where the next run starts from", and both are written by the run's settlement, so this
   * is the one place the two can disagree: a cursor moved past a run the routine is still counting
   * as failing, or a group closed by a success whose cursor never landed.
   */
  test("a failed run's watermark is discarded as it is counted; the next success lands its own and closes the group", async () => {
    const fixture = await hourlyRoutine();
    const { first } = fixture;
    await leftOffAt(fixture, "R-1000");

    // The routine starts failing: the group opens.
    await nextHour(fixture, first, REFUSED);
    const [opened] = await groupsOf(fixture);
    if (!opened) throw new Error("no group was opened");

    // It gets as far as noting R-1002, then the provider refuses: counted, and the cursor stays.
    await nextHour(fixture, first, {
      ...REFUSED,
      notes: handledUpTo("R-1002"),
    });
    expect(await storedNotepad(fixture)).toMatchObject({
      version: 1,
      writtenByRun: "an-earlier-run",
      entries: [expect.objectContaining({ lastId: "R-1000" })],
    });
    expect((await groupsOf(fixture)).map((one) => one.group)).toEqual([
      expect.objectContaining({ count: 2, lastAt: at(fixture) }),
    ]);
    expect(lastRan(first)).toMatchObject({
      ok: false,
      notepad: "discarded",
      failureGroup: { id: opened.id, count: 2, opened: false },
    });

    // The next run succeeds, noting R-1002 again: the cursor lands and the group closes.
    await nextHour(fixture, first, {
      ...ANSWERED,
      notes: handledUpTo("R-1002"),
    });
    const receipts = await database
      .select({ id: lafRoutineRuns.id, ok: lafRoutineRuns.ok })
      .from(lafRoutineRuns)
      .where(eq(lafRoutineRuns.routineId, fixture.routineId))
      .orderBy(asc(lafRoutineRuns.startedAt));
    expect(receipts.map((receipt) => receipt.ok)).toEqual([false, false, true]);
    expect(await storedNotepad(fixture)).toMatchObject({
      version: 2,
      writtenByRun: receipts[2]?.id,
      entries: [expect.objectContaining({ lastId: "R-1002" })],
    });
    expect((await groupsOf(fixture)).map((one) => one.group)).toEqual([
      expect.objectContaining({ count: 2, closedAt: at(fixture) }),
    ]);
    const succeeded = lastRan(first);
    expect(succeeded).toMatchObject({ ok: true, notepad: "written" });
    expect(succeeded).not.toHaveProperty("failureGroup");

    // What each run was shown: the failed run's R-1002 never reached the run after it.
    const reviews = (lastId: string) => [
      { key: "new_reviews", kind: "watermark", lastId },
    ];
    expect(fixture.plan.shown).toEqual([
      reviews("R-1000"),
      reviews("R-1000"),
      reviews("R-1000"),
    ]);
    // And the doors heard about the failing once, for the run that opened the group.
    expect(await doorsTook(first, 2)).toEqual([
      "socket:run.failed",
      "webhook:run.failed",
    ]);
  });
});

describe("the signature", () => {
  const steps = (...names: Array<[string, boolean]>) => [
    { calls: names.map(([name, ok]) => ({ name, ok })) },
  ];

  test("names the tool a run could not use, and nothing for a failure that is not about one", () => {
    const refused = routineFailureSignature({
      routineId: "r1",
      code: TURN_FAILURE_CODES.toolFailed,
      steps: steps(["computer_navigate", true], ["mcp__naver__search", false]),
    });
    expect(refused).toEqual({
      scope: "routine:r1",
      code: TURN_FAILURE_CODES.toolFailed,
      target: "mcp__naver__search",
    });
    // A different tool failing the same way is a different problem, and so a different group.
    expect(
      routineFailureSignature({
        routineId: "r1",
        code: TURN_FAILURE_CODES.toolFailed,
        steps: steps(["computer_click", false]),
      }).target,
    ).toBe("computer_click");
    // The model refusing is about the run, whatever the last tool happened to be.
    expect(
      routineFailureSignature({
        routineId: "r1",
        code: TURN_FAILURE_CODES.rateLimited,
        steps: steps(["mcp__naver__search", false]),
      }).target,
    ).toBe("");
  });
});

describe("the retention sweep", () => {
  test("keeps a group that failed again inside the window, and takes one that stopped", async () => {
    const fixture = await hourlyRoutine();
    const day = 24 * HOUR;
    const now = Date.now();
    const signature = (code: TurnFailureCode) =>
      routineFailureSignature({
        routineId: fixture.routineId,
        code,
        steps: null,
      });
    const opened = (code: TurnFailureCode) =>
      openFailureGroup(database, {
        userId: fixture.owner.id,
        botId: fixture.botId,
        run: { origin: "routine", label: ROUTINE, code },
        signature: signature(code),
        at: new Date(now - 40 * day),
      });

    const stillFailing = await opened(TURN_FAILURE_CODES.rateLimited);
    const stopped = await opened(TURN_FAILURE_CODES.timedOut);
    expect(
      await countRepeatedFailure(database, {
        userId: fixture.owner.id,
        signature: signature(TURN_FAILURE_CODES.rateLimited),
        at: new Date(now - day),
      }),
    ).toEqual({ kind: "repeat", id: stillFailing ?? "", count: 2 });

    await purgeNotificationsBefore(database, new Date(now - 30 * day));

    // Only this person's rows are read: the sweep runs over the whole shared database.
    expect((await groupsOf(fixture)).map((one) => one.id)).toEqual([
      stillFailing ?? "",
    ]);
    expect(stopped).not.toBeNull();
  });
});
