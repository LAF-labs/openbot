import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message, Tool } from "@ag-ui/client";
import { eq, inArray, like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  hubJobRoutines,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createRunBudget } from "../src/hub/budget";
import type { HubHttp } from "../src/hub/http";
import { createHubJobs } from "../src/hub/jobs";
import type { HubOutboxWrite } from "../src/hub/outbox";
import { createTaskPickup } from "../src/hub/task-pickup";
import { createTaskRun } from "../src/hub/task-run";
import { mine } from "../src/routines/ownership";
import { createRoutineService } from "../src/routines/service";
import { createRunLedger } from "../src/runner/run-ledger";
import {
  type LoopAgent,
  runUnattended,
  type UnattendedToolkit,
} from "../src/runner/unattended";
import { TEST_POOL } from "./support/database";
import { fakeTaskHub } from "./support/fake-task-hub";

/**
 * A task on the company board given to a sub-Bot (`job:<id>`): taken on the VM that runs the job and
 * on no other, run as the job's routine — its author, its Bot, its instruction first — against the
 * job's day as well as the task's, and no longer taken here once the job has moved to another
 * member. Real Postgres for the routines, the job links, the ledger and the task's conversation; the
 * hub is the in-memory board with its register and budget (`support/fake-task-hub.ts`), and the Bot
 * is a script that counts what it is asked.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const ledger = createRunLedger(database);
const suite = randomUUID().slice(0, 8);
const RUNNER = `m_runner_${suite}`;
const OTHER = `m_other_${suite}`;
const AUTHOR = { id: `job-tasks-author-${suite}`, role: "user" as const };
const BOT = `job-tasks-bot-${suite}`;
const NEXT = { id: `job-tasks-next-${suite}`, role: "user" as const };
const NEXT_BOT = `job-tasks-next-bot-${suite}`;
const routines = createRoutineService({
  database,
  resolveAgents: async () => ({}),
});

beforeAll(async () => {
  for (const [person, bot] of [
    [AUTHOR, BOT],
    [NEXT, NEXT_BOT],
  ] as const) {
    await database.insert(users).values({
      id: person.id,
      email: `${person.id}@laf.test`,
      name: "사장님",
    });
    await database.insert(agents).values({
      id: bot,
      name: "라피",
      type: "remote_ag_ui",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: bot,
      ownerUserId: person.id,
      roleDescription: "",
      avatarSeed: "seed",
    });
  }
});

afterAll(async () => {
  const threads = (
    await database
      .select({ threadId: channelThreads.threadId })
      .from(channelThreads)
      .where(inArray(channelThreads.userId, [AUTHOR.id, NEXT.id]))
  ).map((row) => row.threadId);
  if (threads.length > 0) {
    await database
      .delete(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, threads));
    const owned = await database
      .select({ channelId: channelThreads.channelId })
      .from(channelThreads)
      .where(inArray(channelThreads.threadId, threads));
    await database.delete(channels).where(
      inArray(
        channels.id,
        owned.map((row) => row.channelId),
      ),
    );
  }
  await database
    .delete(lafThreadRuns)
    .where(inArray(lafThreadRuns.agentId, [BOT, NEXT_BOT]));
  // The job links cascade with the routines.
  await database
    .delete(lafRoutines)
    .where(inArray(lafRoutines.createdById, [AUTHOR.id, NEXT.id]));
  await database.delete(agents).where(like(agents.id, `job-tasks-%${suite}`));
  await database.delete(users).where(inArray(users.id, [AUTHOR.id, NEXT.id]));
  await database.$client.end();
});

/** A Bot that answers in one step and keeps what each run was handed. */
function scriptedBot(answer: string) {
  const sent: { messages: Message[]; tools: Tool[]; props: unknown }[] = [];
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
      parameters?: { tools?: Tool[]; forwardedProps?: unknown },
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) {
      sent.push({
        messages: [...agent.messages],
        tools: parameters?.tools ?? [],
        props: parameters?.forwardedProps,
      });
      const said: Message = {
        id: `a-${randomUUID()}`,
        role: "assistant",
        content: answer,
      };
      agent.messages.push(said);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [said] };
    },
  };
  return { agent: agent as unknown as LoopAgent & { threadId?: string }, sent };
}

const TOOLS: Tool[] = [
  {
    name: "computer_write_file",
    description: "write",
    parameters: { type: "object", properties: {} },
  },
];
const toolkit = async (): Promise<UnattendedToolkit> => ({
  tools: TOOLS,
  execute: async () => ({ ok: true }),
});

/** An outbox that sends at once, keeping what it was handed. */
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
      });
      return randomUUID();
    },
  };
}

async function routineFor(
  actor: typeof AUTHOR,
  bot: string,
  instruction: string,
) {
  const made = await routines.create(actor, {
    agentId: bot,
    name: `거래처 정리 ${randomUUID().slice(0, 6)}`,
    instruction,
    schedule: { kind: "interval", minutes: 60 },
  });
  if (!made) throw new Error("the routine was not made");
  return made;
}

/** One member's VM: its sub-Bots, its pickup, and a task's run on its own scripted Bot. */
function vm(
  hub: ReturnType<typeof fakeTaskHub>,
  member: string,
  input: {
    bot: string;
    answer: string;
    install?: (instruction: string) => Promise<string>;
  },
) {
  const http = hub.as(member);
  const outbox = directOutbox(http);
  const { agent, sent } = scriptedBot(input.answer);
  let pickup: ReturnType<typeof createTaskPickup> | undefined;
  const jobs = createHubJobs({
    database,
    http,
    outbox,
    memberId: () => member,
    mine: (actor, id) => mine(database, actor, id),
    install: async (definition) => {
      if (!input.install) throw new Error("not this VM's to install");
      return input.install(definition.instruction);
    },
    onTaken: () => void pickup?.scan(),
  });
  pickup = createTaskPickup({
    http,
    memberId: () => member,
    jobs,
    run: createTaskRun({
      database,
      ledger,
      budget: createRunBudget({ http, outbox }),
      // Never this VM's 라피: a job's task runs as the job's routine or not at all.
      owner: async () => null,
      resolveAgents: async () => ({ [input.bot]: agent }),
      tools: toolkit,
    }),
  });
  return { jobs, pickup, sent, outbox };
}

const assigned = (pickup: { heard: (event: never) => void }, id: string) =>
  pickup.heard({ type: "task.assigned", refId: id } as never);

const INSTRUCTION = "거래처 목록을 정리해서 메모로 남겨줘";

describe("a task given to a sub-Bot", () => {
  test("runs on the job's runner's VM only, as its routine, against the workspace's, the job's and the task's day", async () => {
    const hub = fakeTaskHub();
    const jobId = `j_${suite}_1`;
    const routine = await routineFor(AUTHOR, BOT, INSTRUCTION);
    await database
      .insert(hubJobRoutines)
      .values({ jobId, routineId: routine.id });
    hub.jobs.set(jobId, {
      id: jobId,
      name: routine.name,
      owner: RUNNER,
      runner: RUNNER,
      schedule: "every 60m",
    });
    hub.add({
      id: `t_${suite}_1`,
      assignee: `job:${jobId}`,
      title: "이번 주 새 거래처 추가",
    });
    const runner = vm(hub, RUNNER, { bot: BOT, answer: "정리했어요." });
    // Another member's VM: it holds no routine for this job, as a VM that never ran it would not.
    const other = createTaskPickup({
      http: hub.as(OTHER),
      memberId: () => OTHER,
      jobs: { routineFor: async () => null },
      run: async () => {
        throw new Error("a VM that does not run the job ran its task");
      },
    });

    assigned(other, `t_${suite}_1`);
    assigned(runner.pickup, `t_${suite}_1`);
    await Promise.all([other.idle(), runner.pickup.idle()]);

    // Run once, by the routine's Bot, told the routine's instruction and then the task.
    expect(runner.sent).toHaveLength(1);
    const asked = runner.sent[0]?.messages.find((one) => one.role === "user");
    expect(asked?.content).toBe(`${INSTRUCTION}\n\n이번 주 새 거래처 추가`);
    expect(runner.sent[0]?.props).toEqual({ mode: "routine" });
    expect(hub.tasks.get(`t_${suite}_1`)?.stage).toBe("review");

    // The run's row is the routine author's, on the routine's Bot, in the task's conversation.
    const runId = hub.budget.reserved[0]?.runId ?? "";
    const [row] = await database
      .select({
        userId: lafThreadRuns.userId,
        agentId: lafThreadRuns.agentId,
        threadId: lafThreadRuns.threadId,
      })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, runId));
    expect(row).toEqual({
      userId: AUTHOR.id,
      agentId: BOT,
      threadId: `task:t_${suite}_1`,
    });

    // Reserved before the Bot with the job's scope beside the task's, settled after.
    expect(hub.budget.reserved).toEqual([
      {
        as: RUNNER,
        runId,
        scopes: ["workspace", `job:${jobId}`, `task:t_${suite}_1`],
      },
    ]);
    expect(hub.budget.settled).toEqual([{ as: RUNNER, runId, actual: 0 }]);

    // The other VM read the task and asked for nothing more.
    expect(
      hub.requests
        .filter((request) => request.as === OTHER)
        .map((request) => `${request.method ?? "GET"} ${request.path}`),
    ).toEqual([`GET /tasks/t_${suite}_1`]);
  });

  test("its head is a routine's, byte for byte", async () => {
    const hub = fakeTaskHub();
    const jobId = `j_${suite}_head`;
    const routine = await routineFor(AUTHOR, BOT, INSTRUCTION);
    await database
      .insert(hubJobRoutines)
      .values({ jobId, routineId: routine.id });
    hub.jobs.set(jobId, {
      id: jobId,
      name: routine.name,
      owner: RUNNER,
      runner: RUNNER,
      schedule: null,
    });
    hub.add({ id: `t_${suite}_head`, assignee: `job:${jobId}`, title: "머리" });
    const runner = vm(hub, RUNNER, { bot: BOT, answer: "끝." });
    assigned(runner.pickup, `t_${suite}_head`);
    await runner.pickup.idle();

    const routineRun = scriptedBot("끝.");
    await runUnattended(routineRun.agent, `${INSTRUCTION}\n\n머리`, {
      toolkit: await toolkit(),
      timeoutMs: 5_000,
      mode: "routine",
    });
    const head = (one: (typeof runner.sent)[number] | undefined) =>
      JSON.stringify({ tools: one?.tools, props: one?.props });
    expect(head(runner.sent[0])).toBe(head(routineRun.sent[0]));
  });

  test("the job's day spent: the Bot is never asked, and the task is blocked with the fact", async () => {
    const hub = fakeTaskHub();
    const jobId = `j_${suite}_spent`;
    const routine = await routineFor(AUTHOR, BOT, INSTRUCTION);
    await database
      .insert(hubJobRoutines)
      .values({ jobId, routineId: routine.id });
    hub.jobs.set(jobId, {
      id: jobId,
      name: routine.name,
      owner: RUNNER,
      runner: RUNNER,
      schedule: null,
    });
    hub.budget.spent.add(`job:${jobId}`);
    hub.add({ id: `t_${suite}_spent`, assignee: `job:${jobId}` });
    const runner = vm(hub, RUNNER, { bot: BOT, answer: "안 불려야 해요." });

    assigned(runner.pickup, `t_${suite}_spent`);
    await runner.pickup.idle();

    expect(runner.sent).toEqual([]);
    const task = hub.tasks.get(`t_${suite}_spent`);
    expect(task?.stage).toBe("blocked");
    expect(task?.notes.at(-1)?.text).toMatch(
      /^laf:task_run_failed run:\S+ code:laf:budget_reached$/,
    );
    expect(hub.budget.settled).toEqual([]);
  });

  test("moved to another member: this VM hands the job on and takes none of its tasks; the new runner's VM takes them", async () => {
    const hub = fakeTaskHub();
    const jobId = `j_${suite}_moved`;
    const routine = await routineFor(AUTHOR, BOT, INSTRUCTION);
    await database
      .insert(hubJobRoutines)
      .values({ jobId, routineId: routine.id });
    hub.jobs.set(jobId, {
      id: jobId,
      name: routine.name,
      owner: RUNNER,
      runner: RUNNER,
      schedule: null,
    });
    const old = vm(hub, RUNNER, { bot: BOT, answer: "예전 VM에서 했어요." });
    const next = vm(hub, OTHER, {
      bot: NEXT_BOT,
      answer: "새 VM에서 했어요.",
      install: async (instruction) =>
        (await routineFor(NEXT, NEXT_BOT, instruction)).id,
    });

    // The owner is handed on while the old VM's line is down: it hears the task before the move.
    const job = hub.jobs.get(jobId);
    if (job) job.runner = OTHER;
    hub.add({ id: `t_${suite}_moved`, assignee: `job:${jobId}` });
    assigned(old.pickup, `t_${suite}_moved`);
    await old.pickup.idle();
    await old.jobs.idle();

    // Not run, not even asked for; and the job handed on as `job.moved` would have.
    expect(old.sent).toEqual([]);
    expect(
      hub.requests.some(
        (request) =>
          request.as === RUNNER &&
          request.path === `/tasks/t_${suite}_moved/checkout`,
      ),
    ).toBe(false);
    expect(
      await database
        .select()
        .from(hubJobRoutines)
        .where(eq(hubJobRoutines.jobId, jobId)),
    ).toEqual([]);
    const [off] = await database
      .select({ enabled: lafRoutines.enabled })
      .from(lafRoutines)
      .where(eq(lafRoutines.id, routine.id));
    expect(off?.enabled).toBe(false);

    // Heard again on the old VM — a replay — it is still not this VM's.
    assigned(old.pickup, `t_${suite}_moved`);
    await old.pickup.idle();
    expect(old.sent).toEqual([]);

    // The new runner's VM collects the job and, once it is its, takes the task waiting for it.
    next.jobs.heard({ type: "job.moved", refId: jobId });
    await next.jobs.idle();
    await next.pickup.idle();
    expect(next.sent).toHaveLength(1);
    expect(
      next.sent[0]?.messages.find((one) => one.role === "user")?.content,
    ).toBe(`${INSTRUCTION}\n\n오늘 날씨 요약해서 메모로 남겨줘`);
    expect(hub.tasks.get(`t_${suite}_moved`)?.stage).toBe("review");
    expect(old.sent).toEqual([]);
  });
});
