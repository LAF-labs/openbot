import type { AuditStore } from "../audit";
import type {
  ApprovalRegistry,
  AskSubject,
  PendingApproval,
} from "../computer/approvals";
import type { ReviewSubject, ReviewVerdict } from "../computer/auto-review";
import type { ActionPolicy } from "../computer/policy";
import type { RepeatDetector } from "../computer/repeat";
import type {
  AllowanceScope,
  StandingApprovalStore,
} from "../computer/standing-approvals";
import type { CredentialSecretReader, CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { createCallPath } from "./call";
import type { CatalogueEntry, PartnerFamily } from "./catalogue";
import { createConnections } from "./connections";
import type { LafGuard } from "./laf-contract";
import { McpServerError } from "./mcp";
import { registerDynamicClient } from "./oauth";
import {
  createOAuthClients,
  exchangeRefreshTokenOverHttp,
} from "./oauth-client";
import { createServers, unlistedAdvertisedTools } from "./servers";
import { NO_SHARED_CLIENTS, type SharedClientLookup } from "./shared-clients";
import { createSkillsAndGrants } from "./skills-and-grants";
import { transportFor, type VendorTransport } from "./transport";

/**
 * Plugins: what this deployment has added, which Bots may use it, and the one path a call takes.
 *
 * The grant and the policy are two different questions and both are asked on every call. The grant
 * answers "is this Bot allowed this tool at all", which an operator decides on the Plugins page. The
 * policy answers "is this particular call permitted right now", which is written as a rule and can
 * say things a grant cannot: not on this host, not this argument, not a write. Collapsing them would
 * mean an operator who granted a Bot a server had also, invisibly, waived every rule about it.
 *
 * WHAT IS AND IS NOT IN THIS FILE. The vocabulary is here — the record types, the error classes, the
 * one spelling of a tool name — and so is the assembly. The work is in five modules beside it, split
 * along the call graph rather than by layer: {@link ./oauth-client} holds the deployment's identity
 * at a vendor, {@link ./connections} holds one person's grant and the token a call goes out with,
 * {@link ./servers} holds what this deployment will talk to, {@link ./skills-and-grants} holds who
 * may use what, and {@link ./call} holds the one path a call takes. They were one 2,581-line closure
 * until 2026-09, and the reason for the split is the reason for the boundaries: the vault, the
 * policy, the approval and the network were interleaved in a single function, so nothing about any
 * one of them could be read, or changed, without reading all four.
 */

export type PluginKind = "mcp" | "skill";

export type ToolRecord = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names and what the model's tool name is derived from. */
  ref: string;
  effect: "read" | "write";
  grantedTo: string[];
  /** True when the definition changed after consent; the tool is paused until reviewed. */
  needsReview: boolean;
  reviewReason: string | null;
  /** Set on custom servers whose declaration stops every call for a person. */
  guard: LafGuard | null;
};

/**
 * A grant on a tool this server no longer advertises.
 *
 * Kept visible rather than tidied away, because the two honest readings — the vendor withdrew the
 * tool, or a transport swap renamed it — both belong to an administrator, and the one dishonest
 * answer would revoke every grant on that server and stamp the refresh as healthy.
 */
export type WithdrawnGrant = {
  /** `<serverId>/<toolName>`, exactly as the grant is stored. */
  ref: string;
  /** The tool half, for a screen that already has the server. */
  name: string;
  grantedTo: string[];
};

export type ServerRecord = {
  id: string;
  title: string;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` or `custom`. Shown wherever the server is, never inferred by a reader. */
  provenance: string;
  hasCredential: boolean;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  /**
   * How this server is authenticated: the catalogue entry's declaration, `deployment-bearer` for a
   * custom server. The surface phrases connection states from this rather than guessing.
   */
  authKind: "none" | "deployment-bearer" | "user-oauth";
  /**
   * Whether the catalogue entry registers its own OAuth client (RFC 7591) rather than waiting on
   * an administrator to paste one in. So the admin screen can hide the paste-a-client form where
   * there is nothing for it to collect.
   */
  dynamicClient: boolean;
  tools: ToolRecord[];
  /**
   * Grants on tools this server no longer advertises.
   *
   * Empty for a healthy connector. Non-empty is the discrepancy an administrator should be reading
   * about, which is why it is here rather than inferred by a screen comparing two lists.
   */
  withdrawn: WithdrawnGrant[];
};

export type SkillRecord = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's, written by an administrator or shipped. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
};

/**
 * Who is asking, for the surfaces where the answer depends on it.
 *
 * An administrator sees and governs the whole deployment. Everybody else sees the deployment's
 * skills and their own, and may act only on their own.
 */
export type SkillActor = { id: string; isAdmin: boolean };

/** What one Bot holds. Everything the runtime needs to offer it, and nothing it does not. */
export type GrantedPlugins = {
  tools: {
    ref: string;
    /** The name the model is offered, which is the ref with the separator a tool name allows. */
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  skills: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }[];
};

export type PluginDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export class PluginRefusedError extends Error {
  constructor(
    message: string,
    readonly rule: string | null,
    /**
     * WHICH refusal this is, beside the sentence rather than instead of it.
     *
     * Optional, because the settle path already puts its code in `message` and the vendor's own
     * 403 has no code of ours to give. Where it is set, a test pins this and not the English: the
     * sentence is a placeholder for words the surface has yet to write in Korean, and a test that
     * pins the placeholder makes rewording it a failing test (docs/laf/redesign-2026-09.md §4-2).
     */
    readonly code?: string,
  ) {
    super(message);
    this.name = "PluginRefusedError";
  }
}

/**
 * The boundary wants a person's answer before this call is made.
 *
 * Emphatically not a {@link PluginRefusedError}, for the same reason the computer keeps the two
 * apart. A refusal is final and a model told it was refused should say so and stop; this is a pause,
 * and the identical call arriving again with an approval on it is the intended next step rather than
 * an attempt to get around anything. Collapsing them teaches a model to abandon exactly the work a
 * deployment was willing to permit, which is what makes an ask list that degrades to a deny list
 * worse than having no ask list at all.
 */
export class PluginNeedsApprovalError extends Error {
  /** What the caller presents once somebody has answered. */
  readonly approvalId: string;
  /** What is being asked about, in facts. The sentence is composed where it is read. */
  readonly subject: AskSubject;
  /** The rule that asked, so the surface can name the boundary the way a refusal does. */
  readonly rule: string;
  /**
   * What answering "always" would cover, so the card can say it on the button.
   *
   * Carried out with the question rather than fetched back: the facts a person reads and the scope
   * that gets granted have to be the same record, and a surface that went and asked separately could
   * show one and grant the other. Absent means the card offers only "this once".
   */
  readonly scope: AllowanceScope | undefined;
  /** When it stops being answerable, so the card can show how long is left. */
  readonly expiresAt: string;

  constructor(approval: PendingApproval) {
    super("laf:awaiting_approval");
    this.name = "PluginNeedsApprovalError";
    this.approvalId = approval.id;
    this.subject = approval.subject;
    this.rule = approval.rule;
    this.scope = approval.scope;
    this.expiresAt = approval.expiresAt;
  }
}

export class CatalogueEntryUnknownError extends Error {
  constructor(key: string) {
    super(`${key} is not a server this deployment will connect to.`);
    this.name = "CatalogueEntryUnknownError";
  }
}

/** A URL an administrator offered that this deployment will not point itself at. */
export class CustomServerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomServerRefusedError";
  }
}

/**
 * The vendor's `error` code, when a token endpoint refuses an exchange.
 *
 * {@link INVALID_CLIENT} is the one code this module ACTS on rather than reports, so it has to
 * survive as a value. It used to travel inside the sentence, which meant the recovery in
 * `oauth-client.ts`'s `refuseAndReplaceEvictedClient` hung on a substring of prose written for a
 * person to read: rewording the sentence — translating it, dropping the parenthesis — would have
 * turned self-registration off with every test still green. A field cannot be reworded by accident.
 */
export class TokenRefusedError extends McpServerError {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "TokenRefusedError";
  }
}

/**
 * The vendor saying the CLIENT is the problem, rather than the grant. RFC 6749 §5.2.
 *
 * Told apart from every other refusal because it is the only one a deployment can do anything about
 * on its own: a client it issued to itself, it can issue again.
 */
export const INVALID_CLIENT = "invalid_client";

/**
 * A transaction, as the writes in these modules hand one to each other.
 *
 * Named because two writes here are one decision — a secret in the vault, and the pointer that says
 * what it is for — and the only way to say that is to run both on the same executor. `select`,
 * `insert` and `update` alone would do for a credential write; this needs `execute` too, for the
 * advisory lock that serialises the client path.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A tool name the model can actually call.
 *
 * `<server>/<tool>` is how a grant is stored, because a slash reads correctly to a person and cannot
 * appear in either half. Model tool names may not contain one, so the offered name uses `__`.
 * Converting in one place, both ways, keeps the two spellings from drifting.
 */
export const toolNameFor = (ref: string) => `mcp__${ref.replace("/", "__")}`;

/** A timestamp as every surface reads one, or null where the column allows none. */
export const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

/**
 * Why a connection last failed, in our own words.
 *
 * Three, because they have three different answers. `revoked` is the grant being gone at the
 * vendor and `refresh_failed` is an exchange that will not start working on its own; both mean the
 * person has to consent again. `vendor_down` is an outage, a timeout or a reply that was not a
 * token, and it comes back by itself — putting 다시 연결 in front of it would send somebody through
 * a consent screen to fix somebody else's afternoon.
 *
 * NEVER THE VENDOR'S OWN CODE OR SENTENCE. `invalid_grant` is what the protocol says; `revoked` is
 * what we say, and the difference is that this one is a closed set the surface can write Korean for
 * (docs/laf/redesign-2026-09.md §4-2).
 */
export type ConnectionFailureCode =
  | "revoked"
  | "refresh_failed"
  | "vendor_down";

/**
 * Whether a connection still works, as the settings page and the tool path both read it.
 *
 * `needs_reconnect` is the only status that asks anything of anybody, and only two of the three
 * failure codes produce it. A connection nothing has ever called through has no dates at all and is
 * `ok` — "never measured" is not "broken", and a person who connected a moment ago should not be
 * told to connect again.
 */
export type ConnectionHealth = {
  status: "ok" | "needs_reconnect";
  lastOkAt: string | null;
  lastFailureAt: string | null;
  failureCode: ConnectionFailureCode | null;
};

/**
 * The deployment's OAuth client for one vendor, as it is held in the vault.
 *
 * Both halves live in the encrypted value rather than the id sitting in `metadata` and the secret
 * here. One read gets a usable client, which keeps the vault interface this module needs small. The
 * id is also copied into `metadata` for the credentials page to show — a deliberate duplication of
 * something that is not a secret, so that a screen listing what the deployment holds does not have
 * to decrypt anything to name it.
 */
export type OAuthClient = { clientId: string; clientSecret: string };

/**
 * The client and when the vault row holding it was written.
 *
 * The date is not about the client: it is how long ago this deployment last introduced itself, which
 * is the one thing that distinguishes a client the vendor has evicted from one a re-registration
 * minted moments ago. Null only for a row that has since disappeared, which the read refuses first.
 */
export type StoredClient = { client: OAuthClient; registeredAt: Date | null };

/** What a vendor's token endpoint gave back for a refresh token. */
export type AccessToken = {
  accessToken: string;
  expiresInSeconds?: number;
  /**
   * The refresh token to present next time, from a vendor that rotates.
   *
   * Absent from Google's replies and present in every one of Notion's. When it is here it is the
   * only one that still works — the token just spent is dead at the vendor — so it has to be
   * persisted before the access token beside it is used for anything.
   */
  refreshToken?: string;
};

export type PluginStoreOptions = {
  database: Database;
  auditStore: AuditStore;
  /**
   * The vault, read and write.
   *
   * Writing is here rather than left to the browser posting `/api/admin/credentials` first. An OAuth
   * client belongs to the server registration and a refresh token belongs to a connection, so both
   * are written by the code that owns those acts — otherwise the first of two calls can succeed and
   * the second fail, leaving a secret in the vault that nothing points at and nobody knows to revoke.
   */
  credentials: CredentialSecretReader & CredentialStore;
  encryptionKey: string;
  /** Read at call time, never captured, so a policy changed a moment ago applies to this call. */
  policy: () => ActionPolicy;
  /**
   * Speaking the vendor's protocol. Defaults to the transport the catalogue entry names.
   *
   * Injected so a test can assert what a call was about to go out with. Whose credential is chosen
   * is the security property of this module, and asserting it otherwise needs a vendor to be
   * reachable, which means the property most worth testing would be the one thing never tested.
   */
  callVendor?: (
    connection: {
      url: string;
      token?: string | undefined;
      actorId?: string;
      botId?: string;
    },
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  /** Trading a refresh token for a short-lived access token. Defaults to a real HTTP exchange. */
  exchangeRefreshToken?: (input: {
    tokenUrl: string;
    client: OAuthClient;
    refreshToken: string;
    tokenAuth?: "basic";
  }) => Promise<AccessToken>;
  /**
   * The OAuth applications LAF registered once for the whole fleet, by vendor.
   *
   * Defaults to nothing configured, which leaves every connector on the two older shapes: a client
   * the deployment registers for itself, or one an administrator pasted in. The process that runs a
   * deployment passes the real lookup (`server/src/index.ts`); a suite that does not care inherits
   * the empty one rather than reaching `process.env` from inside the store.
   */
  sharedClient?: SharedClientLookup;
  /** RFC 7591 self-registration, for entries whose clientRegistration is dynamic. */
  registerClient?: (input: {
    registrationUrl: string;
    redirectUri: string;
  }) => Promise<OAuthClient | null>;
  /** Where the vendor sends people back; needed to (re)register a dynamic client. */
  redirectUri?: string | undefined;
  /**
   * Where a question raised by the `ask` list waits for an answer.
   *
   * Required rather than optional, and the same registry the computer uses. Optional would mean a
   * store built without one, which is easily done, quietly turning every ask rule about a tool call
   * into a refusal: the failure this whole path exists to avoid, arriving through a field somebody
   * forgot to pass.
   */
  approvals: ApprovalRegistry;
  /**
   * The allowances a person has already granted, so "always allow" reaches this path too.
   *
   * Optional, unlike `approvals` above, and absent behaves exactly as this file did before: every
   * asked call opens a question. A missing registry would turn an `ask` into a refusal, which is why
   * that one is required; a missing allowance store only means nobody has been given the shortcut.
   */
  standing?: StandingApprovalStore;
  /**
   * The Bot owner's own sentence about what they do not want to be asked, applied per call.
   *
   * Wired here as well as on the computer since 2026-09: a person who wrote "don't ask me about
   * anything read-only" meant it about their Bot, and until this existed it held for a click and not
   * for a call to the same information through somebody else's server. It never gets past a guard
   * floor — see `computer/settle.ts`, which is where the decision is made for both paths.
   */
  autoReview?: (
    botId: string,
    subject: ReviewSubject,
  ) => Promise<ReviewVerdict | null>;
  /**
   * The transports for the partner vendors this deployment is configured for.
   *
   * ASSEMBLED OUTSIDE AND HANDED IN, which is the whole reason it is an option rather than an
   * import. A partner module's tools are this repository's own code and reach the database through
   * `partner-connections.ts`, which imports this file for its refusal class — so importing the
   * partner runtime here would close the loop `store → partner runtime → partner-tools → store`.
   * The process builds it (`server/src/index.ts`) and passes it down.
   *
   * A missing entry is a partner this deployment holds no key for. Nothing should ever reach it —
   * the catalogue listing hides the card and the connect route refuses 503 — and if something does,
   * {@link PluginContext.transportFor} refuses rather than falling back to MCP, which would post a
   * JSON-RPC frame at 솔라피.
   */
  partnerTransports?: Partial<Record<PartnerFamily, VendorTransport>>;
  /**
   * The counter that says how many times this Bot has just made this exact call.
   *
   * The same detector the computer gateway feeds, because "the same Bot going round in circles" is
   * one fact about one Bot rather than one per subsystem. Absent leaves every call counted as a
   * first attempt, which is what this path did until 2026-09 — `repeat: { count: 1 }`, hard-coded,
   * so the shipped `repeat.count >= 5` rule was false here however many times a stuck model called.
   */
  repeat?: RepeatDetector;
};

/**
 * What every module below shares: the four things they were all closing over, plus the three
 * injectable seams resolved to their defaults exactly once.
 *
 * Resolved here rather than in each module because the defaults are a property of the store, not of
 * the module: a test injects `exchangeRefreshToken` and expects the connection path AND the recovery
 * path to see the stub, and two modules each applying their own `??` is how one of them ends up
 * talking to a real vendor in a test suite.
 */
export type PluginContext = {
  readonly options: PluginStoreOptions;
  readonly database: Database;
  readonly auditStore: AuditStore;
  readonly credentials: CredentialSecretReader & CredentialStore;
  readonly encryptionKey: string;
  readonly exchangeRefreshToken: (input: {
    tokenUrl: string;
    client: OAuthClient;
    refreshToken: string;
    tokenAuth?: "basic";
  }) => Promise<AccessToken>;
  /** The fleet's own OAuth applications, resolved once. See {@link ./shared-clients}. */
  readonly sharedClient: SharedClientLookup;
  readonly registerClient: (input: {
    registrationUrl: string;
    redirectUri: string;
  }) => Promise<OAuthClient | null>;
  /**
   * Held rather than resolved, because the transport is a property of the entry and is not known
   * until a call names one. An injected vendor still wins over both, which is what keeps a test able
   * to assert what a call was about to go out with.
   */
  readonly injectedVendor: PluginStoreOptions["callVendor"];
  /**
   * Which transport reaches this entry, partner entries included.
   *
   * On the context rather than imported at the two call sites, because a partner entry's transport
   * is not a property of the entry alone — it is whichever module this process assembled for that
   * vendor. `transport.ts`'s registry is still the answer for everything else, unchanged.
   */
  readonly transportFor: (entry: CatalogueEntry | null) => VendorTransport;
};

/**
 * A partner entry whose module this deployment did not build, refusing.
 *
 * Not MCP-by-default, which is what `transportFor` would otherwise give it: a JSON-RPC `tools/list`
 * posted at 솔라피's REST host answers something, and whatever that something is would be written
 * into `mcp_tools` as this deployment's idea of what the vendor offers.
 */
const PARTNER_UNAVAILABLE: VendorTransport = {
  listNeedsCredential: false,
  listTools: async () => [],
  callTool: async () => {
    throw new PluginRefusedError(
      "laf:partner_not_configured",
      null,
      "laf:partner_not_configured",
    );
  },
};

export function createPluginStore(options: PluginStoreOptions) {
  const context: PluginContext = {
    options,
    database: options.database,
    auditStore: options.auditStore,
    credentials: options.credentials,
    encryptionKey: options.encryptionKey,
    exchangeRefreshToken:
      options.exchangeRefreshToken ?? exchangeRefreshTokenOverHttp,
    sharedClient: options.sharedClient ?? NO_SHARED_CLIENTS,
    registerClient: options.registerClient ?? registerDynamicClient,
    injectedVendor: options.callVendor,
    transportFor: (entry) =>
      entry?.partner
        ? (options.partnerTransports?.[entry.partner] ?? PARTNER_UNAVAILABLE)
        : transportFor(entry),
  };

  const grants = createSkillsAndGrants(context);
  /*
   * The one edge that is resolved late, and it is late because the three connection modules
   * genuinely need each other: a client is persisted against a server row, a refresh reads a
   * person's connection, and a refused connection replaces the deployment's client. The thunk is
   * only ever followed inside a call, long after everything here is built.
   */
  const oauthClients = createOAuthClients(context, () => servers);
  const connections = createConnections(context, oauthClients);
  const servers = createServers(context, connections, grants);
  const call = createCallPath(context, servers, connections, grants);

  return {
    addServer: servers.addServer,
    /** The row one press of 연결 needs, made on the spot. See `servers.ts` for why a press is enough. */
    ensureCatalogueServer: servers.ensureCatalogueServer,
    storedServerUrl: servers.storedServerUrl,
    addCustomServer: servers.addCustomServer,
    approveToolDefinition: servers.approveToolDefinition,
    removeServer: servers.removeServer,
    refreshTools: servers.refreshTools,
    listServers: servers.listServers,
    /** What a connect and a disconnect do beyond the credential. See `servers.ts`. */
    offerToolsTo: servers.offerToolsTo,
    withdrawToolsFrom: servers.withdrawToolsFrom,

    listSkills: grants.listSkills,
    skillOwner: grants.skillOwner,
    agentOwner: grants.agentOwner,
    installSkill: grants.installSkill,
    uninstallSkill: grants.uninstallSkill,
    grant: grants.grant,
    revoke: grants.revoke,
    listForAgent: grants.listForAgent,
    decide: grants.decide,

    /**
     * Store an OAuth client an administrator obtained by hand, for a vendor without dynamic
     * registration. The same vault treatment as one the deployment issued itself.
     */
    registerOAuthClient: oauthClients.persistOAuthClient,
    ensureOAuthClient: oauthClients.ensureOAuthClient,
    /**
     * The deployment's OAuth client for a server, or null if none is registered.
     *
     * Reads only. `ensureOAuthClient` is the one that will go and get one.
     */
    oauthClientFor: oauthClients.storedOAuthClient,

    recordConnection: connections.recordConnection,
    connectionsFor: connections.connectionsFor,
    disconnectAccount: connections.disconnectAccount,
    retireConnectionsFor: connections.retireConnectionsFor,

    callTool: call.callTool,
  };
}

export type PluginStore = ReturnType<typeof createPluginStore>;

export type { CatalogueEntry };
export { exchangeRefreshTokenOverHttp, unlistedAdvertisedTools };
