import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import {
  CoworkerCallError,
  createCoworkerCall,
} from "../src/agents/coworker-call";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  channelThreads,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const managedEndpoint = new URL("https://managed.example.test/ag-ui");
const profileStore = createAgentProfileStore(database, managedEndpoint);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const loadAgents = createRuntimeAgentLoader(database);

const testPrefix = `runtime-agents-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(channelThreads)
      .where(eq(channelThreads.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(role: AgentActor["role"] = "user") {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Runtime Agents Test User",
  });
  createdUserIds.push(id);
  return { id, role } satisfies AgentActor;
}

async function createCoworker(
  owner: AgentActor,
  overrides: { name?: string } = {},
) {
  const profile = await profileStore.create(owner, {
    name: overrides.name ?? "Expense Manager",
    title: "Finance Operations",
    roleDescription:
      "Review receipts, categorize expenses, and prepare reimbursement reports.",
  });
  createdAgentIds.push(profile.id);
  return profile;
}

/**
 * A Bot the deployment itself ships: an `agent_profiles` row with no owner.
 *
 * Inserted rather than created through the store, because `create` always makes the caller the
 * owner — which is the point of it. This is the one kind of Bot that is nobody's in particular.
 */
async function createDeploymentCoworker(name = "Deployment Helper") {
  const agentId = `${testPrefix}-deployment-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name,
    type: "remote_ag_ui",
    configuration: { endpoint: managedEndpoint.toString() },
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: null,
    title: "For everybody here",
    roleDescription: "Shipped with the deployment.",
    avatarSeed: agentId,
  });
  return { id: agentId, name };
}

function idsOf(loaded: Awaited<ReturnType<typeof loadAgents>>) {
  return loaded.map((agent) => agent.id);
}

/**
 * Which coworkers exist is a per-person question, answered on every request. These assertions are
 * against the database rather than a fake, because the whole point of resolving here is that the
 * filtering happens in the query and not in JavaScript after every row has already been read.
 */
describe("runtime agent loading", () => {
  test("carries the owner's coworker with its standing role and managed endpoint", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    const loaded = await loadAgents(owner);

    expect(loaded).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "remote_ag_ui",
      endpoint: managedEndpoint.toString(),
      /*
       * The PROFILE, not a finished message. The prompt is composed per run — one of the things it
       * says is what time it is — so what a loader hands over is who the Bot is, and the middleware
       * turns that into words at the moment the run starts.
       */
      profile: {
        id: profile.id,
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription:
          "Review receipts, categorize expenses, and prepare reimbursement reports.",
        memories: [],
      },
      // Every Bot anybody creates is remote, so this loader is where a remote Bot's model setting
      // has to arrive from. The column's default, for a Bot nobody has chosen one for.
      effort: "balanced",
    });
  });

  /**
   * The roster a turn runs against, which is where "cannot see it" becomes "cannot use it".
   *
   * Every path that is not a REST read comes through here: the browser's own turn, a room's
   * members (rooms/service.ts), a routine's Bot (routines/run.ts) and one Bot asking another
   * (agents/coworker-call.ts) all resolve their agents from this loader for a named actor. An
   * administrator whose roster was unfiltered here had every private Bot on the deployment mounted
   * as a runnable agent on every turn they took.
   */
  test("hides a coworker from everybody but its owner, an administrator included", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const administrator = await createUser("admin");
    const profile = await createCoworker(owner);

    expect(idsOf(await loadAgents(owner))).toContain(profile.id);
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
    expect(idsOf(await loadAgents(administrator))).not.toContain(profile.id);
  });

  test("leaves everybody their own coworkers and the ones the deployment ships", async () => {
    const owner = await createUser();
    const administrator = await createUser("admin");
    const theirs = await createCoworker(administrator);
    const mine = await createCoworker(owner, { name: "Company Helper" });
    const shipped = await createDeploymentCoworker();

    const adminsRoster = idsOf(await loadAgents(administrator));
    expect(adminsRoster).toContain(theirs.id);
    expect(adminsRoster).toContain(shipped.id);
    expect(adminsRoster).not.toContain(mine.id);

    const ownersRoster = idsOf(await loadAgents(owner));
    expect(ownersRoster).toContain(mine.id);
    expect(ownersRoster).toContain(shipped.id);
    expect(ownersRoster).not.toContain(theirs.id);
  });

  /**
   * One Bot asking another, against the real loader rather than a stubbed roster.
   *
   * `coworker-call.test.ts` hands `resolveAgents` a fixed map, so it can say what the call does
   * with a roster and nothing about which roster a person gets — the same gap that let the
   * live-screen socket open on a public Bot while its unit test stayed green (audit A8). This is
   * the by-id half: the asking Bot names the target in the request, so the refusal has to come
   * from the target's absence from THIS actor's roster and not from a list nobody consulted.
   */
  test("a coworker nobody may see cannot be asked by id either", async () => {
    const owner = await createUser();
    const administrator = await createUser("admin");
    const theirs = await createCoworker(owner);
    const asking = await createCoworker(administrator, { name: "제 것" });
    const call = createCoworkerCall({
      resolveAgents: async (actor) => {
        const loaded = await loadAgents(actor);
        return Object.fromEntries(
          loaded.map((agent) => [agent.id, agent as unknown as AbstractAgent]),
        );
      },
    });

    const attempt = call.ask(
      administrator,
      asking.id,
      theirs.id,
      "오늘 정산 얼마였어?",
    );

    await expect(attempt).rejects.toMatchObject({
      code: "laf:coworker_not_found",
      status: 404,
    });
    // The id is in the refusal because the ASKING MODEL is given it back verbatim, and it must not
    // also carry the Bot's name or title — that is the leak, one refusal later.
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(CoworkerCallError);
      expect((error as CoworkerCallError).message).not.toContain(
        "Expense Manager",
      );
      expect((error as CoworkerCallError).message).not.toContain(
        "Finance Operations",
      );
    });
  });

  test("mounts a coworker the deployment ships for everybody signed in", async () => {
    // The one exception to ownership, and it is not an exception to the rule so much as the case
    // the rule does not reach: a package's Bot is nobody's, so there is nobody for it to be
    // private from. `agents/first-task.ts` and the intro chips are built on it existing.
    const owner = await createUser();
    const otherUser = await createUser();
    const shipped = await createDeploymentCoworker("Company Helper");

    for (const actor of [owner, otherUser]) {
      expect(idsOf(await loadAgents(actor))).toContain(shipped.id);
    }
  });

  test("drops a deleted coworker that has no history to restore", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    await profileStore.softDelete(owner, profile.id);

    expect(idsOf(await loadAgents(owner))).not.toContain(profile.id);
  });

  test("keeps a deleted coworker as a tombstone for a channel member", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const profile = await createCoworker(owner);
    const channel = await channelStore.create(owner, [profile.id]);
    createdChannelIds.push(channel.id);

    await profileStore.softDelete(owner, profile.id);

    expect(await loadAgents(owner)).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "unavailable",
      reason:
        "Expense Manager has been deleted and can no longer run. Its conversations remain readable.",
    });
    // Somebody with no channel of their own gets no tombstone: history is what authorizes it.
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
  });

  test("applies an edited role to the next load without a restart", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    await profileStore.update(owner, profile.id, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Reconcile corporate card statements.",
    });

    const reloaded = (await loadAgents(owner)).find(
      (agent) => agent.id === profile.id,
    );
    expect(
      reloaded?.type === "remote_ag_ui" && reloaded.profile.roleDescription,
    ).toBe("Reconcile corporate card statements.");
  });
});
