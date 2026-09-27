/**
 * 목표, AGAINST THE REAL TABLES (muse-shape plan §3.4, phase 9).
 *
 * A goal is written only after the person's yes, through a chat turn's own tools; progress lands on
 * its timeline from the conversation and from the run of a routine linked to it; the page's reads,
 * presses and deletion are the person's own; and the linked routine outlives the goal, unlinked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { GOALS_ACTIVE_MAX } from "../../shared/goals";
import { LOG_PROGRESS, SAVE_GOAL, UPDATE_GOAL } from "../../shared/tools/goals";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { lafGoals, lafRoutines, users } from "../src/db/schema";
import { createGoalRoutes } from "../src/goals/routes";
import { createGoalStore } from "../src/goals/store";
import { goalApprovals, goalTools, withGoal } from "../src/goals/tools";
import { createRoutineService } from "../src/routines/service";
import { createChatTools } from "../src/turns/chat-tools";
import { createPersonAnswers } from "../src/turns/people";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createGoalStore({ database });
const tag = randomUUID().slice(0, 8);
const made = {
  owners: [] as string[],
  bots: [] as Array<{ botId: string; owner: AgentActor }>,
};

async function personWithBot() {
  const owner: AgentActor = {
    id: `goal-owner-${tag}-${made.owners.length}`,
    role: "user",
  };
  await database
    .insert(users)
    .values({ id: owner.id, email: `${owner.id}@laf.test`, name: owner.id });
  made.owners.push(owner.id);
  const bot = await profiles.create(owner, {
    name: "새벽",
    roleDescription: "",
  });
  made.bots.push({ botId: bot.id, owner });
  return { owner, botId: bot.id };
}

const TOEIC = {
  category: "study",
  title: "12월 토익 800",
  target: "12월 정기시험에서 800점 이상",
  dueOn: "2026-12-13",
  measure: { unit: "점", start: 720, goal: 800 },
};

/** A turn's tools with a yes already collected on a card naming `title`. */
function turnWithYes(userId: string, agentId: string, title?: string) {
  const approvals = goalApprovals();
  if (title) {
    approvals.approved({
      title: "이 목표로 할까요?",
      summary: title,
      details: [{ label: "마감", value: "12월 13일" }],
    });
  }
  return goalTools({ store, userId, agentId, runId: `turn-${tag}`, approvals });
}

let A: Awaited<ReturnType<typeof personWithBot>>;
let B: Awaited<ReturnType<typeof personWithBot>>;

beforeAll(async () => {
  A = await personWithBot();
  B = await personWithBot();
});

afterAll(async () => {
  const botIds = made.bots.map((one) => one.botId);
  await database.delete(lafGoals).where(inArray(lafGoals.agentId, botIds));
  await database
    .delete(lafRoutines)
    .where(inArray(lafRoutines.agentId, botIds));
  for (const { botId, owner } of made.bots) {
    await profiles.softDelete(owner, botId).catch(() => {});
  }
  await database.delete(users).where(inArray(users.id, made.owners));
});

describe("a goal is saved only after the person's yes", () => {
  test("no yes in the turn: refused with laf:goal_needs_yes, and no row", async () => {
    const outcome = await turnWithYes(A.owner.id, A.botId).execute(
      SAVE_GOAL,
      TOEIC,
    );
    expect(outcome.code).toBe("laf:goal_needs_yes");
    expect(await store.list(A.owner.id)).toEqual([]);
  });

  test("a yes on a card naming another goal saves nothing", async () => {
    const outcome = await turnWithYes(
      A.owner.id,
      A.botId,
      "매일 만 보 걷기",
    ).execute(SAVE_GOAL, TOEIC);
    expect(outcome.code).toBe("laf:goal_needs_yes");
    expect(await store.list(A.owner.id)).toEqual([]);
  });

  test("the yes saves it once; a second save on the same yes is refused", async () => {
    const tools = turnWithYes(A.owner.id, A.botId, "12월 토익 800점");
    const saved = await tools.execute(SAVE_GOAL, TOEIC);
    expect(saved.code).toBe("laf:goal_saved");
    const again = await tools.execute(SAVE_GOAL, TOEIC);
    expect(again.code).toBe("laf:goal_needs_yes");
    const [goal] = await store.list(A.owner.id);
    expect(goal).toMatchObject({
      category: "study",
      title: "12월 토익 800",
      dueOn: "2026-12-13",
      status: "active",
      measure: { unit: "점", start: 720, goal: 800 },
    });
  });

  test("a malformed call is told what is wrong and does not spend the yes", async () => {
    const tools = turnWithYes(B.owner.id, B.botId, "12월 토익 800");
    const bad = await tools.execute(SAVE_GOAL, { ...TOEIC, category: "hobby" });
    expect(bad).toMatchObject({ code: "laf:goal_invalid", field: "category" });
    const late = await tools.execute(SAVE_GOAL, { ...TOEIC, dueOn: "12월" });
    expect(late).toMatchObject({ code: "laf:goal_invalid", field: "dueOn" });
    expect((await tools.execute(SAVE_GOAL, TOEIC)).code).toBe("laf:goal_saved");
  });

  test("never more active than the limit, counted when written", async () => {
    const approvals = goalApprovals();
    const tools = goalTools({
      store,
      userId: B.owner.id,
      agentId: B.botId,
      runId: "turn",
      approvals,
    });
    // B has one already.
    for (let index = 1; index < GOALS_ACTIVE_MAX; index += 1) {
      approvals.approved({ title: `목표 ${index}번` });
      const saved = await tools.execute(SAVE_GOAL, {
        category: "life",
        title: `목표 ${index}번`,
        target: "하기",
      });
      expect(saved.code).toBe("laf:goal_saved");
    }
    approvals.approved({ title: "목표 넘침" });
    const full = await tools.execute(SAVE_GOAL, {
      category: "life",
      title: "목표 넘침",
      target: "하기",
    });
    expect(full.code).toBe("laf:goals_full");
    const extras = (await store.list(B.owner.id)).filter((goal) =>
      goal.title.startsWith("목표 "),
    );
    for (const goal of extras) await store.remove(B.owner.id, goal.id);
  });
});

describe("the chat turn carries the yes to the save", () => {
  test("askApproval answered 예, then save_goal, through the turn's own tools — offered though no window declared them", async () => {
    const C = await personWithBot();
    const people = createPersonAnswers();
    const components = {
      listForAgent: async () => [
        {
          name: "askApproval",
          title: "Approve",
          kind: "decision",
          description: "d",
        },
      ],
      decide: async () => ({ allowed: true as const, description: "d" }),
      mayCall: async () => true,
    };
    const toolkit = await createChatTools({ people, components, goals: store })(
      {
        botId: C.botId,
        owner: C.owner,
        threadId: `thread-${tag}`,
        runId: `run-${tag}`,
      },
      [{ name: "askApproval", description: "d", parameters: {} }],
    );
    expect(toolkit.tools.map((tool) => tool.name)).toContain(SAVE_GOAL);
    const signal = new AbortController().signal;
    // Before any card: refused.
    const early = await toolkit.execute(SAVE_GOAL, TOEIC, {
      id: "s-0",
      signal,
    });
    expect(JSON.stringify(early)).toContain("laf:goal_needs_yes");
    // A declined card is not a yes.
    const declined = toolkit.execute(
      "askApproval",
      { title: TOEIC.title, summary: TOEIC.target },
      { id: "a-1", signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    people.answer(`thread-${tag}`, "a-1", { decision: "declined" });
    await declined;
    const refused = await toolkit.execute(SAVE_GOAL, TOEIC, {
      id: "s-1",
      signal,
    });
    expect(JSON.stringify(refused)).toContain("laf:goal_needs_yes");
    // The person's 예.
    const approved = toolkit.execute(
      "askApproval",
      { title: TOEIC.title, summary: TOEIC.target },
      { id: "a-2", signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    people.answer(`thread-${tag}`, "a-2", { decision: "approved" });
    await approved;
    const saved = await toolkit.execute(SAVE_GOAL, TOEIC, {
      id: "s-2",
      signal,
    });
    expect(JSON.stringify(saved)).toContain("laf:goal_saved");
    expect((await store.list(C.owner.id)).map((goal) => goal.title)).toEqual([
      TOEIC.title,
    ]);
  });
});

describe("progress on the timeline", () => {
  test("what the person said in chat lands as a bot entry with its momentum; the goal takes the momentum", async () => {
    const [goal] = await store.active(A.owner.id, A.botId);
    if (!goal) throw new Error("no goal");
    const tools = turnWithYes(A.owner.id, A.botId);
    const logged = await tools.execute(LOG_PROGRESS, {
      goal: goal.id,
      text: "오늘 단어 30개",
      momentum: "on_track",
    });
    expect(logged.code).toBe("laf:goal_logged");
    // By its title's words too.
    const byTitle = await tools.execute(LOG_PROGRESS, {
      goal: "12월 토익 800",
      text: "모의고사 760점",
      value: 760,
    });
    expect(byTitle.code).toBe("laf:goal_logged");
    const detail = await store.get(A.owner.id, goal.id);
    expect(detail?.entries.map((entry) => [entry.text, entry.source])).toEqual([
      ["모의고사 760점", "bot"],
      ["오늘 단어 30개", "bot"],
    ]);
    expect(detail?.goal.momentum).toBe("on_track");
    expect(detail?.goal.latestValue).toBe(760);
    // Nobody else's goal answers to its id.
    const other = await turnWithYes(B.owner.id, B.botId).execute(LOG_PROGRESS, {
      goal: goal.id,
      text: "끼어들기",
    });
    expect(other.code).toBe("laf:goal_not_found");
  });

  test("update_goal links a routine by name; a linked routine's run logs to that goal alone", async () => {
    const service = createRoutineService({
      database,
      resolveAgents: async () => ({}),
      timeZone: "Asia/Seoul",
    });
    const routine = await service.create(A.owner, {
      agentId: A.botId,
      name: "토익 점검",
      instruction: "토익 목표를 점검한다",
      schedule: { kind: "daily", time: "21:00", timeZone: "Asia/Seoul" },
    });
    const [goal] = await store.active(A.owner.id, A.botId);
    if (!goal) throw new Error("no goal");
    const tools = turnWithYes(A.owner.id, A.botId);
    const missing = await tools.execute(UPDATE_GOAL, {
      goal: goal.id,
      routine: "없는 루틴",
    });
    expect(missing).toMatchObject({ code: "laf:goal_routine_not_found" });
    const linked = await tools.execute(UPDATE_GOAL, {
      goal: goal.id,
      routine: "토익 점검",
      target: "12월 정기시험 850점 이상",
    });
    expect(linked).toMatchObject({
      code: "laf:goal_updated",
      routine: "토익 점검",
    });
    const [row] = await database
      .select({ goalId: lafRoutines.goalId })
      .from(lafRoutines)
      .where(eq(lafRoutines.id, routine.id));
    expect(row?.goalId).toBe(goal.id);

    const run = withGoal(
      { tools: [], execute: async () => ({ ok: true }) },
      {
        store,
        userId: A.owner.id,
        agentId: A.botId,
        runId: `run-${tag}`,
        goalId: goal.id,
      },
    );
    expect(run.tools.map((tool) => tool.name)).toEqual([LOG_PROGRESS]);
    // Whatever id the model names, the entry goes on the goal this routine checks.
    const outcome = await run.execute(
      LOG_PROGRESS,
      { goal: "goal_elsewhere", text: "이번 점검: 새 보고 없음", kind: "note" },
      { id: "c" },
    );
    expect(outcome.code).toBe("laf:goal_logged");
    const detail = await store.get(A.owner.id, goal.id);
    expect(detail?.entries[0]).toMatchObject({
      kind: "note",
      runId: `run-${tag}`,
    });
    expect(detail?.goal.target).toBe("12월 정기시험 850점 이상");
    expect(detail?.goal.routines.map((one) => one.name)).toEqual(["토익 점검"]);
  });
});

describe("the person's page", () => {
  const surface = (actorId: string) => {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: actorId,
        email: `${actorId}@laf.test`,
        role: "user",
      });
      await next();
    };
    return new Hono<{ Variables: AppVariables }>().route(
      "/api/goals",
      createGoalRoutes(store, requireUser),
    );
  };

  test("lists and opens only their own; status is theirs to press; deletion leaves the routine unlinked", async () => {
    const listed = (await (
      await surface(A.owner.id).request("/api/goals")
    ).json()) as {
      goals: { id: string }[];
      active: number;
    };
    expect(listed.active).toBe(1);
    const id = listed.goals[0]?.id ?? "";
    expect((await surface(B.owner.id).request(`/api/goals/${id}`)).status).toBe(
      404,
    );
    const patch = (who: string, body: unknown) =>
      surface(who).request(`/api/goals/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await patch(B.owner.id, { status: "done" })).status).toBe(404);
    expect((await patch(A.owner.id, { status: "finished" })).status).toBe(400);
    const done = (await (
      await patch(A.owner.id, { status: "done" })
    ).json()) as {
      status: string;
    };
    expect(done.status).toBe("done");
    // A finished goal takes no more progress from the Bot.
    const late = await turnWithYes(A.owner.id, A.botId).execute(LOG_PROGRESS, {
      goal: id,
      text: "늦은 기록",
    });
    expect(late.code).toBe("laf:goal_not_found");
    expect(
      (
        await surface(B.owner.id).request(`/api/goals/${id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await surface(A.owner.id).request(`/api/goals/${id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    const routines = await database
      .select({ name: lafRoutines.name, goalId: lafRoutines.goalId })
      .from(lafRoutines)
      .where(eq(lafRoutines.agentId, A.botId));
    expect(routines).toEqual([{ name: "토익 점검", goalId: null }]);
  });
});
