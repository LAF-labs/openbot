/**
 * DELETING A PROJECT, AGAINST THE REAL TABLES (record §3, piece 4-5): what goes and what stays,
 * the order it goes in, the one gate every write door stands behind, and the two lists that keep
 * the next table and the next route from being forgotten.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";
import {
  anyBeingDeleted,
  conversationsNamed,
  createConversationWrites,
  createProjectDeletion,
  NAMES_A_CONVERSATION,
  PROJECT_DELETING,
} from "../src/channels/deleting";
import {
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createThreadProjects } from "../src/channels/thread-projects";
import { createDatabase } from "../src/db/client";
import {
  agentMemories,
  agentProfiles,
  agents,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  lafConversationContexts,
  lafNotifications,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { createConversationSearch } from "../src/search/conversations";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
const ME = `deleting-me-${tag}`;
const OTHER = `deleting-other-${tag}`;
const BOT = `deleting-bot-${tag}`;
const MAIN = { channel: `deleting-main-${tag}`, thread: randomUUID() };
const made: Array<{ channel: string; thread: string }> = [MAIN];
const WORD = `지울말${tag}`;

const store = createChannelStore(
  database,
  createAgentProfileStore(
    database,
    new URL("https://managed.example.test/ag-ui"),
  ),
  createThreadIdentity("test-deployment"),
);
const actor = { id: ME } as AgentActor;

/** A conversation of this person's with the Bot, holding one of everything that names it. */
async function conversation(
  kind: "main" | "project",
  given?: { channel: string; thread: string },
) {
  const one = given ?? {
    channel: `deleting-${kind}-${randomUUID().slice(0, 8)}-${tag}`,
    thread: randomUUID(),
  };
  if (!given) made.push(one);
  await database.insert(channels).values({
    id: one.channel,
    name: "가을 메뉴 개편",
    description: "",
    kind,
  });
  await database
    .insert(channelMemberships)
    .values({ channelId: one.channel, userId: ME });
  await database
    .insert(channelAgents)
    .values({ channelId: one.channel, agentId: BOT });
  await database.insert(channelThreads).values({
    userId: ME,
    channelId: one.channel,
    threadId: one.thread,
  });
  await database.insert(lafThreadMessages).values({
    threadId: one.thread,
    seq: 1,
    message: {
      id: `m-${one.thread}`,
      role: "user",
      content: `${WORD} 정해 줘`,
    },
  });
  await database.insert(lafConversationContexts).values({
    threadId: one.thread,
    agentId: BOT,
    epoch: {},
    known: {},
  });
  await database.insert(lafThreadRuns).values({
    runId: `run-${one.thread}`,
    threadId: one.thread,
    agentId: BOT,
    userId: ME,
    status: "done",
    origin: "chat",
    startedAt: new Date(),
  });
  await database.insert(lafNotifications).values({
    id: `note-${one.thread}`,
    kind: "approval.asked",
    botId: BOT,
    userId: ME,
    channelId: one.channel,
  });
  await database.insert(agentMemories).values({
    id: `memory-${one.thread}`,
    agentId: BOT,
    ownerUserId: ME,
    content: "일요일은 쉰다.",
    evidenceThreadId: one.thread,
    evidenceMessageId: `m-${one.thread}`,
    evidenceExcerpt: "일요일은 쉬어요",
  });
  return one;
}

/** How many rows still name this conversation, table by table. */
async function left(one: { channel: string; thread: string }) {
  const count = async (query: Promise<unknown[]>) => (await query).length;
  return {
    channels: await count(
      database.select().from(channels).where(eq(channels.id, one.channel)),
    ),
    memberships: await count(
      database
        .select()
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, one.channel)),
    ),
    bots: await count(
      database
        .select()
        .from(channelAgents)
        .where(eq(channelAgents.channelId, one.channel)),
    ),
    threads: await count(
      database
        .select()
        .from(channelThreads)
        .where(eq(channelThreads.channelId, one.channel)),
    ),
    messages: await count(
      database
        .select()
        .from(lafThreadMessages)
        .where(eq(lafThreadMessages.threadId, one.thread)),
    ),
    contexts: await count(
      database
        .select()
        .from(lafConversationContexts)
        .where(eq(lafConversationContexts.threadId, one.thread)),
    ),
    runs: await count(
      database
        .select()
        .from(lafThreadRuns)
        .where(eq(lafThreadRuns.threadId, one.thread)),
    ),
    notifications: await count(
      database
        .select()
        .from(lafNotifications)
        .where(eq(lafNotifications.channelId, one.channel)),
    ),
  };
}

const GONE = {
  bots: 0,
  channels: 0,
  contexts: 0,
  memberships: 0,
  messages: 0,
  notifications: 0,
  runs: 0,
  threads: 0,
};
const WHOLE = {
  bots: 1,
  channels: 1,
  contexts: 1,
  memberships: 1,
  messages: 1,
  notifications: 1,
  runs: 1,
  threads: 1,
};

const memoryOf = async (thread: string) =>
  (
    await database
      .select({
        content: agentMemories.content,
        excerpt: agentMemories.evidenceExcerpt,
        messageId: agentMemories.evidenceMessageId,
        threadId: agentMemories.evidenceThreadId,
      })
      .from(agentMemories)
      .where(eq(agentMemories.id, `memory-${thread}`))
  )[0];

const auditOf = async (channel: string) =>
  database
    .select({
      actor: auditEvents.actorUserId,
      payload: auditEvents.payload,
      type: auditEvents.eventType,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "project.deleted"),
        eq(auditEvents.targetId, channel),
      ),
    );

const auditStore = {
  insert: async (event: typeof auditEvents.$inferInsert) => {
    await database.insert(auditEvents).values(event);
  },
};

beforeAll(async () => {
  await database.insert(users).values(
    [ME, OTHER].map((id) => ({
      id,
      email: `${id}@laf.test`,
      name: id,
      emailVerified: true,
    })),
  );
  await database.insert(agents).values({
    id: BOT,
    name: BOT,
    type: "remote_ag_ui" as const,
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: BOT,
    ownerUserId: ME,
    roleDescription: "",
    avatarSeed: "seed",
  });
  await conversation("main", MAIN);
});

afterAll(async () => {
  const threads = made.map((one) => one.thread);
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, threads));
  await database
    .delete(lafConversationContexts)
    .where(inArray(lafConversationContexts.threadId, threads));
  await database
    .delete(lafThreadRuns)
    .where(inArray(lafThreadRuns.threadId, threads));
  await database.delete(lafNotifications).where(
    inArray(
      lafNotifications.id,
      threads.map((thread) => `note-${thread}`),
    ),
  );
  // The trail is append-only: the rows this file wrote stay, under ids that resolve to nothing.
  await database.delete(agentMemories).where(eq(agentMemories.agentId, BOT));
  await database.delete(channels).where(
    inArray(
      channels.id,
      made.map((one) => one.channel),
    ),
  );
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(inArray(users.id, [ME, OTHER]));
  await database.$client.end();
});

describe("deleting a project", () => {
  test("removes every row that names it — and nothing of the main conversation or another project", async () => {
    const project = await conversation("project");
    const beside = await conversation("project");
    const ended: Array<[string, string]> = [];
    const deletion = createProjectDeletion({
      auditStore,
      database,
      endApprovals: async (threadId, by) => {
        ended.push([threadId, by]);
      },
      stopThread: async () => {},
    });

    const outcome = await deletion.delete({
      channelId: project.channel,
      userId: ME,
    });
    expect(outcome).toEqual({
      ok: true,
      counts: {
        channels: 1,
        conversationContexts: 1,
        memoryEvidence: 1,
        notifications: 1,
        threadMessages: 1,
        threadRuns: 1,
      },
    });
    expect(await left(project)).toEqual(GONE);
    expect(await left(beside)).toEqual(WHOLE);
    expect(await left(MAIN)).toEqual(WHOLE);

    // What the Bot remembers is the Bot's: it stays, and where it was learned is no longer said.
    expect(await memoryOf(project.thread)).toEqual({
      content: "일요일은 쉰다.",
      excerpt: null,
      messageId: null,
      threadId: null,
    });
    expect((await memoryOf(beside.thread))?.excerpt).toBe("일요일은 쉬어요");

    // What was allowed "for this conversation" is ended, under who deleted it.
    expect(ended).toEqual([[project.thread, ME]]);

    // One row in the trail: who, which, how much — and none of the person's words.
    const trail = await auditOf(project.channel);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.actor).toBe(ME);
    expect(trail[0]?.payload).toMatchObject({
      counts: { threadMessages: 1 },
      resumed: false,
      waited: true,
    });
    expect(JSON.stringify(trail)).not.toContain("가을 메뉴");
  });

  test("the Bot's main conversation is not a project, and is not deleted from here", async () => {
    const deletion = createProjectDeletion({
      database,
      stopThread: async () => {},
    });
    expect(
      await deletion.delete({ channelId: MAIN.channel, userId: ME }),
    ).toEqual({ ok: false, code: "laf:project_only" });
    expect(await left(MAIN)).toEqual(WHOLE);
    expect(
      await anyBeingDeleted(database, {
        channelIds: [MAIN.channel],
        threadIds: [MAIN.thread],
      }),
    ).toBe(false);
  });

  test("somebody who is not in a project is told it is not there, and nothing is marked", async () => {
    const project = await conversation("project");
    const deletion = createProjectDeletion({
      database,
      stopThread: async () => {},
    });
    expect(
      await deletion.delete({ channelId: project.channel, userId: OTHER }),
    ).toEqual({ ok: false, code: "laf:channel_not_found" });
    expect(
      await deletion.delete({ channelId: "no-such-channel", userId: ME }),
    ).toEqual({ ok: false, code: "laf:channel_not_found" });
    expect(await left(project)).toEqual(WHOLE);
    expect(
      await anyBeingDeleted(database, {
        channelIds: [project.channel],
        threadIds: [],
      }),
    ).toBe(false);
  });

  test("the order is mark, wait for the writes in flight, stop the turn, forget its context, delete", async () => {
    const project = await conversation("project");
    const order: string[] = [];
    const isMarked = () =>
      anyBeingDeleted(database, {
        channelIds: [project.channel],
        threadIds: [],
      });
    const rows = async () => (await left(project)).messages;
    const deletion = createProjectDeletion({
      database,
      dropContext: async (threadId) => {
        order.push(
          `forget ${threadId === project.thread ? "its thread" : threadId}: rows ${await rows()}`,
        );
      },
      stopThread: async (threadId) => {
        order.push(
          `stop ${threadId === project.thread ? "its thread" : threadId}: rows ${await rows()}`,
        );
      },
    });
    // A write that came through the gate before the mark, and is still going.
    let finishWrite: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const app = new Hono();
    app.use("/api/*", deletion.gate);
    app.post("/api/channels/:channelId/read", async (context) => {
      entered();
      await held;
      return context.json({ ok: true });
    });
    const write = app.request(`/api/channels/${project.channel}/read`, {
      method: "POST",
    });
    await inside;

    const deleting = deletion.delete({
      channelId: project.channel,
      userId: ME,
    });
    // Marked at once, and nothing removed or stopped while the write is still in flight.
    while (!(await isMarked())) await Promise.resolve();
    order.push(`marked: rows ${await rows()}`);
    expect(order).toEqual(["marked: rows 1"]);
    order.push("the write finishes");
    finishWrite();
    await write;
    await deleting;
    order.push(`deleted: rows ${await rows()}`);
    expect(order).toEqual([
      "marked: rows 1",
      "the write finishes",
      "stop its thread: rows 1",
      "forget its thread: rows 1",
      "deleted: rows 0",
    ]);
  });

  test("a turn that has not ended is not deleted under: the mark stays, the person is told, and the clock finishes it", async () => {
    const project = await conversation("project");
    let end: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const deletion = createProjectDeletion({
      auditStore,
      database,
      stopThread: () => ended,
      turnSettleMs: 5,
    });
    expect(
      await deletion.delete({ channelId: project.channel, userId: ME }),
    ).toEqual({ ok: false, code: PROJECT_DELETING });
    // Nothing removed, and every door still refusing.
    expect((await left(project)).messages).toBe(1);
    expect((await left(project)).channels).toBe(1);
    expect(
      await anyBeingDeleted(database, {
        channelIds: [project.channel],
        threadIds: [],
      }),
    ).toBe(true);
    // The clock, while the turn is still going: still not removed.
    await deletion.finishPending();
    expect((await left(project)).channels).toBe(1);

    end();
    expect(await deletion.finishPending()).toBeGreaterThanOrEqual(1);
    expect(await left(project)).toEqual(GONE);
    expect(await auditOf(project.channel)).toHaveLength(1);
  });

  test("a deletion that failed after its mark is tried again, and asked for twice at once is done once", async () => {
    const project = await conversation("project");
    let fail = true;
    const stops: string[] = [];
    const ends: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = createProjectDeletion({
      database,
      endApprovals: async (threadId) => {
        ends.push(threadId);
      },
      stopThread: async (threadId) => {
        stops.push(threadId);
        await held;
      },
      dropContext: async () => {
        if (fail) throw new Error("the context store: refused");
      },
    });
    const first = deletion.delete({ channelId: project.channel, userId: ME });
    const second = deletion.delete({ channelId: project.channel, userId: ME });
    const both = Promise.allSettled([first, second]);
    /*
     * Both have asked before the first attempt is let go on. The second's arrival is two reads
     * inside `delete` and no event of its own, so it is given time — and too little time fails
     * this test (two stops) rather than passing it. A second, where the reads take milliseconds:
     * a failure here on a loaded machine is the margin, not the joining.
     */
    while (stops.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    release();
    // Both are the one attempt, and it failed: said to both, with the mark left.
    const outcomes = await both;
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(stops).toEqual([project.thread]);
    expect((await left(project)).channels).toBe(1);

    fail = false;
    expect(await deletion.finishPending()).toBeGreaterThanOrEqual(1);
    expect(await left(project)).toEqual(GONE);
    expect(ends).toEqual([project.thread]);
  });

  test("a write that never finishes does not hold a deletion for ever", async () => {
    const writes = createConversationWrites();
    writes.begin({ channelIds: ["c"], threadIds: [] });
    expect(await writes.settled({ channelIds: ["c"], threadIds: [] }, 5)).toBe(
      false,
    );
    expect(await writes.settled({ channelIds: ["d"], threadIds: ["c"] })).toBe(
      true,
    );
  });

  test("a deletion a restart cut short is finished at boot, from the mark", async () => {
    const project = await conversation("project");
    // What a process that died between the mark and the rows leaves behind.
    await database
      .update(channels)
      .set({ deletingAt: new Date() })
      .where(eq(channels.id, project.channel));
    const stopped: string[] = [];
    const deletion = createProjectDeletion({
      auditStore,
      database,
      stopThread: async (threadId) => {
        stopped.push(threadId);
      },
    });
    expect(await deletion.finishPending()).toBeGreaterThanOrEqual(1);
    expect(await left(project)).toEqual(GONE);
    expect(stopped).toContain(project.thread);
    const trail = await auditOf(project.channel);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.actor).toBeNull();
    expect(trail[0]?.payload).toMatchObject({ resumed: true });
    // And nothing that was not marked went with it.
    expect(await left(MAIN)).toEqual(WHOLE);
  });

  test("its folder on the Bot's computer is removed after the turn's end and before the rows, and then it is forgotten", async () => {
    const project = await conversation("project");
    const order: string[] = [];
    const rows = async () => (await left(project)).messages;
    const deletion = createProjectDeletion({
      database,
      stopThread: async () => {
        order.push(`stop: rows ${await rows()}`);
      },
      dropContext: async () => {
        order.push(`forget its context: rows ${await rows()}`);
      },
      removeFolder: async (channelId, botIds) => {
        order.push(
          `remove the folder of ${channelId === project.channel ? "the project" : channelId} for ${botIds.join()}: rows ${await rows()}`,
        );
      },
      forgotten: (channelId) => {
        order.push(
          `forgotten ${channelId === project.channel ? "the project" : channelId}`,
        );
      },
    });

    await deletion.delete({ channelId: project.channel, userId: ME });

    order.push(`deleted: rows ${await rows()}`);
    expect(order).toEqual([
      "stop: rows 1",
      "forget its context: rows 1",
      `remove the folder of the project for ${BOT}: rows 1`,
      "forgotten the project",
      "deleted: rows 0",
    ]);
  });

  test("a folder that could not be removed keeps the project marked with every row, and the clock removes both", async () => {
    const project = await conversation("project");
    let computerIsUp = false;
    const asked: string[] = [];
    const forgotten: string[] = [];
    const deletion = createProjectDeletion({
      auditStore,
      database,
      stopThread: async () => undefined,
      removeFolder: async (channelId) => {
        asked.push(channelId);
        if (!computerIsUp) throw new Error("laf:computer_unreachable");
      },
      forgotten: (channelId) => {
        forgotten.push(channelId);
      },
    });

    // Rows removed with the folder left behind would be a folder nothing ever names again.
    expect(
      await deletion.delete({ channelId: project.channel, userId: ME }),
    ).toEqual({ ok: false, code: PROJECT_DELETING });
    expect(await left(project)).toEqual(WHOLE);
    expect(
      await anyBeingDeleted(database, {
        channelIds: [project.channel],
        threadIds: [],
      }),
    ).toBe(true);
    expect(forgotten).toEqual([]);
    expect(await auditOf(project.channel)).toHaveLength(0);

    await deletion.finishPending();
    expect(await left(project)).toEqual(WHOLE);

    computerIsUp = true;
    expect(await deletion.finishPending()).toBeGreaterThanOrEqual(1);
    expect(await left(project)).toEqual(GONE);
    expect(forgotten).toEqual([project.channel]);
    expect(asked.filter((id) => id === project.channel)).toHaveLength(3);
    expect(await auditOf(project.channel)).toHaveLength(1);
  });
});

describe("which conversations are projects", () => {
  test("is read whole from the database: a project by its thread and its channel, the main conversation as no project", async () => {
    const project = await conversation("project");
    const threadProjects = createThreadProjects(database);

    expect(await threadProjects.load()).toBeGreaterThanOrEqual(1);

    expect(threadProjects.scopeOfThread(project.thread)).toEqual({
      kind: "project",
      id: project.channel,
    });
    expect(threadProjects.scopeOfChannel(project.channel)).toEqual({
      kind: "project",
      id: project.channel,
    });
    expect(threadProjects.scopeOfThread(MAIN.thread)).toEqual({ kind: "main" });
    expect(threadProjects.scopeOfChannel(MAIN.channel)).toEqual({
      kind: "main",
    });
    // A routine's run, a check: no conversation at all.
    expect(threadProjects.scopeOfThread(undefined)).toEqual({ kind: "main" });
  });

  test("a thread it was never told of is asked of the database, once", async () => {
    const threadProjects = createThreadProjects(database);
    const project = await conversation("project");

    expect(await threadProjects.of(project.thread)).toBe(project.channel);
    expect(await threadProjects.of(MAIN.thread)).toBeNull();
    expect(await threadProjects.of(randomUUID())).toBeNull();
    // Kept: the caller that cannot wait is now answered too.
    expect(threadProjects.scopeOfThread(project.thread)).toEqual({
      kind: "project",
      id: project.channel,
    });
  });

  test("is told of a project when the store makes one, and forgets it when it is deleted", async () => {
    const threadProjects = createThreadProjects(database);
    const telling = createChannelStore(
      database,
      createAgentProfileStore(
        database,
        new URL("https://managed.example.test/ag-ui"),
      ),
      createThreadIdentity("test-deployment"),
      undefined,
      threadProjects.remember,
    );
    const project = await telling.createProject(actor, BOT, "가을 메뉴");
    made.push({ channel: project.id, thread: project.threadId });

    // With nothing loaded and nothing asked: told.
    expect(threadProjects.scopeOfThread(project.threadId)).toEqual({
      kind: "project",
      id: project.id,
    });
    expect(threadProjects.scopeOfChannel(project.id)).toEqual({
      kind: "project",
      id: project.id,
    });

    await createProjectDeletion({
      database,
      stopThread: async () => undefined,
      forgotten: threadProjects.forget,
    }).delete({ channelId: project.id, userId: ME });

    expect(threadProjects.scopeOfThread(project.threadId)).toEqual({
      kind: "main",
    });
    expect(threadProjects.scopeOfChannel(project.id)).toEqual({ kind: "main" });
  });
});

describe("while a project is being deleted", () => {
  const asMe: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor as AppVariables["actor"]);
    await next();
  };

  test("it is not in the list, not read by its id, and not searched", async () => {
    const project = await conversation("project");
    const search = createConversationSearch({ database });
    const found = async () =>
      (await search({ cursor: null, terms: [WORD], userId: ME })).hits.map(
        (hit) => hit.channelId,
      );
    expect((await store.list(actor)).map((one) => one.id)).toContain(
      project.channel,
    );
    expect(await found()).toContain(project.channel);

    await database
      .update(channels)
      .set({ deletingAt: new Date() })
      .where(eq(channels.id, project.channel));

    expect((await store.list(actor)).map((one) => one.id)).not.toContain(
      project.channel,
    );
    expect(await store.get(actor, project.channel)).toBeNull();
    expect(await found()).not.toContain(project.channel);
    // The main conversation is where it was.
    expect((await store.list(actor)).map((one) => one.id)).toContain(
      MAIN.channel,
    );
    expect(await found()).toContain(MAIN.channel);
  });

  test("every write door refuses with the fact, a read passes, and the door that deletes goes on answering", async () => {
    const project = await conversation("project");
    const deletion = createProjectDeletion({
      database,
      stopThread: async () => {},
    });
    const reached: string[] = [];
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("/api/*", deletion.gate);
    app.route(
      "/api/channels",
      createChannelRoutes(
        store,
        asMe,
        undefined,
        undefined,
        [],
        undefined,
        deletion,
      ),
    );
    // A door of another router, naming the conversation by its thread, and one naming nothing.
    const turns = new Hono();
    turns.post("/:threadId", (context) => {
      reached.push("turn");
      return context.json({ ok: true });
    });
    turns.post("/:threadId/stop", (context) => {
      reached.push("stop");
      return context.json({ ok: true });
    });
    turns.get("/:threadId/history", (context) => context.json({ ok: true }));
    app.route("/api/turns", turns);
    app.post("/api/elsewhere", (context) => context.json({ ok: true }));

    const press = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
      });
    const read = { read: true };

    // Before the mark, the doors are doors.
    expect(
      (await press("POST", `/api/channels/${project.channel}/read`, read))
        .status,
    ).toBe(200);
    expect((await press("POST", `/api/turns/${project.thread}`)).status).toBe(
      200,
    );

    await database
      .update(channels)
      .set({ deletingAt: new Date() })
      .where(eq(channels.id, project.channel));
    reached.length = 0;

    for (const [method, path] of [
      ["POST", `/api/channels/${project.channel}/read`],
      ["POST", `/api/channels/${project.channel}/activity`],
      ["PUT", `/api/channels/${project.channel}/frames/call-1`],
      ["POST", `/api/turns/${project.thread}`],
      ["POST", `/api/turns/${project.thread}/stop`],
    ] as const) {
      const response = await press(method, path, read);
      expect([path, response.status]).toEqual([path, 409]);
      expect(await response.json()).toEqual({
        code: PROJECT_DELETING,
        error: PROJECT_DELETING,
      });
    }
    // No handler ran: the refusal is the gate's, before any of them.
    expect(reached).toEqual([]);

    // A read is not a write; a write that names no conversation is not this gate's.
    expect(
      (await press("GET", `/api/turns/${project.thread}/history`)).status,
    ).toBe(200);
    expect((await press("POST", "/api/elsewhere")).status).toBe(200);
    // Another conversation's doors are open.
    expect(
      (await press("POST", `/api/channels/${MAIN.channel}/read`, read)).status,
    ).toBe(200);
    expect((await press("POST", `/api/turns/${MAIN.thread}`)).status).toBe(200);

    // The one door that must answer for a marked project: asked again, it finishes.
    const again = await press(
      "DELETE",
      `/api/channels/projects/${project.channel}`,
    );
    expect(again.status).toBe(200);
    expect(await left(project)).toEqual(GONE);
    // And once it is gone, it is not there.
    expect(
      (await press("DELETE", `/api/channels/projects/${project.channel}`))
        .status,
    ).toBe(404);
    const main = await press(
      "DELETE",
      `/api/channels/projects/${MAIN.channel}`,
    );
    expect(main.status).toBe(409);
    expect(((await main.json()) as { code: string }).code).toBe(
      "laf:project_only",
    );
  });

  test("the door that deletes says the project is being deleted while its turn has not ended", async () => {
    const project = await conversation("project");
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/channels",
      createChannelRoutes(
        store,
        asMe,
        undefined,
        undefined,
        [],
        undefined,
        createProjectDeletion({
          database,
          stopThread: () => new Promise<void>(() => {}),
          turnSettleMs: 5,
        }),
      ),
    );
    const answer = await app.request(
      `/api/channels/projects/${project.channel}`,
      { method: "DELETE" },
    );
    expect(answer.status).toBe(409);
    expect(((await answer.json()) as { code: string }).code).toBe(
      PROJECT_DELETING,
    );
    // Finished by hand, as the clock would once the turn had ended.
    await createProjectDeletion({
      database,
      stopThread: async () => {},
    }).finishPending();
    expect(await left(project)).toEqual(GONE);
  });

  test("a write that is in a door when the mark is set is waited for, not cut off", async () => {
    const project = await conversation("project");
    const deletion = createProjectDeletion({
      database,
      stopThread: async () => {},
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const seen: number[] = [];
    const app = new Hono();
    app.use("/api/*", deletion.gate);
    app.post("/api/channels/:channelId/attachments", async (context) => {
      entered();
      await held;
      // What an upload does last: write a row that names the conversation.
      seen.push((await left(project)).channels);
      return context.json({ ok: true });
    });

    const upload = app.request(`/api/channels/${project.channel}/attachments`, {
      method: "POST",
    });
    await inside;
    const deleting = deletion.delete({
      channelId: project.channel,
      userId: ME,
    });
    // The deletion is waiting on the upload: asked now, a second upload is refused.
    while (
      !(await anyBeingDeleted(database, {
        channelIds: [project.channel],
        threadIds: [],
      }))
    ) {
      await Promise.resolve();
    }
    const second = await app.request(
      `/api/channels/${project.channel}/attachments`,
      { method: "POST" },
    );
    expect(second.status).toBe(409);
    expect((await left(project)).channels).toBe(1);

    release();
    expect((await upload).status).toBe(200);
    await deleting;
    // The upload wrote while its conversation was still there; then it went.
    expect(seen).toEqual([1]);
    expect(await left(project)).toEqual(GONE);
  });
});

describe("the conversations a request names", () => {
  test("are read from the patterns that matched it, by the two names a conversation has in a path", () => {
    expect(
      conversationsNamed(
        ["/api/*", "/api/channels/:channelId/read"],
        "/api/channels/c-1/read",
      ),
    ).toEqual({ channelIds: ["c-1"], threadIds: [] });
    expect(
      conversationsNamed(["/api/turns/:threadId"], "/api/turns/t%201"),
    ).toEqual({ channelIds: [], threadIds: ["t 1"] });
    // The door that deletes names its project by another word, on purpose.
    expect(
      conversationsNamed(
        ["/api/channels/projects/:projectId", "/api/channels/:channelId/*"],
        "/api/channels/projects/c-1",
      ),
    ).toEqual({ channelIds: ["projects"], threadIds: [] });
    expect(conversationsNamed(["/api/feed/:postId"], "/api/feed/p")).toEqual({
      channelIds: [],
      threadIds: [],
    });
  });
});

describe("the two lists that keep the next one from being forgotten", () => {
  test("every column that names a conversation without a foreign key to it is in the deletion's list", async () => {
    /*
     * FROM `pg_catalog`, NOT `information_schema`. The first writing joined three of the
     * standard's views, and on CI — four workers, each on its own copy of the database — that one
     * query ran past the five-second default (2026-10-10): `constraint_column_usage` is a view
     * over every constraint and every column the role can see. The catalogue's own tables answer
     * the same question in a millisecond.
     */
    const rows = (await database.execute(sql`
      select t.relname || '.' || a.attname as named
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class t on t.oid = a.attrelid
      where t.relnamespace = current_schema()::regnamespace
        and t.relkind in ('r', 'p')
        and a.attnum > 0
        and not a.attisdropped
        and (a.attname like '%thread_id%' or a.attname like '%channel_id%')
        and not exists (
          select 1
          from pg_catalog.pg_constraint k
          where k.conrelid = t.oid
            and k.contype = 'f'
            and k.confrelid = 'channels'::regclass
            and a.attnum = any (k.conkey)
        )
    `)) as unknown as Array<{ named: string }>;
    expect(rows.map((row) => row.named).sort()).toEqual(
      Object.keys(NAMES_A_CONVERSATION).sort(),
    );
  });

  test("every write route in the server names a conversation by `:channelId` or `:threadId`, so the gate sees it", () => {
    const root = join(import.meta.dir, "..", "src");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);

    // Any quote: a path in a template (`/:id/${verb}`) was invisible to a walk that read only `"`.
    const WRITES = /\.(post|put|patch|delete)\(\s*(["'`])((?:(?!\2).)*)\2/g;
    const ABOUT_A_CONVERSATION = /channel|thread|conversation|project|room/i;
    const routes: string[] = [];
    const strangers: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [, method, , path] of source.matchAll(WRITES)) {
        if (!path?.startsWith("/")) continue;
        routes.push(`${method} ${path}`);
        for (const parameter of path.match(/:[A-Za-z]+/g) ?? []) {
          if (!ABOUT_A_CONVERSATION.test(parameter)) continue;
          // THE ONE ROUTE, not the name: a `POST /projects/:projectId/…` written next month
          // would be a write the gate cannot see, and must fail here like any other word.
          const isTheDeletingDoor =
            method === "delete" &&
            path === "/projects/:projectId" &&
            file.endsWith("channels/conversation-routes.ts");
          if (
            parameter !== ":channelId" &&
            parameter !== ":threadId" &&
            !isTheDeletingDoor
          ) {
            strangers.push(`${file.slice(root.length)} ${method} ${path}`);
          }
        }
      }
    }
    // The walk found the server's routes at all: a pattern that matched nothing proves nothing.
    expect(routes.length).toBeGreaterThan(50);
    expect(routes).toContain("post /:threadId");
    expect(routes).toContain("post /:channelId/attachments");
    // The one route the server writes in a template today, seen.
    expect(routes).toContain("post /:id/${verb}");
    expect(strangers).toEqual([]);
  });
});
