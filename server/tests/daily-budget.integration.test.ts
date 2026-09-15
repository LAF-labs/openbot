import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { loadConfig } from "../src/config";
import { buildAgents } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  lafThreadMessages,
  lafThreadRuns,
} from "../src/db/schema";
import { LafPostgresRunner } from "../src/runner/laf-runner";
import { createRunLedger } from "../src/runner/run-ledger";
import {
  createDailyBudget,
  dailyBudgetFor,
  seoulDayOf,
} from "../src/usage/daily-budget";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * What a trial may spend in a day, counted where the product already counts it.
 *
 * The judge reads `audit_events`: every `model.usage` row written in the Seoul day `now` falls in,
 * summed on `totalTokens` (self-serve contract §4.6). Three things about that sentence are easy to
 * get wrong and invisible from a green run elsewhere — which day (Seoul's, whatever the host's
 * clock says), which rows (usage, and nothing that merely carries a number with the same name), and
 * what a trail that cannot be read means (not a refusal: telling somebody they used up their day is
 * a sentence only a count may say).
 *
 * WHY THE ROWS LIVE IN JUNE 2003, AND WHY NOTHING HERE IS DELETED. `audit_events` is append-only and
 * shared by every suite, so no count over a day can be asserted exactly. Each reading is taken before
 * and after the rows this file writes and the difference is asserted, in days nothing else writes to:
 * after the insights suite's era (before 2000) and far behind today's rows. The retention sweep other
 * files run removes them in time; nothing here needs to.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const HOUR = 3_600_000;

/** A wall-clock reading in Seoul, as the instant it names. Seoul has kept no summer time since 1988. */
const seoul = (wall: string) => new Date(Date.parse(`${wall}Z`) - 9 * HOUR);

async function usageAt(
  at: Date,
  totalTokens: unknown,
  eventType = "model.usage",
): Promise<void> {
  await database.insert(auditEvents).values({
    eventType,
    targetType: "agent",
    targetId: `daily-budget-${suite}`,
    payload: { totalTokens, source: "bot-turn", suite },
    createdAt: at,
  });
}

const budgetAt = (wall: string, tokens = 1_000_000_000) =>
  createDailyBudget({ database, tokens, now: () => seoul(wall) });

const agentIds: string[] = [];
const threadIds: string[] = [];

afterAll(async () => {
  for (const threadId of threadIds) {
    await database
      .delete(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, threadId));
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  if (agentIds.length > 0) {
    await database.delete(agents).where(inArray(agents.id, agentIds));
  }
  await database.$client.end();
});

describe("which day is today", () => {
  test("the Seoul day, from its midnight to the next", () => {
    expect(seoulDayOf(new Date("2026-09-15T14:59:59.999Z"))).toEqual({
      start: new Date("2026-09-14T15:00:00.000Z"),
      end: new Date("2026-09-15T15:00:00.000Z"),
    });
    expect(seoulDayOf(new Date("2026-09-15T15:00:00.000Z"))).toEqual({
      start: new Date("2026-09-15T15:00:00.000Z"),
      end: new Date("2026-09-16T15:00:00.000Z"),
    });
  });

  test("across a month and a year, where a UTC day and a Seoul day disagree most", () => {
    // 2027-01-01 00:30 in Seoul is still 2026-12-31 in UTC.
    expect(seoulDayOf(new Date("2026-12-31T15:30:00.000Z")).start).toEqual(
      new Date("2026-12-31T15:00:00.000Z"),
    );
    expect(seoulDayOf(new Date("2026-02-28T16:00:00.000Z")).end).toEqual(
      new Date("2026-03-01T15:00:00.000Z"),
    );
  });
});

describe("today's count", () => {
  test("is the Seoul day's model.usage rows, and nothing either side of midnight", async () => {
    const yesterday = budgetAt("2003-06-14T18:00:00.000");
    const today = budgetAt("2003-06-15T12:00:00.000");
    const tomorrow = budgetAt("2003-06-16T06:00:00.000");
    const before = {
      yesterday: await yesterday.usedToday(),
      today: await today.usedToday(),
      tomorrow: await tomorrow.usedToday(),
    };

    await usageAt(seoul("2003-06-14T23:59:59.999"), 1000);
    await usageAt(seoul("2003-06-15T00:00:00.000"), 20);
    await usageAt(seoul("2003-06-15T23:59:59.999"), 300);
    await usageAt(seoul("2003-06-16T00:00:00.000"), 4000);
    // A number with the same name on another row is not usage.
    await usageAt(seoul("2003-06-15T12:00:00.000"), 50_000, "coworker.asked");
    // A count that crossed a service boundary malformed is nothing, not a failed read.
    await usageAt(seoul("2003-06-15T13:00:00.000"), "many");
    await usageAt(seoul("2003-06-15T13:00:00.000"), -7);

    expect({
      yesterday: (await yesterday.usedToday()) - before.yesterday,
      today: (await today.usedToday()) - before.today,
      tomorrow: (await tomorrow.usedToday()) - before.tomorrow,
    }).toEqual({ yesterday: 1000, today: 320, tomorrow: 4000 });
  });

  test("reaches the budget when it meets it, not a token before", async () => {
    const reading = budgetAt("2003-06-20T09:00:00.000");
    const before = await reading.usedToday();
    await usageAt(seoul("2003-06-20T08:00:00.000"), 320);

    expect(
      await budgetAt("2003-06-20T09:00:00.000", before + 320).reachedToday(),
    ).toBe(true);
    expect(
      await budgetAt("2003-06-20T09:00:00.000", before + 321).reachedToday(),
    ).toBe(false);
    // And at the next midnight the day is new, whatever yesterday spent.
    const next = await budgetAt("2003-06-21T00:00:00.000").usedToday();
    expect(
      await budgetAt("2003-06-21T00:00:00.000", next + 1).reachedToday(),
    ).toBe(false);
  });

  test("a trail that cannot be read is not a refusal", async () => {
    const unreachable = createDatabase(
      "postgres://nobody:nobody@127.0.0.1:1/nothing",
      { max: 1 },
    );
    try {
      const budget = createDailyBudget({ database: unreachable, tokens: 1 });
      expect(await budget.reachedToday()).toBe(false);
    } finally {
      await unreachable.$client.end().catch(() => undefined);
    }
  });
});

describe("which deployments are judged at all", () => {
  test("a trial is, on the budget its .env gave it", () => {
    const trial = loadConfig(
      testEnvironment({
        LAF_PLAN: "trial",
        LAF_TRIAL_ENDS_AT: "2026-09-29T14:59:59Z",
        LAF_TRIAL_HOLD_DAYS: "30",
        LAF_DAILY_TOKEN_BUDGET: "3000000",
      }),
    ).trial;
    expect(dailyBudgetFor(trial, database)?.tokens).toBe(3_000_000);
  });

  test("a deployment that is not a trial never is", () => {
    expect(
      dailyBudgetFor(loadConfig(testEnvironment()).trial, database),
    ).toBeUndefined();
  });
});

/**
 * A Bot endpoint that says one thing and reports what it cost, as `agent-bot` streams it.
 *
 * Reached through the agent's own fetch rather than a socket, the way `effort-on-the-wire` reaches
 * `agent-bot`: the request the endpoint receives is the assertion.
 */
function endpoint() {
  const received: Array<{ runId?: string; threadId?: string }> = [];
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as {
      runId?: string;
      threadId?: string;
    };
    received.push(body);
    const messageId = `said-${body.runId}`;
    const events = [
      { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
      {
        type: "CUSTOM",
        name: "laf.model.usage",
        value: {
          model: "laf-1",
          promptTokens: 900,
          completionTokens: 34,
          totalTokens: 934,
        },
      },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "주문은 3건이에요." },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  return { received, fetch };
}

describe("what a chat turn costs, written once", () => {
  /*
   * The runtime drives a chat turn through `LafPostgresRunner`, which used to write the usage row
   * itself — while a routine, a room and a coworker, which never pass through it, wrote none. The
   * row is now written at the one seam every run shares, so this is the path that could count twice.
   */
  test("through the runner the endpoint is driven by, one model.usage row per usage event", async () => {
    const agentId = `daily-budget-bot-${suite}`;
    await database.insert(agents).values({
      id: agentId,
      name: agentId,
      type: "remote_ag_ui",
      configuration: {},
    });
    agentIds.push(agentId);
    const threadId = `daily-budget-thread-${suite}`;
    threadIds.push(threadId);
    const runId = `daily-budget-run-${suite}`;

    const rows: AuditEventInput[] = [];
    const { received, fetch } = endpoint();
    const built = buildAgents(
      [
        {
          id: agentId,
          name: "미소",
          type: "remote_ag_ui",
          endpoint: "http://agent-bot.internal/ag-ui",
          profile: {
            id: agentId,
            name: "미소",
            title: "",
            roleDescription: "",
          },
          effort: "balanced",
        },
      ],
      { provider: "openai", defaultModel: "laf-1", supportsEffort: false },
      { watch: () => fetch as never, stop: () => undefined },
      "Asia/Seoul",
      undefined,
      { auditStore: { insert: async (event) => void rows.push(event) } },
    );
    const agent = built[agentId];
    if (!agent) throw new Error("the agent was not built");
    // What the runtime's handler does: run a copy of the registered agent.
    const copy = agent.clone();
    copy.threadId = threadId;

    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
    );
    const messages = [
      { id: `ask-${suite}`, role: "user" as const, content: "주문 확인해줘" },
    ];
    copy.setMessages(messages);
    const events = runner.run({
      threadId,
      agent: copy,
      input: {
        threadId,
        runId,
        messages,
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    });
    await new Promise<void>((resolve) => {
      events.subscribe({ complete: resolve, error: () => resolve() });
    });

    // The ledger settles after the stream completes; wait for it rather than for a clock.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [run] = await database
        .select({ status: lafThreadRuns.status })
        .from(lafThreadRuns)
        .where(eq(lafThreadRuns.runId, runId));
      if (run?.status === "done") break;
      if (Date.now() > deadline) throw new Error("the run never settled");
      await Bun.sleep(25);
    }

    expect(received).toHaveLength(1);
    const usage = rows.filter((row) => row.eventType === "model.usage");
    expect(usage).toEqual([
      {
        eventType: "model.usage",
        targetType: "agent",
        targetId: agentId,
        payload: {
          runId,
          threadId,
          botId: agentId,
          model: "laf-1",
          promptTokens: 900,
          completionTokens: 34,
          totalTokens: 934,
          source: "bot-turn",
        },
      },
    ]);
  });
});
