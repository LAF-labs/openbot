/**
 * The catalogue of MCP servers this deployment will talk to, and the rule that decides admissibility.
 *
 * First-party only, and the list is frozen in code. A remote MCP server is a piece of somebody
 * else's software that our Bots hand credentials to and take instructions from, so "which servers"
 * is a decision to make once, in review, rather than one to leave to whoever is typing a URL into an
 * admin page at the time. Only servers the vendor themselves maintains are here. A community server
 * that wraps the same API is not equivalent: it is an extra party in the trust path with none of the
 * accountability, and the answer for a vendor without an official server is to wait for one.
 *
 * Every host and path here comes from the vendor's published documentation. They are pinned rather
 * than discovered, because a URL this deployment will hand a credential to is a reviewed source
 * contract.
 *
 * Admissibility is fail-closed and checked against the pinned host, never against what a caller
 * supplied. A URL that does not exactly match a pinned host, or match one anchored per-instance
 * pattern, is refused. This is the control that stops "add an MCP server" from being a request
 * forgery primitive pointed at the deployment's own network.
 */

// The one place browsing and this check agree on: the ranges, the names, and — here only — where a
// name actually resolves. See `net/host-verdict.ts` for why the two callers share the predicates
// and not one entry point.
import {
  type HostResolver,
  isAddressLiteral,
  isCloudMetadataHostname,
  isLoopbackHostname,
  isNotPubliclyRoutableName,
  normalizeHostname,
  resolvedHostVerdict,
} from "../net/host-verdict";
import type { LafGuard } from "./laf-contract";
// Type-only, so naming the transport here creates no import cycle with the registry that resolves it.
import type { TransportKind } from "./transport";

/**
 * A vendor LAF registered ONE OAuth application with, for the whole fleet.
 *
 * The platform registers; the customer consents. A shop owner never obtains an API key and never
 * sees a developer console — whatever a vendor lets a platform register once becomes a single
 * 연결 button in this product, and the only thing the person does is say yes in their own account.
 * The client id and secret therefore come from this deployment's environment (one value per family,
 * the same value on every VM in the fleet) rather than from a vault row somebody pasted into.
 *
 * A closed union rather than a string, so adding a vendor is a change to this file and to
 * {@link ./shared-clients} together: an entry naming a family with no environment variables behind
 * it should not typecheck.
 */
export type SharedClientFamily = "google" | "cafe24";

/**
 * A vendor LAF is the CUSTOMER of, where each business is registered underneath.
 *
 * The same platform-holds-it arrangement as {@link SharedClientFamily} and a different mechanism,
 * which is why it is a second union rather than a third auth kind. An OAuth vendor issues a grant
 * to the person and this deployment spends it; this one issues LAF one agency account — a 솔라피
 * 대행사 key — and the business is REGISTERED under it by a step taken inside this product. So there
 * is no grant, nothing rotates, and what belongs to the person is the handle the vendor issued
 * them: a 발신프로필 senderKey.
 *
 * A UNION OF ONE, DELIBERATELY. 전자세금계산서 (팝빌) was the second member until 2026-09-05. The
 * union stays because it is what makes `partner` on an entry mean something other than "any
 * string", and because the arrangement it describes is the one a second vendor would arrive into.
 *
 * Closed, for the same reason the other one is: an entry naming a partner with no module and no
 * environment variables behind it should not typecheck. `server/src/plugins/partner-connections.ts`
 * takes its provider list from here, so a row, a tool ref, a catalogue key and a policy rule all
 * name the connection with one word.
 */
export type PartnerFamily = "kakao-alimtalk";

/**
 * A vendor LAF obtained ONE API KEY from, for the whole fleet, that nobody registers under.
 *
 * The third arrangement. An OAuth vendor issues the person a grant; a partner registers the
 * business under LAF's account; this one asks for neither, because what it serves is public — 나라장터
 * bids, 기업마당 support programmes — and the key exists to count calls, not to say whose they are.
 * So there is no consent, no registration and no row per person: the key is fleet configuration,
 * every Bot on a VM that carries it is offered the tools at boot, and a VM without it has no entry.
 *
 * Closed, like the two unions above it: an entry naming a family with no environment variable behind
 * it (`shared-clients.ts`) and no transport assembled for it (`public-data-rest.ts`) should not
 * typecheck.
 */
export type DeploymentKeyFamily = "data-go-kr";

/**
 * How a server is authenticated, and whose credential does it.
 *
 * The OAuth addresses are pinned here beside the MCP host, for the same reason and with the same
 * rule: they come from the vendor's published documentation and are never taken from a caller.
 * These are where this deployment sends a person's authorization code and receives the refresh
 * token that stands in for their access, so they are a reviewed source contract too.
 */
export type CatalogueAuth =
  /** Answers without any credential at all. */
  | { kind: "none" }
  /** One token, held by the deployment, used for everybody. */
  | { kind: "deployment-bearer" }
  /**
   * One API key LAF obtained for the fleet, spent for everybody, held in the environment.
   *
   * Not `deployment-bearer`, which names a vault row an administrator pasted and makes
   * {@link serverCredentialKind} demand one; and not `none`, which is what the partner entry says
   * for want of a better word and is not true here — a key exists, it is LAF's, and the call path
   * selects nothing because the transport already holds it. See {@link DeploymentKeyFamily}.
   */
  | { kind: "deployment-key"; key: DeploymentKeyFamily }
  /**
   * The asker's own grant. The deployment registers an OAuth client; each person consents once and
   * the call runs on their token, so the vendor decides what comes back.
   */
  | {
      kind: "user-oauth";
      /**
       * The three addresses, either absolute or as a `{host}` template.
       *
       * A template is for a vendor that gives every customer their own hostname and serves its OAuth
       * endpoints there too (Cafe24: `https://<mallid>.cafe24api.com/api/v2/oauth/…`). `{host}` is
       * replaced with the ORIGIN of the server row this deployment already stored, and only after
       * {@link hostAdmissible} has accepted it against the entry's anchored pattern — see
       * {@link authEndpointsFor}. It is never replaced with anything a caller supplied at the time,
       * because these are the addresses an authorization code and a refresh token are sent to.
       */
      authorizationUrl: string;
      tokenUrl: string;
      /** Where a disconnect is sent, so revocation happens at the vendor and not just here. */
      revokeUrl: string;
      /**
       * What to ask a person to consent to. Narrow on purpose: a scope granted by everybody who
       * connects and used by nothing is a permission nobody remembers agreeing to. Empty for a
       * vendor whose consent screen itself is the scoping (Notion), where scope strings would
       * assert a control that does not exist.
       */
      scopes: readonly string[];
      /**
       * How the deployment gets its OAuth client. Absent means an administrator registers one at
       * the vendor and pastes it in. `dynamic` means the deployment registers ITSELF (RFC 7591)
       * on first connect — no admin step, no client secret; PKCE carries the proof instead.
       */
      clientRegistration?: "dynamic";
      /** The RFC 7591 endpoint. Pinned https, required when `clientRegistration` is `dynamic`. */
      registrationUrl?: string;
      /**
       * The fleet-wide OAuth application this entry consents under, when there is one.
       *
       * Present means the client comes from configuration and is the same on every VM: nobody
       * pastes anything and the vault holds no client for this server. Absent keeps the two older
       * shapes — a client the deployment registered for itself (`dynamic`), or one an administrator
       * obtained by hand.
       */
      sharedClient?: SharedClientFamily;
      /**
       * How the token endpoint wants the client proved. Absent means the client id and secret go in
       * the form body, which is what every vendor here but Cafe24 accepts; `basic` puts them in an
       * `Authorization: Basic` header, which is what Cafe24 REQUIRES and refuses the exchange
       * without.
       */
      tokenAuth?: "basic";
      /**
       * Vendor-specific consent-URL parameters. Google's offline/consent pair lives HERE rather
       * than in `authorizationUrlFor`, so one vendor's requirements are never sent to another —
       * an unknown parameter is a thing a strict vendor may refuse the whole request over.
       */
      authorizationParams?: Readonly<Record<string, string>>;
    };

export type CatalogueEntry = {
  /** Stable slug. Prefixes every tool name, so tools from two servers can never collide. */
  key: string;
  title: string;
  vendor: string;
  summary: string;
  /**
   * The one host this server lives on. Null for a vendor that gives every customer their own
   * hostname, where {@link CatalogueEntry.hostPattern} decides instead.
   */
  host: string | null;
  /**
   * Anchored pattern for a per-instance vendor. Only consulted when `host` is null, and written
   * anchored at both ends so it cannot match a host that merely ends in the vendor's domain.
   */
  hostPattern?: string;
  /**
   * How the customer's own name becomes a host, for a per-instance vendor.
   *
   * `{name}` is what the person typed on the connect card — a Cafe24 mall id, which is on the shop's
   * own address bar and is not a secret. The result is checked against {@link hostPattern} before
   * anything is stored, so this template is a convenience for building the address and never the
   * thing that admits it.
   */
  instanceHostTemplate?: string;
  /** The path the MCP endpoint is served at. Frozen here, never taken from a caller. */
  path: string;
  /**
   * Whose credential this server is reached with.
   *
   * This used to be `needsCredential: boolean`, which said that a credential was required and not
   * whose it was. That is the one thing about a connector worth being unambiguous about: a reader
   * who has to guess guesses the deployment's, and a deployment-wide credential pointed at a
   * per-person system means everybody's question is answered from what one account can see. So the
   * shape names it, and every entry states it.
   *
   * `deployment-bearer` is a token an administrator holds on behalf of everybody. `user-oauth` is
   * the person's own grant, where the deployment holds only the OAuth client and each person
   * consents for themselves.
   */
  auth: CatalogueAuth;
  /**
   * The tools this vendor's server exposes that change something.
   *
   * Kept so the policy can be written about effect rather than about tool names a rule author would
   * have to look up. A tool the server never advertised, so nothing here could have named it, is
   * safe to over-scrutinize as a write. The opposite direction is the one that matters for this
   * list: a tool the server DOES advertise but that is missing from here classifies as a read, so
   * an incomplete list is the failure mode, not a safe default — this list has to lean
   * over-inclusive.
   */
  writeTools: readonly string[];
  /**
   * Tools a person answers for every time, whatever the written boundary says short of `deny`.
   *
   * WHY THIS IS HERE AND NOT ON THE TOOL. A custom server declares its own risk with annotations and
   * is believed, because the definition it declared is pinned by hash (docs/laf/mcp-contract.md).
   * A curated entry is the opposite arrangement: the reviewed word is THIS file's, so annotations
   * arriving from the vendor — or written into one of our own REST adapters — decide nothing, and
   * `call.ts` reads the floor from here. Putting them on the tool as well would be two sources for
   * one decision, and the one a reader would trust is the one that does nothing.
   *
   * Only the four names a person can be shown a sentence for (`app/src/lib/approvals.ts`), and each
   * has to be TRUE of the tool: a card telling somebody an append "can destroy something" is a
   * boundary lying in the other direction. A write that is neither outward nor destructive is left
   * to the written policy through its `write_tool` intent.
   */
  guardedTools?: Readonly<Record<string, LafGuard>>;
  /**
   * Whether this vendor answers to the fleet's relay instead of to this deployment's own callback.
   *
   * Google and Cafe24 both check `redirect_uri` for exact equality against what the OAuth
   * application was registered with, and neither accepts a wildcard. One application shared by the
   * whole fleet therefore cannot name `https://<customer>.agent.laf-co.com/…`, because there is no
   * such string to register — there is one per customer, and there will be more tomorrow. So the
   * registered value is the relay's, the relay reads which customer it is from the state, and the
   * browser is handed back to that customer's own callback. See docs/laf/connections.md.
   */
  relay?: true;
  /**
   * Which protocol reaches this vendor. Absent means MCP, which is what every entry was.
   *
   * A field rather than an inference, because the answer is not derivable from the host: Google
   * serves Drive over both an MCP endpoint and an ordinary REST API, and which one this deployment
   * uses is a decision about availability and risk rather than a property of the vendor. Naming it
   * here keeps that decision beside the host it applies to, and makes reversing it a one-line diff.
   */
  transport?: TransportKind;
  /**
   * Which partner module answers this entry, for a vendor LAF holds the account at.
   *
   * Present means the tools are this repository's own code and the credential is fleet
   * configuration — never a vault row, never a person's grant — so the transport comes from the
   * partner runtime the process assembled rather than from {@link ./transport}'s static registry
   * (see `PluginStoreOptions.partnerTransports`). Absent is every other entry, unchanged.
   *
   * It is a field rather than an inference from `auth.kind` because "no credential the call path
   * selects" and "no credential at all" are different facts, and only the first is true here: the
   * key exists, it is LAF's, and it lives in the environment.
   */
  partner?: PartnerFamily;
  docsUrl: string;
};

/**
 * A short list, deliberately.
 *
 * Atlassian, Box, Slack, Salesforce and ServiceNow were here and were removed, following upstream's
 * own review and this fork's measurement: every one of those vendors' official servers refuses a
 * static bearer token and demands OAuth (seven probes, seven 401s with RFC 9728 resource metadata),
 * so each entry was a reviewed source contract for a connector no deployment could actually
 * complete. They are in the history if they are wanted back, and re-adding one is a review of that
 * vendor — its OAuth endpoints pinned like the two below — rather than a revert.
 *
 * `deployment-bearer` therefore has no entry using it. The shape stays because the call path still
 * needs it: a server an administrator added by URL has no catalogue entry at all, and that is the
 * branch it falls into — including every customer server built on this fork's own MCP contract
 * (docs/laf/mcp-contract.md), which authenticates exactly that way.
 */
export const CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    key: "google-drive",
    title: "Google Drive",
    vendor: "Google",
    summary: "Files in the Drive of whoever is asking.",
    /*
     * Google publishes one MCP server per Workspace product, each on its own host: Gmail, Docs,
     * Sheets, Slides, Calendar, Chat and People have their own. Drive is here because it is the one
     * a question about a document needs. Each of the others is a further entry, not a flag on this
     * one, so adding Gmail stays a reviewed decision about Gmail.
     */
    /*
     * The GA REST API, not `drivemcp.googleapis.com`.
     *
     * The MCP server was the original choice and is the better one on paper: vendor-maintained, no
     * Drive-specific code here at all. It is gated behind the Google Workspace Developer Preview
     * Program, and an unenrolled project is refused with `The caller does not have permission` —
     * which describes the project, not the credential, so every check available locally reports a
     * correct setup. Enrolment is a Workspace-account application with a stated turnaround of days.
     *
     * This host has been generally available since 2015. The MCP entry is one line away: set
     * `transport` back to `mcp` and restore the host and path above. Tool names match Google's MCP
     * server exactly, so grants survive the swap in either direction.
     */
    host: "https://www.googleapis.com",
    path: "/drive/v3",
    transport: "google-drive-rest",
    /*
     * The first vendor here that cannot be reached with a token an administrator pastes. Google
     * issues no such token: access is an authorization-code grant belonging to a person. That is
     * not a limitation to work around, it is the property this connector exists for — two people
     * asking the same question should get the answers their own accounts can see.
     */
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      // Read-only, because nothing in this slice writes to anybody's Drive.
      scopes: Object.freeze(["https://www.googleapis.com/auth/drive.readonly"]),
      /*
       * One Google application for the whole fleet and for every Google entry below it.
       *
       * Incremental consent is what makes that safe to share: each entry asks for its own scopes and
       * nothing else, so connecting Drive grants Drive. A person who never connects Gmail has never
       * agreed to Gmail, whatever the application is capable of asking for.
       */
      sharedClient: "google",
      /*
       * `offline` and `consent` are both load bearing FOR GOOGLE. Without `access_type=offline`
       * Google returns no refresh token; without `prompt=consent` a reconnect returns none either.
       * They are Google parameters, so they live on Google's entry.
       */
      authorizationParams: Object.freeze({
        access_type: "offline",
        prompt: "consent",
      }),
    },
    /*
     * Named writes even though the scope above makes Google refuse them.
     *
     * Belt and braces on purpose. The scope is what stops them; this list is what keeps a boundary
     * written about writes covering them, so widening the scope later cannot quietly turn a write
     * into something the policy engine has never heard of.
     */
    writeTools: Object.freeze(["create_file", "copy_file"]),
    relay: true,
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
  },
  {
    key: "google-sheets",
    title: "Google Sheets",
    vendor: "Google",
    summary: "Rows in the spreadsheets of whoever is asking.",
    host: "https://sheets.googleapis.com",
    path: "/v4/spreadsheets",
    transport: "google-sheets-rest",
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      /*
       * Read AND write, unlike Drive, because a spreadsheet is where a small business keeps the
       * thing it wants a Bot to add a row to. `spreadsheets.readonly` would make every write tool
       * below fail at the vendor, which is the shape of a control that does nothing.
       */
      scopes: Object.freeze(["https://www.googleapis.com/auth/spreadsheets"]),
      sharedClient: "google",
      authorizationParams: Object.freeze({
        access_type: "offline",
        prompt: "consent",
      }),
    },
    writeTools: Object.freeze(["append_sheet_row", "update_sheet_values"]),
    /*
     * Only the overwrite. An append adds a row and takes nothing away, so calling it destructive on
     * the card would be a sentence that is not true; it is still a write, so a deployment's own
     * `intent == "write_tool"` rule reaches it.
     */
    guardedTools: Object.freeze({
      update_sheet_values: "destructive" as const,
    }),
    relay: true,
    docsUrl: "https://developers.google.com/sheets/api/reference/rest",
  },
  {
    key: "gmail",
    title: "Gmail",
    vendor: "Google",
    summary: "Mail in the mailbox of whoever is asking.",
    host: "https://gmail.googleapis.com",
    path: "/gmail/v1/users/me",
    transport: "gmail-rest",
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      /*
       * `gmail.compose` covers drafting AND sending, so `gmail.send` beside it would be a second
       * permission for something already granted — a scope nobody remembers agreeing to.
       *
       * Both are RESTRICTED scopes at Google: the application needs a security assessment before
       * anybody outside the test users can consent. That is the fleet's paperwork, once, and it is
       * why this entry disappears from the catalogue until the application exists (see
       * ./shared-clients).
       */
      scopes: Object.freeze([
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ]),
      sharedClient: "google",
      authorizationParams: Object.freeze({
        access_type: "offline",
        prompt: "consent",
      }),
    },
    writeTools: Object.freeze(["create_draft", "send_message"]),
    // A draft stays in the person's own mailbox; a send leaves and cannot be recalled.
    guardedTools: Object.freeze({ send_message: "external" as const }),
    relay: true,
    docsUrl: "https://developers.google.com/gmail/api/reference/rest",
  },
  {
    key: "google-calendar",
    title: "Google Calendar",
    vendor: "Google",
    summary: "The calendar of whoever is asking.",
    host: "https://www.googleapis.com",
    path: "/calendar/v3",
    transport: "google-calendar-rest",
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      // Events, not the whole calendar: nothing here creates or deletes calendars themselves.
      scopes: Object.freeze([
        "https://www.googleapis.com/auth/calendar.events",
      ]),
      sharedClient: "google",
      authorizationParams: Object.freeze({
        access_type: "offline",
        prompt: "consent",
      }),
    },
    writeTools: Object.freeze(["create_event"]),
    /*
     * `external`, not merely a write. An event lands on a calendar other people read, and Google
     * mails every attendee it is given — so the effect of this call leaves the deployment for
     * somebody else's inbox, which is the one thing a person should be asked about every time.
     */
    guardedTools: Object.freeze({ create_event: "external" as const }),
    relay: true,
    docsUrl: "https://developers.google.com/calendar/api/v3/reference",
  },
  {
    key: "google-business-profile",
    title: "Google Business Profile",
    vendor: "Google",
    summary: "Locations and reviews of the business asking.",
    /*
     * One product, three Google hosts. Reviews are only on the legacy v4 API and have been for
     * years; accounts and locations moved to their own v1 services. This is the reviews host
     * because reviews are what the connector exists for, and the adapter pins the other two beside
     * it in reviewed code (see ./google-business-rest) rather than taking either from a caller.
     */
    host: "https://mybusiness.googleapis.com",
    path: "/v4",
    transport: "google-business-rest",
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      // Google publishes exactly one scope for this product; there is no read-only half of it.
      scopes: Object.freeze([
        "https://www.googleapis.com/auth/business.manage",
      ]),
      sharedClient: "google",
      authorizationParams: Object.freeze({
        access_type: "offline",
        prompt: "consent",
      }),
    },
    writeTools: Object.freeze(["reply_to_review"]),
    // A reply is published under the business's name where anybody can read it.
    guardedTools: Object.freeze({ reply_to_review: "external" as const }),
    relay: true,
    docsUrl:
      "https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews",
  },
  {
    key: "cafe24",
    title: "Cafe24",
    vendor: "Cafe24",
    summary: "Orders, products and board posts of one mall.",
    /*
     * Per-instance: every mall answers on its own hostname, so the customer's mall id is the only
     * thing a person types when connecting — and it is not a secret, which is why it is a plain
     * field on the card rather than anything the vault holds.
     *
     * Anchored at both ends, so a host that merely ends in the vendor's domain is refused.
     */
    host: null,
    hostPattern: "^https://[a-z0-9][a-z0-9-]{1,48}\\.cafe24api\\.com$",
    instanceHostTemplate: "https://{name}.cafe24api.com",
    path: "/api/v2/admin",
    transport: "cafe24-rest",
    auth: {
      kind: "user-oauth",
      // Templates: Cafe24 serves its OAuth endpoints on the mall's own host too.
      authorizationUrl: "{host}/api/v2/oauth/authorize",
      tokenUrl: "{host}/api/v2/oauth/token",
      revokeUrl: "{host}/api/v2/oauth/revoke",
      scopes: Object.freeze([
        "mall.read_order",
        "mall.write_order",
        "mall.read_product",
        "mall.read_community",
      ]),
      sharedClient: "cafe24",
      // Cafe24 authenticates the client on the Authorization header and refuses the body form.
      tokenAuth: "basic",
    },
    writeTools: Object.freeze(["update_order_status"]),
    /*
     * `external`: changing an order's status is what tells the buyer their parcel shipped. The
     * effect is a message to somebody who is not in this room, so a person answers for it each time.
     */
    guardedTools: Object.freeze({ update_order_status: "external" as const }),
    relay: true,
    docsUrl: "https://developers.cafe24.com/docs/api/admin",
  },
  {
    key: "notion",
    title: "Notion",
    vendor: "Notion",
    summary: "Pages and databases of whoever is asking.",
    /*
     * The hosted MCP server Notion runs, on the default MCP transport — the first entry to use
     * it. Drive's REST adapter is a workaround for a preview-gated vendor; Notion's server is
     * generally available, so this entry is the shape the catalogue was designed for.
     */
    host: "https://mcp.notion.com",
    path: "/mcp",
    auth: {
      kind: "user-oauth",
      // From https://mcp.notion.com/.well-known/oauth-authorization-server, verified live.
      authorizationUrl: "https://mcp.notion.com/authorize",
      tokenUrl: "https://mcp.notion.com/token",
      // Notion's published revocation_endpoint IS its token endpoint — not a copy-paste mistake.
      revokeUrl: "https://mcp.notion.com/token",
      /*
       * Notion has no scope strings and no read-only scope: access is per-page, chosen on the
       * consent screen. `writeTools` below plus the action policy are the ENTIRE write barrier —
       * there is no vendor-side scope backing them up.
       */
      scopes: Object.freeze([]),
      clientRegistration: "dynamic",
      registrationUrl: "https://mcp.notion.com/register",
    },
    /*
     * The writing tools as the hosted server advertises them today. The hosted server advertises
     * its tools, so a name here that does not match an advertised tool is not the risk — an
     * advertised tool that is missing from this list is: {@link classifyTool} reads an unlisted
     * but advertised name as a read, never as a write. That makes under-inclusion the failure
     * mode, so this list has to lean over-inclusive rather than minimal, and reconciling it
     * against the live tool list on the first Refresh tools is required, not cosmetic.
     */
    writeTools: Object.freeze([
      "notion-convert-page-to-skill",
      "notion-create-attachment",
      "notion-create-comment",
      "notion-create-database",
      "notion-create-file-upload",
      "notion-create-folder",
      "notion-create-pages",
      "notion-create-view",
      "notion-duplicate-page",
      "notion-move-pages",
      "notion-send-message-to-session",
      "notion-spawn-session",
      "notion-stop-session",
      "notion-update-data-source",
      "notion-update-folder",
      "notion-update-page",
      "notion-update-view",
    ]),
    docsUrl: "https://developers.notion.com/guides/mcp/build-mcp-client",
  },
  /*
   * THE PARTNER ENTRY, and what makes it a different shape from everything above.
   *
   * Every entry before this one is a vendor the PERSON has an account with, which this deployment
   * borrows through an OAuth grant. This one is a vendor LAF has the account with: a 솔라피 대행사
   * key, one for the whole fleet. The business registers underneath — its own 카카오톡 채널 —
   * through a screen in this product, and never obtains a key, never visits a console and never
   * sees LAF's credentials.
   *
   * `auth: { kind: "none" }` IS ABOUT THE CALL PATH, NOT ABOUT THE VENDOR. `deployment-bearer` is
   * the nearest description of the truth and is the wrong field to set: it makes
   * {@link serverCredentialKind} demand an `mcp` credential id, and there is no vault row to point
   * at — the key is configuration, read by the partner module and by nothing else. `none` is what
   * the path that selects credentials should do here, which is nothing.
   *
   * The host is pinned like every other, and like every other it comes from the vendor's published
   * documentation. `LAF_ALIMTALK_BASE_URL` overrides where the module actually calls (a test's fake
   * vendor, a staging host); this stays the reviewed address of record, and is what a person reading
   * the catalogue is told this deployment talks to.
   */
  {
    key: "kakao-alimtalk",
    title: "카카오 알림톡",
    vendor: "Solapi",
    summary: "Template messages from this business's own KakaoTalk channel.",
    host: "https://api.solapi.com",
    path: "/kakao/v1",
    auth: { kind: "none" },
    partner: "kakao-alimtalk",
    writeTools: Object.freeze(["alimtalk_send"]),
    /*
     * `external`, and it is the plainest case of it in the catalogue: the message arrives on a
     * customer's phone with the shop's name on it, it cannot be recalled, and the number came from
     * a model. A person answers for the exact message, every time.
     */
    guardedTools: Object.freeze({ alimtalk_send: "external" as const }),
    docsUrl: "https://developers.solapi.com/references/kakao",
  },
  /*
   * THE DEPLOYMENT-KEY ENTRY: public data, on the fleet's one key, offered to every Bot.
   *
   * Nobody consents and nobody registers. 나라장터 bids and 기업마당 support programmes are
   * everybody's; the portal's key exists to count calls. So the arrangement is the partner's turned
   * around — the platform holds the credential AND nothing belongs to the person — and the
   * consequence is that a VM carrying the key offers these tools to every Bot from boot, while a
   * VM without it has no entry at all (`shared-clients.ts`, `public-data-rest.ts`).
   *
   * One host, two services under it. The entry pins the host and the adapter pins each path in
   * reviewed code, the way the Business Profile adapter pins its second and third hosts.
   */
  {
    key: "public-data",
    title: "나라장터·기업마당",
    vendor: "data.go.kr",
    summary: "Public tenders on 나라장터 and support programmes on 기업마당.",
    host: "https://apis.data.go.kr",
    path: "/",
    auth: { kind: "deployment-key", key: "data-go-kr" },
    // Nothing here writes anything anywhere, and no guard: a routine asking every morning is the point.
    writeTools: Object.freeze([]),
    docsUrl: "https://www.data.go.kr/data/15129394/openapi.do",
  },
]);

const BY_KEY = new Map(CATALOGUE.map((entry) => [entry.key, entry]));

/** Compiled once from the frozen source strings above. Never from anything a caller supplied. */
const PATTERNS = new Map(
  CATALOGUE.filter((entry) => entry.hostPattern !== undefined).map((entry) => [
    entry.key,
    new RegExp(entry.hostPattern as string),
  ]),
);

/**
 * Which kind of credential this entry's server record may be pointed at, or null when it takes none
 * from the caller.
 *
 * Beside the entry rather than at the call site, because it is a property of the vendor's auth and
 * not of the request. `deployment-bearer` is the only kind that means "one token this deployment
 * holds for this server", which is what `mcp` names in the vault. A `user-oauth` server is answered
 * with the asker's own grant and its OAuth client is registered through its own call, which mints
 * the credential itself, so an id offered when the server is added is never the right one whatever
 * kind it names. A server needing no credential takes none.
 */
export function serverCredentialKind(entry: CatalogueEntry): "mcp" | null {
  return entry.auth.kind === "deployment-bearer" ? "mcp" : null;
}

export function catalogueEntry(key: string): CatalogueEntry | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * The three OAuth addresses for one entry, with a per-instance vendor's host filled in.
 *
 * `serverUrl` is the address this deployment already stored for the server — the catalogue's own for
 * a fixed vendor, the admitted instance URL for a per-instance one. Its ORIGIN is what `{host}`
 * becomes, and only after {@link hostAdmissible} accepts it again: a row could have been written by
 * an older build, and these are the addresses an authorization code and a refresh token go to, so
 * the check is repeated at the moment of use rather than trusted from the moment of storage.
 *
 * Null when a template has no host to resolve against, or a host this entry would not be pointed at.
 * Every caller turns that into a refusal, because the alternative is sending somebody's grant to an
 * address nobody reviewed.
 */
export function authEndpointsFor(
  entry: CatalogueEntry,
  serverUrl: string | null,
): { authorizationUrl: string; tokenUrl: string; revokeUrl: string } | null {
  if (entry.auth.kind !== "user-oauth") return null;
  const { authorizationUrl, tokenUrl, revokeUrl } = entry.auth;
  const templated = [authorizationUrl, tokenUrl, revokeUrl].some((address) =>
    address.includes("{host}"),
  );
  if (!templated) return { authorizationUrl, tokenUrl, revokeUrl };

  if (!serverUrl) return null;
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return null;
  }
  if (!hostAdmissible(entry, origin)) return null;

  const fill = (address: string) => address.replaceAll("{host}", origin);
  return {
    authorizationUrl: fill(authorizationUrl),
    tokenUrl: fill(tokenUrl),
    revokeUrl: fill(revokeUrl),
  };
}

/**
 * Is this host one this entry is allowed to be pointed at?
 *
 * Compares the RAW host string, case-sensitively, and returns false for anything it does not
 * positively recognise. Every branch that cannot prove admissibility returns false rather than
 * falling through, because the failure mode of the opposite arrangement is a deployment reaching an
 * address nobody chose.
 */
export function hostAdmissible(entry: CatalogueEntry, host: string): boolean {
  if (entry.host !== null) return entry.host === host;
  const pattern = PATTERNS.get(entry.key);
  if (!pattern) return false;
  return pattern.test(host);
}

/**
 * The URL this server is reached at, or null if the request is not admissible.
 *
 * `instanceHost` is only consulted for a per-instance vendor, and only after the pattern accepts it.
 * The path is always the catalogue's, never the caller's, so an admissible host cannot reach some
 * other endpoint on the same machine.
 */
export function resolveServerUrl(
  key: string,
  instanceHost?: string,
): { url: string; entry: CatalogueEntry } | null {
  const entry = catalogueEntry(key);
  if (!entry) return null;

  const host = entry.host ?? instanceHost ?? null;
  if (host === null) return null;
  if (!hostAdmissible(entry, host)) return null;

  // The path is joined rather than concatenated blindly so a root path does not produce a double
  // slash, which some servers treat as a different route.
  const path = entry.path === "/" ? "" : entry.path;
  return { url: `${host}${path}`, entry };
}

/**
 * What this tool does, in the only two categories a policy author cares about.
 *
 * Unknown counts as a write. A tool named in {@link CatalogueEntry.writeTools} is a write. A tool
 * the server never advertised at all is a write, because the only thing that produced the name was
 * a model. A server with no catalogue entry behind it is a write throughout, because nothing
 * reviewed says any tool of theirs only reads.
 *
 * Only a tool the server itself listed AND that is absent from the write list is treated as a read.
 * That is the one case where both sources agree, and it is the only one where guessing permissively
 * is recoverable.
 */
export function classifyTool(
  entry: CatalogueEntry | null,
  toolName: string,
  advertised: boolean,
): "read" | "write" {
  // A server an administrator added by URL has no reviewed tool catalogue behind it, so nothing here
  // can say a tool of theirs only reads. Everything it offers is a write.
  if (!entry) return "write";
  if (!advertised) return "write";
  return entry.writeTools.includes(toolName) ? "write" : "read";
}

/**
 * Words that make a parameter name a credential, wherever they appear in it.
 *
 * A containment test rather than a list of exact names, because the exact-name version of this rule
 * refused `?token=` and accepted `?auth_token=`, `?api_token=`, `?session_token=` and every other
 * spelling one word away. An operator has no way to know which of those the check happens to hold,
 * so a rule that only refuses the names somebody thought of reads as a guard while behaving like a
 * gap.
 *
 * Not shared with `sensitiveKeys` in `audit.ts`: that module reaches the database and this function
 * deliberately imports nothing that does. The two also want different contents, since audit redacts
 * `content`, `prompt` and `result`, which are payload field names and mean nothing here.
 */
const CREDENTIAL_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "bearer",
];

/**
 * Names that are a credential on their own but are too short to contain safely.
 *
 * `sig` is the reason this list is separate from the one above: "design" contains it. These are
 * compared whole, so an ordinary word carrying the same three letters is left alone.
 */
const CREDENTIAL_NAMES = new Set([
  "auth",
  "authorization",
  "pass",
  "pwd",
  "sig",
]);

/**
 * Does this parameter name say it holds a credential?
 *
 * Names are compared with their separators dropped, so `api_key`, `apiKey` and `x-api-key` are one
 * question rather than three. A name ending in "key" is a credential and a name merely containing it
 * is not, which is what keeps `keyword` and `monkey` apart; "author" is likewise not "auth".
 *
 * It over-refuses in one direction on purpose. A parameter this rule misreads costs an operator a
 * rename, and one it misses is written to an append-only audit row that cannot be deleted.
 */
function readsAsCredential(name: string): boolean {
  const normalized = name.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (CREDENTIAL_NAMES.has(normalized) || normalized.endsWith("key")) {
    return true;
  }
  return CREDENTIAL_WORDS.some((word) => normalized.includes(word));
}

/**
 * Is this a URL an administrator may point the deployment at?
 *
 * A curated entry is reviewed in code; this is the other path, and it needs its own floor because
 * "add an MCP server" is otherwise a request-forgery primitive aimed at whatever the server can
 * reach: cloud metadata endpoints, databases on the same network, admin panels bound to localhost.
 * The rules are deliberately blunt.
 *
 * HTTPS only, because the credential is a bearer token and plaintext is not negotiable.
 * No address literals, localhost or internal suffixes, because those point at the deployment rather
 * than a vendor service.
 *
 * THE HALF THAT CAN BE DECIDED FROM THE STRING. Where the name actually points is
 * {@link resolvedCustomUrlRefusal}, which is what `addCustomServer` asks and which needs a resolver
 * and an await. Kept separate rather than folded in, because these two answers have different costs
 * and different failure modes: this one is arithmetic and cannot be wrong about the network, and the
 * other one touches it.
 *
 * The ranges and the names are {@link ../net/host-verdict}'s, which is also what a Bot's browser
 * asks before it navigates. They used to be two lists of the same addresses.
 */
export function customUrlRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a URL.";
  }

  if (url.protocol !== "https:") {
    return "An MCP server must be reached over https.";
  }

  // Userinfo is not part of the host, so none of the host rules below would look at it, and what is
  // typed here is stored verbatim: addCustomServer writes the string into mcp_servers.url and into
  // the configuration.changed audit payload, whose redaction keys on the field name rather than the
  // value. A secret written this way would sit in the trail in clear text. The refusal deliberately
  // does not echo the URL back.
  if (url.username || url.password) {
    return "Put the credential in the token field rather than in the address.";
  }

  /*
   * The query is the other half of the same hole, and the fragment is the half after that.
   *
   * No host rule below reads either one, and both are stored and audited with the rest of the
   * string, so a token written here is as durable and as readable as one written into the userinfo.
   * The fragment never reaches the server at all, which is why it is not a request-forgery concern
   * and is still a disclosure one: what this rule is about is where the string ends up, not where
   * the request goes.
   *
   * The test is on the parameter name rather than on the presence of a query, because vendors
   * legitimately route and version with parameters. A floor that refused every one of them would be
   * one an operator works around rather than with, and an ordinary `#section` is left alone for the
   * same reason.
   */
  const hash = url.hash.replace(/^#/, "");
  const marker = hash.indexOf("?");
  const fragment =
    marker === -1 ? [hash] : [hash.slice(0, marker), hash.slice(marker + 1)];
  const named = [
    ...url.searchParams.keys(),
    ...fragment.flatMap((part) => [...new URLSearchParams(part).keys()]),
  ];
  if (named.some(readsAsCredential)) {
    return "Put the credential in the token field rather than in the address.";
  }

  // Normalised once, in the shared module: a trailing dot is the root-anchored spelling of the same
  // name and resolves to the same place, so without stripping it "localhost." misses the equality
  // test, "vault.internal." misses the suffix tests, and "database." picks up the dot that the
  // single-label test keys on.
  const host = normalizeHostname(url.hostname);

  if (isAddressLiteral(host)) {
    return "Give a hostname rather than an IP address.";
  }
  // The cloud metadata endpoint, by name rather than by luck — asked of the same list a Bot's
  // browser asks, so an alias added there does not have to be remembered here as well.
  if (isCloudMetadataHostname(host)) {
    return "That address holds this deployment's own cloud credentials.";
  }
  if (isLoopbackHostname(host)) {
    return "That address is local to the deployment.";
  }
  if (isNotPubliclyRoutableName(host)) {
    return "That address is not reachable from outside this network.";
  }

  return null;
}

/**
 * The whole question, including where the name actually points.
 *
 * WHY THE STRING WAS NEVER ENOUGH. Every rule in {@link customUrlRefusal} reads the name somebody
 * typed, and a name is not an address. `mcp.example.com` is an ordinary public hostname right up
 * until its A record says `10.0.0.5`, and whoever controls a DNS zone controls that completely — so
 * a static deny-list of names refuses the obvious spellings of "the deployment's own network" and
 * admits every non-obvious one. This is the one place in the product where a person hands the
 * deployment an arbitrary address to keep and to send a credential to, so it is worth a round trip.
 *
 * A name that will not resolve is refused. The deployment would have nothing to send a request to
 * either way, and failing open here would mean a slow resolver is all it takes to skip the check.
 *
 * `resolve` is injected by tests, which must never depend on somebody else's DNS.
 */
export async function resolvedCustomUrlRefusal(
  raw: string,
  options: { resolve?: HostResolver } = {},
): Promise<string | null> {
  const refusal = customUrlRefusal(raw);
  if (refusal) return refusal;

  // Safe by now: `customUrlRefusal` refuses anything that will not parse.
  const host = normalizeHostname(new URL(raw).hostname);
  const verdict = await resolvedHostVerdict(host, options);
  if (verdict.allowed) return null;

  return verdict.fact === "laf:host_unresolvable"
    ? "That address does not resolve, so this deployment cannot tell where it points."
    : "That address resolves to somewhere inside this network.";
}
