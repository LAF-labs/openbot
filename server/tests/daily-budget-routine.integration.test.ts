import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { TURN_FAILURE_CODES } from "../src/channels/turn-failures";
import { buildAgents } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agents, lafRoutineRuns, lafRoutines, users } from "../src/db/schema";
import { createRoutineService } from "../src/routines/service";
import type { DailyBudget } from "../src/usage/daily-budget";
import { TEST_POOL } from "./support/database";

/**
 * A routine on a spent day, through the service that fires it on the clock.
 *
 * `daily-budget-seam.test.ts` shows the loop refused. This is the rest of the road a routine takes in
 * production — the tools it is handed, the settlement, the `routine.ran` row the notification and the
 * record are read from — so a refusal that the loop said and the record then filed as "no answer
 * came back" would fail here, where a person would have met it.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const AUTHOR = { id: `daily-budget-author-${suite}`, role: "user" as const };
const BOT = `daily-budget-routine-bot-${suite}`;

beforeAll(async () => {
  await database.insert(agents).values({
    id: BOT,
    name: "아침 봇",
    type: "remote_ag_ui",
    configuration: {},
  });
  await database
    .insert(users)
    .values({ id: AUTHOR.id, email: `${AUTHOR.id}@laf.test`, name: "사장님" });
});

afterAll(async () => {
  // Only what this file made, and the rows that point at it first.
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
  // Its notifications cascade with the person.
  await database.delete(users).where(eq(users.id, AUTHOR.id));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.$client.end();
});

describe("a routine fired on a day the trial has spent", () => {
  test("never reaches the Bot, and its record says the day is spent", async () => {
    const received: unknown[] = [];
    const spent: DailyBudget = {
      tokens: 3_000_000,
      usedToday: async () => 3_000_000,
      reachedToday: async () => true,
    };
    const built = buildAgents(
      [
        {
          id: BOT,
          name: "아침 봇",
          type: "remote_ag_ui",
          endpoint: "http://agent-bot.internal/ag-ui",
          profile: { id: BOT, name: "아침 봇", title: "", roleDescription: "" },
          effort: "balanced",
        },
      ],
      { provider: "openai", defaultModel: "laf-1", supportsEffort: false },
      {
        watch: () =>
          (async (_url: string, init: RequestInit) => {
            received.push(init.body);
            return new Response("", { status: 500 });
          }) as never,
        stop: () => undefined,
      },
      "Asia/Seoul",
      undefined,
      { dailyBudget: spent },
    );

    const rows: AuditEventInput[] = [];
    let clock = new Date("2026-09-20T22:00:00Z");
    const service = createRoutineService({
      database,
      resolveAgents: async () => built,
      auditStore: { insert: async (event) => void rows.push(event) },
      // The production shape: a routine is an agent turn with tools, not a toolless question.
      tools: async () => ({ tools: [], execute: async () => ({ ok: true }) }),
      now: () => clock,
      runTimeoutMs: 10_000,
    });

    const routine = await service.create(AUTHOR, {
      agentId: BOT,
      name: "아침 주문 요약",
      instruction: "밤사이 들어온 주문을 요약해줘",
      schedule: { kind: "interval", minutes: 30 },
    });
    if (!routine) throw new Error("the routine was not created");

    clock = new Date("2026-09-20T22:31:00Z");
    expect(await service.tick()).toBe(1);

    expect(received).toEqual([]);
    const ran = rows.find((row) => row.eventType === "routine.ran");
    expect(ran?.payload).toMatchObject({
      ok: false,
      failure: TURN_FAILURE_CODES.dailyBudgetReached,
    });
    const [run] = await service.runs(AUTHOR, routine.id);
    expect(run?.ok).toBe(false);
  });
});
