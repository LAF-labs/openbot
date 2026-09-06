import "./telemetry-off";
import { serve } from "bun";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAccountDeletion } from "./account/deletion";
import { createAccountExport } from "./account/export";
import { createRetentionJob, retentionDays } from "./account/retention";
import { createCoworkerCall } from "./agents/coworker-call";
import { withGrantedSkills } from "./agents/granted-skills";
import { createAgentMemoryStore } from "./agents/memory-store";
import { createAgentProfileStore } from "./agents/profile-store";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { createApp } from "./app";
import {
  createAuditReader,
  createAuditStore,
  ONE_SHARED_COMPUTER,
  recordAuditEvent,
} from "./audit";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import { createRoleRepository } from "./auth/guards";
import { createOnboardingStore } from "./auth/onboarding";
import { ORIGIN_REFUSED, upgradeOriginAllowed } from "./auth/origin";
import type { UserRole } from "./auth/roles";
import { streamBotAccess } from "./auth/stream-access";
import { createChannelEventHub } from "./channels/events";
import { createChannelStore } from "./channels/routes";
import { websocket as channelSocket } from "./channels/socket";
import { createStallGuard } from "./channels/stall-guard";
import { createThreadIdentity } from "./channels/thread-identity";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createApprovalRegistry } from "./computer/approvals";
import {
  createAutoReviewProbe,
  createModelAutoReviewer,
  type ReviewSubject,
} from "./computer/auto-review";
import { createComputerClient } from "./computer/client";
import { createDemonstrationRecorder } from "./computer/demonstration";
import { createComputerGateway } from "./computer/gateway";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import { createRepeatDetector } from "./computer/repeat";
import { createSiteConnectionStore } from "./computer/site-connections";
import { createResultSpill } from "./computer/spillover";
import { createDatabaseStandingApprovalStore } from "./computer/standing-approvals";
import { createWriteUp } from "./computer/write-up";
import { loadConfig } from "./config";
import {
  botTimeZone,
  type IdentifyActor,
  mountCopilotRuntime,
  resolveRuntimeAgents,
} from "./copilot";
import {
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import { agentProfiles, users } from "./db/schema";
import { createFleetNotifier } from "./fleet/notify";
import { createAlimtalkAdapter } from "./notifications/alimtalk";
import { readApprovalMetrics } from "./notifications/approval-metrics";
import { withOutboxWatch } from "./notifications/from-audit";
import {
  createFinishedNotice,
  createSocketAdapter,
} from "./notifications/in-app";
import {
  createWebhookAdapter,
  withApprovalNotifications,
} from "./notifications/notify";
import { createNotificationOutbox } from "./notifications/outbox";
import { redirectUriFor } from "./plugins/oauth";
import { createPartnerRuntime } from "./plugins/partners";
import { createPublicDataRuntime } from "./plugins/public-data-rest";
import { lookupOver } from "./plugins/shared-clients";
import { allLiveBots } from "./plugins/skills-and-grants";
import { createPluginStore } from "./plugins/store";
import { createThreadMessageReader } from "./rooms/messages";
import { createRoomService } from "./rooms/service";
import { createApprovalWaiter } from "./rooms/wait-for-approval";
import {
  appendToSoloConversation,
  createRoutineDelivery,
} from "./routines/deliver";
import { createRoutineService } from "./routines/service";
import { createSuggestionDismissalStore } from "./routines/suggestions";
import { createBotLane } from "./runner/bot-lane";
import { LafPostgresRunner } from "./runner/laf-runner";
import { createMessageTimeReader } from "./runner/message-times";
import { createRunLedger } from "./runner/run-ledger";
import { createUnattendedTools } from "./runner/unattended";
import { createWorkingReader } from "./runner/working";
import {
  createPackageStatusReader,
  loadTenantPackage,
  recordTenantPackage,
} from "./tenant-package";

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: UserRole;
}> {
  if (config.devNoAuth) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A CopilotKit run requires a signed-in user.");
  }
  const roles = await roleRepository.rolesForUser(user.id);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A CopilotKit run requires an authorized user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roles.includes("admin") ? "admin" : "user",
  };
}

/*
 * `identifyUser` — the name-and-id projection of the resolver above — is gone. Its one caller was
 * the live-screen upgrade, which needed the ROLE it dropped in order to ask whose Bot was being
 * watched. `resolveRequestActor` is called there directly now, and there was nothing else a
 * name-without-a-role was for.
 */

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * THE FALLBACK IS NOT THE GUARD AND NEVER WAS. It used to be justified by `/info` answering an
 * anonymous deployment check; `/api/copilotkit/*` is behind `requireUser` now (app.ts), so no
 * unauthenticated request reaches this at all. What is left is the transient case — a session read
 * or a role lookup failing under an authenticated request — and it is kept here, and only here,
 * because this one runs INSIDE the vendored runtime's agent factory: throwing there takes the run
 * down with a 500, while resolving to somebody who owns nothing takes it down by name. It grants
 * nothing — no private profile matches, and it is not an administrator — and the two places that
 * decide whose data is served (the live-screen upgrade and the thread priming below) refuse instead.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const config = loadConfig();
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const database = createDatabase(config.databaseUrl);
/*
 * The boot audit store, built first because the runner tees model usage into it.
 *
 * Not awaited and never fatal anywhere it is used: a deployment must not fail to start because
 * its audit trail is unavailable.
 */
const bootAuditStore = createAuditStore(database);
/**
 * The fleet tool, which created this machine and is the only thing that can destroy it.
 *
 * Built next to the audit store because that is the only thing it needs, and before `createAuth`
 * and the account routes, which are the two places a person arrives and leaves.
 *
 * The absence is announced. A deployment with no fleet webhook is correct on a laptop and wrong on
 * a VM, and the wrongness is invisible from every surface: a withdrawal completes, the person is
 * told their account is gone, and the machine keeps running and keeps being paid for because
 * nothing outside this process ever heard. So it says so once, at boot, where an operator reading
 * the logs of a deployment that is behaving perfectly can still see it.
 */
const fleetNotifier = config.fleet
  ? createFleetNotifier({ ...config.fleet, auditStore: bootAuditStore })
  : undefined;
if (!fleetNotifier) {
  console.info(
    JSON.stringify({
      type: "fleet-webhook",
      configured: false,
      note: "LAF_FLEET_WEBHOOK_URL is unset. Sign-ups and withdrawals on this deployment reach nothing: a person who leaves is gone from here and the machine outlives them.",
    }),
  );
}
// One ledger for every run path — chat, routine, room, handoff — so the roster reads one table and
// one module writes it. Built before the runner because the runner opens its rows through it.
const runLedger = createRunLedger(database);
// The durable runner every turn goes through. Built before the app because construction adjudicates
// the runs the last process left open; it reads no conversation until one is asked for.
const lafRunner = await LafPostgresRunner.create(
  database,
  runLedger,
  bootAuditStore,
);
await initializeDevActorUser(database, config.devNoAuth);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
/** What each Bot has learned about each person, and the rows that let them undo it. */
const agentMemoryStore = createAgentMemoryStore(database);

const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgentAgUiUrl,
  agentVault,
);
// Read here rather than beside the row it writes below, because the package names the deployment
// and the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(tenantPackage.tenantId);
/**
 * Every socket open on this server, and the one thing that fans an event out to them.
 *
 * Built before the writers because they are handed it: activity is announced in this process once
 * the write that earned it has committed, rather than through Postgres LISTEN/NOTIFY and a
 * connection of its own. There is one process (docs/laf/deployment-model.md), so there was never a
 * second instance for the carrier to reach.
 */
const channelEvents = createChannelEventHub();
/**
 * The partner vendor LAF holds the account at, assembled once.
 *
 * BEFORE THE OUTBOX AND BEFORE THE PLUGIN STORE, because both take something from it: the AlimTalk
 * door needs to know whose channel to send as, and the store needs the transport for the catalogue
 * entry whose tools are this repository's own code. Built here rather than inside the store because
 * the partner modules import the store's refusal class — see `plugins/partners.ts`.
 *
 * A VM with no key configured gets an object with nothing in it, no cards and no tools, which is a
 * correct deployment. `config.partners` refused to start on half of one.
 */
const partnerRuntime = createPartnerRuntime({
  context: { database, auditStore: bootAuditStore },
  database,
});
console.info(
  JSON.stringify({
    type: "partner-connectors",
    alimtalk: config.partners.alimtalk,
  }),
);
/**
 * The public data the fleet holds one key for, assembled once, from the key `config` already read.
 *
 * Nothing per person: a VM with the key offers 나라장터 and 기업마당 to every Bot on it from boot
 * (the reconciliation runs below, beside the retention sweep), and a VM without it has no entry.
 * Said at boot, like the partner line above, so an operator reading the log knows which it is.
 */
const publicDataRuntime = createPublicDataRuntime({
  keys: config.connectors.keys,
  listBots: () => allLiveBots(database),
});
console.info(
  JSON.stringify({
    type: "public-data",
    dataGoKr: publicDataRuntime.configured,
  }),
);
/**
 * One outbox for "somebody has to be told", and every door it goes out through.
 *
 * Built here, before anything that raises a notification, because there is exactly one of these and
 * the things that write into it — a boundary opening a question, a Bot asking for a password, a
 * routine finishing at seven in the morning — are spread across the process. Three doors:
 *
 *   socket    the page itself, when somebody is connected. The common case, and the fast one.
 *   webhook   `LAF_NOTIFY_WEBHOOK_URL`, unchanged in what it sends but now carrying the row's id.
 *   alimtalk  the phone in the owner's hand, once they have connected their own 카카오톡 채널 and
 *             카카오 has approved LAF's template under it. Until then it declines honestly and the
 *             row stays undelivered for the other two.
 *
 * The socket goes first because it is the only door that is free and instantaneous, and the order
 * is otherwise cosmetic — they are offered the row together (see `outbox.ts`).
 */
const notificationOutbox = createNotificationOutbox({
  database,
  adapters: [
    createSocketAdapter(channelEvents),
    ...(process.env.LAF_NOTIFY_WEBHOOK_URL
      ? [createWebhookAdapter(process.env.LAF_NOTIFY_WEBHOOK_URL)]
      : []),
    createAlimtalkAdapter({ partners: partnerRuntime.connections }),
  ],
});
/** A routine or a room turn that finished while nobody was connected to hear it. See in-app.ts. */
const noticeFinished = createFinishedNotice(channelEvents, notificationOutbox);
const channelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
  (event) => channelEvents.deliver(event),
);
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
const roleRepository = createRoleRepository(database);
// What each Bot IS, then what skills it holds — by name and one line, for the prompt's index.
const loadAgentsForActor = withGrantedSkills(
  createRuntimeAgentLoader(database, agentVault),
  database,
);
await recordTenantPackage(database, tenantPackage);
const auth = config.auth
  ? createAuth(config, database, fleetNotifier)
  : undefined;
// Every Bot of an account shares the one computer at `baseUrl` — the account's desk, by decision
// (see computer/assignment.ts).
const computerClient = config.computer
  ? createComputerClient({
      baseUrl: config.computer.baseUrl,
      allowPrivateHosts: config.computer.allowPrivateHosts,
      ...(config.computer.token ? { token: config.computer.token } : {}),
    })
  : undefined;
/*
 * Long tool results go on file on the Bot's computer and reach the model as a preview and a
 * path (computer/spillover.ts). One for the process, because what is already on file is
 * remembered here; handed to every run path through the same middleware the prompt goes through.
 * No computer, nothing to file: the transcript goes as it always did.
 */
const resultSpill = computerClient
  ? createResultSpill(computerClient)
  : undefined;
// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

/**
 * The one place a Bot's unanswered questions live.
 *
 * Built here rather than inside either thing that raises them, because a deployment has one of
 * these and two things that ask: a Bot meeting an `ask` rule on a button and the same Bot meeting
 * one on a tool call are the same interruption to the same person, and a registry per subsystem
 * would mean the surface somebody happens to be looking at decides which of them they can answer.
 */
// The buzz on "blocked on you" goes through the outbox above, which writes the
// row and then offers it to every door. Absent all of them, the question still
// waits on the surface.
//
// A Map in this process, which is where a pending question belongs: one process
// per VM by decision (docs/laf/deployment-model.md), a question is about a live
// browser session and a live turn, and a restart is an honest withdrawal of it.
// It is also what lets the room be TOLD an answer instead of asking every second
// — see `waitFor`.
//
// `onExpire` is the one ending of a question that writes no row anywhere else:
// ten minutes with nobody answering. It is what makes "the notification was
// never delivered" and "somebody said no" different facts in the list.
const approvals = withApprovalNotifications(
  createApprovalRegistry({
    onExpire: (approval) => {
      void notificationOutbox
        .enqueue({
          kind: "approval.expired",
          botId: approval.botId,
          userId: approval.actor,
          approvalId: approval.id,
          subject: approval.subject,
        })
        .catch(() => undefined);
    },
  }),
  { outbox: notificationOutbox },
);

/**
 * The allowances, in the database, because an allowance whose whole point is to outlive the turn
 * must outlive the process too. See `standing-approvals.ts`.
 */
const standingApprovals = createDatabaseStandingApprovalStore(database);

/**
 * ONE COUNT OF A BOT GOING ROUND IN CIRCLES, not one per subsystem.
 *
 * Built here rather than inside the gateway for the same reason the approval registry is: a Bot
 * clicking the same button thirty times and a Bot calling the same tool on somebody else's server
 * thirty times are the same Bot stuck, and a detector each would mean the shipped
 * `repeat.count >= 5` rule counted only whichever half of its work the deployment happened to be
 * watching. A Map in this process, which is the whole count on one process per VM
 * (docs/laf/deployment-model.md); the window is configurable for a slow provider.
 */
const repeatDetector = createRepeatDetector(
  config.computer?.repeatWindowMs
    ? { windowMs: config.computer.repeatWindowMs }
    : {},
);

/**
 * What somebody did while showing a Bot how a task is done.
 *
 * In this process because that is where the socket is: a demonstration belongs to one person
 * driving one browser, and both ends of that live here. It names each press by asking the computer
 * what is at the point, which is the whole difference between a trace worth writing up and a list
 * of coordinates. See `demonstration.ts`.
 */
const demonstrations = createDemonstrationRecorder({
  namePoint: async (botId, point) => {
    if (!config.computer) return null;
    const response = await fetch(
      `${config.computer.baseUrl.replace(/\/$/, "")}/describe-point`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          /*
           * THE HEADER, NOT A QUERY. `agent-computer` reads the Bot from `x-openbot-bot-id` and
           * falls back to a default when it is absent — so a query string is not a different Bot,
           * it is silently the wrong one. Measured: every press came back unnameable, because every
           * lookup was asking about a blank page belonging to nobody.
           */
          "x-openbot-bot-id": botId,
          ...(config.computer.token
            ? { authorization: `Bearer ${config.computer.token}` }
            : {}),
        },
        body: JSON.stringify(point),
        // A name is a nicety. A lookup that hangs must not sit in a map for the rest of the session.
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      element?: { role?: unknown; name?: unknown } | null;
    };
    const element = body.element;
    return element &&
      typeof element.role === "string" &&
      typeof element.name === "string"
      ? { role: element.role, name: element.name }
      : null;
  },
});

/**
 * The owner's own sentence about what not to be asked, judged against one action.
 *
 * Given to the gateway as one function, so the gateway knows nothing about where an instruction is
 * kept or how it is judged. Read per action rather than cached: it is edited on a screen, and an
 * edit that took effect on the next restart would be a boundary somebody believes they tightened.
 *
 * `OPENAI_BASE_URL` is where everything else in this deployment reaches a model, and the key is
 * resolved per call for the same reason the runtime's is — revoking a credential then takes effect
 * on the next action rather than on the next restart.
 */
/**
 * Server-side model calls land in the same ledger as Bot turns, tagged by purpose.
 *
 * The per-Bot monthly cost is a sum over `model.usage` rows; a deployment whose auto-review burns
 * tokens invisibly would undercount its own KPI. Counts only, never content.
 */
const recordModelUsage =
  (source: "auto-review" | "write-up") =>
  (usage: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }) => {
    void recordAuditEvent(bootAuditStore, {
      eventType: "model.usage",
      targetType: "model",
      payload: { ...usage, source },
    }).catch(() => undefined);
  };

/** Everything the judge and the probe both need, so the probe measures the real call. */
const reviewCall = {
  baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
  model: tenantPackage.model.reviewModel,
  apiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: tenantPackage.model.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
  // The deployment's own assertion that its model reasons, which is what decides whether an effort
  // is sent at all. See `model.yaml supports_effort`, and the note in auto-review.ts.
  supportsEffort: tenantPackage.model.supportsEffort,
};

const reviewModel = createModelAutoReviewer({
  ...reviewCall,
  onUsage: recordModelUsage("auto-review"),
});

/**
 * Whether this deployment can auto-review at all, measured rather than assumed.
 *
 * Started here so the answer is usually already in hand by the time a browser asks, and not awaited:
 * a probe that could delay the port opening would make a model having a bad minute into a deployment
 * that does not boot. Its cost is one trivial completion per process. See `createAutoReviewProbe`.
 */
const autoReviewCapable = createAutoReviewProbe({
  ...reviewCall,
  onUsage: recordModelUsage("auto-review"),
});
void autoReviewCapable().catch(() => false);

/**
 * A finished recording, written up as a procedure.
 *
 * The deployment's own model rather than the review one: this runs once, with the person watching
 * and knowing they asked for it, so a slow careful answer is the right trade — the opposite of the
 * judgement that sits in front of every action a Bot takes.
 */
const writeUpDemonstration = createWriteUp({
  baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
  model: tenantPackage.model.defaultModel,
  apiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: tenantPackage.model.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
  onUsage: recordModelUsage("write-up"),
});

const autoReviewFor = async (botId: string, subject: ReviewSubject) => {
  const [row] = await database
    .select({ instruction: agentProfiles.autoReview })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, botId));
  // No row and no instruction are the same answer: there is nothing to judge, so a person is asked.
  return row?.instruction ? reviewModel(row.instruction, subject) : null;
};

/**
 * Where vendors send people back after a consent, derived from the one public URL every real
 * deployment already declares. No new fleet configuration: BETTER_AUTH_URL is required wherever
 * sign-in works, and sign-in is required wherever plugins are reachable.
 */
const pluginPublicUrl = config.auth?.baseUrl;

/**
 * The OAuth applications LAF registered once for the whole fleet, as one lookup.
 *
 * Resolved here and handed to both halves that need it — the store, which spends a refresh token,
 * and the connect routes, which decide what a person is even offered. Reading the environment again
 * inside either of them would be the same decision made in two places, and the one that drifts is
 * always the one nothing renders.
 */
const sharedOAuthClients = lookupOver(config.connectors.clients);

const pluginStore = createPluginStore({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
  approvals,
  standing: standingApprovals,
  // The same instruction, the same counter and the same registry the computer gets. A boundary that
  // held for a click and not for a call to somebody else's server was one boundary written twice.
  autoReview: autoReviewFor,
  repeat: repeatDetector,
  /*
   * Needed to (re)register a dynamic OAuth client (RFC 7591). Absent when the deployment has no
   * public URL, and self-registration then simply does not happen — registering a redirect URI
   * that resolves to nothing would leave behind a client that can never complete a consent flow.
   */
  redirectUri: pluginPublicUrl ? redirectUriFor(pluginPublicUrl) : undefined,
  // The vault holds no client for a shared-application entry and never will, so a refresh that
  // looked only there would report "connect it again" at a connection nothing is wrong with.
  sharedClient: sharedOAuthClients,
  // The two entries whose tools are this repository's own code, for the vendors this VM has keys
  // for. Empty leaves both entries unreachable rather than falling back to MCP — see `store.ts`.
  partnerTransports: partnerRuntime.transports,
  // The same again for the public-data entry, on the fleet's data.go.kr key.
  deploymentKeyTransports: publicDataRuntime.transports,
});

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 * Not awaited and never fatal: the row is a note for a reader, not something the server depends on.
 */
void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record that every Bot shares the account's one computer.
 *
 * The sharing is a product decision (computer/assignment.ts), not an accident of configuration,
 * but it must still be visible in the trail rather than inferred: sessions, files and logins are
 * common to the roster, and a reader of the audit log has to be told that.
 */
void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  payload: {
    isolation: "one shared computer",
    /*
     * A code. This was a 200-character English paragraph, on the one row whose entire content is a
     * sentence — and the audit page drew no `note` at all, so the arrangement this row exists to
     * state was legible only to somebody reading the database. The surface says it in Korean now,
     * and draws it.
     */
    note: ONE_SHARED_COMPUTER,
  },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    isolation: "one shared computer",
  }),
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because the Bot goes on writing for as long
 * as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  auditStore: bootAuditStore,
});

/**
 * The only path to an acting call.
 *
 * Built here rather than inline in `createApp`'s arguments because it has a second caller now: an
 * unattended run executes a Bot's tools through this exact object, so a routine's click is judged
 * by the same policy, written to the same audit trail and held for the same approvals as one
 * somebody watched.
 */
/**
 * Which business sites this person has signed into on a Bot's browser.
 *
 * Built before the gateway because the gateway writes through it: every navigation that lands on a
 * catalogue host reports what it saw, which is the only thing that can tell somebody in September
 * that the login they did in March has expired.
 */
const siteConnections = createSiteConnectionStore(database);

const computerGateway = computerClient
  ? createComputerGateway({
      client: computerClient,
      /*
       * The trail, with one ear on it.
       *
       * `computer_request_help` and `computer_request_secret` are the two moments a Bot stops for a
       * person WITHOUT going through the approval registry, so neither reaches the buzz on
       * `request`. Both already write a row here, on exactly the right occasions and holding
       * exactly the right two ids, so the row is the seam — see notifications/from-audit.ts. The
       * gateway goes on knowing nothing about notifications.
       */
      auditStore: withOutboxWatch(bootAuditStore, notificationOutbox),
      // Read on every decision rather than captured once, so a rule an administrator adds while the
      // server is running applies to the very next action instead of after a restart.
      policy: () => policyStore.get(),
      approvals,
      standing: standingApprovals,
      autoReview: autoReviewFor,
      repeat: repeatDetector,
      /*
       * Bookkeeping on the success path of somebody's actual work, so it swallows its own failures
       * — the same discipline the outbox states: a card losing its freshness is a small loss, a
       * routine failing because a card could not be updated is not a trade anybody would make.
       */
      siteSeen: (seen) => {
        void siteConnections.record(seen).catch(() => undefined);
      },
    })
  : undefined;

// One Bot asking another: the same loader, model and keys the runtime uses, resolved per call so
// a revoked key or a deleted coworker takes effect on the next question rather than on restart.
const coworkerCall = createCoworkerCall({
  resolveAgents: (actor) =>
    resolveRuntimeAgents(
      () => loadAgentsForActor(actor),
      tenantPackage.model,
      stallGuard,
      botTimeZone(),
      resultSpill,
    ),
  auditStore: bootAuditStore,
  ledger: runLedger,
  /**
   * The answering Bot's own copy of what it was asked, written where that person reads it.
   *
   * The names are looked up rather than passed through, because the heading is what a person sees
   * and an id is not a name. Both Bots are in this person's roster by construction — the call
   * resolved the target from it — and `get` is scoped to the actor, so a Bot they cannot see is a
   * Bot this cannot name.
   */
  recordExchange: async (exchange) => {
    const actor = { id: exchange.actorId, role: "user" as const };
    const [caller, target] = await Promise.all([
      agentProfileStore.get(actor, exchange.callerId).catch(() => null),
      agentProfileStore.get(actor, exchange.targetId).catch(() => null),
    ]);
    await appendToSoloConversation(database, {
      agentId: exchange.targetId,
      userId: exchange.actorId,
      // Two names and an arrow: a fact, not a sentence. See appendToSoloConversation.
      heading: `${caller?.name ?? exchange.callerId} → ${target?.name ?? exchange.targetId}`,
      // The question quoted line by line, so a multi-line ask stays one block rather than
      // becoming a quote and then loose prose.
      body: `${exchange.question
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n${exchange.answer}`,
      at: exchange.at,
    });
  },
});

/**
 * One thing at a time per Bot, shared by everything that drives one server-side.
 *
 * An account has ONE virtual computer and its Bots share it, so a routine firing at seven and a
 * room turn asking the same Bot a question would drive one browser at once — each one's snapshot
 * going stale under the other. This is the queue that stops that, and it has to be one queue: two
 * services each serialising against themselves would not see each other at all.
 */
const botLane = createBotLane();

/** The same agents, keys and model every server-side run path resolves. */
const resolveAgentsFor = (actor: { id: string; role: "admin" | "user" }) =>
  resolveRuntimeAgents(
    () => loadAgentsForActor(actor),
    tenantPackage.model,
    stallGuard,
    botTimeZone(),
    resultSpill,
  );

// Instructions on a clock, running through the same server-side path a coworker answer does.
const routineService = createRoutineService({
  database,
  resolveAgents: (actor) =>
    resolveRuntimeAgents(
      () => loadAgentsForActor(actor),
      tenantPackage.model,
      stallGuard,
      botTimeZone(),
      resultSpill,
    ),
  auditStore: bootAuditStore,
  ledger: runLedger,
  lane: botLane,
  // And the answer lands in the Bot's own conversation, where a person already reads — plus a
  // notification when there is nobody connected to read it, which for a routine is the normal case.
  deliver: createRoutineDelivery(database, (event) => {
    channelEvents.deliver(event);
    noticeFinished(event);
  }),
  // The Bot's tools, on the server, through the same gateway and grants the browser uses.
  tools: createUnattendedTools({
    ...(computerGateway ? { gateway: computerGateway } : {}),
    pluginStore,
  }),
});

/**
 * The runtime's own thread routes, with the thread they are about to answer for read first.
 *
 * CopilotKit's local thread endpoints reach the runner through SYNCHRONOUS methods —
 * `getThreadMessages` returns a `Message[]`, and the handler maps it straight into a `Response` —
 * so a read that has to reach Postgres cannot happen inside them. The runner used to sidestep that
 * by loading every thread in the deployment at boot and answering from memory. This is the
 * alternative: one read, for the one thread this request names, taken here where awaiting is
 * allowed. `/threads` itself takes a summary read that touches no message body.
 */
/**
 * Who the priming middlewares below are reading for, or a refusal.
 *
 * `resolveRequestActor` rather than `identifyActor`: this is the read that decides WHOSE thread is
 * about to be served, and the anonymous fallback would answer that question with an actor who owns
 * nothing — which reads as "not yours" for a person whose session simply could not be checked. The
 * routes are already behind `requireUser` (see app.ts), so an unauthenticated caller never arrives;
 * this is the transient case, and it is refused rather than guessed at.
 */
const primingActor = async (request: Request): Promise<{ id: string } | null> =>
  resolveRequestActor(request).catch(() => null);

const copilotEndpoint = new Hono()
  .use("/api/copilotkit/threads", async (context, next) => {
    if (context.req.method === "GET") {
      const actor = await primingActor(context.req.raw);
      if (!actor) return context.json({ error: "laf:unauthenticated" }, 401);
      await lafRunner.primeThreadList(actor.id);
    }
    return next();
  })
  .use("/api/copilotkit/threads/:threadId/*", async (context, next) => {
    const actor = await primingActor(context.req.raw);
    if (!actor) return context.json({ error: "laf:unauthenticated" }, 401);
    /*
     * REFUSED HERE, not merely left unprimed.
     *
     * `getThreadMessages` reads the vendored runner's live copy as well as the primed one, and that
     * copy is a process-wide singleton — so a thread of somebody else's that has been run on this
     * VM since boot would be answered out of memory however carefully this middleware declined to
     * prime it. The request has to stop.
     */
    const mine = await lafRunner.prime(context.req.param("threadId"), actor.id);
    if (!mine) return context.json({ error: "laf:thread_not_found" }, 404);
    return next();
  })
  .route(
    "/",
    mountCopilotRuntime(
      tenantPackage.model,
      loadAgentsForActor,
      identifyActor,
      stallGuard,
      lafRunner,
      "/api/copilotkit",
      resultSpill,
    ),
  );

const app = createApp(
  config,
  auth,
  roleRepository,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  createOnboardingStore(database),
  copilotEndpoint,
  computerClient,
  computerGateway,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
  // Where a person answers what the boundary stopped to ask, whichever half of the product asked.
  approvals,
  // One Bot asking another, over the same loader and keys the runtime itself uses.
  coworkerCall,
  routineService,
  // When each message was first seen. Read from the snapshot column directly — see message-times.
  createMessageTimeReader(database),
  // What is running for a person right now, from the same ledger chat and routines both write.
  createWorkingReader(database),
  /*
   * A room's turn, run here rather than in the browser. Every dependency is the one a routine
   * already uses — the same agents, the same tools, the same ledger, the same lane — so a Bot in a
   * room is governed exactly as a Bot on a schedule is.
   */
  createRoomService({
    database,
    lane: botLane,
    ledger: runLedger,
    resolveAgents: resolveAgentsFor,
    tools: createUnattendedTools({
      ...(computerGateway ? { gateway: computerGateway } : {}),
      pluginStore,
    }),
    emit: (frame) => channelEvents.deliverRoom(frame),
    // The roster row on every OTHER tab, after the message that moved it has committed — and a
    // notification for a member who has no tab at all. See `createFinishedNotice`.
    announce: (event) => {
      channelEvents.deliver(event);
      noticeFinished(event);
    },
    // A room holds while the person answers, because in a room the person is there. See the module.
    awaitApproval: createApprovalWaiter(approvals),
    // Each member's turn on the trail: which round, why it spoke, what came of it.
    auditStore: bootAuditStore,
  }),
  createThreadMessageReader(database),
  standingApprovals,
  tenantPackage.model.supportsEffort,
  demonstrations,
  writeUpDemonstration,
  agentMemoryStore,
  /*
   * The OAuth connect flow: where vendors send people back, and whether the person a consent was
   * started for still has access when the callback lands. This fork has no removal ledger, so
   * "still has access" is what sign-in itself would answer: the user row exists, and the address
   * is still on the allow-list when one is configured.
   */
  pluginPublicUrl
    ? {
        publicUrl: pluginPublicUrl,
        appUrl: config.auth?.trustedOrigins[0],
        encryptionKey: config.keyEncryptionKey,
        personHasAccess: async (userId: string) => {
          const [person] = await database
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (!person) return false;
          const allowed = config.auth?.allowedEmails ?? [];
          return allowed.length === 0 || allowed.includes(person.email);
        },
        sharedClient: sharedOAuthClients,
        /*
         * The fleet's relay, when this deployment is on one. Absent on a laptop, and then every
         * vendor is told this deployment's own callback — which is what a client registered against
         * `http://localhost:3001` expects and the only thing that can work there.
         */
        ...(config.connectors.relay
          ? {
              relay: {
                url: config.connectors.relay.url,
                slug: config.connectors.relay.slug,
              },
            }
          : {}),
      }
    : undefined,
  // Whether the "do not ask me about" control is drawn at all. Measured against this deployment's
  // own review model; see the probe above.
  autoReviewCapable,
  /*
   * What `/health` asks. The three things a deployment is made of, each answered by the same route
   * the product itself uses, so a check cannot pass against a path nothing else takes.
   *
   * The computer is included only when one is configured: a deployment without it is not degraded,
   * it is a deployment without a browser.
   */
  {
    database: async () => {
      await database.execute(sql`select 1`);
      return true;
    },
    agentBot: async () => {
      const response = await fetch(
        new URL("/health", config.managedAgentAgUiUrl),
        // Its own bound as well as the route's: the route stops waiting after two seconds, but only
        // this stops the socket, and a health poll every ten seconds must not leave one behind.
        { signal: AbortSignal.timeout(2_000) },
      );
      return response.ok;
    },
    ...(computerClient
      ? {
          computer: async () =>
            // The id is a label on the answer, not a route: `status` asks the computer's own
            // /health, which belongs to no Bot.
            (await computerClient.status("health")).state === "ready",
        }
      : {}),
  },
  /*
   * Taking your data with you, and leaving.
   *
   * The plugin store's own retirement is passed rather than reimplemented — it revokes each
   * `mcp_user_token` through the vault and writes the disconnection rows, and it finds the
   * credential by `key_id` rather than through a join table that has already cascaded away.
   *
   * The computer is passed for the same reason it is passed to the gateway: a Bot's browser profile
   * is a directory of somebody's logins, and no row deletion touches it.
   *
   * And the fleet, because leaving has one consequence this process cannot carry out: the machine
   * itself. Absent, the withdrawal is complete here and nowhere else — see the boot line above.
   */
  {
    exporter: createAccountExport(database),
    deletion: createAccountDeletion({
      database,
      retireConnectionsFor: pluginStore.retireConnectionsFor,
      // The 발신프로필, before the row it hangs off goes. See the field's note.
      retirePartnersFor: partnerRuntime.connections.retireFor,
      ...(computerClient ? { computerClient } : {}),
      ...(fleetNotifier ? { fleet: fleetNotifier } : {}),
    }),
    auditStore: bootAuditStore,
  },
  /*
   * What is waiting for a person, and how long answers take.
   *
   * The metric reads the trail rather than the outbox on purpose (see approval-metrics.ts), and it
   * is resolved per request rather than captured, so the window a caller asks for is the window it
   * measures. `BOT_TIME_ZONE` decides what "night" is, the same clock the Bot's own browser and
   * prompt are given — the VM may be anywhere and the person is in Korea.
   */
  {
    outbox: notificationOutbox,
    approvalMetrics: (days: number) =>
      readApprovalMetrics(database, {
        days,
        timeZone: process.env.BOT_TIME_ZONE ?? "",
      }),
  },
  // Which business sites this person has signed into on a Bot's browser. The same store the
  // gateway writes through above, so the card and the morning routine agree about one row.
  siteConnections,
  // 알림톡: the vendor LAF holds the account at. The same runtime the outbox's AlimTalk door and
  // the plugin store's transports were built from, so one connect is one fact.
  partnerRuntime,
  // The 다음에 latch behind the routine suggestion cards. See routines/suggestions.ts.
  createSuggestionDismissalStore(database),
  // The public-data entry: hidden from the catalogue without the key, and handed to a Bot the
  // moment it is made with it. Built above, so the listing and the boot reconciliation agree.
  publicDataRuntime,
);

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
const toStreamUrl = (baseUrl: string, botId: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header for the
  // computer to read and every call it serves is per Bot. The secret travels the same way and for the
  // same reason, this socket is the one a person can type into, so it is the last thing that should
  // be reachable without it.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(config.computer?.token ?? "")}`;

/**
 * A refusal from the upgrade path, as a fact code and nothing else.
 *
 * Written by hand because an upgrade is handled in `fetch`, ahead of Hono, so `context.json` is not
 * available here. Same shape as every other refusal in this server: a code the surface owns the
 * words for, never a sentence meant for a screen.
 */
const fact = (code: string, status: number) =>
  new Response(JSON.stringify({ error: code, code }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 */
const streamPathBotId = (pathname: string): string | null => {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/** The rule, with this deployment's roster behind it. See auth/stream-access.ts. */
const streamAccessFor = (
  botId: string,
  actor: { id: string; role: UserRole } | null,
) =>
  streamBotAccess(botId, actor, (person, id) =>
    agentProfileStore.get(person, id),
  );

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = {
  upstream: string;
  inward?: WebSocket;
  /**
   * Which Bot's browser this socket drives.
   *
   * Carried so a demonstration can be recorded from the messages passing through. The proxy is
   * otherwise byte-for-byte and has no reason to know — see the `message` handler for the one line
   * that reads it, and `demonstration.ts` for why that line is where teaching happens.
   */
  botId: string;
};

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

serve<SocketData>({
  port,
  /*
   * Bun's default cuts a connection that has been quiet for ten seconds, which is shorter than a
   * model thinking. A Bot's run streams over SSE and a coworker being asked answers over one long
   * POST; both sit silent while the model works, and the default was killing them mid-thought —
   * the browser saw a spinner that never resolved and the trail saw nothing at all. Four minutes
   * comfortably clears the coworker answer timeout (90s) and the stall guard, which are the layers
   * that are actually supposed to decide when a run has died.
   */
  idleTimeout: 240,
  async fetch(request, server) {
    const url = new URL(request.url);
    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!config.computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      /*
       * Where the socket was opened from, checked before anything else and before the session.
       *
       * This is the socket a person's clicks and keystrokes travel down, into a browser holding
       * their real logins. It checked nothing but the cookie — and every deployment of this product
       * is a name under one registrable domain, so `SameSite=Lax` sends that cookie on a socket
       * opened from another customer's page. An upgrade with no `Origin` at all is refused too: a
       * browser always sends one on a handshake, and nothing but a browser drives this.
       */
      if (!upgradeOriginAllowed(request.headers, config.trustedOrigins)) {
        return fact(ORIGIN_REFUSED, 403);
      }
      /*
       * The session guard AND the Bot, applied by hand because middleware does not run on an
       * upgrade. The person was already resolved here and the answer was thrown away — see
       * `streamBotAllowed`, which is the whole check now.
       */
      const actor = await resolveRequestActor(request).catch(() => null);
      const access = await streamAccessFor(streamBotId, actor);
      if (access === "bad_id") {
        return fact("laf:bot_id_invalid", 400);
      }
      if (access === "unauthenticated") {
        return fact("laf:unauthenticated", 401);
      }
      if (access === "not_found") {
        return fact("laf:bot_not_found", 404);
      }
      let upstream: string;
      try {
        upstream = toStreamUrl(config.computer.baseUrl, streamBotId);
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That Bot's computer could not be reached.",
          { status: 502 },
        );
      }
      if (server.upgrade(request, { data: { upstream, botId: streamBotId } })) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
  websocket: {
    open(ws) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const inward = new WebSocket(ws.data.upstream);
      ws.data.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      inward.onmessage = (event) => {
        try {
          ws.send(String(event.data));
        } catch {
          inward.close();
        }
      };
      inward.onclose = () => ws.close();
      inward.onerror = () => ws.close();
    },
    message(ws, raw) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      const text = String(raw);
      /*
       * WHERE TEACHING HAPPENS, and the only place it could.
       *
       * Every click and keystroke a person makes in a Bot's browser passes through this line on its
       * way there. When they are showing the Bot how a task is done, that is the demonstration —
       * and nothing else in this process ever sees these messages.
       *
       * Before the forward, never instead of it: the recorder is told and the message goes on
       * regardless. It cannot throw and does not wait; see `observe`.
       */
      if (demonstrations.recording(ws.data.botId)) {
        try {
          demonstrations.observe(ws.data.botId, JSON.parse(text));
        } catch {
          // Not JSON, so not an input message this understands. Forwarded all the same.
        }
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(text);
    },
    close(ws, code, reason) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      ws.data.inward?.close();
    },
  },
});

if (config.devNoAuth) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  console.warn(
    "LAF_DEV_NO_AUTH is on: every request is treated as " +
      `${DEV_ACTOR.email} (administrator). Local development only.`,
  );
}

console.info(`LAF Agent server listening on http://localhost:${port}`);
/*
 * The routine clock. A minute is the finest grain a routine is ever due at — schedules are
 * wall-clock times, not intervals — so a shorter tick would only mean more queries finding
 * nothing. It was once shared with the watch poller's tick, which is gone.
 */
routineService.start(60_000);

/*
 * The retention sweep, on the same shape of clock as the routine tick and for the same reason: one
 * process on one VM, and nothing to install.
 *
 * SIX HOURS, NOT TWENTY-FOUR. A day-long interval on a machine that is restarted most days is a
 * sweep that never runs — the timer is reset by every boot and never reaches its deadline. Six
 * hours means the deployment prunes even if somebody redeploys twice a day, and the work is a
 * handful of deletes against an indexed timestamp.
 *
 * `AUDIT_RETENTION_DAYS=0` switches it off, tick included, and then nothing here is scheduled at all.
 */
const retention = createRetentionJob({
  database,
  days: retentionDays(),
});
void retention.runOnce().catch((error) => {
  console.warn(
    `retention: first sweep failed — ${error instanceof Error ? error.message : String(error)}`,
  );
});
retention.start(6 * 60 * 60_000);

/*
 * The public-data entry, reconciled to the key this boot was given: the row, its two tools and a
 * grant on each for every Bot on the machine — or, with the key gone, every one of those taken
 * back. Once, at boot, because the key is fleet configuration and only changes with a restart.
 * Never fatal: a store that could not be written leaves the tools missing, which the log says.
 */
void publicDataRuntime.reconcile(pluginStore, "deployment");
