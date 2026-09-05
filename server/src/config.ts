/**
 * Everything a deployment is told about itself, read from the environment once.
 *
 * There is one runtime and no switch for it. Upstream reads its durable threads and memory out of
 * CopilotKit Intelligence; this fork's rule is that the only external dependencies are the model
 * API and the machines it runs on, so conversations live in our own Postgres (runner/laf-runner.ts)
 * and always have. The four `INTELLIGENCE_*` variables, the mode union and the branch behind them
 * were carried for a deployment shape nobody ever stood up, and are gone — git has them.
 */
import { devAuthEnabled } from "./auth/dev-actor";
import type { ActionPolicy } from "./computer/policy";
import { parseActionPolicy } from "./computer/policy-store";
import type { SharedClientFamily } from "./plugins/catalogue";
import { isCustomerSlug } from "./plugins/oauth";
import {
  type SharedOAuthClient,
  sharedClientsFrom,
} from "./plugins/shared-clients";

export type DeploymentConfig = {
  databaseUrl: string;
  keyEncryptionKey: string;
  managedAgentAgUiUrl: URL;
  tenantPackageDirectory: string;
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
     * Who may sign in. Empty means open — the pre-lock behavior every existing setup relies on.
     * Set, it is the door: see auth/allowlist.ts. Admin emails are always admitted on top.
     */
    allowedEmails: string[];
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
     * The fleet's relay, and this deployment's own name in front of it.
     *
     * Absent means every vendor is told this deployment's own callback, which is right on a laptop
     * and for a vendor that registers a client per deployment. Present, it is the one address a
     * fleet-wide application can have registered — see docs/laf/connections.md.
     */
    relay?: { url: string; slug: string; productDomain: string };
  };
  /**
   * The partner vendors LAF holds the ACCOUNT at, and whether this VM was given the keys.
   *
   * The third shape a connector can have, after "the person's own grant" and "a token an
   * administrator pasted": LAF is 솔라피's customer, and each business is registered underneath
   * through a screen in this product. So the credential is fleet configuration, the same on every VM
   * that offers the connector and absent on every VM that does not.
   *
   * Booleans rather than the values. The modules read their own settings out of the environment —
   * one place that knows what a 솔라피 key looks like — and what belongs HERE is the boot-time
   * refusal: a half-configured partner is refused before the process starts rather than discovered
   * by somebody pressing 연결. See {@link partnersConfig}.
   */
  partners: {
    /** 카카오 알림톡, through 솔라피's agency API. */
    alimtalk: boolean;
  };
};

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function optional(environment: Environment, name: string): string | undefined {
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
    console.warn(
      "KEY_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -base64 32",
    );
  }

  return value;
}

function url(environment: Environment, name: string): string | undefined {
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

function requiredHttpUrl(environment: Environment, name: string): URL {
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

function commaSeparated(environment: Environment, name: string): string[] {
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

  return {
    baseUrl,
    secret,
    providers: signIn,
    ...(lafOidc ? { lafOidc } : {}),
    trustedOrigins: trustedOrigins(environment),
    initialAdminEmails: commaSeparated(environment, "INITIAL_ADMIN_EMAILS"),
    allowedEmails: commaSeparated(environment, "SIGN_IN_ALLOWED_EMAILS"),
  };
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

  const relayUrl = url(environment, "LAF_OAUTH_RELAY_URL");
  if (!relayUrl) return { clients };

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

  return { alimtalk: Boolean(alimtalkKey) };
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
  name: string,
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
    throw new Error(`AGENT_COMPUTER_POLICY is invalid: ${result.error}`);
  }
  return result.policy;
}

/**
 * How long silence on a Bot's stream is allowed to last.
 *
 * Refuses to start on anything that is not a whole number of milliseconds, rather than falling back
 * to the default. Same reasoning as the action policy above it: an operator who meant to write a
 * two-minute timeout and typed something else would otherwise get a running deployment with a
 * silently different boundary, and no indication that anything was wrong.
 *
 * Zero is a legitimate value and means off. It is not the same as a malformed one.
 */
function agentStallTimeoutMs(environment: Environment): number {
  const raw = optional(environment, "AGENT_STALL_TIMEOUT_MS");
  if (!raw) {
    return 0;
  }

  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "AGENT_STALL_TIMEOUT_MS must be a whole number of milliseconds, or 0 to switch the watchdog off",
    );
  }
  return milliseconds;
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
    connectors: connectorsConfig(environment),
    partners: partnersConfig(environment),
  };
}
