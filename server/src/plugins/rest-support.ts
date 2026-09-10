import { type McpCallResult, shapeResult, trimDetail } from "./mcp";
import { TIMEOUT_MS } from "./timeouts";

/**
 * What every REST adapter in this directory does the same way: one request, one result, one refusal.
 *
 * WHY IT IS SHARED. `google-drive-rest.ts` was the first adapter and every one of these helpers grew
 * there. The second, third and fourth would each have carried a copy — and the copies would drift on
 * exactly the details that are easy to get wrong twice: an empty result read by a model as "nothing
 * to say" and filled in from memory, a 200 that is a CDN's HTML rather than a vendor's JSON, a size
 * cap applied in one adapter and not the next.
 *
 * AND THE FIRST ONE DRIFTED. Measured 2026-09-10 (audit A9, F6): Drive still held its private copies
 * from before this file existed — following redirects with somebody's token on the request, and
 * throwing a `SyntaxError` out of a tool call when Google's maintenance page answered 200 with HTML —
 * while the five adapters written after it did neither. Drive reads from here now, and nothing in
 * this directory may hold a second copy of any of these.
 *
 * These are the parts with no vendor in them. Which URL, which fields, and what a result reads like
 * belong to each adapter, because those are the parts a reviewer has to check against the vendor's
 * documentation.
 */

export type RestConnection = { url: string; token?: string };

/**
 * Text as a tool result, through the one function that decides what a model is told.
 *
 * The empty case and the size cap are {@link shapeResult}'s, shared with the MCP transport, so
 * which door a result came through cannot change what the model reads.
 */
export function asResult(text: string): McpCallResult {
  return { ...shapeResult(text.trim()), isError: false };
}

/**
 * A failure as a result rather than a throw, with the status behind it when there is one.
 *
 * The status is a separate field and not only a number in the sentence, because one reader acts on
 * it: the call path judges a connection's health off a 401 (`connection-health.ts`).
 */
export const failure = (message: string, status?: number): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
  ...(status === undefined ? {} : { status }),
});

/**
 * A tool name that reached an adapter and is not one it implements.
 *
 * It means the stored tool list and this code have diverged, which is a bug to surface rather than
 * to absorb. One sentence for the six adapters, because six copies of it were measured and a
 * seventh would have been written the next time one was added.
 */
export const unknownTool = (toolName: string): McpCallResult =>
  failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );

/** An argument the model sent, if it sent a usable one. */
export function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A whole number the model sent, clamped, or the fallback. Never NaN, never negative. */
export function countArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * One request to a vendor, with the caller's own token.
 *
 * `token` is never optional in practice — every entry these adapters serve is `user-oauth`, so the
 * store has already refused a call with nobody's credential — but the shared connection shape types
 * it optional, so a missing one is named rather than sent as `Bearer undefined`.
 *
 * The vendor's own sentence is kept when it sends one. For a 403 that is where Google names the API
 * that is not enabled and gives the console URL, which is the difference between a fix and a guess.
 *
 * `signal` is the caller's bound on the WHOLE tool call, laid over this request's own. An adapter
 * that fans one call out into many requests (Gmail's search) hands the same signal to each, so the
 * person waits for one deadline rather than for the sum of fifty.
 */
export async function vendorRequest(
  vendor: string,
  connection: RestConnection,
  input: {
    /** Absolute. Each adapter builds it, because each vendor's path shape is its own. */
    url: string;
    method?: "GET" | "POST" | "PUT" | "PATCH";
    query?: Record<string, string | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<
  | { ok: true; response: Response }
  | { ok: false; message: string; status?: number }
> {
  if (!connection.token) {
    return { ok: false, message: "No credential was available for this call." };
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return {
      ok: false,
      message: `${vendor} could not be reached: bad address.`,
    };
  }
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  const own = AbortSignal.timeout(TIMEOUT_MS.rest);
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method ?? "GET",
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(input.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(input.headers ?? {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      /*
       * A redirect is not a detour to be followed: this request carries somebody's access token, and
       * following a 302 would hand it to whatever address the answer named. The same rule the token
       * endpoints in `oauth.ts` state.
       */
      redirect: "manual",
      signal: input.signal ? AbortSignal.any([input.signal, own]) : own,
    });
  } catch (error) {
    // Both a request that outlived its own bound and one cut short by the call's deadline arrive
    // as an abort; the difference is not the vendor's, and one sentence covers both.
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      message: timedOut
        ? `${vendor} did not answer in time.`
        : `${vendor} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      if (typeof parsed.error === "object" && parsed.error !== null) {
        if (typeof parsed.error.message === "string") {
          detail = parsed.error.message;
        }
      } else if (typeof parsed.message === "string") {
        detail = parsed.message;
      }
    } catch {
      // Not JSON. The status alone is still worth saying.
    }
    return {
      ok: false,
      status: response.status,
      message: detail
        ? `${vendor} refused this request (${response.status}): ${trimDetail(detail)}`
        : `${vendor} refused this request (${response.status}).`,
    };
  }

  return { ok: true, response };
}

/**
 * The JSON body, or nothing.
 *
 * A 200 is not a promise of JSON — a captive portal or a maintenance page answers 200 with HTML —
 * and an unguarded parse would throw out of a tool call that has a perfectly good way to say the
 * vendor answered with something unusable.
 */
export async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}
