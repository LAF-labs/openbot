import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TIMEOUT_MS } from "./timeouts";

/**
 * The only place in this deployment that speaks MCP to somebody else's server.
 *
 * One door. Every call out is a credential leaving the building and a result coming back
 * that a model will read, so both directions want a single place to be careful in. A second client
 * somewhere else would be a second place to forget the timeout, the credential handling or the size
 * cap, and nothing about the second one would look wrong in review.
 *
 * No connection is kept. A client is built, used and closed for every listing and every call.
 * Streamable HTTP makes that cheap, and a pooled session would mean one Bot's request could arrive
 * on a session another Bot's credential opened, which is a whole class of bug we simply decline to
 * have.
 */

/**
 * The most result text a call may return.
 *
 * A tool result goes straight into a model's context, so an unbounded one is somebody else's server
 * deciding how much of our context window to spend, and a truncation the model can see is far better
 * than a run that fails or a bill nobody expected. Truncated visibly, never silently.
 */
export const MAX_RESULT_CHARS = 20_000;

/**
 * The most a server's ANSWER may weigh before it is read, in bytes.
 *
 * {@link MAX_RESULT_CHARS} caps what the model is shown; it did nothing about what this process
 * held to get there. Measured 2026-09-10 (audit A9, F5): a custom server answering one call with 50
 * MB of text was read and parsed whole, and trimmed to 20,000 characters afterwards — RSS went from
 * 121 MB to 395 MB for a result that reached the model as 20 KB. On a VM with 4.7 GB to spare, a
 * server an administrator added can push the API process out with a handful of concurrent calls.
 *
 * Two megabytes is a hundred times the cap on what is shown, which leaves room for a JSON envelope
 * around a result that will be trimmed anyway, and for a tool list of any plausible size. A server
 * that needs more is a server whose result nobody was ever going to read.
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * How much of a vendor's own sentence is kept, wherever one is quoted.
 *
 * Four lengths used to exist — 300 in the REST helper, 400 here, 400 again in the audit row, none
 * in Drive's private copy — for one decision: enough for a sentence and a console URL, short of the
 * wall of JSON a Google Workspace server attaches to a 403.
 */
export const VENDOR_DETAIL_CHARS = 400;

/** A vendor's sentence, cut to {@link VENDOR_DETAIL_CHARS} with the cut made visible. */
export const trimDetail = (value: string): string =>
  value.length > VENDOR_DETAIL_CHARS
    ? `${value.slice(0, VENDOR_DETAIL_CHARS)}…`
    : value;

/**
 * Text as a model will read it: the empty case named, the enormous case cut where it can see.
 *
 * ONE FUNCTION FOR EVERY TRANSPORT. The REST helper and Drive's private copy each carried the same
 * sentence and the same cap, and a third copy was one adapter away. Which shape of nothing arrived
 * — no parts, one newline, an empty string — must not change what the model is told, and neither
 * must which adapter it arrived through.
 *
 * The empty case is the one that earns the function. A tool that matched nothing used to produce an
 * empty string, and an empty string is the worst thing to put in front of a model: it reads as
 * "the tool had nothing to say" rather than "there is nothing there", and the model closes the gap
 * from memory. For a server a Bot searches, that is precisely the failure a connector exists to
 * prevent — an answer with nothing behind it. So nothing is stated, in words.
 *
 * Trimmed only to decide emptiness, never to alter a result that has something in it.
 */
export function shapeResult(joined: string): {
  text: string;
  truncated: boolean;
} {
  if (joined.trim() === "") {
    return {
      text: "The tool returned no content. Nothing was found, so there is nothing here to answer from.",
      truncated: false,
    };
  }
  if (joined.length <= MAX_RESULT_CHARS) {
    return { text: joined, truncated: false };
  }
  return {
    text: `${joined.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${joined.length} characters]`,
    truncated: true,
  };
}

/**
 * What a vendor said, as the string a model will read.
 *
 * Its own function, and exported, because this is a decision rather than plumbing: it settles what a
 * model is told when a vendor answers with a part we cannot render. Keeping it out of
 * {@link callTool} means it can be asserted without a server to talk to; the empty and enormous
 * cases are {@link shapeResult}'s, shared with every other transport.
 */
export function resultText(content: unknown): {
  text: string;
  truncated: boolean;
} {
  const parts = Array.isArray(content) ? content : [];
  const joined = parts
    .map((part) => {
      const item = part as { type?: string; text?: string };
      if (item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      // A non-text part is named rather than dropped. A model told "[image]" can say the tool
      // returned an image; a model handed nothing concludes the tool returned nothing.
      return `[${item.type ?? "unknown"}]`;
    })
    .join("\n");
  return shapeResult(joined);
}

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Standard MCP annotations as declared, null when the server declared none.
   *
   * Kept where upstream dropped the field, because this fork's custom-server contract
   * (docs/laf/mcp-contract.md) is built on it: a custom server declares its tools' risk with
   * annotations, the declaration is hashed into the consent a person gives, and the guard floors in
   * laf-contract.ts are compiled from it.
   */
  annotations: Record<string, unknown> | null;
};

export class McpServerError extends Error {
  constructor(
    message: string,
    /**
     * The HTTP status the vendor answered, when the failure was an answer at all.
     *
     * Carried as a number rather than left inside the sentence, because one reader ACTS on it: the
     * call path judges a connection's health off a 401 (`connection-health.ts`), and a judgement
     * that read "(401)" out of prose would be one rewording away from never running again.
     */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "McpServerError";
  }
}

/**
 * A call this deployment declined to complete, with the fact code that says why.
 *
 * WHY A REFUSAL AND NOT A FAILURE. A vendor failing is something that happened TO the call; these
 * are the deployment deciding against it — a redirect it would not follow, an answer it would not
 * read, a wait it would not sit through. The two readings are different acts, and the trail should
 * say which: a reader counting refusals has to be able to find these, and a reader counting vendor
 * outages should not be reading them by accident.
 *
 * The fact is a code rather than a sentence, for the same reason the guard floors are `laf:*`: the
 * model reads Korean out of `shared/prompt/tool-results.ko.ts` and the surface names the boundary
 * from the code, never from our English.
 */
export class McpRefusedError extends McpServerError {
  constructor(
    readonly fact: string,
    message: string,
    status: number | null = null,
  ) {
    super(message, status);
    this.name = "McpRefusedError";
  }
}

/** The fact an audit row carries when this deployment declined to follow a redirect. */
export const MCP_REDIRECT_REFUSED = "laf:mcp_redirect_refused";
/** The fact for an answer heavier than {@link MAX_RESPONSE_BYTES}, refused before it was read. */
export const MCP_RESPONSE_TOO_LARGE = "laf:mcp_response_too_large";
/** The fact for a server that did not answer inside its bound. */
export const MCP_TIMEOUT = "laf:mcp_timeout";

/**
 * A server answered by pointing somewhere else, and we did not go.
 *
 * A custom MCP server is an address an administrator typed: it is checked when it is added and never
 * again, and the check cannot see where a 302 points. Left on fetch's default, the transport would
 * follow one — carrying the Authorization header — to `http://localhost:4100` (the Bot's own
 * computer), to the cloud metadata endpoint, or to anything on this network. Every token endpoint in
 * this fork already says `redirect: "manual"` for exactly that reason; the MCP call path had been
 * left on the default, and it is the one path a MODEL can cause to be walked.
 */
export class McpRedirectRefusedError extends McpRefusedError {
  constructor(status: number) {
    /*
     * The address it named is deliberately absent. It is attacker-chosen text on a path that reaches
     * a model and an audit payload, and naming it would neither help the operator (the server is
     * theirs to fix) nor be safe to repeat.
     */
    super(
      MCP_REDIRECT_REFUSED,
      "That server answered with a redirect rather than a result, so the call was refused: a credential is never sent on to an address this deployment did not agree to talk to.",
      status,
    );
    this.name = "McpRedirectRefusedError";
  }
}

/**
 * A server answered with more than this deployment will hold in memory for one call.
 *
 * Refused as soon as the bound is crossed — from the `content-length` header when the server sends
 * one, and from the byte count as the body streams when it does not — and the connection is
 * aborted at that point, so what was refused was never received. See {@link MAX_RESPONSE_BYTES}.
 */
export class McpResponseTooLargeError extends McpRefusedError {
  constructor(readonly bytes: number) {
    super(
      MCP_RESPONSE_TOO_LARGE,
      `That server answered with more than ${MAX_RESPONSE_BYTES} bytes, so the answer was refused unread.`,
    );
    this.name = "McpResponseTooLargeError";
  }
}

/**
 * A server that did not answer inside its bound.
 *
 * The SDK reports this as JSON-RPC error `-32001`, and the rewrap used to read that number as an
 * HTTP status: "The vendor answered -32001." is what a Bot and a person were both told about a server
 * that answered nothing at all. Its own class, so the trail counts it as this deployment giving up
 * rather than as a vendor's verdict.
 */
export class McpTimeoutError extends McpRefusedError {
  constructor(readonly afterMs: number) {
    super(
      MCP_TIMEOUT,
      `That server did not answer within ${Math.round(afterMs / 1000)} seconds, so the call was abandoned.`,
    );
    this.name = "McpTimeoutError";
  }
}

/** The JSON-RPC code the SDK raises when a request outlives its timeout (`ErrorCode.RequestTimeout`). */
const JSONRPC_REQUEST_TIMEOUT = -32001;

/** The code a failure carries, whatever the SDK put it on: an HTTP status or a JSON-RPC code. */
function codeOf(error: unknown): number | undefined {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "number" ? code : undefined;
}

/**
 * The HTTP status a transport failure carries, when it carries one.
 *
 * Only a number that is one. The SDK puts JSON-RPC codes on the same field, and they are negative;
 * reading one as a status is how a timeout came to be reported as "The vendor answered -32001."
 */
function statusOf(error: unknown): number | undefined {
  const code = codeOf(error);
  return code !== undefined && code >= 100 && code <= 599 ? code : undefined;
}

/**
 * What the transport is allowed to spend on one exchange. Defaults are the deployment's; a test
 * that needs a server to be slow or enormous without being slow or enormous for real narrows them.
 */
export type CallLimits = {
  timeoutMs?: number;
  maxResponseBytes?: number;
};

/**
 * Every request this transport makes: redirects off, and the answer bounded before it is read.
 *
 * ON THE `fetch` SEAM rather than only in `requestInit`, because the SDK spreads `requestInit` into
 * the POST and the DELETE and builds the GET stream's init by hand. One of the three would have kept
 * following redirects, and it would have been the one nobody was looking at.
 *
 * THE BOUND IS ON BYTES RECEIVED, NOT ON WHAT WAS PARSED. `content-length` is honoured when the
 * server sends one and the request is aborted before a byte of the body is read; a chunked or
 * streamed answer is counted as it arrives and aborted the moment it crosses the line. Either way
 * the socket is closed at that point, which is what keeps the 50 MB out of this process rather than
 * merely out of the model.
 *
 * `refused` is the one channel back to {@link withClient} that does not depend on how the SDK
 * rewraps a stream error: the SDK parses the body inside its own `send`, and whatever it throws
 * from there — our error, an abort, a parse failure on the truncated bytes — the refusal that
 * caused it is what the caller is owed.
 */
function boundedFetch(
  maxBytes: number,
  refused: { first: McpRefusedError | null },
): typeof fetch {
  const guarded = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const controller = new AbortController();
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    const refuse = (bytes: number): McpResponseTooLargeError => {
      const error = new McpResponseTooLargeError(bytes);
      refused.first ??= error;
      controller.abort(error);
      return error;
    };

    const response = await fetch(url, { ...init, redirect: "manual", signal });

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw refuse(declared);
    }
    // A status the platform will not attach a body to (1xx, 204, 304) has nothing to count.
    if (!response.body || response.status < 200) return response;

    let seen = 0;
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          seen += chunk.byteLength;
          if (seen > maxBytes) {
            stream.error(refuse(seen));
            return;
          }
          stream.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  // Bun's `typeof fetch` carries a `preconnect` member; the SDK only ever calls the function.
  return Object.assign(guarded, {
    preconnect: () => {},
  }) as typeof fetch;
}

type Connection = {
  url: string;
  /** The bearer token for this server, already decrypted. Absent for a server that needs none. */
  token?: string;
};

/**
 * The vendor's own sentence out of a failure, when there is one worth reading.
 *
 * The transport puts the response body in the message, after a fixed prefix. Two shapes turn up: a
 * plain error object, and — from Google's Workspace servers — a JSON-RPC result whose `content` holds
 * the explanation as text under `isError`. Both are worth surfacing; the tool list, which arrives in
 * the same position under a 403, is not.
 */
function reasonFrom(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const body = message.slice(message.indexOf("{"));
  if (!body.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const asRecord = (value: unknown) =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  // `{"error": {"message": "..."}}` — how Google's REST APIs refuse.
  const restMessage = asRecord(asRecord(parsed).error).message;
  if (typeof restMessage === "string" && restMessage) {
    return trimDetail(restMessage);
  }

  // `{"result": {"content": [{"text": "..."}], "isError": true}}` — how its MCP servers refuse.
  const result = asRecord(asRecord(parsed).result);
  if (result.isError === true && Array.isArray(result.content)) {
    const text = result.content
      .map((part) => asRecord(part).text)
      .find((value): value is string => typeof value === "string" && !!value);
    if (text) return trimDetail(text);
  }

  return null;
}

/**
 * A vendor's failure, as one sentence an operator can act on.
 *
 * WHAT THIS REPLACES. The transport throws `Error POSTing to endpoint: <the whole response body>`,
 * and the status lives on the error object rather than in the message — so rewrapping by `.message`
 * alone threw away the only part that says what went wrong and kept the part that does not.
 *
 * Google's Workspace MCP servers make that worse than it sounds. Asked for a tool list with a token
 * they will not accept, they answer **401, or 403, with a complete and valid tool list in the body** —
 * verified against the live endpoint. So the message was a wall of successful-looking JSON attached
 * to a failure, which reads as a parsing bug here rather than as a refusal there.
 *
 * The status leads, and the well-known ones are named. A 403 also keeps the vendor's own sentence
 * where there is one, because that is where Google says which API is not enabled — and each Workspace
 * product is two APIs, so nothing else can tell "I enabled it" from "it is enabled".
 */
function vendorFailure(error: unknown): string {
  const status = statusOf(error);

  if (status === 401) {
    return "The vendor rejected this credential (401). For a connector reached as the person asking, reconnecting the account is the usual fix; if it persists, the scopes it was granted may not cover this server.";
  }
  if (status === 403) {
    /*
     * A 403 keeps its reason, unlike a 401.
     *
     * This cost a diagnosis. Google refuses a Workspace MCP server with 403 when the API behind it is
     * not enabled for the project — and the sentence saying so, with the console URL to fix it, is in
     * the response body. Dropping the body left "the account may lack access, or the API may not be
     * enabled", which is a guess between two very different problems when the vendor had already
     * answered the question.
     *
     * Worse, each Workspace product is TWO APIs: enabling `drive.googleapis.com` does not enable
     * `drivemcp.googleapis.com`, so "I enabled it" and "it is enabled" are not the same claim and
     * only the body can tell them apart.
     *
     * Trimmed, because the body may instead be the tool list — the same server answers `tools/list`
     * with a full, valid list under a 403 — and a wall of JSON is what made the original error
     * unreadable.
     */
    const detail = reasonFrom(error);
    return detail
      ? `The vendor accepted the credential and refused the request (403). It said: ${detail}`
      : "The vendor accepted the credential and refused the request (403). The account may lack access, or the API may not be enabled for this project.";
  }
  if (typeof status === "number") {
    return `The vendor answered ${status}.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build, use and close a client.
 *
 * The `finally` closes the transport whatever happened, because a thrown error is the case where a
 * leaked connection is most likely and least noticed.
 */
async function withClient<T>(
  connection: Connection,
  limits: Required<CallLimits>,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const refused: { first: McpRefusedError | null } = { first: null };
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: connection.token
      ? { headers: { Authorization: `Bearer ${connection.token}` } }
      : undefined,
    fetch: boundedFetch(limits.maxResponseBytes, refused),
  });
  const client = new Client({ name: "laf-agent", version: "1.0.0" });

  try {
    await client.connect(transport);
    return await use(client);
  } catch (error) {
    /*
     * Our own refusals first, in their own class all the way to the audit row.
     *
     * An answer refused for its size surfaces out of the SDK as whatever its body parser made of an
     * aborted stream; a 3xx, with redirects off, as an ordinary unsuccessful status; a timeout as a
     * JSON-RPC error. Without these branches "we would not do that" would be filed as "the vendor
     * answered 302", "the vendor answered -32001" or a parse error on the truncated bytes.
     */
    if (refused.first) throw refused.first;
    if (error instanceof McpRefusedError) throw error;
    const status = statusOf(error);
    if (status !== undefined && status >= 300 && status < 400) {
      throw new McpRedirectRefusedError(status);
    }
    if (codeOf(error) === JSONRPC_REQUEST_TIMEOUT) {
      throw new McpTimeoutError(limits.timeoutMs);
    }
    // Rewrapped so a caller never has to care whether the failure came from the transport, the
    // handshake or the call, and so the message that reaches an audit row and an admin page is one
    // sentence rather than a stack. The status rides beside it for the one reader that judges on it.
    throw new McpServerError(vendorFailure(error), status ?? null);
  } finally {
    await client.close().catch(() => {
      // A server that will not say goodbye is not a failure of the work that just succeeded.
    });
  }
}

/** The deployment's bounds, with a test's narrower ones laid over where it gave any. */
const limitsFor = (
  limits: CallLimits | undefined,
  timeoutMs: number,
): Required<CallLimits> => ({
  timeoutMs: limits?.timeoutMs ?? timeoutMs,
  maxResponseBytes: limits?.maxResponseBytes ?? MAX_RESPONSE_BYTES,
});

/**
 * A remote server will not list its tools to nobody, so a credential is required to ask.
 *
 * Declared rather than assumed, because the other transport in this deployment answers differently
 * and the difference is the whole shape of an administrator's setup flow. See {@link ./transport}.
 */
export const listNeedsCredential = true;

/** What this server says it offers, right now. */
export async function listTools(
  connection: Connection,
  limits?: CallLimits,
): Promise<McpTool[]> {
  const bounds = limitsFor(limits, TIMEOUT_MS.mcpList);
  return withClient(connection, bounds, async (client) => {
    const result = await client.listTools(undefined, {
      timeout: bounds.timeoutMs,
    });
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      annotations:
        tool.annotations && Object.keys(tool.annotations).length > 0
          ? (tool.annotations as Record<string, unknown>)
          : null,
    }));
  });
}

export type McpCallResult = {
  /** The result as text, which is what a model reads. Truncated visibly if it was enormous. */
  text: string;
  /** True when the server itself reported the call as an error rather than failing to answer. */
  isError: boolean;
  truncated: boolean;
  /**
   * The HTTP status behind an `isError` result, when the adapter knows one.
   *
   * A REST adapter answers a vendor's refusal as a result rather than a throw — the vendor's own
   * sentence is the most useful thing a person can be shown — and until 2026-09-10 the status went
   * into that sentence and nowhere else. The call path judges a connection's health off it
   * (`connection-health.ts`): a 401 after a good exchange is a grant that no longer works, and a
   * health that read only the exchange said `ok` beside a Bot that failed every call.
   */
  status?: number;
};

/**
 * Call one tool.
 *
 * Whether the call was permitted is not decided here. This function's only job is to speak the
 * protocol; the grant and the policy are settled before anything reaches it. Keeping the two apart
 * means the permission check cannot be accidentally satisfied by a code path that also happens to
 * make the call.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
  limits?: CallLimits,
): Promise<McpCallResult> {
  const bounds = limitsFor(limits, TIMEOUT_MS.mcpCall);
  return withClient(connection, bounds, async (client) => {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: bounds.timeoutMs },
    );

    const { text, truncated } = resultText(result.content);
    return { text, isError: result.isError === true, truncated };
  });
}
