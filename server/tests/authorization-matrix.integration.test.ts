/**
 * THE AUTHORIZATION MATRIX: every route this server mounts, driven by four people.
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
 *     widening anywhere in the server is a diff in this file.
 *
 * The stores behind the routes are the real ones on the test database wherever the constructor
 * takes a database; the computer is a fake that answers everything, because the question here is
 * who may reach it, not what it does. Nothing under `/api/copilotkit` is mounted: the runtime
 * cannot be imported from a test (see `createApp`), and its guard has its own file
 * (`copilot-guard.test.ts`).
 *
 * Bodies name A's Bot wherever a body names a Bot, so the colleague column presses on the
 * body-borne doors (`routines`, `components/:name/decision|call`, `plugins/call`, `channels`) as
 * well as the path-borne ones. Everything else is sent an empty object, which every route refuses
 * without writing anything — and the routes that destroy something are pointed at a throwaway Bot,
 * at A's routine, or at nobody, run last, and the fixture is put back before the next person.
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
import { createCoworkerCall } from "../src/agents/coworker-call";
import { createAgentMemoryStore } from "../src/agents/memory-store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createAuditReader, createAuditStore } from "../src/audit";
import type { AuthService } from "../src/auth/guards";
import { createRoleRepository, lookupBotOwner } from "../src/auth/guards";
import { createOnboardingStore } from "../src/auth/onboarding";
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
import { createThreadMessageReader } from "../src/rooms/messages";
import { RoomError } from "../src/rooms/service";
import { createRoutineService } from "../src/routines/service";
import { createSuggestionDismissalStore } from "../src/routines/suggestions";
import { createMessageTimeReader } from "../src/runner/message-times";
import { createWorkingReader } from "../src/runner/working";
import { createFeedbackStore } from "../src/support/feedback";
import { createPackageStatusReader } from "../src/tenant-package";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const TRUSTED = "https://matrix.agent.laf-co.test";
const config = loadConfig(
  testEnvironment({ TRUSTED_ORIGINS: `${TRUSTED},http://localhost:3000` }),
);

/** One suffix per run, so two gates on one database never see each other's rows. */
const run = randomUUID().slice(0, 8);

/** The four people. A and B are ordinary users with a Bot each; the administrator owns nothing. */
const A = { id: `matrix-a-${run}`, role: "user" as const };
const B = { id: `matrix-b-${run}`, role: "user" as const };
const ADMIN = { id: `matrix-admin-${run}`, role: "admin" as const };
const PEOPLE = [A, B, ADMIN];
const PEOPLE_IDS = PEOPLE.map((person) => person.id);

/** A's Bots: the one every cell names, one marked public, one for the delete cell to consume. */
const BOT_A = `agent_a_${run}`;
const BOT_A_PUBLIC = `agent_apub_${run}`;
const BOT_A_DOOMED = `agent_adel_${run}`;
const BOT_B = `agent_b_${run}`;
/** An `agents` row with no profile: a Bot nobody made, which the rule says is everybody's. */
const BOT_NOBODYS = `agent_nobody_${run}`;
const SEEDED_BOTS = [BOT_A, BOT_A_PUBLIC, BOT_A_DOOMED, BOT_B, BOT_NOBODYS];

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
        ? { user: { id: person.id, email: `${person.id}@laf.test` } }
        : null;
    },
  },
};

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
    environment: {},
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
  /** The real room service refuses a room the person is not in the same way; see `roomOf`. */
  const noSuchRoom = () => {
    throw new RoomError("There is no such room.", 404);
  };

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
    createCoworkerCall({ resolveAgents: async () => ({}), auditStore }),
    routineService,
    createMessageTimeReader(database),
    createWorkingReader(database),
    { post: async () => noSuchRoom(), stop: async () => noSuchRoom() },
    createThreadMessageReader(database),
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
    { feedback: createFeedbackStore(database), auditStore, outbox },
  );
  return { app, routineService };
}

type App = ReturnType<typeof createApp>;
type Person = "anonymous" | "A" | "B" | "admin";

/** One cell of the matrix: who, which route, and what came back. */
type Cell = {
  who: Person;
  method: string;
  template: string;
  status: number;
  code?: string;
};

let app: App;
let routineService: ReturnType<typeof deployment>["routineService"];
let routineOfA = "";
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

/** What each placeholder in a path becomes. A Bot is always A's; everything else is nobody's. */
function concrete(method: string, template: string): string {
  const bot =
    `${method} ${template}` === "DELETE /api/agents/:agentId"
      ? BOT_A_DOOMED
      : BOT_A;
  return template
    .replace(/:botId|:agentId/g, bot)
    .replace(/:credentialId/g, NO_SUCH_UUID)
    .replace(/:id(?=\/|$)/g, () =>
      template.startsWith("/api/routines/:id") ? routineOfA : NOBODY,
    )
    .replace(/:kind/g, "click")
    .replace(/:[A-Za-z]+/g, NOBODY)
    .replace(/\*$/, "whatever");
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
    case "POST /api/components/:name/decision":
      return { agentId: BOT_A };
    case "POST /api/components/:name/call":
      return { agentId: BOT_A, function: "botActivity" };
    case "POST /api/plugins/call":
      return { ref: "x", agentId: BOT_A };
    case "POST /api/channels":
      return { agentIds: [BOT_A] };
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
    who === "A" ? A : who === "B" ? B : who === "admin" ? ADMIN : null;
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
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    if (typeof parsed?.code === "string") code = parsed.code;
  } catch {
    // Not JSON: the connected page, a redirect, or nothing. The status is the fact.
  }
  return { who, method, template, status: response.status, code };
}

/** The fixture the destructive cells consume, put back so the next person meets the same one. */
async function restore() {
  await database
    .update(agentProfiles)
    .set({ deletedAt: null })
    .where(eq(agentProfiles.agentId, BOT_A_DOOMED));
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
  for (const who of ["anonymous", "B", "A", "admin"] as const) {
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
        [BOT_A, A.id, "private"],
        [BOT_A_PUBLIC, A.id, "public"],
        [BOT_A_DOOMED, A.id, "private"],
        [BOT_B, B.id, "private"],
      ] as const
    ).map(([agentId, ownerUserId, visibility]) => ({
      agentId,
      ownerUserId,
      title: agentId,
      roleDescription: "For the matrix.",
      avatarSeed: agentId,
      visibility,
    })),
  );

  ({ app, routineService } = deployment());
});

afterAll(async () => {
  await database
    .delete(lafRoutines)
    .where(inArray(lafRoutines.createdById, PEOPLE_IDS));
  // The sweep made a room for A and one for the administrator (`POST /api/channels`, 201).
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
  // And duplicated a Bot for each of them. Everything owned by the three goes with the seeded
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
 * THE ONE 500 LEFT, named so it is a decision and not a blind spot.
 *
 * An administrator revoking a credential id that is not there: `credentialService.revoke` throws
 * `CredentialUnavailableError` (`missing_or_revoked`) and the inline route in `app.ts` does not
 * map it, so Hono answers 500. Administrator-only — A and B get 403 in front of it — so it is a
 * robustness fault and not an authorization one, and it lives in a file the change that wrote this
 * matrix was told to leave to another. The fix is a 404 for that error in the route (or in the
 * service), and then removing this entry.
 */
const KNOWN_500 = ["admin POST /api/admin/credentials/:credentialId/revoke"];

/**
 * STILL OPEN: `GET /api/plugins/for/:agentId` answers a colleague about the owner's Bot.
 *
 * Audit A8's last S2. It lives in `plugins/routes.ts`, which the change that closed every other
 * door was told not to touch (another change was in that tree at the same time), and the store's
 * own `actorMayDriveBot` sits one call away. Listed here so the cell is a decision and not an
 * oversight: closing it is `requireBotAccess("agentId")` on that route and on
 * `for/:agentId/skills/:slug/view` beside it, and then removing this entry — at which point B's
 * list below shrinks by one and this file says so.
 */
const STILL_OPEN = new Set(["GET /api/plugins/for/:agentId"]);

/**
 * Every route whose path names a Bot and whose door the ownership guard now stands in front of.
 * A colleague gets 404 with the code on each — not 403 (which confirms the Bot), not 200.
 */
const BOT_DOORS = (template: string) =>
  template.startsWith("/api/computers/:botId/") ||
  template.startsWith("/api/approvals/:botId") ||
  template === "/api/components/for-agent/:agentId";

/**
 * What a signed-in colleague reaches: their own things, the deployment's catalogues, and the
 * reads that are open to any signed-in person by design (`components`, `sandboxed/published`).
 * Nothing here names A's Bot except the one cell `STILL_OPEN` explains.
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
  "GET /api/plugins/for/:agentId",
  "GET /api/routines",
  "GET /api/routines/suggestions",
  "GET /api/sandboxed/published",
  "GET /api/sites/connections",
  "GET /api/version",
  "GET /connected",
  "GET /health",
  "POST /api/agents/test-connection",
  "POST /api/auth/*",
  "POST /api/me/consent",
  "POST /api/me/onboarded",
  "POST /api/plugins/servers/:id/disconnect",
  "POST /api/threads/mint",
].sort();

/** The owner: everything the colleague has, and every door their own Bot's id opens. */
const A_ALLOWED = [
  ...B_ALLOWED,
  "DELETE /api/agents/:agentId",
  "DELETE /api/computers/:botId/demonstration",
  "DELETE /api/routines/:id",
  "GET /api/agents/:agentId",
  "GET /api/agents/:agentId/memories",
  "GET /api/approvals/:botId",
  "GET /api/components/for-agent/:agentId",
  "GET /api/computers/:botId/control",
  "GET /api/computers/:botId/demonstration",
  "GET /api/computers/:botId/read",
  "GET /api/computers/:botId/screenshot",
  "GET /api/computers/:botId/status",
  "GET /api/routines/:id/runs",
  "POST /api/agents/:agentId/duplicate",
  "POST /api/agents/:agentId/hide",
  "POST /api/agents/:agentId/unhide",
  "POST /api/channels",
  "POST /api/components/:name/call",
  "POST /api/components/:name/decision",
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

/** The administrator: everything the owner has on the owner's Bot, and the deployment's own. */
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
  "GET /api/computers/:botId/computers",
  "GET /api/computers/policy",
  "GET /api/sandboxed",
  "POST /api/computers/:botId/computers/reset",
  "PUT /api/computers/policy",
].sort();

describe("the matrix", () => {
  /*
   * The measurement is a test rather than a hook so it can have its own clock: four people over
   * every route is several hundred requests, a few of which really do something (a routine runs,
   * a Bot is duplicated), and the default five seconds a hook gets is not a bound anybody chose.
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
    expect(matrix).toHaveLength(mountedRoutes(app).length * 4);
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

  test("nobody signed in reaches nothing but the public routes", () => {
    const reached = Object.fromEntries(
      cellsOf("anonymous")
        .filter((cell) => cell.status !== 401)
        .map((cell) => [keyOf(cell), cell.status]),
    );
    expect(reached).toEqual(PUBLIC);
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
    // The doors a body opens.
    for (const template of [
      "POST /api/routines",
      "POST /api/components/:name/decision",
      "POST /api/components/:name/call",
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
  });

  test("a colleague reaches exactly these", () => {
    expect(okCells("B")).toEqual(B_ALLOWED);
    // And, structurally: nothing that names a Bot, save what STILL_OPEN explains.
    expect(
      B_ALLOWED.filter(
        (cell) =>
          (cell.includes(":botId") || cell.includes(":agentId")) &&
          !STILL_OPEN.has(cell),
      ),
    ).toEqual([]);
  });

  test("the owner reaches exactly these", () => {
    expect(okCells("A")).toEqual(A_ALLOWED);
  });

  test("an administrator reaches exactly these", () => {
    expect(okCells("admin")).toEqual(ADMIN_ALLOWED);
  });

  test("the owner is refused the administrator's doors with 403, not with the Bot's 404", () => {
    // Their own Bot exists and they know it; what they lack is the role. The order of the two
    // guards decides which answer they get, and it must not leak the other way round for B.
    for (const template of [
      "GET /api/computers/:botId/computers",
      "POST /api/computers/:botId/computers/reset",
      "POST /api/approvals/:botId/:approvalId",
    ]) {
      const owner = cellsOf("A").find((cell) => keyOf(cell) === template);
      const colleague = cellsOf("B").find((cell) => keyOf(cell) === template);
      expect([template, owner?.status, colleague?.status]).toEqual([
        template,
        403,
        404,
      ]);
    }
  });
});

describe("the live screen, against the real tables", () => {
  const whose = (botId: string) => lookupBotOwner(database, botId);

  test("opens for the owner and for an administrator, on a private Bot and a public one", async () => {
    for (const bot of [BOT_A, BOT_A_PUBLIC]) {
      await expect(streamBotAccess(bot, A, whose)).resolves.toBe("allowed");
      await expect(streamBotAccess(bot, ADMIN, whose)).resolves.toBe("allowed");
    }
  });

  test("a colleague may not open it, and a public Bot does not change that", async () => {
    // The hole: `agentProfileStore.get` let a `public` Bot through to anybody signed in, and the
    // socket their keystrokes travel down opened on it. Whose it is never reads visibility.
    await expect(streamBotAccess(BOT_A, B, whose)).resolves.toBe("not_found");
    await expect(streamBotAccess(BOT_A_PUBLIC, B, whose)).resolves.toBe(
      "not_found",
    );
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
