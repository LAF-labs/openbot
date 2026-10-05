import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { inShell } from "@/lib/notifications/shell";
import { polled } from "@/lib/polling";
import { refusedRequest } from "@/lib/refusals";

/** A tool one server offers, as the Plugins page sees it. */
export type PluginTool = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names. */
  ref: string;
  /** Whether it changes something. Anything not positively known to be a read is a write. */
  effect: "read" | "write";
  grantedTo: string[];
  /** True when the definition changed after consent; refused until approved. */
  needsReview: boolean;
  reviewReason: string | null;
  /**
   * Non-null when the declaration stops a call for a person — each one, until that person answers
   * with 이 도구 항상 허용, which lets that Bot's later calls go without asking.
   */
  guard: "money" | "external" | "destructive" | "unannotated" | null;
};

/**
 * Whose credential reaches a server.
 *
 * `deployment-bearer` is one token an administrator holds for everybody. `user-oauth` is the
 * asker's own grant, so the same question gets each person the answer their own account can see —
 * which is why the surface has to phrase these two differently rather than just say "connected".
 */
export type PluginAuthKind =
  | "none"
  | "deployment-bearer"
  | "user-oauth"
  /** One key LAF holds for the fleet, spent for everybody: nothing to paste and nothing to consent to. */
  | "deployment-key";

/**
 * A grant on a tool its server no longer advertises.
 *
 * Empty for a healthy connector. Non-empty is a discrepancy an administrator should read about,
 * not a state to tidy away, so it is drawn rather than filtered out.
 */
export type WithdrawnGrant = {
  /** `<serverId>/<name>`, exactly as the grant is stored. */
  ref: string;
  /** The tool half, for a screen that already knows the server. */
  name: string;
  grantedTo: string[];
};

export type PluginServer = {
  id: string;
  title: string;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` for a reviewed entry, `custom` for one an administrator added by URL. */
  provenance: string;
  hasCredential: boolean;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  authKind: PluginAuthKind;
  /**
   * Whether the deployment registers its own OAuth client rather than waiting for an administrator
   * to paste one in. False is what makes the paste-a-client form worth drawing.
   */
  dynamicClient: boolean;
  tools: PluginTool[];
  withdrawn: WithdrawnGrant[];
};

/** `origin` of a skill the tenant package ships (`server/src/plugins/built-in-skills.ts`). */
export const BUILT_IN_ORIGIN = "built_in";

export type PluginSkill = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's: an administrator looks after it. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
};

export type CatalogueItem = {
  key: string;
  title: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  /** Which gesture this entry wants: a token field, a connect button, or nothing at all. */
  auth: PluginAuthKind;
  dynamicClient: boolean;
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
};

/** One person's own connection to a `user-oauth` server. */
export type PluginConnection = {
  serverId: string;
  /**
   * The scope string exactly as the vendor granted it, shown rather than interpreted. Empty for a
   * vendor whose consent screen is the scoping, where inventing words for it would assert a
   * control that does not exist.
   */
  scope: string;
  connectedAt: string;
  /**
   * Whether the connection still works, as the last token exchange found it.
   *
   * THE ROW EXISTING IS NOT THE SAME AS THE CONNECTION WORKING, and until 2026-09 this list could
   * only say the first: a grant the vendor had revoked months ago drew 연결됨 until somebody asked
   * a Bot to use it. `needs_reconnect` is the only status that asks anything of anybody, and it is
   * raised only for a vendor that refused the grant — a transient outage stays `ok`, because
   * drawing 다시 연결 in front of one would send somebody through a consent screen to fix
   * somebody else's afternoon.
   *
   * OPTIONAL, and read defensively. A server that predates this field sends none, and a card that
   * assumed it would draw "undefined" on the one screen a person checks when something is wrong.
   */
  health?: {
    status: "ok" | "needs_reconnect";
    /** When a call last worked, and when one last failed. Null until each has happened once. */
    lastOkAt: string | null;
    lastFailureAt: string | null;
    /**
     * Which failure it was, in the server's own words — never a vendor's. Carried even when the
     * status is `ok`, so a screen can say 잠시 문제가 있었어요 for `vendor_down` without telling
     * anybody to go and reconnect.
     */
    failureCode: "revoked" | "refresh_failed" | "vendor_down" | null;
  };
};

/**
 * A service this deployment can actually finish a connection to.
 *
 * The 연결 screen's whole list. It is the CATALOGUE rather than what somebody added, because on a
 * one-person deployment there is nobody else to add anything — and an entry only appears once the
 * deployment holds the OAuth application behind it, so a card that is drawn is one the button works
 * on.
 */
export type AvailableConnector = {
  id: string;
  /** The vendor's own brand name, which is theirs in every language. */
  title: string;
  /** The server's English line, used only when the copy table has no Korean for this key. */
  summary: string;
  docsUrl: string;
  /** True for a vendor that gives every customer their own hostname (Cafe24's mall id). */
  needsInstanceHost: boolean;
  /** What this deployment already has, so a reconnect does not ask for it again. */
  instanceName: string | null;
};

export type PluginConnections = {
  connections: PluginConnection[];
  available: AvailableConnector[];
  /**
   * The address a vendor sends the browser back to, for an administrator registering a client by
   * hand. Null means this deployment has no public URL and no connection can be completed.
   */
  redirectUri: string | null;
};

export type PluginsPage = {
  catalogue: CatalogueItem[];
  servers: PluginServer[];
  skills: PluginSkill[];
};

/** What one Bot holds, which is all the runtime needs to offer it. */
export type GrantedPlugins = {
  tools: {
    ref: string;
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

export const pluginKeys = {
  all: ["plugins"] as const,
  page: () => ["plugins", "page"] as const,
  connections: () => ["plugins", "connections"] as const,
  forAgent: (agentId: string) => ["plugins", "for-agent", agentId] as const,
};

export function pluginsPageQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.page(),
    queryFn: async (): Promise<PluginsPage> => {
      const response = await fetch("/api/plugins", { credentials: "include" });
      if (!response.ok)
        throw await refusedRequest(response, "Plugins could not be loaded.");
      return response.json();
    },
  });
}

/**
 * Which servers the signed-in person has connected with their own account.
 *
 * Separate from the page query because it answers a different question about the same list: that
 * one is "what can this deployment reach", this one is "what have I personally consented to". An
 * administrator looking at the Plugins page sees both, and they are not the same fact.
 */
export function connectionsQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.connections(),
    /*
     * Re-asked when the window comes back, against this app's global default of not doing that.
     *
     * A consent finishes somewhere else — another tab, or in the desktop shell the person's own
     * browser — and the only signal this window gets that it is over is the person returning to it.
     * Without this the strip keeps offering Connect to somebody who has just connected, which reads
     * as the press having done nothing.
     */
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PluginConnections> => {
      const response = await fetch("/api/plugins/connections", {
        credentials: "include",
      });
      if (!response.ok)
        throw new Error(
          t("Connections could not be loaded. Refresh to try again."),
        );
      return response.json();
    },
  });
}

/**
 * A connect the server would not start, carrying the status alongside the message.
 *
 * The status is the whole difference between three things a person needs told apart: an
 * administrator has paperwork left to do (409), this deployment cannot complete a consent flow at
 * all (503), and the vendor refused us (502). Without it the surface can only say "that did not
 * work", which is how a connector that is one console entry away looks broken.
 */
export class ConnectRefusedError extends Error {
  readonly status: number;
  /**
   * The `laf:` fact the server sent — the whole of what it says, since its English sentence beside
   * the code went (2026-09-14).
   *
   * The status alone tells three situations apart; the code tells NINE, and two of them share a
   * 400: a mall id that is not a mall id, and no mall id at all. Read before the status wherever
   * both are known, because a person who can be told which of their own two mistakes it was does
   * not have to guess.
   */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ConnectRefusedError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Ask for the vendor's consent URL. The browser, not the server, decides when to leave the page.
 *
 * `returnTo` is one of two names rather than a URL, because the server seals it into the state it
 * sends the vendor and a destination a caller chose would be an open redirect with a consent screen
 * in front of it.
 */
export async function beginConnect(
  serverId: string,
  /** `chat`: a switch pressed inside the conversation, which the vendor sends the person back to. */
  returnTo: "admin" | "settings" | "chat",
  /**
   * The shop's own name at a per-instance vendor — a Cafe24 mall id, which is on the address bar of
   * the shop itself and is not a secret. Sent only where the server said one is needed.
   */
  instanceName?: string,
): Promise<string> {
  /*
   * In the shell, neither of the caller's two names can work, so a third is sent instead.
   *
   * The shell hands the consent screen to the person's OWN browser (`openConsent`), which is right
   * — a webview has no address bar, no password manager and no Google session. But that browser
   * has no session for this app either, so the vendor sends it back to a callback whose redirect
   * lands on `/sign`: measured as somebody consenting successfully and being shown 로그인하세요.
   * `shell` lands on the server's own `/connected` instead, which needs no session and hands the
   * browser back through `lafagent://`.
   *
   * Whichever page started it, because the destination is about the BROWSER the person is holding
   * rather than the screen they left — the admin page in the shell has exactly the same problem.
   * A browser tab keeps today's two names and today's redirect.
   */
  const destination = inShell() ? "shell" : returnTo;
  const response = await fetch(
    `/api/plugins/servers/${encodeURIComponent(serverId)}/connect?returnTo=${destination}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(instanceName ? { instanceName } : {}),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    authorizationUrl?: string;
    /** The fact. Sent by every refusal this route has; `error` is the same code. */
    code?: string;
  } | null;
  if (!response.ok || !body?.authorizationUrl) {
    // The message is never drawn — `refusalText` in `connections.tsx` reads the code and status —
    // and it is ours, so a reader that did draw it would not print the code.
    throw new ConnectRefusedError(
      t("The connection could not be started."),
      response.status,
      typeof body?.code === "string" ? body.code : null,
    );
  }
  return body.authorizationUrl;
}

/**
 * What `?connected=failed&reason=…` means, as a sentence the screen can draw.
 *
 * FIVE WORDS AND ONE FALLBACK. The callback used to answer every failure with `failed` alone, so
 * the screen said "연결하지 못했습니다" to somebody who had declined at the vendor, to somebody
 * whose link had expired, and to somebody the vendor had refused — three situations with three
 * different next moves and one sentence between them.
 *
 * The keys are the server's (`connected-page.ts`, and the branches in `plugins/routes.ts`); the
 * words are the surface's, which is the arrangement everywhere else in this fork. An unrecognised
 * reason — an older server, a hand-typed URL — falls back to the sentence that is true of all of
 * them rather than to nothing.
 *
 * THE FALLBACK IS ALSO ALL THE INSTALLED APP SAYS. A consent that began in the shell ends in the
 * person's own browser, on the server's page, which says the reason there; the link back into the
 * app carries `failed` and no reason (`link_target` in the shell). So it is the one sentence here
 * with the whole of what somebody needs once they are back: nothing was saved, and try again.
 *
 * Exported because the connected-accounts screen is the caller, and it is a pure mapping: a test
 * can walk the table without a browser.
 */
export function connectFailureText(reason: string | null | undefined): string {
  switch (reason) {
    case "expired":
      return t("The connection took too long. Please try again.");
    case "reused":
      return t("That connection link has already been used.");
    case "denied":
      return t("The connection was cancelled.");
    case "exchange":
      return t("The service could not finish connecting. Please try again.");
    case "mismatch":
      return t("This connection could not be completed.");
    default:
      return t(
        "The connection did not finish, and nothing was saved. Please try again.",
      );
  }
}

/** One person dropping their own connection to one server. */
export async function disconnectServer(serverId: string): Promise<boolean> {
  const response = await fetch(
    `/api/plugins/servers/${encodeURIComponent(serverId)}/disconnect`,
    { method: "POST", credentials: "include" },
  );
  if (!response.ok)
    throw new Error(
      t("That connection could not be removed. Please try again."),
    );
  const body = (await response.json().catch(() => null)) as {
    disconnected?: boolean;
  } | null;
  return body?.disconnected === true;
}

/**
 * Store an OAuth client an administrator registered at the vendor by hand.
 *
 * For a vendor that does not register clients on its own. The secret is optional because a public
 * client has none — PKCE carries the proof instead — so an empty one is sent as empty rather than
 * refused here.
 */
export async function saveOauthClient(
  serverId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const response = await fetch(
    `/api/plugins/servers/${encodeURIComponent(serverId)}/oauth-client`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    },
  );
  if (!response.ok)
    throw new Error(t("That client could not be saved. Please try again."));
}

/**
 * Polled grant snapshot for what the active Bot should be offered; call-time checks still enforce.
 *
 * A minute between reads, and a read on every return to the window (`polled`): a grant changes when
 * a person changes it, on another screen, and that is the moment it needs to show.
 */
export function agentPluginsQueryOptions(agentId: string | undefined) {
  return queryOptions({
    queryKey: pluginKeys.forAgent(agentId ?? ""),
    // No Bot in front of the person is not a Bot with no plugins; it is nothing to ask about.
    enabled: Boolean(agentId),
    ...polled(60_000),
    queryFn: async (): Promise<GrantedPlugins> => {
      const response = await fetch(
        `/api/plugins/for/${encodeURIComponent(agentId ?? "")}`,
        { credentials: "include" },
      );
      if (!response.ok)
        throw new Error(
          t("This Bot's connections could not be read. Refresh to try again."),
        );
      return response.json();
    },
  });
}
