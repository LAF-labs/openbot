import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { createWorkspace } from "../../agent-computer/src/workspace";
import { previewOf, spillPath, TOOL_RESULT_CUT } from "../../shared/spillover";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAttachmentRoutes } from "../src/attachments/routes";
import {
  type AttachmentFiler,
  createAttachmentService,
} from "../src/attachments/service";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createChannelRoutes } from "../src/channels/routes";
import { createChannelStore } from "../src/channels/store";
import { createThreadIdentity } from "../src/channels/thread-identity";
import {
  type ReleasingComputer,
  releaseComputerFor,
} from "../src/computer/release";
import { createDatabase } from "../src/db/client";
import {
  agentGuidance,
  agentMemories,
  agentMemoryReceipts,
  agentPreferences,
  agentProfiles,
  agents,
  auditEvents,
  channelAgents,
  channels,
  channelThreads,
  componentExclusions,
  components,
  computerStandingApprovals,
  credentials,
  lafAnswerRatings,
  lafAttachments,
  lafConversationContexts,
  lafNotifications,
  lafRoutineNotepads,
  lafRoutineRuns,
  lafRoutines,
  lafSiteConnections,
  lafThreadMessages,
  lafThreadRuns,
  pluginGrants,
  users,
} from "../src/db/schema";
import { createRoutineTicker } from "../src/routines/ticker";
import { appendMessages } from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * "Delete this Bot", and whether it did.
 *
 * MEASURED 2026-09-26 by a red-team run: the dialog promised the Bot's conversations, routines and
 * memories would go with it, and after `DELETE /api/agents/:id` answered 204 every one of them was
 * still there — the conversation listed and opened, an attached sheet downloaded whole, the memory
 * was live, and the routine kept firing and failing. This seeds one Bot with one of everything the
 * dialog and `docs/laf/data-lifecycle.md` name, deletes it through the store the route calls, and
 * looks for each of them afterwards: in the tables, through the two doors that served them, and on
 * the disk the attachment's text copy was filed on.
 *
 * AND A NEIGHBOUR. The same person's other Bot is seeded the same way and must lose nothing — every
 * statement in `bot-deletion.ts` is narrowed by one Bot's id, and the way that goes wrong is not a
 * refusal but one row too many.
 *
 * AUDIT ROWS ARE NOT CLEANED UP, and cannot be: the table refuses DELETE. They land in the
 * disposable test database under this file's per-run ids.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const owner: AgentActor = { id: `botdel-${suite}-owner`, role: "user" };
const email = `${owner.id}@example.test`;

/** Strings that are somebody's words. None may appear in a row that only counts. */
const SAID = {
  botName: `빵순이-${suite}`,
  message: `MESSAGE-${suite} 내일 재고 확인해 줘`,
  answer: `ANSWER-${suite} 확인했어요`,
  memory: `MEMORY-${suite} 일요일은 쉰다`,
  notebook: `NOTEBOOK-${suite} 영업시간 9시`,
  guidance: `GUIDANCE-${suite} 짧은 답을 좋아함`,
  instruction: `INSTRUCTION-${suite} 리뷰 요약`,
  routineName: `ROUTINE-${suite}`,
  fileName: `매출-${suite}`,
  fileBody: `아메리카노-${suite}`,
};

let workspaceRoot = "";
const workspaceOf = () => join(workspaceRoot, "workspace");
const madeAgents: string[] = [];
const madeChannels: string[] = [];
const madeThreads: string[] = [];
const madeRuns: string[] = [];
const componentName = `botdel_${suite}`;

/**
 * The deployment's computer, as far as files and a release go: the container's own workspace code
 * over a real directory, so the file the attachment filed is on a disk and its removal is a real
 * unlink rather than a note that one was asked for.
 */
function computerOn(
  root: string,
  options: { unreachable?: boolean } = {},
): ReleasingComputer & AttachmentFiler {
  const workspace = createWorkspace(root);
  return {
    forBot: () => ({
      writeFile: (input) => workspace.write(input.path, input.contents),
      async stopComputer() {
        if (options.unreachable) throw new Error("connect ECONNREFUSED");
        return { stopped: true, wasRunning: false };
      },
      removeFile: (input) => workspace.remove(input.path),
    }),
  };
}

const identity = createThreadIdentity(`botdel-${suite}`);

function storesOn(computer: ReturnType<typeof computerOn>) {
  const profiles = createAgentProfileStore(
    database,
    new URL("https://managed.example.test/ag-ui"),
    undefined,
    undefined,
    releaseComputerFor(computer, auditStore),
  );
  const conversations = createChannelStore(database, profiles, identity);
  const attachments = createAttachmentService({
    database,
    computer,
    imagesAccepted: true,
  });
  return { profiles, conversations, attachments };
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: owner.id, email, role: "user" });
  await next();
};

type Seeded = {
  botId: string;
  channelId: string;
  threadId: string;
  attachmentId: string;
  workspacePath: string;
  spilledPath: string;
  routineId: string;
};

/** One Bot with one of everything its deletion promises to take. */
async function seedBot(
  stores: ReturnType<typeof storesOn>,
  label: string,
): Promise<Seeded> {
  const botId = `agent_botdel-${suite}-${label}`;
  madeAgents.push(botId);
  await database.insert(agents).values({
    id: botId,
    name: `${SAID.botName}-${label}`,
    type: "remote_ag_ui",
    configuration: { endpoint: "https://bot.example.test/ag-ui" },
  });
  await database.insert(agentProfiles).values({
    agentId: botId,
    ownerUserId: owner.id,
    roleDescription: "가게 일을 돕는다",
    avatarSeed: botId,
    autoReview: "찾아보는 건 괜찮아요",
  });
  await database
    .insert(agentPreferences)
    .values({ userId: owner.id, agentId: botId, notify: true });

  const channel = await stores.conversations.create(owner, [botId]);
  madeChannels.push(channel.id);
  madeThreads.push(channel.threadId);
  // A page read too long to carry whole: filed on the computer by the spillover, head in the thread.
  const toolCallId = `call_${suite}_${label}`;
  const pageText = `${SAID.message} `.repeat(
    Math.ceil((TOOL_RESULT_CUT + 1) / (SAID.message.length + 1)),
  );
  await createWorkspace(workspaceOf()).write(spillPath(toolCallId), pageText);
  await appendMessages(database, channel.threadId, [
    { id: `${botId}-m1`, role: "user", content: SAID.message },
    {
      id: `${botId}-read`,
      role: "tool",
      toolCallId,
      content: previewOf(pageText, spillPath(toolCallId)),
    },
    { id: `${botId}-m2`, role: "assistant", content: SAID.answer },
  ]);
  await database.insert(lafConversationContexts).values({
    threadId: channel.threadId,
    agentId: botId,
    epoch: { system: SAID.memory },
    known: { memories: [SAID.memory] },
  });
  await database.insert(lafAnswerRatings).values({
    id: `${botId}-rating`,
    userId: owner.id,
    channelId: channel.id,
    messageId: `${botId}-m2`,
    agentId: botId,
    rating: "down",
    note: SAID.answer,
  });

  const received = await stores.attachments.receive({
    userId: owner.id,
    channelId: channel.id,
    botId,
    claimedName: `${SAID.fileName}-${label}.csv`,
    bytes: new TextEncoder().encode(`메뉴,수량\n${SAID.fileBody},42\n`),
  });
  if (!received.ok) throw new Error(received.code);
  const [filed] = await database
    .select({ workspacePath: lafAttachments.workspacePath })
    .from(lafAttachments)
    .where(eq(lafAttachments.id, received.attachment.id));
  if (!filed?.workspacePath) throw new Error("the sheet was not filed");

  await database.insert(agentMemories).values([
    {
      id: `${botId}-memory`,
      agentId: botId,
      ownerUserId: owner.id,
      content: SAID.memory,
    },
    {
      id: `${botId}-notebook`,
      agentId: botId,
      ownerUserId: owner.id,
      content: SAID.notebook,
      source: "owner",
    },
  ]);
  await database.insert(agentGuidance).values({
    id: `${botId}-guidance`,
    agentId: botId,
    ownerUserId: owner.id,
    content: SAID.guidance,
  });
  await database.insert(agentMemoryReceipts).values({
    id: `${botId}-receipt`,
    agentId: botId,
    ownerUserId: owner.id,
    job: "curation",
    checked: 1,
  });

  const routineId = `${botId}-routine`;
  await database.insert(lafRoutines).values({
    id: routineId,
    agentId: botId,
    name: SAID.routineName,
    instruction: SAID.instruction,
    scheduleKind: "interval",
    intervalMinutes: 60,
    createdById: owner.id,
    createdByRole: "user",
    nextRunAt: new Date(Date.now() + 3_600_000),
  });
  await database.insert(lafRoutineRuns).values({
    id: `${routineId}-run`,
    routineId,
    startedAt: new Date(),
    ok: true,
    answer: SAID.answer,
  });
  await database.insert(lafRoutineNotepads).values({ routineId });
  const runId = `${botId}-thread-run`;
  madeRuns.push(runId);
  await database.insert(lafThreadRuns).values({
    runId,
    threadId: channel.threadId,
    agentId: botId,
    userId: owner.id,
    label: SAID.routineName,
    status: "done",
    origin: "chat",
  });

  await database.insert(computerStandingApprovals).values({
    id: `${botId}-standing`,
    botId,
    rule: "",
    scope: "host=smartstore.naver.com",
    scopeKind: "host",
    scopeValue: "smartstore.naver.com",
    grantedBy: owner.id,
  });
  await database
    .insert(pluginGrants)
    .values({ kind: "skill", ref: `review-${suite}`, agentId: botId });
  await database
    .insert(componentExclusions)
    .values({ componentName, agentId: botId, withheldBy: email });
  await database.insert(credentials).values({
    kind: "agent",
    provider: "ag-ui",
    keyId: botId,
    encryptedValue: "sealed",
    metadata: { header: "authorization" },
  });
  await database.insert(lafNotifications).values([
    {
      id: `${botId}-failed`,
      kind: "run.failed",
      botId,
      userId: owner.id,
      channelId: channel.id,
    },
    // The person's own words to the operator: theirs, not the Bot's.
    {
      id: `${botId}-feedback`,
      kind: "support.feedback",
      botId,
      userId: owner.id,
    },
  ]);
  // A login on the deployment's browser, seen last in this Bot's tab. The person's, not the Bot's.
  await database
    .insert(lafSiteConnections)
    .values({ userId: owner.id, siteId: `site-${label}`, botId });
  // What the trail already says about it, which a deletion must not touch.
  await auditStore.insert({
    eventType: "routine.ran",
    targetType: "routine",
    targetId: routineId,
    payload: { agentId: botId, ok: true },
  });

  return {
    botId,
    channelId: channel.id,
    threadId: channel.threadId,
    attachmentId: received.attachment.id,
    workspacePath: filed.workspacePath,
    spilledPath: spillPath(toolCallId),
    routineId,
  };
}

async function rowsFor(seeded: Seeded) {
  const { botId, channelId, threadId, routineId } = seeded;
  const count = async (rows: Promise<unknown[]>) => (await rows).length;
  return {
    agents: await count(
      database.select().from(agents).where(eq(agents.id, botId)),
    ),
    profiles: await count(
      database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, botId)),
    ),
    preferences: await count(
      database
        .select()
        .from(agentPreferences)
        .where(eq(agentPreferences.agentId, botId)),
    ),
    channels: await count(
      database.select().from(channels).where(eq(channels.id, channelId)),
    ),
    channelAgents: await count(
      database
        .select()
        .from(channelAgents)
        .where(eq(channelAgents.agentId, botId)),
    ),
    threads: await count(
      database
        .select()
        .from(channelThreads)
        .where(eq(channelThreads.threadId, threadId)),
    ),
    messages: await count(
      database
        .select()
        .from(lafThreadMessages)
        .where(eq(lafThreadMessages.threadId, threadId)),
    ),
    contexts: await count(
      database
        .select()
        .from(lafConversationContexts)
        .where(eq(lafConversationContexts.agentId, botId)),
    ),
    ratings: await count(
      database
        .select()
        .from(lafAnswerRatings)
        .where(eq(lafAnswerRatings.agentId, botId)),
    ),
    attachments: await count(
      database
        .select({ id: lafAttachments.id })
        .from(lafAttachments)
        .where(eq(lafAttachments.agentId, botId)),
    ),
    memories: await count(
      database
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.agentId, botId)),
    ),
    guidance: await count(
      database
        .select()
        .from(agentGuidance)
        .where(eq(agentGuidance.agentId, botId)),
    ),
    receipts: await count(
      database
        .select()
        .from(agentMemoryReceipts)
        .where(eq(agentMemoryReceipts.agentId, botId)),
    ),
    routines: await count(
      database.select().from(lafRoutines).where(eq(lafRoutines.agentId, botId)),
    ),
    routineRuns: await count(
      database
        .select()
        .from(lafRoutineRuns)
        .where(eq(lafRoutineRuns.routineId, routineId)),
    ),
    notepads: await count(
      database
        .select()
        .from(lafRoutineNotepads)
        .where(eq(lafRoutineNotepads.routineId, routineId)),
    ),
    runs: await count(
      database
        .select()
        .from(lafThreadRuns)
        .where(eq(lafThreadRuns.threadId, threadId)),
    ),
    standing: await count(
      database
        .select()
        .from(computerStandingApprovals)
        .where(eq(computerStandingApprovals.botId, botId)),
    ),
    grants: await count(
      database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, botId)),
    ),
    exclusions: await count(
      database
        .select()
        .from(componentExclusions)
        .where(eq(componentExclusions.agentId, botId)),
    ),
    agentKeys: await count(
      database
        .select()
        .from(credentials)
        .where(
          and(eq(credentials.kind, "agent"), eq(credentials.keyId, botId)),
        ),
    ),
    notifications: await count(
      database
        .select()
        .from(lafNotifications)
        .where(
          and(
            eq(lafNotifications.botId, botId),
            eq(lafNotifications.kind, "run.failed"),
          ),
        ),
    ),
  };
}

const EVERYTHING_ONCE = {
  agents: 1,
  profiles: 1,
  preferences: 1,
  channels: 1,
  channelAgents: 1,
  threads: 1,
  messages: 3,
  contexts: 1,
  ratings: 1,
  attachments: 1,
  memories: 2,
  guidance: 1,
  receipts: 1,
  routines: 1,
  routineRuns: 1,
  notepads: 1,
  runs: 1,
  standing: 1,
  grants: 1,
  exclusions: 1,
  agentKeys: 1,
  notifications: 1,
};
// Every key of the table above, at zero: a key missing from `rowsFor` fails both comparisons.
const NOTHING = Object.fromEntries(
  Object.keys(EVERYTHING_ONCE).map((key) => [key, 0]),
) as typeof EVERYTHING_ONCE;

async function trailFor(botId: string) {
  return database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, botId));
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "laf-bot-deletion-"));
  await mkdir(workspaceOf());
  await database.insert(users).values({ id: owner.id, email, name: "사장님" });
  await database.insert(components).values({
    name: componentName,
    title: "매출 차트",
    kind: "chart",
    draftDescription: "매출을 그린다",
  });
});

afterAll(async () => {
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, madeThreads));
  await database
    .delete(lafThreadRuns)
    .where(inArray(lafThreadRuns.runId, madeRuns));
  await database.delete(channels).where(inArray(channels.id, madeChannels));
  await database
    .delete(credentials)
    .where(
      and(
        eq(credentials.kind, "agent"),
        inArray(credentials.keyId, madeAgents),
      ),
    );
  // Cascades take what hangs off each Bot, and the person takes their notices and site logins.
  await database.delete(agents).where(inArray(agents.id, madeAgents));
  await database.delete(components).where(eq(components.name, componentName));
  await database.delete(users).where(eq(users.id, owner.id));
  await rm(workspaceRoot, { recursive: true, force: true });
  await database.$client.close();
});

describe("deleting a Bot", () => {
  test("takes everything the dialog names, and leaves the same person's other Bot whole", async () => {
    const root = workspaceOf();
    const computer = computerOn(root);
    const stores = storesOn(computer);
    const doomed = await seedBot(stores, "doomed");
    const neighbour = await seedBot(stores, "neighbour");
    expect(await rowsFor(doomed)).toEqual(EVERYTHING_ONCE);
    expect(await Bun.file(join(root, doomed.workspacePath)).exists()).toBe(
      true,
    );

    await stores.profiles.delete(owner, doomed.botId);

    expect(await rowsFor(doomed)).toEqual(NOTHING);
    // The sheet's text copy went with the row that held its bytes, and the page the conversation
    // filed whole went with the conversation.
    expect(await Bun.file(join(root, doomed.workspacePath)).exists()).toBe(
      false,
    );
    expect(await Bun.file(join(root, doomed.spilledPath)).exists()).toBe(false);

    // Through the doors that served them before: the conversation and the file both answer 404.
    const channelRoutes = createChannelRoutes(
      stores.conversations,
      requireUser,
    );
    expect((await channelRoutes.request(`/${doomed.channelId}`)).status).toBe(
      404,
    );
    const listed = (await (await channelRoutes.request("/")).json()) as {
      channels: Array<{ id: string }>;
    };
    expect(listed.channels.map((channel) => channel.id)).not.toContain(
      doomed.channelId,
    );
    const attachmentRoutes = createAttachmentRoutes(
      stores.attachments,
      stores.conversations,
      requireUser,
    );
    expect(
      (
        await attachmentRoutes.request(
          `/${doomed.channelId}/attachments/${doomed.attachmentId}`,
        )
      ).status,
    ).toBe(404);

    // The neighbour lost nothing, and its conversation and file still answer.
    expect(await rowsFor(neighbour)).toEqual(EVERYTHING_ONCE);
    expect(listed.channels.map((channel) => channel.id)).toContain(
      neighbour.channelId,
    );
    expect(
      (
        await attachmentRoutes.request(
          `/${neighbour.channelId}/attachments/${neighbour.attachmentId}`,
        )
      ).status,
    ).toBe(200);
    expect(await Bun.file(join(root, neighbour.workspacePath)).exists()).toBe(
      true,
    );
    expect(await Bun.file(join(root, neighbour.spilledPath)).exists()).toBe(
      true,
    );

    // What was the person's rather than the Bot's stays: their login, their words to the operator.
    expect(
      await database
        .select({ siteId: lafSiteConnections.siteId })
        .from(lafSiteConnections)
        .where(eq(lafSiteConnections.botId, doomed.botId)),
    ).toEqual([{ siteId: "site-doomed" }]);
    expect(
      await database
        .select({ id: lafNotifications.id })
        .from(lafNotifications)
        .where(eq(lafNotifications.id, `${doomed.botId}-feedback`)),
    ).toHaveLength(1);

    const trail = await trailFor(doomed.botId);
    // The trail keeps what it said before the deletion.
    expect(
      (await trailFor(doomed.routineId)).map((row) => row.eventType),
    ).toEqual(["routine.ran"]);

    const deleted = trail.filter((row) => row.eventType === "agent.deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.actorUserId).toBe(owner.id);
    expect(deleted[0]?.payload).toEqual({
      bot: doomed.botId,
      counts: {
        threadMessages: 3,
        conversationContexts: 1,
        answerRatings: 1,
        attachments: 1,
        runs: 1,
        notifications: 1,
        conversations: 1,
        routineRuns: 1,
        routineNotepads: 1,
        routines: 1,
        memories: 2,
        guidance: 1,
        memoryReceipts: 1,
        standingApprovals: 1,
        grants: 1,
        componentExclusions: 1,
        botPreferences: 1,
        agentKeys: 1,
        profile: 1,
        bot: 1,
      },
      filesOnComputer: 2,
    });
    // Counts, never content: nothing anybody said, wrote or named is in either row.
    const released = trail.filter(
      (row) => row.eventType === "computer.released",
    );
    expect(released).toHaveLength(1);
    expect(released[0]?.payload).toMatchObject({
      loginsKept: true,
      files: { removed: 2, alreadyGone: 0, failed: 0 },
    });
    const written = JSON.stringify([deleted[0]?.payload, released[0]?.payload]);
    for (const words of Object.values(SAID)) {
      expect(written).not.toContain(words);
    }
    expect(written).not.toContain(doomed.workspacePath);
    expect(written).not.toContain(doomed.spilledPath);
  });

  test("a file already gone from the computer does not fail the delete", async () => {
    const root = workspaceOf();
    const stores = storesOn(computerOn(root));
    const seeded = await seedBot(stores, "emptied");
    // Somebody emptied the folder first.
    await createWorkspace(root).remove(seeded.workspacePath);

    await stores.profiles.delete(owner, seeded.botId);

    expect(await rowsFor(seeded)).toEqual(NOTHING);
    const [released] = (await trailFor(seeded.botId)).filter(
      (row) => row.eventType === "computer.released",
    );
    expect(released?.payload).toMatchObject({
      files: { removed: 1, alreadyGone: 1, failed: 0 },
    });
  });

  test("a computer that cannot be reached leaves the rows gone and says the release failed, not a reset", async () => {
    const root = workspaceOf();
    const stores = storesOn(computerOn(root, { unreachable: true }));
    const seeded = await seedBot(stores, "unreachable");

    await stores.profiles.delete(owner, seeded.botId);

    expect(await rowsFor(seeded)).toEqual(NOTHING);
    const types = (await trailFor(seeded.botId)).map((row) => row.eventType);
    expect(types.sort()).toEqual(["agent.deleted", "computer.release_failed"]);
    const [failed] = (await trailFor(seeded.botId)).filter(
      (row) => row.eventType === "computer.release_failed",
    );
    // The file it could not reach is on the record as a number.
    expect(failed?.payload).toMatchObject({ filesLeft: 2 });
    expect(await Bun.file(join(root, seeded.workspacePath)).exists()).toBe(
      true,
    );
  });
});

describe("the clock and a deleted Bot", () => {
  /*
   * Far enough back that no other suite's routine is due: the ticker claims every due routine in the
   * database, and this must only ever claim its own.
   */
  const NOW = new Date("1999-06-01T00:00:00Z");

  test("never runs a routine whose Bot was deleted the old way, and still runs a live Bot's", async () => {
    const stores = storesOn(computerOn(workspaceOf()));
    const legacy = await seedBot(stores, "legacy");
    const live = await seedBot(stores, "live");
    // Deleted before deletion removed anything: `deleted_at` set, the routine left on.
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, legacy.botId));
    await database
      .update(lafRoutines)
      .set({ nextRunAt: new Date(NOW.getTime() - 30_000) })
      .where(inArray(lafRoutines.id, [legacy.routineId, live.routineId]));

    const executed: string[] = [];
    await createRoutineTicker({
      database,
      now: () => NOW,
      execute: async (row) => {
        executed.push(row.id);
        return true;
      },
    }).tick();

    expect(executed).toContain(live.routineId);
    expect(executed).not.toContain(legacy.routineId);
    // Not claimed either: its window did not move.
    const [untouched] = await database
      .select({
        nextRunAt: lafRoutines.nextRunAt,
        enabled: lafRoutines.enabled,
      })
      .from(lafRoutines)
      .where(eq(lafRoutines.id, legacy.routineId));
    expect(untouched?.nextRunAt.getTime()).toBe(NOW.getTime() - 30_000);

    // And a Bot deleted now has no routine left for the clock to find.
    await stores.profiles.delete(owner, live.botId);
    expect(
      await database
        .select({ id: lafRoutines.id })
        .from(lafRoutines)
        .where(eq(lafRoutines.id, live.routineId)),
    ).toEqual([]);
  });
});
