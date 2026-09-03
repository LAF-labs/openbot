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
    },
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
};

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
