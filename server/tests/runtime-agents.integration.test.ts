import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  botsHeldElsewhere,
  createRuntimeAgentLoader,
} from "../src/agents/runtime-agents";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { buildAgents, type RegisteredAgent } from "../src/copilot";
import { encryptSecret } from "../src/credentials";
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
// Hosted, as a deployment runs: none of the tests of who may run which Bot is about its address.
const loadAgents = createRuntimeAgentLoader(database, {
  home: managedEndpoint,
});

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
   * Every path that is not a REST read comes through here: the browser's own turn and a routine's
   * Bot (routines/run.ts) resolve their agents from this loader for a named actor. An
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

/*
 * EVERY BOT RUNS HERE, ON A HOSTED DEPLOYMENT — WHATEVER ITS ROW HOLDS (the owner, 2026-10-06).
 *
 * A hosted deployment no longer takes an endpoint of a person's own for a Bot (`agents/routes.ts`).
 * Refusing new ones is half of it. A Bot pointed elsewhere BEFORE the deployment was upgraded
 * would otherwise go on being answered there — its usage and its endings still filed here as fact
 * — and the screen that could point it back is no longer drawn. So this loader, the one place a
 * row's address and key become the agent a run dials, is told where home is: on a hosted
 * deployment every Bot is dialled there, and the key a person stored for their own server is not
 * sent to ours. The row is not rewritten: what a person once set is still what the row says.
 *
 * Held on what is DIALLED, through the same construction a run goes through (`buildAgents`), not
 * only on what the loader hands back.
 */
describe("where a Bot is dialled", () => {
  const ELSEWHERE = "https://agents.somebody.example.test/ag-ui";
  const THEIR_KEY = "Bearer a-key-for-their-own-server";
  const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  /** A vault holding the one key, and which ids it was asked for. */
  function vaultOf() {
    const asked: string[] = [];
    return {
      asked,
      vault: {
        encryptionKey: ENCRYPTION_KEY,
        reader: {
          readSecret: async (id: string) => {
            asked.push(id);
            return {
              encryptedValue: await encryptSecret(ENCRYPTION_KEY, THEIR_KEY),
              revokedAt: null,
            };
          },
        },
      },
    };
  }

  /** The row of a Bot somebody pointed at their own agent, with a key, while that was taken. */
  const POINTED = {
    endpoint: ELSEWHERE,
    auth: { header: "Authorization", credentialId: "credential-of-theirs" },
  };
  async function pointElsewhere(agentId: string) {
    await database
      .update(agents)
      .set({ configuration: POINTED })
      .where(eq(agents.id, agentId));
  }
  const configurationOf = async (agentId: string) =>
    (
      await database
        .select({ configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, agentId))
    )[0]?.configuration;

  /** One run of the Bot as the runtime builds it: the address the request went to, and its key. */
  async function dialled(registered: RegisteredAgent | undefined) {
    if (!registered) throw new Error("the Bot was not loaded");
    const seen: { url: string; authorization: string | null }[] = [];
    const built = buildAgents(
      [registered],
      { provider: "openai", defaultModel: "test/model", supportsEffort: true },
      {
        watch: () =>
          (async (url: unknown, init?: { headers?: HeadersInit }) => {
            seen.push({
              url: String(url),
              authorization: new Headers(init?.headers).get("authorization"),
            });
            return new Response(
              `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "t", runId: "r" })}\n\n` +
                `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: "t", runId: "r" })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          }) as never,
        stop: () => undefined,
      },
    )[registered.id];
    if (!built) throw new Error("no agent was built");
    built.setMessages([{ id: "m1", role: "user", content: "안녕" }]);
    await built.runAgent();
    return seen;
  }

  /*
   * THE LOADER'S DEFAULT WAS THE OPEN ONE (the independent read of #121). Where Bots run was an
   * optional third argument, and left out it meant a developer's stack: each Bot dialled where its
   * row says, with its key. The routes default shut; this did the opposite, so a second caller
   * that forgot the argument would have reopened the door for every row from before the upgrade
   * with every test here still passing. It is required now and has no default: the compiler asks
   * each caller, and each test that builds a loader says which setting it means.
   */
  test("a loader is not built without saying where Bots run: the compiler refuses the call, and so does the loader", () => {
    // Typecheck covers this file, so the directive IS the assertion: were the argument optional
    // again, it would be an unused directive and the gate would fail on it.
    // @ts-expect-error the second argument — where Bots run — is required
    expect(() => createRuntimeAgentLoader(database)).toThrow("where Bots run");
    // A caller that gets past the compiler is not given the open setting by way of a default.
    for (const forgotten of [undefined, null, {}, "", "anywhere"]) {
      expect(() =>
        createRuntimeAgentLoader(database, forgotten as never),
      ).toThrow("where Bots run");
    }
    // The two answers there are.
    expect(
      createRuntimeAgentLoader(database, { home: managedEndpoint }),
    ).toBeFunction();
    expect(
      createRuntimeAgentLoader(database, "where each row says"),
    ).toBeFunction();
  });

  test("on a hosted deployment a Bot whose row holds another address is dialled at the deployment's own agent, with no key of the person's — and its row is left as it was", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);
    await pointElsewhere(profile.id);
    const { asked, vault } = vaultOf();
    const hosted = createRuntimeAgentLoader(
      database,
      { home: managedEndpoint },
      vault,
    );

    const loaded = (await hosted(owner)).find(
      (agent) => agent.id === profile.id,
    );
    expect(loaded).toMatchObject({
      type: "remote_ag_ui",
      endpoint: managedEndpoint.toString(),
    });
    expect(loaded && "headers" in loaded).toBe(false);
    // The key was not sent, and was not so much as read out of the vault for the run.
    expect(asked).toEqual([]);
    expect(await dialled(loaded)).toEqual([
      { url: managedEndpoint.toString(), authorization: null },
    ]);
    // Nothing of theirs is anywhere in what the run was built from.
    expect(JSON.stringify(loaded)).not.toContain("somebody.example.test");
    expect(JSON.stringify(loaded)).not.toContain(THEIR_KEY);

    // THE ROW IS NOT REWRITTEN: what somebody once set is still what it says.
    expect(await configurationOf(profile.id)).toEqual(POINTED);
  });

  test("on a developer's stack the same Bot is dialled where its row says, with its key", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);
    await pointElsewhere(profile.id);
    const { asked, vault } = vaultOf();
    const developers = createRuntimeAgentLoader(
      database,
      "where each row says",
      vault,
    );

    const loaded = (await developers(owner)).find(
      (agent) => agent.id === profile.id,
    );
    expect(asked).toEqual(["credential-of-theirs"]);
    expect(await dialled(loaded)).toEqual([
      { url: ELSEWHERE, authorization: THEIR_KEY },
    ]);
  });

  test("a Bot nobody pointed anywhere is dialled at home either way", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);
    for (const load of [
      createRuntimeAgentLoader(
        database,
        "where each row says",
        vaultOf().vault,
      ),
      createRuntimeAgentLoader(
        database,
        { home: managedEndpoint },
        vaultOf().vault,
      ),
    ]) {
      const loaded = (await load(owner)).find(
        (agent) => agent.id === profile.id,
      );
      expect(await dialled(loaded)).toEqual([
        { url: managedEndpoint.toString(), authorization: null },
      ]);
    }
  });

  /*
   * WHATEVER ITS ROW HOLDS — nothing included. A row's configuration is an address and a key's
   * reference and nothing else, and a hosted deployment dials by neither, so there is nothing in it
   * left to be unusable. Skipped there, as a developer's stack skips it, such a Bot would be gone
   * from every run with no screen left that could point it anywhere: the endpoints page is the
   * one that repaired a row, and a hosted deployment does not draw it.
   */
  test.each([
    ["no address at all", {}],
    ["something that is no address", { endpoint: "not a url" }],
    ["an address nothing can dial", { endpoint: "ftp://agents.example.test/" }],
  ])(
    "a Bot whose row holds %s runs at home on a hosted deployment, and is skipped on a developer's stack as it always was",
    async (_what, configuration) => {
      const owner = await createUser();
      const profile = await createCoworker(owner);
      await database
        .update(agents)
        .set({ configuration })
        .where(eq(agents.id, profile.id));

      const developers = createRuntimeAgentLoader(
        database,
        "where each row says",
        vaultOf().vault,
      );
      expect(
        (await developers(owner)).find((agent) => agent.id === profile.id),
      ).toBeUndefined();

      const { asked, vault } = vaultOf();
      const hosted = createRuntimeAgentLoader(
        database,
        { home: managedEndpoint },
        vault,
      );
      const loaded = (await hosted(owner)).find(
        (agent) => agent.id === profile.id,
      );
      expect(await dialled(loaded)).toEqual([
        { url: managedEndpoint.toString(), authorization: null },
      ]);
      expect(asked).toEqual([]);
      // Read around, not repaired: the row says what it said.
      expect(await configurationOf(profile.id)).toEqual(configuration);
      // And it is not one that "holds another address" for the boot's count unless it names one.
      const counted = await botsHeldElsewhere(database, managedEndpoint);
      expect(counted.includes(profile.id)).toBe("endpoint" in configuration);
    },
  );

  /*
   * THE EDIT FORM'S ORDINARY SAVE SENDS NO ADDRESS, and a hosted deployment refuses one that is
   * sent — so what a save does to the row when none is sent is the whole of what a hosted
   * deployment can do to it. It keeps it: the address and the key's reference, as they were.
   */
  test("a save that names no address leaves the row's configuration as it was: a rename moves nothing", async () => {
    const owner = await createUser();
    const pointed = await createCoworker(owner);
    await pointElsewhere(pointed.id);
    const ordinary = await createCoworker(await createUser());
    const before = await configurationOf(ordinary.id);
    expect(before).toEqual({ endpoint: managedEndpoint.toString() });

    const renamed = await profileStore.update(owner, pointed.id, {
      name: "새 이름",
      roleDescription: "",
      avatarSeed: "r2c6",
      effort: "thorough",
    });
    expect(renamed.name).toBe("새 이름");
    expect(await configurationOf(pointed.id)).toEqual(POINTED);
    // And an empty one, which is what a form's cleared box becomes, is no address either.
    await profileStore.update(owner, pointed.id, {
      name: "또 새 이름",
      roleDescription: "",
      endpoint: undefined,
    });
    expect(await configurationOf(pointed.id)).toEqual(POINTED);
    expect(await configurationOf(ordinary.id)).toEqual(before);
  });

  /*
   * WHAT A BOOT SAYS OF IT (`boot/announce.ts`): how many Bots hold an address other than the
   * deployment's own, so an operator reading the first lines after an upgrade knows one came
   * home. Counted off the rows of Bots that still exist. Ids here, a number on the line, and the
   * address nowhere.
   */
  test("the Bots whose rows hold another address are found by id: the live ones, and never one that holds the deployment's own", async () => {
    const owner = await createUser();
    const pointed = await createCoworker(owner);
    await pointElsewhere(pointed.id);
    const ordinary = await createCoworker(await createUser());
    const deleted = await createCoworker(await createUser());
    await pointElsewhere(deleted.id);
    await profileStore.softDelete(
      { id: deleted.ownerUserId ?? "", role: "user" },
      deleted.id,
    );

    const elsewhere = await botsHeldElsewhere(database, managedEndpoint);
    expect(elsewhere).toContain(pointed.id);
    expect(elsewhere).not.toContain(ordinary.id);
    expect(elsewhere).not.toContain(deleted.id);
    // By what the row says against what home is: named differently, the same rows read the other way.
    const fromElsewhere = await botsHeldElsewhere(database, new URL(ELSEWHERE));
    expect(fromElsewhere).not.toContain(pointed.id);
    expect(fromElsewhere).toContain(ordinary.id);
  });
});
