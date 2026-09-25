/**
 * Everything a deployment is told about itself, read from the environment once.
 *
 * ONE READER. This module is the place in `server/src` that reads `process.env`, and
 * `server/tests/config-discipline.test.ts` walks the tree and fails on another reader (its two
 * exceptions say why they are exceptions). Everything else is handed the parsed, typed value: a
 * variable read in two places is a variable parsed two ways, and audit A1 measured what that costs —
 * `PORT=abc` opened a random port behind a green boot line, `AUDIT_RETENTION_DAYS=abc` was refused
 * only after the port had opened, `BOT_TIME_ZONE` had two readers that each fell back on their own.
 *
 * There is one runtime and no switch for it. Upstream reads its durable threads and memory out of
 * CopilotKit Intelligence; this fork's rule is that the only external dependencies are the model
 * API and the machines it runs on, so conversations live in our own Postgres (runner/laf-runner.ts)
 * and always have. The four `INTELLIGENCE_*` variables, the mode union and the branch behind them
 * were carried for a deployment shape nobody ever stood up, and are gone — git has them.
 */
import { DEFAULT_TIME_ZONE, resolveTimeZone } from "../../shared/prompt";
import { retentionDays } from "./account/retention";
import { admittedAddresses } from "./auth/allowlist";
import { devAuthEnabled } from "./auth/dev-actor";
import type { ActionPolicy } from "./computer/policy";
import { parseActionPolicy } from "./computer/policy-store";
import { log } from "./log";
import { type SolapiSettings, solapiSettings } from "./plugins/alimtalk/solapi";
import type {
  DeploymentKeyFamily,
  SharedClientFamily,
} from "./plugins/catalogue";
import { isCustomerSlug } from "./plugins/oauth";
import {
  deploymentKeysFrom,
  type SharedOAuthClient,
  sharedClientsFrom,
} from "./plugins/shared-clients";

/**
 * Where a deployment's value for a variable comes from — which is what the documents are held to.
 *
 *   operator     written into `.env` by whoever stands the deployment up, because nothing else can
 *                supply a usable value. The table in docs/laf/deploying.md lists exactly these, and
 *                compose passes them to the server.
 *   compose      compose passes it through from `.env`, or sets it itself. Unset is a correct
 *                deployment, or compose supplies the value.
 *   development  a local run or a test sets it, and compose never passes it: the image is built around
 *                its default (`PORT` — Caddy and the healthcheck both ask :3001), or a deployment
 *                carrying it would be unsafe (`LAF_DEV_NO_AUTH`, `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS`).
 *   retired      read only to refuse a stale spelling. Nobody should set it, so `.env.example` does
 *                not list it.
 *
 * `server/tests/configuration-documents.test.ts` holds `.env.example`, the deploying guide's table and
 * the compose file to this list, and `config.test.ts` holds this list to what `loadConfig` reads.
 */
export type VariableSource = "operator" | "compose" | "development" | "retired";

/**
 * Every environment variable this server reads, and where a deployment's value comes from.
 *
 * A new variable is added here first: the helpers below take only these names, so a read of one
 * that is not declared does not compile. There is no exception left: `BOT_SEATS_PER_ACCOUNT`, the
 * last variable read anywhere else (`computer/assignment.ts`), went on 2026-09-24 when a person
 * came to have one Bot and the number stopped being a setting.
 */
export const ENVIRONMENT = {
  // What the process cannot start without, and where it listens.
  DATABASE_URL: "compose",
  KEY_ENCRYPTION_KEY: "operator",
  LAF_TOKEN_ENCRYPTION_KEY: "operator",
  MANAGED_AGENT_AG_UI_URL: "compose",
  NODE_ENV: "compose",
  PORT: "development",
  TENANT_PACKAGE_DIR: "compose",
  // The deployment's name, where a browser may come from, and who may sign in.
  PUBLIC_ORIGIN: "operator",
  TRUSTED_ORIGINS: "compose",
  AUTH_PROVIDERS: "operator",
  BETTER_AUTH_URL: "compose",
  BETTER_AUTH_SECRET: "operator",
  GOOGLE_OAUTH_CLIENT_ID: "operator",
  GOOGLE_OAUTH_CLIENT_SECRET: "operator",
  KAKAO_OAUTH_CLIENT_ID: "operator",
  KAKAO_OAUTH_CLIENT_SECRET: "operator",
  NAVER_OAUTH_CLIENT_ID: "operator",
  NAVER_OAUTH_CLIENT_SECRET: "operator",
  LAF_OIDC_ISSUER: "operator",
  LAF_OIDC_CLIENT_ID: "operator",
  INITIAL_ADMIN_EMAILS: "operator",
  SIGN_IN_ALLOWED_EMAILS: "operator",
  LAF_DEV_NO_AUTH: "development",
  OPENBOT_DEV_NO_AUTH: "retired",
  // The model, and the clock a Bot is told about.
  OPENAI_API_KEY: "operator",
  OPENAI_BASE_URL: "compose",
  BOT_MODEL: "operator",
  BOT_MODEL_EFFORT: "compose",
  REVIEW_MODEL: "compose",
  // The agent harness: the privacy switch for Jev, and compaction.
  JEV_ENABLED: "compose",
  COMPACTION: "compose",
  COMPACTION_THRESHOLD_TOKENS: "compose",
  BOT_TIME_ZONE: "compose",
  AGENT_STALL_TIMEOUT_MS: "compose",
  // The Bot's computer and its boundary.
  AGENT_COMPUTER_URL: "compose",
  COMPUTER_TOKEN: "operator",
  AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "development",
  AGENT_COMPUTER_POLICY: "compose",
  COMPUTER_REPEAT_WINDOW_MS: "compose",
  // Who is told: the person, the operator, the fleet.
  LAF_NOTIFY_WEBHOOK_URL: "compose",
  LAF_ALERT_WEBHOOK_URL: "compose",
  LAF_FLEET_WEBHOOK_URL: "compose",
  LAF_FLEET_WEBHOOK_SECRET: "compose",
  // What the fleet may read back: counts and codes, behind its own bearer token.
  LAF_FLEET_METRICS_TOKEN: "compose",
  // What the fleet holds an application or a key for.
  CAFE24_CLIENT_ID: "compose",
  CAFE24_CLIENT_SECRET: "compose",
  LAF_OAUTH_RELAY_URL: "compose",
  LAF_PRODUCT_DOMAIN: "compose",
  DATA_GO_KR_SERVICE_KEY: "compose",
  LAF_ALIMTALK_API_KEY: "compose",
  LAF_ALIMTALK_BASE_URL: "compose",
  LAF_ALIMTALK_FROM: "compose",
  // How long the trail is kept.
  AUDIT_RETENTION_DAYS: "compose",
  // A free trial: that it is one, when it ends, how long it is kept after, and what a day may spend.
  LAF_PLAN: "compose",
  LAF_TRIAL_ENDS_AT: "compose",
  LAF_TRIAL_HOLD_DAYS: "compose",
  LAF_DAILY_TOKEN_BUDGET: "compose",
} as const satisfies Record<string, VariableSource>;

export type VariableName = keyof typeof ENVIRONMENT;

/**
 * The variables the tenant package's `${NAME}` references resolve against.
 *
 * Named here rather than handing the package the whole environment, so this list stays the one
 * place a variable the server reads is declared. `configuration-documents.test.ts` fails when a file
 * in `tenant/laf` names a variable that is not in it.
 */
export const TENANT_PACKAGE_VARIABLES = [
  "BOT_MODEL",
  "BOT_MODEL_EFFORT",
  "REVIEW_MODEL",
] as const satisfies readonly VariableName[];

/**
 * A free trial's lines in `.env`, in the order the self-serve contract's table gives them (§4.5).
 *
 * A wire contract with laf-control rather than a private spelling: the fleet writes these at
 * provision and pushes them again (`laf trial extend`, `laf trial budget`), and its
 * `PUSHED_ENV_NAMES` owns the same four. `server/tests/trial-env-contract.test.ts` holds compose and
 * `.env.example` to this list.
 */
export const TRIAL_VARIABLES = [
  "LAF_PLAN",
  "LAF_TRIAL_ENDS_AT",
  "LAF_TRIAL_HOLD_DAYS",
  "LAF_DAILY_TOKEN_BUDGET",
] as const satisfies readonly VariableName[];

export type DeploymentConfig = {
  databaseUrl: string;
  /**
   * Where this process listens. 3001 unless a local run says otherwise; the image is built around
   * that number — Caddy proxies to it and compose's healthcheck asks it — so compose never sets one.
   * Zero asks for any free port, which is how a test starts the server and reads the port back.
   */
  port: number;
  keyEncryptionKey: string;
  /**
   * What the provider tokens a sign-in stores in `accounts` are sealed under. Its own key, 32 bytes
   * as hex — see auth/token-encryption.ts.
   */
  tokenEncryptionKey: string;
  managedAgentAgUiUrl: URL;
  tenantPackageDirectory: string;
  /** What the package's `${NAME}` references resolve against: see {@link TENANT_PACKAGE_VARIABLES}. */
  tenantPackageVariables: Readonly<Record<string, string | undefined>>;
  /**
   * Where this server's own model calls go — the auto-review judge, its probe, a demonstration's
   * write-up — and the key they fall back to when the vault holds none.
   *
   * `OPENAI_BASE_URL` is where everything in this deployment reaches a model, `agent-bot` included;
   * unset, it is OpenAI. The key is only the fallback: the vault is asked first, per call, so a
   * revoked credential takes effect on the next action rather than on the next restart.
   */
  model: { baseUrl: string; apiKey?: string };
  /**
   * The wall clock a Bot is told about, and what "night" means in the approval metrics.
   *
   * `BOT_TIME_ZONE` rather than the host's own zone: the VM may be anywhere and the person is in
   * Korea. An unusable name falls back to Seoul rather than refusing to start — a typo in a
   * deployment's environment should not stop every Bot answering, it should stop being believed —
   * and the fallback is said at boot, where it used to be silent in two places.
   */
  botTimeZone: string;
  /**
   * How long the audit trail and the run records are kept, in days. Zero keeps everything and
   * switches the sweep off. See `account/retention.ts`.
   */
  auditRetentionDays: number;
  /**
   * The agent harness's two switches for phase 2 (`~/laf/docs/agent-harness-design.md` rows 8–9).
   *
   * `jevEnabled` (`JEV_ENABLED`, OFF unless it says `on`): whether TypeSafe's Jev is asked anything —
   * compaction's keep-or-drop, auto-review's triage. Jev is hosted in the US; off, the deployment's
   * own model answers the same questions and nothing leaves for anyone new. What is sent when it is
   * on is redacted (`context/judge-redaction.ts`) and only its having been consulted is logged.
   *
   * `compaction` (`COMPACTION`): how a long conversation is compacted at `compactionThresholdTokens`
   * (`COMPACTION_THRESHOLD_TOKENS`) prompt tokens — `latest-snapshot`, `decisions`, or `off`. The
   * default is the arm `bun run eval:compaction` measured best (docs/laf/eval-pack.md).
   */
  harness: {
    jevEnabled: boolean;
    compaction: "off" | "latest-snapshot" | "decisions";
    compactionThresholdTokens: number;
  };
  /**
   * `PUBLIC_ORIGIN`: the deployed address, and what the fleet and the operator's alert channel
   * know this deployment by. Absent on a laptop.
   */
  publicOrigin?: string;
  /**
   * The two webhooks the notification outbox can reach besides the page itself.
   *
   * `webhookUrl` is the person's buzz (`LAF_NOTIFY_WEBHOOK_URL`); `alertWebhookUrl` is the fleet's
   * alert channel (`LAF_ALERT_WEBHOOK_URL`), the only door a `support.feedback` row goes through.
   * Each is a URL or absent: a value that is not one used to boot quietly and fail at the first
   * notification, which is the moment nobody is watching the log.
   */
  notifications: { webhookUrl?: string; alertWebhookUrl?: string };
  /**
   * How long a Bot's stream may say nothing before this deployment ends the turn, in milliseconds.
   *
   * Zero means no watchdog, and an unset variable means zero. A turn that is ended is a turn
   * somebody loses, so a deployment that has not said it wants that gets the behaviour it already
   * had. `.env.example` ships a value, so a new clone starts with the watch on and an upgraded
   * deployment does not acquire it without being asked.
   */
  agentStallTimeoutMs: number;
  /**
   * The origins a browser is allowed to say a state-changing request came from.
   *
   * TOP LEVEL, not only under `auth`. It was only ever read as better-auth's own list, so a
   * deployment with authentication switched off had nowhere to say it — and the check that needs it
   * most is the one on every other `/api` route, which exists whether or not sign-in does. Both
   * halves read this one field, so a deployment cannot trust one set of origins for its sign-in and
   * a different set for everything else. See auth/origin.ts.
   */
  trustedOrigins: string[];
  auth?: {
    baseUrl: string;
    secret: string;
    /** The sign-in routes better-auth mounts. At least one, or `auth` is absent entirely. */
    providers: {
      google?: OAuthClient;
      kakao?: OAuthClient;
      naver?: OAuthClient;
    };
    /**
     * The fleet's login broker (auth.<product domain>), as a generic OIDC
     * provider named `laf`. A PUBLIC client on purpose: the broker's registry
     * holds no secrets, the code is bound by PKCE, and the redirect is pinned
     * to this deployment's own callback — so there is no secret to configure
     * here either. Issuer and client id travel together or not at all.
     */
    lafOidc?: { issuer: string; clientId: string };
    trustedOrigins: string[];
    initialAdminEmails: string[];
    /**
     * Who may sign in: see auth/allowlist.ts. Admin emails are always admitted on top.
     */
    allowedEmails: string[];
    /**
     * Whether those two lines are a closed door. Always true in production, where a deployment that
     * does not name exactly one address between them refuses to start (see {@link authConfig}) — so
     * the one address closes the door even when it is written only as the administrator. Elsewhere,
     * true once `SIGN_IN_ALLOWED_EMAILS` names anybody; unset leaves a laptop open, and says so.
     */
    allowlistEnforced: boolean;
  };
  /**
   * Local development only: admit everybody as a fixed administrator instead of requiring sign-in.
   * See auth/dev-actor.ts for the two locks that stop this reaching a deployment.
   */
  devNoAuth: boolean;
  /**
   * The Bot computer. Absent means the feature is off and its routes are not mounted, rather than
   * mounted and failing: a capability that is not configured should be missing, not broken.
   */
  computer?: {
    baseUrl: string;
    /** The secret every computer requires of its caller. */
    token?: string;
    /** True on a laptop, where browsing the deployment's own services is the point. */
    allowPrivateHosts: boolean;
    /**
     * What Bots may do on their computers. Absent means the built-in default applies.
     *
     * A whole policy in one variable rather than a variable per rule, because the rules are an
     * ordered pair of lists and splitting them across `AGENT_COMPUTER_DENY_1`-style names makes their
     * precedence, which is the only subtle thing about them, impossible to see.
     */
    policy?: ActionPolicy;
    /**
     * How long two identical calls count as the same repetition, in milliseconds.
     *
     * Absent uses the built-in window, which assumes a retry loop is a model round trip apart. It is
     * here because that assumption is about someone else's model: a deployment on a slow or heavily
     * queued provider can have genuine retries minutes apart, and there the built-in window counts
     * every attempt as the first one and a rule about repetition never fires at all.
     */
    repeatWindowMs?: number;
  };
  /**
   * Where a person arriving and a person leaving reach the fleet tool.
   *
   * Absent means this deployment tells nobody, which is the correct state on a laptop and the wrong
   * one on a VM: a withdrawal would be complete in the database and invisible to the only thing
   * that can destroy the machine. Said out loud at boot rather than inferred, for that reason.
   *
   * `origin` is `PUBLIC_ORIGIN` and it is how the fleet knows which customer this is. It travels
   * with the pair rather than being read at the call site, so a deployment cannot end up signing a
   * notice that names nobody.
   */
  fleet?: {
    webhookUrl: string;
    secret: string;
    origin: string;
  };
  /**
   * `LAF_FLEET_METRICS_TOKEN`: the bearer the fleet presents to read `GET /api/admin/metrics/insights`.
   *
   * The other direction from `fleet` above, and deliberately a separate secret: that one signs what
   * this deployment SENDS to a machine that destroys VMs; this one admits a reader to counts. A leak
   * of one should cost exactly one of the two.
   *
   * Absent means the route is not mounted at all, so a laptop — or a VM the fleet has not handed a
   * token — answers that path with the same 404 as a path that does not exist, and advertises
   * nothing. Present, it is at least 32 characters: the door is on the public internet, and a short
   * token is one somebody can guess.
   */
  fleetMetricsToken?: string;
  /**
   * What this deployment can offer as a one-press 연결, and how a vendor gets the browser back.
   *
   * Both halves are the FLEET's rather than this deployment's, which is the whole shape of the
   * decision: LAF registers one OAuth application per vendor and one relay address, and every VM
   * carries the same values. A customer never sees a developer console.
   */
  connectors: {
    /** The applications LAF registered, by vendor. Missing means that vendor is not offered here. */
    clients: Partial<Record<SharedClientFamily, SharedOAuthClient>>;
    /**
     * The API keys LAF obtained, by vendor, for data that is everybody's (나라장터, 기업마당).
     *
     * The value rather than a boolean, unlike `partners`, because the one module that spends it is
     * assembled by the process from this object rather than reading the environment a second time.
     * Missing means the entry is not offered here. A key in the spelling that cannot work refuses
     * to start — see `plugins/shared-clients.ts`.
     */
    keys: Partial<Record<DeploymentKeyFamily, string>>;
    /**
     * The fleet's relay, and this deployment's own name in front of it.
     *
     * Absent means every vendor is told this deployment's own callback, which is right on a laptop
     * and for a vendor that registers a client per deployment. Present, it is the one address a
     * fleet-wide application can have registered — see docs/laf/connections.md.
     */
    relay?: { url: string; slug: string; productDomain: string };
  };
  /**
   * The partner vendors LAF holds the ACCOUNT at, and the keys this VM was given for them.
   *
   * The third shape a connector can have, after "the person's own grant" and "a token an
   * administrator pasted": LAF is 솔라피's customer, and each business is registered underneath
   * through a screen in this product. So the credential is fleet configuration, the same on every VM
   * that offers the connector and absent on every VM that does not.
   *
   * THE VALUES, NOT BOOLEANS — the same decision as `connectors.keys`. These were booleans while the
   * modules read their own settings out of the environment a second time, per call; they are parsed
   * here once, by `solapiSettings`, which is still the one place that knows what a 솔라피 key looks
   * like, and the modules are handed what it parsed. The boot-time refusal stays here too: a
   * half-configured partner is refused before the process starts rather than discovered by somebody
   * pressing 연결. See {@link partnersConfig}.
   */
  partners: {
    /** 카카오 알림톡, through 솔라피's agency API. Null when this VM holds no key. */
    alimtalk: SolapiSettings | null;
  };
  /**
   * A free trial, as the fleet provisioned it. Absent on every deployment that is not one — which
   * is every VM made before self-serve, every paid one, and a laptop — and then nothing is judged
   * and no banner is drawn.
   *
   * `endsAt` is kept as the string `.env` carries rather than as a `Date`: `GET /api/me` says it
   * back, and "the four values equal the `.env`" is how an operator reads that a push arrived
   * (self-serve contract §13.3). It is validated as one instant in UTC before it gets here.
   *
   * What a day may spend is judged by `usage/daily-budget.ts` against the Seoul day; `holdDays` is a
   * fact for the surface. See {@link trialConfig} for why the four travel together or not at all.
   */
  trial?: {
    /** ISO-8601 in UTC: the fleet writes 23:59:59 in Seoul on the trial's last day. */
    endsAt: string;
    /** How long a stopped trial is kept before it is destroyed. */
    holdDays: number;
    /** Tokens a Seoul day may spend across every Bot on this VM, checked before each run starts. */
    dailyTokenBudget: number;
  };
};

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: VariableName): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function optional(
  environment: Environment,
  name: VariableName,
): string | undefined {
  return environment[name]?.trim() || undefined;
}

/**
 * The key in `.env.example`, which every clone of this repository starts with.
 *
 * It is a valid key, which is the whole problem: it is the right length and the right encoding, so
 * nothing about it fails a check. A deployment that never changed it encrypts its credential vault
 * with a key printed in a public repository, and looks exactly like one that did.
 */
const PLACEHOLDER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function keyEncryptionKey(environment: Environment): string {
  const value = required(environment, "KEY_ENCRYPTION_KEY");
  const decoded = Buffer.from(value, "base64");

  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  /**
   * Refused in production, warned everywhere else. The placeholder is convenient locally and public
   * in any deployment.
   */
  if (value === PLACEHOLDER_KEY) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "KEY_ENCRYPTION_KEY is still the example key from .env.example, which is public. Generate one with: openssl rand -base64 32",
      );
    }
    log.warn("encryption_key_is_example", {
      note: "KEY_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -base64 32",
    });
  }

  return value;
}

/** What stands in for `LAF_TOKEN_ENCRYPTION_KEY` under `bun test`, which sets `NODE_ENV=test` itself. */
export const TEST_TOKEN_ENCRYPTION_KEY = "7e57".repeat(16);

/** The token key in `.env.example`: public, like the vault key's, and refused where that one is. */
const EXAMPLE_TOKEN_ENCRYPTION_KEY = "0".repeat(64);

/**
 * The key the stored sign-in tokens are sealed under, or a refusal to start.
 *
 * REQUIRED ON EVERY DEPLOYMENT, whether or not it has sign-in yet. The fleet mints it at provision
 * beside `BETTER_AUTH_SECRET` and with no domain at all (laf-control `c2483e0`), and a deployment
 * that gains sign-in later must not first write a token in the clear — the state this key exists
 * to end (A8 S1, 2026-09-10: `ya29.…` in a `pg_dump`). The one escape is a test run: `loadConfig`
 * is handed environments the tests build, which carry no `NODE_ENV`, while `bun test` sets it on
 * the process — so the environment is asked first and the process second, and a test that wants
 * the refusal says `NODE_ENV: "production"`.
 */
function tokenEncryptionKey(environment: Environment): string {
  const value = optional(environment, "LAF_TOKEN_ENCRYPTION_KEY");
  if (!value) {
    if ((environment.NODE_ENV ?? process.env.NODE_ENV) === "test") {
      return TEST_TOKEN_ENCRYPTION_KEY;
    }
    throw new Error(
      "LAF_TOKEN_ENCRYPTION_KEY is required: the tokens a sign-in stores are sealed under it. Generate one with: openssl rand -hex 32",
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(
      "LAF_TOKEN_ENCRYPTION_KEY must be 32 bytes written as 64 hex characters (openssl rand -hex 32)",
    );
  }
  if (value === EXAMPLE_TOKEN_ENCRYPTION_KEY) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "LAF_TOKEN_ENCRYPTION_KEY is still the example key from .env.example, which is public. Generate one with: openssl rand -hex 32",
      );
    }
    log.warn("token_encryption_key_is_example", {
      note: "LAF_TOKEN_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -hex 32",
    });
  }
  return value.toLowerCase();
}

function url(environment: Environment, name: VariableName): string | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function requiredHttpUrl(environment: Environment, name: VariableName): URL {
  const value = required(environment, name);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  return parsed;
}

export type OAuthClient = { clientId: string; clientSecret: string };

function oauthClient(
  environment: Environment,
  provider: "GOOGLE" | "KAKAO" | "NAVER",
): OAuthClient | undefined {
  const clientId = optional(environment, `${provider}_OAUTH_CLIENT_ID`);
  const clientSecret = optional(environment, `${provider}_OAUTH_CLIENT_SECRET`);

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      `${provider}_OAUTH configuration requires both client ID and client secret`,
    );
  }

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** The broker pair: both or neither, like every half-configured sign-in. */
function lafOidcClient(
  environment: Environment,
): { issuer: string; clientId: string } | undefined {
  const issuer = optional(environment, "LAF_OIDC_ISSUER");
  const clientId = optional(environment, "LAF_OIDC_CLIENT_ID");
  if (Boolean(issuer) !== Boolean(clientId)) {
    throw new Error(
      "LAF_OIDC configuration requires both LAF_OIDC_ISSUER and LAF_OIDC_CLIENT_ID",
    );
  }
  if (!issuer || !clientId) return undefined;
  requiredHttpUrl({ LAF_OIDC_ISSUER: issuer }, "LAF_OIDC_ISSUER");
  // No trailing slash: the discovery URL is assembled from this.
  return { issuer: issuer.replace(/\/+$/, ""), clientId };
}

function commaSeparated(
  environment: Environment,
  name: VariableName,
): string[] {
  return (optional(environment, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const PROVIDER_NAMES = ["google", "kakao", "naver"] as const;
type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * The origins this deployment trusts, read once for everybody who needs them.
 *
 * The default is the Vite dev server, which is what a laptop is. A deployment names its own with
 * `TRUSTED_ORIGINS`; the installed shell loads the deployment's origin, so that is the one to list.
 */
function trustedOrigins(environment: Environment): string[] {
  const configured = commaSeparated(environment, "TRUSTED_ORIGINS");
  return configured.length > 0 ? configured : ["http://localhost:3000"];
}

function authConfig(
  environment: Environment,
  providers: Partial<Record<ProviderName, OAuthClient>>,
): DeploymentConfig["auth"] {
  const secret = optional(environment, "BETTER_AUTH_SECRET");
  const baseUrl = url(environment, "BETTER_AUTH_URL");
  const configured = PROVIDER_NAMES.filter((name) => providers[name]);

  /*
   * AUTH_PROVIDERS is the deployment's declaration, and it must agree with the credentials.
   *
   * The declaration exists because two other things are keyed off it and cannot read the
   * credentials: the compose file decides whether to pass BETTER_AUTH_* at all, and the web image
   * bakes the sign-in buttons at build time. A declaration that names a provider with no
   * credentials would draw a button that posts into an error; credentials without the declaration
   * would accept sign-ins the surface never offers. Both are refused by name rather than served.
   */
  const declared = commaSeparated(environment, "AUTH_PROVIDERS");
  const lafOidc = lafOidcClient(environment);
  // `laf` is declared like the direct providers but keyed by its own pair —
  // the broker's issuer and a public client id, no secret anywhere.
  const declarable = [...PROVIDER_NAMES, "laf"];
  if (declared.length > 0) {
    for (const name of declared) {
      if (!declarable.includes(name)) {
        throw new Error(
          `AUTH_PROVIDERS names '${name}', which is not a provider this deployment knows (${declarable.join(", ")})`,
        );
      }
      if (name === "laf") {
        if (!lafOidc) {
          throw new Error(
            "AUTH_PROVIDERS names 'laf' but LAF_OIDC_ISSUER and LAF_OIDC_CLIENT_ID are not set",
          );
        }
        continue;
      }
      if (!providers[name as ProviderName]) {
        throw new Error(
          `AUTH_PROVIDERS names '${name}' but ${name.toUpperCase()}_OAUTH_CLIENT_ID is not set`,
        );
      }
    }
    if (lafOidc && !declared.includes("laf")) {
      throw new Error(
        "LAF_OIDC_ISSUER is set but AUTH_PROVIDERS does not name 'laf'. " +
          "The sign-in buttons are compiled from AUTH_PROVIDERS, and the API must not accept a " +
          "sign-in the surface never offers: add it there, or remove the broker settings.",
      );
    }
  }

  if (configured.length === 0 && !lafOidc) {
    if (secret || baseUrl) {
      throw new Error(
        "Authentication requires at least one OAuth client: set GOOGLE_, KAKAO_ or NAVER_OAUTH_CLIENT_ID and _SECRET, or the broker's LAF_OIDC_ISSUER and LAF_OIDC_CLIENT_ID",
      );
    }
    return undefined;
  }
  if (!secret) {
    throw new Error("Authentication requires BETTER_AUTH_SECRET");
  }
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  if (!baseUrl) {
    throw new Error("Authentication requires BETTER_AUTH_URL");
  }

  /*
   * Which providers actually reach the sign-in screen, which is no longer the same set as "has
   * credentials".
   *
   * `GOOGLE_OAUTH_*` acquired a second job: it is also the fleet's connector application, the one
   * every 구글 연결 consents under (`plugins/shared-clients.ts`). A VM that signs people in through
   * the broker therefore carries the pair without offering Google sign-in — and this function used
   * to REFUSE TO START on exactly that combination, which made the two features mutually exclusive
   * and was measured: `AUTH_PROVIDERS=laf` plus a Google connector client would not boot.
   *
   * The property that refusal was protecting is kept and is now enforced rather than complained
   * about: what is DECLARED is what the API registers, so a credential the surface does not offer
   * cannot be signed in with at all. With no declaration — a laptop — every configured pair is
   * offered, exactly as before.
   */
  const signIn: Partial<Record<ProviderName, OAuthClient>> =
    declared.length === 0
      ? providers
      : Object.fromEntries(
          configured
            .filter((name) => declared.includes(name))
            .map((name) => [name, providers[name]]),
        );

  const initialAdminEmails = commaSeparated(
    environment,
    "INITIAL_ADMIN_EMAILS",
  );
  const allowedEmails = commaSeparated(environment, "SIGN_IN_ALLOWED_EMAILS");
  return {
    baseUrl,
    secret,
    providers: signIn,
    ...(lafOidc ? { lafOidc } : {}),
    trustedOrigins: trustedOrigins(environment),
    initialAdminEmails,
    allowedEmails,
    allowlistEnforced: signInLock(environment, {
      allowedEmails,
      initialAdminEmails,
    }),
  };
}

/**
 * Whether the sign-in list is a closed door — or, on a production deployment that names anything
 * but one account, a refusal to start.
 *
 * ONE ACCOUNT PER DEPLOYMENT, BY THE OWNER'S DECISION (2026-09-16): "1계정 1VM을 코드로 강제한다."
 * Every Bot on a deployment opens the same browser profile, so a second account's Bots would browse
 * inside the first person's logins; the list used to fail open when unset and admit as many
 * addresses as it was given (audit 2026-09-16 S1-1). So production counts the addresses the two
 * lines admit together, compared the way the door compares them:
 *
 *   - none is a door open to anybody the sign-in provider authenticates. Refused.
 *   - more than one is a second person. Refused, with the count and never the addresses — this
 *     message lands in an operator's log, and the addresses are already in the `.env` beside it.
 *   - one closes the door, even when `INITIAL_ADMIN_EMAILS` is the only line that names it.
 *
 * Outside production the old rule stands — the allow variable alone arms the lock — because a
 * laptop and the test suites are not somebody's shop. An open door there is said once per load,
 * next to the example-key warnings, rather than refused. Whether a second ACCOUNT can be made is
 * not decided here in either case: the sign-in hook refuses that everywhere (`auth/admission.ts`).
 */
function signInLock(
  environment: Environment,
  lists: { allowedEmails: string[]; initialAdminEmails: string[] },
): boolean {
  if (environment.NODE_ENV === "production") {
    const count = admittedAddresses(lists).length;
    if (count === 0) {
      throw new Error(
        "A production deployment must name the one account it belongs to: set SIGN_IN_ALLOWED_EMAILS (or INITIAL_ADMIN_EMAILS) to that address. With neither, anybody the sign-in provider authenticates would get an account here, so the server refuses to start.",
      );
    }
    if (count > 1) {
      throw new Error(
        `SIGN_IN_ALLOWED_EMAILS and INITIAL_ADMIN_EMAILS name ${count} addresses between them, and a deployment belongs to exactly one account: every Bot on it shares one browser and its logins. Leave only the address this deployment belongs to.`,
      );
    }
    return true;
  }
  const enforced = lists.allowedEmails.length > 0;
  if (!enforced) {
    log.warn("sign_in_door_open", {
      note: "SIGN_IN_ALLOWED_EMAILS is unset, so anybody the sign-in provider authenticates may make the first account here. Fine on a laptop; production refuses to start this way.",
    });
  }
  return enforced;
}

function computerConfig(
  environment: Environment,
): DeploymentConfig["computer"] {
  const baseUrl = url(environment, "AGENT_COMPUTER_URL");
  if (!baseUrl) {
    return undefined;
  }
  const policy = actionPolicy(environment);
  /*
   * The secret the computers require. Without it every call to a computer is refused, and that is the
   * intended failure: `agent-computer` drives a browser holding real logins and must not answer
   * unauthenticated callers that can reach its port.
   */
  const computerToken = optional(environment, "COMPUTER_TOKEN");
  const repeatWindowMs = milliseconds(environment, "COMPUTER_REPEAT_WINDOW_MS");
  return {
    baseUrl,
    allowPrivateHosts:
      optional(environment, "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS") === "true",
    ...(policy ? { policy } : {}),
    ...(repeatWindowMs ? { repeatWindowMs } : {}),
    ...(computerToken ? { token: computerToken } : {}),
  };
}

/**
 * The fleet webhook, or a refusal to start.
 *
 * Optional as a whole and strict once it exists, the same shape as every half-configured thing in
 * this file. The URL alone would post an unsigned notice, and the endpoint on the other end
 * destroys machines — so a receiver that accepted one would take instructions from anybody who
 * could reach it. `PUBLIC_ORIGIN` is required for the same class of reason: the fleet identifies a
 * customer by origin, so a notice with an empty one is one nobody can act on, delivered and
 * recorded as though it had worked.
 */
function fleetConfig(environment: Environment): DeploymentConfig["fleet"] {
  const webhookUrl = url(environment, "LAF_FLEET_WEBHOOK_URL");
  if (!webhookUrl) {
    return undefined;
  }

  const secret = optional(environment, "LAF_FLEET_WEBHOOK_SECRET");
  if (!secret) {
    throw new Error(
      "LAF_FLEET_WEBHOOK_URL is set, so LAF_FLEET_WEBHOOK_SECRET must be too: the fleet destroys machines on these notices and will not act on an unsigned one",
    );
  }

  const origin = optional(environment, "PUBLIC_ORIGIN");
  if (!origin) {
    throw new Error(
      "LAF_FLEET_WEBHOOK_URL is set, so PUBLIC_ORIGIN must be too: the fleet identifies a customer by origin, never by email, and a notice without one names nobody",
    );
  }

  return { webhookUrl, secret, origin };
}

/** Long enough that guessing it is not a plan: what `openssl rand -hex 16` gives, at the least. */
const FLEET_METRICS_TOKEN_MIN_LENGTH = 32;

/**
 * The fleet's read token, or a refusal to start.
 *
 * Optional as a whole and strict once it exists, like the webhook above it. A token with whitespace
 * inside is one a shell or a `.env` line split somewhere, and the fleet would be refused with a
 * token that looks right on both ends; a short one is a door on the internet with a guessable key.
 * Either is refused at boot, by name, rather than discovered as a fleet that cannot read this VM.
 */
function fleetMetricsToken(environment: Environment): string | undefined {
  const token = optional(environment, "LAF_FLEET_METRICS_TOKEN");
  if (!token) return undefined;
  if (/\s/.test(token) || token.length < FLEET_METRICS_TOKEN_MIN_LENGTH) {
    throw new Error(
      `LAF_FLEET_METRICS_TOKEN must be at least ${FLEET_METRICS_TOKEN_MIN_LENGTH} characters with no whitespace: it is the only key to a door on the public internet. Generate one with: openssl rand -hex 32`,
    );
  }
  return token;
}

/**
 * The fleet's OAuth relay, and the name this deployment answers to underneath the product domain.
 *
 * WHY A SLUG HAS TO BE DERIVED AT ALL. Google and Cafe24 compare `redirect_uri` for exact equality
 * with what the application was registered with, and neither accepts a wildcard — so one
 * application shared by the fleet cannot name `https://<customer>.agent.laf-co.com/…`, because
 * there is one such string per customer and the next one does not exist yet. The relay is the one
 * address that CAN be registered, and the only thing it needs in order to hand the browser back is
 * which customer this consent belongs to. That is the slug, and it travels in front of the sealed
 * state (`plugins/oauth.ts`).
 *
 * THE PRODUCT DOMAIN IS DERIVED FROM THE RELAY, not configured a fourth time. The relay lives at
 * `auth.<product domain>`, so its parent domain is the domain every customer is a name under, and
 * a deployment that sets the relay has already said which fleet it belongs to. `LAF_PRODUCT_DOMAIN`
 * overrides it for the case that arrangement stops holding, and is otherwise not set anywhere.
 *
 * REFUSES TO START rather than guessing. A `PUBLIC_ORIGIN` outside the product domain has no slug
 * the fleet's allow-list would recognise, so every consent from that deployment would die at the
 * relay — after the person had already said yes at the vendor, which is the worst moment to find
 * out. The same reasoning as every other half-configured thing in this file.
 */
function connectorsConfig(
  environment: Environment,
): DeploymentConfig["connectors"] {
  const clients = sharedClientsFrom(environment);
  // Refuses to start on the spelling that cannot work, like every half-configured thing here.
  const keys = deploymentKeysFrom(environment);

  const relayUrl = url(environment, "LAF_OAUTH_RELAY_URL");
  if (!relayUrl) return { clients, keys };

  const relay = new URL(relayUrl);
  if (relay.protocol !== "https:" && relay.hostname !== "localhost") {
    throw new Error(
      "LAF_OAUTH_RELAY_URL must be https: it is the address vendors are told to send an authorization code to",
    );
  }

  const labels = relay.hostname.split(".");
  const productDomain =
    optional(environment, "LAF_PRODUCT_DOMAIN") ?? labels.slice(1).join(".");
  if (!productDomain) {
    throw new Error(
      "LAF_OAUTH_RELAY_URL names no product domain (it should live at auth.<domain>), so set LAF_PRODUCT_DOMAIN",
    );
  }

  const origin = optional(environment, "PUBLIC_ORIGIN");
  if (!origin) {
    throw new Error(
      "LAF_OAUTH_RELAY_URL is set, so PUBLIC_ORIGIN must be too: the relay hands the browser back to this deployment by name, and a deployment with no origin has none",
    );
  }

  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a valid URL");
  }

  const suffix = `.${productDomain}`;
  const slug = hostname.endsWith(suffix)
    ? hostname.slice(0, -suffix.length)
    : "";
  // One label, and a real one. A slug carrying a dot would name a deeper host than the fleet's
  // allow-list holds, and it is also the separator the state is split on.
  if (!isCustomerSlug(slug)) {
    throw new Error(
      `PUBLIC_ORIGIN (${origin}) is not one name under ${productDomain}, so the OAuth relay has no customer to hand the browser back to. Every deployment on the relay is https://<name>${suffix}`,
    );
  }

  return {
    clients,
    keys,
    // No trailing slash: the provider segment is appended to this.
    relay: { url: relayUrl.replace(/\/+$/, ""), slug, productDomain },
  };
}

/**
 * Which partner vendors this VM was given LAF's keys for, and a refusal to start over half of one.
 *
 * THE RULE IS THE SAME ONE `sharedClientsFrom` KEEPS, and it is here for the same reason: a
 * connector half configured fails at the moment somebody is trying to use it, which is the worst
 * moment to find out. A 솔라피 key with no secret in it cannot sign a request, and that cannot be
 * discovered from anything but a live call, so it is refused at boot with the name of what is wrong.
 *
 * ABSENT IS NOT A FAILURE. A VM with the variable unset offers no connector, draws no card, and is
 * a correct deployment — which is what the boolean says.
 */
function partnersConfig(
  environment: Environment,
): DeploymentConfig["partners"] {
  /*
   * 솔라피's key is `key:secret` in ONE variable because the two are issued together and are useless
   * apart. So the half-configured state here is not a missing variable, it is a value that is not a
   * pair — and a deployment that set `LAF_ALIMTALK_API_KEY=abc` would otherwise start, draw the
   * card, and refuse every connect with a code that reads as the vendor's fault.
   */
  const alimtalkKey = optional(environment, "LAF_ALIMTALK_API_KEY");
  if (alimtalkKey) {
    const separator = alimtalkKey.indexOf(":");
    if (separator <= 0 || separator === alimtalkKey.length - 1) {
      throw new Error(
        "LAF_ALIMTALK_API_KEY must be the pair 솔라피 issues, written apiKey:apiSecret — one half of it signs nothing",
      );
    }
  } else if (optional(environment, "LAF_ALIMTALK_BASE_URL")) {
    throw new Error(
      "LAF_ALIMTALK_BASE_URL is set without LAF_ALIMTALK_API_KEY: an address with no key behind it is a connector that cannot complete a single call",
    );
  }

  return { alimtalk: alimtalkKey ? solapiSettings(environment) : null };
}

/**
 * A duration in milliseconds, or a refusal to start.
 *
 * Refused rather than quietly defaulted, for the same reason a malformed policy is. An operator who
 * widened a window and typed `3m` would otherwise get a running deployment on the built-in value,
 * and the only evidence would be a rule that never fires, which reads exactly like a Bot behaving
 * itself.
 */
function milliseconds(
  environment: Environment,
  name: VariableName,
): number | undefined {
  const raw = optional(environment, name);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds`);
  }
  return value;
}

/**
 * The action policy, as JSON in one variable.
 *
 * Refuses to start on malformed JSON or a policy of the wrong shape, rather than falling back to the
 * default. An operator who wrote a rule and mistyped it would otherwise get a running deployment that
 * silently permits what they had just tried to forbid, and no indication that anything was wrong.
 * Configuration the product cannot honour belongs at the boot boundary; see the note at the top.
 */
function actionPolicy(environment: Environment): ActionPolicy | undefined {
  const raw = optional(environment, "AGENT_COMPUTER_POLICY");
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_COMPUTER_POLICY must be valid JSON");
  }

  const result = parseActionPolicy(parsed);
  if (!result.ok) {
    // The parser answers in codes now; the list it names is the part an operator edits.
    throw new Error(
      `AGENT_COMPUTER_POLICY is invalid: ${result.code}${result.list ? ` (${result.list})` : ""}`,
    );
  }
  return result.policy;
}

/**
 * A minute: what `.env.example` ships, and the silence `agent-bot`'s fifteen-second heartbeat was
 * sized against ("its stall watchdog ends the turn at the configured silence (60 s by default)").
 */
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/**
 * How long silence on a Bot's stream is allowed to last. A minute, unless the deployment says.
 *
 * UNSET USED TO MEAN OFF, and that put the watchdog on every developer's machine and on no
 * customer's: `.env.example` ships 60000, but the fleet's `.env` is written by laf-control and
 * never carried the variable, and compose passes `${AGENT_STALL_TIMEOUT_MS:-}` — so every VM ran
 * with the value nobody had written, which was zero (audit A2 §2, 2026-09-10). The default is now
 * the value the code has always documented as its own, and off is a value an operator has to write.
 *
 * Refuses to start on anything that is not a whole number of milliseconds, rather than falling back
 * to the default. Same reasoning as the action policy above it: an operator who meant to write a
 * two-minute timeout and typed something else would otherwise get a running deployment with a
 * silently different boundary, and no indication that anything was wrong.
 *
 * Zero is a legitimate value and means off. It is not the same as a malformed one.
 */
/** The compaction arm a deployment runs when `COMPACTION` says nothing. See `harness`. */
export const DEFAULT_COMPACTION = "decisions" as const;

/** Prompt tokens at which a conversation is compacted when `COMPACTION_THRESHOLD_TOKENS` says nothing. */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 60_000;

/**
 * The harness's switches, or a refusal to start. A value that is not one of the words is a typo,
 * and a typo in a privacy switch must not boot as whichever way the parser leaned.
 */
function harnessConfig(environment: Environment): DeploymentConfig["harness"] {
  const jev = optional(environment, "JEV_ENABLED")?.toLowerCase();
  if (jev !== undefined && jev !== "on" && jev !== "off") {
    throw new Error("JEV_ENABLED must be on or off (unset is off)");
  }
  const mode = optional(environment, "COMPACTION") ?? DEFAULT_COMPACTION;
  if (mode !== "off" && mode !== "latest-snapshot" && mode !== "decisions") {
    throw new Error(
      "COMPACTION must be latest-snapshot, decisions or off (unset is the measured default)",
    );
  }
  const raw = optional(environment, "COMPACTION_THRESHOLD_TOKENS");
  const threshold = raw ? Number(raw) : DEFAULT_COMPACTION_THRESHOLD_TOKENS;
  if (!Number.isInteger(threshold) || threshold < 4_000) {
    throw new Error(
      "COMPACTION_THRESHOLD_TOKENS must be a whole number of tokens, 4000 or more",
    );
  }
  return {
    jevEnabled: jev === "on",
    compaction: mode,
    compactionThresholdTokens: threshold,
  };
}

function agentStallTimeoutMs(environment: Environment): number {
  const raw = optional(environment, "AGENT_STALL_TIMEOUT_MS");
  if (!raw) {
    return DEFAULT_STALL_TIMEOUT_MS;
  }

  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "AGENT_STALL_TIMEOUT_MS must be a whole number of milliseconds, or 0 to switch the watchdog off",
    );
  }
  return milliseconds;
}

/** What the image serves on, and what every local instruction in this repository assumes. */
const DEFAULT_PORT = 3001;

/**
 * Where to listen, or a refusal to start.
 *
 * MEASURED BY AUDIT A1 (2026-09-10): this was `Number.parseInt(process.env.PORT ?? "3001")` in
 * `main.ts`, and `PORT=abc` is `NaN`, which Bun reads as "any port" — the server opened on 49953,
 * wrote `port: 49953` on a boot line that looked perfectly healthy, and Caddy went on waiting at
 * 3001. A deployment whose front door answers that the API is not there while its log says it booted
 * is the failure every other refusal in this file exists to prevent. Digits only: `3001abc` was 3001
 * to `parseInt`.
 */
function port(environment: Environment): number {
  const raw = optional(environment, "PORT");
  if (!raw) return DEFAULT_PORT;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > 65_535) {
    throw new Error(
      "PORT must be a whole number from 0 to 65535 (0 asks for any free port)",
    );
  }
  return value;
}

/** Where a model is reached when nothing says otherwise. */
const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";

/**
 * The endpoint and fallback key for the server's own model calls.
 *
 * An address that is not an HTTP(S) URL refuses to start. It used to boot and fail at the auto-review
 * probe, which reported honestly — but only by switching a control off, which is a long way from the
 * variable that caused it.
 */
function modelEndpoint(environment: Environment): DeploymentConfig["model"] {
  const baseUrl = optional(environment, "OPENAI_BASE_URL");
  // Checked, and then kept as written rather than as `URL` would print it: the client appends its
  // path to this string, and a slash `URL` added would change the address.
  if (baseUrl) requiredHttpUrl(environment, "OPENAI_BASE_URL");
  const apiKey = optional(environment, "OPENAI_API_KEY");
  return {
    baseUrl: baseUrl ?? DEFAULT_MODEL_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** The zone a Bot is told the time in, falling back to Seoul — out loud — on a name nobody knows. */
function botTimeZone(environment: Environment): string {
  const configured = optional(environment, "BOT_TIME_ZONE");
  const zone = resolveTimeZone(configured);
  if (configured && zone !== configured) {
    log.warn("bot_time_zone_unknown", {
      configured,
      using: DEFAULT_TIME_ZONE,
      note: "BOT_TIME_ZONE is not a time zone this runtime knows, so every Bot is told the time in Seoul. Use an IANA name such as Asia/Seoul.",
    });
  }
  return zone;
}

/** The declared package variables, and nothing else of the environment. */
function tenantPackageVariables(
  environment: Environment,
): DeploymentConfig["tenantPackageVariables"] {
  return Object.freeze(
    Object.fromEntries(
      TENANT_PACKAGE_VARIABLES.map((name) => [name, environment[name]]),
    ),
  );
}

/** One instant in UTC as the fleet writes it: seconds, optional milliseconds, and `Z`. */
const UTC_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/**
 * Whether `value` names a moment that exists, read the way it is written.
 *
 * `Date.parse` alone is not the check: it rolls `2026-02-30` over into March and calls that fine, so
 * the parts are put back together and compared. A date a person mistyped would otherwise draw a
 * countdown to a day nobody chose.
 */
function isUtcInstant(value: string): boolean {
  const parts = UTC_INSTANT.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second
  );
}

/** A whole number of at least one, digits only, or a refusal naming the variable and its unit. */
function positiveWhole(
  environment: Environment,
  name: VariableName,
  unit: string,
): number {
  const raw = optional(environment, name) ?? "";
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(
      `${name} must be a whole number of ${unit}, at least 1, written in digits alone (it is '${raw}')`,
    );
  }
  return value;
}

/**
 * A free trial, or a refusal to start over half of one.
 *
 * ALL FOUR OR NONE (self-serve contract §4.5), the rule every half-configured thing in this file
 * keeps. The fleet writes the four together at provision and pushes them together, so any other
 * shape is a mistake somewhere, and each half is a promise nothing keeps: an end date with no budget
 * is a trial that can spend without limit, a budget or a date on a VM that is not a trial limits and
 * counts down to nothing, and a date the surface cannot read counts towards the wrong day.
 *
 * `LAF_PLAN` HAS ONE VALUE. Unset is not a trial; `trial` is one; anything else is refused rather than
 * read as unset, because "not a trial" is the reading with no budget — a typo would be the expensive
 * direction, found on an invoice.
 *
 * A BUDGET OF ONE IS A BUDGET, and it is how an operator proves a push reached the server (the first
 * run of the day is refused). Zero is refused rather than read: elsewhere in this file zero means
 * "switched off", and a trial whose budget an operator believed was off would be one refusing every
 * question.
 */
function trialConfig(environment: Environment): DeploymentConfig["trial"] {
  const plan = optional(environment, "LAF_PLAN");
  const lines = [
    "LAF_TRIAL_ENDS_AT",
    "LAF_TRIAL_HOLD_DAYS",
    "LAF_DAILY_TOKEN_BUDGET",
  ] as const;
  const present = lines.filter((name) => optional(environment, name));

  if (!plan) {
    if (present.length === 0) return undefined;
    throw new Error(
      `${present.join(", ")} ${present.length === 1 ? "is" : "are"} set but LAF_PLAN is not: these lines belong to a free trial, and on a deployment that is not one they limit nothing and count down to nothing. Set LAF_PLAN=trial with all of them, or remove them`,
    );
  }
  if (plan !== "trial") {
    throw new Error(
      `LAF_PLAN is '${plan}', and the only plan this deployment knows is 'trial'. Remove the line on a deployment that is not a trial; anything else is refused rather than read as no trial, which is the reading with no budget`,
    );
  }
  const missing = lines.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `LAF_PLAN=trial needs LAF_TRIAL_ENDS_AT, LAF_TRIAL_HOLD_DAYS and LAF_DAILY_TOKEN_BUDGET together, and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing: a trial with no end never ends on screen, and one with no budget spends without limit`,
    );
  }

  const endsAt = optional(environment, "LAF_TRIAL_ENDS_AT") ?? "";
  if (!isUtcInstant(endsAt)) {
    throw new Error(
      `LAF_TRIAL_ENDS_AT must be one instant in UTC, written like 2026-09-29T14:59:59Z — the end of the trial's last day in Seoul (it is '${endsAt}')`,
    );
  }
  return {
    endsAt,
    holdDays: positiveWhole(environment, "LAF_TRIAL_HOLD_DAYS", "days"),
    dailyTokenBudget: positiveWhole(
      environment,
      "LAF_DAILY_TOKEN_BUDGET",
      "tokens",
    ),
  };
}

export function loadConfig(
  environment: Environment = process.env,
): DeploymentConfig {
  const providers = {
    ...(oauthClient(environment, "GOOGLE")
      ? { google: oauthClient(environment, "GOOGLE") }
      : {}),
    ...(oauthClient(environment, "KAKAO")
      ? { kakao: oauthClient(environment, "KAKAO") }
      : {}),
    ...(oauthClient(environment, "NAVER")
      ? { naver: oauthClient(environment, "NAVER") }
      : {}),
  };

  return {
    databaseUrl: required(environment, "DATABASE_URL"),
    keyEncryptionKey: keyEncryptionKey(environment),
    tokenEncryptionKey: tokenEncryptionKey(environment),
    managedAgentAgUiUrl: requiredHttpUrl(
      environment,
      "MANAGED_AGENT_AG_UI_URL",
    ),
    tenantPackageDirectory:
      optional(environment, "TENANT_PACKAGE_DIR") ?? "../tenant/laf",
    agentStallTimeoutMs: agentStallTimeoutMs(environment),
    trustedOrigins: trustedOrigins(environment),
    auth: authConfig(environment, providers),
    devNoAuth: devAuthEnabled(environment),
    computer: computerConfig(environment),
    fleet: fleetConfig(environment),
    fleetMetricsToken: fleetMetricsToken(environment),
    connectors: connectorsConfig(environment),
    partners: partnersConfig(environment),
    // Read after everything above, so a refusal that existed before these did still comes first.
    port: port(environment),
    publicOrigin: url(environment, "PUBLIC_ORIGIN"),
    notifications: {
      webhookUrl: url(environment, "LAF_NOTIFY_WEBHOOK_URL"),
      alertWebhookUrl: url(environment, "LAF_ALERT_WEBHOOK_URL"),
    },
    model: modelEndpoint(environment),
    tenantPackageVariables: tenantPackageVariables(environment),
    botTimeZone: botTimeZone(environment),
    auditRetentionDays: retentionDays(environment),
    harness: harnessConfig(environment),
    trial: trialConfig(environment),
  };
}
