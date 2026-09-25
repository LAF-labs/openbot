/**
 * THE AUTHORIZATION MATRIX: every route this server mounts, driven by four people and one who was
 * removed.
 *
 * Audit A8 (2026-09-10) stood the server up with real authentication, planted two people with a
 * Bot each, and pressed every route as each of them and as nobody. It found that the anonymous
 * column was clean and the colleague column was not: B, signed in, read A's Bot's screen, took its
 * wheel, listed its open questions, read its component grants, and planted a routine on it — the
 * ownership predicate that had closed chat, the live screen and tool calls had never reached
 * these doors. This file is that measurement, kept.
 *
 * WHAT IT ASSERTS. The routes are enumerated from the app itself (`app.routes`), not from a list
 * somebody wrote, so a route added tomorrow is in the matrix the day it is mounted. For every
 * route and every person:
 *
 *   - nothing answers 500, ever, and the 503s are the deliberate ones, listed by code;
 *   - nobody signed in gets anything but 401 on `/api/*`, save the routes that are public on
 *     purpose, listed by name;
 *   - a colleague (B) naming the owner's (A's) Bot is told 404 — `laf:bot_not_found` — on every
 *     door the Bot id opens, never 200 and never a 403 that would confirm the Bot exists;
 *   - the cells that answer 2xx are EXACTLY the ones listed here, per person, so an accidental
 *     widening anywhere in the server is a diff in this file;
 *   - somebody struck off the sign-in list, still holding a session and a role, reaches exactly what
 *     nobody signed in reaches — told on every guarded door that the session was taken away
 *     (2026-09-14: that person used to keep everything they had until the cookie expired).
 *
 * The stores behind the routes are the real ones on the test database wherever the constructor
 * takes a database; the computer is a fake that answers everything, because the question here is
 * who may reach it, not what it does. Nothing under `/api/copilotkit` is mounted: the runtime
 * cannot be imported from a test (see `createApp`), and its guard has its own file
 * (`copilot-guard.test.ts`).
 *
 * Bodies name A's Bot wherever a body names a Bot, so the colleague column presses on the
 * body-borne doors (`routines`, `components/:name/decision|call`, `plugins/call`, `plugins/grants`,
 * `channels`) as well as the path-borne ones, and the one query-borne door (`DELETE
 * plugins/grants`) is sent its Bot in the query. Everything else is sent an empty object, which
 * every route refuses without writing anything — and the routes that destroy something are pointed
 * at a throwaway Bot, at A's routine, or at nobody, run last, and the fixture is put back before
 * the next person.
 *
 * `LAF_MATRIX_DUMP=1` prints every cell, which is how the lists below were written and how the
 * next one gets updated.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { createAccountDeletion } from "../src/account/deletion";
import { createAccountExport } from "../src/account/export";
import { createConsentStore } from "../src/account/consent";
import { createAgentMemoryStore } from "../src/agents/memory-store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createAuditReader, createAuditStore } from "../src/audit";
import type { AuthService } from "../src/auth/guards";
import { createSignInAllowlist } from "../src/auth/allowlist";
import { createRoleRepository, lookupBotOwner } from "../src/auth/guards";
import { createOnboardingStore } from "../src/auth/onboarding";
import {
  createSessionRevocation,
  SESSION_REVOKED,
} from "../src/auth/session-revocation";
import { streamBotAccess } from "../src/auth/stream-access";
import { createChannelEventHub } from "../src/channels/events";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createSandboxedStore } from "../src/components/sandboxed";
import { createComponentStore } from "../src/components/store";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import { createDemonstrationRecorder } from "../src/computer/demonstration";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createPolicyStore } from "../src/computer/policy-store";
import type { SnapshotResult } from "../src/computer/schema";
import { createScreenViewAudit } from "../src/computer/screen-view";
import { createSiteConnectionStore } from "../src/computer/site-connections";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { loadConfig } from "../src/config";
import {
  createCredentialAdminService,
  createCredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channels,
  lafRoutines,
  userRoles,
  users,
} from "../src/db/schema";
import { readApprovalMetrics } from "../src/notifications/approval-metrics";
import { createNotificationOutbox } from "../src/notifications/outbox";
import { createPartnerRuntime } from "../src/plugins/partners";
import { createPluginStore } from "../src/plugins/store";
import { createRoutineService } from "../src/routines/service";
import { createSuggestionDismissalStore } from "../src/routines/suggestions";
import { createMessageTimeReader } from "../src/runner/message-times";
import { createWorkingReader } from "../src/runner/working";
import { readInsights } from "../src/insights/read";
import { createAnswerRatingStore } from "../src/support/answer-ratings";
import { createDiagnosticsSource } from "../src/support/diagnostics";
import { createFeedbackStore } from "../src/support/feedback";
import { createPackageStatusReader } from "../src/tenant-package";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";
import { A_CLICK } from "./support/subjects";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const TRUSTED = "https://matrix.agent.laf-co.test";
/**
 * The fleet's read token, so its door is mounted and pressed like every other. None of the four
 * people holds it — a session is not the fleet — so every cell on it is a 401 with a code.
 */
const FLEET_METRICS_TOKEN = `matrix-fleet-${"0".repeat(32)}`;
const config = loadConfig(
  testEnvironment({
    TRUSTED_ORIGINS: `${TRUSTED},http://localhost:3000`,
    LAF_FLEET_METRICS_TOKEN: FLEET_METRICS_TOKEN,
  }),
);

/** One suffix per run, so two gates on one database never see each other's rows. */
const run = randomUUID().slice(0, 8);

/** The four people. A and B are ordinary users with a Bot each; the administrator owns nothing. */
const A = { id: `matrix-a-${run}`, role: "user" as const };
const B = { id: `matrix-b-${run}`, role: "user" as const };
const ADMIN = { id: `matrix-admin-${run}`, role: "admin" as const };
/**
 * And one who was removed: an account with a role and a session, whose address the deployment's
 * sign-in list no longer carries — `laf member remove`, then the push. An administrator's role, so
 * the column shows that no role buys anything back.
 */
const REMOVED = { id: `matrix-removed-${run}`, role: "admin" as const };
const PEOPLE = [A, B, ADMIN, REMOVED];
const PEOPLE_IDS = PEOPLE.map((person) => person.id);
const emailOf = (person: { id: string }) => `${person.id}@laf.test`;

/** A's Bots: the one every cell names, and one for the delete cell to consume. */
const BOT_A = `agent_a_${run}`;
const BOT_A_DOOMED = `agent_adel_${run}`;
const BOT_B = `agent_b_${run}`;
/**
 * A Bot the deployment itself ships: a profile with no owner.
 *
 * It replaced A's `public` Bot, which is the fixture this file used to keep for the one Bot two
 * people could both see. There is no such marking any more — a Bot is the account's that made it —
 * so the only Bot in front of more than one person is one in front of all of them.
 */
const BOT_SHIPPED = `agent_shipped_${run}`;
/** An `agents` row with NO profile: not a Bot anybody made, which the rule says is everybody's. */
const BOT_NOBODYS = `agent_nobody_${run}`;
const SEEDED_BOTS = [BOT_A, BOT_SHIPPED, BOT_A_DOOMED, BOT_B, BOT_NOBODYS];

/** A well-formed id that names nothing, for the parameters that are keys into a table. */
const NOBODY = `nobody-${run}`;
const NO_SUCH_UUID = "00000000-0000-4000-8000-000000000000";

const SNAPSHOT: SnapshotResult = {
  snapshotId: 1,
  url: "https://example.com/",
  title: "Example",
  truncated: false,
  elements: [{ ref: "e1", role: "button", name: "Go" }],
};

/**
 * A computer that answers everything.
 *
 * A Proxy rather than a hand-written stub, because the question in this file is never what the
 * computer did: every member the gateway or a route reaches resolves to a plausible shape, and a
 * member nobody stubbed cannot turn into a 500 that this file would then have to explain.
 */
function computerThatAnswers(): ComputerClient {
  const answers: Record<string, unknown> = {
    status: { botId: BOT_A, state: "ready" },
    screenshot: {
      base64: "aGVsbG8=",
      width: 1,
      height: 1,
      capturedAt: "2026-09-10T00:00:00.000Z",
    },
    read: { url: SNAPSHOT.url, title: SNAPSHOT.title, text: "" },
    snapshot: SNAPSHOT,
    control: { holder: "bot", url: SNAPSHOT.url },
    requestControl: { holder: "bot", url: SNAPSHOT.url },
    takeControl: { holder: "human", url: SNAPSHOT.url },
    releaseControl: { holder: "bot", url: SNAPSHOT.url },
    computers: { computers: [] },
    listFiles: { path: ".", entries: [] },
    readFile: { path: "notes.md", contents: "", truncated: false },
    writeFile: { path: "notes.md", bytes: 0 },
    stopComputer: { wasRunning: false },
    resetComputer: { botId: BOT_A, state: "stopped" },
  };
  const client: ComputerClient = new Proxy({} as ComputerClient, {
    get(_target, member) {
      if (member === "forBot") return () => client;
      if (typeof member !== "string") return undefined;
      return async () =>
        answers[member] ?? { action: member, url: SNAPSHOT.url, elapsedMs: 1 };
    },
  });
  return client;
}

const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

/**
 * Sessions as this file mints them: the cookie names the person, and the session is the person.
 * better-auth's own signing is proven elsewhere (`laf-oidc.integration.test.ts`); the seam this
 * file drives starts where `createRequireUser` takes the session and asks the tables who it is.
 */
const auth: AuthService = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async ({ headers }) => {
      const cookie = headers.get("cookie") ?? "";
      const id = cookie.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
      const person = PEOPLE.find((candidate) => candidate.id === id);
      return person
        ? { user: { id: person.id, email: emailOf(person) } }
        : null;
    },
  },
};

/**
 * The sign-in list this deployment booted with: the three who are still here. The session above
 * keeps answering for the removed person on every request — the way a row did before 2026-09-14 —
 * so every cell of theirs is the guard deciding, never a session that happened to be gone already.
 */
const admission = createSessionRevocation({
  database,
  allowlist: createSignInAllowlist({
    allowedEmails: [A, B, ADMIN].map(emailOf),
    initialAdminEmails: [],
  }),
});

/** The deployment as `main.ts` assembles it, every mount present, on the test database. */
function deployment() {
  const auditStore = createAuditStore(database);
  const credentialStore = createCredentialStore(database);
  const agentProfileStore = createAgentProfileStore(
    database,
    new URL("http://agent-bot.test/ag-ui"),
    { store: credentialStore, encryptionKey: config.keyEncryptionKey },
  );
  const approvals = createApprovalRegistry();
  const standing = createStandingApprovalStore();
  const client = computerThatAnswers();
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => PERMISSIVE,
    approvals,
    standing,
  });
  const partners = createPartnerRuntime({
    context: { database, auditStore },
    database,
    alimtalk: null,
  });
  const pluginStore = createPluginStore({
    database,
    auditStore,
    credentials: credentialVaultStub({ readSecret: async () => null }),
    encryptionKey: config.keyEncryptionKey,
    policy: () => PERMISSIVE,
    approvals,
    partnerTransports: partners.transports,
  });
  const threadIdentity = createThreadIdentity(`matrix-${run}`);
  const outbox = createNotificationOutbox({ database, log: () => {} });
  /**
   * A's Bot, answering at once, so `POST /api/routines/:id/run` — which really runs the routine —
   * is a cell and not a five-second wait for a Bot that is not in any roster.
   */
  const instantBot = {
    setMessages() {},
    async runAgent() {
      return {
        result: undefined,
        newMessages: [{ id: "m", role: "assistant", content: "done" }],
      };
    },
  } as unknown as AbstractAgent;
  const routineService = createRoutineService({
    database,
    resolveAgents: async () => ({ [BOT_A]: instantBot }),
  });

  const app = createApp(
    config,
    auth,
    createRoleRepository(database),
    createAuditReader(database),
    createCredentialAdminService(
      config.keyEncryptionKey,
      credentialStore,
      auditStore,
    ),
    createPackageStatusReader(database),
    createOnboardingStore(database),
    // The CopilotKit runtime: not importable from a test. See the file comment.
    undefined,
    client,
    gateway,
    createPolicyStore(PERMISSIVE),
    agentProfileStore,
    createChannelStore(database, agentProfileStore, threadIdentity),
    createChannelEventHub(),
    auditStore,
    createComponentStore(database),
    pluginStore,
    createSandboxedStore(database, auditStore),
    threadIdentity,
    approvals,
    routineService,
    createMessageTimeReader(database),
    createWorkingReader(database),
    standing,
    true,
    createDemonstrationRecorder(),
    undefined,
    createAgentMemoryStore(database),
    undefined,
    undefined,
    undefined,
    {
      exporter: createAccountExport(database),
      deletion: createAccountDeletion({ database }),
      auditStore,
    },
    {
      outbox,
      approvalMetrics: (days) =>
        readApprovalMetrics(database, { days, timeZone: "" }),
    },
    createSiteConnectionStore(database),
    partners,
    createSuggestionDismissalStore(database),
    undefined,
    createConsentStore(database),
    createScreenViewAudit({
      auditStore,
      ownerOf: async (botId) => (await lookupBotOwner(database, botId)) ?? null,
    }),
    {
      feedback: createFeedbackStore(database),
      auditStore,
      outbox,
      diagnostics: createDiagnosticsSource({ database, lines: () => [] }),
      // Mounted as `main.ts` mounts it, so its two routes are pressed by every person below.
      ratings: createAnswerRatingStore(database),
    },
    (days) => readInsights(database, { days, timeZone: "Asia/Seoul" }),
    admission,
  );
  return { app, routineService, approvals };
}

type App = ReturnType<typeof createApp>;
type Person = "anonymous" | "A" | "B" | "admin" | "removed";

/** One cell of the matrix: who, which route, and what came back. */
type Cell = {
  who: Person;
  method: string;
  template: string;
  status: number;
  code?: string;
  /** What a refusal said that was not a code: an `error` or `message` sentence, or plain text. */
  said?: string;
};

let app: App;
let routineService: ReturnType<typeof deployment>["routineService"];
let approvals: ReturnType<typeof deployment>["approvals"];
let routineOfA = "";
/**
 * A question A's Bot is waiting on, raised afresh for every person, so the answering door is pressed
 * on a real question rather than on an id that names nothing: the owner's cell is then an answer
 * given, which is the whole of what that door is for.
 */
let approvalOfA = "";
let matrix: Cell[] = [];

/**
 * Every route the app mounted, once each. `app.routes` holds one entry per handler AND per
 * middleware on a route, so the pairs are deduplicated; the `ALL`-method entries are the `use`
 * middlewares and are not routes anybody can be authorised for on their own.
 */
function mountedRoutes(application: App): Array<[string, string]> {
  const seen = new Set<string>();
  const routes: Array<[string, string]> = [];
  for (const route of application.routes) {
    if (route.method === "ALL") continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push([route.method, route.path]);
  }
  return routes;
}

/** Runs last for each person, and only ever against a throwaway or against nobody. */
const DESTRUCTIVE = new Set([
  "DELETE /api/agents/:agentId",
  "DELETE /api/routines/:id",
  "POST /api/me/delete",
  "POST /api/admin/users/:id/delete",
]);

/**
 * The one door whose Bot travels in the query string, named there so the colleague column presses
 * on it. A skill nobody wrote, so the owner is refused it and the administrator's revoke removes
 * nothing.
 */
const QUERY: Record<string, string> = {
  "DELETE /api/plugins/grants": `?kind=skill&ref=nothing-${run}&agentId=${BOT_A}`,
};

/** What each placeholder in a path becomes. A Bot is always A's; everything else is nobody's. */
function concrete(method: string, template: string): string {
  const bot =
    `${method} ${template}` === "DELETE /api/agents/:agentId"
      ? BOT_A_DOOMED
      : BOT_A;
  return (
    template
      .replace(/:botId|:agentId/g, bot)
      .replace(/:approvalId/g, approvalOfA)
      .replace(/:credentialId/g, NO_SUCH_UUID)
      .replace(/:id(?=\/|$)/g, () =>
        template.startsWith("/api/routines/:id") ? routineOfA : NOBODY,
      )
      .replace(/:kind/g, "click")
      .replace(/:[A-Za-z]+/g, NOBODY)
      .replace(/\*$/, "whatever") + (QUERY[`${method} ${template}`] ?? "")
  );
}

/** The bodies that name a Bot. Anything else is refused on shape before it reaches a store. */
function bodyFor(method: string, template: string): unknown {
  switch (`${method} ${template}`) {
    case "POST /api/routines":
      return {
        agentId: BOT_A,
        name: `matrix ${run}`,
        instruction: "say the time",
        schedule: { kind: "interval", minutes: 30 },
      };
    case "PATCH /api/routines/:id":
      // A rename: the owner's edit lands, and nobody else's reaches the routine at all.
      return { name: `matrix ${run} renamed` };
    case "POST /api/routines/resume":
      // 다시 켜기 on A's Bot: the owner's press resumes what the unread rule paused (nothing, here),
      // and the colleague must be told the Bot is not there.
      return { agentId: BOT_A };
    case "POST /api/components/:name/decision":
      return { agentId: BOT_A };
    case "POST /api/components/:name/call":
      return { agentId: BOT_A, function: "botActivity" };
    case "POST /api/plugins/call":
      // A well-formed ref (`server/tool`) so the call gets as far as asking whose Bot this is; a
      // bare word was refused on shape first, and that refusal carries no code.
      return { ref: `nobody-${run}/nothing`, agentId: BOT_A };
    case "POST /api/plugins/grants":
      // A skill nobody wrote: the owner is told there is no such skill, the administrator grants
      // a name that resolves to nothing, and the colleague must be told the Bot is not there. The
      // one row this writes is on A's Bot and goes with it in `afterAll`.
      return { kind: "skill", ref: `nothing-${run}`, agentId: BOT_A };
    case "POST /api/channels":
      return { agentIds: [BOT_A] };
    case "POST /api/approvals/:botId/:approvalId":
      // A real answer, and a No: it gets as far as the registry for whoever the guard lets through,
      // and it widens nothing on the way.
      return { granted: false };
    case "POST /api/approvals/:botId/:approvalId/hold":
    case "POST /api/approvals/:botId/:approvalId/release":
      // A window's made-up name for itself, so the press reaches the registry (0.5.4 A).
      return { holder: `matrix-window-${run}` };
    case "POST /api/me/first-task":
      // A chip pressed on A's Bot: the owner's press is a row, the colleague's is a Bot not there.
      return {
        agentId: BOT_A,
        kind: "connect",
        pattern: null,
        via: null,
        hint: null,
      };
    default:
      return {};
  }
}

async function press(
  who: Person,
  method: string,
  template: string,
): Promise<Cell> {
  const person =
    who === "A"
      ? A
      : who === "B"
        ? B
        : who === "admin"
          ? ADMIN
          : who === "removed"
            ? REMOVED
            : null;
  const response = await app.request(
    `http://laf.local${concrete(method, template)}`,
    {
      method,
      headers: {
        origin: TRUSTED,
        "content-type": "application/json",
        ...(person ? { cookie: `session=${person.id}` } : {}),
      },
      ...(method === "GET"
        ? {}
        : { body: JSON.stringify(bodyFor(method, template)) }),
    },
    // What Bun hands the app in production: the server, which the channel socket's upgrade asks
    // for. One that refuses to upgrade turns that route into a plain 404 instead of a thrown
    // TypeError, which is the only 500 this harness ever manufactured on its own.
    { server: { upgrade: () => false } },
  );
  const text = await response.text();
  let code: string | undefined;
  let said: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      code?: unknown;
      error?: unknown;
      message?: unknown;
    };
    if (typeof parsed?.code === "string") code = parsed.code;
    said = [parsed?.error, parsed?.message].find(
      (value): value is string =>
        typeof value === "string" && !value.startsWith("laf:"),
    );
  } catch {
    // Not JSON: the connected page, a redirect, or nothing. The status is the fact — unless it is
    // a refusal with words in it, which is a sentence however it was sent.
    if (response.status >= 400 && text.trim()) said = text.slice(0, 80);
  }
  return {
    who,
    method,
    template,
    status: response.status,
    code,
    ...(said === undefined ? {} : { said }),
  };
}

/** The fixture the destructive cells consume, put back so the next person meets the same one. */
async function restore() {
  await database
    .update(agentProfiles)
    .set({ deletedAt: null })
    .where(eq(agentProfiles.agentId, BOT_A_DOOMED));
  // A question for this person to meet, whether or not the last one was answered. The registry is
  // this process's memory, as on a deployment; nothing here reaches the database.
  const question = await approvals.request({
    botId: BOT_A,
    actor: A.id,
    rule: "true",
    subject: A_CLICK,
    fingerprint: `matrix-${randomUUID()}`,
    target: { type: "computer", id: BOT_A },
  });
  approvalOfA = question.id;
  const still = await database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(eq(lafRoutines.id, routineOfA));
  if (still.length === 0) {
    const routine = await routineService.create(A, {
      agentId: BOT_A,
      name: "A's routine",
      instruction: "say the time",
      schedule: { kind: "interval", minutes: 30 },
    });
    routineOfA = routine.id;
  }
}

/** The whole matrix, one person at a time, the colleague first so B's presses change nothing. */
async function measure(): Promise<Cell[]> {
  const routes = mountedRoutes(app).sort(
    ([methodA, pathA], [methodB, pathB]) =>
      Number(DESTRUCTIVE.has(`${methodA} ${pathA}`)) -
        Number(DESTRUCTIVE.has(`${methodB} ${pathB}`)) ||
      pathA.localeCompare(pathB) ||
      methodA.localeCompare(methodB),
  );
  const cells: Cell[] = [];
  for (const who of ["anonymous", "B", "A", "admin", "removed"] as const) {
    await restore();
    for (const [method, template] of routes) {
      cells.push(await press(who, method, template));
    }
  }
  return cells;
}

const keyOf = (cell: Cell) => `${cell.method} ${cell.template}`;
const cellsOf = (who: Person) => matrix.filter((cell) => cell.who === who);
const okCells = (who: Person) =>
  cellsOf(who)
    .filter((cell) => cell.status < 300)
    .map(keyOf)
    .sort();

beforeAll(async () => {
  for (const person of PEOPLE) {
    await database.insert(users).values({
      id: person.id,
      email: `${person.id}@laf.test`,
      name: person.id,
    });
    await database
      .insert(userRoles)
      .values({ userId: person.id, role: person.role });
  }
  await database.insert(agents).values(
    SEEDED_BOTS.map((id) => ({
      id,
      name: id,
      type: "remote_ag_ui" as const,
      configuration: { endpoint: "https://agent-bot.test/ag-ui" },
    })),
  );
  await database.insert(agentProfiles).values(
    (
      [
        [BOT_A, A.id],
        [BOT_SHIPPED, null],
        [BOT_A_DOOMED, A.id],
        [BOT_B, B.id],
      ] as const
    ).map(([agentId, ownerUserId]) => ({
      agentId,
      ownerUserId,
      title: agentId,
      roleDescription: "For the matrix.",
      avatarSeed: agentId,
    })),
  );

  ({ app, routineService, approvals } = deployment());
});

afterAll(async () => {
  await database
    .delete(lafRoutines)
    .where(inArray(lafRoutines.createdById, PEOPLE_IDS));
  // The sweep made a conversation for A and one for the administrator (`POST /api/channels`, 201).
  const rooms = await database
    .select({ id: channelMemberships.channelId })
    .from(channelMemberships)
    .where(inArray(channelMemberships.userId, PEOPLE_IDS));
  if (rooms.length > 0) {
    await database.delete(channels).where(
      inArray(
        channels.id,
        rooms.map((row) => row.id),
      ),
    );
  }
  // And may have made a Bot for each of them. Everything owned by the three goes with the seeded
  // rows, so nothing this file made outlives it.
  const owned = await database
    .select({ id: agentProfiles.agentId })
    .from(agentProfiles)
    .where(inArray(agentProfiles.ownerUserId, PEOPLE_IDS));
  await database
    .delete(agents)
    .where(inArray(agents.id, [...SEEDED_BOTS, ...owned.map((row) => row.id)]));
  await database.delete(users).where(inArray(users.id, PEOPLE_IDS));
  await database.$client.close();
});

/**
 * What nobody signed in may reach, and how it answers. Everything else under `/api` is 401.
 *
 * `/api/auth/*` is the fake auth handler's 204; the real one is proven in `laf-oidc`. The OAuth
 * callback redirects to the connected page with its refusal in the query, because the person who
 * lands there has no session by design (see `plugins/routes.ts`).
 */
const PUBLIC: Record<string, number> = {
  "GET /api/auth/*": 204,
  "POST /api/auth/*": 204,
  "GET /api/auth/providers": 200,
  "GET /api/capabilities": 200,
  "GET /api/health": 200,
  "GET /api/plugins/oauth/callback": 302,
  "GET /api/version": 200,
  "GET /connected": 200,
  "GET /health": 200,
};

/**
 * The 503s, which are a deployment saying it cannot do a thing rather than failing to do it: no
 * partner key, no public URL. Each carries the code the surface owns the words for.
 */
const UNAVAILABLE: Record<string, string> = {
  "POST /api/partners/kakao-alimtalk/code": "laf:kakao-alimtalk_not_configured",
  "POST /api/partners/kakao-alimtalk/connect":
    "laf:kakao-alimtalk_not_configured",
  "POST /api/partners/kakao-alimtalk/refresh":
    "laf:kakao-alimtalk_not_configured",
  "POST /api/plugins/servers/:id/connect": "laf:no_public_url",
};

/**
 * NO 500 IS LEFT, and the list stays so the next one is a decision and not a blind spot.
 *
 * There was one: an administrator revoking a credential id that is not there, where
 * `credentialService.revoke` throws `CredentialUnavailableError` and the inline route in `app.ts`
 * did not map it. The error boundary (`app.onError`) answers it with 404
 * `laf:credential_not_found` now — see `route-error-boundary.integration.test.ts`.
 */
const KNOWN_500: string[] = [];

/**
 * STILL OPEN: the cells a colleague reaches on the owner's Bot, each one a decision written down.
 *
 * NONE. Audit A8's last S2 was `GET /api/plugins/for/:agentId`, which answered a colleague naming
 * the owner's Bot with every tool and skill it held; it lived in a tree another change was in at
 * the time, so it was listed here rather than closed. It is closed now — `requireBotAccess` on it
 * and on `for/:agentId/skills/:slug/view` beside it, `mayDriveBot` on the two grant verbs — and B's
 * list below shrank by one.
 *
 * Kept, empty, as the one place an open cell would have to be written down. The colleague test
 * counts open cells from the measurement, not from the lists, and asserts the count is zero: a cell
 * that opens by accident fails there, and leaving one open on purpose means changing that line in
 * review, with the reason written here.
 */
const STILL_OPEN = new Set<string>();

/** Whether this file names A's Bot to the route: in its path, its body or its query string. */
const namesABot = (cell: Cell) =>
  /:botId|:agentId/.test(cell.template) ||
  JSON.stringify(bodyFor(cell.method, cell.template)).includes(BOT_A) ||
  (QUERY[keyOf(cell)] ?? "").includes(BOT_A);

/**
 * Every route whose path names a Bot and whose door the ownership guard now stands in front of.
 * A colleague gets 404 with the code on each — not 403 (which confirms the Bot), not 200.
 */
const BOT_DOORS = (template: string) =>
  template.startsWith("/api/computers/:botId/") ||
  template.startsWith("/api/approvals/:botId") ||
  template.startsWith("/api/plugins/for/:agentId") ||
  template === "/api/components/for-agent/:agentId";

/**
 * What a signed-in colleague reaches: their own things, the deployment's catalogues, and the
 * reads that are open to any signed-in person by design (`components`, `sandboxed/published`).
 * Nothing here names A's Bot.
 */
const B_ALLOWED = [
  "DELETE /api/plugins/skills/:slug",
  "GET /api/agents",
  "GET /api/agents/working",
  "GET /api/auth/*",
  "GET /api/auth/providers",
  "GET /api/capabilities",
  "GET /api/channels",
  "GET /api/components",
  "GET /api/components/functions",
  "GET /api/connections/overview",
  "GET /api/health",
  "GET /api/me",
  "GET /api/me/export",
  "GET /api/me/notifications",
  "GET /api/partners",
  "GET /api/plugins",
  "GET /api/plugins/connections",
  "GET /api/routines",
  "GET /api/routines/suggestions",
  "GET /api/sandboxed/published",
  "GET /api/sites/connections",
  // What the 문의·의견 box would attach: the asking person's own facts, and the deployment's build and health.
  "GET /api/support/diagnostics",
  "GET /api/version",
  "GET /connected",
  "GET /health",
  "POST /api/agents/test-connection",
  "POST /api/auth/*",
  "POST /api/me/consent",
  "POST /api/me/onboarded",
  "POST /api/plugins/servers/:id/disconnect",
  // The guide was opened: a row about the person who opened it, and nothing about anybody's Bot.
  "POST /api/support/help-opened",
  "POST /api/threads/mint",
].sort();

/** The owner: everything the colleague has, and every door their own Bot's id opens. */
const A_ALLOWED = [
  ...B_ALLOWED,
  "DELETE /api/agents/:agentId",
  "DELETE /api/computers/:botId/demonstration",
  "DELETE /api/routines/:id",
  // The routine's notepad: read and cleared by its person, never written over HTTP.
  "DELETE /api/routines/:id/notepad",
  "GET /api/agents/:agentId",
  "GET /api/agents/:agentId/memories",
  "GET /api/approvals/:botId",
  "GET /api/components/for-agent/:agentId",
  "GET /api/computers/:botId/control",
  "GET /api/computers/:botId/demonstration",
  "GET /api/computers/:botId/read",
  "GET /api/computers/:botId/screenshot",
  "GET /api/computers/:botId/status",
  "GET /api/plugins/for/:agentId",
  "GET /api/routines/:id/notepad",
  "GET /api/routines/:id/runs",
  // Editing it in place: its name, its words, its clock.
  "PATCH /api/routines/:id",
  // 계속 돌리기 on it, and 다시 켜기 on its Bot's routines the unread rule paused.
  "POST /api/routines/:id/keep-running",
  "POST /api/routines/resume",
  "POST /api/agents/:agentId/hide",
  "POST /api/agents/:agentId/unhide",
  // Answering the question their own Bot raised — a No, on a real question. It was an
  // administrator's alone until 2026-09-16, which left a `user`'s Bot asking nobody at all.
  "POST /api/approvals/:botId/:approvalId",
  // Taking their own No back (다시 물어보기): the same person as answering.
  "POST /api/approvals/:botId/:approvalId/reconsider",
  // Which of their windows carries the step on, and a stopped turn closing its question (0.5.4 A).
  "POST /api/approvals/:botId/:approvalId/hold",
  "POST /api/approvals/:botId/:approvalId/release",
  "POST /api/approvals/:botId/:approvalId/withdraw",
  "POST /api/channels",
  "POST /api/components/:name/call",
  "POST /api/components/:name/decision",
  "POST /api/me/first-task",
  "POST /api/computers/:botId/computers/stop",
  "POST /api/computers/:botId/control/release",
  "POST /api/computers/:botId/control/request",
  "POST /api/computers/:botId/control/take",
  "POST /api/computers/:botId/files/list",
  "POST /api/computers/:botId/human/:kind",
  "POST /api/computers/:botId/scroll",
  "POST /api/computers/:botId/snapshot",
  "POST /api/routines",
  "POST /api/routines/:id/enabled",
  "POST /api/routines/:id/run",
].sort();

/**
 * The doors that NAME A's Bot, none of which an administrator reaches any more (2026-09-16).
 *
 * Every cell in this matrix presses `:agentId`/`:botId` against `BOT_A`, which is A's, and the
 * routine cells against the routine driving it. Measured on the rehearsal deployment: the
 * administrator's Bots page listed three Bots, two of them somebody else's, with the titles and
 * roles their owners had written.
 *
 * TWO RULES WENT, IN THAT ORDER. The roster's first — a Bot belongs to the account that made it,
 * and the `public` marking that used to say otherwise is dropped (migration 0042). Then the drive
 * rule, `actorMayDriveBot`, which had kept an administrator exception of its own and is the reason
 * this list doubled: driving somebody's Bot is the stronger half of seeing it. It types into the
 * browser holding their bank and marketplace logins, answers the questions their boundary raises,
 * spends the credentials their tools sit behind, and takes the wheel of a session they are in the
 * middle of. Closing the roster and leaving that open would have been the smaller half of the job.
 *
 * WHAT IS NOT ON THIS LIST IS THE POINT, and it is what an operator still runs a deployment with:
 * every `/api/admin/*` door, the audit table, the approval metrics, the package and status reads,
 * the deployment-wide computer policy (`GET`/`PUT /api/computers/policy`, which names no Bot), and
 * removing a person — which still takes their Bots, their browsers and their logins with them,
 * because `account/deletion.ts` reads `owner_user_id` off the table and asks no predicate at all.
 */
const NAMES_SOMEBODY_ELSES_BOT = [
  // The roster and what hangs off a profile.
  "DELETE /api/agents/:agentId",
  "GET /api/agents/:agentId",
  "GET /api/agents/:agentId/memories",
  "POST /api/agents/:agentId/hide",
  "POST /api/agents/:agentId/unhide",
  // A conversation made around A's Bot, and the intro chip pressed on it: both take the id in a body.
  "POST /api/channels",
  "POST /api/me/first-task",
  // A standing instruction planted on it, and the verbs that manage one.
  "DELETE /api/routines/:id",
  "DELETE /api/routines/:id/notepad",
  "GET /api/routines/:id/notepad",
  "GET /api/routines/:id/runs",
  "PATCH /api/routines/:id",
  "POST /api/routines",
  "POST /api/routines/:id/enabled",
  "POST /api/routines/:id/keep-running",
  "POST /api/routines/:id/run",
  "POST /api/routines/resume",
  // Its browser: what it is looking at, and every way of pressing something in it.
  "DELETE /api/computers/:botId/demonstration",
  "GET /api/computers/:botId/control",
  "GET /api/computers/:botId/demonstration",
  "GET /api/computers/:botId/read",
  "GET /api/computers/:botId/screenshot",
  "GET /api/computers/:botId/status",
  "POST /api/computers/:botId/computers/reset",
  "POST /api/computers/:botId/computers/stop",
  "POST /api/computers/:botId/control/release",
  "POST /api/computers/:botId/control/request",
  "POST /api/computers/:botId/control/take",
  "POST /api/computers/:botId/files/list",
  "POST /api/computers/:botId/human/:kind",
  "POST /api/computers/:botId/scroll",
  "POST /api/computers/:botId/snapshot",
  // The questions its boundary raised — reading them and answering them — and what it may spend.
  "GET /api/approvals/:botId",
  "POST /api/approvals/:botId/:approvalId",
  "POST /api/approvals/:botId/:approvalId/reconsider",
  "POST /api/approvals/:botId/:approvalId/hold",
  "POST /api/approvals/:botId/:approvalId/release",
  "POST /api/approvals/:botId/:approvalId/withdraw",
  "DELETE /api/plugins/grants",
  "POST /api/plugins/grants",
  "GET /api/plugins/for/:agentId",
  "GET /api/components/for-agent/:agentId",
  "POST /api/components/:name/call",
  "POST /api/components/:name/decision",
];

/** The administrator: what anybody has on their own Bots, and the deployment's own doors. */
const ADMIN_ALLOWED = [
  ...A_ALLOWED,
  "DELETE /api/components/:name/functions/:function",
  "DELETE /api/plugins/servers/:id",
  "DELETE /api/sandboxed/:name",
  "GET /api/admin/audit-events",
  "GET /api/admin/credentials",
  "GET /api/admin/metrics/approvals",
  "GET /api/admin/package",
  "GET /api/admin/status",
  "GET /api/approvals/standing",
  // The Computers page's list: what the deployment's one browser holds, at an address that names no
  // Bot (2026-09-16 — it was `computers/:botId/computers`, pressed with a Bot id nobody has).
  "GET /api/computers",
  "GET /api/computers/policy",
  "GET /api/sandboxed",
  "PUT /api/computers/policy",
]
  // Applied to the WHOLE list, not only to A's half: two of the administrator's own doors take a
  // Bot id too (the computer's reset, and the grant verbs), and a Bot id that is not theirs closes
  // those exactly like the rest.
  .filter((cell) => !NAMES_SOMEBODY_ELSES_BOT.includes(cell))
  .sort();

describe("the matrix", () => {
  /*
   * The measurement is a test rather than a hook so it can have its own clock: four people over
   * every route is several hundred requests, a few of which really do something (a routine runs,
   * a Bot is made), and the default five seconds a hook gets is not a bound anybody chose.
   */
  test("is measured: every route, by every person", async () => {
    matrix = await measure();
    if (process.env.LAF_MATRIX_DUMP) {
      const lines = matrix.map(
        (cell) =>
          `${cell.who.padEnd(9)} ${cell.status} ${keyOf(cell)}${cell.code ? `  [${cell.code}]` : ""}`,
      );
      console.log(`\n${mountedRoutes(app).length} routes\n${lines.join("\n")}`);
    }
    expect(matrix.length).toBeGreaterThan(0);
  }, 60_000);

  test("covers the routes the audit counted, from the app itself", () => {
    // 142 on the day it was written. A floor rather than an equality, in the spirit of the
    // test-ci floors: a route removed on purpose lowers it with a reason; one lost by accident
    // — a mount that silently stopped — fails here.
    expect(mountedRoutes(app).length).toBeGreaterThanOrEqual(140);
    expect(matrix).toHaveLength(mountedRoutes(app).length * 5);
  });

  test("nothing answers 500 but the one named, and the 503s are the deliberate ones", () => {
    expect(
      matrix
        .filter((cell) => cell.status === 500)
        .map((cell) => `${cell.who} ${keyOf(cell)}`),
    ).toEqual(KNOWN_500);
    const unavailable = matrix.filter((cell) => cell.status === 503);
    for (const cell of unavailable) {
      expect([keyOf(cell), cell.code]).toEqual([
        keyOf(cell),
        UNAVAILABLE[keyOf(cell)],
      ]);
    }
    // And never for somebody who is not signed in: 401 comes before "cannot".
    expect(unavailable.filter((cell) => cell.who === "anonymous")).toEqual([]);
  });

  /*
   * EVERY REFUSAL IS A FACT, ON THE WIRE — the live half of `error-codes.test.ts`, which reads the
   * source. Until 2026-09-14 the anonymous column alone was 142 cells of
   * `{"error":"Authentication required."}`, and the colleague and owner columns held the plugin and
   * component routes' own sentences, while the source walk looked at six directories and said none.
   */
  test("every refusal any of the four is given carries a code and no sentence", () => {
    const refusals = matrix.filter((cell) => cell.status >= 400);
    expect(refusals.length).toBeGreaterThan(300);
    expect(
      refusals
        .filter((cell) => !cell.code?.startsWith("laf:") || cell.said)
        .map(
          (cell) =>
            `${cell.who} ${cell.status} ${keyOf(cell)} ${cell.code ?? "-"} ${cell.said ?? ""}`,
        ),
    ).toEqual([]);
  });

  test("nobody signed in reaches nothing but the public routes", () => {
    const reached = Object.fromEntries(
      cellsOf("anonymous")
        .filter((cell) => cell.status !== 401)
        .map((cell) => [keyOf(cell), cell.status]),
    );
    expect(reached).toEqual(PUBLIC);
  });

  /*
   * THE COLUMN THAT DID NOT EXIST: a person struck off the sign-in list, who still holds a session and
   * an administrator's role. Measured on 2026-09-14 before the guard asked: `GET /api/me` 200 on the
   * old cookie, and a renewal on every use. Now the column is the anonymous column cell for cell,
   * except that every door the session guard stands at says why — the session was taken away.
   */
  test("somebody struck off the sign-in list reaches exactly what nobody signed in reaches, and is told why", () => {
    const anonymous = new Map(
      cellsOf("anonymous").map((cell) => [keyOf(cell), cell]),
    );
    const removed = cellsOf("removed");
    expect(removed).toHaveLength(anonymous.size);
    const differing = removed
      .filter((cell) => {
        const nobody = anonymous.get(keyOf(cell));
        const expected =
          nobody?.code === "laf:unauthenticated"
            ? { status: 401, code: SESSION_REVOKED }
            : { status: nobody?.status, code: nobody?.code };
        return cell.status !== expected.status || cell.code !== expected.code;
      })
      .map((cell) => `${cell.status} ${keyOf(cell)} ${cell.code ?? "-"}`);
    expect(differing).toEqual([]);
    // Most doors are the session guard's, so this is not a column of public routes passing trivially.
    expect(
      removed.filter((cell) => cell.code === SESSION_REVOKED).length,
    ).toBeGreaterThan(120);
    expect(okCells("removed")).toEqual(
      Object.entries(PUBLIC)
        .filter(([, status]) => status < 300)
        .map(([key]) => key)
        .sort(),
    );
  });

  /*
   * THE COLUMN THE AUDIT FOUND OPEN.
   *
   * Measured before this file: screenshot 200 and 6,387 bytes, `read`/`control`/`take` 200, the
   * approval list 200, the component grants 200, a routine 201 with a trigger token. Each of those
   * is a 404 now, with the code, and B's 2xx cells are exactly the ones a colleague should have.
   */
  test("a colleague naming the owner's Bot is told it is not there, on every door", () => {
    const doors = cellsOf("B").filter((cell) => BOT_DOORS(cell.template));
    expect(doors.length).toBeGreaterThanOrEqual(30);
    for (const cell of doors) {
      expect([keyOf(cell), cell.status, cell.code]).toEqual([
        keyOf(cell),
        404,
        "laf:bot_not_found",
      ]);
    }
    // The doors a body — or, for the grant revoke, a query — opens.
    for (const template of [
      "POST /api/routines",
      "POST /api/routines/resume",
      "POST /api/components/:name/decision",
      "POST /api/components/:name/call",
      "POST /api/plugins/call",
      "POST /api/plugins/grants",
      "DELETE /api/plugins/grants",
    ]) {
      const cell = cellsOf("B").find(
        (candidate) => keyOf(candidate) === template,
      );
      expect([template, cell?.status, cell?.code]).toEqual([
        template,
        404,
        "laf:bot_not_found",
      ]);
    }
    /*
     * A first-task press names its Bot in the body too, and asks the roster rather than the drive
     * rule — a press is a fact about a Bot the person can see, not an act through it — so the
     * colleague is told what `GET /api/agents/:agentId` tells them: the same 404, the roster's code.
     */
    const press = cellsOf("B").find(
      (candidate) => keyOf(candidate) === "POST /api/me/first-task",
    );
    expect([press?.status, press?.code]).toEqual([404, "laf:agent_not_found"]);
  });

  test("the fleet's door opens for nobody holding a session, an administrator included", () => {
    for (const who of ["anonymous", "B", "A", "admin"] as const) {
      const cell = cellsOf(who).find(
        (candidate) => keyOf(candidate) === "GET /api/admin/metrics/insights",
      );
      expect([who, cell?.status, cell?.code]).toEqual([
        who,
        401,
        "laf:fleet_token_refused",
      ]);
    }
  });

  test("a colleague reaches exactly these, and none of them names the owner's Bot", () => {
    expect(okCells("B")).toEqual(B_ALLOWED);
    // Counted from the measurement rather than read off the list above, and counting the Bots a
    // body or a query names as well as a path: every cell B reached with A's Bot in the request.
    const open = cellsOf("B")
      .filter((cell) => cell.status < 300 && namesABot(cell))
      .map(keyOf)
      .sort();
    expect(open).toEqual([...STILL_OPEN].sort());
    expect(open).toHaveLength(0);
  });

  test("the owner reaches exactly these", () => {
    expect(okCells("A")).toEqual(A_ALLOWED);
  });

  test("an administrator reaches exactly these", () => {
    expect(okCells("admin")).toEqual(ADMIN_ALLOWED);
  });

  /**
   * THE SCREEN THE OWNER MEASURED, read the way the Bots page reads it.
   *
   * Every other assertion here is about a status code, and a status code is what was already
   * right: `GET /api/agents` answered the administrator 200 both before and after. What was wrong
   * was the BODY — three Bots, all marked private, two of them somebody else's, with the titles and
   * roles their owners had written. So this one presses the door and reads what came back.
   */
  test("the administrator's Bots page carries no Bot of somebody else's", async () => {
    const response = await app.request("http://laf.local/api/agents", {
      headers: { cookie: `session=${ADMIN.id}` },
    });
    const body = (await response.json()) as {
      agents: Array<{ id: string; mine: boolean }>;
    };
    const listed = body.agents.map((agent) => agent.id);

    expect(response.status).toBe(200);
    /*
     * MEASURED: before the change this page carried all four seeded profiles — BOT_A, BOT_A_DOOMED
     * and BOT_B are A's and B's, and the administrator owns none of them and nothing else either.
     * It now carries the Bot the deployment ships and nothing else, which is a filter rather than
     * an empty page. (BOT_NOBODYS has no profile row and has never been on this list.)
     */
    expect(listed).toEqual([BOT_SHIPPED]);
    // `mine` stays honest on the row that survives: on a roster, visible is not owned.
    expect(body.agents[0]).toMatchObject({ mine: false });
  });

  test("and B's page carries their own Bot and the shipped one, and nothing of A's", async () => {
    const response = await app.request("http://laf.local/api/agents", {
      headers: { cookie: `session=${B.id}` },
    });
    const { agents: listed } = (await response.json()) as {
      agents: Array<{ id: string; mine: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(listed.map((agent) => agent.id).sort()).toEqual(
      [BOT_B, BOT_SHIPPED].sort(),
    );
    expect(listed.find((agent) => agent.id === BOT_B)?.mine).toBe(true);
    expect(listed.find((agent) => agent.id === BOT_SHIPPED)?.mine).toBe(false);
  });

  /**
   * The operational screens, named one at a time rather than left to the list above.
   *
   * An administrator still has to be able to account for what ran on the deployment and to remove
   * a person who is leaving. Closing what they may see AND what they may drive must not take any
   * of that with it, and a list of sixty sorted strings is not where a reader would notice if it
   * had. Every door here names no Bot: they are about the deployment, which is what the role is.
   */
  test("keeps every door an administrator operates the deployment through", () => {
    for (const template of [
      "GET /api/admin/audit-events",
      "GET /api/admin/credentials",
      "GET /api/admin/metrics/approvals",
      "GET /api/admin/package",
      "GET /api/admin/status",
      "GET /api/approvals/standing",
      // What the deployment's one browser holds, which the Computers page lists and resets from.
      "GET /api/computers",
      // The gateway's rules for the whole deployment — read and changed while it runs.
      "GET /api/computers/policy",
      "PUT /api/computers/policy",
    ]) {
      const cell = cellsOf("admin").find(
        (candidate) => keyOf(candidate) === template,
      );
      expect([template, (cell?.status ?? 0) < 400]).toEqual([template, true]);
    }
    /*
     * Removing a person is pressed against an id that names nobody (it is destructive, and the
     * sweep has only these four people), so what it can show here is that the administrator gets
     * past the guard and is told the person is not there — not the 403 of a door closed to them.
     * That the removal really does take a person's Bots with it, browsers included, is measured
     * against the real tables in `account-lifecycle.integration.test.ts`.
     */
    const removal = cellsOf("admin").find(
      (candidate) => keyOf(candidate) === "POST /api/admin/users/:id/delete",
    );
    expect(removal?.status).toBe(404);
  });

  /**
   * And the doors that reach INTO a Bot are shut, with the same 404 the colleague gets.
   *
   * These are the twenty-three that closed when `actorMayDriveBot` lost its administrator
   * exception. A 404 and not a 403: which of "not yours" and "not here" it is would itself be a
   * fact about somebody else's roster.
   */
  test("and shuts every door that reaches into a Bot that is not theirs", () => {
    for (const template of [
      "GET /api/computers/:botId/read",
      "GET /api/computers/:botId/screenshot",
      "POST /api/computers/:botId/scroll",
      "POST /api/computers/:botId/control/take",
      "POST /api/computers/:botId/computers/reset",
      "GET /api/approvals/:botId",
      "POST /api/plugins/grants",
      "GET /api/plugins/for/:agentId",
      "POST /api/components/:name/call",
    ]) {
      const admin = cellsOf("admin").find(
        (candidate) => keyOf(candidate) === template,
      );
      const colleague = cellsOf("B").find(
        (candidate) => keyOf(candidate) === template,
      );
      // The same answer as the colleague's, which is the whole of what changed.
      expect([template, admin?.status, admin?.code]).toEqual([
        template,
        colleague?.status,
        colleague?.code,
      ]);
      expect(admin?.status).toBe(404);
    }
  });

  /**
   * And the trail still says which Bot, which is the whole use of it.
   *
   * The audit reader reads `audit_events` and joins nothing, so it was never going to inherit the
   * roster's rule — but "the administrator can no longer see that Bot" and "the administrator can
   * no longer account for what that Bot did" are one careless join apart, and only one of them is
   * what the owner asked for. An id, never a title.
   */
  test("the audit table still names a private Bot's id, and never its title", async () => {
    await createAuditStore(database).insert({
      eventType: "computer.action_failed",
      targetType: "agent",
      targetId: BOT_A,
      payload: { reason: "for the matrix" },
    });

    const response = await app.request(
      "http://laf.local/api/admin/audit-events?limit=100",
      { headers: { cookie: `session=${ADMIN.id}` } },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(BOT_A);
    // `title` on A's private Bot is its id (the fixture above), so the assertion that would pass
    // by accident is asserted against the roleDescription every seeded profile carries instead.
    expect(body).not.toContain("For the matrix.");
  });

  test("the owner is refused the administrator's doors with 403, not with the Bot's 404", () => {
    // Their own Bot exists and they know it; what they lack is the role. The order of the two
    // guards decides which answer they get, and it must not leak the other way round for B.
    // One such door is left: resetting empties the browser profile EVERY Bot on the deployment
    // signs in through, which is not one Bot's business even when the Bot on the row is yours.
    for (const template of ["POST /api/computers/:botId/computers/reset"]) {
      const owner = cellsOf("A").find((cell) => keyOf(cell) === template);
      const colleague = cellsOf("B").find((cell) => keyOf(cell) === template);
      expect([template, owner?.status, colleague?.status]).toEqual([
        template,
        403,
        404,
      ]);
    }
  });

  /*
   * THE COMPUTERS PAGE'S LIST, ONE PERSON AT A TIME (audit R3-04, R5-02).
   *
   * The page asked `GET /api/computers/shared/computers`; `shared` is no Bot's id, and once the
   * ownership guard lost its administrator exception that was 404 `laf:bot_not_found` for the
   * administrator too — a load error, no rows, and no Reset button. The list names no Bot now, so
   * the only question in front of it is the role, and the administrator here owns no Bot at all.
   */
  test("the Computers page's list names no Bot: 401 signed out, 403 without the role, 200 for the administrator", () => {
    const cell = (who: Person) =>
      cellsOf(who).find(
        (candidate) => keyOf(candidate) === "GET /api/computers",
      );
    expect([cell("anonymous")?.status, cell("anonymous")?.code]).toEqual([
      401,
      "laf:unauthenticated",
    ]);
    expect([cell("removed")?.status, cell("removed")?.code]).toEqual([
      401,
      SESSION_REVOKED,
    ]);
    for (const who of ["A", "B"] as const) {
      expect([who, cell(who)?.status, cell(who)?.code]).toEqual([
        who,
        403,
        "laf:admin_required",
      ]);
    }
    expect(cell("admin")?.status).toBe(200);
    // And the old address is not a door any more, for anybody.
    expect(
      matrix.filter(
        (candidate) =>
          candidate.template.startsWith("/api/computers/:botId/computers") &&
          candidate.method === "GET",
      ),
    ).toEqual([]);
  });

  /*
   * ANSWERING IS THE OWNER'S, AND ONLY THE OWNER'S (audit R1-02, R3-06, R5-06).
   *
   * It needed ownership AND the administrator's role, so A — the owner, with the `user` role — was
   * told 403 about their own Bot's question, and the administrator 404: nobody on the deployment
   * could answer it, and every ask on it ran out its ten minutes. The same predicate every other
   * door a Bot id opens asks is the whole of the rule now.
   */
  test("the owner answers their own Bot's question; the colleague and the administrator are told it is not there", () => {
    const template = "POST /api/approvals/:botId/:approvalId";
    const cell = (who: Person) =>
      cellsOf(who).find((candidate) => keyOf(candidate) === template);
    expect(cell("A")?.status).toBe(200);
    for (const who of ["B", "admin"] as const) {
      expect([who, cell(who)?.status, cell(who)?.code]).toEqual([
        who,
        404,
        "laf:bot_not_found",
      ]);
    }
  });
});

describe("the live screen, against the real tables", () => {
  const whose = (botId: string) => lookupBotOwner(database, botId);

  /**
   * SEEING AND DRIVING NOW AGREE, and this socket is the clearest case for why they had to.
   *
   * It carries live frames of somebody's browser out and their keystrokes in, mid-task, with that
   * person's logins loaded. An administrator exception survived here after the roster was closed,
   * on the argument that an approval on a deployment should still be answerable; the owner's rule
   * is about the account rather than about the list, so it went too (2026-09-16). What an operator
   * does about a Bot of somebody else's that is stuck is written down in `auth/guards.ts`: read
   * the trail, and if it comes to it, remove the person — which takes their Bots with them.
   */
  test("opens for the owner, and for nobody else — an administrator included", async () => {
    await expect(streamBotAccess(BOT_A, A, whose)).resolves.toBe("allowed");
    await expect(streamBotAccess(BOT_A, ADMIN, whose)).resolves.toBe(
      "not_found",
    );
  });

  test("a colleague may not open it, and neither may an administrator", async () => {
    // The hole this pair exists for: `agentProfileStore.get` let a `public` Bot through to anybody
    // signed in, and the socket their keystrokes travel down opened on it. Whose a Bot is is never
    // read from a roster, and the answer no longer depends on a role at all.
    await expect(streamBotAccess(BOT_A, B, whose)).resolves.toBe("not_found");
    await expect(streamBotAccess(BOT_B, A, whose)).resolves.toBe("not_found");
    await expect(streamBotAccess(BOT_B, ADMIN, whose)).resolves.toBe(
      "not_found",
    );
  });

  test("a Bot the deployment ships is every signed-in person's to drive", async () => {
    for (const person of [A, B, ADMIN]) {
      await expect(streamBotAccess(BOT_SHIPPED, person, whose)).resolves.toBe(
        "allowed",
      );
    }
  });

  test("a Bot nobody made is every signed-in person's", async () => {
    await expect(streamBotAccess(BOT_NOBODYS, B, whose)).resolves.toBe(
      "allowed",
    );
  });

  test("a Bot that is not there, or is deleted, is not there for anybody", async () => {
    await expect(streamBotAccess(`agent_ghost_${run}`, A, whose)).resolves.toBe(
      "not_found",
    );
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, BOT_A_DOOMED));
    await expect(streamBotAccess(BOT_A_DOOMED, A, whose)).resolves.toBe(
      "not_found",
    );
  });
});
