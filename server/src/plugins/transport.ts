import type { CallPreview } from "../computer/approvals";
import * as cafe24Rest from "./cafe24-rest";
import type { CatalogueEntry } from "./catalogue";
import * as gmailRest from "./gmail-rest";
import * as businessRest from "./google-business-rest";
import * as calendarRest from "./google-calendar-rest";
import * as driveRest from "./google-drive-rest";
import * as sheetsRest from "./google-sheets-rest";
import type { McpCallResult, McpTool } from "./mcp";
import * as mcp from "./mcp";

/**
 * How this deployment reaches one vendor: which protocol, chosen per catalogue entry.
 *
 * WHY THIS EXISTS. Every connector used to be MCP, so "the transport" was an import. Google's Drive
 * MCP server turned out to be gated behind a developer preview, and the same product's ordinary REST
 * API is generally available — so one vendor needed a second way in, and a second way in wants a
 * seam rather than a branch at each call site.
 *
 * The interface is MCP's OWN, unchanged: `listTools` and `callTool`, the two functions
 * {@link ./mcp} already exported, with the shapes it already used. That direction matters. Had the
 * REST adapter been given its own interface with MCP adapted to fit, MCP would have become a special
 * case of a shape invented for Drive. As it is, MCP is the contract and the adapter conforms to it,
 * which is why swapping back is one field on one entry and not a refactor.
 *
 * There are exactly two call sites in the whole system — the tool listing and the tool call — and
 * both take a transport from here. Nothing else, including the OAuth flow, the per-person credential
 * selection, the grants, the policy engine and the audit trail, knows which protocol is underneath.
 *
 * Upstream's registry also holds a `builtin-routines` transport. Ours deliberately does not: this
 * fork has its own routines system with its own surfaces, and a Bot scheduling its own future runs
 * is a capability to grant through that system's review, not to inherit through a port.
 */

/**
 * WHERE WHAT A CALL ANSWERS WILL BE DRAWN: the surface its result lands on, said by the door the
 * call came in through (`call.ts` lists the two).
 *
 * - `conversation`: the call is a line of a conversation — a window of it now, or the transcript
 *   later — so what it answers is drawn there, on its own row. A chat turn's calls.
 * - `nowhere`: nothing of the call is drawn. A routine's answer reaches the person as the Bot's
 *   words alone, with no row under them.
 *
 * A FACT ABOUT THE SURFACE, NOT ABOUT WHO IS LOOKING. It was a flag, `watched`, first set so a code
 * withheld from a mail was kept for the person — and then also read by the weather tool for whether
 * its forecast is on the screen as a card. One flag, two meanings, and the second was a guess from
 * the first. Both readers ask this instead: a withheld value is kept only to be shown on its call's
 * row (`call.ts`), and the forecast is a card only where the row is drawn (`kma-weather-rest.ts`).
 */
export type DrawnOn = "conversation" | "nowhere";

export type VendorTransport = {
  /**
   * Whether discovering the tool list needs somebody's credential.
   *
   * True for MCP, where the list is an answer from a remote server that will not give it up
   * unauthenticated. False for an adapter whose tool list is this code, where there is nothing to ask
   * and nobody to ask it of.
   *
   * It is on the transport rather than assumed by the caller because getting it wrong is a whole
   * broken setup flow. Assumed true, an administrator configuring Drive was sent to their own
   * settings page to connect a personal account, purely so a token could be minted, passed to a
   * function that ignores it, and discarded — then sent back to press refresh. Nothing about that
   * sequence hinted that the middle step was doing no work.
   */
  listNeedsCredential: boolean;
  /**
   * Set on a stand-in: what a deployment answers with when it cannot serve an entry at all — a
   * partner whose module was not built here, a key the VM was not given (`store.ts`). Its list is
   * empty because nothing can be asked, which is a different thing from an entry that offers
   * nothing, so the pass that brings shipped definitions up to the build at boot leaves it alone.
   */
  unavailable?: true;
  listTools(connection: {
    url: string;
    token?: string | undefined;
    /** Who this call is for. Ignored by transports that answer to a credential. */
    actorId?: string;
    /** The Bot the run belongs to, never a name a model supplies. */
    botId?: string;
  }): Promise<McpTool[]>;
  callTool(
    connection: {
      url: string;
      token?: string | undefined;
      /** Who this call is for. Ignored by transports that answer to a credential. */
      actorId?: string;
      /** The Bot the run belongs to, never a name a model supplies. */
      botId?: string;
      /** Where what this call answers will be drawn (`DrawnOn`). Absent is `nowhere`. */
      drawnOn?: DrawnOn;
      /** The zone the person's days are counted in. Read by the calendar alone. */
      timeZone?: string;
    },
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
  /**
   * Whether this call could succeed at all, asked BEFORE anybody is asked to approve it.
   *
   * Throws a `PluginRefusedError` for a call that can never go out — a blank the template needs
   * and the arguments do not carry, a number that is not a phone number. Resolves for everything
   * else, including calls that will fail later for reasons only the vendor knows.
   *
   * WHY IT IS A SEPARATE FUNCTION AND NOT THE FIRST LINES OF `callTool`. The boundary asks a
   * person about an `external` tool before the transport is reached, and until 2026-09-06 the
   * arguments were first looked at after they had said yes. Measured against the real stack:
   * `alimtalk_send` called with the wrong blank names, approved, refused; the model retried,
   * the person approved again, refused again — two approvals spent on a send that could never
   * have gone out. The call path runs this first so that question is never asked.
   *
   * MUST HAVE NO SIDE EFFECTS AND TOUCH NO VENDOR. It runs before the audit row, before the
   * credential is chosen and before consent; a transport that sent anything from here would be
   * acting on a call nobody has agreed to. The connection carries no token for that reason.
   *
   * Optional: MCP has nothing to check without asking the server. Gmail checks its recipient and
   * subject here as well as where it builds the mail; the other REST adapters validate only where
   * they build the request. Absent means "nothing this side can know in advance".
   */
  validateArgs?(
    connection: {
      url: string;
      token?: string | undefined;
      actorId?: string;
      botId?: string;
    },
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void>;
  /**
   * What this call would send, for the person about to be asked whether it may. Null when the tool
   * sends nothing outward.
   *
   * On the transport for the reason `validateArgs` is: the adapter is the only code that knows
   * which argument is the recipient and which is the body, and a preview written anywhere else
   * would drift from the request the adapter actually builds. Each adapter builds both from one
   * reading of the arguments.
   *
   * SAME RULES AS `validateArgs`: no side effects, no vendor, no row, and only after the arguments
   * have passed it. Optional, and absent for MCP, whose arguments mean whatever the server says.
   */
  previewCall?(
    toolName: string,
    args: Record<string, unknown>,
  ): CallPreview | null;
};

/**
 * Whether a transport's tool definitions are this build's own code.
 *
 * READ OFF `listNeedsCredential`, WHICH IS A DECLARATION AND NOT THE FACT ITSELF. Every adapter
 * whose list is a constant of this repository declares false; the one transport that asks a remote
 * server what it offers — MCP — declares true (`mcp.ts`), and that constant is what keeps a vendor's
 * definition out of this rule. It is not that a remote list always needs a credential: a custom
 * server added with no token is listed anonymously (`connections.ts`), and is still MCP, still
 * true, still paused. So `server/tests/plugin-transport-shipped.test.ts` writes out every entry a
 * person connects — nine of the catalogue's thirteen — and a custom server, and holds the two
 * apart; the partner entry and the three on the deployment's own keys get their transport from
 * the process (`store.ts`) and are this repository's adapters or its refusing stand-ins. A
 * transport that ever lists from somebody else's server while declaring false would be accepted
 * without a person, and that test is what says so.
 *
 * What follows from the answer is the consent rule in `servers.ts`: a vendor's changed definition
 * is paused until a person has read it, and one that ships with this build is not, because it
 * arrived with the release that also ships the rule.
 */
export function definitionsShipWithThisBuild(
  transport: Pick<VendorTransport, "listNeedsCredential">,
): boolean {
  // `=== false`, not `!`: a transport that declares nothing — a module replaced in a test, a new
  // one that forgot the line — is a vendor's until it says otherwise, and waits for a person.
  return transport.listNeedsCredential === false;
}

/**
 * The protocols a catalogue entry may name.
 *
 * A closed union rather than a string, so adding one is a change to this file and to the registry
 * below together. An entry naming a transport that does not exist should not typecheck.
 */
export type TransportKind =
  | "mcp"
  | "google-drive-rest"
  | "google-sheets-rest"
  | "gmail-rest"
  | "google-calendar-rest"
  | "google-business-rest"
  | "cafe24-rest";

/*
 * One adapter per PRODUCT, not one per vendor.
 *
 * Google's five entries could have been one module with a switch in it, and that is the version
 * where adding Gmail's send changes the file Drive's search lives in. They are separate because
 * they are separately granted, separately consented to and separately reviewed: a person who
 * connected Sheets has agreed to Sheets, and the code that reaches their mailbox should not even be
 * loaded by that decision.
 */
const TRANSPORTS: Record<TransportKind, VendorTransport> = {
  mcp,
  "google-drive-rest": driveRest,
  "google-sheets-rest": sheetsRest,
  "gmail-rest": gmailRest,
  "google-calendar-rest": calendarRest,
  "google-business-rest": businessRest,
  "cafe24-rest": cafe24Rest,
};

/**
 * Which transport serves this entry.
 *
 * MCP for anything that does not say otherwise, which covers every catalogue entry that omits the
 * field and — importantly — every server an administrator added by URL, where there is no entry at
 * all. A custom server is somebody else's MCP endpoint by definition, so the absent case and the
 * default case are the same answer for the same reason.
 */
export function transportFor(entry: CatalogueEntry | null): VendorTransport {
  return TRANSPORTS[entry?.transport ?? "mcp"];
}
