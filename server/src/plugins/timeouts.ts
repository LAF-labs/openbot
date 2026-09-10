/**
 * How long this deployment waits on somebody else's server, in one table.
 *
 * WHY A TABLE. Five numbers sat at eight `fetch` sites — 30 s in a REST helper, 30 s again in a
 * private copy of it, 15 s and 60 s in the MCP client, 10 s at the token endpoint, 15 s twice in
 * the OAuth flow, 10 s at the partner — and nothing said which of them were one decision spelled
 * several times and which were different round trips (audit 2026-09-10, A9 §1). They ARE different
 * round trips: a token renewal is one request or nothing, a tool call may legitimately be slow. So
 * they stay distinct, and they sit together so a reader sees the whole set and a change to one is a
 * change here.
 *
 * Every number is a bound on a Bot's turn as much as on a vendor. A person watching a conversation
 * is waiting for whichever of these is longest.
 */
export const TIMEOUT_MS = Object.freeze({
  /** One round trip at a vendor's token endpoint: renewing a grant, or revoking one. */
  token: 10_000,
  /** Redeeming an authorization code, on the way back from a consent screen. */
  redeem: 15_000,
  /** Registering this deployment as a client at a vendor that issues its own (RFC 7591). */
  registration: 15_000,
  /** One REST request to a vendor's API. Long enough for a slow listing, short of a Bot's turn. */
  rest: 30_000,
  /**
   * The whole of one REST tool call that fans out into several requests.
   *
   * Gmail's search is one list and up to fifty reads; under `rest` alone the worst case was fifty
   * times thirty seconds, in a chat turn the browser runs with no bound of its own. This is the
   * bound for the call as a person experiences it.
   */
  toolCall: 30_000,
  /** An MCP server listing its tools. */
  mcpList: 15_000,
  /** One MCP tool call, end to end, the body included. */
  mcpCall: 60_000,
  /** One call to a partner vendor (솔라피). The same bound the webhook door uses. */
  partner: 10_000,
});
