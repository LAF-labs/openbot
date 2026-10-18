import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message, Tool } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { placedForWrite, projectScope } from "../../shared/file-scope";
import { createThreadProjects } from "../src/channels/thread-projects";
import type { ActionActor } from "../src/computer/gateway";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import {
  createRefusedRuns,
  createTaskRun,
  createUnreportedRuns,
  taskThreadOf,
} from "../src/hub/task-run";
import { createWorkInFlight } from "../src/runner/in-flight";
import { createRunLedger } from "../src/runner/run-ledger";
import { messagesFor } from "../src/runner/thread-store";
import {
  type LoopAgent,
  runUnattended,
  type UnattendedToolkit,
} from "../src/runner/unattended";
import { TEST_POOL } from "./support/database";

/**
 * A task's run, against a real Postgres: the routine's unattended run in the task's own
 * conversation — a project named after the task, thread `task:<id>` — with its ledger row, and a
 * stop for a person reported by topic. The Bot is a script; the toolkit is a stub that answers.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const ledger = createRunLedger(database);
const made = {
  people: [] as string[],
  bots: [] as string[],
  threads: [] as string[],
  runs: [] as string[],
};

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, made.threads));
  await database
    .delete(lafThreadRuns)
    .where(inArray(lafThreadRuns.runId, made.runs));
  const owned = await database
    .select({ channelId: channelThreads.channelId })
    .from(channelThreads)
    .where(inArray(channelThreads.threadId, made.threads));
  if (owned.length > 0) {
    await database.delete(channels).where(
      inArray(
        channels.id,
        owned.map((row) => row.channelId),
      ),
    );
  }
  await database.delete(agents).where(inArray(agents.id, made.bots));
  await database.delete(users).where(inArray(users.id, made.people));
  await database.$client.close();
});

async function person() {
  const id = `u_task_${randomUUID()}`;
  const bot = `agent_task_${randomUUID()}`;
  made.people.push(id);
  made.bots.push(bot);
  await database.insert(users).values({
    id,
    email: `${id}@laf.test`,
    name: "기범",
    emailVerified: true,
  });
  await database.insert(agents).values({
    id: bot,
    name: "라피",
    type: "remote_ag_ui",
    configuration: { endpoint: "https://bot.example.test/ag-ui" },
  });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: id,
    roleDescription: "",
    avatarSeed: "seed",
  });
  return { actor: { id, role: "user" as const }, botId: bot };
}

/** A Bot that says what it is told to, turn by turn, and keeps what each run was sent. */
function scriptedAgent(turns: Message[][]) {
  const sent: { tools: Tool[]; forwardedProps: unknown }[] = [];
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
        tools: parameters?.tools ?? [],
        forwardedProps: parameters?.forwardedProps,
      });
      const turn = turns[sent.length - 1] ?? [];
      agent.messages.push(...turn);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: turn };
    },
  };
  return { agent: agent as unknown as LoopAgent & { threadId?: string }, sent };
}

const call = (name: string, args: object): Message => ({
  id: `a-${randomUUID()}`,
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: `c-${randomUUID()}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const say = (text: string): Message => ({
  id: `s-${randomUUID()}`,
  role: "assistant",
  content: text,
});

const TOOLS: Tool[] = [
  {
    name: "computer_write_file",
    description: "write",
    parameters: { type: "object", properties: {} },
  },
];

function stubTools(
  answer: UnattendedToolkit["execute"],
): () => Promise<UnattendedToolkit> {
  return async () => ({ tools: TOOLS, execute: answer });
}

function task(title: string) {
  const id = `t_${randomUUID()}`;
  made.threads.push(taskThreadOf(id));
  return {
    id,
    title,
    description: null,
    stage: "doing",
    assignee: "bot:m_me",
    version: 2,
    checkout: null,
  };
}

const runId = () => {
  const id = randomUUID();
  made.runs.push(id);
  return id;
};

describe("a task's run", () => {
  test("runs as a routine runs, in a project named after the task, and files every step in task:<id>", async () => {
    const who = await person();
    const { agent, sent } = scriptedAgent([
      [call("computer_write_file", { path: "메모/날씨.md", contents: "맑음" })],
      [say("메모로 남겼어요.")],
    ]);
    const written: string[] = [];
    const run = createTaskRun({
      database,
      ledger,
      owner: async () => who,
      resolveAgents: async () => ({ [who.botId]: agent }),
      tools: stubTools(async (name) => {
        written.push(name);
        return { ok: true, path: "메모/날씨.md" };
      }),
    });
    const given = task("오늘 날씨 요약해서 메모로 남겨줘");
    const id = runId();

    const outcome = await run({
      task: given,
      runId: id,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({ kind: "done", steps: 2 });
    expect(written).toEqual(["computer_write_file"]);
    // The routine's head: told it is a routine, and offered the routine's toolkit — nothing more.
    expect(sent[0]?.forwardedProps).toEqual({ mode: "routine" });
    expect(sent[0]?.tools.map((tool) => tool.name)).toEqual([
      "computer_write_file",
    ]);
    expect(agent.threadId).toBe(`task:${given.id}`);

    const thread = await messagesFor(database, `task:${given.id}`);
    expect(thread.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(thread[0]?.content).toBe("오늘 날씨 요약해서 메모로 남겨줘");
    expect(thread.at(-1)?.content).toBe("메모로 남겼어요.");

    const [conversation] = await database
      .select({ name: channels.name, kind: channels.kind })
      .from(channels)
      .innerJoin(channelThreads, eq(channelThreads.channelId, channels.id))
      .where(eq(channelThreads.threadId, `task:${given.id}`));
    expect(conversation).toEqual({
      name: "오늘 날씨 요약해서 메모로 남겨줘",
      kind: "project",
    });

    const [row] = await database
      .select({
        status: lafThreadRuns.status,
        threadId: lafThreadRuns.threadId,
        userId: lafThreadRuns.userId,
      })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, id));
    expect(row).toEqual({
      status: "done",
      threadId: `task:${given.id}`,
      userId: who.actor.id,
    });

    // Finished and not on the board yet: reported after a restart instead of run again.
    const unreported = createUnreportedRuns(database);
    expect(await unreported({ taskId: given.id, noted: new Set() })).toEqual({
      runId: id,
      outcome: { kind: "done" },
    });
    expect(
      await unreported({ taskId: given.id, noted: new Set([id]) }),
    ).toBeNull();
  });

  test("its head is a routine's, byte for byte: the same tools and the same forwarded mode", async () => {
    const who = await person();
    const task_ = scriptedAgent([[say("끝.")]]);
    const routine = scriptedAgent([[say("끝.")]]);
    const toolkit = stubTools(async () => ({ ok: true }));
    await createTaskRun({
      database,
      ledger,
      owner: async () => who,
      resolveAgents: async () => ({ [who.botId]: task_.agent }),
      tools: toolkit,
    })({
      task: task("머리 비교"),
      runId: runId(),
      signal: new AbortController().signal,
    });
    await runUnattended(routine.agent, "머리 비교", {
      toolkit: await toolkit(),
      timeoutMs: 5_000,
      mode: "routine",
    });
    expect(JSON.stringify(task_.sent[0])).toBe(JSON.stringify(routine.sent[0]));
  });

  test("an action that needed a person's yes stops it on the topic — kind, action, site — and nothing the call carried", async () => {
    const who = await person();
    const { agent } = scriptedAgent([
      [call("computer_click", { ref: "e7", snapshotId: 3 })],
      [say("결제는 사장님 확인이 필요해요.")],
    ]);
    const run = createTaskRun({
      database,
      ledger,
      owner: async () => who,
      resolveAgents: async () => ({ [who.botId]: agent }),
      tools: stubTools(async () => ({
        ok: false,
        awaitingApproval: true,
        approvalId: "ap_1",
        subject: {
          kind: "browser",
          intent: "click",
          host: "shop.example.com",
          element: { role: "button", name: "결제하기 4,500원" },
          reason: "rule",
        },
        preview: "카드 1234-5678",
        question: "결제할까요?",
      })),
    });
    const id = runId();
    const given = task("주문 결제해줘");

    const outcome = await run({
      task: given,
      runId: id,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      kind: "approval",
      topic: "browser/click@shop.example.com",
      steps: 2,
    });
    expect(JSON.stringify(outcome)).not.toContain("결제하기");
    expect(JSON.stringify(outcome)).not.toContain("1234");
    const [row] = await database
      .select({ status: lafThreadRuns.status, ending: lafThreadRuns.ending })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, id));
    expect(row).toEqual({ status: "done", ending: "owner" });
    // And after a restart, a stop for a person that never reached the board is one still.
    expect(
      await createUnreportedRuns(database)({
        taskId: given.id,
        noted: new Set(),
      }),
    ).toEqual({ runId: id, outcome: { kind: "person" } });
  });

  test("what it files goes in the task's project folder, not the main one", async () => {
    const who = await person();
    const { agent } = scriptedAgent([[say("했어요.")]]);
    const actors: ActionActor[] = [];
    const given = task("보고서 파일로 남겨줘");
    await createTaskRun({
      database,
      ledger,
      owner: async () => who,
      resolveAgents: async () => ({ [who.botId]: agent }),
      tools: async (_botId, actor) => {
        actors.push(actor);
        return { tools: TOOLS, execute: async () => ({ ok: true }) };
      },
    })({ task: given, runId: runId(), signal: new AbortController().signal });

    const [conversation] = await database
      .select({ channelId: channelThreads.channelId })
      .from(channelThreads)
      .where(eq(channelThreads.threadId, `task:${given.id}`));
    // The gateway's own question (`gateway.ts`, `fileScopeOf`): whose files is this actor's run?
    const threadId = actors[0]?.threadId;
    expect(threadId).toBe(`task:${given.id}`);
    const projectId = await createThreadProjects(database).of(threadId ?? "");
    expect(projectId).toBe(conversation?.channelId ?? "none");
    expect(placedForWrite(projectScope(projectId ?? ""), "보고서.md")).toBe(
      `projects/${conversation?.channelId}/보고서.md`,
    );
  });

  test("a second run of the same task works in the same conversation", async () => {
    const who = await person();
    const given = task("같은 일감");
    for (const _ of [1, 2]) {
      const { agent } = scriptedAgent([[say("했어요.")]]);
      await createTaskRun({
        database,
        ledger,
        owner: async () => who,
        resolveAgents: async () => ({ [who.botId]: agent }),
        tools: stubTools(async () => ({ ok: true })),
      })({ task: given, runId: runId(), signal: new AbortController().signal });
    }
    const conversations = await database
      .select({ channelId: channelThreads.channelId })
      .from(channelThreads)
      .where(eq(channelThreads.threadId, `task:${given.id}`));
    expect(conversations).toHaveLength(1);
    const thread = await messagesFor(database, `task:${given.id}`);
    expect(thread.filter((message) => message.role === "user")).toHaveLength(2);
  });

  test("a run nobody started still unsettled is not one to report: it is run again", async () => {
    const id = runId();
    const given = task("끊긴 실행");
    await ledger.begin({
      runId: id,
      agentId: null,
      userId: null,
      threadId: `task:${given.id}`,
      origin: "chat",
    });
    expect(
      await createUnreportedRuns(database)({
        taskId: given.id,
        noted: new Set(),
      }),
    ).toBeNull();
  });
  test("a person's stop that never reached the board is reported as a stop after a restart, never run again", async () => {
    const who = await person();
    const work = createWorkInFlight();
    const { agent } = scriptedAgent([
      [call("computer_write_file", { path: "a.md", contents: "가" })],
      [say("다음 걸음.")],
    ]);
    const id = runId();
    const given = task("멈출 일");
    const outcome = await createTaskRun({
      database,
      ledger,
      work,
      owner: async () => who,
      resolveAgents: async () => ({ [who.botId]: agent }),
      // 모두 멈추기, pressed while the run's first step is being taken.
      tools: stubTools(async () => {
        for (const going of work.of(who.actor.id)) await going.stop();
        return { ok: true };
      }),
    })({ task: given, runId: id, signal: new AbortController().signal });

    expect(outcome.kind).toBe("stopped");
    expect(
      await createUnreportedRuns(database)({
        taskId: given.id,
        noted: new Set(),
      }),
    ).toEqual({ runId: id, outcome: { kind: "stopped" } });
  });

  test("a run that lost its claim is told apart from a person's stop, and worked again", async () => {
    const who = await person();
    const claim = new AbortController();
    const { agent } = scriptedAgent([
      [call("computer_write_file", { path: "a.md", contents: "가" })],
      [say("다음 걸음.")],
    ]);
    const id = runId();
    const given = task("옮겨진 일");
    const outcome = await createTaskRun({
      database,
      ledger,
      owner: async () => who,
      resolveAgents: async () => ({ [who.botId]: agent }),
      // The beat is told the run no longer holds the task while its first step is taken.
      tools: stubTools(async () => {
        claim.abort();
        return { ok: true };
      }),
    })({ task: given, runId: id, signal: claim.signal });

    expect(outcome).toEqual({ kind: "lost" });
    const [row] = await database
      .select({ status: lafThreadRuns.status, error: lafThreadRuns.error })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, id));
    expect(row).toEqual({ status: "stopped", error: "laf:task_not_held" });
    expect(
      await createUnreportedRuns(database)({
        taskId: given.id,
        noted: new Set(),
      }),
    ).toBeNull();
  });

  test("a finished run whose move the board refused is never reported later", async () => {
    const who = await person();
    const { agent } = scriptedAgent([[say("했어요.")]]);
    const id = runId();
    const given = task("돌려보낸 일");
    await createTaskRun({
      database,
      ledger,
      owner: async () => who,
      resolveAgents: async () => ({ [who.botId]: agent }),
      tools: stubTools(async () => ({ ok: true })),
    })({ task: given, runId: id, signal: new AbortController().signal });
    const unreported = createUnreportedRuns(database);
    expect(await unreported({ taskId: given.id, noted: new Set() })).toEqual({
      runId: id,
      outcome: { kind: "done" },
    });

    // The board said `laf:task_not_held` to its move: a person had sent the task back.
    await createRefusedRuns(ledger)(id);

    expect(await unreported({ taskId: given.id, noted: new Set() })).toBeNull();
  });
});
