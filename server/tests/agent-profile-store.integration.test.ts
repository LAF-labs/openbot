import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import {
  AccountHasBotError,
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  createAgentProfileStore,
  ProtectedAgentError,
} from "../src/agents/profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  channels,
  deploymentPackages,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const managedAgentAgUiUrl = new URL("https://managed.example.test/ag-ui");
const store: AgentProfileStore = createAgentProfileStore(
  database,
  managedAgentAgUiUrl,
);
const testPrefix = `agent-profile-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const packageId of createdPackageIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function id(kind: string) {
  return `${testPrefix}-${kind}-${randomUUID()}`;
}

async function createUser(role: AgentActor["role"] = "user") {
  const userId = id("user");
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Profile Store Test User",
  });
  createdUserIds.push(userId);
  return { id: userId, role } satisfies AgentActor;
}

async function createPackage() {
  const [deploymentPackage] = await database
    .insert(deploymentPackages)
    .values({
      tenantId: id("tenant"),
      sourcePath: "test/profile-store",
      checksum: randomUUID(),
    })
    .returning();
  if (!deploymentPackage) throw new Error("Expected deployment package.");
  createdPackageIds.push(deploymentPackage.id);
  return deploymentPackage;
}

async function createProfileFixture(options: {
  owner: AgentActor | null;
  packageId?: string;
  name?: string;
  roleDescription?: string;
  avatarSeed?: string;
  configuration?: Record<string, unknown>;
}) {
  const agentId = id("seed-agent");
  const name = options.name ?? `Seed ${randomUUID()}`;
  const roleDescription = options.roleDescription ?? "Helps test profiles.";
  const avatarSeed = options.avatarSeed ?? `avatar-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name,
    type: "remote_ag_ui",
    configuration: options.configuration ?? {
      endpoint: "https://seed.example.test/ag-ui",
    },
    packageId: options.packageId,
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: options.owner?.id ?? null,
    roleDescription,
    avatarSeed,
  });
  return { agentId, name, roleDescription, avatarSeed };
}

async function profileById(actor: AgentActor, agentId: string) {
  const profile = await store.get(actor, agentId);
  if (!profile) throw new Error(`Expected visible profile ${agentId}.`);
  return profile;
}

function expectListed(
  profiles: AgentProfile[],
  agentId: string,
  expected: boolean,
) {
  expect(profiles.some((profile) => profile.id === agentId)).toBe(expected);
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitForMutationBlock(
  applicationName: string,
  mutationSettled: () => boolean,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const blockedSessions = await database.execute(sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
      LIMIT 1
    `);
    if (blockedSessions.length > 0) return true;
    if (mutationSettled()) return false;
  }
  throw new Error(`Timed out observing blocked session ${applicationName}.`);
}

async function racePackageAttachment(
  agentId: string,
  packageId: string,
  mutate: (namedStore: AgentProfileStore) => Promise<unknown>,
) {
  const applicationName = `profile_store_lock_${randomUUID()}`;
  const namedDatabaseUrl = new URL(databaseUrl);
  namedDatabaseUrl.searchParams.set("application_name", applicationName);
  const namedDatabase = createDatabase(namedDatabaseUrl.toString(), TEST_POOL);
  const namedStore = createAgentProfileStore(
    namedDatabase,
    managedAgentAgUiUrl,
  );
  const writeAcquired = deferred();
  const releaseAttachment = deferred();
  const attachment = database.transaction(async (transaction) => {
    await transaction
      .update(agents)
      .set({ packageId })
      .where(eq(agents.id, agentId));
    writeAcquired.resolve();
    await releaseAttachment.promise;
  });
  void attachment.catch(writeAcquired.reject);

  try {
    await writeAcquired.promise;
    let settled = false;
    const outcomePromise = mutate(namedStore).then(
      (value) => {
        settled = true;
        return { status: "fulfilled", value } as const;
      },
      (reason: unknown) => {
        settled = true;
        return { reason, status: "rejected" } as const;
      },
    );
    const blocked = await waitForMutationBlock(applicationName, () => settled);
    releaseAttachment.resolve();
    await attachment;
    return { blocked, outcome: await outcomePromise };
  } finally {
    releaseAttachment.resolve();
    await attachment.catch(() => undefined);
    await namedDatabase.$client.close();
  }
}

describe("agent profile store integration", () => {
  /**
   * A BOT BELONGS TO THE ACCOUNT THAT MADE IT, AND TO NOBODY ELSE.
   *
   * MEASURED on the rehearsal deployment 2026-09-16: signing in as the deployment's administrator
   * listed three Bots, all of them marked private, two of them owned by somebody else on the same
   * VM — with their titles and the roles their owners had written for them. `accessFilter` returned
   * no WHERE clause at all for the role. The owner's decision went further than the role: "모든 봇은
   * 해당 계정 소유인 거고 다른 계정이랑은 전혀 관계없는건데? 남이 만든 봇을 다른 계정이 볼 수 있는
   * 구조라는거 자체가 잘못된 거임." There is no `public` any more to test the other side of.
   *
   * Both halves, because a list filtered while `get` stays open is the same leak behind one more
   * request: a guessed or leaked id must not be enough.
   */
  test("hides a Bot from everybody but its owner, an administrator included", async () => {
    const owner = await createUser();
    const other = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({ owner });

    expect((await profileById(owner, source.agentId)).id).toBe(source.agentId);
    expectListed(await store.list(owner), source.agentId, true);

    for (const stranger of [other, admin]) {
      // By id, not only by absence from a list.
      expect(await store.get(stranger, source.agentId)).toBeNull();
      expectListed(await store.list(stranger), source.agentId, false);
      // And not through the hidden list either, which is the same read with one clause changed.
      expectListed(await store.list(stranger, true), source.agentId, false);
    }
  });

  test("leaves everybody their own Bots and the ones the deployment ships", async () => {
    // The other half of the rule, and the one a filter written too wide would break. A Bot with no
    // owner is the deployment's own — what a package ships — and is the single exception: it
    // belongs to no person, so there is nobody for it to be private from.
    const owner = await createUser();
    const admin = await createUser("admin");
    const theirs = await createProfileFixture({ owner: admin });
    const mine = await createProfileFixture({ owner });
    const deployments = await createProfileFixture({ owner: null });

    for (const [actor, ids] of [
      [admin, [theirs.agentId, deployments.agentId]],
      [owner, [mine.agentId, deployments.agentId]],
    ] as const) {
      for (const agentId of ids) {
        expect((await profileById(actor, agentId)).id).toBe(agentId);
        expectListed(await store.list(actor), agentId, true);
      }
    }
    // And neither of them has the other's.
    expect(await store.get(admin, mine.agentId)).toBeNull();
    expect(await store.get(owner, theirs.agentId)).toBeNull();
  });

  test("stores hiding per user and moves the caller between default and hidden lists", async () => {
    // On a Bot the deployment itself ships, because that is now the only kind two people can both
    // see — and hiding has to stay a preference of theirs each rather than a fact about the Bot.
    const owner = await createUser();
    const other = await createUser();
    const source = await createProfileFixture({ owner: null });

    expectListed(await store.list(owner), source.agentId, true);
    expectListed(await store.list(owner, true), source.agentId, false);
    expectListed(await store.list(other), source.agentId, true);

    await store.setHidden(owner, source.agentId, true);
    expectListed(await store.list(owner), source.agentId, false);
    expectListed(await store.list(owner, true), source.agentId, true);
    expectListed(await store.list(other), source.agentId, true);
    expectListed(await store.list(other, true), source.agentId, false);

    await store.setHidden(owner, source.agentId, false);
    expectListed(await store.list(owner), source.agentId, true);
    expectListed(await store.list(owner, true), source.agentId, false);
    const [preference] = await database
      .select()
      .from(agentPreferences)
      .where(
        and(
          eq(agentPreferences.userId, owner.id),
          eq(agentPreferences.agentId, source.agentId),
        ),
      );
    expect(preference?.hiddenAt).toBeNull();
  });

  test("takes the endpoint and ignores every field a caller must not set", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      configuration: { endpoint: "https://preserved.example.test/ag-ui" },
    });
    const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");
    await database
      .update(agents)
      .set({ updatedAt: oldTimestamp })
      .where(eq(agents.id, source.agentId));
    await database
      .update(agentProfiles)
      .set({ updatedAt: oldTimestamp })
      .where(eq(agentProfiles.agentId, source.agentId));

    const result = await store.update(owner, source.agentId, {
      name: "Renamed Assistant",
      roleDescription: "Updated role description.",
      id: "forged-id",
      // The endpoint IS editable. A service moves host, and the alternative is deleting the
      // coworker and losing its conversations. It reaches here already validated by the same check
      // that guards creation.
      endpoint: "https://moved.example.test/ag-ui",
      // So is the face, for the same reason the name above it is: it is what somebody sees, not a
      // fact about who owns the Bot. Everything left in this payload is still forged.
      avatarSeed: "r2c6",
      ownerUserId: "forged-owner",
      packageId: deploymentPackage.id,
      deletedAt: new Date(),
    } as unknown as CreateAgentInput);

    expect(result).toMatchObject({
      id: source.agentId,
      name: "Renamed Assistant",
      roleDescription: "Updated role description.",
      ownerUserId: owner.id,
      avatarSeed: "r2c6",
      systemOwned: false,
      deletedAt: null,
    });
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical).toMatchObject({
      id: source.agentId,
      name: "Renamed Assistant",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://moved.example.test/ag-ui" },
      packageId: null,
    });
    expect(profile).toMatchObject({
      ownerUserId: owner.id,
      roleDescription: "Updated role description.",
      avatarSeed: "r2c6",
      deletedAt: null,
    });
    expect(canonical?.updatedAt.getTime()).toBeGreaterThan(
      oldTimestamp.getTime(),
    );
    expect(profile?.updatedAt.getTime()).toBeGreaterThan(
      oldTimestamp.getTime(),
    );
  });

  /**
   * The two refusals, and why they are different words.
   *
   * 403 is for a Bot somebody CAN see and may not change; 404 is for one that, as far as they are
   * concerned, is not there. Getting that round the wrong way either hands a stranger the fact that
   * an id names something, or tells somebody their own screen is broken.
   *
   * The 403 case used to be a `public` Bot they did not own. With that gone, the only Bot anybody
   * sees that is not theirs is one the deployment ships — so that is what stands here now, and the
   * 404 case is any Bot of somebody else's at all.
   */
  test("rejects a deployment Bot as unmanageable and somebody else's as absent", async () => {
    const owner = await createUser();
    const other = await createUser();
    const deployments = await createProfileFixture({ owner: null });
    const theirs = await createProfileFixture({ owner });
    const input: CreateAgentInput = {
      name: "Other Name",
      roleDescription: "Other role.",
    };

    await expect(
      store.update(other, deployments.agentId, input),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    // Seen, so it can be tidied off their own screen — a preference, not a change to the Bot.
    await store.setHidden(other, deployments.agentId, true);
    expectListed(await store.list(other), deployments.agentId, false);
    expectListed(await store.list(other, true), deployments.agentId, true);

    await expect(
      store.update(other, theirs.agentId, input),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(
      store.setHidden(other, theirs.agentId, true),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("rejects update and soft delete for a package-backed profile", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      packageId: deploymentPackage.id,
    });
    const input: CreateAgentInput = {
      name: "Protected Rename",
      roleDescription: "Protected role.",
    };

    const profile = await profileById(owner, source.agentId);
    expect(profile.systemOwned).toBe(true);
    await expect(
      store.update(owner, source.agentId, input),
    ).rejects.toBeInstanceOf(ProtectedAgentError);
    await expect(
      store.softDelete(owner, source.agentId),
    ).rejects.toBeInstanceOf(ProtectedAgentError);
  });

  test("serializes update authorization against concurrent package attachment", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      name: "Original Name",
      roleDescription: "Original role.",
    });

    const { blocked, outcome } = await racePackageAttachment(
      source.agentId,
      deploymentPackage.id,
      (namedStore) =>
        namedStore.update(owner, source.agentId, {
          name: "Racing Rename",
          roleDescription: "Racing role.",
        }),
    );

    expect(outcome.status).toBe("rejected");
    expect(blocked).toBe(true);
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(ProtectedAgentError);
    }
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.name).toBe(source.name);
    expect(canonical?.packageId).toBe(deploymentPackage.id);
    expect(profile).toMatchObject({
      deletedAt: null,
      roleDescription: source.roleDescription,
    });
  });

  test("serializes soft-delete authorization against concurrent package attachment", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({ owner });

    const { blocked, outcome } = await racePackageAttachment(
      source.agentId,
      deploymentPackage.id,
      (namedStore) => namedStore.softDelete(owner, source.agentId),
    );

    expect(outcome.status).toBe("rejected");
    expect(blocked).toBe(true);
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(ProtectedAgentError);
    }
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.packageId).toBe(deploymentPackage.id);
    expect(profile?.deletedAt).toBeNull();
  });

  /**
   * What `canManageAgent` still grants, and where it now runs out.
   *
   * The management rule itself is untouched — it still says an administrator manages a Bot that is
   * not theirs — but it is asked SECOND. Every mutating verb loads the profile through the access
   * filter first, so a Bot the administrator may not see is one they are never asked whether they
   * may manage. What is left for the rule to grant is a Bot of their own, which they would manage
   * as its owner anyway; what a package ships it refuses outright as `systemOwned`.
   *
   * The refusal is `AgentNotFoundError`, the same answer a stranger gets, and not a 403 that would
   * confirm the id names something real.
   */
  test("lets an admin update and soft delete a Bot of their own", async () => {
    const admin = await createUser("admin");
    const source = await createProfileFixture({ owner: admin });

    const updated = await store.update(admin, source.agentId, {
      name: "Admin Rename",
      roleDescription: "Admin role update.",
    });
    expect(updated).toMatchObject({
      name: "Admin Rename",
      ownerUserId: admin.id,
    });

    await store.softDelete(admin, source.agentId);
    expect(await store.get(admin, source.agentId)).toBeNull();
  });

  test("refuses an admin every verb on a Bot they do not own, by id", async () => {
    const owner = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({ owner });
    const input: CreateAgentInput = {
      name: "Admin Rename",
      roleDescription: "Admin role update.",
    };

    for (const attempt of [
      () => store.update(admin, source.agentId, input),
      () => store.softDelete(admin, source.agentId),
      () => store.setHidden(admin, source.agentId, true),
      () => store.setPreferences(admin, source.agentId, { notify: false }),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(AgentNotFoundError);
    }
    // And the Bot is untouched.
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(profile).toMatchObject({
      deletedAt: null,
      ownerUserId: owner.id,
    });
  });

  test("soft deletes a profile from reads and lists while retaining its raw rows", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({ owner });

    await store.softDelete(owner, source.agentId);

    expect(await store.get(owner, source.agentId)).toBeNull();
    expectListed(await store.list(owner), source.agentId, false);
    expectListed(await store.list(owner, true), source.agentId, false);
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.id).toBe(source.agentId);
    expect(profile?.agentId).toBe(source.agentId);
    expect(profile?.deletedAt).toBeInstanceOf(Date);
    await expect(
      store.setHidden(owner, source.agentId, true),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("rolls back canonical creation when the profile insert fails", async () => {
    const owner = await createUser();
    const name = `Rollback ${randomUUID()}`;

    await expect(
      store.create(owner, {
        name,
        // NOT NULL, so the profile insert fails after the canonical row went in.
        roleDescription: null,
      } as unknown as CreateAgentInput),
    ).rejects.toThrow();
    const rows = await database
      .select()
      .from(agents)
      .where(eq(agents.name, name));
    expect(rows).toHaveLength(0);
  });

  test("creates a caller-owned remote AG-UI profile", async () => {
    const owner = await createUser();
    const input: CreateAgentInput = {
      name: `Created ${randomUUID()}`,
      roleDescription: "Created role description.",
    };

    const created = await store.create(owner, input);
    createdAgentIds.push(created.id);

    expect(created).toMatchObject({
      name: input.name,
      roleDescription: input.roleDescription,
      avatarSeed: created.id,
      ownerUserId: owner.id,
      systemOwned: false,
      hidden: false,
      deletedAt: null,
    });
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, created.id));
    expect(canonical).toMatchObject({
      id: created.id,
      name: input.name,
      type: "remote_ag_ui",
      configuration: { endpoint: managedAgentAgUiUrl.toString() },
      packageId: null,
    });
  });
});

/**
 * One Bot a person (2026-09-24; it was five).
 *
 * The Bot past the cap must fail to be created — not exist and then fail to reach a computer. The
 * cap is injected where a test needs an account the way it looked before it came down to one, and
 * the product number is what `createAgentProfileStore` uses when nothing is passed.
 */
describe("the seat cap", () => {
  test("a person makes one Bot, and the second is refused with its own code", async () => {
    const owner = await createUser();
    const oneBot = createAgentProfileStore(database, managedAgentAgUiUrl);

    const first = await oneBot.create(owner, {
      name: `First ${randomUUID()}`,
      roleDescription: "",
    });
    createdAgentIds.push(first.id);

    const second = oneBot.create(owner, {
      name: `Second ${randomUUID()}`,
      roleDescription: "",
    });
    await expect(second).rejects.toBeInstanceOf(AccountHasBotError);
    await expect(second).rejects.toMatchObject({
      code: "laf:account_has_bot",
      status: 409,
    });
    // Refused before anything was written: still exactly the one.
    const [held] = await database
      .select({ count: count() })
      .from(agentProfiles)
      .where(
        and(
          eq(agentProfiles.ownerUserId, owner.id),
          isNull(agentProfiles.deletedAt),
        ),
      );
    expect(Number(held?.count)).toBe(1);
  });

  /*
   * THE TRIAL CUSTOMER'S CASE. An account that had several Bots before the cap came down keeps
   * every one of them — listed, readable, editable — and is refused only the next.
   */
  test("an account that already has several keeps them all, and is refused only a new one", async () => {
    const owner = await createUser();
    const oneBot = createAgentProfileStore(database, managedAgentAgUiUrl);
    const older = await createProfileFixture({ owner });
    const newer = await createProfileFixture({ owner });

    const listed = (await oneBot.list(owner)).map((profile) => profile.id);
    expect(listed).toContain(older.agentId);
    expect(listed).toContain(newer.agentId);

    const renamed = await oneBot.update(owner, newer.agentId, {
      name: "둘째 봇",
      roleDescription: newer.roleDescription,
    });
    expect(renamed.name).toBe("둘째 봇");

    await expect(
      oneBot.create(owner, { name: "셋째", roleDescription: "" }),
    ).rejects.toBeInstanceOf(AccountHasBotError);
    expect((await oneBot.list(owner)).map((profile) => profile.id)).toEqual(
      expect.arrayContaining([older.agentId, newer.agentId]),
    );
  });

  test("refuses the Bot that would need one seat too many, and seats one after a deletion", async () => {
    /*
     * A FRESH PERSON, so the count starts at nothing.
     *
     * This used to count every undeleted profile in the database and set the cap two above it,
     * because the seats were counted deployment-wide and the test had to work around whatever else
     * happened to exist. Seats are this person's now, so the arrangement is the whole test: two
     * seats, two Bots, and the third must fail to exist.
     */
    const owner = await createUser();
    const capped = createAgentProfileStore(
      database,
      managedAgentAgUiUrl,
      undefined,
      2,
    );

    const seeded: string[] = [];
    for (let seat = 0; seat < 2; seat += 1) {
      seeded.push((await createProfileFixture({ owner })).agentId);
    }

    const input = {
      name: `Sixth ${randomUUID()}`,
      roleDescription: "Should never come to exist.",
    };
    await expect(capped.create(owner, input)).rejects.toThrow(
      AccountHasBotError,
    );

    // A freed seat is a usable seat: soft-delete one and the same create goes through.
    const [freed] = seeded;
    if (!freed) throw new Error("the fixtures did not seat anybody");
    await capped.softDelete(owner, freed);
    const created = await capped.create(owner, input);
    createdAgentIds.push(created.id);
    expect(created.name).toBe(input.name);
  });

  test("deleting a Bot releases its computer, with the Bot's id", async () => {
    /*
     * AUDIT A3 (2026-09-10): the delete route set `deleted_at` and touched the computer not at all,
     * so a deleted Bot's browser stayed running and its profile — its logins — stayed on disk. The
     * store now hands the deleted Bot to the release hook after the row is gone.
     */
    const released: Array<{ agentId: string; actorId: string }> = [];
    const withRelease = createAgentProfileStore(
      database,
      managedAgentAgUiUrl,
      undefined,
      undefined,
      async (agentId, actor) => {
        released.push({ agentId, actorId: actor.id });
      },
    );
    const owner = await createUser();
    const { agentId } = await createProfileFixture({ owner });

    await withRelease.softDelete(owner, agentId);

    expect(released).toEqual([{ agentId, actorId: owner.id }]);
    // And the row really is gone, so the release is not instead of the delete.
    expect(await withRelease.get(owner, agentId)).toBeNull();
  });

  test("a release that throws does not fail the delete", async () => {
    // The Bot is off the roster whichever way the computer answered; a reset that failed must not
    // leave a person deleting a Bot that no longer exists. The hook records its own failure.
    const withFailingRelease = createAgentProfileStore(
      database,
      managedAgentAgUiUrl,
      undefined,
      undefined,
      async () => {
        throw new Error("the computer is unreachable");
      },
    );
    const owner = await createUser();
    const { agentId } = await createProfileFixture({ owner });

    await expect(
      withFailingRelease.softDelete(owner, agentId),
    ).resolves.toBeUndefined();
    expect(await withFailingRelease.get(owner, agentId)).toBeNull();
  });

  test("somebody else's Bots do not take your seats", async () => {
    /*
     * THE BUG THIS PAIR EXISTS FOR. The count had no owner filter, so every undeleted profile in
     * the deployment held a seat. Measured on a development machine: five profiles, two of them
     * this person's, and their sixth Bot refused with "all five seats are taken" — three of the
     * five belonged to nobody, shipped by a package. On a shared deployment it is worse, and the
     * person it happens to has no way to see why.
     */
    const owner = await createUser();
    const stranger = await createUser();
    const capped = createAgentProfileStore(
      database,
      managedAgentAgUiUrl,
      undefined,
      2,
    );

    // The stranger fills their own two seats, and a Bot owned by nobody sits beside them.
    await createProfileFixture({ owner: stranger });
    await createProfileFixture({ owner: stranger });
    await createProfileFixture({ owner: null });

    const created = await capped.create(owner, {
      name: `Mine ${randomUUID()}`,
      roleDescription: "",
    });
    createdAgentIds.push(created.id);
    expect(created.name).toContain("Mine");
  });

  /**
   * The cap under a burst, which is the only condition it was ever actually at risk in.
   *
   * The count sat inside the transaction under a comment saying that racing creates "serialize
   * here". They did not: read committed hands every transaction its own snapshot, so six creates
   * for an account with one seat left all read the same number, all pass the check and all insert.
   * Nothing downstream catches it — a seat cap is a count, and there is no constraint that counts
   * rows. The fix is `pg_advisory_xact_lock` on the owner before counting; this is what tells the
   * two apart, because both spellings pass every sequential test in this file.
   *
   * One connection per racer on purpose. At the shared pool's two, the pool would do the queuing
   * and the test would go green against the broken version.
   */
  async function raceForTheLastSeat(
    racers: number,
    attempt: (
      store: AgentProfileStore,
      owner: AgentActor,
      sourceAgentId: string,
    ) => Promise<unknown>,
  ) {
    const owner = await createUser();
    const seats = 3;
    const racingDatabase = createDatabase(databaseUrl, { max: racers });
    const racingStore = createAgentProfileStore(
      racingDatabase,
      managedAgentAgUiUrl,
      undefined,
      seats,
    );
    // Two of three seats spoken for, so exactly one of the racers can be seated.
    const source = await createProfileFixture({ owner });
    await createProfileFixture({ owner });

    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: racers }, () =>
          attempt(racingStore, owner, source.agentId),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") {
          createdAgentIds.push((outcome.value as AgentProfile).id);
        }
      }
      const [held] = await database
        .select({ count: count() })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.ownerUserId, owner.id),
            isNull(agentProfiles.deletedAt),
          ),
        );
      return { held: Number(held?.count ?? 0), outcomes, seats };
    } finally {
      await racingDatabase.$client.close();
    }
  }

  function expectExactlyOneSeated(
    outcomes: PromiseSettledResult<unknown>[],
    held: number,
    seats: number,
  ) {
    expect(outcomes.filter((one) => one.status === "fulfilled")).toHaveLength(
      1,
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(AccountHasBotError);
      }
    }
    // The table agrees, which is the assertion that survives a change of error type.
    expect(held).toBe(seats);
  }

  test("six creates racing for the last seat seat exactly one Bot", async () => {
    const { held, outcomes, seats } = await raceForTheLastSeat(
      6,
      (store, owner) =>
        store.create(owner, {
          name: `Racer ${randomUUID()}`,
          roleDescription: "Only one of these may come to exist.",
        }),
    );

    expectExactlyOneSeated(outcomes, held, seats);
  });
});
