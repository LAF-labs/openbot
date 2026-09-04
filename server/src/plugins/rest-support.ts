import { MAX_RESULT_CHARS, type McpCallResult } from "./mcp";

/**
 * What every REST adapter in this directory does the same way: one request, one result, one refusal.
 *
 * WHY IT IS SHARED. `google-drive-rest.ts` was the first adapter and every one of these helpers grew
 * there. The second, third and fourth would each have carried a copy — and the copies would drift on
 * exactly the details that are easy to get wrong twice: an empty result read by a model as "nothing
 * to say" and filled in from memory, a 200 that is a CDN's HTML rather than a vendor's JSON, a size
 * cap applied in one adapter and not the next.
 *
 * These are the parts with no vendor in them. Which URL, which fields, and what a result reads like
 * belong to each adapter, because those are the parts a reviewer has to check against the vendor's
 * documentation.
 */

/** Long enough for a slow listing, short enough that a Bot's turn is not held open on it. */
export const REST_TIMEOUT_MS = 30_000;

export type RestConnection = { url: string; token?: string };

/**
 * Text as a tool result, through the one function that decides what a model is told.
 *
 * The empty case is the one that matters: a search that matched nothing has to SAY so, because an
 * empty string reads to a model as "the tool had nothing to say" and gets filled in from memory —
 * which for a connector somebody searches is the exact failure it exists to prevent.
 */
export function asResult(text: string): McpCallResult {
  const joined = text.trim();
  if (joined === "") {
    return {
      text: "The tool returned no content. Nothing was found, so there is nothing here to answer from.",
      isError: false,
      truncated: false,
    };
  }
  if (joined.length <= MAX_RESULT_CHARS) {
    return { text: joined, isError: false, truncated: false };
  }
  return {
    text: `${joined.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${joined.length} characters]`,
    isError: false,
    truncated: true,
  };
}

export const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

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
  },
): Promise<{ ok: true; response: Response } | { ok: false; message: string }> {
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
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
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
      message: detail
        ? `${vendor} refused this request (${response.status}): ${detail.slice(0, 300)}`
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
