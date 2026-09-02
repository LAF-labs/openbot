import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createAccountDeletion } from "../src/account/deletion";
import { createAccountExport } from "../src/account/export";
import { pseudonymFor } from "../src/account/pseudonym";
import { createRetentionJob } from "../src/account/retention";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentMemories,
  agentPreferences,
  agentProfiles,
  agents,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  computerStandingApprovals,
  credentials,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
  skills,
  users,
} from "../src/db/schema";
import { appendMessages } from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * A person takes their data and leaves, WITH SOMEBODY ELSE STILL ON THE DEPLOYMENT.
 *
 * The second person is the whole point of this file. Every statement in `account/deletion.ts` is
 * narrowed by one person's id or by the ids of their Bots, and the way that goes wrong is not a
 * refusal — it is a delete that quietly takes one row too many. A test with one account cannot see
 * that; a test with two sees it as the second account's rows disappearing.
 *
 * AUDIT ROWS ARE NOT CLEANED UP, and cannot be: the table refuses DELETE, which is the property
 * `audit-append-only.integration.test.ts` exists to hold. They land in the disposable test database
 * marked with this file's per-run id.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);

type Person = {
  id: string;
  email: string;
  botId: string;
  channelId: string;
  threadId: string;
  routineId: string;
  skillId: string;
  runId: string;
  approvalId: string;
};

async function makePerson(label: string): Promise<Person> {
  const id = `acct-${suite}-${label}`;
  const email = `${id}@example.test`;
  const botId = `${id}-bot`;
  const channelId = `${id}-channel`;
  const threadId = `${id}-thread`;
  const routineId = `${id}-routine`;
  const skillId = `${id}-skill`;
  const runId = `${id}-run`;
  const approvalId = `${id}-standing`;

  await database.insert(users).values({ id, email, name: label });
  await database.insert(agents).values({
    id: botId,
    name: `${label}'s Bot`,
    type: "remote_ag_ui",
    configuration: {
      endpoint: "https://bot.example.test/ag-ui",
      // A vault POINTER, and the export must not carry it: see `endpointOf`.
      auth: { header: "authorization", credentialKeyId: `${id}-key` },
    },
  });
  await database.insert(agentProfiles).values({
    agentId: botId,
    ownerUserId: id,
    title: "Bookkeeping",
    roleDescription: "Keeps the books.",
    avatarSeed: "seed",
    visibility: "private",
  });
  await database
    .insert(agentPreferences)
    .values({ userId: id, agentId: botId, notify: true });
  await database.insert(agentMemories).values({
    id: `${id}-memory`,
    agentId: botId,
    ownerUserId: id,
    content: `${label} closes on Sundays.`,
  });
  await database.insert(channels).values({
    id: channelId,
    name: `${label} and the Bot`,
    description: "A private conversation.",
  });
  await database.insert(channelMemberships).values({ channelId, userId: id });
  await database.insert(channelAgents).values({ channelId, agentId: botId });
  await database
    .insert(channelThreads)
    .values({ userId: id, channelId, threadId });
  await appendMessages(database, threadId, [
    { id: `${id}-m1`, role: "user", content: `${label} asked something.` },
    { id: `${id}-m2`, role: "assistant", content: "The Bot answered." },
  ]);
  await database.insert(lafRoutines).values({
    id: routineId,
    agentId: botId,
    name: "Morning check",
    instruction: "Check the orders.",
    scheduleKind: "daily",
    dailyLocal: "09:00",
    dailyTimeZone: "Asia/Seoul",
    createdById: id,
    createdByRole: "user",
    nextRunAt: new Date(),
  });
  await database.insert(lafRoutineRuns).values({
    id: `${routineId}-run`,
    routineId,
    startedAt: new Date(),
    ok: true,
    answer: "Nothing new.",
  });
  await database.insert(lafThreadRuns).values({
    runId,
    threadId,
    agentId: botId,
    userId: id,
    status: "done",
    origin: "chat",
    startedAt: new Date(),
  });
  await database.insert(skills).values({
    id: skillId,
    ownerUserId: id,
    slug: `${id}-standup`,
    title: "Standup",
    summary: "One line.",
    instructions: "Say what happened.",
    installedBy: email,
  });
  await database.insert(computerStandingApprovals).values({
    id: approvalId,
    botId,
    rule: "computer.host == 'example.test'",
    scope: "host=example.test",
    scopeKind: "host",
    scopeValue: "example.test",
    subject: {
      kind: "browser",
      intent: "read",
      host: "example.test",
      reason: "policy_ask",
    },
    grantedBy: id,
  });
  // A vault row of the shape `retireConnectionsFor` finds: the person's id is the key.
  await database.insert(credentials).values({
    kind: "mcp_user_token",
    provider: `${id}-vendor`,
    encryptedValue: "not-a-real-secret",
    keyId: id,
    metadata: {},
  });
  await auditStore.insert({
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: botId,
    actorUserId: id,
    payload: { note: `account-lifecycle ${suite}` },
  });

  return {
    id,
    email,
    botId,
    channelId,
    threadId,
    routineId,
    skillId,
    runId,
    approvalId,
  };
}

let leaver: Person;
let stayer: Person;

beforeAll(async () => {
  leaver = await makePerson("leaver");
  stayer = await makePerson("stayer");
});

/** Everything the stayer made. The leaver's rows are removed by the code under test. */
afterAll(async () => {
  for (const person of [stayer, leaver].filter(Boolean)) {
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, person.threadId));
    await database
      .delete(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, person.runId));
    await database.delete(skills).where(eq(skills.id, person.skillId));
    await database.delete(credentials).where(eq(credentials.keyId, person.id));
    await database.delete(channels).where(eq(channels.id, person.channelId));
    await database.delete(agents).where(eq(agents.id, person.botId));
    await database.delete(users).where(eq(users.id, person.id));
  }
  await database.$client.close();
});

async function readExport(userId: string) {
  const exporter = createAccountExport(database);
  const text = await new Response(exporter.stream(userId)).text();
  return JSON.parse(text) as Record<string, unknown>;
}

describe("the export", () => {
  test("carries this person's account and nobody else's", async () => {
    const document = await readExport(leaver.id);

    expect(document.format).toBe("laf.account-export/1");
    expect((document.profile as { email: string }).email).toBe(leaver.email);
    expect(
      (document.bots as Array<{ id: string }>).map((bot) => bot.id),
    ).toEqual([leaver.botId]);
    expect(
      (document.memories as Array<{ content: string }>)[0]?.content,
    ).toContain("closes on Sundays");
    expect(
      (document.conversations as Array<{ messages: unknown[] }>)[0]?.messages,
    ).toHaveLength(2);
    expect(
      (document.routines as Array<{ id: string }>).map((row) => row.id),
    ).toEqual([leaver.routineId]);
    expect(document.routineRuns).toHaveLength(1);
    expect(
      (document.skills as Array<{ id: string }>).map((row) => row.id),
    ).toEqual([leaver.skillId]);
    expect(document.standingApprovals).toHaveLength(1);
    expect(
      (document.auditEvents as Array<{ actorUserId: string }>).every(
        (row) => row.actorUserId === leaver.id,
      ),
    ).toBe(true);
    expect(document.truncated).toEqual([]);

    // The serialised whole, checked for the two things that must never be in it.
    const serialised = JSON.stringify(document);
    expect(serialised).not.toContain(stayer.id);
    expect(serialised).not.toContain("credentialKeyId");
    expect(serialised).not.toContain("not-a-real-secret");
  });
});

describe("deletion", () => {
  test("removes the person and leaves the other account alone", async () => {
    const retired: Array<{ userId: string; by: string }> = [];
    const wiped: string[] = [];
    const deletion = createAccountDeletion({
      database,
      retireConnectionsFor: async (userId, by) => {
        retired.push({ userId, by });
        return { retired: 1 };
      },
      // The shape of the client this path uses: `forBot(id)` sets `x-openbot-bot-id`, which is the
      // difference between wiping this Bot's profile and wiping the default one.
      computerClient: {
        forBot: (id: string) => ({
          resetComputer: async () => {
            wiped.push(id);
            return { reset: true, botId: id };
          },
        }),
      } as never,
    });

    const result = await deletion.delete({
      userId: leaver.id,
      by: leaver.id,
    });

    expect(result.deleted).toBe(true);
    expect(result.pseudonym).toBe(pseudonymFor(leaver.id));
    // The browser profile went first, addressed per Bot.
    expect(wiped).toEqual([leaver.botId]);
    expect(result.computers).toEqual({
      reset: [leaver.botId],
      failed: [],
      configured: true,
    });
    // And the vault was retired through the store that owns it, under the pseudonym.
    expect(retired).toEqual([
      { userId: leaver.id, by: pseudonymFor(leaver.id) },
    ]);

    expect(result.counts).toMatchObject({
      threadMessages: 2,
      threads: 1,
      channelMemberships: 1,
      channels: 1,
      routineRuns: 1,
      routines: 1,
      runs: 1,
      skills: 1,
      standingApprovals: 1,
      memories: 1,
      botPreferences: 1,
      bots: 1,
      vaultTokens: 1,
      user: 1,
    });

    const gone = async (name: string, rows: Promise<unknown[]>) =>
      expect([name, await rows]).toEqual([name, []]);

    await gone(
      "users",
      database.select().from(users).where(eq(users.id, leaver.id)),
    );
    await gone(
      "agents",
      database.select().from(agents).where(eq(agents.id, leaver.botId)),
    );
    await gone(
      "messages",
      database
        .select()
        .from(lafThreadMessages)
        .where(eq(lafThreadMessages.threadId, leaver.threadId)),
    );
    await gone(
      "channels",
      database.select().from(channels).where(eq(channels.id, leaver.channelId)),
    );
    await gone(
      "routines",
      database
        .select()
        .from(lafRoutines)
        .where(eq(lafRoutines.id, leaver.routineId)),
    );
    await gone(
      "routineRuns",
      database
        .select()
        .from(lafRoutineRuns)
        .where(eq(lafRoutineRuns.routineId, leaver.routineId)),
    );
    await gone(
      "runs",
      database
        .select()
        .from(lafThreadRuns)
        .where(eq(lafThreadRuns.runId, leaver.runId)),
    );
    await gone(
      "skills",
      database.select().from(skills).where(eq(skills.id, leaver.skillId)),
    );
    await gone(
      "standingApprovals",
      database
        .select()
        .from(computerStandingApprovals)
        .where(eq(computerStandingApprovals.id, leaver.approvalId)),
    );
    await gone(
      "memories",
      database
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.ownerUserId, leaver.id)),
    );
    await gone(
      "vault",
      database
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.kind, "mcp_user_token"),
            eq(credentials.keyId, leaver.id),
          ),
        ),
    );

    // THE OTHER ACCOUNT, ROW FOR ROW. This is the assertion the second person exists for.
    expect(
      await database.select().from(users).where(eq(users.id, stayer.id)),
    ).toHaveLength(1);
    expect(
      await database.select().from(agents).where(eq(agents.id, stayer.botId)),
    ).toHaveLength(1);
    expect(
      await database
        .select()
        .from(lafThreadMessages)
        .where(eq(lafThreadMessages.threadId, stayer.threadId)),
    ).toHaveLength(2);
    expect(
      await database
        .select()
        .from(channels)
        .where(eq(channels.id, stayer.channelId)),
    ).toHaveLength(1);
    expect(
      await database
        .select()
        .from(lafRoutines)
        .where(eq(lafRoutines.id, stayer.routineId)),
    ).toHaveLength(1);
    expect(
      await database.select().from(skills).where(eq(skills.id, stayer.skillId)),
    ).toHaveLength(1);
    expect(
      await database
        .select()
        .from(computerStandingApprovals)
        .where(eq(computerStandingApprovals.id, stayer.approvalId)),
    ).toHaveLength(1);
  });

  test("the trail keeps what happened under a pseudonym, and names nobody", async () => {
    const pseudonym = pseudonymFor(leaver.id);

    // Nothing anywhere still says who they were.
    expect(
      await database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actorUserId, leaver.id)),
    ).toHaveLength(0);

    const kept = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, pseudonym));
    // The action they took before leaving, and the row that says they left.
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.map((row) => row.eventType)).toContain("account.deleted");
    expect(kept.map((row) => row.eventType)).toContain(
      "computer.action_allowed",
    );

    const deletionRow = kept.find((row) => row.eventType === "account.deleted");
    const payload = deletionRow?.payload as {
      by: string;
      counts: Record<string, number>;
      computers: { configured: boolean; reset: number; note: string };
    };
    expect(payload.by).toBe("themselves");
    expect(payload.counts.bots).toBe(1);
    // The count is a NUMBER, not "[REDACTED]": see why it is not called `credentials`.
    expect(payload.counts.vaultTokens).toBe(1);
    expect(payload.computers).toMatchObject({ configured: true, reset: 1 });
  });

  test("says so rather than throwing when the account is already gone", async () => {
    const deletion = createAccountDeletion({ database });
    const result = await deletion.delete({
      userId: leaver.id,
      by: stayer.id,
    });
    expect(result.deleted).toBe(false);
    expect(result.counts).toEqual({});
  });
});

describe("the append-only trail, after 0028", () => {
  test("still refuses an ordinary UPDATE and an ordinary DELETE", async () => {
    const said = async (attempt: () => Promise<unknown>) => {
      try {
        await attempt();
      } catch (error) {
        const reasons: string[] = [];
        for (
          let current: unknown = error;
          current instanceof Error;
          current = current.cause
        ) {
          reasons.push(current.message);
        }
        return reasons.join(" | ");
      }
      throw new Error("The statement succeeded. The trail is not append-only.");
    };

    expect(
      await said(() =>
        database.execute(
          sql`update audit_events set payload = '{}'::jsonb
              where actor_user_id = ${pseudonymFor(leaver.id)}`,
        ),
      ),
    ).toContain("Audit events are append-only");
    expect(
      await said(() =>
        database.execute(
          sql`delete from audit_events where actor_user_id = ${pseudonymFor(leaver.id)}`,
        ),
      ),
    ).toContain("Audit events are append-only");
  });

  test("refuses to rewrite a payload even from inside the exit", async () => {
    /*
     * THE NARROW EXIT, PROVED NARROW. `audit_pseudonymise_actor` opens the trigger's flag for the
     * width of one statement; if the flag were all that stood between a caller and the table, a
     * second statement in the same transaction could rewrite anything. It cannot: the flag is
     * cleared before the function returns, AND the trigger refuses any UPDATE that moves a column
     * other than the actor.
     */
    const said = await database
      .execute(
        sql`select set_config('laf.audit_maintenance', 'on', true),
                   (select count(*) from audit_events) as seen`,
      )
      .then(() =>
        database.execute(
          sql`update audit_events set payload = '{"tampered":true}'::jsonb
              where actor_user_id = ${pseudonymFor(leaver.id)}`,
        ),
      )
      .then(() => "the statement succeeded")
      .catch((error: unknown) =>
        error instanceof Error ? `${error.message} | ${error.cause}` : "",
      );
    expect(said).toContain("Audit events are append-only");
  });
});

describe("retention", () => {
  test("removes what has aged out, through the one exit, and logs a line", async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1_000);
    const oldRunId = `acct-${suite}-old-run`;
    await database.insert(auditEvents).values({
      eventType: "configuration.changed",
      targetType: "test",
      targetId: `${suite}-old`,
      payload: { note: "older than the retention period" },
      createdAt: old,
    });
    await database.insert(lafThreadRuns).values({
      runId: oldRunId,
      status: "done",
      origin: "chat",
      startedAt: old,
    });

    const lines: string[] = [];
    const job = createRetentionJob({
      database,
      days: 365,
      log: (message) => lines.push(message),
    });
    const outcome = await job.runOnce();

    expect(outcome).not.toBeNull();
    expect(outcome?.auditEvents).toBeGreaterThanOrEqual(1);
    expect(outcome?.threadRuns).toBeGreaterThanOrEqual(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("retention: kept 365 days");

    expect(
      await database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.targetId, `${suite}-old`)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(lafThreadRuns)
        .where(eq(lafThreadRuns.runId, oldRunId)),
    ).toHaveLength(0);
    // And the rows written this minute are untouched.
    expect(
      await database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actorUserId, stayer.id)),
    ).toHaveLength(1);
  });

  test("zero days is off: no sweep, no line", async () => {
    const lines: string[] = [];
    const job = createRetentionJob({
      database,
      days: 0,
      log: (message) => lines.push(message),
    });
    expect(await job.runOnce()).toBeNull();
    expect(lines).toEqual([]);
  });
});
