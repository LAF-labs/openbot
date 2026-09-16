import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { logLine } from "../../shared/log";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  channelThreads,
  lafFeedback,
  lafRoutines,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import {
  createDiagnosticsShelf,
  createDiagnosticsSource,
  type DiagnosticBundle,
  type DiagnosticsShelf,
} from "../src/support/diagnostics";
import { createFeedbackStore } from "../src/support/feedback";
import { createSupportRoutes } from "../src/support/routes";
import { TEST_POOL } from "./support/database";

/**
 * 진단 정보, FROM THE TICK TO THE ROW, AGAINST THE TABLES THAT SAY WHOSE THINGS ARE WHOSE.
 *
 * `diagnostics.test.ts` proves the allow-list on a log it hands over with ownership already decided.
 * This is the half a fake cannot be trusted with: which Bot, run, conversation, room and routine is
 * whose is read from the real tables — a Bot by its profile, a run by the ledger, a conversation by
 * `channel_threads`, a room by who else is in it — and the bundle the preview drew is the one the
 * row keeps, through the route and a real `jsonb` column. Two people share the VM, and the second
 * one's Bot, run, thread and routine are all named in the same log tail.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
const person = (name: string) => ({
  id: `diag-${name}-${tag}`,
  bot: `diag-bot-${name}-${tag}`,
  run: `diag-run-${name}-${tag}`,
  thread: randomUUID(),
  channel: `diag-channel-${name}-${tag}`,
  routine: `diag-routine-${name}-${tag}`,
});
const A = person("a");
const B = person("b");
const ROOM = `diag-room-${tag}`;

const PASSWORD = "Hunter2!diag-canary";
const KOREAN = "리뷰 답글은 이렇게 써 줘 진단카나리아";
const EMAIL = "diag.canary@laf.test";
const TOKEN_URL =
  "https://smartstore.example.com/callback?code=DIAGCODE&access_token=diagTOKEN987";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

const LINES = [
  logLine(
    "error",
    "server",
    "agent_stream_stalled",
    { bot: A.bot, thread: A.thread, run: A.run, silentForMs: 60_000 },
    at(30),
  ),
  logLine(
    "error",
    "server",
    "routine_run_not_recorded",
    { routine: A.routine, reason: new Error(`${TOKEN_URL} ${EMAIL}`) },
    at(29),
  ),
  logLine(
    "error",
    "server",
    "room_turn_failed",
    { channel: A.channel, typed: PASSWORD, message: KOREAN },
    at(28),
  ),
  // Somebody else's, every kind of it, and a room both of them are in.
  logLine(
    "error",
    "server",
    "agent_stream_stalled",
    { bot: B.bot, thread: B.thread, run: B.run },
    at(27),
  ),
  logLine(
    "error",
    "server",
    "routine_run_not_recorded",
    { routine: B.routine },
    at(26),
  ),
  logLine(
    "error",
    "server",
    "room_turn_failed",
    { channel: B.channel },
    at(25),
  ),
  logLine("error", "server", "room_turn_failed", { channel: ROOM }, at(24)),
];

async function seed(who: typeof A) {
  await database.insert(users).values({
    id: who.id,
    email: `${who.id}@laf.test`,
    name: who.id,
    emailVerified: true,
  });
  await database.insert(agents).values({
    id: who.bot,
    name: `${who.id}'s Bot`,
    type: "remote_ag_ui",
    configuration: { endpoint: "https://bot.example.test/ag-ui" },
  });
  await database.insert(agentProfiles).values({
    agentId: who.bot,
    ownerUserId: who.id,
    title: "Reviews",
    roleDescription: "Answers reviews.",
    avatarSeed: "seed",
  });
  await database.insert(channels).values({
    id: who.channel,
    name: `${who.id} alone`,
    description: "",
  });
  await database
    .insert(channelMemberships)
    .values({ channelId: who.channel, userId: who.id });
  await database
    .insert(channelThreads)
    .values({ userId: who.id, channelId: who.channel, threadId: who.thread });
  await database.insert(lafRoutines).values({
    id: who.routine,
    agentId: who.bot,
    name: KOREAN,
    instruction: KOREAN,
    scheduleKind: "daily",
    dailyLocal: "09:00",
    dailyTimeZone: "Asia/Seoul",
    createdById: who.id,
    createdByRole: "user",
    nextRunAt: new Date(),
  });
  await database.insert(lafThreadRuns).values({
    runId: who.run,
    threadId: who.thread,
    agentId: who.bot,
    userId: who.id,
    // A routine's name, which a person wrote, and an error written by whatever threw.
    label: `${KOREAN} ${EMAIL}`,
    status: "error",
    origin: "chat",
    error: `Unable to connect. ${TOKEN_URL} ${PASSWORD}`,
    startedAt: at(31),
    finishedAt: at(30),
  });
}

beforeAll(async () => {
  await seed(A);
  await seed(B);
  await database.insert(channels).values({
    id: ROOM,
    name: "shared room",
    description: "",
  });
  await database.insert(channelMemberships).values([
    { channelId: ROOM, userId: A.id },
    { channelId: ROOM, userId: B.id },
  ]);
});

afterAll(async () => {
  await database
    .delete(lafThreadRuns)
    .where(inArray(lafThreadRuns.runId, [A.run, B.run]));
  await database.delete(agents).where(inArray(agents.id, [A.bot, B.bot]));
  await database
    .delete(channels)
    .where(inArray(channels.id, [A.channel, B.channel, ROOM]));
  // The feedback rows go with the people.
  await database.delete(users).where(inArray(users.id, [A.id, B.id]));
  await database.$client.end();
});

function surface(actorId: string, shelf?: DiagnosticsShelf) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@laf.test`,
      role: "user",
    });
    await next();
  };
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/support",
    createSupportRoutes(
      {
        feedback: createFeedbackStore(database),
        auditStore: { insert: async () => {} },
        diagnostics: createDiagnosticsSource({
          database,
          lines: () => LINES,
        }),
      },
      requireUser,
      {
        version: { version: "edge", revision: "eeea985" },
        health: async () => ({
          status: "ok",
          checks: { database: "ok", agentBot: "ok" },
        }),
        ...(shelf ? { shelf } : {}),
      },
    ),
  );
}

describe("diagnostic details, through the route to the row", () => {
  test("what the preview drew is what the row keeps — this person's, and none of the canaries", async () => {
    const app = surface(A.id);
    const preview = await app.request("/api/support/diagnostics");
    expect(preview.status).toBe(200);
    const { id, diagnostics } = (await preview.json()) as {
      id: string;
      diagnostics: DiagnosticBundle;
    };

    const sent = await app.request("/api/support/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "안 돼요", diagnostics: { id } }),
    });
    expect(sent.status).toBe(201);
    const receipt = (await sent.json()) as {
      id: string;
      withDiagnostics: boolean;
    };
    expect(receipt.withDiagnostics).toBe(true);

    const [row] = await database
      .select({ diagnostics: lafFeedback.diagnostics })
      .from(lafFeedback)
      .where(eq(lafFeedback.id, receipt.id));
    expect(row?.diagnostics).toEqual(diagnostics);

    const kept = row?.diagnostics as DiagnosticBundle;
    expect(kept.events.map((event) => event.event)).toEqual([
      "agent_stream_stalled",
      "run_failed",
      "routine_run_not_recorded",
      "room_turn_failed",
    ]);
    expect(kept.failures).toEqual([
      {
        code: "laf:turn_unreachable",
        count: 1,
        lastAt: expect.any(String),
      },
    ]);

    const serialised = JSON.stringify(row);
    for (const canary of [
      PASSWORD,
      "Hunter2",
      KOREAN,
      "진단카나리아",
      EMAIL,
      "@laf.test",
      TOKEN_URL,
      "smartstore.example.com",
      "diagTOKEN987",
      "DIAGCODE",
    ]) {
      expect({ canary, found: serialised.includes(canary) }).toEqual({
        canary,
        found: false,
      });
    }
    for (const theirs of [B.bot, B.run, B.thread, B.channel, B.routine, ROOM]) {
      expect({ theirs, found: serialised.includes(theirs) }).toEqual({
        theirs,
        found: false,
      });
    }
  });

  test("the second person reads their own, and never the first person's", async () => {
    const response = await surface(B.id).request("/api/support/diagnostics");
    const { diagnostics } = (await response.json()) as {
      diagnostics: DiagnosticBundle;
    };
    const serialised = JSON.stringify(diagnostics);
    expect(serialised).toContain(B.bot);
    for (const theirs of [A.bot, A.run, A.thread, A.channel, A.routine, ROOM]) {
      expect({ theirs, found: serialised.includes(theirs) }).toEqual({
        theirs,
        found: false,
      });
    }
  });

  test("a bundle shown to one person cannot be sent by another", async () => {
    // One shelf behind both, as there is one process behind both on a VM.
    const shelf = createDiagnosticsShelf();
    const preview = await surface(A.id, shelf).request(
      "/api/support/diagnostics",
    );
    const { id } = (await preview.json()) as { id: string };
    const refused = await surface(B.id, shelf).request(
      "/api/support/feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "x", diagnostics: { id } }),
      },
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "laf:diagnostics_expired",
      code: "laf:diagnostics_expired",
    });
    expect(
      await database
        .select({ id: lafFeedback.id })
        .from(lafFeedback)
        .where(eq(lafFeedback.userId, B.id)),
    ).toEqual([]);

    // The same id, from the person it was shown to, is still good: the refusal was about who.
    const own = await surface(A.id, shelf).request("/api/support/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", diagnostics: { id } }),
    });
    expect(own.status).toBe(201);
  });
});
