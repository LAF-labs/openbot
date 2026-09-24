import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  channels,
  credentials,
  lafAnswerRatings,
  lafRoutineRuns,
  lafRoutines,
  lafSiteConnections,
  lafThreadRuns,
  mcpServers,
  mcpUserCredentials,
  users,
} from "../src/db/schema";
import {
  insightStatements,
  readInsightSections,
  readInsights,
} from "../src/insights/read";
import type { InsightsReport } from "../src/insights/report";
import { TEST_POOL } from "./support/database";

/**
 * The insights statements against the real schema, seeded the way the product writes its rows.
 *
 * laf-control proves its own copy of these statements on hand-made tables
 * (`tests/insights-sql.integration.test.ts`); this proves the VM's, on the tables the migrations
 * actually build, with the same scenarios — nearest-rank inputs grouped without loss, a night that
 * starts at 22:00 Seoul time, a step budget met at fourteen entries, a host mapped to a site and
 * never returned, a free-text failure reduced to a code — and the two things this VM adds: the
 * first-task chips and the help page.
 *
 * AND THAT NOTHING PLANTED BESIDE A COUNTED ROW COMES BACK. Every seeded row carries content in the
 * columns next to what is counted — an email, a Bot's role, a routine's instruction, a failure's
 * prose, a customer's own domain — and the whole answer is serialised and searched for each.
 *
 * WHY THE SEEDS LIVE IN 1999. `audit_events` is append-only and this database is shared by every
 * suite, so no count over "the last seven days" can be asserted exactly against rows other files
 * wrote this minute. The window is bounded on both ends (`from ≤ t < to`), so a window that ends in
 * January 1999 holds these rows and nothing else. Nothing else in the suite writes before 2000, so
 * the era is this file's: it is cleared first — the trail through `audit_purge_before`, the one exit
 * the append-only trigger allows — so a second run, or a run after one that died halfway, counts
 * the same. Current state — live Bots, connections, per-person caps, accounts — has no window, and is
 * asserted as the difference between a reading before the seeds and one after.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const ZONE = "Asia/Seoul";
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** When "now" is for every reading here. */
const NOW = new Date(Date.UTC(1999, 0, 20, 12, 0, 0));
/** 1999-01-18 00:00 UTC — 09:00 in Seoul, which has kept no summer time since 1988. */
const BASE = Date.UTC(1999, 0, 18, 0, 0, 0);
/** Everything before this is this file's. */
const ERA_ENDS = new Date(Date.UTC(2000, 0, 1));
const at = (hoursUtc: number, seconds = 0) =>
  new Date(BASE + hoursUtc * HOUR + seconds * 1000);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const PERSON_PREFIX = "insights-read-";
const BOT_PREFIX = "agent_insights_read_";
const u1 = `${PERSON_PREFIX}${suite}-u1`;
const u2 = `${PERSON_PREFIX}${suite}-u2`;
const u3 = `${PERSON_PREFIX}${suite}-u3`;
const PEOPLE = [u1, u2, u3];
const bot = (name: string) => `${BOT_PREFIX}${suite}_${name}`;
const B1 = bot("b1");
const B2 = bot("b2");
const B3 = bot("b3");
const U1_BOTS = [B1, B2, B3, bot("b4"), bot("b5")];
const DELETED_BOT = bot("deleted");
const U2_BOT = bot("u2");
const ALL_BOTS = [...U1_BOTS, DELETED_BOT, U2_BOT];
const CUSTOM_SERVER = `${PERSON_PREFIX}crm-${suite}`;
const RUN = (name: string) => `${PERSON_PREFIX}${suite}-${name}`;

const OWNER_EMAIL = `owner-${suite}@example.com`;
const SENTENCE = "Tell me what is on the calendar tomorrow.";
/** The conversation the rated answers were in. */
const CHANNEL = `${PERSON_PREFIX}${suite}-channel`;
/** What somebody wrote under 아쉬워요: theirs, and never the fleet's. */
const RATING_NOTE = "매출 합계가 틀렸어요 평가노트";
const PLANTED = [
  RATING_NOTE,
  "rude words",
  OWNER_EMAIL,
  "김사장",
  "비밀 루틴",
  "myshop.co.kr",
  "token=abc",
  "secret-crm",
  "export_all",
  "오늘 매출은",
  "The caller does not have permission",
  "Bad Key!",
  SENTENCE,
  "문제가 생기면",
  "Not A Site",
];

const read = (days = 7) =>
  readInsights(database, { days, timeZone: ZONE, now: () => NOW });

/** First-party connector rows this file had to make, and therefore the only ones it may remove. */
const madeServers: string[] = [];

let before: InsightsReport;
let after: InsightsReport;

type Cell = ReadonlyArray<unknown>;

/**
 * How many more of each cell the second reading holds than the first, keyed by everything but the
 * count. Cells that did not move are left out, so what is asserted is exactly what the seeds added.
 */
function cellDelta(
  later: readonly Cell[] | null | undefined,
  earlier: readonly Cell[] | null | undefined,
): Record<string, number> {
  const tally = (cells: readonly Cell[] | null | undefined) => {
    const counts = new Map<string, number>();
    for (const cell of cells ?? []) {
      const key = JSON.stringify(cell.slice(0, -1));
      counts.set(key, (counts.get(key) ?? 0) + Number(cell.at(-1)));
    }
    return counts;
  };
  const a = tally(later);
  const b = tally(earlier);
  const moved: Record<string, number> = {};
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const difference = (a.get(key) ?? 0) - (b.get(key) ?? 0);
    if (difference !== 0) moved[key] = difference;
  }
  return moved;
}

const cellKey = (...values: unknown[]) => JSON.stringify(values);

async function audit(
  eventType: string,
  payload: Record<string, unknown>,
  createdAt: Date,
  extra: { targetId?: string; actorUserId?: string } = {},
) {
  await database.insert(auditEvents).values({
    eventType,
    targetType: "insights-test",
    payload,
    createdAt,
    ...extra,
  });
}

async function seed() {
  await database.insert(users).values(
    PEOPLE.map((id) => ({
      id,
      email: id === u1 ? OWNER_EMAIL : `${id}@example.com`,
      name: id === u1 ? "김사장" : "staff",
    })),
  );

  /*
   * Bots: u1 five live in the window and one deleted from a month before; u2 one from a month
   * before.
   */
  await database.insert(agents).values(
    ALL_BOTS.map((id) => ({
      id,
      name: "초롱",
      type: "remote_ag_ui" as const,
      configuration: { endpoint: "http://bot.local/ag-ui" },
    })),
  );
  await database.insert(agentProfiles).values([
    ...U1_BOTS.map((agentId) => ({
      agentId,
      ownerUserId: u1,
      roleDescription: "오늘 매출은 얼마인지 알려 줘",
      avatarSeed: "s:pebble.blue",
      createdAt: at(1),
    })),
    {
      agentId: DELETED_BOT,
      ownerUserId: u1,
      roleDescription: "",
      avatarSeed: "s:cloud.green",
      deletedAt: at(2),
      createdAt: daysAgo(30),
    },
    {
      agentId: U2_BOT,
      ownerUserId: u2,
      roleDescription: "",
      avatarSeed: "s:cloud.green",
      createdAt: daysAgo(30),
    },
  ]);

  // First-task chips, as the route writes them — and one written as nothing the route would write.
  const pressed = (
    agentId: string,
    payload: Record<string, unknown>,
    when = at(2),
  ) =>
    audit("onboarding.first_task_pressed", { agentId, ...payload }, when, {
      targetId: agentId,
      actorUserId: u1,
    });
  const askSchedule = {
    kind: "ask",
    pattern: "schedule",
    via: null,
    hint: "schedule",
  };
  await pressed(B1, askSchedule);
  await pressed(B1, askSchedule);
  await pressed(B1, {
    kind: "routine",
    pattern: "schedule",
    via: { kind: "site", id: "naver-smartplace" },
    hint: "schedule",
  });
  await pressed(B2, { kind: "connect", pattern: null, via: null, hint: null });
  await pressed(B2, {
    kind: "ask",
    pattern: "enquiries",
    via: { kind: "account", id: "gmail" },
    hint: null,
  });
  await pressed(B3, {
    kind: "type",
    pattern: "marketing",
    via: { kind: "email", id: OWNER_EMAIL },
    hint: "sales",
    sentence: SENTENCE,
  });
  await pressed(B1, askSchedule, daysAgo(10));

  /*
   * Routines: four by u1 in the window (two from suggestions, one with a key that is not a key),
   * one by u2 a month before and switched off, and twenty by u3 long before — the cap. Never due:
   * a clock left running by another suite must not pick one of these up.
   */
  const routine = (
    id: string,
    createdById: string,
    options: {
      suggestionKey?: string | null;
      enabled?: boolean;
      createdAt: Date;
      agentId?: string;
      name?: string;
    },
  ) => ({
    id,
    agentId: options.agentId ?? B1,
    name: options.name ?? "비밀 루틴",
    instruction: `${OWNER_EMAIL}으로 오늘 매출은 보내`,
    scheduleKind: "interval" as const,
    intervalMinutes: 60,
    enabled: options.enabled ?? true,
    createdById,
    createdByRole: "user",
    suggestionKey: options.suggestionKey ?? null,
    nextRunAt: new Date(Date.UTC(2999, 0, 1)),
    createdAt: options.createdAt,
  });
  await database.insert(lafRoutines).values([
    routine(RUN("r1"), u1, {
      suggestionKey: "morning-brief",
      createdAt: at(3),
    }),
    routine(RUN("r2"), u1, { suggestionKey: "review-watch", createdAt: at(3) }),
    routine(RUN("r3"), u1, { createdAt: at(3) }),
    routine(RUN("r5"), u1, { suggestionKey: "Bad Key!", createdAt: at(3) }),
    routine(RUN("r4"), u2, {
      suggestionKey: "stock-check",
      enabled: false,
      createdAt: daysAgo(30),
      agentId: U2_BOT,
    }),
    ...Array.from({ length: 20 }, (_, index) =>
      routine(RUN(`cap-${index}`), u3, {
        createdAt: daysAgo(40),
        name: "x",
      }),
    ),
  ]);

  // Runs: one met the step budget, one stopped asking on its thirteenth turn and ran ten minutes,
  // one from before `steps` was an array, one outside the window.
  const steps = (count: number) =>
    Array.from({ length: count }, () => ({ ms: 1, text: 1, calls: [] }));
  await database.insert(lafRoutineRuns).values([
    {
      id: RUN("rr1"),
      routineId: RUN("r1"),
      startedAt: at(4),
      finishedAt: at(4, 120),
      ok: true,
      answer: `오늘 매출은 ${OWNER_EMAIL}`,
      steps: steps(14),
    },
    {
      id: RUN("rr2"),
      routineId: RUN("r1"),
      startedAt: at(5),
      finishedAt: at(5, 600.5),
      ok: false,
      steps: steps(13),
    },
    {
      id: RUN("rr-old"),
      routineId: RUN("r2"),
      startedAt: daysAgo(10),
      finishedAt: daysAgo(10),
      steps: steps(14),
    },
  ]);
  await database.execute(sql`
    INSERT INTO laf_routine_runs (id, routine_id, started_at, steps)
    VALUES (${RUN("rr3")}, ${RUN("r2")}, ${at(6)}, '"a string, from before 0026"'::jsonb)`);

  await audit("routine.ran", { name: "비밀 루틴", ok: true }, at(4));
  await audit(
    "routine.ran",
    { name: "비밀 루틴", ok: true, silent: true },
    at(4),
  );
  await audit("routine.ran", { ok: true }, at(5));
  await audit(
    "routine.ran",
    { ok: false, failure: "laf:turn_timed_out" },
    at(5),
  );
  await audit(
    "routine.ran",
    { ok: false, failure: `${OWNER_EMAIL} broke it` },
    at(6),
  );
  await audit("routine.ran", { ok: true }, daysAgo(10));

  /*
   * Approvals, in Seoul hours: 09 answered in 30s; 14 denied in 90.6s (a later grant must not win);
   * 23 answered in 3600.4s; 03 never; 22 "answered" before it was asked (not an answer); one without
   * an approval id; one outside the window. Ids are this run's own, since the join is on them.
   */
  const approval = (name: string) => `${RUN("approval")}-${name}`;
  const ask = (name: string | null, hoursUtc: number) =>
    audit(
      "approval.requested",
      name ? { approval: approval(name), bot: B1 } : { bot: B1 },
      at(hoursUtc),
    );
  await ask("a4", 0);
  await audit("approval.granted", { approval: approval("a4") }, at(0, 30));
  await ask("a2", 5);
  await audit("approval.denied", { approval: approval("a2") }, at(5, 90.6));
  await audit("approval.granted", { approval: approval("a2") }, at(5, 200));
  await ask("a1", 14);
  await audit("approval.granted", { approval: approval("a1") }, at(14, 3600.4));
  await ask("a3", 18);
  await ask("a7", 13);
  await audit("approval.granted", { approval: approval("a7") }, at(13, -5));
  await ask(null, 1);
  await audit("approval.requested", { approval: approval("old") }, daysAgo(10));

  // Where Bots got stuck.
  for (let index = 0; index < 2; index += 1) {
    await audit(
      "computer.action_failed",
      {
        action: "computer_click",
        failure: "laf:stale_refs",
        page: "https://sell.smartstore.naver.com/o/orders",
      },
      at(7),
    );
  }
  await audit(
    "computer.action_failed",
    {
      action: "computer_type",
      failure: `Timeout 30000ms exceeded ${OWNER_EMAIL}`,
      page: "https://myshop.co.kr:8443/admin?token=abc",
    },
    at(7),
  );
  await audit(
    "computer.action_failed",
    { action: "computer_click", failure: "database error (23505)", page: "" },
    at(7),
  );
  await audit(
    "computer.action_allowed",
    {
      action: "computer_click",
      element: "laf:element_not_in_snapshot",
      page: "https://self.ceo.baemin.com/settle",
    },
    at(7),
  );
  await audit(
    "computer.action_allowed",
    {
      action: "computer_click",
      element: { role: "button", name: OWNER_EMAIL },
      page: "https://ceo.baemin.com/",
    },
    at(7),
  );
  await audit(
    "computer.action_repeated",
    {
      action: "computer_scroll",
      page: "https://smartstore.naver.com/main",
      fingerprint: "x",
      count: 5,
    },
    at(7),
  );
  await audit(
    "mcp.call_failed",
    {
      server: "google-sheets",
      tool: "append_sheet_row",
      failure: "The caller does not have permission",
    },
    at(8),
  );
  await audit(
    "mcp.call_failed",
    { server: "secret-crm", tool: "export_all", failure: "boom" },
    at(8),
  );
  await audit(
    "mcp.call_failed",
    { server: "notion", tool: "notion-search", failure: "boom" },
    at(8),
  );
  await audit("agent.stream_stalled", { bot: B1 }, at(8));

  await audit("support.feedback_sent", { length: 12, withScreen: true }, at(9));
  await audit(
    "support.feedback_sent",
    { length: 30, withScreen: false },
    at(9),
  );
  await audit(
    "support.feedback_sent",
    { length: 30, withScreen: true },
    daysAgo(10),
  );

  const opened = (section: unknown, actorUserId: string, when = at(9)) =>
    audit("support.help_opened", { section }, when, { actorUserId });
  await opened(null, u1);
  await opened("routines", u1);
  await opened("routines", u2);
  await opened("문제가 생기면", u2);
  await opened("routines", u1, daysAgo(10));

  /*
   * 좋아요·아쉬워요, counted by when each was LAST said: two 좋아요 and four 아쉬워요 in the window —
   * one of them with a note, one with no reason, one with a reason no route would have written —
   * and a 좋아요 from before it.
   */
  await database
    .insert(channels)
    .values({ id: CHANNEL, name: "김사장 and 초롱", description: "" });
  const rated = (
    name: string,
    rating: "up" | "down",
    reason: string | null,
    when = at(11),
    note: string | null = null,
  ) => ({
    id: RUN(`rating-${name}`),
    userId: u1,
    channelId: CHANNEL,
    messageId: RUN(`answer-${name}`),
    agentId: B1,
    rating,
    reason,
    note,
    createdAt: when,
    updatedAt: when,
  });
  await database
    .insert(lafAnswerRatings)
    .values([
      rated("up-1", "up", null),
      rated("up-2", "up", null),
      rated("wrong", "down", "wrong-facts", at(11), RATING_NOTE),
      rated("slow", "down", "too-slow"),
      rated("none", "down", null),
      rated("rude", "down", "rude words"),
      rated("up-old", "up", null, daysAgo(10)),
    ]);

  // Runs and what they spent.
  const threadRun = (
    runId: string,
    values: {
      userId: string | null;
      status: "done" | "error" | "unknown" | "stopped";
      origin: "chat" | "routine" | "wake";
      error?: string;
      startedAt?: Date;
    },
  ) => ({
    runId,
    userId: values.userId,
    label: "오늘 매출은",
    status: values.status,
    origin: values.origin,
    error: values.error ?? null,
    startedAt: values.startedAt ?? at(10),
  });
  await database.insert(lafThreadRuns).values([
    threadRun(RUN("run-u1-chat"), {
      userId: u1,
      status: "done",
      origin: "chat",
    }),
    threadRun(RUN("run-u1-err"), {
      userId: u1,
      status: "error",
      origin: "chat",
      error: `agent said laf:model_rate_limited after 3 tries (${OWNER_EMAIL})`,
    }),
    threadRun(RUN("run-u1-unknown"), {
      userId: u1,
      status: "unknown",
      origin: "wake",
    }),
    threadRun(RUN("run-u1-routine"), {
      userId: u1,
      status: "error",
      origin: "routine",
      error: "laf:turn_timed_out",
    }),
    threadRun(RUN("run-u1-stopped"), {
      userId: u1,
      status: "stopped",
      origin: "chat",
    }),
    threadRun(RUN("run-u2"), { userId: u2, status: "done", origin: "chat" }),
    threadRun(RUN("run-system"), {
      userId: null,
      status: "done",
      origin: "wake",
    }),
    threadRun(RUN("run-old"), {
      userId: u1,
      status: "done",
      origin: "chat",
      startedAt: daysAgo(10),
    }),
  ]);
  await audit(
    "model.usage",
    { runId: RUN("run-u1-chat"), totalTokens: 1200 },
    at(10),
  );
  await audit(
    "model.usage",
    { runId: RUN("run-u1-chat"), totalTokens: 800 },
    at(10),
  );
  await audit(
    "model.usage",
    { runId: RUN("run-u2"), totalTokens: 500 },
    at(10),
  );
  await audit(
    "model.usage",
    { runId: RUN("run-old"), totalTokens: 300 },
    at(10),
  );
  await audit("model.usage", { totalTokens: 46, source: "judge" }, at(10));
  await audit("model.usage", { totalTokens: "lots" }, at(10));
  await audit(
    "model.usage",
    { runId: RUN("run-u2"), totalTokens: 9999 },
    daysAgo(10),
  );

  // Site connections, as spans the product only keeps the ends of.
  await database.insert(lafSiteConnections).values([
    {
      userId: u1,
      siteId: "naver-smartstore",
      botId: B1,
      connectedAt: daysAgo(20),
      lastSeenAt: new Date(daysAgo(20).getTime() + 6.9 * DAY),
      needsLogin: true,
    },
    {
      userId: u2,
      siteId: "naver-smartstore",
      botId: U2_BOT,
      connectedAt: daysAgo(5),
      lastSeenAt: new Date(NOW.getTime() - 2 * HOUR),
      needsLogin: false,
    },
    {
      userId: u3,
      siteId: "naver-smartstore",
      botId: B1,
      connectedAt: at(0),
      lastSeenAt: at(-1),
      needsLogin: true,
    },
    {
      userId: u1,
      siteId: "baemin-ceo",
      botId: B1,
      connectedAt: daysAgo(3.5),
      lastSeenAt: daysAgo(0.4),
      needsLogin: false,
    },
    {
      userId: u2,
      siteId: "Not A Site",
      botId: U2_BOT,
      connectedAt: daysAgo(1),
      lastSeenAt: daysAgo(1),
      needsLogin: true,
    },
  ]);

  // Accounts. First-party server rows are made only where the database does not already hold one.
  for (const [id, title] of [
    ["google-sheets", "Google Sheets"],
    ["gmail", "Gmail"],
    ["notion", "Notion"],
    [CUSTOM_SERVER, "secret-crm"],
  ] as const) {
    const made = await database
      .insert(mcpServers)
      .values({
        id,
        title,
        vendor: "insights-test",
        url: `https://${id}.test.invalid/mcp`,
        provenance: id === CUSTOM_SERVER ? "custom" : "first-party",
      })
      .onConflictDoNothing()
      .returning({ id: mcpServers.id });
    if (made.length > 0) madeServers.push(id);
  }
  const held = async (
    serverId: string,
    userId: string,
    values: {
      connectedAt: Date;
      lastFailureAt?: Date;
      lastFailureCode?: string;
    },
  ) => {
    const [credential] = await database
      .insert(credentials)
      .values({
        kind: "mcp_user_token",
        provider: serverId,
        encryptedValue: "sealed",
        keyId: `${userId}:${serverId}`,
        metadata: {},
      })
      .returning({ id: credentials.id });
    if (!credential) throw new Error("no credential row");
    await database.insert(mcpUserCredentials).values({
      serverId,
      userId,
      credentialId: credential.id,
      scope: OWNER_EMAIL,
      connectedAt: values.connectedAt,
      lastFailureAt: values.lastFailureAt ?? null,
      lastFailureCode: values.lastFailureCode ?? null,
    });
  };
  await held("google-sheets", u1, { connectedAt: daysAgo(9) });
  await held("gmail", u1, {
    connectedAt: daysAgo(30),
    lastFailureAt: daysAgo(18),
    lastFailureCode: "revoked",
  });
  await held("gmail", u2, {
    connectedAt: daysAgo(10),
    lastFailureAt: daysAgo(7.5),
    lastFailureCode: "refresh_failed",
  });
  await held("notion", u1, {
    connectedAt: daysAgo(9),
    lastFailureAt: daysAgo(1),
    lastFailureCode: "vendor_down",
  });
  await held(CUSTOM_SERVER, u1, { connectedAt: daysAgo(9) });
}

/**
 * What an earlier run of this file left in its era: trail rows nothing but the maintenance exit may
 * remove, and — if that run died before its `afterAll` — its people, Bots and runs. Every statement
 * is scoped to this file's names or to before 2000, which no other file writes.
 */
async function clearEra() {
  await database.execute(sql`SELECT audit_purge_before(${ERA_ENDS})`);
  await database
    .delete(lafThreadRuns)
    .where(sql`${lafThreadRuns.startedAt} < ${ERA_ENDS}`);
  await database
    .delete(mcpUserCredentials)
    .where(sql`${mcpUserCredentials.userId} LIKE ${`${PERSON_PREFIX}%`}`);
  await database
    .delete(credentials)
    .where(sql`${credentials.keyId} LIKE ${`${PERSON_PREFIX}%`}`);
  await database
    .delete(mcpServers)
    .where(sql`${mcpServers.id} LIKE ${`${PERSON_PREFIX}crm-%`}`);
  await database
    .delete(agents)
    .where(sql`${agents.id} LIKE ${`${BOT_PREFIX}%`}`);
  await database
    .delete(channels)
    .where(sql`${channels.id} LIKE ${`${PERSON_PREFIX}%`}`);
  await database
    .delete(users)
    .where(sql`${users.id} LIKE ${`${PERSON_PREFIX}%`}`);
}

beforeAll(async () => {
  await clearEra();
  before = await read();
  await seed();
  after = await read();
}, 30_000);

afterAll(async () => {
  // Scoped to what this file made, in foreign-key order. The trail rows stay until the next run's
  // `clearEra`: in 1999 they sit outside every window but this file's.
  await database
    .delete(mcpUserCredentials)
    .where(inArray(mcpUserCredentials.userId, PEOPLE));
  for (const person of PEOPLE) {
    await database
      .delete(credentials)
      .where(sql`${credentials.keyId} LIKE ${`${person}:%`}`);
  }
  if (madeServers.length > 0) {
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, madeServers));
  }
  await database
    .delete(lafThreadRuns)
    .where(sql`${lafThreadRuns.runId} LIKE ${`${PERSON_PREFIX}${suite}-%`}`);
  // The ratings go with the conversation they were in.
  await database.delete(channels).where(eq(channels.id, CHANNEL));
  await database.delete(agents).where(inArray(agents.id, ALL_BOTS));
  await database.delete(users).where(inArray(users.id, PEOPLE));
  await database.$client.close();
});

describe("what the insights read counts, against the product's own tables", () => {
  test("every section answers, over the window it says", () => {
    expect(after.window).toEqual({
      days: 7,
      from: new Date(NOW.getTime() - 7 * DAY).toISOString(),
      to: NOW.toISOString(),
      nightTimeZone: ZONE,
    });
    for (const section of [
      "onboarding",
      "routines",
      "limits",
      "approvals",
      "sites",
      "accounts",
      "failures",
      "support",
      "people",
    ] as const) {
      expect([section, after[section] === null]).toEqual([section, false]);
    }
  });

  test("onboarding: Bots made, and the chips pressed on them", () => {
    // Live Bots have no window: u1's five and u2's one, over whatever the database already held.
    expect(
      (after.onboarding?.botsLive ?? 0) - (before.onboarding?.botsLive ?? 0),
    ).toBe(6);

    const onboarding = after.onboarding;
    expect(onboarding?.botsCreated).toBe(5);
    // No `fromPreset` since migration 0047 dropped the column it counted.
    expect(onboarding).not.toHaveProperty("fromPreset");
    expect(onboarding?.firstTaskPresses).toBe(6);
    expect(onboarding?.botsWithFirstTask).toBe(3);
    expect(onboarding?.firstTasks[0]).toEqual([
      "ask",
      "schedule",
      null,
      null,
      "schedule",
      2,
    ]);
    expect(cellDelta(onboarding?.firstTasks, [])).toEqual({
      [cellKey("ask", "schedule", null, null, "schedule")]: 2,
      [cellKey("ask", "enquiries", "account", "gmail", null)]: 1,
      [cellKey("connect", null, null, null, null)]: 1,
      [cellKey("routine", "schedule", "site", "naver-smartplace", "schedule")]:
        1,
      // Nothing the route would have written: every field folds to `other` and keeps its count.
      [cellKey("other", "other", "other", "other", "other")]: 1,
    });
  });

  test("routines: made, from which suggestion, and how their runs went", () => {
    expect((after.routines?.live ?? 0) - (before.routines?.live ?? 0)).toBe(24);
    expect(after.routines).toEqual({
      live: after.routines?.live ?? -1,
      created: 4,
      fromSuggestion: { "morning-brief": 1, "review-watch": 1 },
      runs: 5,
      ok: 3,
      silent: 1,
      failed: 2,
    });
  });

  test("limits: who is at a cap, and which runs met the step and time budgets", () => {
    const limits = after.limits;
    expect(limits?.botsPerPersonMax).toBeGreaterThanOrEqual(5);
    expect(limits?.routinesPerPersonMax).toBeGreaterThanOrEqual(20);
    // Both people: the cap is one Bot since 2026-09-24, so u2's one is at it and u1's five — a
    // roster from before the cap came down — are past it and still counted.
    expect(
      (limits?.peopleAtBotCap ?? 0) - (before.limits?.peopleAtBotCap ?? 0),
    ).toBe(2);
    expect(
      (limits?.peopleAtRoutineCap ?? 0) -
        (before.limits?.peopleAtRoutineCap ?? 0),
    ).toBe(1);
    // Fourteen entries met the budget and thirteen did not; 600.5s met the time cap.
    expect([
      limits?.routineRuns,
      limits?.runsAtStepCap,
      limits?.runsAtTimeCap,
    ]).toEqual([3, 1, 1]);
  });

  test("approvals: asked in which Seoul hour, answered in how many whole seconds", () => {
    // 90.6s rounds to 91 and 3600.4s to 3600; a "grant" before the question is no answer.
    expect(after.approvals).toEqual([
      [3, null, 1],
      [9, 30, 1],
      [14, 91, 1],
      [22, null, 1],
      [23, 3600, 1],
    ]);
  });

  test("sites: behind the wall or not, and the proven span in whole days", () => {
    // 6.9 days → 6; a last sighting before the first sign-in → 0, never negative; not a site → gone.
    expect(cellDelta(after.sites, before.sites)).toEqual({
      [cellKey("baemin-ceo", false, 3)]: 1,
      [cellKey("naver-smartstore", false, 4)]: 1,
      [cellKey("naver-smartstore", true, 0)]: 1,
      [cellKey("naver-smartstore", true, 6)]: 1,
    });
  });

  test("accounts: revoked and refresh_failed need a person, vendor_down does not, custom is custom", () => {
    expect(cellDelta(after.accounts, before.accounts)).toEqual({
      [cellKey("custom", false, null)]: 1,
      [cellKey("gmail", true, 2)]: 1,
      [cellKey("gmail", true, 12)]: 1,
      [cellKey("google-sheets", false, null)]: 1,
      [cellKey("notion", false, null)]: 1,
    });
  });

  test("failures: a code out of free text or nothing, a site out of a host or other", () => {
    // computer 6 · connector 3 · routine 2 · stream 1 · turn 2 (the routine-origin run is routine.ran's)
    expect(after.failures?.total).toBe(14);
    expect(after.failures?.top[0]).toEqual([
      "computer",
      "laf:stale_refs",
      "computer_click",
      "naver-smartstore",
      2,
    ]);
    expect(cellDelta(after.failures?.top, [])).toEqual({
      [cellKey(
        "computer",
        "laf:stale_refs",
        "computer_click",
        "naver-smartstore",
      )]: 2,
      [cellKey("computer", "database_error", "computer_click", null)]: 1,
      [cellKey(
        "computer",
        "laf:action_repeated",
        "computer_scroll",
        "naver-smartstore",
      )]: 1,
      [cellKey(
        "computer",
        "laf:element_not_in_snapshot",
        "computer_click",
        "baemin-ceo",
      )]: 1,
      [cellKey("computer", "uncoded", "computer_type", "other")]: 1,
      [cellKey(
        "connector",
        "vendor_error",
        "google-sheets.append_sheet_row",
        null,
      )]: 1,
      [cellKey("connector", "vendor_error", "custom", null)]: 1,
      [cellKey("connector", "vendor_error", "notion", null)]: 1,
      [cellKey("routine", "laf:turn_timed_out", "routine", null)]: 1,
      [cellKey("routine", "uncoded", "routine", null)]: 1,
      [cellKey("stream", "laf:agent_stalled", "stream", null)]: 1,
      [cellKey("turn", "laf:model_rate_limited", "chat", null)]: 1,
      [cellKey("turn", "laf:turn_interrupted", "wake", null)]: 1,
    });
  });

  test("support: feedback, the help page, and how answers were rated — how often, and why not", () => {
    expect(after.support).toEqual({
      feedback: 2,
      withScreen: 1,
      helpOpened: 4,
      helpReaders: 2,
      // A heading written as words is a visit, and not a section.
      helpSections: { routines: 2 },
      answersUp: 2,
      answersDown: 4,
      // By reason, for the ones that named one from the list. A reason no route writes is not a key.
      downReasons: { "too-slow": 1, "wrong-facts": 1 },
    });
  });

  test("people: turns and tokens per person with no id, by where they came from", () => {
    expect((after.people?.accounts ?? 0) - (before.people?.accounts ?? 0)).toBe(
      3,
    );
    // u1: five runs in the window, 2000 + 300 (a run from before the window, spent in it); u2: 1 · 500
    expect(after.people?.perPerson).toEqual([
      [5, 2300],
      [1, 500],
    ]);
    expect(after.people?.turnsByOrigin).toEqual({
      chat: 4,
      routine: 1,
      wake: 2,
    });
    expect(after.people?.tokensByOrigin).toEqual({ chat: 2800, server: 46 });
  });

  test("none of the content sitting beside the counted rows comes back", () => {
    const everything = JSON.stringify(after);
    for (const planted of PLANTED) {
      expect([planted, everything.includes(planted)]).toEqual([planted, false]);
    }
    // Nor any id: of a person, of a Bot, of a run, of a conversation or an answer.
    for (const id of [
      ...PEOPLE,
      ...ALL_BOTS,
      RUN("run-u1-chat"),
      CUSTOM_SERVER,
      CHANNEL,
      RUN("answer-wrong"),
    ]) {
      expect(everything.includes(id)).toBe(false);
    }
  });

  test("a wider window reaches the older rows", async () => {
    const month = await read(30);
    expect(month.approvals?.reduce((sum, cell) => sum + cell[2], 0)).toBe(6);
    expect(month.support?.feedback).toBe(3);
    expect(month.support?.helpOpened).toBe(5);
    expect(month.support?.answersUp).toBe(3);
    expect(month.limits?.routineRuns).toBe(4);
    expect(month.onboarding?.firstTaskPresses).toBe(7);
  });
});

describe("how a section is read", () => {
  const statements = () =>
    insightStatements({
      since: new Date(NOW.getTime() - 7 * DAY),
      to: NOW,
      timeZone: ZONE,
    });

  test("one that fails is null, and the other eight still answer", async () => {
    const sections = await readInsightSections(database, {
      ...statements(),
      approvals: sql`SELECT (1 / 0)::text AS value`,
    });
    expect(sections.approvals).toBeNull();
    expect(sections.support?.feedback).toBe(2);
    expect(sections.people?.perPerson).toHaveLength(2);
  });

  test("in a transaction that cannot write", async () => {
    const intruder = `${PERSON_PREFIX}${suite}-intruder`;
    const sections = await readInsightSections(database, {
      ...statements(),
      support: sql`INSERT INTO users (id, email) VALUES (${intruder}, ${`${intruder}@example.com`}) RETURNING 'written' AS value`,
    });
    expect(sections.support).toBeNull();
    expect(
      await database.select().from(users).where(eq(users.id, intruder)),
    ).toHaveLength(0);
  });
});
