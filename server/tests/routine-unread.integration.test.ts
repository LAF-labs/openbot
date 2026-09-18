import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, Message } from "@ag-ui/client";
import { and, eq, gt, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { type AuditEventInput, createAuditStore } from "../src/audit";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  channelMemberships,
  channels,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import { createRoutineService } from "../src/routines/service";
import { createBotLane } from "../src/runner/bot-lane";
import { createWorkInFlight } from "../src/runner/in-flight";
import {
  pauseUnreadRoutines,
  UNREAD_PAUSE_AFTER_MS,
  UNREAD_PAUSE_DELIVERIES,
} from "../src/routines/unread";
import { TEST_POOL } from "./support/database";

/**
 * ROUTINES NOBODY READS STOP ON THEIR OWN. 2026-09-18.
 *
 * A routine that runs every morning while nobody opens the conversation it delivers into spends the
 * day's allowance and the shared model key on answers nobody reads, and the person does not notice
 * — nothing about a routine going unread is visible from anywhere but the unread dot it leaves.
 * The rule: when at least three of a Bot's routine results have arrived in its conversation since
 * the person last opened it, and the oldest of them has waited a week, the routines that delivered
 * them are paused, the reason is kept on the row, and the person is told once.
 *
 * Everything here is measured with a fixed clock. The deliveries are `routine.ran` trail rows written
 * with the times a run would have given them, and the reading is the conversation's own read mark.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const conversations = createChannelStore(
  database,
  profiles,
  createThreadIdentity("routine-unread-test"),
);

const run = randomUUID().slice(0, 8);
/**
 * Somebody with no Bot at all. Every test's owner is a person of its own (`ownerOfItsOwn`): an
 * account seats five Bots, and one Bot per test is how each test's pile stays its own.
 */
const STRANGER: AgentActor = { id: `unread-stranger-${run}`, role: "user" };

const DAY = 24 * 60 * 60_000;
/** Friday 2026-09-18, 06:00 UTC — 15:00 in Seoul. */
const NOW = new Date("2026-09-18T06:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const madeBots: Array<{ botId: string; owner: AgentActor }> = [];
const madeOwners: string[] = [];
const madeChannels: string[] = [];
const madeThreads: string[] = [];

beforeAll(async () => {
  await database.insert(users).values({
    id: STRANGER.id,
    email: `${STRANGER.id}@laf.test`,
    name: STRANGER.id,
  });
});

afterAll(async () => {
  const botIds = madeBots.map((made) => made.botId);
  const routines = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(inArray(lafRoutines.agentId, botIds));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, routines));
  await database
    .delete(lafRoutines)
    .where(inArray(lafRoutines.agentId, botIds));
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, madeThreads));
  await database.delete(channels).where(inArray(channels.id, madeChannels));
  for (const { botId, owner } of madeBots) {
    await profiles.softDelete(owner, botId).catch(() => {});
  }
  await database
    .delete(users)
    .where(inArray(users.id, [...madeOwners, STRANGER.id]));
});

/** A person of this test's own, so each test's Bot takes one of their five seats and no more. */
async function ownerOfItsOwn(): Promise<AgentActor> {
  const owner: AgentActor = {
    id: `unread-owner-${run}-${madeOwners.length}`,
    role: "user",
  };
  await database
    .insert(users)
    .values({ id: owner.id, email: `${owner.id}@laf.test`, name: owner.id });
  madeOwners.push(owner.id);
  return owner;
}

/** What the trail was told, for the one audit row this rule writes. */
function trail() {
  const rows: AuditEventInput[] = [];
  return {
    rows,
    store: {
      insert: async (event: AuditEventInput) => {
        rows.push(event);
      },
    },
  };
}

/** A Bot of the owner's, and the conversation its routines deliver into — opened at `openedAt`. */
async function botWithConversation(openedAt: Date | null = daysAgo(30)) {
  const owner = await ownerOfItsOwn();
  const bot = await profiles.create(owner, {
    name: "리뷰봇",
    title: "리뷰 담당",
    roleDescription: "가게 리뷰를 챙긴다.",
  });
  madeBots.push({ botId: bot.id, owner });
  const channel = await conversations.create(owner, [bot.id]);
  madeChannels.push(channel.id);
  madeThreads.push(channel.threadId);
  // The conversation has existed a while; the read mark is set to when the person last looked.
  await database
    .update(channelMemberships)
    .set({ lastReadAt: openedAt, createdAt: daysAgo(40) })
    .where(
      and(
        eq(channelMemberships.channelId, channel.id),
        eq(channelMemberships.userId, owner.id),
      ),
    );
  return { owner, botId: bot.id, channelId: channel.id };
}

function serviceAt(
  clock: { now: Date },
  options: {
    agents?: Record<string, AbstractAgent>;
    auditStore?: { insert: (event: AuditEventInput) => Promise<void> };
  } = {},
) {
  return createRoutineService({
    database,
    resolveAgents: async () => options.agents ?? {},
    ...(options.auditStore ? { auditStore: options.auditStore } : {}),
    timeZone: "Asia/Seoul",
    now: () => clock.now,
  });
}

/**
 * A routine on the Bot. Made a minute before `NOW`, so its clock is not due when a test ticks —
 * only the routine a test sets due is. Its deliveries are backdated; the rule reads those, not this.
 */
async function routineOn(
  owner: AgentActor,
  botId: string,
  name: string,
  schedule:
    | { kind: "daily"; time: string }
    | { kind: "interval"; minutes: number } = {
    kind: "daily",
    time: "07:30",
  },
) {
  const service = serviceAt({ now: new Date(NOW.getTime() - 60_000) });
  return service.create(owner, {
    agentId: botId,
    name,
    instruction: "새 리뷰를 요약해줘",
    schedule,
  });
}

/**
 * One run's `routine.ran` trail row, written `at`: what the rule reads a delivery from.
 *
 * The trail and not the receipts, because receipts are pruned to twenty a routine — a routine that
 * reports every half hour keeps ten hours of them, and its oldest unread result would never look a
 * week old. The trail is append-only, so these rows outlive the test; they name routines only this
 * run made, and nothing else reads them.
 */
async function delivered(
  routineId: string,
  at: Date,
  answer = "새 리뷰 2건: 배송이 빨라요, 포장이 꼼꼼해요.",
  ok = true,
) {
  const silent = ok && answer === "[SILENT]";
  await database.insert(auditEvents).values({
    eventType: "routine.ran",
    targetType: "routine",
    targetId: routineId,
    payload: {
      ok,
      ...(silent ? { silent: true } : {}),
      ...(ok && !silent ? { delivered: true } : {}),
    },
    createdAt: at,
  });
}

async function receiptsOf(routineId: string) {
  const rows = await database
    .select({ id: lafRoutineRuns.id })
    .from(lafRoutineRuns)
    .where(eq(lafRoutineRuns.routineId, routineId));
  return rows.length;
}

async function stored(id: string) {
  const [row] = await database
    .select()
    .from(lafRoutines)
    .where(eq(lafRoutines.id, id));
  if (!row) throw new Error(`no routine ${id}`);
  return row;
}

describe("the rule's two numbers", () => {
  test("are three results and a week", () => {
    expect(UNREAD_PAUSE_DELIVERIES).toBe(3);
    expect(UNREAD_PAUSE_AFTER_MS).toBe(7 * DAY);
  });
});

describe("a Bot whose results pile up unread", () => {
  test("has the routines that delivered them paused, with the reason and when, and one trail row", async () => {
    const { owner, botId, channelId } = await botWithConversation(daysAgo(20));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [9, 8, 2]) await delivered(daily.id, daysAgo(days));
    const audit = trail();

    const paused = await pauseUnreadRoutines({
      database,
      botIds: [botId],
      now: NOW,
      auditStore: audit.store,
    });

    const mine = paused.filter((pause) => pause.agentId === botId);
    expect(mine).toEqual([
      {
        agentId: botId,
        userId: owner.id,
        channelId,
        routineIds: [daily.id],
        unread: 3,
        since: daysAgo(9),
      },
    ]);
    const row = await stored(daily.id);
    expect(row.enabled).toBe(false);
    expect(row.pausedReason).toBe("unread");
    expect(row.pausedAt?.toISOString()).toBe(NOW.toISOString());

    const rows = audit.rows.filter((event) => event.payload.agentId === botId);
    expect(rows).toEqual([
      {
        eventType: "routine.paused_unread",
        targetType: "routine",
        targetId: daily.id,
        actorUserId: owner.id,
        payload: {
          agentId: botId,
          actor: owner.id,
          channelId,
          routineIds: [daily.id],
          count: 1,
          unread: 3,
          since: daysAgo(9).toISOString(),
        },
      },
    ]);
  });

  test("is paused once: a second sweep finds nothing to pause and tells nobody again", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(20));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8]) await delivered(daily.id, daysAgo(days));
    const audit = trail();

    await pauseUnreadRoutines({
      database,
      botIds: [botId],
      now: NOW,
      auditStore: audit.store,
    });
    const again = await pauseUnreadRoutines({
      database,
      botIds: [botId],
      now: new Date(NOW.getTime() + 60_000),
      auditStore: audit.store,
    });

    expect(again.filter((pause) => pause.agentId === botId)).toEqual([]);
    expect(
      audit.rows.filter((event) => event.payload.agentId === botId),
    ).toHaveLength(1);
  });

  test("a routine that reports every half hour is counted from its first unread result, not its last twenty", async () => {
    /*
     * The case the rule exists for most: a routine that says something every run spends the most.
     * Its receipts are pruned to twenty — ten hours — so a rule reading them would never see a
     * result a week old, and the chattiest routine would be the one that never stops.
     */
    const { owner, botId } = await botWithConversation(daysAgo(20));
    const chatty = await routineOn(owner, botId, "주문 확인", {
      kind: "interval",
      minutes: 30,
    });
    for (let hours = 8 * 24; hours > 0; hours -= 6) {
      await delivered(chatty.id, new Date(NOW.getTime() - hours * 3_600_000));
    }

    const [pause] = await pauseUnreadRoutines({
      database,
      botIds: [botId],
      now: NOW,
    });

    expect(pause?.routineIds).toEqual([chatty.id]);
    expect(pause?.unread).toBe(32);
    expect(pause?.since).toEqual(daysAgo(8));
  });

  test("pauses every routine that is part of the pile, and one notice counts them", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(20));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    const weekly = await routineOn(owner, botId, "주간 정산");
    await delivered(daily.id, daysAgo(8));
    await delivered(daily.id, daysAgo(1));
    await delivered(weekly.id, daysAgo(5));
    const audit = trail();

    const [pause] = (
      await pauseUnreadRoutines({
        database,
        botIds: [botId],
        now: NOW,
        auditStore: audit.store,
      })
    ).filter((one) => one.agentId === botId);

    expect(pause?.routineIds.sort()).toEqual([daily.id, weekly.id].sort());
    expect(pause?.unread).toBe(3);
    const [row] = audit.rows.filter((event) => event.payload.agentId === botId);
    expect(row?.payload.count).toBe(2);
  });
});

describe("what does not count as a pile", () => {
  test("two unread results, however old", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [20, 15]) await delivered(daily.id, daysAgo(days));

    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });
    expect((await stored(daily.id)).enabled).toBe(true);
  });

  test("three results whose oldest has waited less than a week", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [6, 5, 4, 3, 2, 1]) {
      await delivered(daily.id, daysAgo(days));
    }

    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });
    expect((await stored(daily.id)).enabled).toBe(true);
  });

  test("results the person has read: the read mark is after them", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(1));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8, 7, 6, 5, 4, 3, 2]) {
      await delivered(daily.id, daysAgo(days));
    }

    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });
    expect((await stored(daily.id)).enabled).toBe(true);
  });

  test("a run that said nothing, or failed, delivered nothing to read", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const monitor = await routineOn(owner, botId, "별점 1점 감시", {
      kind: "interval",
      minutes: 30,
    });
    for (const days of [20, 15, 10, 9]) {
      await delivered(monitor.id, daysAgo(days), "[SILENT]");
    }
    await delivered(monitor.id, daysAgo(8), "", false);
    await delivered(monitor.id, daysAgo(7.5), "", false);
    await delivered(monitor.id, daysAgo(7.2), "", false);

    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });
    expect((await stored(monitor.id)).enabled).toBe(true);
  });

  test("a Bot with no conversation: nothing was delivered anywhere, and reading cannot be measured", async () => {
    const owner = await ownerOfItsOwn();
    const bot = await profiles.create(owner, {
      name: "대화 없는 봇",
      title: "",
      roleDescription: "",
    });
    madeBots.push({ botId: bot.id, owner });
    const botId = bot.id;
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8]) await delivered(daily.id, daysAgo(days));

    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });
    expect((await stored(daily.id)).enabled).toBe(true);
  });
});

describe("what the rule never pauses", () => {
  test("a routine the person told to keep running, whose results do not count either", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const kept = await routineOn(owner, botId, "매일 매출 기록");
    const quiet = await routineOn(owner, botId, "주간 정산");
    await database
      .update(lafRoutines)
      .set({ keepRunning: true })
      .where(eq(lafRoutines.id, kept.id));
    for (const days of [20, 15, 10, 9, 8]) {
      await delivered(kept.id, daysAgo(days));
    }
    // One result of the other routine, sitting in the same unread conversation.
    await delivered(quiet.id, daysAgo(8));

    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });

    // The person said the first may pile up; that is not evidence against the second.
    expect((await stored(kept.id)).enabled).toBe(true);
    expect((await stored(quiet.id)).enabled).toBe(true);
  });

  test("a routine on the same Bot that delivered nothing unread — a silent monitor keeps watching", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const digest = await routineOn(owner, botId, "아침 리뷰 요약");
    const monitor = await routineOn(owner, botId, "별점 1점 감시", {
      kind: "interval",
      minutes: 30,
    });
    for (const days of [10, 9, 8]) await delivered(digest.id, daysAgo(days));
    await delivered(monitor.id, daysAgo(9), "[SILENT]");

    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });

    expect((await stored(digest.id)).enabled).toBe(false);
    expect((await stored(monitor.id)).enabled).toBe(true);
  });

  test("a routine its person switched off stays theirs: not paused, not given a reason", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8]) await delivered(daily.id, daysAgo(days));
    await serviceAt({ now: daysAgo(1) }).setEnabled(owner, daily.id, false);

    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });
    expect((await stored(daily.id)).pausedReason).toBeNull();
  });
});

describe("turning it back on", () => {
  test("by its switch clears the reason, and the old pile does not pause it again", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8]) await delivered(daily.id, daysAgo(days));
    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });

    const clock = { now: new Date(NOW.getTime() + 60 * 60_000) };
    const back = await serviceAt(clock).setEnabled(owner, daily.id, true);
    expect(back.enabled).toBe(true);
    expect(back.pausedReason).toBeNull();
    expect(back.pausedAt).toBeNull();

    // The conversation is still unread — turning a routine on is not reading it — and the rule
    // counts from the moment it was turned back on.
    const audit = trail();
    const again = await pauseUnreadRoutines({
      database,
      botIds: [botId],
      now: new Date(clock.now.getTime() + 60_000),
      auditStore: audit.store,
    });
    expect(again.filter((pause) => pause.agentId === botId)).toEqual([]);
    expect((await stored(daily.id)).enabled).toBe(true);
  });

  test("and a fresh pile a week after that is a fresh pause, told again", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [29, 28, 27]) await delivered(daily.id, daysAgo(days));
    await pauseUnreadRoutines({ database, botIds: [botId], now: daysAgo(20) });
    expect((await stored(daily.id)).pausedReason).toBe("unread");
    await serviceAt({ now: daysAgo(19) }).setEnabled(owner, daily.id, true);
    for (const days of [12, 10, 5]) await delivered(daily.id, daysAgo(days));
    const audit = trail();

    const [pause] = (
      await pauseUnreadRoutines({
        database,
        botIds: [botId],
        now: NOW,
        auditStore: audit.store,
      })
    ).filter((one) => one.agentId === botId);

    expect(pause?.unread).toBe(3);
    expect(pause?.since).toEqual(daysAgo(12));
    expect(
      audit.rows.filter((event) => event.payload.agentId === botId),
    ).toHaveLength(1);
  });

  test("switching it off by hand also clears the rule's reason — the decision is the person's now", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8]) await delivered(daily.id, daysAgo(days));
    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });

    const off = await serviceAt({ now: NOW }).setEnabled(
      owner,
      daily.id,
      false,
    );
    expect(off.pausedReason).toBeNull();
  });
});

describe("다시 켜기 and 계속 돌리기, for one Bot at a time", () => {
  test("다시 켜기 turns on the routines the rule paused on that Bot, and only those", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const paused = await routineOn(owner, botId, "아침 리뷰 요약");
    const offByHand = await routineOn(owner, botId, "주간 정산");
    for (const days of [10, 9, 8]) await delivered(paused.id, daysAgo(days));
    await serviceAt({ now: daysAgo(2) }).setEnabled(owner, offByHand.id, false);
    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });

    const clock = { now: new Date(NOW.getTime() + 60 * 60_000) };
    const resumed = await serviceAt(clock).resumePaused(owner, botId, {
      keepRunning: false,
    });

    expect(resumed.map((routine) => routine.id)).toEqual([paused.id]);
    const row = await stored(paused.id);
    expect(row).toMatchObject({
      enabled: true,
      pausedReason: null,
      pausedAt: null,
      keepRunning: false,
    });
    expect(row.resumedAt?.toISOString()).toBe(clock.now.toISOString());
    // Re-armed from now: a routine paused for a week does not fire a backlog.
    expect(row.nextRunAt.getTime()).toBeGreaterThan(clock.now.getTime());
    // The one the person switched off stays off.
    expect((await stored(offByHand.id)).enabled).toBe(false);
  });

  test("계속 돌리기 turns them on and exempts them from the rule for good", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8]) await delivered(daily.id, daysAgo(days));
    await pauseUnreadRoutines({ database, botIds: [botId], now: NOW });

    await serviceAt({ now: NOW }).resumePaused(owner, botId, {
      keepRunning: true,
    });
    for (const days of [-8, -9, -10]) await delivered(daily.id, daysAgo(days));

    await pauseUnreadRoutines({ database, botIds: [botId], now: daysAgo(-20) });
    expect(await stored(daily.id)).toMatchObject({
      enabled: true,
      keepRunning: true,
      pausedReason: null,
    });
  });

  test("somebody else's Bot is not there", async () => {
    const { botId } = await botWithConversation(daysAgo(30));
    await expect(
      serviceAt({ now: NOW }).resumePaused(STRANGER, botId, {
        keepRunning: true,
      }),
    ).rejects.toMatchObject({ status: 404, code: "laf:bot_not_found" });
  });

  test("keep-running on one routine is a switch of its own, off as well as on", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    const service = serviceAt({ now: NOW });

    expect(
      (await service.setKeepRunning(owner, daily.id, true)).keepRunning,
    ).toBe(true);
    expect(
      (await service.setKeepRunning(owner, daily.id, false)).keepRunning,
    ).toBe(false);
    await expect(
      service.setKeepRunning(STRANGER, daily.id, true),
    ).rejects.toMatchObject({ status: 404, code: "laf:routine_not_found" });
  });
});

describe("on the clock", () => {
  test("a due routine on a Bot nobody reads is paused instead of run", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8]) await delivered(daily.id, daysAgo(days));
    await database
      .update(lafRoutines)
      .set({ nextRunAt: new Date(NOW.getTime() - 30_000) })
      .where(eq(lafRoutines.id, daily.id));
    const asked: string[] = [];
    const agent = {
      setMessages(messages: { content?: string }[]) {
        asked.push(messages[0]?.content ?? "");
      },
      async runAgent() {
        return {
          result: undefined,
          newMessages: [{ id: "m", role: "assistant", content: "요약" }],
        };
      },
    } as unknown as AbstractAgent;
    const audit = trail();

    await serviceAt(
      { now: NOW },
      { agents: { [botId]: agent }, auditStore: audit.store },
    ).tick();

    // Not asked, and no run recorded: the pause came before the claim, and the claim asks for a
    // routine that is on.
    expect(asked).toEqual([]);
    expect(await receiptsOf(daily.id)).toBe(0);
    expect((await stored(daily.id)).pausedReason).toBe("unread");
    expect(
      audit.rows
        .filter((event) => event.payload.agentId === botId)
        .map((event) => event.eventType),
    ).toEqual(["routine.paused_unread"]);
  });

  test("a due routine on a Bot that is read runs as it always did", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(1));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    for (const days of [10, 9, 8]) await delivered(daily.id, daysAgo(days));
    await database
      .update(lafRoutines)
      .set({ nextRunAt: new Date(NOW.getTime() - 30_000) })
      .where(eq(lafRoutines.id, daily.id));
    const agent = {
      setMessages() {},
      async runAgent() {
        return {
          result: undefined,
          newMessages: [{ id: "m", role: "assistant", content: "요약" }],
        };
      },
    } as unknown as AbstractAgent;

    await serviceAt({ now: NOW }, { agents: { [botId]: agent } }).tick();

    expect(await receiptsOf(daily.id)).toBe(1);
    expect((await stored(daily.id)).enabled).toBe(true);
  });
});

describe("what a run's trail row says", () => {
  test("a run whose answer landed in the conversation says so, and a silent one does not", async () => {
    /*
     * The trail row is what the rule counts, so it has to say the one thing the rule asks: did this
     * run put something in front of the person. `ok` alone does not — a `[SILENT]` run is ok and
     * delivered nothing.
     */
    const { owner, botId, channelId } = await botWithConversation(daysAgo(1));
    const daily = await routineOn(owner, botId, "아침 리뷰 요약");
    const replies = ["새 리뷰 1건: 맛있어요.", "[SILENT]"];
    const agent = {
      setMessages() {},
      async runAgent() {
        return {
          result: undefined,
          newMessages: [
            {
              id: randomUUID(),
              role: "assistant",
              content: replies.shift() ?? "",
            },
          ],
        };
      },
    } as unknown as AbstractAgent;
    const audit = trail();
    const service = createRoutineService({
      database,
      resolveAgents: async () => ({ [botId]: agent }),
      auditStore: audit.store,
      timeZone: "Asia/Seoul",
      now: () => NOW,
      // What the real delivery answers when the message went in; see `routines/deliver.ts`.
      deliver: async () => ({
        channelId,
        threadId: "thread",
        announce: () => {},
      }),
    });

    await service.runNow(owner, daily.id);
    await service.runNow(owner, daily.id);

    expect(
      audit.rows
        .filter(
          (event) =>
            event.eventType === "routine.ran" && event.targetId === daily.id,
        )
        .map((event) => ({
          delivered: event.payload.delivered === true,
          silent: event.payload.silent === true,
        })),
    ).toEqual([
      { delivered: true, silent: false },
      { delivered: false, silent: true },
    ]);
  });
});

/**
 * A RUN SOMEBODY STOPPED IS NOT A RESULT THEY DID NOT READ. 2026-09-18, on the day both landed.
 *
 * `모두 멈추기` settles a routine's run as stopped: not ok, no failure code, nothing delivered
 * (`routines/settlement.ts`). The rule counts `routine.ran` rows that say `delivered: true`, so a
 * stopped run can only move a routine toward a pause if its row said that — and a person who pressed
 * stop on a routine would then have it paused a week later as though its results had piled up.
 * Measured through the real stop and the real trail rather than a row written by hand.
 */
describe("a run stopped with 모두 멈추기", () => {
  test("is not counted as a delivered result, so it does not move a routine toward the pause", async () => {
    const { owner, botId } = await botWithConversation(daysAgo(30));
    const routine = await routineOn(owner, botId, "주문 정리", {
      kind: "interval",
      minutes: 60,
    });
    // Two real results, both unread and over a week old: one short of the pause.
    const real = new Date();
    const before = (days: number) => new Date(real.getTime() - days * DAY);
    await delivered(routine.id, before(10));
    await delivered(routine.id, before(9));

    // A Bot still thinking when the person stops everything.
    let asked = 0;
    let release: (() => void) | undefined;
    const thinking = {
      messages: [] as Message[],
      setMessages(messages: Message[]) {
        thinking.messages = [...messages];
      },
      addMessage(message: Message) {
        thinking.messages.push(message);
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
    const bot = thinking as unknown as AbstractAgent;
    const work = createWorkInFlight();
    const service = createRoutineService({
      database,
      resolveAgents: async () => ({ [botId]: bot }),
      // The real trail: the rule reads what `run-report.ts` actually wrote.
      auditStore: createAuditStore(database),
      tools: async () => ({ tools: [], execute: async () => ({ ok: true }) }),
      lane: createBotLane(),
      work,
    });

    const running = service.runNow(owner, routine.id);
    const deadline = Date.now() + 5_000;
    while (asked === 0 && Date.now() < deadline) await Bun.sleep(10);
    for (const entry of work.of(owner.id)) await entry.stop();
    await running;

    const [ran] = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "routine.ran"),
          eq(auditEvents.targetId, routine.id),
          gt(auditEvents.createdAt, before(1)),
        ),
      );
    expect(ran?.payload).toMatchObject({ ok: false, stopped: true });
    expect(ran?.payload).not.toHaveProperty("delivered");

    // Two results, however old, are not a pile: the stop did not make it three.
    expect(
      await pauseUnreadRoutines({ database, botIds: [botId], now: real }),
    ).toEqual([]);
    expect((await stored(routine.id)).enabled).toBe(true);

    // And a third real one is — which is what the stopped run was one short of being.
    await delivered(routine.id, before(1));
    const [pause] = await pauseUnreadRoutines({
      database,
      botIds: [botId],
      now: real,
    });
    expect(pause?.unread).toBe(3);
  });
});
