import "./telemetry-off";
import { serve } from "bun";
import { HARNESS_VERSION } from "../../shared/prompt/harness";
import { createConsentStore } from "./account/consent";
import { createAccountDeletion } from "./account/deletion";
import { createAccountExport } from "./account/export";
import { createShopStore } from "./account/shop";
import {
  createBrowserWhereabouts,
  createWhereaboutsStore,
} from "./account/whereabouts";
import { createDayReader } from "./agents/day";
import { withGrantedSkills } from "./agents/granted-skills";
import { createDream } from "./agents/dream";
import { createGuidanceStore } from "./agents/guidance-store";
import {
  createMemoryCurator,
  evidenceFromConversations,
} from "./agents/memory-curation";
import { recordMemoryReceipt } from "./agents/memory-receipts";
import { createAgentMemoryStore, forgottenForBot } from "./agents/memory-store";
import { withPersonContext } from "./agents/person-context";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { withShopProfile } from "./agents/shop-context";
import { createApp } from "./app";
import { createAuditReader, createAuditStore } from "./audit";
import { createAuth } from "./auth";
import { createDeploymentAdmission } from "./auth/admission";
import { createSignInAllowlist } from "./auth/allowlist";
import { createRoleRepository } from "./auth/guards";
import { createOnboardingStore } from "./auth/onboarding";
import { createRequestActors } from "./auth/request-actor";
import { createSessionRevocation } from "./auth/session-revocation";
import {
  recordStartingArrangement,
  sayBooted,
  sayConnectors,
  sayFleetIsUnconfigured,
} from "./boot/announce";
import { startBackgroundWork } from "./boot/background";
import { keepServingThroughUnhandledRejections } from "./boot/process";
import { reconcileBeforeServing } from "./boot/reconcile";
import {
  type ChannelActivityEvent,
  createChannelEventHub,
} from "./channels/events";
import { createChannelStore } from "./channels/routes";
import { websocket as channelSocket } from "./channels/socket";
import { createStallGuard } from "./channels/stall-guard";
import { createThreadIdentity } from "./channels/thread-identity";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createApprovalRegistry } from "./computer/approvals";
import { createComputerClient } from "./computer/client";
import { createDemonstrationRecorder } from "./computer/demonstration";
import { createComputerGateway } from "./computer/gateway";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import { releaseComputerFor } from "./computer/release";
import { createRepeatDetector } from "./computer/repeat";
import { botOwnerLookup, createScreenViewAudit } from "./computer/screen-view";
import { createSiteConnectionStore } from "./computer/site-connections";
import { createResultSpill } from "./computer/spillover";
import {
  createDatabaseStandingApprovalStore,
  ownerTaskTextIn,
} from "./computer/standing-approvals";
import { createHighRiskCheck } from "./computer/high-risk";
import { loadConfig } from "./config";
import type { Compactor } from "./context/compaction";
import { createSummaryScrubber } from "./context/forget-scrub";
import {
  botBusyReader,
  conversationPersistence,
  createConversationStore,
} from "./context/conversations";
import { createAttachmentService } from "./attachments/service";
import { messagesFor } from "./runner/thread-store";
import { mountCopilotRuntime, resolveRuntimeAgents } from "./copilot";
import {
  createCredentialAdminService,
  createCredentialStore,
} from "./credentials";
import { createDatabase } from "./db/client";
import { createFleetNotifier } from "./fleet/notify";
import { deploymentHealthProbes } from "./health";
import { readInsights } from "./insights/read";
import {
  createLiveScreen,
  describePointOn,
  type SocketData,
} from "./live-screen";
import { log, recentLines } from "./log";
import { readApprovalMetrics } from "./notifications/approval-metrics";
import { createDeploymentOutbox } from "./notifications/doors";
import { withOutboxWatch } from "./notifications/from-audit";
import { createFinishedNotice } from "./notifications/in-app";
import { withApprovalNotifications } from "./notifications/notify";
import { connectConfigFor } from "./plugins/connect-config";
import { redirectUriFor } from "./plugins/oauth";
import { createPartnerRuntime } from "./plugins/partners";
import { createPublicDataRuntime } from "./plugins/public-data-rest";
import { lookupOver } from "./plugins/shared-clients";
import { createBuiltInSkills } from "./plugins/built-in-skill-sync";
import { allLiveBots } from "./plugins/skills-and-grants";
import { createPluginStore } from "./plugins/store";
import {
  createRoutineDelivery,
  createRoutineFailureDelivery,
} from "./routines/deliver";
import { createRoutineService } from "./routines/service";
import { createSuggestionDismissalStore } from "./routines/suggestions";
import { createBotLane } from "./runner/bot-lane";
import { createWorkInFlight } from "./runner/in-flight";
import { LafPostgresRunner, reportInterruptedRuns } from "./runner/laf-runner";
import { createMessageTimeReader } from "./runner/message-times";
import { createRunLedger } from "./runner/run-ledger";
import { createStopAll } from "./runner/stop-all";
import { primeThreadRoutes } from "./runner/thread-priming";
import { createUnattendedTools } from "./runner/unattended";
import { createWorkingReader } from "./runner/working";
import { createServerModelCalls } from "./server-model-calls";
import { createAnswerRatingStore } from "./support/answer-ratings";
import { createDiagnosticsSource } from "./support/diagnostics";
import { createFeedbackStore } from "./support/feedback";
import { createPackageStatusReader, loadTenantPackage } from "./tenant-package";
import { dailyBudgetFor } from "./usage/daily-budget";

/*
 * The server: the one process a deployment runs (docs/laf/deployment-model.md), started by
 * `index.ts` once `eventsource` has loaded.
 *
 * A COMPOSITION ROOT, AND ONLY THAT. It reads the configuration, builds each store and service,
 * hands them to each other, opens the port, and stops. What any of them DOES lives beside the
 * feature it belongs to; what the boot itself does — the facts it announces, what it settles before
 * serving, what it runs on a clock — lives under `boot/`. This file was 1,501 lines until
 * 2026-09-14, a third of the code in it logic rather than wiring (audit A1 §5), and a feature
 * reachable only by starting the whole process is a feature no test can reach.
 *
 * THE ORDER IS LOAD-BEARING. Several things below are built before others because of what they are
 * handed, and the comments say which; the log lines come out in the order the boot reaches them.
 */

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
/*
 * The boot audit store, built first because every run's model usage is written into it (`runMeter`).
 *
 * Not awaited and never fatal anywhere it is used: a deployment must not fail to start because
 * its audit trail is unavailable.
 */
const bootAuditStore = createAuditStore(database);
/**
 * The fleet tool, which created this machine and is the only thing that can destroy it.
 *
 * Built next to the audit store because that is the only thing it needs, and before `createAuth`
 * and the account routes, which are the two places a person arrives and leaves. Its absence is said
 * out loud (see `sayFleetIsUnconfigured`).
 */
const fleetNotifier = config.fleet
  ? createFleetNotifier({ ...config.fleet, auditStore: bootAuditStore })
  : undefined;
if (!fleetNotifier) sayFleetIsUnconfigured();
// One ledger for every run path — chat, routine, room, handoff — so the roster reads one table and
// one module writes it. Built before the runner because the runner opens its rows through it.
const runLedger = createRunLedger(database);
/**
 * What is going on for each person right now, with the way to stop each piece — the one list
 * `모두 멈추기` reads (runner/in-flight.ts). Built beside the ledger and handed to the same run paths:
 * the ledger says a run is happening, this is what can end one.
 */
const workInFlight = createWorkInFlight();
// The durable runner every turn goes through. Built before the app because construction adjudicates
// the runs the last process left open; it reads no conversation until one is asked for.
const lafRunner = await LafPostgresRunner.create(
  database,
  runLedger,
  workInFlight,
);
/**
 * What every run is metered by, and on a free trial judged against — one object, handed to every
 * path that builds agents (the chat endpoint below, and `resolveAgentsFor` for rooms, routines and
 * coworkers), so no path can be counted or refused differently from another. The judge exists only
 * on a trial: see `usage/daily-budget.ts`.
 */
const dailyBudget = dailyBudgetFor(config.trial, database);
/**
 * What each Bot conversation has been told — its frozen epoch and the reminders its person's
 * messages carry (`context/conversations.ts`). Loaded whole before any run can be served: the
 * middleware that reads it answers synchronously, and a conversation it did not know would start a
 * new epoch and re-bill its whole history.
 */
const conversations = createConversationStore({
  persistence: conversationPersistence(database),
  /*
   * Compaction at the threshold (`context/compaction.ts`). The compactor is built with the server's
   * own model calls below — read when a conversation crosses the threshold, long after boot.
   */
  ...(config.harness.compaction === "off"
    ? {}
    : {
        compaction: {
          thresholdTokens: config.harness.compactionThresholdTokens,
          compact: (messages: Parameters<Compactor>[0]) =>
            modelCalls.compactor
              ? modelCalls.compactor(messages)
              : Promise.resolve({ plan: {}, arm: "latest-snapshot" as const }),
        },
      }),
  /*
   * The day's close (`context/day-close.ts`): prepared on the background clock once the owner's day
   * has turned and nothing of theirs is running or waiting, read from the thread as it is stored,
   * and summarised by the server model — read late, like the compactor, long after boot.
   */
  ...(config.harness.dayEpochs
    ? {
        days: {
          summarize: (input: Parameters<typeof modelCalls.summarizeDay>[0]) =>
            modelCalls.summarizeDay(input),
          history: (threadId: string) => messagesFor(database, threadId),
          busy: botBusyReader(database),
          fallbackTimeZone: config.botTimeZone,
          // What the owner forgot is never summarised again (`context/forget-scrub.ts`).
          forgotten: forgottenForBot(database),
          // The nightly dream, read late like the summariser (`agents/dream.ts`).
          dream: (input: Parameters<typeof dream>[0]) => dream(input),
        },
      }
    : {}),
  // A forgotten fact out of the day summaries: the memory's judge with the rule under it.
  scrub: (input) => createSummaryScrubber(modelCalls.memoryAsker)(input),
  ...(config.harness.clockOffsetMs
    ? { now: () => Date.now() + config.harness.clockOffsetMs }
    : {}),
});
const conversationsLoaded = await conversations.load();
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
/**
 * What each Bot has learned about each person, and the rows that let them undo it. A Bot's line
 * carries where it was learned (the owner message its conversation is answering); a line the owner
 * forgets is taken out of the day summaries before 잊기 answers, and the forgetting is on record.
 */
const agentMemoryStore = createAgentMemoryStore(database, {
  evidenceFor: evidenceFromConversations(conversations),
  afterForget: async ({ agentId, ownerUserId, line }) => {
    const { scrubbed, arm } = await conversations.forget(agentId, [line]);
    await recordMemoryReceipt(database, {
      agentId,
      ownerUserId,
      job: "forget",
      checked: 1,
      scrubbed,
      arm,
    });
  },
});

// Every Bot on the deployment shares the one computer at `baseUrl` and its one browser profile, by
// decision (docs/laf/deployment-model.md). Built before the Bot store, which hands a deleted Bot's
// computer to it.
/**
 * The person's clock and place: written through their own session (`PUT /api/me/device` when the
 * app opens, `PUT`/`DELETE /api/me/place` from 내 가게 and the Bot's `remember`), read by every run
 * below and by the Bot's browser on every call to the computer. A change forgets the browser's held
 * copy, so a place saved on 내 가게 reaches the very next click.
 */
const whereaboutsStore = createWhereaboutsStore(database, (userId) =>
  browserWhereabouts.forget(userId),
);
const browserWhereabouts = createBrowserWhereabouts({
  ownerOf: botOwnerLookup(database),
  read: whereaboutsStore.read,
  fallbackZone: config.botTimeZone,
});
const computerClient = config.computer
  ? createComputerClient({
      baseUrl: config.computer.baseUrl,
      allowPrivateHosts: config.computer.allowPrivateHosts,
      ...(config.computer.token ? { token: config.computer.token } : {}),
      whereaboutsFor: browserWhereabouts.forBot,
    })
  : undefined;
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgentAgUiUrl,
  agentVault,
  undefined,
  // A deleted Bot's tabs are closed and the deployment's logins kept for the other Bots, and the
  // trail says so or says why not (computer/release.ts).
  releaseComputerFor(computerClient, bootAuditStore),
);
// Read here rather than beside the row it writes below, because the package names the deployment
// and the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(
  config.tenantPackageDirectory,
  config.tenantPackageVariables,
);
const threadIdentity = createThreadIdentity(tenantPackage.tenantId);
/**
 * Files the owner hands their Bot (attachments/): the bytes kept here, what the Bot can read of them
 * filed on its computer, and photos refused where the model cannot see.
 */
const attachmentService = createAttachmentService({
  database,
  ...(computerClient ? { computer: computerClient } : {}),
  imagesAccepted: tenantPackage.model.supportsImages !== false,
});
const runMeter = {
  auditStore: bootAuditStore,
  ...(dailyBudget ? { dailyBudget } : {}),
  conversations,
  attachments: attachmentService,
};
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
 */
const partnerRuntime = createPartnerRuntime({
  context: { database, auditStore: bootAuditStore },
  database,
  alimtalk: config.partners.alimtalk,
});
/**
 * The public data the fleet holds one key for, assembled once, from the key `config` already read.
 *
 * Nothing per person: a VM with the key offers 나라장터 and 기업마당 to every Bot on it from boot
 * (the reconciliation runs with the background work, beside the retention sweep).
 */
const publicDataRuntime = createPublicDataRuntime({
  keys: config.connectors.keys,
  listBots: () => allLiveBots(database),
});
/**
 * The package's own skills (`tenant/<package>/skills/*.md`): written at boot, handed to every Bot.
 * Read from the same directory the package above was, so a deployment's skills are its package's.
 */
const builtInSkills = createBuiltInSkills({
  packageDir: config.tenantPackageDirectory,
  listBots: () => allLiveBots(database),
});
sayConnectors({
  alimtalk: config.partners.alimtalk !== null,
  dataGoKr: publicDataRuntime.configured,
});
/**
 * The sign-in list this process booted with, and who it lets act (auth/admission.ts).
 *
 * ONE DEPLOYMENT, ONE ACCOUNT (docs/laf/deployment-model.md, 2026-09-16). Built once and handed to
 * every path that acts for a person — the sign-in door, the sessions already issued, the routines,
 * the outbox, the account deletion — so no two of them can read the list two ways. Before the
 * outbox, which asks it about every person it is about to reach. No sign-in configured is an open
 * door, as it always was: nobody can sign in there to be a second person.
 */
const signInList = config.auth ? createSignInAllowlist(config.auth) : undefined;
const admission = createDeploymentAdmission({
  database,
  devNoAuth: config.devNoAuth,
  ...(signInList ? { allowlist: signInList } : {}),
});
/**
 * One outbox for "somebody has to be told", and every door it goes out through. Built here, before
 * anything that raises a notification, because there is exactly one of these and the things that
 * write into it are spread across the process. See `notifications/doors.ts`.
 */
const notificationOutbox = createDeploymentOutbox({
  database,
  sockets: channelEvents,
  config,
  partners: partnerRuntime.connections,
  alimtalk: config.partners.alimtalk,
  fleetNotifier,
  admission,
});
/** A routine that finished while nobody was connected to hear it. See in-app.ts. */
const noticeFinished = createFinishedNotice(channelEvents, notificationOutbox);
/**
 * A finished turn's roster row, on every open tab — and a notification for a person who has no tab
 * at all.
 */
const announceFinished = (event: ChannelActivityEvent) => {
  channelEvents.deliver(event);
  noticeFinished(event);
};
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
/**
 * What kind of business the person runs and where they work every day: written only by the person
 * (`PUT /api/me/shop`, the first run and Settings), read by `/api/me` and by every run below.
 */
const shopStore = createShopStore(database);
// What each Bot IS, then what skills it holds — by name and one line, for the prompt's index — then
// the shop it works for, which is the person's and the same for every Bot they have.
// And last, the person's clock and place, which every run — a routine at 07:30 included — reads.
const loadAgentsForActor = withPersonContext(
  withShopProfile(
    withGrantedSkills(createRuntimeAgentLoader(database, agentVault), database),
    shopStore.read,
  ),
  whereaboutsStore.read,
);
/**
 * Who is still let in, for the sessions already issued (auth/session-revocation.ts).
 *
 * From the same list, through the same function, the sign-in hook refuses new sessions with — two
 * readings of one configuration cannot disagree. Built before the boot settles anything, because a
 * boot is the moment `laf member remove` takes effect, and handed to every place a session is read
 * or ended: both guards, the account deletion and the live screen.
 */
const sessionRevocation = signInList
  ? createSessionRevocation({ database, allowlist: signInList })
  : undefined;
await reconcileBeforeServing({
  database,
  devNoAuth: config.devNoAuth,
  tenantPackage,
  tokenEncryptionKey: config.tokenEncryptionKey,
  sessions: sessionRevocation,
});
const auth = config.auth
  ? createAuth(config, database, fleetNotifier, admission)
  : undefined;
// A person whose sessions end loses their activity sockets with them. See `ChannelEventHub.closeFor`.
sessionRevocation?.onEnded((userId) => {
  channelEvents.closeFor(userId);
});
/** Who is asking, for the two doors `requireUser` never sees: the runtime and the screen socket. */
const actors = createRequestActors({
  devNoAuth: config.devNoAuth,
  auth,
  roles: roleRepository,
  admission: sessionRevocation,
});
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
const standingApprovals = createDatabaseStandingApprovalStore(database, {
  // "오늘 하루" ends at midnight where the person is, which is the Bot's clock.
  timeZone: config.botTimeZone,
});

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
 * what is at the point. See `demonstration.ts` and `live-screen.ts`.
 */
const demonstrations = createDemonstrationRecorder({
  namePoint: describePointOn(config.computer),
});

/** The auto-review judge, its probe and a demonstration's write-up. See server-model-calls.ts. */
const modelCalls = createServerModelCalls({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  endpoint: config.model,
  model: tenantPackage.model,
  harness: config.harness,
  ...(dailyBudget ? { dailyBudget } : {}),
});
/*
 * Whether this deployment can auto-review at all, started here so the answer is usually already in
 * hand by the time a browser asks, and not awaited: a probe that could delay the port opening would
 * make a model having a bad minute into a deployment that does not boot. Its cost is one trivial
 * completion per process.
 */
void modelCalls.autoReviewCapable().catch(() => false);
/**
 * The nightly dream at the day's close: how the owner likes to work, as standing guidance. Built
 * here, after the server's model calls; the conversation store above reads it only at a close.
 */
const dream = createDream({
  database,
  guidance: agentMemoryStore.guidance ?? createGuidanceStore(database),
  call: modelCalls.dreamCall,
});

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
  autoReview: modelCalls.autoReviewFor,
  repeat: repeatDetector,
  // The second look at a number or link in a mail the rules could not settle. See mail-secrets.ts.
  mailSecretJudge: modelCalls.mailSecretJudge,
  /*
   * Needed to (re)register a dynamic OAuth client (RFC 7591). Absent when the deployment has no
   * public URL, and self-registration then simply does not happen — registering a redirect URI
   * that resolves to nothing would leave behind a client that can never complete a consent flow.
   */
  redirectUri: config.auth?.baseUrl
    ? redirectUriFor(config.auth.baseUrl)
    : undefined,
  // The vault holds no client for a shared-application entry and never will, so a refresh that
  // looked only there would report "connect it again" at a connection nothing is wrong with.
  sharedClient: sharedOAuthClients,
  // The two entries whose tools are this repository's own code, for the vendors this VM has keys
  // for. Empty leaves both entries unreachable rather than falling back to MCP — see `store.ts`.
  partnerTransports: partnerRuntime.transports,
  // The same again for the public-data entry, on the fleet's data.go.kr key.
  deploymentKeyTransports: publicDataRuntime.transports,
});

recordStartingArrangement({
  auditStore: bootAuditStore,
  policy: policyStore.get(),
  source: policySource,
  configured: Boolean(config.computer?.policy),
});

keepServingThroughUnhandledRejections();

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
 * Which business sites this person has signed into on a Bot's browser.
 *
 * Built before the gateway because the gateway writes through it: every navigation that lands on a
 * catalogue host reports what it saw, which is the only thing that can tell somebody in September
 * that the login they did in March has expired.
 */
const siteConnections = createSiteConnectionStore(database);

/**
 * The only path to an acting call.
 *
 * Built here rather than inline in `createApp`'s arguments because it has a second caller: an
 * unattended run executes a Bot's tools through this exact object, so a routine's click is judged
 * by the same policy, written to the same audit trail and held for the same approvals as one
 * somebody watched.
 */
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
      autoReview: modelCalls.autoReviewFor,
      repeat: repeatDetector,
      /*
       * Bookkeeping on the success path of somebody's actual work, so it swallows its own failures
       * — the same discipline the outbox states: a card losing its freshness is a small loss, a
       * routine failing because a card could not be updated is not a trade anybody would make.
       */
      siteSeen: (seen) => {
        void siteConnections.record(seen).catch(() => undefined);
      },
      /*
       * A submission that pays, changes how an account is secured or hands somebody's details to a
       * site is put in front of the person whatever was allowed before (`computer/high-risk.ts`).
       * The judge is Jev with the server model behind it; the task it weighs against is the
       * person's newest message in the conversation.
       */
      highRisk: {
        check: createHighRiskCheck({
          asker: modelCalls.highRiskAsker,
          model: modelCalls.highRiskModel,
        }),
        taskText: (threadId) =>
          ownerTaskTextIn(database, threadId).catch(() => ""),
      },
    })
  : undefined;

/**
 * The same agents, keys and model every server-side run path resolves — a coworker's answer, a
 * routine, a room turn — resolved per call, so a revoked key or a deleted coworker takes effect on
 * the next question rather than on restart.
 */
const resolveAgentsFor = (actor: AgentActor) =>
  resolveRuntimeAgents(
    () => loadAgentsForActor(actor),
    tenantPackage.model,
    stallGuard,
    config.botTimeZone,
    resultSpill,
    runMeter,
  );

/**
 * One thing at a time per Bot, shared by everything that drives one server-side.
 *
 * An account has ONE virtual computer and its Bots share it, so a routine firing at seven and a
 * room turn asking the same Bot a question would drive one browser at once — each one's snapshot
 * going stale under the other. This is the queue that stops that, and it has to be one queue: two
 * services each serialising against themselves would not see each other at all.
 */
const botLane = createBotLane();

// The Bot's tools, on the server, through the same gateway and grants the browser uses — for a
// routine and a room alike.
const unattendedTools = createUnattendedTools({
  ...(computerGateway ? { gateway: computerGateway } : {}),
  pluginStore,
});

/**
 * Where a routine that did not finish is marked: the Bot's conversation, with the roster row moved
 * on every open tab. Not the answer's announce — that one also raises `run.finished` for anybody
 * not connected, and a failure has its own row (`run.failed`, from the audit trail below).
 */
const markRoutineFailure = createRoutineFailureDelivery(database, (event) =>
  channelEvents.deliver(event),
);

// Instructions on a clock, running through the same server-side path a coworker answer does.
const routineService = createRoutineService({
  database,
  resolveAgents: resolveAgentsFor,
  // The trail with the outbox listening: a `routine.ran` row that says `ok: false` becomes a
  // `run.failed` notification, the same way the computer's help and secret rows become one.
  auditStore: withOutboxWatch(bootAuditStore, notificationOutbox),
  ledger: runLedger,
  lane: botLane,
  // And the answer lands in the Bot's own conversation, where a person already reads — plus a
  // notification when there is nobody connected to read it, which for a routine is the normal case.
  deliver: createRoutineDelivery(database, announceFinished),
  deliverFailure: markRoutineFailure,
  tools: unattendedTools,
  // The clock a routine made without a zone runs on: the person's device's, else the deployment's.
  timeZone: config.botTimeZone,
  personZone: async (userId) => (await whereaboutsStore.read(userId)).timeZone,
  // A routine runs as its author; one the sign-in list no longer admits is run by no door.
  admission,
  work: workInFlight,
});

/*
 * The runs the last process died on, told to the people they belonged to.
 *
 * Here rather than inside the runner's boot, because the outbox and the failure mark are built
 * after the runner is. Not awaited: a webhook door has a ten-second bound per row, and boot must
 * not wait on somebody else's server to start answering requests.
 */
void reportInterruptedRuns({
  database,
  runs: lafRunner.interruptedAtBoot(),
  outbox: notificationOutbox,
  markRoutine: markRoutineFailure,
});

/** The runtime's thread routes, each reading the thread it answers for first. See thread-priming.ts. */
const copilotEndpoint = primeThreadRoutes({
  runner: lafRunner,
  actorOf: actors.resolveOrNull,
}).route(
  "/",
  mountCopilotRuntime(
    tenantPackage.model,
    loadAgentsForActor,
    actors.identify,
    stallGuard,
    lafRunner,
    config.botTimeZone,
    "/api/copilotkit",
    resultSpill,
    runMeter,
  ),
);

/**
 * The row a looked-at screen leaves, from the same trail every other computer row lands in. Built
 * once and handed to both doors: the live-screen proxy below, and the demonstration read inside
 * the computer routes.
 */
const screenViews = createScreenViewAudit({
  auditStore: bootAuditStore,
  ownerOf: botOwnerLookup(database),
});

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
  routineService,
  // When each message was first seen. Read from the snapshot column directly — see message-times.
  createMessageTimeReader(database),
  // What is running for a person right now, from the same ledger chat and routines both write.
  createWorkingReader(database),
  standingApprovals,
  tenantPackage.model.supportsEffort,
  demonstrations,
  modelCalls.writeUp,
  agentMemoryStore,
  // The OAuth connect flow: where vendors send people back, and who still has access. See the module.
  connectConfigFor({ config, database, sharedClient: sharedOAuthClients }),
  // Whether the "do not ask me about" control is drawn at all. Measured against this deployment's
  // own review model; see the probe above.
  modelCalls.autoReviewCapable,
  // What `/health` asks: the database, `agent-bot`, and the computer when there is one.
  deploymentHealthProbes({
    database,
    agentBotUrl: config.managedAgentAgUiUrl,
    computer: computerClient,
  }),
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
      ...(fleetNotifier ? { fleetNotices: notificationOutbox } : {}),
      // The cookies of somebody an administrator removed, remembered as revoked; their screens closed.
      ...(sessionRevocation ? { sessions: sessionRevocation } : {}),
      // Whose logins the shared browser holds, so removing a leftover account keeps them — and the
      // trail its released Bots are written to.
      admission,
      auditStore: bootAuditStore,
    }),
    auditStore: bootAuditStore,
  },
  /*
   * What is waiting for a person, and how long answers take.
   *
   * The metric reads the trail rather than the outbox on purpose (see approval-metrics.ts), and it
   * is resolved per request rather than captured, so the window a caller asks for is the window it
   * measures. The Bot's own clock decides what "night" is — the VM may be anywhere and the person
   * is in Korea.
   */
  {
    outbox: notificationOutbox,
    approvalMetrics: (days: number) =>
      readApprovalMetrics(database, { days, timeZone: config.botTimeZone }),
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
  // Who agreed to which terms, and when. See account/consent.ts for why it is its own call.
  createConsentStore(database),
  screenViews,
  // The 문의·의견 box: the row, the trail, and the outbox whose support door reaches the operator —
  // and what its diagnostic details are read from: this process's log tail and the run ledger. And
  // 좋아요·아쉬워요 under an answer, which leaves by the same door when somebody writes why.
  {
    feedback: createFeedbackStore(database),
    auditStore: bootAuditStore,
    outbox: notificationOutbox,
    diagnostics: createDiagnosticsSource({
      database,
      lines: recentLines.lines,
    }),
    ratings: createAnswerRatingStore(database),
  },
  // The fleet's counts, read per request over the window it asks for, in the Bot's own clock — the
  // same zone "night" means in the approvals metric. Mounted only when the fleet gave this VM a token.
  (days: number) =>
    readInsights(database, { days, timeZone: config.botTimeZone }),
  // Whether the person behind each session is still let in, asked by `requireUser` on every request.
  sessionRevocation,
  // A free trial's day, for `/api/me` to say whether it is spent — the judge the runs are refused by.
  dailyBudget,
  // `모두 멈추기`: the list every run path writes, and the trail the press is recorded on.
  createStopAll({ work: workInFlight, auditStore: bootAuditStore }),
  // The shop answers: `/api/me` carries them and `PUT /api/me/shop` is their one door. The same
  // store every run reads through `loadAgentsForActor` above.
  shopStore,
  // The person's clock and place: `/api/me` carries them and three doors change them.
  whereaboutsStore,
  // 오늘: the Bot's day, from the ledgers, in the person's own day.
  createDayReader({
    database,
    zoneOf: async (userId) => (await whereaboutsStore.read(userId)).timeZone,
    fallbackZone: config.botTimeZone,
  }),
  // The package's skills, handed to a Bot the moment it is made (built-in-skill-sync.ts).
  builtInSkills,
  // Files the owner hands their Bot: the composer's two doors, and whether photos are offered.
  attachmentService,
);

/** The live screen, proxied ahead of the app because an upgrade is not a request. See live-screen.ts. */
const liveScreen = createLiveScreen({
  computer: config.computer,
  trustedOrigins: config.trustedOrigins,
  actorOf: actors.resolveOrNull,
  botOwner: roleRepository.botOwner,
  screenViews,
  demonstrations,
  ...(sessionRevocation ? { sessions: sessionRevocation } : {}),
});

const server = serve<SocketData>({
  port: config.port,
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
    const streamBotId = liveScreen.botOf(request);
    if (streamBotId !== null) {
      return liveScreen.upgrade(request, server, streamBotId);
    }
    return app.fetch(request, { server });
  },
  websocket: liveScreen.websocket(channelSocket),
});

sayBooted({
  config,
  model: tenantPackage.model,
  port: server.port,
  fleetWebhook: Boolean(fleetNotifier),
  harness: { version: HARNESS_VERSION, conversations: conversationsLoaded },
});

/*
 * Said before leaving, with the reason. `docker stop` sends SIGTERM and then waits; a log that
 * ends mid-turn with no last line cannot be told from a process the kernel killed, and the two
 * want different next steps (see docs/laf/operating.md). Registering the handler means Bun no
 * longer exits on its own, so the exit is explicit. The routine clock and the retention timer die
 * with the process; a run in flight is reconciled to `unknown` by the next boot (laf-runner.ts).
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info("shutdown", { reason: signal });
    server.stop(true);
    process.exit(0);
  });
}

startBackgroundWork({
  database,
  routines: routineService,
  auditRetentionDays: config.auditRetentionDays,
  // Only with a fleet: on a laptop there is nothing to tell.
  fleetOutbox: fleetNotifier ? notificationOutbox : undefined,
  publicData: publicDataRuntime,
  builtInSkills,
  pluginStore,
  conversations,
  // The hourly curation: each new line of a Bot's checked against the owner's own words.
  memoryCurator: createMemoryCurator({
    database,
    asker: modelCalls.memoryAsker,
    history: (threadId) => messagesFor(database, threadId),
    now: () => conversations.now(),
  }),
});
