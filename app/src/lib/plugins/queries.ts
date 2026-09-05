import { queryOptions } from "@tanstack/react-query";
import { toolResultText } from "@shared/prompt/tool-results.ko";
import {
  type AllowanceScope,
  type AskSubject,
  closeQuestion,
  openQuestion,
  pauseFrom,
  waitForApproval,
} from "@/lib/approvals";
import { t } from "@/lib/i18n";
import { inShell } from "@/lib/notifications/shell";

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
  /** Non-null when the declaration stops every call for a person. */
  guard: "money" | "external" | "destructive" | "unannotated" | null;
};

/**
 * Whose credential reaches a server.
 *
 * `deployment-bearer` is one token an administrator holds for everybody. `user-oauth` is the
 * asker's own grant, so the same question gets each person the answer their own account can see —
 * which is why the surface has to phrase these two differently rather than just say "connected".
 */
export type PluginAuthKind = "none" | "deployment-bearer" | "user-oauth";

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
      if (!response.ok) throw new Error("Plugins could not be loaded.");
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
   * The `laf:` fact the server sent alongside its English sentence, when it sent one.
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
  returnTo: "admin" | "settings",
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
    error?: string;
    /** The fact behind the sentence. Sent by every refusal this route has. */
    code?: string;
  } | null;
  if (!response.ok || !body?.authorizationUrl) {
    throw new ConnectRefusedError(
      body?.error ?? t("The connection could not be started."),
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
      return t("That account could not be connected.");
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
 */
export function agentPluginsQueryOptions(agentId: string | undefined) {
  return queryOptions({
    queryKey: pluginKeys.forAgent(agentId ?? ""),
    // No Bot in front of the person is not a Bot with no plugins; it is nothing to ask about.
    enabled: Boolean(agentId),
    refetchInterval: 15_000,
    // A hidden tab cannot act on a revoked tool, and its throttled timers only bank up requests.
    refetchIntervalInBackground: false,
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

/** The body of one skill this Bot holds, read by its own `skill_view` tool. */
export type ViewedSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
};

/**
 * A Bot reading one of its skills, as this Bot, through the server.
 *
 * The instructions are in the grants query already; going to the server is what writes the
 * `skill.viewed` row and rechecks the grant at the moment of reading. A refusal comes back as the
 * `laf:` code the model's own table translates, never as a sentence.
 */
export async function viewSkill(
  agentId: string,
  name: string,
): Promise<{ ok: true; skill: ViewedSkill } | { ok: false; code: string }> {
  const response = await fetch(
    `/api/plugins/for/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}/view`,
    { method: "POST", credentials: "include" },
  );
  const body = (await response.json().catch(() => null)) as
    | (Partial<ViewedSkill> & { code?: unknown })
    | null;
  if (response.ok && body && typeof body.instructions === "string") {
    return {
      ok: true,
      skill: {
        slug: body.slug ?? name,
        title: body.title ?? name,
        summary: body.summary ?? "",
        instructions: body.instructions,
      },
    };
  }
  const code =
    typeof body?.code === "string" && body.code.startsWith("laf:")
      ? body.code
      : "laf:skill_not_granted";
  return { ok: false, code };
}

export type PluginCallOutcome =
  | { ok: true; text: string; isError: boolean }
  /** The deployment decided against it. `rule` names the expression, when one decided. */
  | { ok: false; refused: true; reason: string; rule: string | null }
  /** Remote server failure; distinct from a policy refusal. */
  | { ok: false; refused: false; reason: string };

/**
 * Call a tool as a Bot, with server-side grant and policy rechecks for mid-run revocations.
 *
 * A call the boundary wants a person's answer to comes back here as a pause rather than a failure,
 * and this holds it open, puts the question on the tool call's own line, and sends the identical
 * call again with the answer attached. A tool call that reported "not allowed" to the model instead
 * would throw away the turn on work the deployment was willing to permit, which is the whole
 * difference between an ask rule and a deny rule.
 */
export async function callPluginTool(
  ref: string,
  args: Record<string, unknown>,
  agentId: string,
  signal?: AbortSignal,
  toolCallId?: string,
): Promise<PluginCallOutcome> {
  const outcome = await sendCall(ref, args, agentId, signal);
  if (!("awaitingApproval" in outcome)) return outcome;

  openQuestion(toolCallId ?? "", {
    approvalId: outcome.approvalId,
    botId: agentId,
    // The facts, not a sentence: `describeSubject` writes the Korean on the card.
    subject: outcome.subject,
    rule: outcome.rule,
    scope: outcome.scope,
    expiresAt: outcome.expiresAt,
  });
  try {
    const answer = await waitForApproval(agentId, outcome.approvalId, signal);
    if (answer === "granted") {
      // Sent once, not through this function again. A second ask on the retry would mean the answer
      // did not fit the call, and looping on that would hold the turn open until the deadline
      // instead of telling the model something it can act on, so a question raised on the retry is
      // reported rather than waited on.
      const retried = await sendCall(
        ref,
        args,
        agentId,
        signal,
        outcome.approvalId,
      );
      return "awaitingApproval" in retried
        ? {
            ok: false,
            refused: false,
            reason: toolResultText("laf:approval_did_not_fit"),
          }
        : retried;
    }
    // The same three codes the computer's tools hand back, said in the same Korean: what a Bot is
    // told when a person says no must not depend on which subsystem it was asking about.
    return answer === "declined"
      ? {
          ok: false,
          refused: true,
          reason: toolResultText("laf:person_declined"),
          rule: outcome.rule,
        }
      : {
          ok: false,
          refused: false,
          reason: toolResultText(
            answer === "cancelled" ? "laf:stopped" : "laf:nobody_answered",
          ),
        };
  } finally {
    closeQuestion(toolCallId ?? "");
  }
}

/** A question the server raised about this call, as the reply that paused it carried it. */
type AwaitingApproval = {
  awaitingApproval: true;
  approvalId: string;
  /** What is being asked about, in facts. Undefined when the reply carried none we recognise. */
  subject: AskSubject | undefined;
  rule: string | null;
  /** What "always" would cover here — always a tool, for a call to somebody else's server. */
  scope?: AllowanceScope | undefined;
  /** When it stops being answerable, so the card can count down. */
  expiresAt: string;
};

async function sendCall(
  ref: string,
  args: Record<string, unknown>,
  agentId: string,
  signal?: AbortSignal,
  approvalId?: string,
): Promise<PluginCallOutcome | AwaitingApproval> {
  const response = await fetch("/api/plugins/call", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ref,
      args,
      agentId,
      // Sent identically to the call that was asked about, because the server binds an answer to a
      // fingerprint of the call, arguments included: anything else comes back as a different action.
      ...(approvalId ? { approvalId } : {}),
    }),
    ...(signal ? { signal } : {}),
  });

  const body = (await response.json().catch(() => null)) as {
    text?: string;
    isError?: boolean;
    error?: string;
    /** The fact, beside the sentence. Read before `error` — see the 403 branch below. */
    code?: string;
    rule?: string | null;
    awaitingApproval?: boolean;
    approvalId?: string;
    question?: string;
    scope?: unknown;
  } | null;

  if (response.ok) {
    return {
      ok: true,
      text: body?.text ?? "",
      isError: body?.isError === true,
    };
  }
  // Read before anything else a 409 can mean, and never shown to the model: the caller above is
  // going to wait and then send the very same call again.
  const pause = response.status === 409 ? pauseFrom(body) : null;
  if (pause) return { awaitingApproval: true, ...pause };
  if (response.status === 403) {
    /*
     * A fact code from the boundary, turned into the sentence the MODEL reads.
     *
     * The server stopped writing prose here: a refusal arrives as `laf:policy_denied` or
     * `laf:declined_recently`, and passing that through would hand a Bot an identifier to reason
     * about. The Korean is in the one table both tool paths read
     * (`shared/prompt/tool-results.ko.ts`); anything that is not a code passes through unchanged,
     * because an English sentence from somewhere upstream is a regression worth seeing.
     *
     * `code` FIRST. The route has been sending one beside `error` all along
     * (`plugins/routes.ts`: `{ error, rule, code }`), and reading only `error` saw just the
     * refusals whose sentence IS the code. A connection refusal carries the code in `code` and an
     * English sentence in `error` — so `laf:not_connected` reached this fork's Korean-speaking
     * people as "You have not connected your Google Sheets account", with the Korean sitting in a
     * table nothing had looked up.
     */
    const carried = typeof body?.code === "string" ? body.code : "";
    const said = typeof body?.error === "string" ? body.error : "";
    const fact = carried.startsWith("laf:")
      ? carried
      : said.startsWith("laf:")
        ? said
        : "";
    return {
      ok: false,
      refused: true,
      reason: fact
        ? toolResultText(fact)
        : said || t("That tool is not allowed here."),
      rule: body?.rule ?? null,
    };
  }
  return {
    ok: false,
    refused: false,
    reason: body?.error ?? t("The server did not answer."),
  };
}
