import type { Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { buildOf } from "../../shared/log";
import { type AccountService, createAccountRoutes } from "./account/routes";
import type { CoworkerCall } from "./agents/coworker-call";
import { createFirstTaskRoutes } from "./agents/first-task";
import type { AgentMemoryStore } from "./agents/memory-store";
import type { AgentProfileStore } from "./agents/profile-store";
import { createAgentRoutes } from "./agents/routes";
import { type AuditReader, type AuditStore, auditQueryFromUrl } from "./audit";
import { createDevRequireUser } from "./auth/dev-actor";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  type RoleRepository,
  requireAdmin,
} from "./auth/guards";
import { type ConsentStore, LEGAL_VERSION } from "./account/consent";
import type { OnboardingStore } from "./auth/onboarding";
import type { SessionAdmission } from "./auth/session-revocation";
import {
  isOriginExempt,
  originAllowed,
  originRefusalBody,
} from "./auth/origin";
import type { ChannelEventHub } from "./channels/events";
import { type ChannelStore, createChannelRoutes } from "./channels/routes";
import type { ThreadIdentity } from "./channels/thread-identity";
import { createThreadRoutes } from "./channels/thread-routes";
import { createComponentRoutes } from "./components/routes";
import type { SandboxedStore } from "./components/sandboxed";
import { createSandboxedRoutes } from "./components/sandboxed-routes";
import type { ComponentStore } from "./components/store";
import { createApprovalRoutes } from "./computer/approval-routes";
import type { ApprovalRegistry } from "./computer/approvals";
import { MAX_BOTS_PER_COMPUTER } from "./computer/assignment";
import type { ComputerClient } from "./computer/client";
import type { DemonstrationRecorder } from "./computer/demonstration";
import type { ScreenViewAudit } from "./computer/screen-view";
import type { ComputerGateway } from "./computer/gateway";
import type { PolicyStore } from "./computer/policy-store";
import { createComputerRoutes } from "./computer/routes";
import type { SiteConnectionStore } from "./computer/site-connections";
import { createSiteRoutes } from "./computer/site-routes";
import type { StandingApprovalStore } from "./computer/standing-approvals";
import type { WriteUp } from "./computer/write-up";
import type { DeploymentConfig } from "./config";
import {
  type CredentialAdminService,
  type CredentialInput,
  CredentialUnavailableError,
} from "./credentials";
import {
  BAD_VALUE,
  describeFailure,
  type HttpRefusal,
  httpRefusalOf,
  INTERNAL_FAILURE,
  isBadValue,
  NOT_FOUND,
  refusalBody,
} from "./failure-text";
import {
  createHealthRoute,
  type HealthProbes,
  type HealthReport,
} from "./health";
import type { InsightsReport } from "./insights/report";
import { createInsightsRoutes } from "./insights/routes";
import { log } from "./log";
import { createSecurityMiddleware, RATE_LIMITED } from "./middleware/security";
import type { ApprovalMetrics } from "./notifications/approval-metrics";
import type { NotificationOutbox } from "./notifications/outbox";
import { createNotificationRoutes } from "./notifications/routes";
import { createConnectedPageRoute } from "./plugins/connected-page";
import {
  type ConnectionsOverviewSources,
  createConnectionsOverviewRoutes,
  readConnectionsOverview,
} from "./plugins/overview-routes";
import { createPartnerRoutes } from "./plugins/partner-routes";
import type { PartnerRuntime } from "./plugins/partners";
import type { PublicDataRuntime } from "./plugins/public-data-rest";
import { type ConnectConfig, createPluginRoutes } from "./plugins/routes";
import { connectableCatalogue } from "./plugins/shared-clients";
import type { PluginStore } from "./plugins/store";
import { createRoutineRoutes } from "./routines/routes";
import type { RoutineService } from "./routines/service";
import {
  createRoutineSuggestionService,
  type SuggestionDismissalStore,
} from "./routines/suggestions";
import { createRoutineSuggestionRoutes } from "./routines/suggestions-routes";
import type { StopAll } from "./runner/stop-all";
import { createStopAllRoutes } from "./runner/stop-all-routes";
import { createSupportRoutes, type SupportService } from "./support/routes";
import type { PackageStatusReader } from "./tenant-package";
import type { DailyBudget } from "./usage/daily-budget";

/*
 * What the routes written inline below refuse with.
 *
 * They were the last English sentences in the server's own file — "Credential input is invalid.",
 * four "Credential storage is not configured.", "Authentication is not configured." on every door
 * of a deployment without sign-in — and `POST /api/admin/credentials` with a bad body was the one
 * refusal wave 1 counted and could not close, because this file was not its to change. The screens
 * that call these routes say their own sentence; these are the facts beside the status.
 */
/** No sign-in is configured on this deployment, so nobody can be asked who they are. */
const AUTH_NOT_CONFIGURED = "laf:auth_not_configured";
/** No audit reader was wired into this process. */
const AUDIT_UNAVAILABLE = "laf:audit_unavailable";
/** No credential vault was wired into this process. */
const CREDENTIALS_UNAVAILABLE = "laf:credentials_unavailable";
/** The body is not a credential this route accepts. See `credentialInput`. */
const CREDENTIAL_INPUT_INVALID = "laf:credential_input_invalid";
/** No package reader was wired into this process. */
const PACKAGE_UNAVAILABLE = "laf:package_unavailable";

export function createApp(
  config: DeploymentConfig,
  auth?: AuthService,
  roleRepository?: RoleRepository,
  auditReader?: AuditReader,
  credentialService?: CredentialAdminService,
  packageStatusReader?: PackageStatusReader,
  /** Whether this person has made their first Bot yet. Absent means nobody is ever asked to. */
  onboarding?: OnboardingStore,
  /**
   * The CopilotKit endpoint, already built by the caller.
   *
   * Passed in rather than constructed here so this module never imports the runtime. The runtime
   * pulls in `eventsource`, which Bun cannot `require()` from a test, so importing it at module
   * scope broke every server test that touches createApp even though none of them use CopilotKit.
   */
  copilotHandler?: HonoApp,
  /** Absent when no computer is configured, and the routes are then not mounted at all. */
  computerClient?: ComputerClient,
  /** The only path to an acting call: policy decision, then audit row, then the action. */
  computerGateway?: ComputerGateway,
  /** What the gateway enforces, and what an administrator can change while running. */
  computerPolicy?: PolicyStore,
  /** Bots as durable objects: profile, roster, whose they are. */
  agentProfileStore?: AgentProfileStore,
  /** The durable channels a Bot runs in. */
  channelStore?: ChannelStore,
  /** Live channel activity. Absent leaves the routes working, just without the socket. */
  channelEvents?: ChannelEventHub,
  /**
   * Where a Bot's own refusal is written.
   *
   * Separate from `auditReader`, which only reads: this writes, and it is the one thing in the trail
   * that is not decided by the gateway, a model declining before it calls anything.
   */
  auditStore?: AuditStore,
  /**
   * Which components each Bot may answer with.
   *
   * Absent leaves the app working and every Bot answering in prose, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must not fall back to granting
   * everything.
   */
  componentStore?: ComponentStore,
  /**
   * The MCP servers and packaged skills this deployment has, and which Bots hold them.
   *
   * Absent leaves every Bot with the tools it was born with, which is the correct degraded
   * behaviour: a deployment that cannot reach its grant table must offer nothing extra rather than
   * fall back to offering everything.
   */
  pluginStore?: PluginStore,
  /**
   * Components authored in the browser rather than compiled into the build.
   *
   * Absent leaves the compiled gallery working exactly as before, which is the correct degraded
   * behaviour: the React path is the primary one and does not depend on this.
   */
  sandboxedStore?: SandboxedStore,
  /**
   * How this deployment names the threads it mints.
   *
   * Absent leaves the direct Bot chat generating its own id in the browser, which works and simply
   * says nothing about which deployment the conversation belongs to.
   */
  threadIdentity?: ThreadIdentity,
  /**
   * Where the questions an `ask` rule raised wait for a person.
   *
   * Deliberately not tied to the computer being configured. The same policy judges a Bot's calls to
   * somebody else's servers, so a deployment with plugins and no browser can still stop and ask, and
   * a question nobody can be shown is worse than a rule that never fired: the Bot waits out the full
   * ten minutes and then reports that nobody answered.
   */
  approvals?: ApprovalRegistry,
  /** One Bot asking another. Absent means the ask route answers 501 and everything else stands. */
  coworkerCall?: CoworkerCall,
  /** Instructions on a clock. Absent leaves the routine surface unmounted. */
  routineService?: RoutineService,
  /**
   * When each message in a thread was first seen and which Bot said it: the date separators, and
   * the name above a reply in a room where more than one Bot can answer.
   *
   * A reader rather than the database, because this module takes services and never a connection.
   * Absent serves empty maps, and the transcript then draws no separators and no names — which is
   * the right degraded behaviour: a conversation with neither is still a readable conversation.
   */
  messageTimeReader?: (threadId: string) => Promise<{
    times: Record<string, string>;
    speakers: Record<string, string>;
  }>,
  /** Which of a person's Bots are mid-run, for the roster. Absent answers "none". */
  readWorking?: (userId: string) => Promise<
    Array<{
      agentId: string;
      origin: string;
      label: string | null;
      startedAt: string;
    }>
  >,
  /**
   * Runs a room's turn on the server. Absent leaves the room routes unmounted, which is what a
   * deployment without a model runtime should look like: rooms simply cannot answer.
   */
  roomService?: {
    post: (input: {
      actor: { id: string; role: "admin" | "user" };
      actorLabel: string;
      channelId: string;
      threadId: string;
      text: string;
      messageId?: string;
      addressedAgentIds?: string[];
      personName: string;
    }) => Promise<{ turnId: string; messageId: string; epoch: number }>;
    stop: (actor: { id: string }, channelId: string) => Promise<void>;
  },
  /** A room's transcript, straight out of the snapshot column. */
  readThreadMessages?: (threadId: string) => Promise<unknown[]>,
  /**
   * The questions a person has decided not to be asked again.
   *
   * LAST, and new parameters belong here too. Everything above is positional, so a parameter
   * inserted anywhere else shifts every argument after it — which has already broken composition
   * tests that reach a late slot through a run of `undefined`, silently, because the types line up.
   *
   * Absent leaves the answering handler ignoring `always` and the two `/standing` handlers reporting
   * nothing, which is the honest degraded behaviour: a deployment with nowhere to record a widening
   * should keep asking rather than accept one it cannot show anybody.
   */
  standingApprovals?: StandingApprovalStore,
  /**
   * Whether this deployment's model takes an effort setting, for the surface to draw or not draw.
   *
   * The same fact `RuntimeModel.supportsEffort` decides with, read from the same package, so the
   * control appears exactly where the parameter is actually sent. Absent reads as yes, matching the
   * package's own default.
   */
  deploymentEffort?: boolean,
  /**
   * Where a demonstration is recorded while somebody teaches a Bot. Last, like everything new here.
   *
   * Absent leaves taking the wheel exactly as it was — see the `teaching` note on `control/take`.
   */
  demonstrations?: DemonstrationRecorder,
  /** Turns a finished recording into a procedure. Absent leaves it readable and nothing more. */
  writeUp?: WriteUp,
  /**
   * What each Bot has learned about each person. Last, like everything new here.
   *
   * Absent leaves the three memory endpoints unmounted, so a deployment without the store answers
   * 404 rather than drawing a list that is empty for a reason nobody can see.
   */
  agentMemoryStore?: AgentMemoryStore,
  /**
   * What the OAuth connect flow needs: the deployment's public URL, and whether the person a
   * consent was started for still has access when the callback lands. Last, like everything new
   * here.
   *
   * Absent leaves the connect and callback routes answering that the deployment cannot complete a
   * consent flow, which is the honest degraded behaviour for a deployment with no public URL.
   */
  pluginConnect?: ConnectConfig,
  /**
   * Whether this deployment's model can actually judge a "do not ask me about" instruction.
   *
   * Asked of the model rather than assumed, once, and cached — see `createAutoReviewProbe`. It is
   * here because the alternative is a control on every Bot's profile that saves, draws, and reaches
   * nothing, which is the exact failure CLAUDE.md names: if a deployment's model cannot do the
   * thing, do not draw the control.
   *
   * Absent reads as capable, which is what a deployment with no probe wired up should look like:
   * the feature behaves as it did, and the surface draws the control it has always drawn.
   */
  autoReviewCapable?: () => Promise<boolean>,
  /**
   * What `/health` asks before it answers. Last, like everything new here.
   *
   * Absent, the endpoint reports no checks and stays 200 — an embedding that supplied no probes is
   * not a degraded deployment. The process that runs a deployment supplies all three; see
   * `health.ts` for why a constant was worse than nothing.
   */
  healthProbes?: HealthProbes,
  /**
   * Taking your data with you, and leaving. Last, like everything new here.
   *
   * Absent leaves the three routes unmounted, which is the honest degraded behaviour: a deployment
   * that cannot delete an account must answer 404 rather than draw a page whose button reports
   * success and removes nothing.
   */
  accountService?: AccountService,
  /**
   * The notification outbox and the number it exists to make measurable. Last, like everything new.
   *
   * Absent leaves both routes unmounted and the answering handler telling nobody it was answered,
   * which is the honest degraded behaviour: a deployment with no outbox has nothing to list, and a
   * page that asked would get a 404 rather than an empty list it would read as "nothing is waiting".
   */
  notifications?: {
    outbox: NotificationOutbox;
    /** How long answers take. Absent answers 503 on the metric and leaves the door working. */
    approvalMetrics?: (days: number) => Promise<ApprovalMetrics>;
  },
  /**
   * Which business sites this person has signed into on a Bot's browser. Last, like everything new.
   *
   * Absent leaves the 사이트 연결 routes unmounted, and the section then draws every card as "not
   * connected yet" — which is honest: a deployment that cannot remember a connection genuinely does
   * not know about one. Nothing else changes; the handoff itself is the ordinary navigate-and-take-
   * the-wheel path and works without any of this.
   */
  siteConnections?: SiteConnectionStore,
  /**
   * The partner vendor LAF holds the account at. Last, like everything new.
   *
   * Absent leaves `/api/partners` unmounted and the 연결 screen draws no partner cards — which is
   * what a deployment with no key configured should show, and what the runtime itself reports. It is
   * passed BESIDE the plugin store rather than through it, because a connect writes a server row and
   * a grant as well as a registration: see `plugins/partner-routes.ts`.
   */
  partners?: PartnerRuntime,
  /**
   * The 다음에 latch behind the routine suggestions. Absent leaves the cards unmounted, which is
   * the right degraded behaviour: a suggestion that could be declined and come back tomorrow is
   * the nag wall the feature exists not to be.
   */
  routineSuggestionDismissals?: SuggestionDismissalStore,
  /**
   * The public data the fleet holds one key for. Last, like everything new here.
   *
   * Absent leaves nothing unmounted — there is no route of its own, since nobody connects anything —
   * and takes one thing away: a Bot made after boot is not handed the tools on the spot. The boot
   * reconciliation lives in the process (`index.ts`), beside the retention sweep, because it is a
   * fact about the whole machine and not about a request.
   */
  publicData?: PublicDataRuntime,
  /**
   * What each person agreed to, and when. Absent means nobody is asked and `/api/me` says nothing
   * about it, the same shape as `onboarding`: a deployment that cannot record an agreement must not
   * stand a screen in front of people demanding one.
   */
  consent?: ConsentStore,
  /**
   * The row a looked-at screen leaves. The live socket is terminated in `index.ts` and writes its
   * own; this one is for the demonstration read below, which is the other way a screen is seen.
   */
  screenViews?: ScreenViewAudit,
  /**
   * The 문의·의견 box's other end. Last, like everything new.
   *
   * Absent leaves the route unmounted and the box answering 404, which is the honest degraded
   * behaviour: a deployment that cannot keep a message must not draw a box that says 보냈습니다.
   */
  support?: SupportService,
  /**
   * The fleet's read of this VM's counts (`insights/read.ts`). Last, like everything new.
   *
   * Mounted only with `config.fleetMetricsToken` as well: a reader with no token to guard it is not
   * a door this deployment opens, and a path nothing is mounted on answers 404 like any other.
   */
  insights?: (days: number) => Promise<InsightsReport>,
  /**
   * Whether a session's person is still let in, asked by `requireUser` on every request. Last, like
   * everything new here.
   *
   * Absent, a removal decides who may sign in again and nothing about who is already inside — the
   * state measured on 2026-09-14 (`auth/session-revocation.ts`). `main.ts` always passes it; the
   * suites that stub a session without a sign-in list leave it out.
   */
  sessionAdmission?: SessionAdmission,
  /**
   * A free trial's day, for `/api/me` to say whether today's is spent. Last, like everything new.
   *
   * The same judge the runs are refused by (`usage/daily-budget.ts`), so this cannot say a day is
   * open while every question is being refused, or the other way round. Absent on a deployment that
   * is not a trial, which then says nothing about a trial at all.
   */
  dailyBudget?: DailyBudget,
  /**
   * `모두 멈추기`: what a person has going on, and the one press that stops it all
   * (`runner/stop-all.ts`). Last, like everything new here.
   *
   * Absent leaves both doors unmounted, which is the honest degraded behaviour: a deployment that
   * cannot reach its running work answers 404 rather than a count of nothing that reads as calm.
   */
  stopAll?: StopAll,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", createSecurityMiddleware());

  /*
   * WHERE A THROWN ERROR ENDS UP.
   *
   * There was no handler, so a route that threw fell through to Hono's default: `500 Internal Server
   * Error` as text/plain, and `console.error(err)` — the whole error object, which for a Drizzle
   * failure is the statement and every bound parameter. Measured by audit A1 (2026-09-10) with one
   * request naming a Bot that does not exist: the operator log carried the routine's instruction
   * and the trigger token's hash, thirty frames deep, in the one place the log discipline
   * (`shared/log.ts`) could not reach because Hono wrote the line and not the logger.
   *
   * Every answer is JSON — `{ code, …facts }`, see `refusalBody` on why there is no `error` beside
   * it — and only the failures that are the server's are logged:
   *   - a thrown error that IS a refusal — a `laf:` code and a status — answers with them, whichever
   *     module's class it is; the route's own mapper usually caught it first, and this is for the
   *     one that forgot;
   *   - a credential that is not there, or no longer live, is the admin routes' unknown id: 404;
   *   - a value Postgres could not read as its column's type is the request's doing: 400, with a
   *     warning, because a server that computed the bad value itself should still be findable;
   *   - everything else is `laf:internal`, and the line names the route PATTERN — never the path
   *     with its ids — and `describeFailure`, never the message.
   */
  app.onError((error, context) => {
    const refusal: HttpRefusal | null =
      httpRefusalOf(error) ??
      (error instanceof CredentialUnavailableError
        ? { status: 404, code: "laf:credential_not_found", facts: {} }
        : null);
    if (refusal) {
      return context.json(refusalBody(refusal), refusal.status);
    }
    const where = {
      method: context.req.method,
      route: context.req.routePath,
      reason: describeFailure(error),
    };
    if (isBadValue(error)) {
      log.warn("route_refused_value", where);
      return context.json({ code: BAD_VALUE }, 400);
    }
    log.error("route_failed", where);
    return context.json({ code: INTERNAL_FAILURE }, 500);
  });
  // A path nothing is mounted on, as a fact. Not logged: a probe for one is not an operator's news.
  app.notFound((context) => context.json({ code: NOT_FOUND }, 404));

  /**
   * What the deployment can do, asked per request and answered from a cache.
   *
   * One function so that a second place cannot answer differently, which is how a control comes to
   * be drawn on one screen and dead on the next.
   */
  const capabilities = async () => ({
    effort: deploymentEffort !== false,
    autoReview: autoReviewCapable ? await autoReviewCapable() : true,
    /*
     * How many Bots fit, so the roster can say "3/5" instead of leaving somebody to discover the
     * cap by being refused. The same constant `reserveSeat` counts against, read from the same
     * place — a surface that wrote five into its own prose would be wrong on any deployment that
     * set `BOT_SEATS_PER_ACCOUNT` to anything else.
     */
    seats: MAX_BOTS_PER_COMPUTER,
  });

  /*
   * WHERE A REQUEST THAT CHANGES SOMETHING IS ALLOWED TO HAVE COME FROM.
   *
   * FIRST, before every other `/api` route, because a check that runs after a handler has already
   * done the thing is not a check. Reads are not covered: a cross-site page cannot read the answer
   * to one, and covering them would refuse the ordinary same-site navigation as well.
   *
   * The reason this deployment cannot lean on `SameSite=Lax` is in auth/origin.ts: every customer
   * of this product is a name under one registrable domain, so all of them are same-site with each
   * other and the cookie's own default is no boundary between two of them.
   */
  app.use("/api/*", async (context, next) => {
    const method = context.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }
    if (isOriginExempt(new URL(context.req.url).pathname)) return next();
    if (!originAllowed(context.req.raw.headers, config.trustedOrigins)) {
      return context.json(originRefusalBody, 403);
    }
    return next();
  });

  /*
   * One route at two paths. The front door (`app/Caddyfile`) hands only `/api/*` to the API, and a
   * `/health` asked from outside a VM was the SPA's index.html — measured 2026-09-06 on a customer
   * VM: 200 and 1,790 bytes, and still 200 through a six-second API outage, which is what the fleet
   * monitor had been reading as "alive". The Caddyfile now passes `/health` through as well, and
   * `/api/health` answers the same so a poller that only ever speaks `/api` reads the truth too.
   * The same instance, so the two paths share one cache and one round of probes.
   */
  const health = createHealthRoute(healthProbes);
  app.route("/health", health);
  app.route("/api/health", health);
  /*
   * What this deployment can do, for anybody who asks — and it is anybody: this endpoint has no
   * session guard, so every field added here is published. It once reported a runtime `mode` and an
   * always-true `durableHistory`, both left from a hosted-runtime choice that no longer exists, and
   * a projection of nothing is still a projection: add fields explicitly, never the config object.
   *
   * Kept rather than removed because the deployment's own smoke test uses it to decide whether
   * anything is answering at all before it starts asking real questions of it.
   */
  /*
   * WHAT THIS DEPLOYMENT CAN DO IS NOT PUBLISHED HERE. It is on `/api/me`, behind the session
   * guard, beside the person it is being drawn for. This endpoint is reachable by anyone, the two
   * booleans are about which controls to draw rather than about who is asking, and there is nothing
   * an anonymous caller needs them for — see the note above and `health.test.ts`, which pins the
   * body to one field for exactly that reason.
   */
  app.get("/api/capabilities", (context) => context.json({ status: "ok" }));
  /*
   * WHICH BUILD IS ANSWERING. Until 2026-09-10 nothing on any surface said: a customer writing
   * "it does not work" could not be asked what they were running, and a shell at 0.4.4 in front of
   * a server at 0.4.5 was a combination nobody could tell from a healthy one. Three facts, read
   * once at boot from the environment the image was built and pulled with (`buildOf`), and never
   * the config object — the rule two comments up. Public like `/health`, because the fleet monitor
   * and a support thread both need it before anybody has signed in.
   */
  const build = buildOf();
  app.get("/api/version", (context) => context.json(build));
  /*
   * Which sign-ins this deployment offers, for the surface to draw its buttons from.
   *
   * Public on purpose, and one field: the sign-in screen is the one screen an anonymous person
   * sees, and the set is already declared to the world by every callback route better-auth mounts.
   * It exists because the web image used to compile the same list in at BUILD time from the same
   * variable — measured on the fleet: an image baked for `google` drew a Google button on a VM
   * whose `.env` said `laf`, and the button posted into a callback this deployment had never
   * registered. The baked list is now only what the surface falls back to when this route cannot
   * be reached (`app/src/lib/auth/providers.ts`).
   *
   * What is DECLARED, not what has credentials: `config.auth.providers` is already narrowed to the
   * declaration (`GOOGLE_OAUTH_*` carried as the connector application is not a Google button),
   * and the broker is a provider of its own. Registered before the `/api/auth/*` catch-all so
   * better-auth never sees the path.
   */
  app.get("/api/auth/providers", (context) =>
    context.json({
      providers: config.auth
        ? [
            ...Object.keys(config.auth.providers),
            ...(config.auth.lafOidc ? ["laf"] : []),
          ]
        : [],
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", async (context) => {
    if (!auth) {
      return context.json(
        { error: AUTH_NOT_CONFIGURED, code: AUTH_NOT_CONFIGURED },
        503,
      );
    }

    /*
     * better-auth's own limit, answered with this deployment's fact.
     *
     * Its limiter refuses the fourth sign-in start in ten seconds with `429 {"message":"Too many
     * requests. Please try again later."}` — no code, a sentence — and the sign-in screen printed it
     * under the buttons (rehearsal VM, 2026-09-13). The API's own limit on the same door answers
     * `laf:rate_limited` with `Retry-After`; the two are one fact to the person pressing, so they are
     * one answer on the wire. The wait better-auth computed is kept, in the header the surface reads.
     */
    const answered = await auth.handler(context.req.raw);
    if (answered.status !== 429) return answered;
    const wait = Number(answered.headers.get("x-retry-after"));
    context.header(
      "Retry-After",
      String(Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : 1),
    );
    return context.json(RATE_LIMITED, 429);
  });

  const authenticationUnavailable: MiddlewareHandler<{
    Variables: AppVariables;
  }> = async (context) =>
    context.json(
      { error: AUTH_NOT_CONFIGURED, code: AUTH_NOT_CONFIGURED },
      503,
    );
  // Local development can stand in a fixed administrator so the product is reachable before the
  // authentication slice is built. It is checked first so a machine with the flag set does not also
  // need Google credentials configured just to boot.
  const requireUser = config.devNoAuth
    ? createDevRequireUser(roleRepository?.botOwner)
    : auth && roleRepository
      ? createRequireUser(auth, roleRepository, sessionAdmission)
      : authenticationUnavailable;

  app.get("/api/me", requireUser, async (context) => {
    const actor = context.var.actor;
    /*
     * `onboarded: true` when nothing tracks it, so a deployment without the store never traps
     * anybody in a flow it cannot record the end of.
     */
    const onboarded = onboarding
      ? await onboarding.isOnboarded(actor.id).catch(() => true)
      : true;
    /*
     * What this deployment can do, beside who is asking.
     *
     * Here as well as on `/api/capabilities` because this is the call the app already makes before
     * it draws anything, and a second round trip to find out whether to draw a control is a control
     * that flickers. Both read one function, so they cannot disagree.
     *
     * Two booleans, and each one is a control that must not be drawn where it does nothing: whether
     * the model takes an effort setting, and whether it can judge a "do not ask me about"
     * instruction. The surface cannot work either out for itself — it is never told which model this
     * deployment serves, and it should not have to know model names to draw a form.
     */
    /*
     * Which text they agreed to, beside which text is current. Two facts and no verdict: the app
     * decides that a version other than the current one — including none — means asking again,
     * and it is the app that draws the screen that asks. Absent when nothing records consent.
     */
    const agreed = consent
      ? await consent.read(actor.id).catch(() => null)
      : null;
    /*
     * A free trial's four facts, and no sentence (self-serve contract §4.6): when it ends, how long
     * it is kept after, the day's budget, and whether today's is spent. `endsAt` is the `.env` value
     * as written, so reading these four back is how an operator sees a push arrived. Absent — the
     * key, not an empty trial — on every deployment that is not one, and the judge is not asked.
     *
     * AND WHAT TODAY HAS USED, so the surface can say how much is left before a question is refused
     * rather than only after. The judge's own count (`usedToday`) — the same Seoul day and the same
     * sum the refusal is decided on — and never a second reading of the trail here. Left OUT when it
     * cannot be read: zero would draw an empty meter on the very day somebody may be one question
     * from the limit, which is the one thing this field exists to tell them.
     */
    const trial = config.trial
      ? {
          trial: {
            endsAt: config.trial.endsAt,
            holdDays: config.trial.holdDays,
            dailyTokenBudget: config.trial.dailyTokenBudget,
            ...(await todayOf(dailyBudget)),
          },
        }
      : {};
    return context.json({
      user: { ...actor, onboarded },
      deployment: { ...(await capabilities()), ...trial },
      ...(consent
        ? {
            consent: {
              version: agreed?.version ?? null,
              at: agreed?.at?.toISOString() ?? null,
              current: LEGAL_VERSION,
            },
          }
        : {}),
    });
  });

  /**
   * They agreed to the terms and the privacy policy, as they stand today.
   *
   * Called by the first screen's 다음 — the screen that says continuing means agreeing — and by
   * the screen that asks again once the version has moved. Not a side effect of onboarding, for
   * the reason `account/consent.ts` gives: the stamp must be written by the act the sentence names.
   */
  app.post("/api/me/consent", requireUser, async (context) => {
    if (!consent) {
      return context.json(
        { error: "laf:consent_not_recorded", code: "laf:consent_not_recorded" },
        503,
      );
    }
    await consent.record(context.var.actor.id);
    return context.body(null, 204);
  });

  /**
   * They finished onboarding. Written by the flow itself once the first Bot exists.
   *
   * Its own call rather than a side effect of creating an agent: a Bot made later from the Agents
   * page is the same creation and must not silently mean "and they have been onboarded", which is
   * the kind of coupling that makes the flow impossible to change afterwards.
   */
  app.post("/api/me/onboarded", requireUser, async (context) => {
    if (onboarding) await onboarding.markOnboarded(context.var.actor.id);
    return context.body(null, 204);
  });
  app.get("/api/admin/status", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ status: "ok" });
  });
  app.get("/api/admin/audit-events", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!auditReader) {
      return context.json(
        { error: AUDIT_UNAVAILABLE, code: AUDIT_UNAVAILABLE },
        503,
      );
    }

    return context.json(
      await auditReader.list(auditQueryFromUrl(new URL(context.req.url))),
    );
  });
  app.get("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: CREDENTIALS_UNAVAILABLE, code: CREDENTIALS_UNAVAILABLE },
        503,
      );
    }

    return context.json({ credentials: await credentialService.list() });
  });
  app.post("/api/admin/credentials", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    if (!credentialService) {
      return context.json(
        { error: CREDENTIALS_UNAVAILABLE, code: CREDENTIALS_UNAVAILABLE },
        503,
      );
    }

    const body = await context.req.json().catch(() => null);
    const input = credentialInput(body, context.var.actor.id);
    if (!input) {
      return context.json(
        { error: CREDENTIAL_INPUT_INVALID, code: CREDENTIAL_INPUT_INVALID },
        400,
      );
    }

    return context.json(
      { credential: await credentialService.create(input) },
      201,
    );
  });
  app.post(
    "/api/admin/credentials/:credentialId/rotate",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: CREDENTIALS_UNAVAILABLE, code: CREDENTIALS_UNAVAILABLE },
          503,
        );
      }

      const body = await context.req.json().catch(() => null);
      const input = credentialInput(body, context.var.actor.id);
      if (!input) {
        return context.json(
          { error: CREDENTIAL_INPUT_INVALID, code: CREDENTIAL_INPUT_INVALID },
          400,
        );
      }

      return context.json({
        credential: await credentialService.rotate({
          ...input,
          previousCredentialId: context.req.param("credentialId"),
        }),
      });
    },
  );
  app.post(
    "/api/admin/credentials/:credentialId/revoke",
    requireUser,
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      if (!credentialService) {
        return context.json(
          { error: CREDENTIALS_UNAVAILABLE, code: CREDENTIALS_UNAVAILABLE },
          503,
        );
      }

      return context.json({
        credential: await credentialService.revoke(
          context.req.param("credentialId"),
          context.var.actor.id,
        ),
      });
    },
  );
  app.get("/api/admin/package", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!packageStatusReader) {
      return context.json(
        { error: PACKAGE_UNAVAILABLE, code: PACKAGE_UNAVAILABLE },
        503,
      );
    }
    return context.json({ package: await packageStatusReader.active() });
  });
  // The CopilotKit runtime, behind the same session guard as every other API route. Mounted last so
  // its own routing under /api/copilotkit cannot shadow a LAF Agent route declared above.
  if (copilotHandler) {
    /*
     * THE GUARD, AS A MIDDLEWARE, BECAUSE THE MOUNT CANNOT CARRY ONE.
     *
     * The comment above said "behind the same session guard as every other API route" and there was
     * no guard: every other route names `requireUser` in its own declaration, and `app.route` takes
     * no middleware — so the runtime, alone in this file, was mounted with nothing in front of it.
     * MEASURED on a deployment with authentication configured, no cookie sent:
     * `GET /api/copilotkit/threads` answered 200 with every thread in the deployment,
     * `/threads/<id>/messages` answered 200 with the conversation, and `/api/me` beside them
     * answered 401.
     *
     * Registered before the mount, because Hono runs middleware in registration order and one added
     * after the route it is meant to guard never runs. The trailing wildcard covers the bare
     * `/api/copilotkit` as well — measured against this Hono, rather than assumed.
     */
    app.use("/api/copilotkit/*", requireUser);
    // Mounted at the ROOT with the handler carrying its own basePath. Mounting it at
    // "/api/copilotkit" as well double-prefixes it: Hono strips the prefix before the handler sees
    // the path, so every route lands at /api/copilotkit/api/copilotkit/* and /info 404s. The client
    // reports that as "Runtime info request failed with status 404" and every run fails before it
    // starts, with nothing at all in the server log.
    app.route("/", copilotHandler);
  }

  // The Bot computer. Acting on a page needs the gateway and the policy it enforces, so all
  // three arrive together or the routes are not mounted: a computer whose actions were ungoverned is
  // not a reduced feature, it is the one shape of this feature that must not exist.
  if (computerClient && computerGateway && computerPolicy) {
    app.route(
      "/api/computers",
      createComputerRoutes(
        computerClient,
        computerGateway,
        computerPolicy,
        requireUser,
        demonstrations,
        writeUp,
        // So a change to the boundary itself lands in the same trail as the actions it governs.
        auditStore,
        screenViews,
      ),
    );

    // The 사이트 연결 cards. Mounted with the computer because "look at the page and tell me
    // whether it is signed in" is a read of a browser, and there is no browser without one.
    if (siteConnections) {
      app.route(
        "/api/sites",
        createSiteRoutes(computerGateway, siteConnections, requireUser),
      );
    }
  }

  // Answering is its own surface because asking is not only the computer's. See approval-routes.ts.
  if (approvals && auditStore) {
    app.route(
      "/api/approvals",
      createApprovalRoutes(
        approvals,
        auditStore,
        requireUser,
        standingApprovals,
        // An answered question stops being a thing anybody is waiting on. See the outbox.
        notifications
          ? (approvalId) => {
              void notifications.outbox
                .markSeenForApproval(approvalId)
                .catch(() => undefined);
            }
          : undefined,
      ),
    );
  }

  /*
   * What is waiting for the person asking, and how long answers take.
   *
   * One mount under `/api`, holding `/me/notifications` and `/admin/metrics/approvals`, because
   * they are the door and the measurement of the same thing — see notifications/routes.ts.
   */
  if (notifications) {
    app.route(
      "/api",
      createNotificationRoutes(
        requireUser,
        notifications.outbox,
        notifications.approvalMetrics,
      ),
    );
  }

  /*
   * The fleet's counts, beside the operator's one metric but not behind the operator's session:
   * the fleet has no session here and is given a bearer token instead. See insights/routes.ts.
   */
  if (config.fleetMetricsToken && insights) {
    app.route(
      "/api/admin/metrics",
      createInsightsRoutes({ token: config.fleetMetricsToken, read: insights }),
    );
  }

  if (agentProfileStore) {
    app.route(
      "/api/agents",
      createAgentRoutes(
        agentProfileStore,
        requireUser,
        // The same stance the computer uses: a laptop legitimately talks to its own services, a hosted
        // deployment must not. Passed from configuration rather than defaulted here, so "hosted and
        // permissive" cannot happen by forgetting something.
        config.computer?.allowPrivateHosts ?? false,
        coworkerCall,
        // What the roster shows as busy, read from the one ledger every run path writes.
        readWorking,
        // What each Bot has learned, and the three endpoints that let a person read and undo it.
        agentMemoryStore,
        // A new Bot is offered what its owner already has the moment it exists, not at the next
        // boot or the next connect: the deployment-wide tools, the partner channels this person
        // connected before the Bot was made, and — since the audit of 2026-09-10 measured a Bot
        // made after Google Sheets was connected holding nothing — the accounts they consented to
        // at a vendor. `by` is the deployment for all three, because nobody pressed anything: a
        // standing decision is being extended to a Bot it could not name.
        pluginStore
          ? async (agentId, ownerUserId) => {
              if (publicData) {
                await publicData.offerTo(pluginStore, agentId, "deployment");
              }
              if (partners) {
                await partners.offerTo(
                  pluginStore,
                  agentId,
                  ownerUserId,
                  "deployment",
                );
              }
              await pluginStore.offerConnectionsTo(
                agentId,
                ownerUserId,
                "deployment",
              );
            }
          : undefined,
      ),
    );

    // A first-task chip pressed on a new Bot's conversation: one row, catalogue keys only. Under
    // `/api/me` because the press is the person's; it needs the roster to know the Bot is theirs to
    // see, and the trail to be written to. See agents/first-task.ts.
    if (auditStore) {
      app.route(
        "/api",
        createFirstTaskRoutes(agentProfileStore, auditStore, requireUser),
      );
    }
  }

  if (channelStore) {
    app.route(
      "/api/channels",
      createChannelRoutes(
        channelStore,
        requireUser,
        channelEvents,
        messageTimeReader,
        roomService,
        readThreadMessages,
        // Where the activity socket may be opened from. The same list every other check reads.
        config.trustedOrigins,
      ),
    );
  }

  if (componentStore) {
    app.route(
      "/api/components",
      createComponentRoutes(componentStore, requireUser, auditStore),
    );
  }

  /*
   * Where the 연결 screen's facts come from — built once, because two readers want the same
   * answer: the overview route below, and the routine suggestions further down, which offer a
   * card only for a connection that is actually connected. Null without a plugin store, and then
   * neither reader is mounted.
   */
  const connectionSources: ConnectionsOverviewSources | null = pluginStore
    ? {
        catalogue: () =>
          connectableCatalogue(pluginConnect?.sharedClient ?? (() => null)),
        store: pluginStore,
        partners: partners ?? null,
        /*
         * THE SAME CONDITION `/api/sites` IS MOUNTED UNDER, and it has to be, not just the store.
         * The store is built from the database on every deployment, so reading it alone would
         * draw fifteen site switches on a machine with no browser behind any of them — and the
         * check on the way back from a handoff, which is a read of that browser, is not mounted
         * there at all. A section that cannot work is not drawn.
         */
        sites:
          computerClient && computerGateway && computerPolicy
            ? (siteConnections ?? null)
            : null,
        bots: async (userId) => {
          if (!agentProfileStore) return [];
          const roster = await agentProfileStore.list({
            id: userId,
            role: "user",
          });
          return roster.map((bot) => ({ id: bot.id, name: bot.name }));
        },
      }
    : null;

  if (pluginStore) {
    app.route(
      "/api/plugins",
      // The key lookup apart from the connect config, which a laptop without a public URL has none of.
      createPluginRoutes(
        pluginStore,
        requireUser,
        pluginConnect,
        publicData?.keys,
      ),
    );
    /*
     * The one page this server draws for a person, and the one route outside `/api`.
     *
     * A consent started in the desktop shell finishes in the person's OWN browser, which has no
     * session for the app — so the app cannot be where that flow lands. Public, session-free, and
     * mounted beside the plugin routes because it is the other half of the callback. See
     * `connected-page.ts`; the front door forwards `/connected` for the same reason (app/Caddyfile).
     */
    app.route("/connected", createConnectedPageRoute());
    // 알림톡. Mounted with the plugin store because a partner connect makes a server row and grants
    // its tools through it — the registration alone reaches no Bot.
    if (partners) {
      app.route(
        "/api/partners",
        createPartnerRoutes(pluginStore, partners, requireUser),
      );
    }

    /*
     * The 연결 screen's one read, over the four doors above and beside it.
     *
     * Mounted here because the plugin store is the only part it cannot do without; the partner
     * runtime, the site store and the roster are each optional and each simply contribute nothing
     * when absent, which is the same degraded behaviour their own routes have.
     */
    if (connectionSources) {
      app.route(
        "/api/connections",
        createConnectionsOverviewRoutes(connectionSources, requireUser),
      );
    }
  }

  if (sandboxedStore) {
    app.route(
      "/api/sandboxed",
      createSandboxedRoutes(sandboxedStore, requireUser),
    );
  }

  // Export, deletion and the admin removal, under `/api` because two are the person's own and one
  // is an administrator's. See account/routes.ts.
  if (accountService)
    app.route("/api", createAccountRoutes(accountService, requireUser));

  // `모두 멈추기`, under `/api/me` because it is about the person asking and nobody else.
  if (stopAll) app.route("/api", createStopAllRoutes(stopAll, requireUser));

  // A person writing to the operator. Under its own prefix: it is neither about the account nor
  // about a Bot, and a message to whoever runs the product should not read as either. The build and
  // the health report its diagnostic details carry are the ones `/api/version` and `/health` answer.
  if (support)
    app.route(
      "/api/support",
      createSupportRoutes(support, requireUser, {
        version: build,
        health: async () =>
          (await (await health.request("/")).json()) as HealthReport,
      }),
    );

  if (threadIdentity) {
    app.route("/api/threads", createThreadRoutes(threadIdentity, requireUser));

    if (routineService) {
      /*
       * The suggestion cards, mounted AHEAD of the routines so `suggestions` is never read as a
       * routine id. They need the connections (a card is offered only for a connection that is
       * connected), the roster (a card goes on a Bot), the latch, and the routine service itself —
       * accept IS `create`, on the same path a typed routine takes.
       */
      if (
        routineSuggestionDismissals &&
        connectionSources &&
        agentProfileStore
      ) {
        const sources = connectionSources;
        const roster = agentProfileStore;
        app.route(
          "/api/routines/suggestions",
          createRoutineSuggestionRoutes(
            createRoutineSuggestionService({
              routines: routineService,
              dismissals: routineSuggestionDismissals,
              connections: (userId) => readConnectionsOverview(sources, userId),
              bots: async (actor) =>
                (await roster.list(actor)).map((bot) => ({
                  id: bot.id,
                  name: bot.name,
                })),
            }),
            requireUser,
          ),
        );
      }
      app.route(
        "/api/routines",
        createRoutineRoutes(routineService, requireUser),
      );
    }
  }

  return app;
}

/**
 * Today, as a trial's surface is told it: whether the day is spent, and what it has used so far.
 *
 * Both asked of the one judge the runs are refused by, side by side rather than one after the
 * other, because `/api/me` is the call every screen waits on before it draws. `reachedToday` never
 * throws — a trail that cannot be read is not a refusal — and the count can, so a count nobody
 * could read is left out rather than said as zero.
 */
async function todayOf(budget: DailyBudget | undefined): Promise<{
  budgetReachedToday: boolean;
  tokensUsedToday?: number;
}> {
  if (!budget) return { budgetReachedToday: false };
  const [budgetReachedToday, tokensUsedToday] = await Promise.all([
    budget.reachedToday(),
    budget.usedToday().catch(() => null),
  ]);
  return {
    budgetReachedToday,
    ...(tokensUsedToday === null ? {} : { tokensUsedToday }),
  };
}

function credentialInput(
  value: unknown,
  actorUserId: string,
): CredentialInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  /*
   * `mcp_oauth_client` and `mcp_user_token` are deliberately NOT accepted here. Both are minted by
   * the code that owns their acts — the client by registration, the token by a person's consent —
   * and a hand-typed one would be a secret whose provenance nothing can vouch for, attached to a
   * flow that treats provenance as the security property.
   */
  if (
    (body.kind !== "model" &&
      body.kind !== "connector" &&
      body.kind !== "mcp") ||
    typeof body.provider !== "string" ||
    typeof body.keyId !== "string" ||
    typeof body.plaintext !== "string" ||
    !body.plaintext ||
    !body.metadata ||
    typeof body.metadata !== "object" ||
    Array.isArray(body.metadata)
  ) {
    return null;
  }

  return {
    kind: body.kind,
    provider: body.provider,
    keyId: body.keyId,
    metadata: body.metadata as Record<string, unknown>,
    plaintext: body.plaintext,
    actorUserId,
  };
}
