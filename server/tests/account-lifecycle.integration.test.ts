import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { createAccountDeletion } from "../src/account/deletion";
import { createAccountExport, EXPORT_LIMITS } from "../src/account/export";
import { pseudonymFor } from "../src/account/pseudonym";
import { createRetentionJob } from "../src/account/retention";
import { cascadeAnchors, TABLE_LIFECYCLE } from "../src/account/tables";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { type AuditEventInput, createAuditStore } from "../src/audit";
import { createDeploymentAdmission } from "../src/auth/admission";
import { createSignInAllowlist } from "../src/auth/allowlist";
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
  channelMemberships,
  channels,
  channelThreads,
  computerStandingApprovals,
  credentials,
  lafAlimtalkTemplates,
  lafAnswerRatings,
  lafAttachments,
  lafFeedback,
  lafFeedPosts,
  lafGoalEntries,
  lafGoals,
  lafNotifications,
  lafPartnerConnections,
  lafRoutineNotepads,
  lafRoutineRuns,
  lafRoutineSuggestionDismissals,
  lafRoutines,
  lafSavedLogins,
  lafSiteConnections,
  lafThreadMessages,
  lafThreadRuns,
  mcpServers,
  mcpUserCredentials,
  skills,
  userRoles,
  users,
} from "../src/db/schema";
import { appendMessages } from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * A person takes their data and leaves, WITH ANOTHER ACCOUNT STILL IN THE DATABASE.
 *
 * A deployment belongs to one account (docs/laf/deployment-model.md, 2026-09-16), but it can still
 * hold a second row: a leftover from before the rule, whose address the sign-in list no longer
 * admits. That second row is the whole point of this file. Every statement in `account/deletion.ts`
 * is narrowed by one person's id or by the ids of their Bots, and the way that goes wrong is not a
 * refusal — it is a delete that quietly takes one row too many. A test with one account cannot see
 * that; a test with two sees it as the second account's rows disappearing.
 *
 * And the browser, which is the deployment's and not the account's. Its logins are the admitted
 * person's, so removing a leftover lets go of the leftover's Bots and keeps those logins; the
 * profile is emptied only when the admitted person leaves, or when nobody the list admits is left.
 * Until 2026-09-16 this file asserted the reset with the other account still here — the one call
 * that signed the person who stayed out of their bank.
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
  /** The vault row behind their connected service: never in the file, by id or by value. */
  vaultId: string;
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

  await database.insert(users).values({
    id,
    email,
    name: label,
    // The first run's answers, different per person, so a leak from one to the other shows.
    businessKind: label === "stayer" ? "office" : "food",
    dailyPlaces: label === "stayer" ? ["notion"] : ["baemin-ceo"],
  });
  await database.insert(userRoles).values({ userId: id, role: "user" });
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
    roleDescription: "Keeps the books.",
    avatarSeed: "seed",
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
  // Read up to a minute of its own, so the membership's row is told from the channel's.
  await database.insert(channelMemberships).values({
    channelId,
    userId: id,
    lastReadAt: new Date("2026-10-01T01:02:03.000Z"),
  });
  await database.insert(channelAgents).values({ channelId, agentId: botId });
  await database
    .insert(channelThreads)
    .values({ userId: id, channelId, threadId });
  await appendMessages(database, threadId, [
    { id: `${id}-m1`, role: "user", content: `${label} asked something.` },
    {
      id: `${id}-m2`,
      role: "assistant",
      content: "The Bot answered.",
      // The model's reasoning, carried as AG-UI files it (agent-bot/src/reasoning.ts): cleartext.
      encryptedValue: JSON.stringify([
        { type: "reasoning.text", text: `${id} reasoning` },
      ]),
    },
  ]);
  // The last picture of a browsing task, a column on that row (channels/frames.ts): cleartext too.
  await database
    .update(lafThreadMessages)
    .set({ frame: `/9j/${id}frame` })
    .where(
      and(
        eq(lafThreadMessages.threadId, threadId),
        sql`${lafThreadMessages.message} ->> 'id' = ${`${id}-m2`}`,
      ),
    );
  // What they thought of that answer: theirs to take, and theirs to take away when they go.
  await database.insert(lafAnswerRatings).values({
    id: `${id}-rating`,
    userId: id,
    channelId,
    messageId: `${id}-m2`,
    agentId: botId,
    rating: "down",
    reason: "wrong-facts",
    note: `${label} thinks the total is off.`,
  });
  // A receipt they handed the Bot: the photo's bytes in a row of its own (`attachments/`).
  await database.insert(lafAttachments).values({
    id: `${id}-receipt`,
    userId: id,
    channelId,
    agentId: botId,
    name: "영수증.jpg",
    mimeType: "image/jpeg",
    bytes: 4,
    data: Buffer.from(`${label}`),
    modelText: "[첨부 사진: 영수증.jpg · 4B]",
    workspacePath: null,
  });
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
  await database.insert(lafRoutineNotepads).values({
    routineId,
    entries: [
      {
        key: "orders",
        kind: "watermark",
        lastId: `${label}-order-17`,
        at: new Date().toISOString(),
      },
    ],
    version: 1,
    writtenByRun: `${routineId}-run`,
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
  // A login they saved for their Bot's browser (2026-10-10). Sealed, so what the row holds here
  // does not matter; whose it is does.
  await database.insert(lafSavedLogins).values({
    id: `${id}-login`,
    userId: id,
    label: `${label}의 네이버`,
    origins: ["https://nid.naver.com"],
    wrappedKey: "lv1.AAAA.AAAA",
    kekId: "0000000000000000",
    sealedUsername: "lv1.AAAA.AAAA",
    sealedPassword: "lv1.AAAA.AAAA",
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
  const [vault] = await database
    .insert(credentials)
    .values({
      kind: "mcp_user_token",
      provider: `${id}-vendor`,
      encryptedValue: "not-a-real-secret",
      keyId: id,
      metadata: {},
    })
    .returning({ id: credentials.id });
  if (!vault) throw new Error("the vault row was not made");
  // The service that token is for, and the row that says this person connected it: what the
  // export carries as `connectedAccounts` — the service, the scope, the dates — and not the
  // pointer into the vault.
  await database.insert(mcpServers).values({
    id: `${id}-server`,
    title: `${label}'s calendar`,
    vendor: "google",
    url: "https://mcp.example.test/calendar",
  });
  await database.insert(mcpUserCredentials).values({
    serverId: `${id}-server`,
    userId: id,
    credentialId: vault.id,
    scope: `${label}.calendar.read`,
    lastOkAt: new Date(),
  });
  // A goal, its first check-in, and a 소식 the Bot posted: three tables the file carries that
  // nothing here seeded until the catalogue was held to a row per table.
  await database.insert(lafGoals).values({
    id: `${id}-goal`,
    userId: id,
    agentId: botId,
    category: "sales",
    title: `${label} sells a hundred coffees`,
    target: "100 cups a day",
  });
  await database.insert(lafGoalEntries).values({
    id: `${id}-goal-entry`,
    goalId: `${id}-goal`,
    text: `${label} sold forty so far.`,
  });
  await database.insert(lafFeedPosts).values({
    id: `${id}-post`,
    userId: id,
    agentId: botId,
    topic: "orders",
    title: `${label}'s morning post`,
    body: "Three orders came in overnight.",
  });
  await auditStore.insert({
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: botId,
    actorUserId: id,
    payload: { note: `account-lifecycle ${suite}` },
  });

  /*
   * THE EIGHT TABLES THE REVIEW OF 2026-10-11 FOUND WITH NO DECISION: each names the person, each
   * went by cascade, none was in the file. Seeded for both people so the file is checked for one
   * and not the other, and the deletion for the cascade actually firing.
   */
  await database.insert(agentGuidance).values({
    id: `${id}-guidance`,
    agentId: botId,
    ownerUserId: id,
    content: `${label} likes short answers.`,
    day: "2026-10-10",
  });
  await database.insert(agentMemoryReceipts).values({
    id: `${id}-receipt-row`,
    agentId: botId,
    ownerUserId: id,
    job: "dream",
    checked: 3,
    confirmed: 1,
  });
  await database.insert(lafSiteConnections).values({
    userId: id,
    siteId: `${label}-store`,
    botId,
  });
  await database.insert(lafFeedback).values({
    id: `${id}-feedback`,
    userId: id,
    text: `${label} wrote to the operator.`,
    route: "/settings/account",
  });
  await database.insert(lafRoutineSuggestionDismissals).values({
    userId: id,
    suggestionKey: `${label}-suggestion`,
  });
  await database.insert(lafNotifications).values({
    id: `${id}-notification`,
    kind: "approval.waiting",
    botId,
    userId: id,
    channelId,
    subject: { kind: "browser", intent: "read", host: `${label}.example.test` },
  });
  await database.insert(lafPartnerConnections).values({
    provider: "kakao-alimtalk",
    userId: id,
    // The vendor's handle: decides whose channel a message leaves from, so never in the file.
    account: `${id}-senderkey`,
    details: { searchId: `@${label}shop` },
  });
  await database.insert(lafAlimtalkTemplates).values({
    userId: id,
    code: "laf_approval",
    templateId: `${id}-template`,
    status: "approved",
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
    vaultId: vault.id,
  };
}

let leaver: Person;
let stayer: Person;
/** A third person, removed by somebody else. Made inside the test that removes them. */
let struck: Person | undefined;
/** Made inside the tests that empty the browser. */
const alsoMade: Person[] = [];

/**
 * The deployment as its sign-in list reads it: the people named here are the ones it admits, and
 * every other row in this file is a leftover the list no longer admits.
 */
const admittedOnly = (...people: Array<Pick<Person, "email">>) =>
  createDeploymentAdmission({
    database,
    allowlist: createSignInAllowlist({
      allowedEmails: people.map((one) => one.email),
      initialAdminEmails: [],
    }),
  });

/**
 * The computer as this path addresses it: `forBot(id)` sets `x-openbot-bot-id`, and each Bot can be
 * let go of (tabs and wheel) or the whole profile emptied. What was asked is remembered, per verb.
 */
function computerThatRecords() {
  const wiped: string[] = [];
  /** Whose resets also asked for the Bot's folder to be emptied (attached files' copies). */
  const emptied: string[] = [];
  const stopped: string[] = [];
  const client = {
    forBot: (id: string) => ({
      resetComputer: async (options: { emptyFolder?: boolean } = {}) => {
        wiped.push(id);
        if (options.emptyFolder) emptied.push(id);
        return { reset: true, botId: id, scope: "deployment" as const };
      },
      stopComputer: async () => {
        stopped.push(id);
        return { stopped: true, wasRunning: true };
      },
    }),
  };
  return { client: client as never, wiped, emptied, stopped };
}

/**
 * What the real `retireConnectionsFor` does to the rows this file seeds: the `mcp_user_credentials`
 * rows go before the vault rows they point at, which `deletion.ts` removes by name next and which
 * the join table references without a cascade (`db/schema/plugins.ts`). A stub that skipped it
 * would fail the deletion on that key, not on anything under test.
 */
async function retireJoinRowsOf(userId: string): Promise<void> {
  await database
    .delete(mcpUserCredentials)
    .where(eq(mcpUserCredentials.userId, userId));
}

/** An audit store that keeps what it was handed, for the rows written beside the transaction. */
function trailThatRecords() {
  const rows: AuditEventInput[] = [];
  return {
    rows,
    store: {
      insert: async (event: AuditEventInput) => {
        rows.push(event);
      },
    },
  };
}

beforeAll(async () => {
  leaver = await makePerson("leaver");
  stayer = await makePerson("stayer");
});

/** Everything the stayer made. The leaver's rows are removed by the code under test. */
afterAll(async () => {
  for (const person of [stayer, leaver, struck, ...alsoMade].filter(
    (person): person is Person => Boolean(person),
  )) {
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, person.threadId));
    await database
      .delete(lafThreadRuns)
      .where(eq(lafThreadRuns.runId, person.runId));
    await database.delete(skills).where(eq(skills.id, person.skillId));
    await database
      .delete(mcpServers)
      .where(eq(mcpServers.id, `${person.id}-server`));
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
    // What they agreed to is theirs to take too. Present as keys even when null: a person who
    // joined before the text existed should see that nothing was recorded, not nothing at all.
    expect(document.profile as Record<string, unknown>).toMatchObject({
      consentedAt: null,
      consentVersion: null,
    });
    // What they told the product about their business is theirs to take, and only theirs.
    expect((document.profile as Record<string, unknown>).shop).toEqual({
      kind: "food",
      places: ["baemin-ceo"],
    });
    expect(
      (document.bots as Array<{ id: string }>).map((bot) => bot.id),
    ).toEqual([leaver.botId]);
    // The profile is a name and a face since 2026-09-24; the job title and the preset a Bot was
    // made from are columns no more (migration 0047), so neither is a key of what leaves either.
    const [bot] = document.bots as Array<Record<string, unknown>>;
    expect(bot).not.toHaveProperty("title");
    expect(bot).not.toHaveProperty("presetId");
    expect(
      (document.memories as Array<{ content: string }>)[0]?.content,
    ).toContain("closes on Sundays");
    expect(
      (document.conversations as Array<{ messages: unknown[] }>)[0]?.messages,
    ).toHaveLength(2);
    // How they rated the answers they got — their own ratings, reason and note included.
    // The files they attached go as what they were, never as their bytes.
    expect(document.attachments).toEqual([
      expect.objectContaining({
        id: `${leaver.id}-receipt`,
        name: "영수증.jpg",
        mimeType: "image/jpeg",
        bytes: 4,
      }),
    ]);
    expect(JSON.stringify(document.attachments)).not.toContain(
      Buffer.from("leaver").toString("base64"),
    );
    expect(document.answerRatings).toEqual([
      {
        id: `${leaver.id}-rating`,
        channelId: leaver.channelId,
        messageId: `${leaver.id}-m2`,
        agentId: leaver.botId,
        rating: "down",
        reason: "wrong-facts",
        note: "leaver thinks the total is off.",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(
      (document.routines as Array<{ id: string }>).map((row) => row.id),
    ).toEqual([leaver.routineId]);
    expect(document.routineRuns).toHaveLength(1);
    // Where their routine left off is their routine's work too.
    expect(
      (document.routineNotepads as Array<{ routineId: string }>).map(
        (row) => row.routineId,
      ),
    ).toEqual([leaver.routineId]);
    expect(
      (document.skills as Array<{ id: string }>).map((row) => row.id),
    ).toEqual([leaver.skillId]);
    // The logins they saved: WHICH, and nobody else's — and not a value, sealed or otherwise.
    expect(
      (document.savedLogins as Array<{ id: string }>).map((row) => row.id),
    ).toEqual([`${leaver.id}-login`]);
    expect(JSON.stringify(document.savedLogins)).not.toContain("lv1.");
    expect(document.standingApprovals).toHaveLength(1);
    expect(
      (document.auditEvents as Array<{ actorUserId: string }>).every(
        (row) => row.actorUserId === leaver.id,
      ),
    ).toBe(true);
    expect(document.truncated).toEqual([]);

    // A conversation says what it is: the main one or a project (migration 0064).
    expect(document.channels).toEqual([
      expect.objectContaining({ id: leaver.channelId, kind: "main" }),
    ]);

    // The eight sections that were missing until 2026-10-11, each this person's rows only.
    expect(document.memoryReceipts).toEqual([
      expect.objectContaining({ id: `${leaver.id}-receipt-row`, job: "dream" }),
    ]);
    expect(document.siteConnections).toEqual([
      expect.objectContaining({ siteId: "leaver-store", needsLogin: false }),
    ]);
    expect(document.feedback).toEqual([
      expect.objectContaining({
        id: `${leaver.id}-feedback`,
        text: "leaver wrote to the operator.",
      }),
    ]);
    expect(document.suggestionDismissals).toEqual([
      expect.objectContaining({ suggestionKey: "leaver-suggestion" }),
    ]);
    expect(document.notifications).toEqual([
      expect.objectContaining({
        id: `${leaver.id}-notification`,
        kind: "approval.waiting",
      }),
    ]);
    // The service they connected: which, with what scope and when — and not the vault pointer.
    expect(document.connectedAccounts).toEqual([
      {
        serverId: `${leaver.id}-server`,
        scope: "leaver.calendar.read",
        connectedAt: expect.any(String),
        lastOkAt: expect.any(String),
        lastFailureAt: null,
        lastFailureCode: null,
      },
    ]);
    expect(document.partnerConnections).toEqual([
      {
        provider: "kakao-alimtalk",
        details: { searchId: "@leavershop" },
        status: "linked",
        connectedAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(document.alimtalkTemplates).toEqual([
      expect.objectContaining({ code: "laf_approval", status: "approved" }),
    ]);

    // The serialised whole, checked for the things that must never be in it.
    const serialised = JSON.stringify(document);
    expect(serialised).not.toContain(stayer.id);
    expect(serialised).not.toContain('"notion"');
    expect(serialised).not.toContain("credentialKeyId");
    expect(serialised).not.toContain("not-a-real-secret");
    // The vault row behind the connected service: neither its key nor its id is in the file.
    expect(serialised).not.toContain("credentialId");
    expect(serialised).not.toContain(leaver.vaultId);
    // The vendor's senderKey: not the person's to carry around, and not a key of any section.
    expect(serialised).not.toContain("senderkey");
    expect(serialised).not.toContain('"account":');
  });

  /*
   * EVERY TABLE THE CATALOGUE EXPORTS LEAVES A ROW OF ITS OWN IN THE SECTION IT NAMES. Holding
   * only that the section's key exists let a table mapped to a section that already existed pass
   * with `export.ts` never reading it (review, 2026-10-11). So each exported table has a sentinel
   * here — a value `makePerson` seeded in that table and nowhere else — and the test looks for it
   * in the section the catalogue names. A table catalogued as exported with no sentinel named is
   * the first assertion's failure: whoever adds the row to the catalogue seeds its evidence too.
   */
  const evidenceOf = (person: Person): Record<string, string> => ({
    users: person.email,
    user_roles: '"roles":["user"]',
    agents: "leaver's Bot",
    agent_profiles: "Keeps the books.",
    agent_preferences: person.botId,
    agent_memories: "leaver closes on Sundays.",
    agent_guidance: "leaver likes short answers.",
    agent_memory_receipts: `${person.id}-receipt-row`,
    channels: "leaver and the Bot",
    channel_memberships: "2026-10-01T01:02:03.000Z",
    channel_agents: person.botId,
    channel_threads: person.threadId,
    laf_thread_messages: "leaver asked something.",
    laf_thread_runs: person.runId,
    laf_attachments: "영수증.jpg",
    laf_answer_ratings: "leaver thinks the total is off.",
    laf_routines: "Morning check",
    laf_routine_runs: "Nothing new.",
    laf_routine_notepads: "leaver-order-17",
    laf_routine_suggestion_dismissals: "leaver-suggestion",
    laf_feed_posts: "leaver's morning post",
    laf_goals: "leaver sells a hundred coffees",
    laf_goal_entries: "leaver sold forty so far.",
    laf_notifications: `${person.id}-notification`,
    laf_site_connections: "leaver-store",
    laf_feedback: "leaver wrote to the operator.",
    laf_saved_logins: "leaver의 네이버",
    mcp_user_credentials: "leaver.calendar.read",
    laf_partner_connections: "@leavershop",
    laf_alimtalk_templates: `${person.id}-template`,
    skills: `${person.id}-standup`,
    computer_standing_approvals: person.approvalId,
    audit_events: "computer.action_allowed",
  });

  test("every table the catalogue exports leaves a row of its own in the section it names", async () => {
    const document = await readExport(leaver.id);
    const evidence = evidenceOf(leaver);
    const exported = Object.entries(TABLE_LIFECYCLE)
      .filter(([, lifecycle]) => lifecycle.exported !== null)
      .map(([table]) => table)
      .sort();
    expect(Object.keys(evidence).sort()).toEqual(exported);
    const missing = exported.filter((table) => {
      const section = TABLE_LIFECYCLE[table]?.exported as string;
      return !JSON.stringify(document[section] ?? null).includes(
        evidence[table] as string,
      );
    });
    expect(missing).toEqual([]);
  });

  /*
   * What they wrote to the operator is capped like the runs are: each row can carry a diagnostics
   * bundle, nothing ages them out, and the export is read whole into one string before it is
   * written — so a history long enough would take the API process with it. The cap is announced.
   */
  test("feedback past the cap is left out, and the file says so", async () => {
    const extra = Array.from({ length: EXPORT_LIMITS.feedback }, (_, at) => ({
      id: `${stayer.id}-feedback-${at}`,
      userId: stayer.id,
      text: `stayer wrote again, ${at}.`,
      route: "/settings/account",
    }));
    for (let at = 0; at < extra.length; at += 1000) {
      await database.insert(lafFeedback).values(extra.slice(at, at + 1000));
    }
    try {
      const document = await readExport(stayer.id);
      expect(document.feedback).toHaveLength(EXPORT_LIMITS.feedback);
      expect(document.truncated).toEqual(["feedback"]);
    } finally {
      await database
        .delete(lafFeedback)
        .where(
          and(
            eq(lafFeedback.userId, stayer.id),
            like(lafFeedback.id, `${stayer.id}-feedback-%`),
          ),
        );
    }
  });

  test("a weekday routine's days leave as a list, not as the driver's typed array", async () => {
    /*
     * The export reads routines with a parameterised WHERE, and Bun's driver hands an `integer[]`
     * back as an `Int32Array` whenever a query carries parameters — which JSON writes as
     * `{"0":1,"1":3,"2":5}`. Somebody taking their data away got their 월·수·금 routine's days as
     * an object keyed by position: the fault the routine list had, fixed there on 2026-09-18
     * (`publishedRoutine` in routines/store.ts) and measured here the same day.
     */
    await database
      .update(lafRoutines)
      .set({ dailyDays: [1, 3, 5] })
      .where(eq(lafRoutines.id, leaver.routineId));

    const text = await new Response(
      createAccountExport(database).stream(leaver.id),
    ).text();

    expect(text).toContain('"dailyDays":[1,3,5]');
    const document = JSON.parse(text) as {
      routines: Array<{ dailyDays: unknown }>;
    };
    expect(document.routines[0]?.dailyDays).toEqual([1, 3, 5]);
  });

  test("a routine leaves with where it posts and the goal it checks", async () => {
    // Migrations 0059 and 0060 added both, and the export's column list was not told (2026-09-27).
    await database
      .update(lafRoutines)
      .set({ delivery: "feed" })
      .where(eq(lafRoutines.id, leaver.routineId));
    const document = JSON.parse(
      await new Response(
        createAccountExport(database).stream(leaver.id),
      ).text(),
    ) as { routines: Array<{ delivery?: unknown; goalId?: unknown }> };
    expect(document.routines[0]?.delivery).toBe("feed");
    expect(document.routines[0]).toHaveProperty("goalId");
    await database
      .update(lafRoutines)
      .set({ delivery: "chat" })
      .where(eq(lafRoutines.id, leaver.routineId));
  });
});

/**
 * THE LIST THAT KEEPS THE NEXT TABLE FROM BEING FORGOTTEN (`account/tables.ts`), held against the
 * database's own catalogue — the way `NAMES_A_CONVERSATION` is in `conversation-deleting`. Eight
 * tables had arrived since the export was written with no decision anywhere; this is what makes
 * the ninth fail here rather than wait for a review.
 */
describe("every table in the database has a decision", () => {
  test("the catalogue names every table, and no table that is not there", async () => {
    const rows = (await database.execute(sql`
      select c.relname as name
      from pg_catalog.pg_class c
      where c.relnamespace = current_schema()::regnamespace
        and c.relkind in ('r', 'p')
    `)) as unknown as Array<{ name: string }>;
    expect(rows.map((row) => row.name).sort()).toEqual(
      Object.keys(TABLE_LIFECYCLE).sort(),
    );
  });

  test("a table left to the cascade actually cascades, from the person or from what is deleted by name", async () => {
    // Every ON DELETE CASCADE key in the schema: which table hangs off which.
    const keys = (await database.execute(sql`
      select t.relname as child, r.relname as parent
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class t on t.oid = k.conrelid
      join pg_catalog.pg_class r on r.oid = k.confrelid
      where k.contype = 'f'
        and k.confdeltype = 'c'
        and t.relnamespace = current_schema()::regnamespace
    `)) as unknown as Array<{ child: string; parent: string }>;

    const reached = cascadeAnchors();
    const waiting = new Set(
      Object.entries(TABLE_LIFECYCLE)
        .filter(([, lifecycle]) => lifecycle.deletion === "cascade")
        .map(([table]) => table),
    );
    // A cascade table is reached once one of its cascading parents is; repeat until nothing moves,
    // so `laf_goal_entries` is reached through `laf_goals` whichever order the rows came in.
    let moved = true;
    while (moved) {
      moved = false;
      for (const table of waiting) {
        if (
          keys.some((key) => key.child === table && reached.has(key.parent))
        ) {
          reached.add(table);
          waiting.delete(table);
          moved = true;
        }
      }
    }
    expect([...waiting]).toEqual([]);
  });
});

describe("deletion", () => {
  test("removes the person and leaves the other account alone — its rows and its browser's logins", async () => {
    const retired: Array<{ userId: string; by: string }> = [];
    const computer = computerThatRecords();
    const trail = trailThatRecords();
    const deletion = createAccountDeletion({
      database,
      retireConnectionsFor: async (userId, by) => {
        await retireJoinRowsOf(userId);
        retired.push({ userId, by });
        return { retired: 1 };
      },
      computerClient: computer.client,
      auditStore: trail.store,
      admission: admittedOnly(stayer),
    });

    // Present before, so the absence asserted below is the deletion's doing.
    const [seeded] = await database
      .select({ frame: lafThreadMessages.frame })
      .from(lafThreadMessages)
      .where(
        sql`${lafThreadMessages.frame} = ${`/9j/${leaver.id}frame`} and ${lafThreadMessages.message}::text like ${`%${leaver.id} reasoning%`}`,
      );
    expect(seeded?.frame).toBe(`/9j/${leaver.id}frame`);

    // The deployment's person removes the leftover (`POST /api/admin/users/:id/delete`).
    const result = await deletion.delete({
      userId: leaver.id,
      by: stayer.id,
    });

    expect(result.deleted).toBe(true);
    expect(result.pseudonym).toBe(pseudonymFor(leaver.id));
    /*
     * THE PROFILE STAYS. It holds the logins of the person who is still here, and resetting it would
     * sign them out of every site without asking. The leftover's Bot is let go of instead — its tabs
     * and its wheel — and the trail says so, logins kept, in a row of its own.
     */
    expect(computer.wiped).toEqual([]);
    expect(computer.stopped).toEqual([leaver.botId]);
    expect(result.computers).toEqual({
      reset: [],
      failed: [],
      released: [leaver.botId],
      configured: true,
    });
    const released = trail.rows.filter(
      (row) => row.eventType === "computer.released",
    );
    expect(released.map((row) => row.targetId)).toEqual([leaver.botId]);
    expect(released[0]?.payload.loginsKept).toBe(true);
    expect(released[0]?.actorUserId).toBe(stayer.id);
    // And the vault was retired through the store that owns it, under the pseudonym.
    expect(retired).toEqual([
      { userId: leaver.id, by: pseudonymFor(leaver.id) },
    ]);

    expect(result.counts).toMatchObject({
      threadMessages: 2,
      answerRatings: 1,
      attachments: 1,
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
      // The login they saved, removed by name and counted — not left to the foreign key.
      savedLogins: 1,
      user: 1,
    });

    const gone = async (name: string, rows: Promise<unknown[]>) =>
      expect([name, await rows]).toEqual([name, []]);

    // The shop answers are columns on this row, so they went with it — and the stayer's did not.
    await gone(
      "users",
      database.select().from(users).where(eq(users.id, leaver.id)),
    );
    const [kept] = await database
      .select({ kind: users.businessKind, places: users.dailyPlaces })
      .from(users)
      .where(eq(users.id, stayer.id));
    expect(kept).toEqual({ kind: "office", places: ["notion"] });
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
    /*
     * The two things stored in cleartext on a message — a browsing task's last picture and the
     * model's reasoning — go with it, looked for across the whole table rather than by thread, so a
     * copy filed anywhere else would show here (security review 2026-09-25 F3).
     */
    await gone(
      "frames and reasoning",
      database
        .select({ seq: lafThreadMessages.seq })
        .from(lafThreadMessages)
        .where(
          sql`${lafThreadMessages.frame} = ${`/9j/${leaver.id}frame`} or ${lafThreadMessages.message}::text like ${`%${leaver.id} reasoning%`}`,
        ),
    );
    await gone(
      "channels",
      database.select().from(channels).where(eq(channels.id, leaver.channelId)),
    );
    await gone(
      "attachments",
      database
        .select({ id: lafAttachments.id })
        .from(lafAttachments)
        .where(eq(lafAttachments.userId, leaver.id)),
    );
    await gone(
      "answerRatings",
      database
        .select()
        .from(lafAnswerRatings)
        .where(eq(lafAnswerRatings.userId, leaver.id)),
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
      "routineNotepads",
      database
        .select()
        .from(lafRoutineNotepads)
        .where(eq(lafRoutineNotepads.routineId, leaver.routineId)),
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

    // The leaver's saved login is gone with them: a password does not outlive its person.
    expect(
      await database
        .select()
        .from(lafSavedLogins)
        .where(eq(lafSavedLogins.userId, leaver.id)),
    ).toEqual([]);

    // Every count the catalogue promises the trail is in the tally, by that name.
    for (const lifecycle of Object.values(TABLE_LIFECYCLE)) {
      if (lifecycle.counted)
        expect(result.counts).toHaveProperty(lifecycle.counted);
    }

    // THE EIGHT TABLES LEFT TO THE CASCADE, SEEN TO HAVE GONE: a schema file's `onDelete` is a
    // claim about a migration, and this is where the claim is checked against rows.
    await gone(
      "guidance",
      database
        .select()
        .from(agentGuidance)
        .where(eq(agentGuidance.ownerUserId, leaver.id)),
    );
    await gone(
      "memoryReceipts",
      database
        .select()
        .from(agentMemoryReceipts)
        .where(eq(agentMemoryReceipts.ownerUserId, leaver.id)),
    );
    await gone(
      "siteConnections",
      database
        .select()
        .from(lafSiteConnections)
        .where(eq(lafSiteConnections.userId, leaver.id)),
    );
    await gone(
      "feedback",
      database
        .select()
        .from(lafFeedback)
        .where(eq(lafFeedback.userId, leaver.id)),
    );
    await gone(
      "suggestionDismissals",
      database
        .select()
        .from(lafRoutineSuggestionDismissals)
        .where(eq(lafRoutineSuggestionDismissals.userId, leaver.id)),
    );
    await gone(
      "notifications",
      database
        .select()
        .from(lafNotifications)
        .where(eq(lafNotifications.userId, leaver.id)),
    );
    await gone(
      "partnerConnections",
      database
        .select()
        .from(lafPartnerConnections)
        .where(eq(lafPartnerConnections.userId, leaver.id)),
    );
    await gone(
      "alimtalkTemplates",
      database
        .select()
        .from(lafAlimtalkTemplates)
        .where(eq(lafAlimtalkTemplates.userId, leaver.id)),
    );
    // And the stayer's copies of the same did not go with them.
    expect(
      await database
        .select({ id: lafFeedback.id })
        .from(lafFeedback)
        .where(eq(lafFeedback.userId, stayer.id)),
    ).toEqual([{ id: `${stayer.id}-feedback` }]);
    expect(
      await database
        .select({ siteId: lafSiteConnections.siteId })
        .from(lafSiteConnections)
        .where(eq(lafSiteConnections.userId, stayer.id)),
    ).toEqual([{ siteId: "stayer-store" }]);

    // THE OTHER ACCOUNT, ROW FOR ROW. This is the assertion the second person exists for.
    expect(
      await database.select().from(users).where(eq(users.id, stayer.id)),
    ).toHaveLength(1);
    expect(
      (
        await database
          .select({ id: lafSavedLogins.id })
          .from(lafSavedLogins)
          .where(eq(lafSavedLogins.userId, stayer.id))
      ).map((row) => row.id),
    ).toEqual([`${stayer.id}-login`]);
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
        .from(lafAnswerRatings)
        .where(eq(lafAnswerRatings.userId, stayer.id)),
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

  /**
   * An administrator removes somebody whose Bots they cannot see.
   *
   * Since 2026-09-16 a private Bot is its owner's alone, the administrator included — and this is
   * the path that must not have inherited that. Removing a person is not reading their roster: it
   * is the one operation that has to reach every Bot they own, let go of those Bots on the
   * deployment's browser, and take the rows with it. `account/deletion.ts` finds those Bots by
   * `ownerUserId` straight off the table, with no actor and no visibility clause, which is why it
   * still works — and the first assertion here is the one that would go red if a later change
   * "tidied" that read onto the profile store.
   */
  test("an administrator still removes the Bots of a person they cannot see", async () => {
    struck = await makePerson("struck");
    const administrator = { id: `acct-${suite}-admin`, role: "admin" as const };
    const profiles = createAgentProfileStore(
      database,
      new URL("https://managed.example.test/ag-ui"),
    );

    // The premise: this Bot is invisible to the administrator doing the removing.
    expect(await profiles.get(administrator, struck.botId)).toBeNull();
    expect(
      (await profiles.list(administrator)).map((profile) => profile.id),
    ).not.toContain(struck.botId);

    const computer = computerThatRecords();
    const deletion = createAccountDeletion({
      database,
      retireConnectionsFor: async (userId) => {
        await retireJoinRowsOf(userId);
        return { retired: 0 };
      },
      computerClient: computer.client,
      auditStore: trailThatRecords().store,
      admission: admittedOnly(stayer),
    });

    const result = await deletion.delete({
      userId: struck.id,
      by: administrator.id,
    });

    expect(result.deleted).toBe(true);
    // Their Bot, addressed by its id — let go of, since the account the logins belong to stays.
    expect(computer.stopped).toEqual([struck.botId]);
    expect(computer.wiped).toEqual([]);
    expect(result.computers).toMatchObject({
      reset: [],
      released: [struck.botId],
      failed: [],
    });
    // And the rows are gone: the Bot, its profile, and the routine that drove it.
    expect(
      await database.select().from(agents).where(eq(agents.id, struck.botId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, struck.botId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(lafRoutines)
        .where(eq(lafRoutines.id, struck.routineId)),
    ).toHaveLength(0);
    expect(
      await database.select().from(users).where(eq(users.id, struck.id)),
    ).toHaveLength(0);
  });

  test("the deployment's own person leaving empties the browser, leftover or not", async () => {
    // Their logins are the ones in it; the leftover beside them acts on nothing and keeps nothing.
    const owner = await makePerson("owner");
    alsoMade.push(owner);
    const computer = computerThatRecords();
    const deletion = createAccountDeletion({
      database,
      retireConnectionsFor: async (userId) => {
        await retireJoinRowsOf(userId);
        return { retired: 0 };
      },
      computerClient: computer.client,
      auditStore: trailThatRecords().store,
      // `stayer` is still in the database, and is not who this list admits.
      admission: admittedOnly(owner),
    });

    const result = await deletion.delete({ userId: owner.id, by: owner.id });

    expect(result.deleted).toBe(true);
    expect(computer.wiped).toEqual([owner.botId]);
    // And the folder with it: what their attached files became on the computer leaves with them.
    expect(computer.emptied).toEqual([owner.botId]);
    expect(computer.stopped).toEqual([]);
    expect(result.computers).toEqual({
      reset: [owner.botId],
      failed: [],
      released: [],
      configured: true,
    });
    // The other row is untouched by any of it.
    expect(
      await database.select().from(users).where(eq(users.id, stayer.id)),
    ).toHaveLength(1);
    const [left] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, pseudonymFor(owner.id)),
          eq(auditEvents.eventType, "account.deleted"),
        ),
      );
    expect((left?.payload as { by?: string } | undefined)?.by).toBe(
      "themselves",
    );
  });

  test("the last account the list admits leaving empties the browser too", async () => {
    /*
     * Nobody the deployment admits is left — its person already withdrew, or never signed up — so
     * the logins in the browser are nobody's to keep, and the next person the list admits must not
     * sign in to find a leftover's sessions waiting in their Bots' browser.
     */
    const last = await makePerson("last");
    alsoMade.push(last);
    const computer = computerThatRecords();
    const deletion = createAccountDeletion({
      database,
      retireConnectionsFor: async (userId) => {
        await retireJoinRowsOf(userId);
        return { retired: 0 };
      },
      computerClient: computer.client,
      auditStore: trailThatRecords().store,
      admission: admittedOnly({ email: `acct-${suite}-nobody@example.test` }),
    });

    const result = await deletion.delete({
      userId: last.id,
      by: `acct-${suite}-admin`,
    });

    expect(result.deleted).toBe(true);
    expect(computer.wiped).toEqual([last.botId]);
    expect(computer.stopped).toEqual([]);
    expect(result.computers).toMatchObject({
      reset: [last.botId],
      released: [],
    });
  });

  test("stops the person's live work before their rows go, and leaves anyway when it cannot", async () => {
    // Review M2: a turn went on writing into a conversation that was being deleted under it.
    const busy = await makePerson("busy");
    const stuck = await makePerson("stuck");
    alsoMade.push(busy, stuck);
    const stoppedWhileThere: Array<{ userId: string; rows: number }> = [];
    const stopping = createAccountDeletion({
      retireConnectionsFor: async (userId) => {
        await retireJoinRowsOf(userId);
        return { retired: 0 };
      },
      database,
      stopWorkFor: async (userId) => {
        const rows = await database
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId));
        stoppedWhileThere.push({ userId, rows: rows.length });
      },
    });
    expect(
      (await stopping.delete({ userId: busy.id, by: busy.id })).deleted,
    ).toBe(true);
    expect(stoppedWhileThere).toEqual([{ userId: busy.id, rows: 1 }]);

    // A stuck turn does not keep a person in a deployment they asked to leave.
    const failing = createAccountDeletion({
      retireConnectionsFor: async (userId) => {
        await retireJoinRowsOf(userId);
        return { retired: 0 };
      },
      database,
      stopWorkFor: async () => {
        throw new Error("the turn would not end");
      },
    });
    expect(
      (await failing.delete({ userId: stuck.id, by: stuck.id })).deleted,
    ).toBe(true);
    expect(
      await database.select().from(users).where(eq(users.id, stuck.id)),
    ).toHaveLength(0);
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
      computers: {
        configured: boolean;
        reset: number;
        released: number;
        note: string;
      };
    };
    // Removed by the deployment's person, who is named the way the trail names anybody in it.
    expect(payload.by).toBe(pseudonymFor(stayer.id));
    expect(payload.counts.bots).toBe(1);
    // The count is a NUMBER, not "[REDACTED]": see why it is not called `credentials`.
    expect(payload.counts.vaultTokens).toBe(1);
    expect(payload.computers).toMatchObject({
      configured: true,
      reset: 0,
      released: 1,
    });
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
